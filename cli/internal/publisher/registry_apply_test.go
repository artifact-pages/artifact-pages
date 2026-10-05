package publisher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	deploymentconfig "github.com/artifact-pages/artifact-pages/cli/internal/config"
	"github.com/artifact-pages/artifact-pages/cli/internal/registry"
)

const currentAdminManifest = `schemaVersion: 1
sites:
  legacy:
    name: Legacy
    repository: acme/legacy
    sourcePath: docs
  sre:
    name: Old SRE
    repository: acme/sre
    sourcePath: docs/artifacts
`

const manifestWithoutLegacy = `schemaVersion: 1
sites:
  sre:
    name: Old SRE
    repository: acme/sre
    sourcePath: docs/artifacts
`

const desiredAdminManifest = `schemaVersion: 1
sites:
  docs:
    name: Documentation
    repository: acme/docs
    sourcePath: artifacts
  sre:
    name: SRE & Platform
    repository: acme/sre
    sourcePath: docs/artifacts
`

const manifestWithoutSRE = `schemaVersion: 1
sites:
  docs:
    name: Documentation
    repository: acme/docs
    sourcePath: artifacts
`

const registrySREOnlyManifest = `schemaVersion: 1
sites:
  sre:
    name: Old SRE
    repository: acme/sre
    sourcePath: docs/artifacts
`

const registrySREAndDocsManifest = `schemaVersion: 1
sites:
  docs:
    name: Documentation
    repository: acme/docs
    sourcePath: artifacts
  sre:
    name: Old SRE
    repository: acme/sre
    sourcePath: docs/artifacts
`

const registrySREMetadataChangedManifest = `schemaVersion: 1
sites:
  sre:
    name: SRE Platform
    repository: acme/sre
    sourcePath: docs/artifacts
`

func TestRegisterSitesDryRunMatchesApplyPlanAndDoesNotWrite(t *testing.T) {
	backend := newRegistryApplyTestBackend()
	seedRegistryFromManifest(t, backend, currentAdminManifest)
	backend.seed("_artifacts/legacy/report.html", []byte("legacy artifact"))
	backend.seed("_indexes/legacy/meta.json", []byte("{}"))
	backend.seed("_previews/legacy/revision/index.html", []byte("preview"))
	beforeObjects, beforeETags := backend.snapshot()

	planned, err := RegisterSites(context.Background(), backend, testRegistryProjection(t, desiredAdminManifest), true)
	if err != nil {
		t.Fatalf("RegisterSites(dry-run) error = %v", err)
	}
	expected := []Change{
		{Action: "invalidate", Path: "/_artifacts/legacy/*"},
		{Action: "invalidate", Path: "/_indexes/legacy/*"},
		{Action: "invalidate", Path: "/_indexes/sites.json"},
		{Action: "invalidate", Path: "/_previews/legacy/*"},
		{Action: "invalidate", Path: "/legacy"},
		{Action: "invalidate", Path: "/legacy/*"},
		{Action: "remove", Path: "/legacy/*"},
		{Action: "remove", Path: "_artifacts/legacy/report.html"},
		{Action: "remove", Path: "_indexes/legacy/meta.json"},
		{Action: "update", Path: "_indexes/sites.json"},
		{Action: "create", Path: "_indexes/sites.json#sites/docs"},
		{Action: "remove", Path: "_indexes/sites.json#sites/legacy"},
		{Action: "update", Path: "_indexes/sites.json#sites/sre"},
		{Action: "remove", Path: "_previews/legacy/revision/index.html"},
	}
	if planned.Outcome != "planned" || !reflect.DeepEqual(planned.Changes, expected) {
		t.Fatalf("dry-run result = %+v, want exact plan %+v", planned, expected)
	}
	assertRegistryUpdatedJSON(t, planned, false, false)
	assertNoRegistryApplyWrites(t, backend)
	if afterObjects, afterETags := backend.snapshot(); !reflect.DeepEqual(beforeObjects, afterObjects) || !reflect.DeepEqual(beforeETags, afterETags) {
		t.Fatal("dry-run changed deployed objects or ETags")
	}

	backend.resetCounters()
	applied, err := RegisterSites(context.Background(), backend, testRegistryProjection(t, desiredAdminManifest), false)
	if err != nil {
		t.Fatalf("RegisterSites() error = %v", err)
	}
	if !reflect.DeepEqual(applied.Changes, planned.Changes) {
		t.Fatalf("apply plan = %+v, dry-run plan = %+v", applied.Changes, planned.Changes)
	}
	if applied.Outcome != "registered" {
		t.Fatalf("apply outcome = %q, want registered", applied.Outcome)
	}
	assertRegistryUpdatedJSON(t, applied, true, false)
	wantLegacyPaths := registryInvalidationPaths(true, []string{"legacy"})
	if len(backend.invalidations) != 1 || !reflect.DeepEqual(backend.invalidations[0], wantLegacyPaths) {
		t.Fatalf("provider invalidations = %v, want registry and removed-site routes", backend.invalidations)
	}
	for _, key := range []string{"_artifacts/legacy/report.html", "_indexes/legacy/meta.json", "_previews/legacy/revision/index.html"} {
		if _, exists := backend.objects[key]; exists {
			t.Errorf("removed site object %q remains after apply", key)
		}
	}
	registryObject, _, err := backend.GetObject(context.Background(), "_indexes/sites.json")
	if err != nil {
		t.Fatalf("read applied registry: %v", err)
	}
	_, expectedProjection, err := testRegistryBuild(t, []byte(desiredAdminManifest))
	if err != nil {
		t.Fatal(err)
	}
	actualProjection, err := registry.DecodeProjection(registryObject.Bytes)
	if err != nil || !reflect.DeepEqual(actualProjection, expectedProjection) {
		t.Fatalf("applied projection = %+v, err=%v; want %+v", actualProjection, err, expectedProjection)
	}
}

func TestRegisterSitesNoOpReportsExplicitFalseAndEmptyChanges(t *testing.T) {
	backend := newRegistryApplyTestBackend()
	seedRegistryFromManifest(t, backend, desiredAdminManifest)
	before, _ := backend.snapshot()

	result, err := RegisterSites(context.Background(), backend, testRegistryProjection(t, desiredAdminManifest), false)
	if err != nil {
		t.Fatalf("RegisterSites(no-op) error = %v", err)
	}
	if result.Outcome != "no-op" || result.Changes == nil || len(result.Changes) != 0 {
		t.Fatalf("no-op result = %+v, want outcome no-op and a non-nil empty change list", result)
	}
	assertRegistryUpdatedJSON(t, result, false, true)
	if len(backend.invalidations) != 0 || backend.deleteCalls != 0 {
		t.Fatalf("no-op provider side effects: deletes=%d invalidations=%v", backend.deleteCalls, backend.invalidations)
	}
	after, _ := backend.snapshot()
	if !reflect.DeepEqual(before["_indexes/sites.json"], after["_indexes/sites.json"]) {
		t.Fatal("no-op changed the deployed registry object")
	}
}

