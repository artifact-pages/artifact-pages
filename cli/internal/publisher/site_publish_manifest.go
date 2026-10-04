package publisher

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/tasuku43/git-artifact-pages/cli/internal/indexer"
)

const sitePublishInputPolicy = "publisher-site-projection-v1;http-policy-v1;index-schema-v1;fulltext-policy-v1"

type sitePublishSnapshot struct {
	state         sitePublishState
	head          ObjectInfo
	etag          string
	exists        bool
	fastPath      bool
	actual        map[string]sitePublishObject
	actualKeys    []string
	generation    string
	retry         siteCacheRetry
	retryETag     string
	retryExists   bool
	activeTx      *sitePublishTransaction
	activeTouched []string
}

type sitePublishDiff struct {
	changes       []Change
	stale         []string
	desired       []desiredSiteObject
	committedNext sitePublishState
	stateExists   bool
	stateETag     string
	needsCommit   bool
	buildSkipped  bool
	transaction   *sitePublishTransaction
}

func sitePublishBuildOptions(siteID, title, description, sourceDir string, identity indexer.GitSourceIdentity) indexer.BuildOptions {
	return indexer.BuildOptions{
		SiteID: siteID, SiteTitle: title, SiteDescription: description, SourceDir: sourceDir,
		Repository: identity.Repository, RepositoryURL: identity.RepositoryURL,
		RejectSymlinks: true, InputPolicy: sitePublishInputPolicy,
	}
}

func loadSitePublishSnapshot(ctx context.Context, backend ConditionalObjectBackend, siteID string, prepared *indexer.PreparedBuild, reconcile bool, retry siteCacheRetry, retryETag string) (sitePublishSnapshot, error) {
	key := sitePublishStateKey(siteID)
	snapshot := sitePublishSnapshot{retry: retry, retryETag: retryETag, retryExists: retryETag != ""}
	var info ObjectInfo
	var stateObject Object
	var getETag string
	stateReadMode := selectedPublishStateReadMode(backend)
	if stateReadMode == publishStateReadGetOnly {
		var err error
		stateObject, getETag, err = backend.GetObject(ctx, key)
		if errors.Is(err, ErrObjectNotFound) {
			return loadMissingSitePublishSnapshot(ctx, backend, siteID, retry, retryETag)
		}
		if err != nil {
			return sitePublishSnapshot{}, fmt.Errorf("read site publish state: %w", err)
		}
		info = sitePublishStateInfo(stateObject, getETag)
		snapshot.exists = true
		snapshot.etag = getETag
		snapshot.head = info
	} else {
		var err error
		info, err = backend.HeadObject(ctx, key)
		if errors.Is(err, ErrObjectNotFound) {
			return loadMissingSitePublishSnapshot(ctx, backend, siteID, retry, retryETag)
		}
		if err != nil {
			return sitePublishSnapshot{}, fmt.Errorf("inspect site publish state: %w", err)
		}
		snapshot.exists = true
		snapshot.etag = info.ETag
		snapshot.head = info
	}
	if err := validateSitePublishStateHead(siteID, info); err != nil {
		return sitePublishSnapshot{}, fmt.Errorf("validate site publish state HEAD: %w", err)
	}
	version, _ := strconv.Atoi(info.Metadata["artifact-pages-publish-state-schema"])
	snapshot.generation = sitePublishGenerationFromHead(siteID, info)
	if err := classifySitePublishTransaction(&snapshot); err != nil {
		return sitePublishSnapshot{}, err
	}
	if stateReadMode == publishStateReadGetOnly {
		state, err := decodeSitePublishState(siteID, info, stateObject.Bytes)
		if err != nil {
			return sitePublishSnapshot{}, fmt.Errorf("validate site publish state: %w", err)
		}
		snapshot.state = state
	} else if !reconcile && prepared.Reusable() && info.Metadata["artifact-pages-publish-pending"] == "false" &&
		info.Metadata["artifact-pages-publish-input-root"] == prepared.InputRoot() && snapshot.activeTx == nil {
		// The trusted state HEAD supplies both the fingerprint and transaction
		// generation, so ordinary no-ops can skip the state body and full build.
		snapshot.state = sitePublishState{
			SchemaVersion: version, Site: siteID,
			Committed: sitePublishCommitted{InputRoot: prepared.InputRoot(), Generation: snapshot.generation, Objects: []sitePublishObject{}},
		}
		snapshot.fastPath = true
		return snapshot, nil
	}
	if stateReadMode == publishStateReadHeadThenGet {
		var err error
		stateObject, getETag, err = backend.GetObject(ctx, key)
		if err != nil {
			return sitePublishSnapshot{}, fmt.Errorf("read site publish state: %w", err)
		}
		if getETag != info.ETag {
			return sitePublishSnapshot{}, errors.New("site publish state changed between HEAD and GET; retry site publish")
		}
		state, err := decodeSitePublishState(siteID, info, stateObject.Bytes)
		if err != nil {
			return sitePublishSnapshot{}, fmt.Errorf("validate site publish state: %w", err)
		}
		snapshot.state = state
	}
	if !reconcile && prepared.Reusable() &&
		snapshot.state.Committed.InputRoot == prepared.InputRoot() && snapshot.activeTx == nil {
		snapshot.fastPath = true
		return snapshot, nil
	}
	if reconcile {
		rows, keys, inventoryErr := inventorySiteObjects(ctx, backend, siteID)
		if inventoryErr != nil {
			return sitePublishSnapshot{}, inventoryErr
		}
		snapshot.actual = rowsMap(rows)
		snapshot.actualKeys = keys
	}
	return snapshot, nil
}

