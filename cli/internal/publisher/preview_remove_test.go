package publisher

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
	"github.com/artifact-pages/artifact-pages/cli/internal/registry"
)

type previewRemoveFaultBackend struct {
	*lockMemoryBackend
	failListPrefix       string
	unsafeListKey        string
	partialDeleteOnce    bool
	invalidateFailure    bool
	clearResponseLost    bool
	listPrefixes         []string
	deleteCalls          [][]string
	invalidationFailures int
}

func (backend *previewRemoveFaultBackend) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	backend.listPrefixes = append(backend.listPrefixes, prefix)
	if prefix == backend.failListPrefix {
		return nil, errors.New("injected exact revision listing failure")
	}
	keys, err := backend.lockMemoryBackend.ListKeys(ctx, prefix)
	if err != nil {
		return nil, err
	}
	if prefix == backend.failListPrefix && backend.unsafeListKey != "" {
		keys = append(keys, backend.unsafeListKey)
	}
	if backend.unsafeListKey != "" && strings.HasPrefix(prefix, "_previews/") && strings.Contains(prefix, "/revisions/") {
		keys = append(keys, backend.unsafeListKey)
	}
	sort.Strings(keys)
	return keys, nil
}

func (backend *previewRemoveFaultBackend) DeleteObjects(ctx context.Context, keys []string) error {
	backend.deleteCalls = append(backend.deleteCalls, append([]string(nil), keys...))
	if len(keys) == 1 && keys[0] == previewCleanupKey("sre") && backend.clearResponseLost {
		backend.clearResponseLost = false
		if err := backend.lockMemoryBackend.DeleteObjects(ctx, keys); err != nil {
			return err
		}
		return errors.New("injected journal clear response loss")
	}
	if backend.partialDeleteOnce && len(keys) > 1 {
		backend.partialDeleteOnce = false
		if err := backend.lockMemoryBackend.DeleteObjects(ctx, keys[:1]); err != nil {
			return err
		}
		return errors.New("injected partial revision delete")
	}
	return backend.lockMemoryBackend.DeleteObjects(ctx, keys)
}

func (backend *previewRemoveFaultBackend) Invalidate(ctx context.Context, paths []string) (string, error) {
	if backend.invalidateFailure {
		backend.invalidateFailure = false
		backend.invalidationFailures++
		return "", errors.New("injected preview cache invalidation failure")
	}
	return backend.lockMemoryBackend.Invalidate(ctx, paths)
}

func newPreviewRemoveFaultBackend() *previewRemoveFaultBackend {
	return &previewRemoveFaultBackend{lockMemoryBackend: newLockMemoryBackend()}
}

func previewRemoveTestGroup(id, headSHA string) preview.Group {
	group := preview.Group{
		ID: id, HeadSHA: headSHA, UpdatedAt: "2026-10-06T00:00:00Z", Documents: []preview.Document{},
	}
	if strings.HasPrefix(id, "pr:") {
		group.Kind = "pull-request"
		group.PRURL = "https://github.com/acme/sre/pull/" + strings.TrimPrefix(id, "pr:")
	} else {
		group.Kind = "manual"
	}
	return group
}

func previewRemoveTestManifest(site, headSHA string, paths ...string) (preview.RevisionManifest, map[string][]byte) {
	sort.Strings(paths)
	files := make(map[string][]byte, len(paths))
	manifestFiles := make([]preview.PreviewFile, 0, len(paths))
	for _, filePath := range paths {
		files[filePath] = []byte("body: " + filePath)
		manifestFiles = append(manifestFiles, preview.PreviewFile{
			Path: filePath, SHA256: strings.Repeat("a", 64), ContentType: "text/plain; charset=utf-8",
		})
	}
	return preview.RevisionManifest{
		SchemaVersion: preview.SchemaVersion, Site: site, HeadSHA: headSHA,
		DefaultHead: strings.Repeat("d", 40), MergeBase: strings.Repeat("e", 40),
		CreatedAt: "2026-10-06T00:00:00Z", BundleDigest: "sha256:" + strings.Repeat("f", 64),
		Files: manifestFiles, Documents: []preview.Document{},
	}, files
}

