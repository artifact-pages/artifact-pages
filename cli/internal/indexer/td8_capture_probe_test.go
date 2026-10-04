//go:build td8audit

package indexer

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"hash"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

// This opt-in TD8 probe compares full publisher capture with standalone
// index-only capture/build. Fixture totals come from file sizes; reader-hook
// counters report bytes returned by the injected reader, not kernel I/O. Heap
// values are retained Go heap after forced GC, not peak heap/RSS.
//
// The publisher's full immutable-source snapshot contract remains covered
// separately by TestBuildPreparedUsesExactCapturedSourceBytes in prepare_test.go.
func TestTD8ProbeIndexBuildMixedResourceSizeSweep(t *testing.T) {
	repositoryRoot := initializeGitRepository(t)
	restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
	defer restoreWorkingDirectory()

	const sourceName = "content"
	sourceRoot := filepath.Join(repositoryRoot, sourceName)
	fullOutputRoot := filepath.Join(repositoryRoot, ".td8-output-full")
	indexOnlyOutputRoot := filepath.Join(repositoryRoot, ".td8-output-index-only")
	fixtureTime := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	generatedAt := time.Date(2026, 10, 5, 9, 0, 0, 0, time.UTC)
	if err := os.MkdirAll(filepath.Join(sourceRoot, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 10; i++ {
		body := fmt.Sprintf("# Page %02d\n\nFixed TD8 index capture probe page %02d.\n", i, i)
		if i == 0 {
			body += "\n[Stylesheet](assets/site.css)\n\n![Diagram](assets/diagram.svg)\n\n[Binary payload](assets/payload.bin)\n"
		}
		writeTD8FixtureFile(t, sourceRoot, fmt.Sprintf("page-%02d.md", i), []byte(body), fixtureTime)
	}
	resources := []struct {
		path string
		body []byte
	}{
		{path: "assets/site.css", body: []byte("body { color: #123456; }\n")},
		{path: "assets/diagram.svg", body: []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><path d="M0 0h4v4H0z"/></svg>`)},
		{path: "assets/unused.css", body: []byte(".unused { display: none; }\n")},
		{path: "assets/unused.svg", body: []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><circle r="1"/></svg>`)},
		{path: "assets/unused.bin", body: []byte{0x00, 0x01, 0xfe, 0xff, 0x10, 0x20, 0x30}},
		{path: "assets/payload.bin"},
	}
	for _, resource := range resources {
		writeTD8FixtureFile(t, sourceRoot, resource.path, resource.body, fixtureTime)
	}
	commitFixture(t, repositoryRoot, "add TD8 index probe fixture", fixtureTime)

	payloadPath := filepath.Join(sourceRoot, "assets", "payload.bin")
	resourcePayloadSizes := []int64{0, 10 << 20, 100 << 20}
	baseOptions := BuildOptions{
		SiteID: "td8-index", SiteTitle: "TD8 Index Capture Probe",
		SourceDir:  sourceName,
		Repository: "acme/td8-index", RepositoryURL: "https://github.com/acme/td8-index",
		Ref: "refs/heads/main", Now: func() time.Time { return generatedAt },
	}
	var expectedFull, expectedIndexOnly td8OutputFingerprint
	for point, payloadBytes := range resourcePayloadSizes {
		if err := writeTD8Payload(payloadPath, payloadBytes, fixtureTime); err != nil {
			t.Fatalf("write payload fixture (%d bytes): %v", payloadBytes, err)
		}
		if err := os.RemoveAll(fullOutputRoot); err != nil {
			t.Fatal(err)
		}
		if err := os.RemoveAll(indexOnlyOutputRoot); err != nil {
			t.Fatal(err)
		}
		fixtureStats, err := td8FixtureStats(sourceRoot)
		if err != nil {
			t.Fatal(err)
		}

		fullOptions := baseOptions
		fullOptions.OutputDir = fullOutputRoot
		fullCounters := &td8CaptureCounters{}
		fullReader, _ := td8CaptureHooks(fullCounters)
		runtime.GC()
		var beforeFull runtime.MemStats
		runtime.ReadMemStats(&beforeFull)
		prepareStarted := time.Now()
		prepared, err := prepareBuild(context.Background(), fullOptions, sourceCaptureMode{readFile: fullReader})
		fullPrepareElapsed := time.Since(prepareStarted)
		if err != nil {
			t.Fatalf("full PrepareBuild capture (payload=%d bytes): %v", payloadBytes, err)
		}
		runtime.GC()
		var afterFullPrepare runtime.MemStats
		runtime.ReadMemStats(&afterFullPrepare)
		runtime.KeepAlive(prepared)

		indexOnlyCaptureOptions := baseOptions
		indexOnlyCaptureOptions.OutputDir = indexOnlyOutputRoot
		indexOnlyCaptureCounters := &td8CaptureCounters{}
		indexOnlyReader, indexOnlyOpener := td8CaptureHooks(indexOnlyCaptureCounters)
		indexOnlyPrepareStarted := time.Now()
		indexOnlyPrepared, err := prepareBuild(context.Background(), indexOnlyCaptureOptions, sourceCaptureMode{
			indexOnly: true, readFile: indexOnlyReader, openFile: indexOnlyOpener,
		})
		indexOnlyCaptureElapsed := time.Since(indexOnlyPrepareStarted)
		if err != nil {
			t.Fatalf("index-only capture (payload=%d bytes): %v", payloadBytes, err)
		}
		runtime.GC()
		var afterIndexOnlyCapture runtime.MemStats
		runtime.ReadMemStats(&afterIndexOnlyCapture)
		// Both snapshots remain live across the forced GC above. Subtracting the
		// full-only sample from the combined sample estimates the incremental
		// retained heap of the index-only snapshot in the same fixture/process.
		runtime.KeepAlive(prepared)
		runtime.KeepAlive(indexOnlyPrepared)
		fullRetainedHeap := int64(afterFullPrepare.HeapAlloc) - int64(beforeFull.HeapAlloc)
		combinedRetainedHeap := int64(afterIndexOnlyCapture.HeapAlloc) - int64(beforeFull.HeapAlloc)
		indexOnlyIncrementalRetainedHeap := int64(afterIndexOnlyCapture.HeapAlloc) - int64(afterFullPrepare.HeapAlloc)
		if indexOnlyCaptureCounters.documentCalls != fixtureStats.files-fixtureStats.resourceFiles || indexOnlyCaptureCounters.resourceCalls != 0 || indexOnlyCaptureCounters.resourceBytes != 0 || indexOnlyCaptureCounters.resourceOpenCalls != fixtureStats.resourceFiles || int64(indexOnlyCaptureCounters.documentBytes) != fixtureStats.documentBytes {
			t.Fatalf("index-only capture hooks = %+v, want document reads, zero resource-body reads, and metadata-only resource opens", indexOnlyCaptureCounters)
		}

		buildStarted := time.Now()
		fullResult, err := BuildPrepared(context.Background(), prepared, fullOutputRoot)
		fullBuildElapsed := time.Since(buildStarted)
		if err != nil {
			t.Fatalf("full BuildPrepared (payload=%d bytes): %v", payloadBytes, err)
		}
		if fullResult.ArtifactsIndexed != 10 {
			t.Fatalf("full ArtifactsIndexed = %d, want 10", fullResult.ArtifactsIndexed)
		}
		if fullResult.FilesScanned != fixtureStats.files {
			t.Fatalf("full FilesScanned = %d, want all %d source fixture files", fullResult.FilesScanned, fixtureStats.files)
		}
		fullFingerprint, err := td8OutputFingerprintFor(fullOutputRoot)
		if err != nil {
			t.Fatal(err)
		}
		if point == 0 {
			expectedFull = fullFingerprint
		} else if fullFingerprint != expectedFull {
			t.Fatalf("full generated output changed with payload size %d: got %+v; want %+v", payloadBytes, fullFingerprint, expectedFull)
		}
		if fullCounters.documentCalls != fixtureStats.files-fixtureStats.resourceFiles || fullCounters.resourceCalls != fixtureStats.resourceFiles || int64(fullCounters.documentBytes) != fixtureStats.documentBytes || int64(fullCounters.resourceBytes) != fixtureStats.resourceBytes {
			t.Fatalf("full capture reader counters = %+v, want all fixture document/resource bytes", fullCounters)
		}
		prepared = nil
		indexOnlyPrepared = nil
		runtime.GC()

		standaloneCounters := &td8CaptureCounters{}
		standaloneReader, standaloneOpener := td8CaptureHooks(standaloneCounters)
		standaloneOptions := baseOptions
		standaloneOptions.OutputDir = indexOnlyOutputRoot
		standaloneStarted := time.Now()
		standaloneResult, err := buildWithSourceHooks(context.Background(), standaloneOptions, standaloneReader, standaloneOpener)
		standaloneElapsed := time.Since(standaloneStarted)
		if err != nil {
			t.Fatalf("standalone Build (payload=%d bytes): %v", payloadBytes, err)
		}
		if standaloneResult.ArtifactsIndexed != 10 || standaloneResult.FilesScanned != fixtureStats.files {
			t.Fatalf("standalone result = %+v, want 10 documents and %d walked files", standaloneResult, fixtureStats.files)
		}
		if standaloneCounters.documentCalls != fixtureStats.files-fixtureStats.resourceFiles || standaloneCounters.resourceCalls != 0 || standaloneCounters.resourceBytes != 0 || standaloneCounters.resourceOpenCalls != fixtureStats.resourceFiles || int64(standaloneCounters.documentBytes) != fixtureStats.documentBytes {
			t.Fatalf("standalone Build hooks = %+v, want document reads, zero resource-body reads, and metadata-only resource opens", standaloneCounters)
		}
		standaloneFingerprint, err := td8OutputFingerprintFor(indexOnlyOutputRoot)
		if err != nil {
			t.Fatal(err)
		}
		if standaloneFingerprint != fullFingerprint {
			t.Fatalf("standalone output differs from full PrepareBuild+BuildPrepared at payload size %d: got %+v; full %+v", payloadBytes, standaloneFingerprint, fullFingerprint)
		}
		if point == 0 {
			expectedIndexOnly = standaloneFingerprint
		} else if standaloneFingerprint != expectedIndexOnly {
			t.Fatalf("standalone generated output changed with payload size %d: got %+v; want %+v", payloadBytes, standaloneFingerprint, expectedIndexOnly)
		}
		t.Logf(
			"payloadFixtureBytes=%d sourceFixtureBytes=%d resourceFixtureBytes=%d documentFixtureBytes=%d fixtureFiles=%d filesWalked=%d fullPrepareCaptureElapsed=%s fullPreparedRetainedHeapDeltaAfterForcedGC=%d indexOnlyPrepareCaptureElapsed=%s indexOnlyPreparedIncrementalRetainedHeapDeltaAfterForcedGCWhileFullLive=%d fullPlusIndexOnlyPreparedRetainedHeapDeltaAfterForcedGC=%d fullBuildPreparedElapsed=%s fullStandaloneModeElapsed=%s standaloneBuildElapsed=%s fullReaderDocumentCalls=%d fullReaderResourceCalls=%d fullReaderDocumentBytes=%d fullReaderResourceBytes=%d indexOnlyCaptureDocumentCalls=%d indexOnlyCaptureResourceCalls=%d indexOnlyCaptureDocumentBytes=%d indexOnlyCaptureResourceBytes=%d indexOnlyCaptureResourceOpenStatCalls=%d standaloneDocumentCalls=%d standaloneResourceCalls=%d standaloneDocumentBytes=%d standaloneResourceBytes=%d standaloneResourceOpenStatCalls=%d fullOutputObjects=%d standaloneOutputObjects=%d fullOutputBytes=%d standaloneOutputBytes=%d outputPathBodyHTTPMetadataSHA256=%s",
			payloadBytes, fixtureStats.totalBytes, fixtureStats.resourceBytes, fixtureStats.documentBytes,
			fixtureStats.files, fullResult.FilesScanned, fullPrepareElapsed,
			fullRetainedHeap, indexOnlyCaptureElapsed, indexOnlyIncrementalRetainedHeap, combinedRetainedHeap, fullBuildElapsed, fullPrepareElapsed+fullBuildElapsed, standaloneElapsed,
			fullCounters.documentCalls, fullCounters.resourceCalls, fullCounters.documentBytes, fullCounters.resourceBytes,
			indexOnlyCaptureCounters.documentCalls, indexOnlyCaptureCounters.resourceCalls, indexOnlyCaptureCounters.documentBytes, indexOnlyCaptureCounters.resourceBytes, indexOnlyCaptureCounters.resourceOpenCalls,
			standaloneCounters.documentCalls, standaloneCounters.resourceCalls, standaloneCounters.documentBytes, standaloneCounters.resourceBytes, standaloneCounters.resourceOpenCalls,
			fullFingerprint.objects, standaloneFingerprint.objects, fullFingerprint.bytes, standaloneFingerprint.bytes, fullFingerprint.sha256,
		)
	}
}

type td8FixtureSizeStats struct {
	files         int
	resourceFiles int
	totalBytes    int64
	resourceBytes int64
	documentBytes int64
}

type td8CaptureCounters struct {
	documentCalls     int
	resourceCalls     int
	documentBytes     int
	resourceBytes     int
	resourceOpenCalls int
}

func td8CaptureHooks(counters *td8CaptureCounters) (sourceFileReader, sourceFileOpener) {
	reader := func(filename string) ([]byte, error) {
		resource := strings.Contains(filepath.ToSlash(filename), "/assets/")
		if resource {
			counters.resourceCalls++
		} else {
			counters.documentCalls++
		}
		data, err := os.ReadFile(filename)
		if err == nil {
			if resource {
				counters.resourceBytes += len(data)
			} else {
				counters.documentBytes += len(data)
			}
		}
		return data, err
	}
	opener := func(filename string) (*os.File, error) {
		if strings.Contains(filepath.ToSlash(filename), "/assets/") {
			counters.resourceOpenCalls++
		}
		return os.Open(filename)
	}
	return reader, opener
}

type td8OutputFingerprint struct {
	objects int
	bytes   int64
	sha256  string
}

func writeTD8FixtureFile(t testing.TB, root, relative string, body []byte, modified time.Time) {
	t.Helper()
	filename := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(filename), 0o755); err != nil {
		t.Fatalf("create TD8 fixture directory: %v", err)
	}
	if err := os.WriteFile(filename, body, 0o644); err != nil {
		t.Fatalf("write TD8 fixture %q: %v", relative, err)
	}
	if err := os.Chtimes(filename, modified, modified); err != nil {
		t.Fatalf("set TD8 fixture mtime %q: %v", relative, err)
	}
}