func sitePublishStateInfo(object Object, etag string) ObjectInfo {
	return ObjectInfo{ETag: etag, Size: int64(len(object.Bytes)), ContentType: object.ContentType,
		ContentDisposition: object.ContentDisposition, ContentEncoding: object.ContentEncoding,
		CacheControl: object.Cache, Metadata: object.Metadata}
}

func sitePublishGenerationFromHead(site string, info ObjectInfo) string {
	return info.Metadata["artifact-pages-publish-generation"]
}

func classifySitePublishTransaction(snapshot *sitePublishSnapshot) error {
	tx := snapshot.retry.Transaction
	if tx == nil {
		return nil
	}
	if !snapshot.exists {
		if tx.BaseGeneration != snapshot.generation {
			return errors.New("site cache retry transaction does not match the absent publish state generation")
		}
		snapshot.activeTx = tx
		snapshot.activeTouched = append([]string(nil), tx.TouchedKeys...)
		return nil
	}
	if tx.ID == snapshot.generation {
		return nil
	}
	if tx.BaseGeneration != snapshot.generation {
		return errors.New("site cache retry transaction matches neither the committed nor pending publish state generation")
	}
	snapshot.activeTx = tx
	snapshot.activeTouched = append([]string(nil), tx.TouchedKeys...)
	return nil
}

func loadMissingSitePublishSnapshot(ctx context.Context, backend ConditionalObjectBackend, siteID string, retry siteCacheRetry, retryETag string) (sitePublishSnapshot, error) {
	rows, keys, err := inventorySiteObjects(ctx, backend, siteID)
	if err != nil {
		return sitePublishSnapshot{}, err
	}
	snapshot := sitePublishSnapshot{
		state: sitePublishState{SchemaVersion: sitePublishStateSchemaVersion, Site: siteID,
			Committed: sitePublishCommitted{Generation: absentSitePublishGeneration(siteID), Objects: rows}},
		generation: absentSitePublishGeneration(siteID), actual: rowsMap(rows), actualKeys: keys,
		retry: retry, retryETag: retryETag, retryExists: retryETag != "",
	}
	if err := classifySitePublishTransaction(&snapshot); err != nil {
		return sitePublishSnapshot{}, err
	}
	return snapshot, nil
}