func TestRegisterSitesRetainsPendingCatalogInvalidationWhenCleanupTargetIsRegistered(t *testing.T) {
	backend := newRegistryApplyTestBackend()
	seedRegistryFromManifest(t, backend, desiredAdminManifest)
	pendingPaths := registryInvalidationPaths(true, []string{"docs"})
	cleanupBytes, err := json.Marshal(registryCleanupRecord{SchemaVersion: 1, Sites: []string{"docs"}, Paths: pendingPaths})
	if err != nil {
		t.Fatalf("marshal cleanup retry record: %v", err)
	}
	backend.seed(registryCleanupKey, cleanupBytes)
	backend.failNextInvalidate = true
	beforeDryRunObjects, beforeDryRunETags := backend.snapshot()

	planned, err := RegisterSites(context.Background(), backend, testRegistryProjection(t, desiredAdminManifest), true)
	if err != nil {
		t.Fatalf("RegisterSites(dry-run) error = %v", err)
	}
	assertRegistryInvalidationPlan(t, planned, pendingPaths)
	assertNoRegistryApplyWrites(t, backend)
	if afterObjects, afterETags := backend.snapshot(); !reflect.DeepEqual(beforeDryRunObjects, afterObjects) || !reflect.DeepEqual(beforeDryRunETags, afterETags) {
		t.Fatal("dry-run changed deployed objects, ETags, or retry record")
	}

	first, err := RegisterSites(context.Background(), backend, testRegistryProjection(t, desiredAdminManifest), false)
	if err == nil || !strings.Contains(err.Error(), "cache revalidation failed") {
		t.Fatalf("RegisterSites() = %+v, %v; want invalidation failure", first, err)
	}
	if _, _, err := backend.GetObject(context.Background(), registryCleanupKey); err != nil {
		t.Fatalf("pending retry record after failed invalidation = %v; want retained", err)
	}
	if len(backend.invalidations) != 1 || !reflect.DeepEqual(backend.invalidations[0], pendingPaths) {
		t.Fatalf("first invalidation paths = %v; want preserved catalog and site paths", backend.invalidations)
	}

	backend.resetCounters()
	second, err := RegisterSites(context.Background(), backend, testRegistryProjection(t, desiredAdminManifest), false)
	if err != nil {
		t.Fatalf("retry RegisterSites() error = %v", err)
	}
	if second.Outcome != "registered" {
		t.Fatalf("retry outcome = %q; want catalog invalidation retry", second.Outcome)
	}
	assertRegistryUpdatedJSON(t, second, false, false)
	assertRegistryInvalidationPlan(t, second, pendingPaths)
	if len(backend.invalidations) != 1 || !reflect.DeepEqual(backend.invalidations[0], pendingPaths) {
		t.Fatalf("retry invalidation paths = %v; want the complete retained site path set", backend.invalidations)
	}
	if _, _, err := backend.GetObject(context.Background(), registryCleanupKey); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("cleanup retry record after successful invalidation = %v; want cleared", err)
	}
}

func TestRegisterSitesPersistsCatalogRetryForAddAndMetadataOnlyChanges(t *testing.T) {
	tests := []struct {
		name    string
		initial string
		desired string
	}{
		{name: "add only", initial: registrySREOnlyManifest, desired: registrySREAndDocsManifest},
		{name: "metadata only", initial: registrySREOnlyManifest, desired: registrySREMetadataChangedManifest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			backend := newRegistryApplyTestBackend()
			seedRegistryFromManifest(t, backend, test.initial)
			before, beforeETag, err := backend.GetObject(context.Background(), "_indexes/sites.json")
			if err != nil {
				t.Fatal(err)
			}
			backend.failNextInvalidate = true
			first, err := RegisterSites(context.Background(), backend, testRegistryProjection(t, test.desired), false)
			if err == nil || !strings.Contains(err.Error(), "cache revalidation failed") {
				t.Fatalf("first register = %+v, %v; want purge failure", first, err)
			}
			if first.RegistryUpdated == nil || !*first.RegistryUpdated {
				t.Fatalf("first register = %+v; want registry write before purge", first)
			}
			recordObject, _, err := backend.GetObject(context.Background(), registryCleanupKey)
			if err != nil {
				t.Fatalf("read persisted retry record: %v", err)
			}
			var record registryCleanupRecord
			if err := json.Unmarshal(recordObject.Bytes, &record); err != nil {
				t.Fatalf("decode retry record: %v", err)
			}
			if len(record.Sites) != 0 || !reflect.DeepEqual(record.Paths, []string{"/_indexes/sites.json"}) {
				t.Fatalf("retry record = %+v; want empty cleanup sites and catalog path", record)
			}
			updatedRegistry, updatedETag, err := backend.GetObject(context.Background(), "_indexes/sites.json")
			if err != nil || updatedETag == beforeETag || bytes.Equal(updatedRegistry.Bytes, before.Bytes) {
				t.Fatalf("registry after initial operation unchanged: etag %q -> %q, err=%v", beforeETag, updatedETag, err)
			}

			backend.resetCounters()
			second, err := RegisterSites(context.Background(), backend, testRegistryProjection(t, test.desired), false)
			if err != nil {
				t.Fatalf("retry register: %v", err)
			}
			if second.Outcome != "registered" || second.RegistryUpdated == nil || *second.RegistryUpdated {
				t.Fatalf("retry result = %+v; want cache-only registered outcome", second)
			}
			if len(backend.invalidations) != 1 || !reflect.DeepEqual(backend.invalidations[0], []string{"/_indexes/sites.json"}) {
				t.Fatalf("retry invalidations = %v; want catalog only", backend.invalidations)
			}
			if _, _, err := backend.GetObject(context.Background(), registryCleanupKey); !errors.Is(err, ErrObjectNotFound) {
				t.Fatalf("retry record after purge = %v; want cleared", err)
			}
			registryAfterRetry, registryAfterRetryETag, err := backend.GetObject(context.Background(), "_indexes/sites.json")
			if err != nil || !bytes.Equal(registryAfterRetry.Bytes, updatedRegistry.Bytes) || registryAfterRetryETag != updatedETag {
				t.Fatalf("cache-only retry changed registry: etag=%q want=%q err=%v", registryAfterRetryETag, updatedETag, err)
			}
		})
	}
}