func writeTD8Payload(filename string, size int64, modified time.Time) error {
	file, err := os.OpenFile(filename, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	block := make([]byte, 1<<20)
	for i := range block {
		block[i] = byte((i*31 + 7) % 251)
	}
	for remaining := size; remaining > 0; {
		writeSize := int64(len(block))
		if remaining < writeSize {
			writeSize = remaining
		}
		written, writeErr := file.Write(block[:int(writeSize)])
		if writeErr != nil {
			_ = file.Close()
			return writeErr
		}
		if int64(written) != writeSize {
			_ = file.Close()
			return fmt.Errorf("short write: got %d, want %d", written, writeSize)
		}
		remaining -= writeSize
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Chtimes(filename, modified, modified)
}

func td8FixtureStats(root string) (td8FixtureSizeStats, error) {
	var stats td8FixtureSizeStats
	err := filepath.WalkDir(root, func(filename string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, filename)
		if err != nil {
			return err
		}
		stats.files++
		stats.totalBytes += info.Size()
		if strings.HasPrefix(filepath.ToSlash(relative), "assets/") {
			stats.resourceFiles++
			stats.resourceBytes += info.Size()
		} else {
			stats.documentBytes += info.Size()
		}
		return nil
	})
	return stats, err
}

func td8OutputFingerprintFor(root string) (td8OutputFingerprint, error) {
	var paths []string
	if err := filepath.WalkDir(root, func(filename string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, filename)
		if err != nil {
			return err
		}
		paths = append(paths, filepath.ToSlash(relative))
		return nil
	}); err != nil {
		return td8OutputFingerprint{}, err
	}
	sort.Strings(paths)
	output := td8OutputFingerprint{}
	digest := sha256.New()
	for _, relative := range paths {
		body, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil {
			return td8OutputFingerprint{}, err
		}
		contentType, disposition, encoding, cacheControl := td8OutputHTTPMetadata(relative)
		td8WriteHashField(digest, []byte(relative))
		td8WriteHashField(digest, body)
		td8WriteHashField(digest, []byte(contentType))
		td8WriteHashField(digest, []byte(disposition))
		td8WriteHashField(digest, []byte(encoding))
		td8WriteHashField(digest, []byte(cacheControl))
		output.objects++
		output.bytes += int64(len(body))
	}
	output.sha256 = hex.EncodeToString(digest.Sum(nil))
	return output, nil
}

func td8OutputHTTPMetadata(relative string) (contentType, disposition, encoding, cacheControl string) {
	// Match the publisher's generated-index policy: JSON is short-lived, while
	// content-addressed gzip search parts are immutable binary objects.
	if strings.HasSuffix(relative, ".gz") {
		return "application/octet-stream", "inline", "", "public, max-age=31536000, immutable"
	}
	return "application/json; charset=utf-8", "inline", "", "public, max-age=0, s-maxage=60, must-revalidate"
}

func td8WriteHashField(destination hash.Hash, value []byte) {
	var size [8]byte
	binary.BigEndian.PutUint64(size[:], uint64(len(value)))
	_, _ = destination.Write(size[:])
	_, _ = destination.Write(value)
}