func buildSitePublishDiff(ctx context.Context, backend ConditionalObjectBackend, siteID string, prepared *indexer.PreparedBuild, snapshot sitePublishSnapshot, reconcile bool) (sitePublishDiff, error) {
	if snapshot.fastPath {
		return sitePublishDiff{changes: []Change{}, stale: []string{}, desired: nil, stateExists: true, stateETag: snapshot.etag, buildSkipped: true}, nil
	}
	buildDir, err := os.MkdirTemp("", "artifact-pages-site-build-")
	if err != nil {
		return sitePublishDiff{}, fmt.Errorf("create temporary site build directory: %w", err)
	}
	defer os.RemoveAll(buildDir)
	build, err := indexer.BuildPrepared(ctx, prepared, buildDir)
	if err != nil {
		return sitePublishDiff{}, fmt.Errorf("build site index: %w", err)
	}
	desired, err := preparedSiteObjects(prepared, siteID)
	if err != nil {
		return sitePublishDiff{}, err
	}
	generated := []struct{ path, name string }{{build.OutputPath, "index.json"}, {build.MetadataPath, "meta.json"}}
	for _, filename := range build.SearchFiles {
		generated = append(generated, struct{ path, name string }{filename, "search/" + filepath.Base(filename)})
	}
	for _, file := range generated {
		data, readErr := os.ReadFile(file.path)
		if readErr != nil {
			return sitePublishDiff{}, fmt.Errorf("read generated site %s: %w", file.name, readErr)
		}
		key := "_indexes/" + siteID + "/" + file.name
		contentType, cache := "application/json; charset=utf-8", indexCacheControl
		if strings.HasSuffix(file.name, ".gz") {
			contentType, cache = "application/octet-stream", immutableCache
		}
		desired = append(desired, desiredSiteObject{
			key: key, relative: file.name, digest: sha256Hex(data), data: data,
			object: Object{ContentType: contentType, ContentDisposition: "inline", Cache: cache, Metadata: map[string]string{"artifact-pages-site": siteID}},
		})
	}
	sourceCount := len(prepared.SourceFiles())
	sort.Slice(desired[:sourceCount], func(i, j int) bool { return desired[i].key < desired[j].key })
	sort.Slice(desired[sourceCount:], func(i, j int) bool {
		a, b := desired[sourceCount+i], desired[sourceCount+j]
		rank := func(name string) int {
			if strings.HasSuffix(name, ".gz") {
				return 0
			}
			if name == "index.json" {
				return 1
			}
			if name == "search/manifest.json" {
				return 2
			}
			return 3
		}
		if rank(a.relative) != rank(b.relative) {
			return rank(a.relative) < rank(b.relative)
		}
		return a.key < b.key
	})
	oldRows := snapshot.state.Committed.Objects
	oldMap := rowsMap(oldRows)
	if snapshot.exists || len(snapshot.actualKeys) > 0 {
		if err := preserveGeneratedAt(ctx, backend, desired, oldMap); err != nil {
			return sitePublishDiff{}, err
		}
	}
	desiredRows := rowsFromDesired(desired)
	desiredMap := rowsMap(desiredRows)
	touched := make(map[string]struct{})
	for _, key := range snapshot.activeTouched {
		touched[key] = struct{}{}
	}
	for _, key := range unionRowKeys(oldMap, desiredMap) {
		if !equalSitePublishObject(oldMap[key], desiredMap[key]) {
			touched[key] = struct{}{}
		}
	}
	if reconcile || !snapshot.exists {
		actualKeys := make(map[string]struct{}, len(snapshot.actualKeys))
		for _, key := range snapshot.actualKeys {
			actualKeys[key] = struct{}{}
		}
		for _, key := range unionRowKeys(snapshot.actual, desiredMap) {
			if _, isListed := actualKeys[key]; !isListed || !equalSitePublishObject(snapshot.actual[key], desiredMap[key]) {
				touched[key] = struct{}{}
			}
		}
		// Listing can reveal old or manually-created managed keys whose custom
		// digest or HTTP metadata is absent/invalid. Keep them in the journal so
		// they are removed after the desired replacement is safely written.
		for _, key := range snapshot.actualKeys {
			if _, inRows := snapshot.actual[key]; !inRows {
				if _, desiredKey := desiredMap[key]; !desiredKey {
					touched[key] = struct{}{}
				}
			}
		}
	}
	touchedKeys := sortedSet(touched)
	changes := make([]Change, 0, len(touchedKeys))
	stale := make([]string, 0)
	for _, key := range touchedKeys {
		if _, desiredKey := desiredMap[key]; desiredKey {
			action := "create"
			if _, committed := oldMap[key]; committed {
				action = "update"
			}
			changes = append(changes, Change{Action: action, Path: key})
		} else {
			changes = append(changes, Change{Action: "remove", Path: key})
			stale = append(stale, key)
		}
	}
	projectionChanges := len(changes) > 0
	var transaction *sitePublishTransaction
	if projectionChanges {
		if snapshot.activeTx != nil {
			transaction = &sitePublishTransaction{ID: snapshot.activeTx.ID, BaseGeneration: snapshot.activeTx.BaseGeneration,
				TouchedKeys: sortedUnique(append(append([]string(nil), snapshot.activeTx.TouchedKeys...), touchedKeys...))}
		} else {
			id, err := newSitePublishTransactionID(snapshot.generation)
			if err != nil {
				return sitePublishDiff{}, err
			}
			transaction = &sitePublishTransaction{ID: id, BaseGeneration: snapshot.generation, TouchedKeys: touchedKeys}
		}
	}
	generation := snapshot.generation
	if transaction != nil {
		generation = transaction.ID
	}
	state := sitePublishState{
		SchemaVersion: sitePublishStateSchemaVersion, Site: siteID,
		Committed: sitePublishCommitted{InputRoot: prepared.InputRoot(), Generation: generation, Objects: desiredRows},
	}
	needsCommit := !snapshot.exists || snapshot.state.Committed.InputRoot != prepared.InputRoot() || projectionChanges
	// A true managed-state no-op must avoid writes. Reconcile with no drift and
	// a matching fingerprint falls through here with no change either.
	if snapshot.exists && !projectionChanges && snapshot.state.Committed.InputRoot == prepared.InputRoot() {
		needsCommit = false
	}
	if !snapshot.exists && !needsCommit {
		needsCommit = true
	}
	return sitePublishDiff{
		changes: changes, stale: stale, desired: desired, committedNext: state,
		stateExists: snapshot.exists, stateETag: snapshot.etag, needsCommit: needsCommit, transaction: transaction,
	}, nil
}

