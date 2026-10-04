//go:build td9audit

package publisher

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"hash"
	"os"
	"sort"
	"strings"
	"testing"
	"time"
)

// This local-only probe compares source-derived legacy per-file hash work with
// the captured digest path and measures the real in-memory DeployApp operation.
// Hash counts/bytes are code-path counts, not production instrumentation. The
// only timed path is candidate DeployApp; timing excludes no local work and
// makes no provider/network claim.
func TestTD9ProbeAppDigestReuseAcrossBundleAndChangeShapes(t *testing.T) {
	const repeats = 3
	for _, fixture := range []struct {
		name        string
		payloadSize int
	}{
		{name: "small", payloadSize: 1 << 20},
		{name: "medium", payloadSize: 8 << 20},
		{name: "large", payloadSize: 32 << 20},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			archive := td9CreateBundle(t, fixture.payloadSize)
			archiveInfo, err := os.Stat(archive)
			if err != nil {
				t.Fatal(err)
			}
			bundle, err := loadAppBundle(archive)
			if err != nil {
				t.Fatalf("load reference bundle: %v", err)
			}
			totalBytes := td9BundleBytes(bundle.files)
			if totalBytes < int64(fixture.payloadSize) || len(bundle.files) != 5 {
				t.Fatalf("fixture bundle bytes/files = %d/%d, want >=%d/5", totalBytes, len(bundle.files), fixture.payloadSize)
			}
			expectedObjects := td9ReferenceObjects(bundle)
			expectedFingerprint, expectedBodyBytes := td9ObjectsFingerprint(expectedObjects)

			for _, scenario := range []struct {
				name          string
				existingFiles int
				changedPaths  []string
			}{
				{name: "initial", existingFiles: 0, changedPaths: td9AllPaths(bundle.files)},
				{name: "noop", existingFiles: len(bundle.files)},
				{name: "sparse", existingFiles: len(bundle.files), changedPaths: []string{"assets/runtime.js"}},
				{name: "dense", existingFiles: len(bundle.files), changedPaths: td9AllPaths(bundle.files)},
			} {
				t.Run(scenario.name, func(t *testing.T) {
					var elapsedSamples []time.Duration
					var lastOps td9OperationCounts
					var lastResult Result
					for range repeats {
						backend := newAppCachePublishBackend()
						if scenario.existingFiles > 0 {
							td9SeedAppBundle(t, backend.store, bundle)
						}
						if scenario.existingFiles > 0 {
							for _, changedPath := range scenario.changedPaths {
								td9CorruptAppDigest(t, backend.store, changedPath)
							}
						}

						started := time.Now()
						result, deployErr := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive})
						elapsedSamples = append(elapsedSamples, time.Since(started))
						if deployErr != nil {
							t.Fatalf("DeployApp() error = %v", deployErr)
						}
						wantChanged := len(scenario.changedPaths)
						if scenario.name == "noop" {
							if result.Outcome != "no-op" || result.FilesPublished != 0 {
								t.Fatalf("DeployApp() no-op result = %+v", result)
							}
						} else if result.Outcome != "deployed" || result.FilesPublished != wantChanged {
							t.Fatalf("DeployApp() result = %+v, want deployed %d changed files", result, wantChanged)
						}

						lastOps = td9CountOperations(backend.store)
						lastResult = result
						td9AssertOperationCounts(t, lastOps, len(bundle.files), wantChanged)
						td9AssertAppObjects(t, backend.store, expectedObjects)
						actualObjects := td9ReadAppObjects(t, backend.store)
						actualFingerprint, actualBodyBytes := td9ObjectsFingerprint(actualObjects)
						if actualFingerprint != expectedFingerprint || actualBodyBytes != expectedBodyBytes {
							t.Fatalf("candidate output fingerprint/body bytes = %s/%d, reference = %s/%d", actualFingerprint, actualBodyBytes, expectedFingerprint, expectedBodyBytes)
						}
					}

					beforeCalls, beforeBytes := td9LegacyHashWork(bundle.files, scenario.existingFiles, scenario.changedPaths)
					afterCalls, afterBytes := len(bundle.files), totalBytes
					if afterBytes != totalBytes {
						t.Fatalf("candidate per-file hash bytes = %d, want one pass over %d captured bytes", afterBytes, totalBytes)
					}
					if lastOps.applicationHEADs != len(bundle.files) || lastOps.appPuts != len(scenario.changedPaths) {
						t.Fatalf("final measured operation counts = %+v, changed paths = %v", lastOps, scenario.changedPaths)
					}
					archiveHashDigest := bundle.sha256
					if archiveHashDigest == "" {
						t.Fatal("archive checksum digest is empty")
					}
					t.Logf("bundle=%s archiveBytes=%d capturedFileBytes=%d files=%d scenario=%s repeats=%d candidateDeployElapsedMedian=%s legacyPerFileSHA256CallsSourceDerived=%d legacyPerFileSHA256BytesSourceDerived=%d capturedPerFileSHA256CallsSourceDerived=%d capturedPerFileSHA256BytesSourceDerived=%d archiveChecksumSHA256Calls=1 archiveChecksumBytes=%d controlGETs=%d lockGETs=%d retryRecordGETs=%d applicationHEADs=%d applicationPUTs=%d lockConditionalPUTs=%d retryRecordConditionalPUTs=%d retryRecordDeleteCalls=%d invalidations=%d outputKeys=%d outputBodyBytes=%d outputKeyBodyHTTPMetadataSHA256=%s result=%s",
						fixture.name, archiveInfo.Size(), totalBytes, len(bundle.files), scenario.name, repeats,
						td9MedianDuration(elapsedSamples), beforeCalls, beforeBytes, afterCalls, afterBytes,
						archiveInfo.Size(), lastOps.controlGETs, lastOps.lockGETs, lastOps.retryRecordGETs,
						lastOps.applicationHEADs, lastOps.appPuts, lastOps.lockConditionalPUTs,
						lastOps.retryConditionalPUTs, lastOps.retryDeleteCalls, lastOps.invalidations,
						len(expectedObjects), expectedBodyBytes, expectedFingerprint, lastResult.Outcome,
					)
				})
			}
		})
	}
}

