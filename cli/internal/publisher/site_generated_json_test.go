package publisher

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/artifact-pages/artifact-pages/cli/internal/fulltext"
	"github.com/artifact-pages/artifact-pages/cli/internal/indexer"
)

type awsGeneratedJSONTestBackend struct{ *siteReconcileBackend }

func (*awsGeneratedJSONTestBackend) siteGeneratedJSONContentEncoding() string { return "gzip" }

func TestSitePublishInputFingerprintIncludesAWSGeneratedJSONPolicy(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	writePublisherFixture(t, root, "docs/artifacts/guide.md", []byte("# Guide\n\nPolicy fingerprint fixture."))
	identity := indexer.GitSourceIdentity{
		Repository: "acme/sre", RepositoryURL: "https://github.com/acme/sre", SourcePath: "docs/artifacts",
	}
	const releasedPlainPolicy = "publisher-site-projection-v1;http-policy-v1;index-schema-v1;fulltext-policy-v2"
	plainOptions := sitePublishBuildOptions("sre", "SRE", "", filepath.Join(root, "docs/artifacts"), "", identity, &cloudflareBackend{})
	awsOptions := sitePublishBuildOptions("sre", "SRE", "", filepath.Join(root, "docs/artifacts"), "", identity, &awsBackend{})
	fixedTime := time.Date(2026, time.October, 18, 0, 0, 0, 0, time.UTC)
	plainOptions.Now = func() time.Time { return fixedTime }
	awsOptions.Now = func() time.Time { return fixedTime }
	if sitePublishInputPolicy != releasedPlainPolicy || plainOptions.InputPolicy != releasedPlainPolicy {
		t.Fatalf("non-AWS input policy = %q and base policy = %q; want released policy %q", plainOptions.InputPolicy, sitePublishInputPolicy, releasedPlainPolicy)
	}
	if awsOptions.InputPolicy != releasedPlainPolicy+";aws-generated-json-gzip-v1" {
		t.Fatalf("AWS input policy = %q; want generated-JSON gzip policy", awsOptions.InputPolicy)
	}
	plainPrepared, err := indexer.PrepareBuild(context.Background(), plainOptions)
	if err != nil {
		t.Fatalf("prepare non-AWS inputs: %v", err)
	}
	awsPrepared, err := indexer.PrepareBuild(context.Background(), awsOptions)
	if err != nil {
		t.Fatalf("prepare AWS inputs: %v", err)
	}
	if plainPrepared.InputRoot() == awsPrepared.InputRoot() {
		t.Fatalf("identical source inputs have the same plain/AWS root %q", plainPrepared.InputRoot())
	}
}

func TestSiteGeneratedJSONEncodingIsAdapterSelectedAndDeterministic(t *testing.T) {
	plain := []byte(`{"schemaVersion":1,"synthetic":true}`)
	local, encoding, err := encodeSiteGeneratedJSON(newSiteReconcileBackend(), "index.json", plain)
	if err != nil || encoding != "" || !bytes.Equal(local, plain) {
		t.Fatalf("local representation = %q, %q, %v", local, encoding, err)
	}
	if got := selectedSiteGeneratedJSONEncoding(&awsBackend{}); got != "gzip" {
		t.Fatalf("AWS encoding policy = %q", got)
	}
	if got := selectedSiteGeneratedJSONEncoding(&cloudflareBackend{}); got != "" {
		t.Fatalf("Cloudflare encoding policy = %q", got)
	}

	first, encoding, err := encodeSiteGeneratedJSON(&awsGeneratedJSONTestBackend{newSiteReconcileBackend()}, "index.json", plain)
	if err != nil || encoding != "gzip" {
		t.Fatalf("AWS representation encoding = %q, %v", encoding, err)
	}
	second, _, err := encodeSiteGeneratedJSON(&awsGeneratedJSONTestBackend{newSiteReconcileBackend()}, "index.json", plain)
	if err != nil || !bytes.Equal(first, second) {
		t.Fatalf("repeated gzip bytes differ: %v", err)
	}
	if len(first) < 10 || first[3] != 0 || !bytes.Equal(first[4:8], []byte{0, 0, 0, 0}) || first[9] != 255 {
		t.Fatalf("gzip header is not deterministic/fixed: %v", first[:min(len(first), 10)])
	}
	decoded, err := decodeSiteGeneratedJSON(first, encoding)
	if err != nil || !bytes.Equal(decoded, plain) {
		t.Fatalf("decoded AWS representation = %q, %v", decoded, err)
	}
	meta, metaEncoding, _ := encodeSiteGeneratedJSON(&awsGeneratedJSONTestBackend{newSiteReconcileBackend()}, "meta.json", plain)
	if metaEncoding != "" || !bytes.Equal(meta, plain) {
		t.Fatalf("metadata representation = %q, %q", meta, metaEncoding)
	}
}