func newSitePublishTransactionID(base string) (string, error) {
	for attempt := 0; attempt < 4; attempt++ {
		var raw [32]byte
		if _, err := rand.Read(raw[:]); err != nil {
			return "", fmt.Errorf("generate site publish transaction id: %w", err)
		}
		id := hex.EncodeToString(raw[:])
		if id != base {
			return id, nil
		}
	}
	return "", errors.New("could not generate a site publish transaction id distinct from its base")
}

func preparedSiteObjects(prepared *indexer.PreparedBuild, siteID string) ([]desiredSiteObject, error) {
	files := prepared.SourceFiles()
	desired := make([]desiredSiteObject, 0, len(files)+4)
	prefix := "_artifacts/" + siteID + "/"
	for _, file := range files {
		data, ok := prepared.ReadSourceFile(file.RelativePath)
		if !ok {
			return nil, fmt.Errorf("prepared source file %q is missing its byte snapshot", file.RelativePath)
		}
		desired = append(desired, desiredSiteObject{
			key: prefix + file.RelativePath, relative: file.RelativePath, data: data, digest: file.SHA256,
			object: Object{ContentType: contentType(file.RelativePath), ContentDisposition: "inline", Cache: artifactCacheControl, Metadata: map[string]string{"artifact-pages-site": siteID}},
		})
	}
	return desired, nil
}

func preserveGeneratedAt(ctx context.Context, backend ConditionalObjectBackend, desired []desiredSiteObject, old map[string]sitePublishObject) error {
	for index := range desired {
		object := &desired[index]
		if object.key != "_indexes/"+siteIDFromKey(object.key)+"/index.json" && object.key != "_indexes/"+siteIDFromKey(object.key)+"/meta.json" {
			continue
		}
		previous, exists := old[object.key]
		if !exists || previous.SHA256 == object.digest {
			continue
		}
		current, _, err := backend.GetObject(ctx, object.key)
		if errors.Is(err, ErrObjectNotFound) {
			continue
		}
		if err != nil {
			return fmt.Errorf("read deployed site %s for generatedAt preservation: %w", object.key, err)
		}
		if sameGeneratedProjection(current.Bytes, object.data) {
			object.data = current.Bytes
			object.digest = sha256Hex(current.Bytes)
		}
	}
	return nil
}

func siteIDFromKey(key string) string {
	parts := strings.Split(key, "/")
	if len(parts) >= 3 {
		return parts[1]
	}
	return ""
}