func TestRegistryCleanupRecordRejectsOldOrUnsafeShape(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "old Sites-only record", body: `{"schemaVersion":1,"sites":["docs"]}`},
		{name: "duplicate key", body: `{"schemaVersion":1,"sites":[],"paths":["/_indexes/sites.json"],"paths":[]}`},
		{name: "out of scope path", body: `{"schemaVersion":1,"sites":[],"paths":["/_control/locks/registry.json"]}`},
		{name: "unsorted paths", body: `{"schemaVersion":1,"sites":[],"paths":["/z-site","/_indexes/sites.json"]}`},
		{name: "null paths", body: `{"schemaVersion":1,"sites":[],"paths":null}`},
		{name: "site without paths", body: `{"schemaVersion":1,"sites":["docs"],"paths":[]}`},
		{name: "site with partial paths", body: `{"schemaVersion":1,"sites":["docs"],"paths":["/_indexes/sites.json"]}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			backend := newRegistryApplyTestBackend()
			backend.seed(registryCleanupKey, []byte(test.body))
			if _, _, err := readRegistryCleanup(context.Background(), backend); err == nil {
				t.Fatal("readRegistryCleanup() succeeded for an invalid record")
			}
		})
	}
}

func TestRegisterReaddedSitePreservesPendingPathsButStopsCleanup(t *testing.T) {
	backend := newRegistryApplyTestBackend()
	seedRegistryFromManifest(t, backend, currentAdminManifest)
	backend.seed("_artifacts/legacy/report.html", []byte("legacy artifact"))
	backend.seed("_indexes/legacy/meta.json", []byte(`{"site":"legacy"}`))
	backend.seed("_previews/legacy/catalog.json", []byte(`{"site":"legacy"}`))
	removedProjection := testRegistryProjection(t, manifestWithoutLegacy)
	backend.failNextInvalidate = true
	if _, err := UnregisterSite(context.Background(), backend, removedProjection, "legacy", false); err == nil {
		t.Fatal("UnregisterSite() succeeded with injected invalidation failure")
	}
	paths := registryInvalidationPaths(true, []string{"legacy"})
	firstRecordObject, _, err := backend.GetObject(context.Background(), registryCleanupKey)
	if err != nil {
		t.Fatalf("read unregister journal: %v", err)
	}
	var firstRecord registryCleanupRecord
	if err := json.Unmarshal(firstRecordObject.Bytes, &firstRecord); err != nil || !reflect.DeepEqual(firstRecord.Sites, []string{"legacy"}) || !reflect.DeepEqual(firstRecord.Paths, paths) {
		t.Fatalf("journal after unregister failure = %+v, err=%v; want legacy cleanup and full paths", firstRecord, err)
	}

	// Model the site being restored after its previous origin deletion but before
	// the failed cache purge is retried. Re-registration must preserve that data.
	backend.seed("_artifacts/legacy/restored.html", []byte("restored content"))
	backend.failNextInvalidate = true
	readded, err := RegisterSites(context.Background(), backend, testRegistryProjection(t, currentAdminManifest), false)
	if err == nil || !strings.Contains(err.Error(), "cache revalidation failed") {
		t.Fatalf("RegisterSites(re-add) = %+v, %v; want pending purge failure", readded, err)
	}
	if readded.RegistryUpdated == nil || !*readded.RegistryUpdated || readded.FilesRemoved != 0 {
		t.Fatalf("re-add result = %+v; want registry update and no site cleanup", readded)
	}
	if got := string(backend.objects["_artifacts/legacy/restored.html"].Bytes); got != "restored content" {
		t.Fatalf("re-added site's restored content = %q; cleanup must stop after desired re-registration", got)
	}
	secondRecordObject, _, err := backend.GetObject(context.Background(), registryCleanupKey)
	if err != nil {
		t.Fatalf("read re-add journal: %v", err)
	}
	var secondRecord registryCleanupRecord
	if err := json.Unmarshal(secondRecordObject.Bytes, &secondRecord); err != nil || len(secondRecord.Sites) != 0 || !reflect.DeepEqual(secondRecord.Paths, paths) {
		t.Fatalf("journal after re-add failure = %+v, err=%v; want no cleanup sites and preserved old paths", secondRecord, err)
	}

	beforeRegistry, beforeRegistryETag, err := backend.GetObject(context.Background(), "_indexes/sites.json")
	if err != nil {
		t.Fatal(err)
	}
	backend.resetCounters()
	third, err := RegisterSites(context.Background(), backend, testRegistryProjection(t, currentAdminManifest), false)
	if err != nil {
		t.Fatalf("RegisterSites(retry re-add) error = %v", err)
	}
	if third.Outcome != "registered" || third.RegistryUpdated == nil || *third.RegistryUpdated || third.FilesRemoved != 0 {
		t.Fatalf("cache-only re-add retry = %+v; want successful purge without registry write or site deletion", third)
	}
	if len(backend.invalidations) != 1 || !reflect.DeepEqual(backend.invalidations[0], paths) {
		t.Fatalf("re-add retry invalidations = %v; want the prior unregister URL set", backend.invalidations)
	}
	if got := string(backend.objects["_artifacts/legacy/restored.html"].Bytes); got != "restored content" {
		t.Fatalf("re-added site content after purge retry = %q; want preserved", got)
	}
	registryAfterRetry, registryAfterRetryETag, err := backend.GetObject(context.Background(), "_indexes/sites.json")
	if err != nil || !bytes.Equal(registryAfterRetry.Bytes, beforeRegistry.Bytes) || registryAfterRetryETag != beforeRegistryETag {
		t.Fatalf("cache-only re-add retry changed registry: ETag=%q want=%q err=%v", registryAfterRetryETag, beforeRegistryETag, err)
	}
	if _, _, err := backend.GetObject(context.Background(), registryCleanupKey); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("journal after successful re-add purge = %v; want cleared", err)
	}
}

func TestRegistryCleanupIntentFailureStopsCatalogMutationAndCanResumeAfterAmbiguousWrite(t *testing.T) {
	tests := []struct {
		name      string
		ambiguous bool
	}{
		{name: "conditional failure before persistence"},
		{name: "response lost after persistence", ambiguous: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			backend := newRegistryApplyTestBackend()
			seedRegistryFromManifest(t, backend, registrySREOnlyManifest)
			before, beforeETag, err := backend.GetObject(context.Background(), "_indexes/sites.json")
			if err != nil {
				t.Fatal(err)
			}
			putErr := errors.New("injected retry-record write response failure")
			if test.ambiguous {
				backend.conditionalAfterWriteKey = registryCleanupKey
				backend.conditionalAfterWriteErr = putErr
			} else {
				backend.conditionalFailKey = registryCleanupKey
				backend.conditionalFailErr = putErr
			}
			first, err := RegisterSites(context.Background(), backend, testRegistryProjection(t, registrySREAndDocsManifest), false)
			if !errors.Is(err, putErr) {
				t.Fatalf("first register = %+v, %v; want retry-record write error", first, err)
			}
			if first.RegistryUpdated == nil || *first.RegistryUpdated {
				t.Fatalf("first result = %+v; catalog must not be written before retry intent", first)
			}
			after, afterETag, err := backend.GetObject(context.Background(), "_indexes/sites.json")
			if err != nil || afterETag != beforeETag || !bytes.Equal(after.Bytes, before.Bytes) {
				t.Fatalf("registry after intent error changed: ETag %q -> %q, err=%v", beforeETag, afterETag, err)
			}
			if len(backend.invalidations) != 0 {
				t.Fatalf("invalidations after intent error = %v; want none", backend.invalidations)
			}
			if _, _, readErr := backend.GetObject(context.Background(), registryCleanupKey); test.ambiguous && readErr != nil {
				t.Fatalf("ambiguous intent write was not persisted: %v", readErr)
			} else if !test.ambiguous && !errors.Is(readErr, ErrObjectNotFound) {
				t.Fatalf("failed intent unexpectedly persisted: %v", readErr)
			}

			second, err := RegisterSites(context.Background(), backend, testRegistryProjection(t, registrySREAndDocsManifest), false)
			if err != nil {
				t.Fatalf("retry after intent error = %+v, %v", second, err)
			}
			if second.Outcome != "registered" || second.RegistryUpdated == nil || !*second.RegistryUpdated {
				t.Fatalf("retry result = %+v; want successful catalog update", second)
			}
			if len(backend.invalidations) != 1 || !reflect.DeepEqual(backend.invalidations[0], []string{"/_indexes/sites.json"}) {
				t.Fatalf("retry invalidations = %v; want catalog path", backend.invalidations)
			}
			if _, _, readErr := backend.GetObject(context.Background(), registryCleanupKey); !errors.Is(readErr, ErrObjectNotFound) {
				t.Fatalf("record after successful retry = %v; want cleared", readErr)
			}
		})
	}
}

func TestUnregisterSiteRetriesRemovedSiteCleanupAfterPostWriteFailures(t *testing.T) {
	tests := []struct {
		name   string
		inject func(*registryApplyTestBackend)
	}{
		{name: "listing", inject: func(backend *registryApplyTestBackend) { backend.failListPrefix = "_artifacts/legacy/" }},
		{name: "partial delete", inject: func(backend *registryApplyTestBackend) { backend.partialDeleteKey = "_indexes/legacy/meta.json" }},
		{name: "invalidation", inject: func(backend *registryApplyTestBackend) { backend.failNextInvalidate = true }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			backend := newRegistryApplyTestBackend()
			seedRegistryFromManifest(t, backend, currentAdminManifest)
			backend.seed("_artifacts/legacy/report.html", []byte("legacy artifact"))
			backend.seed("_indexes/legacy/meta.json", []byte(`{"site":"legacy"}`))
			backend.seed(sitePublishStateKey("legacy"), []byte("private legacy publish state"))
			seedForcedUnregisterFixture(t, backend)
			preservedBefore := make(map[string][]byte)
			for _, key := range []string{
				"_artifacts/sre/report.html", "_indexes/sre/meta.json", "_previews/sre/catalog.json",
				"_previews/sre/revisions/head/report.md", "_artifacts/docs/neighbor.html", "_indexes/docs/meta.json",
				"_previews/docs/catalog.json", "index.html", "assets/app.js", "_control/private/sentinel",
			} {
				object, _, err := backend.GetObject(context.Background(), key)
				if err != nil {
					t.Fatalf("read preservation fixture %q: %v", key, err)
				}
				preservedBefore[key] = object.Bytes
			}
			test.inject(backend)

			first, err := UnregisterSite(context.Background(), backend, testRegistryProjection(t, manifestWithoutLegacy), "legacy", false)
			if err == nil {
				t.Fatalf("first UnregisterSite() = %+v; want a post-registry-write %s failure", first, test.name)
			}
			if test.name == "listing" && !strings.Contains(err.Error(), "list site") {
				t.Fatalf("first UnregisterSite() error = %v; want listing failure", err)
			}
			if test.name != "listing" && !strings.Contains(err.Error(), "registry updated") {
				t.Fatalf("first UnregisterSite() error = %v; want post-registry-write %s failure", err, test.name)
			}
			assertRegistryUpdatedJSON(t, first, true, false)
			cleanupObject, _, err := backend.GetObject(context.Background(), registryCleanupKey)
			if err != nil {
				t.Fatalf("read retained cleanup retry record: %v", err)
			}
			var cleanup registryCleanupRecord
			if err := json.Unmarshal(cleanupObject.Bytes, &cleanup); err != nil || !reflect.DeepEqual(cleanup.Sites, []string{"legacy"}) {
				t.Fatalf("cleanup retry record = %+v, err=%v; want legacy target", cleanup, err)
			}
			deployedRegistry, deployedRegistryETag, err := backend.GetObject(context.Background(), "_indexes/sites.json")
			if err != nil {
				t.Fatalf("read registry after failure: %v", err)
			}
			_, expectedRegistry, _ := testRegistryBuild(t, []byte(manifestWithoutLegacy))
			actualRegistry, err := registry.DecodeProjection(deployedRegistry.Bytes)
			if err != nil || !reflect.DeepEqual(actualRegistry, expectedRegistry) {
				t.Fatalf("registry after failure = %+v, err=%v; want desired projection %+v", actualRegistry, err, expectedRegistry)
			}
			if test.name == "invalidation" {
				if len(backend.invalidations) != 1 || !reflect.DeepEqual(backend.invalidations[0], registryInvalidationPaths(true, []string{"legacy"})) {
					t.Fatalf("failed invalidation request = %v; want complete registry and site cache set", backend.invalidations)
				}
			} else if len(backend.invalidations) != 0 {
				t.Fatalf("invalidation requests after %s failure = %v; want none", test.name, backend.invalidations)
			}

			backend.resetCounters()
			beforeDryRunObjects, beforeDryRunETags := backend.snapshot()
			plannedRetry, err := UnregisterSite(context.Background(), backend, testRegistryProjection(t, manifestWithoutLegacy), "legacy", true)
			if err != nil {
				t.Fatalf("dry-run UnregisterSite() error = %v", err)
			}
			if plannedRetry.Outcome != "planned" {
				t.Fatalf("dry-run retry outcome = %q, want planned", plannedRetry.Outcome)
			}
			assertRegistryInvalidationPlan(t, plannedRetry, []string{
				"/_indexes/sites.json", "/legacy", "/legacy/*", "/_indexes/legacy/*", "/_artifacts/legacy/*", "/_previews/legacy/*",
			})
			assertNoRegistryApplyWrites(t, backend)
			if afterObjects, afterETags := backend.snapshot(); !reflect.DeepEqual(beforeDryRunObjects, afterObjects) || !reflect.DeepEqual(beforeDryRunETags, afterETags) {
				t.Fatal("dry-run retry changed deployed objects, ETags, or retry record")
			}

			second, err := UnregisterSite(context.Background(), backend, testRegistryProjection(t, manifestWithoutLegacy), "legacy", false)
			if err != nil {
				t.Fatalf("retry UnregisterSite() error = %v", err)
			}
			if second.Outcome != "unregistered" || second.Site != "legacy" {
				t.Fatalf("retry unregister result = %+v, want successful cleanup retry", second)
			}
			assertRegistryUpdatedJSON(t, second, false, false)
			assertRegistryInvalidationPlan(t, second, registryInvalidationPaths(true, []string{"legacy"}))
			if len(backend.invalidations) != 1 || !reflect.DeepEqual(backend.invalidations[0], registryInvalidationPaths(true, []string{"legacy"})) {
				t.Fatalf("retry provider invalidations = %v, want complete registry and site cache set", backend.invalidations)
			}
			if _, _, err := backend.GetObject(context.Background(), registryCleanupKey); !errors.Is(err, ErrObjectNotFound) {
				t.Fatalf("cleanup record after retry error = %v, want not found", err)
			}
			for _, key := range []string{"_artifacts/legacy/report.html", "_indexes/legacy/meta.json"} {
				if _, exists := backend.objects[key]; exists {
					t.Errorf("removed site object %q remains after successful cleanup retry", key)
				}
			}
			if _, exists := backend.objects[sitePublishStateKey("legacy")]; exists {
				t.Error("removed site's private publish state remains after successful cleanup retry")
			}
			for key, want := range preservedBefore {
				object, _, err := backend.GetObject(context.Background(), key)
				if err != nil || !bytes.Equal(object.Bytes, want) {
					t.Errorf("unrelated object %q changed during unregister: got=%q want=%q err=%v", key, object.Bytes, want, err)
				}
			}
			registryAfterRetry, registryAfterRetryETag, err := backend.GetObject(context.Background(), "_indexes/sites.json")
			if err != nil || !bytes.Equal(registryAfterRetry.Bytes, deployedRegistry.Bytes) || registryAfterRetryETag != deployedRegistryETag {
				t.Errorf("registry after retry changed: bytesEqual=%t etag=%q wantETag=%q err=%v", bytes.Equal(registryAfterRetry.Bytes, deployedRegistry.Bytes), registryAfterRetryETag, deployedRegistryETag, err)
			}
		})
	}
}

func TestUnregisterSiteRetriesForcedCleanupWhenRegistrationIsAlreadyAbsent(t *testing.T) {
	tests := []struct {
		name string
		fail func(*registryApplyTestBackend)
	}{
		{name: "listing failure", fail: func(backend *registryApplyTestBackend) { backend.failListPrefix = "_indexes/sre/" }},
		{name: "partial deletion", fail: func(backend *registryApplyTestBackend) { backend.partialDeleteKey = "_indexes/sre/meta.json" }},
		{name: "cache invalidation", fail: func(backend *registryApplyTestBackend) { backend.failNextInvalidate = true }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			backend := newRegistryApplyTestBackend()
			seedRegistryFromManifest(t, backend, manifestWithoutSRE)
			seedForcedUnregisterFixture(t, backend)
			registryBefore, registryETagBefore, err := backend.GetObject(context.Background(), "_indexes/sites.json")
			if err != nil {
				t.Fatalf("read registry before forced cleanup: %v", err)
			}
			preservedBefore := make(map[string][]byte)
			for _, key := range []string{
				"_artifacts/docs/neighbor.html", "_indexes/docs/meta.json", "_previews/docs/catalog.json",
				sitePublishStateKey("docs"), "index.html", "assets/app.js", "_control/private/sentinel", "_control/locks/sites/docs.json",
			} {
				object, _, err := backend.GetObject(context.Background(), key)
				if err != nil {
					t.Fatalf("read preservation fixture %q: %v", key, err)
				}
				preservedBefore[key] = object.Bytes
			}
			test.fail(backend)

			first, err := UnregisterSite(context.Background(), backend, testRegistryProjection(t, manifestWithoutSRE), "sre", false)
			if err == nil {
				t.Fatalf("first UnregisterSite() = %+v; want injected %s failure", first, test.name)
			}
			if first.Operation != "registry unregister" || first.Site != "sre" || first.RegistryUpdated == nil || *first.RegistryUpdated {
				t.Fatalf("first unregister result = %+v; want site identity and unchanged registry", first)
			}
			registryAfterFailure, registryETagAfterFailure, err := backend.GetObject(context.Background(), "_indexes/sites.json")
			if err != nil || !bytes.Equal(registryAfterFailure.Bytes, registryBefore.Bytes) || registryETagAfterFailure != registryETagBefore {
				t.Fatalf("registry after forced cleanup failure changed: bytesEqual=%t etag=%q wantETag=%q err=%v", bytes.Equal(registryAfterFailure.Bytes, registryBefore.Bytes), registryETagAfterFailure, registryETagBefore, err)
			}
			cleanupObject, _, err := backend.GetObject(context.Background(), registryCleanupKey)
			if err != nil {
				t.Fatalf("read retained cleanup record after %s failure: %v", test.name, err)
			}
			var cleanup registryCleanupRecord
			if err := json.Unmarshal(cleanupObject.Bytes, &cleanup); err != nil || !reflect.DeepEqual(cleanup.Sites, []string{"sre"}) {
				t.Fatalf("cleanup record after %s failure = %+v, err=%v; want explicit sre retry target", test.name, cleanup, err)
			}

			retry, err := UnregisterSite(context.Background(), backend, testRegistryProjection(t, manifestWithoutSRE), "sre", false)
			if err != nil {
				t.Fatalf("retry UnregisterSite() error = %v", err)
			}
			if retry.Outcome != "unregistered" || retry.Site != "sre" || retry.RegistryUpdated == nil || *retry.RegistryUpdated {
				t.Fatalf("retry unregister result = %+v; want successful forced cleanup without registry rewrite", retry)
			}
			registryAfterRetry, registryETagAfterRetry, err := backend.GetObject(context.Background(), "_indexes/sites.json")
			if err != nil || !bytes.Equal(registryAfterRetry.Bytes, registryBefore.Bytes) || registryETagAfterRetry != registryETagBefore {
				t.Fatalf("registry after forced cleanup retry changed: bytesEqual=%t etag=%q wantETag=%q err=%v", bytes.Equal(registryAfterRetry.Bytes, registryBefore.Bytes), registryETagAfterRetry, registryETagBefore, err)
			}
			if len(backend.invalidations) == 0 || !reflect.DeepEqual(backend.invalidations[len(backend.invalidations)-1], registryInvalidationPaths(true, []string{"sre"})) {
				t.Fatalf("final invalidation paths = %v; want catalog and exact site routes including preview paths", backend.invalidations)
			}
			if test.name == "cache invalidation" && len(backend.invalidations) != 2 {
				t.Fatalf("cache invalidations after failed request and retry = %v; want the request repeated", backend.invalidations)
			}
			if test.name != "cache invalidation" && len(backend.invalidations) != 1 {
				t.Fatalf("cache invalidations after %s failure and retry = %v; want one successful request", test.name, backend.invalidations)
			}
			for _, prefix := range []string{"_artifacts/sre/", "_indexes/sre/", "_previews/sre/"} {
				keys, err := backend.ListKeys(context.Background(), prefix)
				if err != nil || len(keys) != 0 {
					t.Fatalf("keys after retry under %q = %v, err=%v; want empty", prefix, keys, err)
				}
			}
			if _, exists := backend.objects[sitePublishStateKey("sre")]; exists {
				t.Error("unregistered site's private publish state remains after cleanup")
			}
			for key, want := range preservedBefore {
				object, _, err := backend.GetObject(context.Background(), key)
				if err != nil || !bytes.Equal(object.Bytes, want) {
					t.Errorf("unrelated object %q changed during unregister: got=%q want=%q err=%v", key, object.Bytes, want, err)
				}
			}
			for _, key := range []string{siteLockKey("sre"), "_control/locks/registry.json"} {
				object, _, err := backend.GetObject(context.Background(), key)
				if err != nil {
					t.Errorf("retained control lock %q was removed: %v", key, err)
					continue
				}
				var record lockRecord
				if err := json.Unmarshal(object.Bytes, &record); err != nil || record.State != "free" {
					t.Errorf("control lock %q = %+v, err=%v; want retained free lock", key, record, err)
				}
			}
			if _, _, err := backend.GetObject(context.Background(), registryCleanupKey); !errors.Is(err, ErrObjectNotFound) {
				t.Errorf("cleanup record after retry error = %v; want cleared", err)
			}
		})
	}
}

func seedForcedUnregisterFixture(t *testing.T, backend *registryApplyTestBackend) {
	t.Helper()
	for key, contents := range map[string][]byte{
		"_artifacts/sre/report.html":             []byte("site artifact"),
		"_indexes/sre/meta.json":                 []byte(`{"site":"sre"}`),
		"_previews/sre/catalog.json":             []byte(`{"site":"sre"}`),
		"_previews/sre/revisions/head/report.md": []byte("preview document"),
		sitePublishStateKey("sre"):               []byte("private publish state"),
		sitePublishStateKey("docs"):              []byte("neighbor publish state"),
		"_artifacts/docs/neighbor.html":          []byte("neighbor artifact"),
		"_indexes/docs/meta.json":                []byte(`{"site":"docs"}`),
		"_previews/docs/catalog.json":            []byte(`{"site":"docs"}`),
		"index.html":                             []byte("application shell"),
		"assets/app.js":                          []byte("application asset"),
		"_control/private/sentinel":              []byte("private control object"),
	} {
		backend.seed(key, contents)
	}
	for _, siteID := range []string{"sre", "docs"} {
		contents, err := marshalLockRecord(lockRecord{SchemaVersion: 1, Site: siteID, State: "free"})
		if err != nil {
			t.Fatal(err)
		}
		backend.seed(siteLockKey(siteID), contents)
	}
}

func TestRegisterSitesSerializesSeparateProcesses(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "artifact-pages.yaml")
	if err := os.WriteFile(configPath, testUnifiedConfigFixture(desiredAdminManifest), 0o600); err != nil {
		t.Fatal(err)
	}
	storageRoot := filepath.Join(root, "storage")
	lockReadyPath := filepath.Join(root, "lock-ready")
	releaseLockPath := filepath.Join(root, "release-lock")
	holderOutput := &bytes.Buffer{}
	holder := exec.Command(os.Args[0], "-test.run=^TestRegisterSitesCrossProcessHelper$")
	holder.Env = append(os.Environ(),
		"ARTIFACT_PAGES_REGISTRY_PROCESS_HELPER=hold",
		"ARTIFACT_PAGES_REGISTRY_ROOT="+storageRoot,
		"ARTIFACT_PAGES_REGISTRY_LOCK_READY="+lockReadyPath,
		"ARTIFACT_PAGES_REGISTRY_RELEASE_LOCK="+releaseLockPath,
	)
	holder.Stdout, holder.Stderr = holderOutput, holderOutput
	if err := holder.Start(); err != nil {
		t.Fatalf("start registry lock holder: %v", err)
	}
	holderDone := make(chan error, 1)
	go func() { holderDone <- holder.Wait() }()
	holderFinished := false
	var holderWaitErr error
	releaseHolder := func() {
		_ = os.WriteFile(releaseLockPath, []byte("release"), 0o600)
		if holderFinished {
			return
		}
		select {
		case holderWaitErr = <-holderDone:
			holderFinished = true
		case <-time.After(5 * time.Second):
			_ = holder.Process.Kill()
			holderWaitErr = <-holderDone
			holderFinished = true
		}
	}
	defer releaseHolder()
	if err := waitForRegistryProcessSignal(lockReadyPath, 5*time.Second); err != nil {
		t.Fatalf("registry lock holder did not become ready: %v", err)
	}

	observedHeldPath := filepath.Join(root, "waiter-observed-held-lock")
	registryReadPath := filepath.Join(root, "waiter-read-registry")
	waiterStartedPath := filepath.Join(root, "waiter-started")
	waiterOutput := &bytes.Buffer{}
	waiter := exec.Command(os.Args[0], "-test.run=^TestRegisterSitesCrossProcessHelper$")
	waiter.Env = append(os.Environ(),
		"ARTIFACT_PAGES_REGISTRY_PROCESS_HELPER=apply",
		"ARTIFACT_PAGES_REGISTRY_ROOT="+storageRoot,
		"ARTIFACT_PAGES_REGISTRY_CONFIG="+configPath,
		"ARTIFACT_PAGES_REGISTRY_STARTED="+waiterStartedPath,
		"ARTIFACT_PAGES_REGISTRY_HELD_OBSERVED="+observedHeldPath,
		"ARTIFACT_PAGES_REGISTRY_REGISTRY_READ="+registryReadPath,
	)
	waiter.Stdout, waiter.Stderr = waiterOutput, waiterOutput
	if err := waiter.Start(); err != nil {
		t.Fatalf("start competing registry register: %v", err)
	}
	waiterDone := make(chan error, 1)
	go func() { waiterDone <- waiter.Wait() }()
	waiterFinished := false
	defer func() {
		releaseHolder()
		if !waiterFinished {
			select {
			case <-waiterDone:
				waiterFinished = true
			case <-time.After(5 * time.Second):
				_ = waiter.Process.Kill()
				<-waiterDone
				waiterFinished = true
			}
		}
	}()
	if err := waitForRegistryProcessSignal(waiterStartedPath, 5*time.Second); err != nil {
		t.Fatalf("registry register process did not start: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(observedHeldPath); err == nil {
			break
		}
		if _, err := os.Stat(registryReadPath); err == nil {
			t.Fatal("competing apply read the deployed registry while another process held the registry lock")
		}
		select {
		case err := <-waiterDone:
			waiterFinished = true
			t.Fatalf("competing apply exited before observing the held registry lock: %v\n%s", err, waiterOutput.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("competing apply did not observe the held registry lock\n%s", waiterOutput.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
	select {
	case err := <-waiterDone:
		waiterFinished = true
		t.Fatalf("competing apply completed while the registry lock was held: %v\n%s", err, waiterOutput.String())
	case <-time.After(150 * time.Millisecond):
	}
	if _, err := os.Stat(registryReadPath); err == nil {
		t.Fatal("competing apply read the registry before the holder released its lock")
	}

	releaseHolder()
	if holderWaitErr != nil {
		t.Fatalf("registry lock holder failed: %v\n%s", holderWaitErr, holderOutput.String())
	}
	waiterErr := <-waiterDone
	waiterFinished = true
	if err := waiterErr; err != nil {
		t.Fatalf("competing registry register failed after lock release: %v\n%s", err, waiterOutput.String())
	}

	backend, err := NewDirectoryBackend(storageRoot)
	if err != nil {
		t.Fatal(err)
	}
	object, _, err := backend.GetObject(context.Background(), "_indexes/sites.json")
	if err != nil {
		t.Fatalf("read cross-process result registry: %v", err)
	}
	_, want, err := testRegistryBuild(t, []byte(desiredAdminManifest))
	if err != nil {
		t.Fatal(err)
	}
	got, err := registry.DecodeProjection(object.Bytes)
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("cross-process registry = %+v, err=%v; want %+v", got, err, want)
	}
}

func TestRegisterSitesCrossProcessHelper(t *testing.T) {
	mode := os.Getenv("ARTIFACT_PAGES_REGISTRY_PROCESS_HELPER")
	if mode == "" {
		return
	}
	root := os.Getenv("ARTIFACT_PAGES_REGISTRY_ROOT")
	backend, err := NewDirectoryBackend(root)
	if err != nil {
		t.Fatal(err)
	}
	switch mode {
	case "hold":
		_, release, err := (SiteLockManager{Backend: backend}).AcquireRegistry(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		readyPath := os.Getenv("ARTIFACT_PAGES_REGISTRY_LOCK_READY")
		if err := os.WriteFile(readyPath, []byte("ready"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := waitForRegistryProcessSignal(os.Getenv("ARTIFACT_PAGES_REGISTRY_RELEASE_LOCK"), 10*time.Second); err != nil {
			t.Fatal(err)
		}
		if err := release(); err != nil {
			t.Fatal(err)
		}
	case "apply":
		if err := os.WriteFile(os.Getenv("ARTIFACT_PAGES_REGISTRY_STARTED"), []byte("started"), 0o600); err != nil {
			t.Fatal(err)
		}
		configContents, err := os.ReadFile(os.Getenv("ARTIFACT_PAGES_REGISTRY_CONFIG"))
		if err != nil {
			t.Fatal(err)
		}
		parsedConfig, err := deploymentconfig.Parse(configContents)
		if err != nil {
			t.Fatal(err)
		}
		desired, err := registry.ProjectSites(parsedConfig.Sites)
		if err != nil {
			t.Fatal(err)
		}
		observingBackend := &registryProcessObserveBackend{
			DirectoryBackend: backend,
			heldObservedPath: os.Getenv("ARTIFACT_PAGES_REGISTRY_HELD_OBSERVED"),
			registryReadPath: os.Getenv("ARTIFACT_PAGES_REGISTRY_REGISTRY_READ"),
		}
		if _, err := RegisterSites(context.Background(), observingBackend, desired, false); err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatalf("unknown registry process helper mode %q", mode)
	}
}

type registryProcessObserveBackend struct {
	*DirectoryBackend
	heldObservedPath string
	registryReadPath string
	heldReads        int
}

func (backend *registryProcessObserveBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	object, etag, err := backend.DirectoryBackend.GetObject(ctx, key)
	if key == "_control/locks/registry.json" && err == nil {
		var record lockRecord
		if json.Unmarshal(object.Bytes, &record) == nil && record.State == "held" {
			backend.heldReads++
			if backend.heldReads >= 2 {
				if signalErr := os.WriteFile(backend.heldObservedPath, []byte("held"), 0o600); signalErr != nil {
					return Object{}, "", signalErr
				}
			}
		}
	}
	if key == "_indexes/sites.json" {
		if signalErr := os.WriteFile(backend.registryReadPath, []byte("read"), 0o600); signalErr != nil {
			return Object{}, "", signalErr
		}
	}
	return object, etag, err
}

func waitForRegistryProcessSignal(path string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		if _, err := os.Stat(path); err == nil {
			return nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for %s", path)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type registryApplyTestBackend struct {
	*lockMemoryBackend
	conditionalWrites        int
	directWrites             int
	deleteCalls              int
	invalidations            [][]string
	failDeleteKey            string
	failListPrefix           string
	partialDeleteKey         string
	failNextInvalidate       bool
	conditionalFailKey       string
	conditionalFailErr       error
	conditionalAfterWriteKey string
	conditionalAfterWriteErr error
}

func newRegistryApplyTestBackend() *registryApplyTestBackend {
	return &registryApplyTestBackend{lockMemoryBackend: newLockMemoryBackend()}
}

func (backend *registryApplyTestBackend) seed(key string, contents []byte) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.objects[key] = Object{Bytes: append([]byte(nil), contents...)}
	backend.etags[key] = "\"seed-" + key + "\""
}

func (backend *registryApplyTestBackend) snapshot() (map[string]Object, map[string]string) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	objects := make(map[string]Object, len(backend.objects))
	for key, object := range backend.objects {
		objects[key] = Object{Bytes: append([]byte(nil), object.Bytes...), ContentType: object.ContentType, ContentDisposition: object.ContentDisposition, ContentEncoding: object.ContentEncoding, Cache: object.Cache}
	}
	etags := make(map[string]string, len(backend.etags))
	for key, etag := range backend.etags {
		etags[key] = etag
	}
	return objects, etags
}

func (backend *registryApplyTestBackend) resetCounters() {
	backend.conditionalWrites = 0
	backend.directWrites = 0
	backend.deleteCalls = 0
	backend.invalidations = nil
}

func (backend *registryApplyTestBackend) PutObject(ctx context.Context, key string, object Object) error {
	backend.directWrites++
	return backend.memoryDeploymentBackend.PutObject(ctx, key, object)
}

func (backend *registryApplyTestBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	backend.conditionalWrites++
	if key == backend.conditionalFailKey {
		backend.conditionalFailKey = ""
		if backend.conditionalFailErr != nil {
			return "", backend.conditionalFailErr
		}
		return "", errors.New("injected conditional write failure")
	}
	etag, err := backend.lockMemoryBackend.PutObjectConditional(ctx, key, object, condition)
	if err == nil && key == backend.conditionalAfterWriteKey {
		backend.conditionalAfterWriteKey = ""
		if backend.conditionalAfterWriteErr != nil {
			return "", backend.conditionalAfterWriteErr
		}
		return "", errors.New("injected response lost after conditional write")
	}
	return etag, err
}

func (backend *registryApplyTestBackend) DeleteObjects(ctx context.Context, keys []string) error {
	backend.deleteCalls++
	if backend.partialDeleteKey != "" {
		for index, key := range keys {
			if key == backend.partialDeleteKey {
				if index > 0 {
					if err := backend.memoryDeploymentBackend.DeleteObjects(ctx, keys[:index]); err != nil {
						return err
					}
				}
				backend.partialDeleteKey = ""
				return fmt.Errorf("injected partial delete failure for %s", key)
			}
		}
	}
	if backend.failDeleteKey != "" {
		for _, key := range keys {
			if key == backend.failDeleteKey {
				backend.failDeleteKey = ""
				return fmt.Errorf("injected delete failure for %s", key)
			}
		}
	}
	return backend.memoryDeploymentBackend.DeleteObjects(ctx, keys)
}

func (backend *registryApplyTestBackend) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	if backend.failListPrefix == prefix {
		backend.failListPrefix = ""
		return nil, fmt.Errorf("injected listing failure for %s", prefix)
	}
	return backend.lockMemoryBackend.ListKeys(ctx, prefix)
}

func (backend *registryApplyTestBackend) Invalidate(_ context.Context, paths []string) (string, error) {
	backend.invalidations = append(backend.invalidations, append([]string(nil), paths...))
	if backend.failNextInvalidate {
		backend.failNextInvalidate = false
		return "", errors.New("injected invalidation failure")
	}
	return "registry-test-invalidation", nil
}

func seedRegistryFromManifest(t *testing.T, backend *registryApplyTestBackend, manifest string) {
	t.Helper()
	contents, _, err := testRegistryBuild(t, []byte(manifest))
	if err != nil {
		t.Fatalf("build registry fixture: %v", err)
	}
	backend.seed("_indexes/sites.json", contents)
}

func assertNoRegistryApplyWrites(t *testing.T, backend *registryApplyTestBackend) {
	t.Helper()
	if backend.conditionalWrites != 0 || backend.directWrites != 0 || backend.deleteCalls != 0 || len(backend.invalidations) != 0 {
		t.Fatalf("dry-run writes: conditional=%d direct=%d deletes=%d invalidations=%v", backend.conditionalWrites, backend.directWrites, backend.deleteCalls, backend.invalidations)
	}
}

func assertRegistryInvalidationPlan(t *testing.T, result Result, want []string) {
	t.Helper()
	got := make([]string, 0)
	for _, change := range result.Changes {
		if change.Action == "invalidate" {
			got = append(got, change.Path)
		}
	}
	want = append([]string(nil), want...)
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("invalidation plan = %v, want complete set %v", got, want)
	}
}

func assertRegistryUpdatedJSON(t *testing.T, result Result, wantUpdated bool, wantEmptyChanges bool) {
	t.Helper()
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal deployment result: %v", err)
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &value); err != nil {
		t.Fatalf("decode deployment result: %v", err)
	}
	var updated bool
	if raw, exists := value["registryUpdated"]; !exists {
		t.Fatalf("result JSON %s omits registryUpdated", encoded)
	} else if err := json.Unmarshal(raw, &updated); err != nil || updated != wantUpdated {
		t.Fatalf("registryUpdated JSON = %s, err=%v; want %t", raw, err, wantUpdated)
	}
	if wantEmptyChanges {
		if raw, exists := value["changes"]; !exists || string(raw) != "[]" {
			t.Fatalf("empty changes JSON = %s (present=%t); want []", raw, exists)
		}
	}
}