func TestSyntheticLargeGeneratedJSONIsStoredGzippedAtExistingKeys(t *testing.T) {
	// This is synthetic payload evidence: it tests the >10,000,000-byte raw
	// representation boundary without claiming a benchmark or real site result.
	backend := &awsGeneratedJSONTestBackend{newSiteReconcileBackend()}
	for _, test := range []struct {
		name     string
		size     int
		relative string
	}{
		{name: "small-index", size: 2048, relative: "index.json"},
		{name: "large-index-synthetic", size: (10 << 20) + 1, relative: "index.json"},
		{name: "small-manifest", size: 2048, relative: "search/manifest.json"},
		{name: "large-manifest-synthetic", size: (10 << 20) + 1, relative: "search/manifest.json"},
	} {
		t.Run(test.name, func(t *testing.T) {
			plain := syntheticJSONBytes(test.size)
			stored, encoding, err := encodeSiteGeneratedJSON(backend, test.relative, plain)
			if err != nil || encoding != "gzip" {
				t.Fatalf("encode = %q, %v", encoding, err)
			}
			key := "_indexes/sre/" + test.relative
			object := Object{Bytes: stored, ContentType: "application/json; charset=utf-8", ContentEncoding: encoding,
				ContentDisposition: "inline", Cache: indexCacheControl,
				Metadata: map[string]string{"artifact-pages-site": "sre", "artifact-pages-sha256": sha256Hex(stored)}}
			if err := backend.PutObject(context.Background(), key, object); err != nil {
				t.Fatal(err)
			}
			got, _, err := backend.GetObject(context.Background(), key)
			if err != nil {
				t.Fatal(err)
			}
			info, err := backend.HeadObject(context.Background(), key)
			if err != nil {
				t.Fatal(err)
			}
			if info.Size != int64(len(stored)) || info.Metadata["artifact-pages-sha256"] != sha256Hex(stored) ||
				info.ContentType != object.ContentType || info.ContentDisposition != "inline" || info.ContentEncoding != "gzip" || info.CacheControl != indexCacheControl {
				t.Fatalf("stored representation metadata = %+v", info)
			}
			decoded, err := decodeSiteGeneratedJSON(got.Bytes, got.ContentEncoding)
			if err != nil || !bytes.Equal(decoded, plain) {
				t.Fatalf("decoded stored bytes differ from generated JSON: %v", err)
			}
			repeated, _, err := encodeSiteGeneratedJSON(backend, test.relative, plain)
			if err != nil || !bytes.Equal(repeated, stored) {
				t.Fatalf("repeated stored representation differs: %v", err)
			}
		})
	}
}