type td9OperationCounts struct {
	controlGETs          int
	lockGETs             int
	retryRecordGETs      int
	applicationHEADs     int
	appPuts              int
	lockConditionalPUTs  int
	retryConditionalPUTs int
	retryDeleteCalls     int
	invalidations        int
}

func td9CountOperations(store *appCachePublishStore) td9OperationCounts {
	counts := td9OperationCounts{
		controlGETs:      len(store.getKeys),
		applicationHEADs: len(store.headKeys),
		appPuts:          len(store.appPuts),
		invalidations:    len(store.invalidations),
	}
	for _, key := range store.getKeys {
		if key == "_control/locks/application.json" {
			counts.lockGETs++
		} else if key == appCacheRetryObjectKey {
			counts.retryRecordGETs++
		}
	}
	for _, key := range store.conditional {
		if key == "_control/locks/application.json" {
			counts.lockConditionalPUTs++
		} else if key == appCacheRetryObjectKey {
			counts.retryConditionalPUTs++
		}
	}
	for _, deletedKeys := range store.deletions {
		for _, key := range deletedKeys {
			if key == appCacheRetryObjectKey {
				counts.retryDeleteCalls++
			}
		}
	}
	return counts
}

func td9AssertOperationCounts(t *testing.T, got td9OperationCounts, bundleFiles, changedFiles int) {
	t.Helper()
	needsRetry := changedFiles > 0
	wantRetryCount := 0
	wantInvalidations := 0
	if needsRetry {
		wantRetryCount, wantInvalidations = 1, 1
	}
	want := td9OperationCounts{
		controlGETs:          4,
		lockGETs:             3,
		retryRecordGETs:      1,
		applicationHEADs:     bundleFiles,
		appPuts:              changedFiles,
		lockConditionalPUTs:  3,
		retryConditionalPUTs: wantRetryCount,
		retryDeleteCalls:     wantRetryCount,
		invalidations:        wantInvalidations,
	}
	if got != want {
		t.Fatalf("measured deployment operations = %+v, want %+v", got, want)
	}
}

func td9CreateBundle(t *testing.T, payloadSize int) string {
	t.Helper()
	perAsset := payloadSize / 4
	files := map[string][]byte{
		"index.html":        []byte("<!doctype html><main>TD9 digest reuse fixture</main>"),
		"assets/app.js":     td9Payload(perAsset, 0x1a2b3c4d),
		"assets/runtime.js": td9Payload(perAsset, 0x31415926),
		"assets/theme.css":  td9Payload(perAsset, 0x27182818),
		"assets/font.bin":   td9Payload(perAsset, 0x55aa55aa),
	}
	return createWebBundle(t, files)
}

func td9Payload(size int, seed uint32) []byte {
	data := make([]byte, size)
	state := seed
	for index := range data {
		state ^= state << 13
		state ^= state >> 17
		state ^= state << 5
		data[index] = byte(state >> 24)
	}
	return data
}

func td9BundleBytes(files []bundleFile) int64 {
	var total int64
	for _, file := range files {
		total += int64(len(file.data))
	}
	return total
}

func td9AllPaths(files []bundleFile) []string {
	paths := make([]string, 0, len(files))
	for _, file := range files {
		paths = append(paths, file.path)
	}
	return paths
}

func td9SeedAppBundle(t *testing.T, store *appCachePublishStore, bundle appBundle) {
	t.Helper()
	for _, file := range bundle.files {
		if err := store.objects.PutObject(context.Background(), file.path, Object{
			Bytes: file.data, ContentType: contentType(file.path), Cache: appFileCacheControl(file.path),
			Metadata: map[string]string{
				"artifact-pages-version":       bundle.manifest.Version,
				"artifact-pages-source-commit": bundle.manifest.SourceCommit,
				"artifact-pages-sha256":        file.sha256,
			},
		}); err != nil {
			t.Fatalf("seed bundle object %s: %v", file.path, err)
		}
	}
}

