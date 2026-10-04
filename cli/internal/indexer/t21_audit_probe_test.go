//go:build t21audit

package indexer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"testing"
	"time"
)

// Explicitly tagged T21 audit probe. Run with `go test -tags t21audit`; it uses
// only an ignored fixture and measures the standalone index resource-size slope.
func TestT21ProbeIndexBuildResourceSizeSlope(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(root, "../../../.local/t21-audit/index-slope")
	source := filepath.Join(work, "source")
	out := filepath.Join(work, "out")
	if err := os.RemoveAll(work); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(work) })
	if err := os.MkdirAll(filepath.Join(source, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(source, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	fixedTime := time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 10; i++ {
		name := fmt.Sprintf("doc-%02d.md", i)
		body := []byte(fmt.Sprintf("# Document %02d\n\nFixed site-index resource slope probe.\n", i))
		path := filepath.Join(source, "docs", name)
		if err := os.WriteFile(path, body, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, fixedTime, fixedTime); err != nil {
			t.Fatal(err)
		}
	}
	resource := filepath.Join(source, "assets", "payload.bin")
	if err := os.WriteFile(resource, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(resource, fixedTime, fixedTime); err != nil {
		t.Fatal(err)
	}

	points := []int64{0, 10 << 20, 100 << 20}
	var wantOutput string
	for _, size := range points {
		if err := os.Truncate(resource, size); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(resource, fixedTime, fixedTime); err != nil {
			t.Fatal(err)
		}
		if err := os.RemoveAll(out); err != nil {
			t.Fatal(err)
		}
		runtime.GC()
		var before runtime.MemStats
		runtime.ReadMemStats(&before)
		started := time.Now()
		prepared, err := PrepareBuild(context.Background(), BuildOptions{
			SiteID: "t21-index", SiteTitle: "T21 index-only resource slope",
			SourceDir: source, OutputDir: out,
			Repository: "acme/t21", RepositoryURL: "https://github.com/acme/t21", Ref: "refs/heads/main",
			Now: func() time.Time { return fixedTime },
		})
		prepareElapsed := time.Since(started)
		if err != nil {
			t.Fatalf("PrepareBuild(size=%d): %v", size, err)
		}
		// Force collection while retaining the prepared snapshot so HeapAlloc
		// measures live retained heap, not unreclaimed short-lived allocations.
		runtime.GC()
		runtime.KeepAlive(prepared)
		var afterPrepare runtime.MemStats
		runtime.ReadMemStats(&afterPrepare)
		buildStarted := time.Now()
		result, err := BuildPrepared(context.Background(), prepared, out)
		buildElapsed := time.Since(buildStarted)
		if err != nil {
			t.Fatalf("BuildPrepared(size=%d): %v", size, err)
		}
		var afterBuild runtime.MemStats
		runtime.GC()
		runtime.KeepAlive(prepared)
		runtime.ReadMemStats(&afterBuild)
		outputDigest, err := t21OutputDigest(out)
		if err != nil {
			t.Fatal(err)
		}
		if wantOutput == "" {
			wantOutput = outputDigest
		} else if outputDigest != wantOutput {
			t.Fatalf("generated output changed at resource size %d: got %s want %s", size, outputDigest, wantOutput)
		}
		t.Logf("resource=%d bytes scanned=%d preparedInputRoot=%s prepare=%s liveHeapDeltaAfterPrepare=%d liveHeapAfterPrepare=%d build=%s liveHeapDeltaAfterBuild=%d outputBytes=%d outputSHA256=%s", size, result.FilesScanned, prepared.InputRoot(), prepareElapsed, int64(afterPrepare.HeapAlloc)-int64(before.HeapAlloc), int64(afterPrepare.HeapAlloc), buildElapsed, int64(afterBuild.HeapAlloc)-int64(afterPrepare.HeapAlloc), result.OutputBytes+result.MetadataBytes+result.SearchBytes, outputDigest)
	}
}

func t21OutputDigest(root string) (string, error) {
	var paths []string
	err := filepath.WalkDir(root, func(file string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			relative, err := filepath.Rel(root, file)
			if err != nil {
				return err
			}
			paths = append(paths, relative)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(paths)
	hash := sha256.New()
	for _, relative := range paths {
		body, err := os.ReadFile(filepath.Join(root, relative))
		if err != nil {
			return "", err
		}
		_, _ = hash.Write([]byte(relative))
		_, _ = hash.Write(body)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