func TestPublishAWSGeneratedJSONMigrationDryRunAndNoOp(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	writePublisherFixture(t, root, "docs/artifacts/guide.md", []byte("# Guide\n\nsearchable text"))
	base := newSiteReconcileBackend()
	seedPublisherRegistry(t, base.lockMemoryBackend, registeredSREManifest)
	seedMemoryObject(base.lockMemoryBackend, "_indexes/other/index.json", []byte("neighbor site"))
	seedMemoryObject(base.lockMemoryBackend, "_control/private/sentinel", []byte("private control"))
	seedMemoryObject(base.lockMemoryBackend, "index.html", []byte("application shell"))

	plainResult, err := PublishSite(context.Background(), base, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err != nil || plainResult.Outcome != "synced" {
		t.Fatalf("plain publish = %+v, %v", plainResult, err)
	}
	indexKey, manifestKey := "_indexes/sre/index.json", "_indexes/sre/search/manifest.json"
	plainIndex, _, err := base.GetObject(context.Background(), indexKey)
	if err != nil {
		t.Fatal(err)
	}
	plainManifest, _, err := base.GetObject(context.Background(), manifestKey)
	if err != nil {
		t.Fatal(err)
	}
	metaBefore, _, err := base.GetObject(context.Background(), "_indexes/sre/meta.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest fulltext.Manifest
	if err := json.Unmarshal(plainManifest.Bytes, &manifest); err != nil {
		t.Fatal(err)
	}
	var opaqueKeys []string
	opaqueKeys = append(opaqueKeys, strings.TrimPrefix(manifest.Root.URL, "/"))
	if manifest.Sections != nil {
		opaqueKeys = append(opaqueKeys, strings.TrimPrefix(manifest.Sections.URL, "/"))
	}
	for _, ref := range manifest.Shards {
		if ref != nil {
			opaqueKeys = append(opaqueKeys, strings.TrimPrefix(ref.URL, "/"))
		}
	}
	opaqueKeys = append(opaqueKeys, fullTextObjectKeys(manifest.Texts)...)
	opaqueBefore := make(map[string]Object, len(opaqueKeys))
	for _, key := range opaqueKeys {
		object, _, err := base.GetObject(context.Background(), key)
		if err != nil {
			t.Fatalf("read opaque search object %q: %v", key, err)
		}
		opaqueBefore[key] = object
	}
	neighborBefore, _, _ := base.GetObject(context.Background(), "_indexes/other/index.json")
	controlBefore, _, _ := base.GetObject(context.Background(), "_control/private/sentinel")
	appBefore, _, _ := base.GetObject(context.Background(), "index.html")
	stateHeadBefore, err := base.HeadObject(context.Background(), sitePublishStateKey("sre"))
	if err != nil {
		t.Fatal(err)
	}

	aws := &awsGeneratedJSONTestBackend{base}
	base.resetEvents()
	dry, err := PublishSite(context.Background(), aws, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts", DryRun: true})
	if err != nil || dry.Outcome != "planned" {
		t.Fatalf("AWS dry-run = %+v, %v", dry, err)
	}
	for _, event := range base.eventSnapshot() {
		if strings.HasPrefix(event, "put:") || strings.HasPrefix(event, "delete:") {
			t.Fatalf("dry-run mutated storage: %v", base.eventSnapshot())
		}
	}

	result, err := PublishSite(context.Background(), aws, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err != nil || result.Outcome != "synced" {
		t.Fatalf("AWS migration = %+v, %v", result, err)
	}
	for _, key := range []string{indexKey, manifestKey} {
		object, _, err := base.GetObject(context.Background(), key)
		if err != nil {
			t.Fatal(err)
		}
		info, err := base.HeadObject(context.Background(), key)
		if err != nil {
			t.Fatal(err)
		}
		if object.ContentEncoding != "gzip" || info.ContentEncoding != "gzip" || info.Size != int64(len(object.Bytes)) ||
			info.ContentType != "application/json; charset=utf-8" || info.ContentDisposition != "inline" ||
			info.CacheControl != indexCacheControl || info.Metadata["artifact-pages-sha256"] != sha256Hex(object.Bytes) {
			t.Fatalf("encoded %s representation metadata = object=%+v info=%+v", key, object, info)
		}
		decoded, err := decodeSiteGeneratedJSON(object.Bytes, object.ContentEncoding)
		if err != nil {
			t.Fatal(err)
		}
		var want []byte
		if key == indexKey {
			want = plainIndex.Bytes
		} else {
			want = plainManifest.Bytes
		}
		if !bytes.Equal(decoded, want) {
			t.Fatalf("decoded %s differs from the builder's plain output", key)
		}
	}
	metaAfter, _, _ := base.GetObject(context.Background(), "_indexes/sre/meta.json")
	if metaAfter.ContentEncoding != "" || !bytes.Equal(metaAfter.Bytes, metaBefore.Bytes) {
		t.Fatal("meta.json changed representation during the AWS migration")
	}
	for _, key := range opaqueKeys {
		got, _, err := base.GetObject(context.Background(), key)
		if err != nil {
			t.Fatal(err)
		}
		if got.ContentEncoding != "" || !bytes.Equal(got.Bytes, opaqueBefore[key].Bytes) || len(got.Bytes) != len(opaqueBefore[key].Bytes) || sha256Hex(got.Bytes) != sha256Hex(opaqueBefore[key].Bytes) {
			t.Fatalf("opaque search object %s changed or acquired HTTP encoding", key)
		}
	}
	neighborAfter, _, _ := base.GetObject(context.Background(), "_indexes/other/index.json")
	controlAfter, _, _ := base.GetObject(context.Background(), "_control/private/sentinel")
	appAfter, _, _ := base.GetObject(context.Background(), "index.html")
	if !bytes.Equal(neighborBefore.Bytes, neighborAfter.Bytes) || !bytes.Equal(controlBefore.Bytes, controlAfter.Bytes) || !bytes.Equal(appBefore.Bytes, appAfter.Bytes) {
		t.Fatal("AWS migration changed a neighboring site, unrelated control object, or app object")
	}
	stateHeadAfter, err := base.HeadObject(context.Background(), sitePublishStateKey("sre"))
	if err != nil {
		t.Fatal(err)
	}
	if stateHeadAfter.Metadata["artifact-pages-publish-input-root"] == stateHeadBefore.Metadata["artifact-pages-publish-input-root"] {
		t.Fatal("AWS representation policy did not advance the committed input fingerprint")
	}
	stateObject, etag, err := base.GetObject(context.Background(), sitePublishStateKey("sre"))
	if err != nil {
		t.Fatal(err)
	}
	state, err := decodeSitePublishState("sre", sitePublishStateInfo(stateObject, etag), stateObject.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{indexKey, manifestKey} {
		var found bool
		for _, row := range state.Committed.Objects {
			if row.Key == key {
				found = row.ContentEncoding == "gzip" && row.Size > 0 && row.SHA256 == sha256Hex(mustGetObject(t, base, key).Bytes)
			}
		}
		if !found {
			t.Fatalf("state row for %s does not describe stored gzip bytes", key)
		}
	}
	noOp, err := PublishSite(context.Background(), aws, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err != nil || noOp.Outcome != "no-op" {
		t.Fatalf("post-migration sync = %+v, %v", noOp, err)
	}
}

func TestPriorSiteIndexReadsPlainAndGzipAndRejectsCorruption(t *testing.T) {
	plain := []byte(`{"schemaVersion":1,"site":{"id":"sre","title":"SRE"},"generatedAt":"2026-01-01T00:00:00Z","artifacts":[{"id":"report.html","title":"Report","path":"report.html","format":"html","updatedAt":"2026-01-01T00:00:00Z","lastCommitter":{"name":"Alice"}}]}`)
	goodGzip := testGzipMember(t, plain)
	secondMember := testGzipMember(t, []byte(`{}`))
	truncated := append([]byte(nil), goodGzip[:len(goodGzip)-3]...)
	withTrailing := append(append([]byte(nil), goodGzip...), []byte("tail")...)
	concatenated := append(append([]byte(nil), goodGzip...), secondMember...)
	badCRC := append([]byte(nil), goodGzip...)
	badCRC[len(badCRC)-8] ^= 0xff
	invalidJSON := []byte("{")
	for _, test := range []struct {
		name           string
		body           []byte
		encoding       string
		wantErr        bool
		wantNil        bool
		mutateMetadata string
	}{
		{name: "plain", body: plain},
		{name: "gzip", body: goodGzip, encoding: "gzip"},
		{name: "missing object fallback", body: plain, wantNil: true},
		{name: "digest mismatch fallback", body: plain, wantNil: true, mutateMetadata: "bytes"},
		{name: "metadata mismatch", body: plain, wantErr: true, mutateMetadata: "encoding"},
		{name: "cache metadata mismatch", body: plain, wantErr: true, mutateMetadata: "cache"},
		{name: "truncated gzip", body: truncated, encoding: "gzip", wantErr: true},
		{name: "bad gzip CRC", body: badCRC, encoding: "gzip", wantErr: true},
		{name: "gzip trailing bytes", body: withTrailing, encoding: "gzip", wantErr: true},
		{name: "concatenated gzip", body: concatenated, encoding: "gzip", wantErr: true},
		{name: "invalid JSON", body: invalidJSON, wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			backend := newLockMemoryBackend()
			if test.name != "missing object fallback" {
				seedPriorIndexState(t, backend, test.body, test.encoding, test.mutateMetadata)
			}
			prior, err := sitePriorStateLoader(backend, "sre")(context.Background())
			if test.wantErr {
				if err == nil {
					t.Fatal("expected prior-index error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if test.wantNil {
				if prior != nil {
					t.Fatalf("prior = %+v, want no-prior fallback", prior)
				}
				return
			}
			document, ok := prior.Documents["report.html"]
			if !ok || document.LastCommitter != "Alice" {
				t.Fatalf("prior document attribution = %+v, found=%t", document, ok)
			}
		})
	}

	if _, err := decodeSiteGeneratedJSONWithLimit(plain, "", int64(len(plain)-1)); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("plain prior-index overflow = %v", err)
	}
	if _, err := decodeSiteGeneratedJSONWithLimit(goodGzip, "gzip", int64(len(plain)-1)); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("gzip prior-index overflow = %v", err)
	}
	if err := validateSitePublishRow("sre", sitePublishObject{Key: "_indexes/sre/meta.json", SHA256: sha256Hex(plain), Size: int64(len(plain)), ContentType: "application/json; charset=utf-8", ContentDisposition: "inline", ContentEncoding: "gzip", CacheControl: indexCacheControl}); err == nil {
		t.Fatal("encoded meta.json was accepted in committed state")
	}
	if err := validateSitePublishRow("sre", sitePublishObject{Key: "_indexes/sre/index.json", SHA256: sha256Hex(plain), Size: int64(len(plain)), ContentType: "application/json; charset=utf-8", ContentDisposition: "inline", ContentEncoding: "br", CacheControl: indexCacheControl}); err == nil {
		t.Fatal("unknown index encoding was accepted in committed state")
	}
}

func seedPriorIndexState(t *testing.T, backend *lockMemoryBackend, body []byte, encoding, mutateMetadata string) {
	t.Helper()
	key := "_indexes/sre/index.json"
	row := sitePublishObject{Key: key, SHA256: sha256Hex(body), Size: int64(len(body)), ContentType: "application/json; charset=utf-8",
		ContentEncoding: encoding, ContentDisposition: "inline", CacheControl: indexCacheControl}
	state := sitePublishState{SchemaVersion: sitePublishStateSchemaVersion, Site: "sre", Committed: sitePublishCommitted{
		InputRoot: strings.Repeat("a", 64), Generation: strings.Repeat("b", 64), Objects: []sitePublishObject{row}}}
	stateObject, err := buildSitePublishStateObject("sre", state)
	if err != nil {
		t.Fatal(err)
	}
	seedReconcileObject(t, backend, sitePublishStateKey("sre"), stateObject)
	metadata := map[string]string{"artifact-pages-site": "sre", "artifact-pages-sha256": row.SHA256}
	contentType := row.ContentType
	contentDisposition := row.ContentDisposition
	contentEncoding := row.ContentEncoding
	cache := row.CacheControl
	switch mutateMetadata {
	case "encoding":
		contentEncoding = "br"
	case "cache":
		cache = "no-cache"
	case "digest":
		metadata["artifact-pages-sha256"] = strings.Repeat("0", 64)
	}
	if mutateMetadata != "missing" {
		storedBody := body
		if mutateMetadata == "bytes" {
			storedBody = bytes.Repeat([]byte("x"), len(body))
		}
		seedReconcileObject(t, backend, key, Object{Bytes: storedBody, ContentType: contentType, ContentDisposition: contentDisposition,
			ContentEncoding: contentEncoding, Cache: cache, Metadata: metadata})
	}
}

func syntheticJSONBytes(size int) []byte {
	prefix, suffix := []byte(`{"synthetic":true,"payload":"`), []byte(`"}`)
	if size < len(prefix)+len(suffix) {
		panic("synthetic JSON size is too small")
	}
	return append(append(prefix, bytes.Repeat([]byte("x"), size-len(prefix)-len(suffix))...), suffix...)
}

func testGzipMember(t *testing.T, plain []byte) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := gzip.NewWriter(&output)
	writer.Header.ModTime = time.Time{}
	writer.Header.OS = 255
	if _, err := writer.Write(plain); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func fullTextObjectKeys(refs []fulltext.ObjectRef) []string {
	keys := make([]string, 0, len(refs))
	for _, ref := range refs {
		keys = append(keys, strings.TrimPrefix(ref.URL, "/"))
	}
	return keys
}

func mustGetObject(t *testing.T, backend ConditionalObjectBackend, key string) Object {
	t.Helper()
	object, _, err := backend.GetObject(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	return object
}