func seedPreviewRemoveCatalog(t *testing.T, backend *previewRemoveFaultBackend, catalog preview.Catalog, manifests map[string]preview.RevisionManifest, extraKeys ...string) {
	t.Helper()
	catalogBytes, err := preview.EncodeCatalog(catalog)
	if err != nil {
		t.Fatalf("encode preview remove catalog: %v", err)
	}
	if err := backend.PutObject(context.Background(), "_previews/"+catalog.Site+"/catalog.json", Object{Bytes: catalogBytes}); err != nil {
		t.Fatal(err)
	}
	for headSHA, manifest := range manifests {
		contents, err := preview.EncodeManifest(manifest)
		if err != nil {
			t.Fatalf("encode manifest %s: %v", headSHA, err)
		}
		manifestKey, _ := preview.ManifestKey(catalog.Site, headSHA)
		if err := backend.PutObject(context.Background(), strings.TrimPrefix(manifestKey, "/"), Object{Bytes: contents}); err != nil {
			t.Fatal(err)
		}
		for _, file := range manifest.Files {
			fileKey, _ := preview.FileKey(catalog.Site, headSHA, file.Path)
			raw, _ := preview.RawObjectKey(fileKey)
			if err := backend.PutObject(context.Background(), raw, Object{Bytes: []byte("body: " + file.Path)}); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, key := range extraKeys {
		if err := backend.PutObject(context.Background(), key, Object{Bytes: []byte("orphaned partial upload")}); err != nil {
			t.Fatal(err)
		}
	}
}

func ownership(groupID string, revisions ...preview.RevisionOwnership) preview.GroupRevisionHistory {
	sort.Slice(revisions, func(i, j int) bool { return revisions[i].HeadSHA < revisions[j].HeadSHA })
	for index := range revisions {
		sort.Strings(revisions[index].Files)
	}
	return preview.GroupRevisionHistory{GroupID: groupID, Revisions: revisions}
}

func TestRemovePreviewGroupPreservesSharedSHAAndDeletesOnlyExactExclusiveRevisions(t *testing.T) {
	backend := newPreviewRemoveFaultBackend()
	const sharedSHA = "1111111111111111111111111111111111111111"
	const exclusiveSHA = "2222222222222222222222222222222222222222"
	sharedManifest, _ := previewRemoveTestManifest("sre", sharedSHA, "shared.md")
	exclusiveManifest, _ := previewRemoveTestManifest("sre", exclusiveSHA, "exclusive.md")
	catalog := preview.Catalog{
		SchemaVersion: preview.SchemaVersion, Site: "sre",
		Groups: []preview.Group{previewRemoveTestGroup("pr:42", exclusiveSHA), previewRemoveTestGroup("pr:43", sharedSHA)},
		RevisionHistory: []preview.GroupRevisionHistory{
			ownership("pr:42", preview.RevisionOwnership{HeadSHA: sharedSHA, Files: []string{"shared.md"}}, preview.RevisionOwnership{HeadSHA: exclusiveSHA, Files: []string{"exclusive.md"}}),
			ownership("pr:43", preview.RevisionOwnership{HeadSHA: sharedSHA, Files: []string{"shared.md"}}),
		},
	}
	orphanKey := "_previews/sre/revisions/" + exclusiveSHA + "/files/orphan-from-partial-upload.txt"
	seedPreviewRemoveCatalog(t, backend, catalog, map[string]preview.RevisionManifest{sharedSHA: sharedManifest, exclusiveSHA: exclusiveManifest}, orphanKey)

	result, err := RemovePreviewGroup(context.Background(), backend, PreviewRemoveOptions{SiteID: "sre", GroupID: "pr:42"})
	if err != nil {
		t.Fatalf("RemovePreviewGroup() error = %v", err)
	}
	if result.Outcome != "removed" || result.FilesRemoved != 3 || !reflect.DeepEqual(result.InvalidationPaths, []string{"/_previews/sre/*"}) {
		t.Fatalf("RemovePreviewGroup() = %+v; want exact exclusive objects and one site-preview cache scope", result)
	}
	if keys, err := backend.ListKeys(context.Background(), "_previews/sre/revisions/"+sharedSHA+"/"); err != nil || len(keys) != 2 {
		t.Fatalf("shared revision objects = %v, %v; want manifest and file retained", keys, err)
	}
	if keys, err := backend.ListKeys(context.Background(), "_previews/sre/revisions/"+exclusiveSHA+"/"); err != nil || len(keys) != 0 {
		t.Fatalf("exclusive revision objects = %v, %v; want manifest, files, and orphan removed", keys, err)
	}
	object, _, err := backend.GetObject(context.Background(), "_previews/sre/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	remaining, err := preview.DecodeCatalog(object.Bytes)
	if err != nil || len(remaining.Groups) != 1 || remaining.Groups[0].ID != "pr:43" || len(remaining.RevisionHistory) != 1 || remaining.RevisionHistory[0].GroupID != "pr:43" {
		t.Fatalf("remaining catalog = %+v, err=%v", remaining, err)
	}
	if _, _, err := backend.GetObject(context.Background(), previewCleanupKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("preview cleanup journal remains: %v", err)
	}
	if len(backend.invalidations) != 1 || !reflect.DeepEqual(backend.invalidations[0], []string{"/_previews/sre/*"}) {
		t.Fatalf("cache invalidations = %v", backend.invalidations)
	}
}

func TestRemovePreviewGroupDryRunDoesNotAcquireLockOrRecoverPendingCleanup(t *testing.T) {
	backend := newPreviewRemoveFaultBackend()
	const sha = "3333333333333333333333333333333333333333"
	manifest, _ := previewRemoveTestManifest("sre", sha, "guide.md")
	catalog := preview.Catalog{SchemaVersion: preview.SchemaVersion, Site: "sre", Groups: []preview.Group{previewRemoveTestGroup("pr:42", sha)}, RevisionHistory: []preview.GroupRevisionHistory{ownership("pr:42", preview.RevisionOwnership{HeadSHA: sha, Files: []string{"guide.md"}})}}
	seedPreviewRemoveCatalog(t, backend, catalog, map[string]preview.RevisionManifest{sha: manifest})
	options := PreviewRemoveOptions{SiteID: "sre", GroupID: "pr:42"}
	conditional, store, err := previewRemovalDependencies(context.Background(), backend, options)
	if err != nil {
		t.Fatal(err)
	}
	catalogValue, err := readPreviewCatalog(context.Background(), store, "sre")
	if err != nil {
		t.Fatal(err)
	}
	plan, err := planPreviewRemoval(context.Background(), backend, store, "sre", "pr:42", catalogValue)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writePreviewCleanup(context.Background(), conditional, plan.journal); err != nil {
		t.Fatal(err)
	}
	before := len(backend.puts)
	options.DryRun = true
	result, err := RemovePreviewGroup(context.Background(), backend, options)
	if err != nil {
		t.Fatalf("RemovePreviewGroup(dry-run) error = %v", err)
	}
	if result.Outcome != "planned" || result.FilesRemoved != 2 || len(backend.invalidations) != 0 || len(backend.deleteCalls) != 0 {
		t.Fatalf("dry-run result/effects = %+v invalidations=%v deletes=%v", result, backend.invalidations, backend.deleteCalls)
	}
	if len(backend.puts) != before {
		t.Fatalf("dry-run wrote provider objects: before puts=%d after=%d", before, len(backend.puts))
	}
	if keys, err := backend.ListKeys(context.Background(), siteLockKey("sre")); err != nil || len(keys) != 0 {
		t.Fatalf("dry-run site lock objects = %v, %v", keys, err)
	}
}

func TestRemovePreviewGroupResumesAfterPartialDeleteAndCacheFailure(t *testing.T) {
	for _, test := range []struct {
		name    string
		fault   func(*previewRemoveFaultBackend)
		wantErr string
	}{
		{name: "partial delete", fault: func(backend *previewRemoveFaultBackend) { backend.partialDeleteOnce = true }, wantErr: "partial revision delete"},
		{name: "invalidation", fault: func(backend *previewRemoveFaultBackend) { backend.invalidateFailure = true }, wantErr: "cache invalidation failure"},
	} {
		t.Run(test.name, func(t *testing.T) {
			backend := newPreviewRemoveFaultBackend()
			const sha = "4444444444444444444444444444444444444444"
			manifest, _ := previewRemoveTestManifest("sre", sha, "guide.md")
			catalog := preview.Catalog{SchemaVersion: preview.SchemaVersion, Site: "sre", Groups: []preview.Group{previewRemoveTestGroup("pr:42", sha)}, RevisionHistory: []preview.GroupRevisionHistory{ownership("pr:42", preview.RevisionOwnership{HeadSHA: sha, Files: []string{"guide.md"}})}}
			seedPreviewRemoveCatalog(t, backend, catalog, map[string]preview.RevisionManifest{sha: manifest})
			test.fault(backend)
			if _, err := RemovePreviewGroup(context.Background(), backend, PreviewRemoveOptions{SiteID: "sre", GroupID: "pr:42"}); err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("RemovePreviewGroup() error = %v; want %q", err, test.wantErr)
			}
			if _, _, err := backend.GetObject(context.Background(), previewCleanupKey("sre")); err != nil {
				t.Fatalf("pending cleanup journal missing after failure: %v", err)
			}
			result, err := RemovePreviewGroup(context.Background(), backend, PreviewRemoveOptions{SiteID: "sre", GroupID: "pr:42"})
			if err != nil || result.Outcome != "removed" {
				t.Fatalf("retry RemovePreviewGroup() = %+v, %v", result, err)
			}
			if keys, err := backend.ListKeys(context.Background(), "_previews/sre/revisions/"+sha+"/"); err != nil || len(keys) != 0 {
				t.Fatalf("retry left revision objects: %v, %v", keys, err)
			}
			if _, _, err := backend.GetObject(context.Background(), previewCleanupKey("sre")); !errors.Is(err, ErrObjectNotFound) {
				t.Fatalf("retry journal remains: %v", err)
			}
		})
	}
}

func TestRemovePreviewGroupDoesNotResumeDifferentPendingGroup(t *testing.T) {
	for _, includeTarget := range []bool{false, true} {
		t.Run(fmt.Sprintf("target-present-%t", includeTarget), func(t *testing.T) {
			backend := newPreviewRemoveFaultBackend()
			const pendingSHA = "9999999999999999999999999999999999999999"
			const targetSHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			pendingManifest, _ := previewRemoveTestManifest("sre", pendingSHA, "pending.md")
			targetManifest, _ := previewRemoveTestManifest("sre", targetSHA, "target.md")
			groups := []preview.Group{previewRemoveTestGroup("pr:42", pendingSHA)}
			histories := []preview.GroupRevisionHistory{ownership("pr:42", preview.RevisionOwnership{HeadSHA: pendingSHA, Files: []string{"pending.md"}})}
			manifests := map[string]preview.RevisionManifest{pendingSHA: pendingManifest}
			if includeTarget {
				groups = append(groups, previewRemoveTestGroup("pr:43", targetSHA))
				histories = append(histories, ownership("pr:43", preview.RevisionOwnership{HeadSHA: targetSHA, Files: []string{"target.md"}}))
				manifests[targetSHA] = targetManifest
			}
			catalog := preview.Catalog{SchemaVersion: preview.SchemaVersion, Site: "sre", Groups: groups, RevisionHistory: histories}
			seedPreviewRemoveCatalog(t, backend, catalog, manifests)
			conditional, store, err := previewRemovalDependencies(context.Background(), backend, PreviewRemoveOptions{SiteID: "sre", GroupID: "pr:42"})
			if err != nil {
				t.Fatal(err)
			}
			plan, err := planPreviewRemoval(context.Background(), backend, store, "sre", "pr:42", catalog)
			if err != nil {
				t.Fatal(err)
			}
			snapshot, release, err := (SiteLockManager{Backend: conditional}).Acquire(context.Background(), "sre")
			if err != nil {
				t.Fatal(err)
			}
			locked := context.WithValue(context.Background(), previewSiteLockContextKey{}, previewSiteLock{site: snapshot.Site, owner: snapshot.Owner, etag: snapshot.ETag})
			if _, err := writePreviewCleanup(locked, conditional, plan.journal); err != nil {
				t.Fatal(err)
			}
			if err := release(); err != nil {
				t.Fatal(err)
			}
			catalogBefore, _, _ := backend.GetObject(context.Background(), "_previews/sre/catalog.json")
			pendingBefore, _, _ := backend.GetObject(context.Background(), previewCleanupKey("sre"))
			pendingObjectsBefore, _ := backend.ListKeys(context.Background(), "_previews/sre/revisions/"+pendingSHA+"/")
			result, err := RemovePreviewGroup(context.Background(), backend, PreviewRemoveOptions{SiteID: "sre", GroupID: "pr:43"})
			if err == nil || !strings.Contains(err.Error(), "pending cleanup for group \"pr:42\"") {
				t.Fatalf("RemovePreviewGroup(other group) = %+v, %v; want actionable pending-group error", result, err)
			}
			catalogAfter, _, _ := backend.GetObject(context.Background(), "_previews/sre/catalog.json")
			pendingAfter, _, _ := backend.GetObject(context.Background(), previewCleanupKey("sre"))
			pendingObjectsAfter, _ := backend.ListKeys(context.Background(), "_previews/sre/revisions/"+pendingSHA+"/")
			if !reflect.DeepEqual(catalogBefore.Bytes, catalogAfter.Bytes) || !reflect.DeepEqual(pendingBefore.Bytes, pendingAfter.Bytes) || !reflect.DeepEqual(pendingObjectsBefore, pendingObjectsAfter) {
				t.Fatal("request for another group mutated pending group state")
			}
			if len(backend.invalidations) != 0 {
				t.Fatalf("other-group request invalidated cache: %v", backend.invalidations)
			}
		})
	}
}

func TestRemovePreviewGroupConvergesAfterAmbiguousJournalClearResponse(t *testing.T) {
	backend := newPreviewRemoveFaultBackend()
	const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	manifest, _ := previewRemoveTestManifest("sre", sha, "guide.md")
	catalog := preview.Catalog{SchemaVersion: preview.SchemaVersion, Site: "sre", Groups: []preview.Group{previewRemoveTestGroup("pr:42", sha)}, RevisionHistory: []preview.GroupRevisionHistory{ownership("pr:42", preview.RevisionOwnership{HeadSHA: sha, Files: []string{"guide.md"}})}}
	seedPreviewRemoveCatalog(t, backend, catalog, map[string]preview.RevisionManifest{sha: manifest})
	backend.clearResponseLost = true
	if _, err := RemovePreviewGroup(context.Background(), backend, PreviewRemoveOptions{SiteID: "sre", GroupID: "pr:42"}); err == nil || !strings.Contains(err.Error(), "journal clear response loss") {
		t.Fatalf("first RemovePreviewGroup() error = %v; want ambiguous journal-clear response", err)
	}
	if _, _, err := backend.GetObject(context.Background(), previewCleanupKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("journal remains after ambiguous clear response: %v", err)
	}
	result, err := RemovePreviewGroup(context.Background(), backend, PreviewRemoveOptions{SiteID: "sre", GroupID: "pr:42"})
	if err != nil || result.Outcome != "no-op" {
		t.Fatalf("converged retry = %+v, %v; want successful no-op", result, err)
	}
	if len(backend.invalidations) != 1 {
		t.Fatalf("cache was invalidated %d times, want only the completed original request", len(backend.invalidations))
	}
}

func TestRemovePreviewGroupFailClosedBeforeJournalOnIncompleteOrUnsafeListing(t *testing.T) {
	for _, test := range []struct {
		name      string
		configure func(*previewRemoveFaultBackend, string)
	}{
		{name: "listing failure", configure: func(backend *previewRemoveFaultBackend, prefix string) { backend.failListPrefix = prefix }},
		{name: "unsafe key", configure: func(backend *previewRemoveFaultBackend, _ string) {
			backend.unsafeListKey = "_previews/sre/revisions/5555555555555555555555555555555555555555/files/../../sibling"
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			backend := newPreviewRemoveFaultBackend()
			const sha = "5555555555555555555555555555555555555555"
			manifest, _ := previewRemoveTestManifest("sre", sha, "guide.md")
			catalog := preview.Catalog{SchemaVersion: preview.SchemaVersion, Site: "sre", Groups: []preview.Group{previewRemoveTestGroup("pr:42", sha)}, RevisionHistory: []preview.GroupRevisionHistory{ownership("pr:42", preview.RevisionOwnership{HeadSHA: sha, Files: []string{"guide.md"}})}}
			seedPreviewRemoveCatalog(t, backend, catalog, map[string]preview.RevisionManifest{sha: manifest})
			prefix := "_previews/sre/revisions/" + sha + "/"
			test.configure(backend, prefix)
			before, _, _ := backend.GetObject(context.Background(), "_previews/sre/catalog.json")
			if _, err := RemovePreviewGroup(context.Background(), backend, PreviewRemoveOptions{SiteID: "sre", GroupID: "pr:42"}); err == nil {
				t.Fatal("RemovePreviewGroup() succeeded with an incomplete or unsafe revision listing")
			}
			after, _, _ := backend.GetObject(context.Background(), "_previews/sre/catalog.json")
			if !reflect.DeepEqual(before.Bytes, after.Bytes) {
				t.Fatal("failed listing changed the preview catalog")
			}
			if _, _, err := backend.GetObject(context.Background(), previewCleanupKey("sre")); !errors.Is(err, ErrObjectNotFound) {
				t.Fatalf("failed listing wrote cleanup journal: %v", err)
			}
		})
	}
}

func TestRemovePreviewGroupRetainsHiddenHistoryAfterNoPreviewAndManifestPrune(t *testing.T) {
	for _, phase := range []string{"no-preview", "manifest-prune"} {
		t.Run(phase, func(t *testing.T) {
			backend := newPreviewRemoveFaultBackend()
			const sha = "6666666666666666666666666666666666666666"
			manifest, _ := previewRemoveTestManifest("sre", sha, "guide.md")
			store, err := NewObjectPreviewStore(backend)
			if err != nil {
				t.Fatal(err)
			}
			catalog := preview.Catalog{SchemaVersion: preview.SchemaVersion, Site: "sre", Groups: []preview.Group{previewRemoveTestGroup("pr:42", sha)}, RevisionHistory: []preview.GroupRevisionHistory{ownership("pr:42", preview.RevisionOwnership{HeadSHA: sha, Files: []string{"guide.md"}})}}
			seedPreviewRemoveCatalog(t, backend, catalog, map[string]preview.RevisionManifest{sha: manifest}, "_previews/sre/revisions/"+sha+"/files/guide.md")
			if phase == "no-preview" {
				if err := preview.Publish(context.Background(), store, preview.BuildResult{Site: "sre", Outcome: preview.OutcomeNoPreview, Group: previewRemoveTestGroup("pr:42", sha)}); err != nil {
					t.Fatalf("withdraw visible preview: %v", err)
				}
			} else {
				manifestKey, _ := preview.ManifestKey("sre", sha)
				if err := backend.DeleteObjects(context.Background(), []string{strings.TrimPrefix(manifestKey, "/")}); err != nil {
					t.Fatal(err)
				}
				if err := preview.ReconcileCatalog(context.Background(), store, "sre"); err != nil {
					t.Fatalf("prune absent visible manifest: %v", err)
				}
			}
			catalogObject, _, err := backend.GetObject(context.Background(), "_previews/sre/catalog.json")
			if err != nil {
				t.Fatal(err)
			}
			decodedCatalog, decodeErr := preview.DecodeCatalog(catalogObject.Bytes)
			if decodeErr != nil || len(decodedCatalog.Groups) != 0 || len(decodedCatalog.RevisionHistory) != 1 {
				t.Fatalf("hidden history after %s = %+v, err=%v", phase, decodedCatalog, decodeErr)
			}
			result, err := RemovePreviewGroup(context.Background(), backend, PreviewRemoveOptions{SiteID: "sre", GroupID: "pr:42"})
			if err != nil || result.Outcome != "removed" {
				t.Fatalf("remove hidden history after %s = %+v, %v", phase, result, err)
			}
			if keys, err := backend.ListKeys(context.Background(), "_previews/sre/revisions/"+sha+"/"); err != nil || len(keys) != 0 {
				t.Fatalf("hidden revision after %s removal = %v, %v", phase, keys, err)
			}
		})
	}
}

func TestPreviewCleanupJournalRejectsRevisionSetChangedAfterCreation(t *testing.T) {
	backend := newPreviewRemoveFaultBackend()
	const first = "7777777777777777777777777777777777777777"
	const second = "8888888888888888888888888888888888888888"
	manifestA, _ := previewRemoveTestManifest("sre", first, "a.md")
	manifestB, _ := previewRemoveTestManifest("sre", second, "b.md")
	catalog := preview.Catalog{SchemaVersion: preview.SchemaVersion, Site: "sre", Groups: []preview.Group{previewRemoveTestGroup("pr:42", first)}, RevisionHistory: []preview.GroupRevisionHistory{ownership("pr:42", preview.RevisionOwnership{HeadSHA: first, Files: []string{"a.md"}})}}
	seedPreviewRemoveCatalog(t, backend, catalog, map[string]preview.RevisionManifest{first: manifestA})
	conditional, store, err := previewRemovalDependencies(context.Background(), backend, PreviewRemoveOptions{SiteID: "sre", GroupID: "pr:42"})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := planPreviewRemoval(context.Background(), backend, store, "sre", "pr:42", catalog)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, release, err := (SiteLockManager{Backend: conditional}).Acquire(context.Background(), "sre")
	if err != nil {
		t.Fatal(err)
	}
	lockedContext := context.WithValue(context.Background(), previewSiteLockContextKey{}, previewSiteLock{site: snapshot.Site, owner: snapshot.Owner, etag: snapshot.ETag})
	if _, err := writePreviewCleanup(lockedContext, conditional, plan.journal); err != nil {
		t.Fatalf("write journal: %v", err)
	}
	catalog.RevisionHistory = []preview.GroupRevisionHistory{ownership("pr:42", preview.RevisionOwnership{HeadSHA: first, Files: []string{"a.md"}}, preview.RevisionOwnership{HeadSHA: second, Files: []string{"b.md"}})}
	catalog.Groups = []preview.Group{previewRemoveTestGroup("pr:42", second)}
	manifestBytes, _ := preview.EncodeManifest(manifestB)
	manifestKey, _ := preview.ManifestKey("sre", second)
	_ = backend.PutObject(context.Background(), strings.TrimPrefix(manifestKey, "/"), Object{Bytes: manifestBytes})
	for _, file := range manifestB.Files {
		key, _ := preview.FileKey("sre", second, file.Path)
		raw, _ := preview.RawObjectKey(key)
		_ = backend.PutObject(context.Background(), raw, Object{Bytes: []byte("body")})
	}
	catalogBytes, _ := preview.EncodeCatalog(catalog)
	_ = backend.PutObject(context.Background(), "_previews/sre/catalog.json", Object{Bytes: catalogBytes})
	if _, _, err := resumePreviewCleanup(lockedContext, backend, conditional, store); err == nil || !strings.Contains(err.Error(), "exact exclusive revision set") {
		t.Fatalf("resume changed ownership set error = %v", err)
	}
	if err := release(); err != nil {
		t.Fatal(err)
	}
}

func TestPreviewRemovalCacheScopeDoesNotGrowWithHistory(t *testing.T) {
	backend := newPreviewRemoveFaultBackend()
	const groupID = "pr:42"
	var revisions []preview.RevisionOwnership
	var groups []preview.Group
	manifests := make(map[string]preview.RevisionManifest)
	for index := 1; index <= 20; index++ {
		headSHA := fmt.Sprintf("%040x", index)
		manifest, _ := previewRemoveTestManifest("sre", headSHA, fmt.Sprintf("guide-%d.md", index))
		manifests[headSHA] = manifest
		revisions = append(revisions, preview.RevisionOwnership{HeadSHA: headSHA, Files: []string{fmt.Sprintf("guide-%d.md", index)}})
		groups = append(groups, previewRemoveTestGroup(groupID, headSHA))
	}
	// The reader projection has one latest head; ownership history keeps all 20.
	groups = groups[:1]
	catalog := preview.Catalog{SchemaVersion: preview.SchemaVersion, Site: "sre", Groups: groups, RevisionHistory: []preview.GroupRevisionHistory{ownership(groupID, revisions...)}}
	seedPreviewRemoveCatalog(t, backend, catalog, manifests)
	result, err := RemovePreviewGroup(context.Background(), backend, PreviewRemoveOptions{SiteID: "sre", GroupID: groupID, DryRun: true})
	if err != nil || result.Outcome != "planned" || !reflect.DeepEqual(result.InvalidationPaths, []string{"/_previews/sre/*"}) {
		t.Fatalf("20-revision removal plan = %+v, %v", result, err)
	}
}

func TestRegistrySyncResumesPreviewCleanupJournalBeforeOmittedSiteSweep(t *testing.T) {
	backend := newPreviewRemoveFaultBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	const sha = "cccccccccccccccccccccccccccccccccccccccc"
	manifest, _ := previewRemoveTestManifest("sre", sha, "guide.md")
	catalog := preview.Catalog{SchemaVersion: preview.SchemaVersion, Site: "sre", Groups: []preview.Group{previewRemoveTestGroup("pr:42", sha)}, RevisionHistory: []preview.GroupRevisionHistory{ownership("pr:42", preview.RevisionOwnership{HeadSHA: sha, Files: []string{"guide.md"}})}}
	seedPreviewRemoveCatalog(t, backend, catalog, map[string]preview.RevisionManifest{sha: manifest}, "_artifacts/sre/overview.html", "_indexes/sre/index.json", "_control/neighbor-sentinel")
	conditional, store, err := previewRemovalDependencies(context.Background(), backend, PreviewRemoveOptions{SiteID: "sre", GroupID: "pr:42"})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := planPreviewRemoval(context.Background(), backend, store, "sre", "pr:42", catalog)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, release, err := (SiteLockManager{Backend: conditional}).Acquire(context.Background(), "sre")
	if err != nil {
		t.Fatal(err)
	}
	locked := context.WithValue(context.Background(), previewSiteLockContextKey{}, previewSiteLock{site: snapshot.Site, owner: snapshot.Owner, etag: snapshot.ETag})
	if _, err := writePreviewCleanup(locked, conditional, plan.journal); err != nil {
		t.Fatal(err)
	}
	if err := release(); err != nil {
		t.Fatal(err)
	}
	desired := registry.Projection{SchemaVersion: registry.SchemaVersion, Sites: []registry.Entry{}}
	result, err := RegisterSites(context.Background(), backend, desired, false)
	if err != nil {
		t.Fatalf("RegisterSites(omitted site) error = %v", err)
	}
	if result.Outcome != "synced" {
		t.Fatalf("registry sync outcome = %q, want synced", result.Outcome)
	}
	if keys, err := backend.ListKeys(context.Background(), "_previews/sre/"); err != nil || len(keys) != 0 {
		t.Fatalf("omitted site's preview objects remain: %v, %v", keys, err)
	}
	if _, _, err := backend.GetObject(context.Background(), previewCleanupKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("omitted site's preview cleanup journal remains: %v", err)
	}
	if _, _, err := backend.GetObject(context.Background(), "_control/neighbor-sentinel"); err != nil {
		t.Fatalf("registry cleanup removed unrelated control object: %v", err)
	}
}