func inventorySiteObjects(ctx context.Context, backend ConditionalObjectBackend, siteID string) ([]sitePublishObject, []string, error) {
	prefixes := []string{"_artifacts/" + siteID + "/", "_indexes/" + siteID + "/"}
	all := make([]string, 0)
	for _, prefix := range prefixes {
		keys, err := backend.ListKeys(ctx, prefix)
		if err != nil {
			return nil, nil, fmt.Errorf("list deployed site objects under %s: %w", prefix, err)
		}
		for _, key := range keys {
			if !managedSitePublishKey(siteID, key) {
				continue
			}
			all = append(all, key)
		}
	}
	all = sortedUnique(all)
	rows := make([]sitePublishObject, 0, len(all))
	for _, key := range all {
		info, err := backend.HeadObject(ctx, key)
		if errors.Is(err, ErrObjectNotFound) {
			continue
		}
		if err != nil {
			return nil, nil, fmt.Errorf("inspect legacy site object %s: %w", key, err)
		}
		row, valid := rowFromHead(siteID, key, info)
		if valid {
			rows = append(rows, row)
		}
	}
	return rows, all, nil
}

func managedSitePublishKey(siteID, key string) bool {
	if strings.HasPrefix(key, "_artifacts/"+siteID+"/") {
		return true
	}
	return strings.HasPrefix(key, "_indexes/"+siteID+"/") && validateSitePublishOwnedKey(siteID, key) == nil
}

func rowFromHead(siteID, key string, info ObjectInfo) (sitePublishObject, bool) {
	expectedType, expectedDisposition, expectedEncoding, expectedCache, err := expectedSitePublishObjectPolicy(siteID, key)
	if err != nil {
		return sitePublishObject{}, false
	}
	digest := info.Metadata["artifact-pages-sha256"]
	if !sitePublishStateHashPattern.MatchString(digest) {
		return sitePublishObject{}, false
	}
	if info.ContentDisposition == "" {
		info.ContentDisposition = "inline"
	}
	if info.ContentType != expectedType || info.ContentDisposition != expectedDisposition || info.ContentEncoding != expectedEncoding || info.CacheControl != expectedCache {
		return sitePublishObject{}, false
	}
	return sitePublishObject{
		Key: key, SHA256: digest, Size: info.Size, ContentType: info.ContentType,
		ContentEncoding: info.ContentEncoding, ContentDisposition: info.ContentDisposition, CacheControl: info.CacheControl,
	}, true
}

func rowsFromDesired(desired []desiredSiteObject) []sitePublishObject {
	rows := make([]sitePublishObject, 0, len(desired))
	for _, object := range desired {
		rows = append(rows, sitePublishObject{
			Key: object.key, SHA256: object.digest, Size: int64(len(object.data)),
			ContentType: object.object.ContentType, ContentEncoding: object.object.ContentEncoding,
			ContentDisposition: object.object.ContentDisposition, CacheControl: object.object.Cache,
		})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Key < rows[j].Key })
	return rows
}

func rowsMap(rows []sitePublishObject) map[string]sitePublishObject {
	result := make(map[string]sitePublishObject, len(rows))
	for _, row := range rows {
		result[row.Key] = row
	}
	return result
}

func equalSitePublishObject(left, right sitePublishObject) bool {
	return left.Key != "" && right.Key != "" && left == right
}

func unionRowKeys(left, right map[string]sitePublishObject) []string {
	set := make(map[string]struct{}, len(left)+len(right))
	for key := range left {
		set[key] = struct{}{}
	}
	for key := range right {
		set[key] = struct{}{}
	}
	return sortedSet(set)
}

func sortedSet(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for key := range values {
		result = append(result, key)
	}
	sort.Strings(result)
	return result
}

func sortedUnique(values []string) []string {
	set := make(map[string]struct{}, len(values))
	for _, value := range values {
		set[value] = struct{}{}
	}
	return sortedSet(set)
}

func sitePublishStateCondition(exists bool, etag string) ObjectCondition {
	if exists {
		return ObjectCondition{IfMatchETag: etag}
	}
	return ObjectCondition{IfNoneMatch: true}
}

func writeSitePublishState(ctx context.Context, backend ConditionalObjectBackend, siteID string, state sitePublishState, exists bool, etag string) (string, error) {
	object, err := buildSitePublishStateObject(siteID, state)
	if err != nil {
		return "", err
	}
	newETag, err := backend.PutObjectConditional(ctx, sitePublishStateKey(siteID), object, sitePublishStateCondition(exists, etag))
	if err != nil {
		return "", fmt.Errorf("save site publish state: %w", err)
	}
	if strings.TrimSpace(newETag) == "" {
		return "", errors.New("site publish state write returned no ETag")
	}
	return newETag, nil
}

func sourceKey(siteID, relative string) string { return "_artifacts/" + siteID + "/" + relative }