func td9CorruptAppDigest(t *testing.T, store *appCachePublishStore, key string) {
	t.Helper()
	object, _, err := store.objects.GetObject(context.Background(), key)
	if err != nil {
		t.Fatalf("read seeded app object %s: %v", key, err)
	}
	object.Metadata["artifact-pages-sha256"] = "drifted-digest"
	if err := store.objects.PutObject(context.Background(), key, object); err != nil {
		t.Fatalf("write drifted app object %s: %v", key, err)
	}
}

func td9ReferenceObjects(bundle appBundle) map[string]Object {
	objects := make(map[string]Object, len(bundle.files))
	for _, file := range bundle.files {
		// This is the previous per-object upload rule, evaluated test-locally as
		// the semantic reference for keys, bodies, policy, and metadata.
		objects[file.path] = Object{
			Bytes: file.data, ContentType: contentType(file.path), Cache: appFileCacheControl(file.path),
			Metadata: map[string]string{
				"artifact-pages-version":       bundle.manifest.Version,
				"artifact-pages-source-commit": bundle.manifest.SourceCommit,
				"artifact-pages-sha256":        sha256Hex(file.data),
			},
		}
	}
	return objects
}

func td9ReadAppObjects(t *testing.T, store *appCachePublishStore) map[string]Object {
	t.Helper()
	store.objects.mu.Lock()
	defer store.objects.mu.Unlock()
	objects := make(map[string]Object)
	for key, object := range store.objects.objects {
		if !strings.HasPrefix(key, "_control/") {
			objects[key] = object
		}
	}
	return objects
}

func td9AssertAppObjects(t *testing.T, store *appCachePublishStore, expected map[string]Object) {
	t.Helper()
	actual := td9ReadAppObjects(t, store)
	if len(actual) != len(expected) {
		t.Fatalf("application object keys = %v, want %v", td9SortedKeys(actual), td9SortedKeys(expected))
	}
	for key, want := range expected {
		got, exists := actual[key]
		if !exists || !bytes.Equal(got.Bytes, want.Bytes) || got.ContentType != want.ContentType ||
			got.ContentDisposition != want.ContentDisposition || got.ContentEncoding != want.ContentEncoding ||
			got.Cache != want.Cache || !td9EqualMetadata(got.Metadata, want.Metadata) {
			t.Fatalf("application object %q = %+v; want identical body and HTTP/custom metadata", key, got)
		}
	}
}

func td9SortedKeys(objects map[string]Object) []string {
	keys := make([]string, 0, len(objects))
	for key := range objects {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func td9EqualMetadata(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}

func td9ObjectsFingerprint(objects map[string]Object) (string, int64) {
	keys := td9SortedKeys(objects)
	digest := sha256.New()
	var bodyBytes int64
	for _, key := range keys {
		object := objects[key]
		td9WriteHashField(digest, []byte(key))
		td9WriteHashField(digest, object.Bytes)
		td9WriteHashField(digest, []byte(object.ContentType))
		td9WriteHashField(digest, []byte(object.ContentDisposition))
		td9WriteHashField(digest, []byte(object.ContentEncoding))
		td9WriteHashField(digest, []byte(object.Cache))
		metadataKeys := make([]string, 0, len(object.Metadata))
		for metadataKey := range object.Metadata {
			metadataKeys = append(metadataKeys, metadataKey)
		}
		sort.Strings(metadataKeys)
		for _, metadataKey := range metadataKeys {
			td9WriteHashField(digest, []byte(metadataKey))
			td9WriteHashField(digest, []byte(object.Metadata[metadataKey]))
		}
		bodyBytes += int64(len(object.Bytes))
	}
	return hex.EncodeToString(digest.Sum(nil)), bodyBytes
}

func td9WriteHashField(destination hash.Hash, value []byte) {
	var size [8]byte
	binary.BigEndian.PutUint64(size[:], uint64(len(value)))
	_, _ = destination.Write(size[:])
	_, _ = destination.Write(value)
}

func td9LegacyHashWork(files []bundleFile, existingFiles int, changedPaths []string) (int, int64) {
	changed := make(map[string]struct{}, len(changedPaths))
	for _, key := range changedPaths {
		changed[key] = struct{}{}
	}
	calls := 0
	var bytesHashed int64
	for index, file := range files {
		if index < existingFiles {
			calls++
			bytesHashed += int64(len(file.data))
		}
		if _, isChanged := changed[file.path]; isChanged {
			calls++
			bytesHashed += int64(len(file.data))
		}
	}
	return calls, bytesHashed
}

func td9MedianDuration(samples []time.Duration) time.Duration {
	ordered := append([]time.Duration(nil), samples...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i] < ordered[j] })
	return ordered[len(ordered)/2]
}
