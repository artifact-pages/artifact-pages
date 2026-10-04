package publisher

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestSitePublishStateCodecRoundTripDeterministic(t *testing.T) {
	state := validSitePublishState()
	first, err := encodeSitePublishState(state)
	if err != nil {
		t.Fatal(err)
	}
	second, err := encodeSitePublishState(state)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatal("identical state encoded to different gzip bytes")
	}
	reader, err := gzip.NewReader(bytes.NewReader(first))
	if err != nil {
		t.Fatal(err)
	}
	if !reader.ModTime.IsZero() || reader.Name != "" || reader.Comment != "" || reader.OS != 255 {
		t.Fatalf("gzip header is not deterministic: %+v", reader.Header)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}

	object, err := buildSitePublishStateObject(state.Site, state)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(object.Bytes, first) {
		t.Fatal("object builder did not use deterministic encoded bytes")
	}
	if object.ContentType != "application/octet-stream" || object.ContentEncoding != "" || object.ContentDisposition != "" || object.Cache != "no-store" {
		t.Fatalf("unexpected object HTTP policy: %+v", object)
	}
	if len(object.Metadata) != 6 || object.Metadata["artifact-pages-publish-state-schema"] != "1" ||
		object.Metadata["artifact-pages-publish-input-root"] != state.Committed.InputRoot ||
		object.Metadata["artifact-pages-publish-generation"] != state.Committed.Generation ||
		object.Metadata["artifact-pages-publish-pending"] != "false" ||
		object.Metadata["artifact-pages-site"] != state.Site ||
		object.Metadata["artifact-pages-sha256"] != sha256Hex(object.Bytes) {
		t.Fatalf("unexpected object metadata: %+v", object.Metadata)
	}
	decoded, err := decodeSitePublishState(state.Site, objectInfoForState(object), object.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decoded, state) {
		t.Fatalf("decoded state differs\n got: %#v\nwant: %#v", decoded, state)
	}
	if got := sitePublishStateKey("sre"); got != "_control/publish-state/sre.json.gz" {
		t.Fatalf("state key = %q", got)
	}
}

func TestSitePublishStateRejectsOldSchemaOneShapeWithScopedResetGuidance(t *testing.T) {
	inputRoot := strings.Repeat("b", 64)
	generation := strings.Repeat("d", 64)
	plain := []byte(`{"schemaVersion":1,"site":"sre","committed":{"inputRoot":"` + inputRoot + `","objects":[]}}`)
	compressed := gzipForTest(t, plain)
	info := stateInfoForBytes(compressed, "sre", inputRoot, generation)
	_, err := decodeSitePublishState("sre", info, compressed)
	for _, exactKey := range []string{sitePublishStateKey("sre"), siteCacheRetryKey("sre")} {
		if err == nil || !strings.Contains(err.Error(), exactKey) {
			t.Fatalf("old schema-one shape error = %v; want target-scoped reset guidance including %s", err, exactKey)
		}
	}
}

func TestSitePublishStateHeadRejectsOldSchemaOneMetadataMissingGeneration(t *testing.T) {
	state := validSitePublishState()
	object, err := buildSitePublishStateObject(state.Site, state)
	if err != nil {
		t.Fatal(err)
	}
	info := sitePublishStateInfo(object, `"missing-generation"`)
	delete(info.Metadata, "artifact-pages-publish-generation")
	if err := validateSitePublishStateHead(state.Site, info); err == nil ||
		!strings.Contains(err.Error(), sitePublishStateKey(state.Site)) || !strings.Contains(err.Error(), siteCacheRetryKey(state.Site)) {
		t.Fatalf("old schema-one HEAD shape error = %v; want selected-site reset guidance", err)
	}
}

func TestValidateSitePublishStateHead(t *testing.T) {
	object, err := buildSitePublishStateObject("sre", validSitePublishState())
	if err != nil {
		t.Fatal(err)
	}
	base := objectInfoForState(object)
	cases := []struct {
		name string
		edit func(*ObjectInfo)
	}{
		{name: "missing etag", edit: func(info *ObjectInfo) { info.ETag = "  " }},
		{name: "invalid size", edit: func(info *ObjectInfo) { info.Size = 0 }},
		{name: "oversize", edit: func(info *ObjectInfo) { info.Size = maxSitePublishStateGzipBytes + 1 }},
		{name: "wrong content type", edit: func(info *ObjectInfo) { info.ContentType = "application/json" }},
		{name: "content encoding", edit: func(info *ObjectInfo) { info.ContentEncoding = "gzip" }},
		{name: "wrong cache", edit: func(info *ObjectInfo) { info.CacheControl = "public" }},
		{name: "wrong disposition", edit: func(info *ObjectInfo) { info.ContentDisposition = "attachment" }},
		{name: "missing metadata", edit: func(info *ObjectInfo) { delete(info.Metadata, "artifact-pages-site") }},
		{name: "bad schema", edit: func(info *ObjectInfo) { info.Metadata["artifact-pages-publish-state-schema"] = "3" }},
		{name: "bad generation", edit: func(info *ObjectInfo) { info.Metadata["artifact-pages-publish-generation"] = "ABC" }},
		{name: "wrong site", edit: func(info *ObjectInfo) { info.Metadata["artifact-pages-site"] = "other" }},
		{name: "bad input root", edit: func(info *ObjectInfo) { info.Metadata["artifact-pages-publish-input-root"] = "ABC" }},
		{name: "bad pending", edit: func(info *ObjectInfo) { info.Metadata["artifact-pages-publish-pending"] = "yes" }},
		{name: "bad sha", edit: func(info *ObjectInfo) { info.Metadata["artifact-pages-sha256"] = strings.Repeat("A", 64) }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			info := cloneStateInfo(base)
			test.edit(&info)
			if err := validateSitePublishStateHead("sre", info); err == nil {
				t.Fatal("expected HEAD validation error")
			}
		})
	}
	if err := validateSitePublishStateHead("sre", base); err != nil {
		t.Fatalf("valid HEAD rejected: %v", err)
	}
	withAdditiveMetadata := cloneStateInfo(base)
	withAdditiveMetadata.Metadata["provider-added-field"] = "ignored"
	if err := validateSitePublishStateHead("sre", withAdditiveMetadata); err != nil {
		t.Fatalf("unknown additive state metadata was rejected: %v", err)
	}
}

func TestEncodeSitePublishStateRejectsInvalidRows(t *testing.T) {
	base := validSitePublishState()
	cases := []struct {
		name   string
		mutate func(*sitePublishState)
	}{
		{name: "wrong schema", mutate: func(state *sitePublishState) { state.SchemaVersion = 3 }},
		{name: "wrong site", mutate: func(state *sitePublishState) { state.Site = "other" }},
		{name: "bad root", mutate: func(state *sitePublishState) { state.Committed.InputRoot = "not-a-hash" }},
		{name: "nil object list", mutate: func(state *sitePublishState) { state.Committed.Objects = nil }},
		{name: "unsorted rows", mutate: func(state *sitePublishState) {
			state.Committed.Objects[0], state.Committed.Objects[1] = state.Committed.Objects[1], state.Committed.Objects[0]
		}},
		{name: "duplicate rows", mutate: func(state *sitePublishState) { state.Committed.Objects[1] = state.Committed.Objects[0] }},
		{name: "uppercase digest", mutate: func(state *sitePublishState) { state.Committed.Objects[0].SHA256 = strings.Repeat("A", 64) }},
		{name: "negative size", mutate: func(state *sitePublishState) { state.Committed.Objects[0].Size = -1 }},
		{name: "unknown cache", mutate: func(state *sitePublishState) { state.Committed.Objects[0].CacheControl = "no-store" }},
		{name: "outside key", mutate: func(state *sitePublishState) { state.Committed.Objects[0].Key = "_artifacts/other/file.html" }},
		{name: "traversal key", mutate: func(state *sitePublishState) { state.Committed.Objects[0].Key = "_artifacts/sre/../escape.html" }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			state := cloneSitePublishState(base)
			test.mutate(&state)
			if _, err := encodeSitePublishState(state); err == nil {
				t.Fatal("expected invalid state to be rejected")
			}
		})
	}
}

func TestDecodeSitePublishStateStrictJSONAndBounds(t *testing.T) {
	state := validSitePublishState()
	object, err := buildSitePublishStateObject(state.Site, state)
	if err != nil {
		t.Fatal(err)
	}
	validJSON, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	withUnknown := append(append([]byte(nil), validJSON[:len(validJSON)-1]...), []byte(`,"future":{"ok":[1,true]}}`)...)
	if _, err := decodePlainStateForTest(state.Site, objectInfoForState(object), withUnknown); err != nil {
		t.Fatalf("unknown fields should be ignored: %v", err)
	}
	duplicate := append(append([]byte(nil), validJSON[:len(validJSON)-1]...), []byte(`,"future":{"x":1,"x":2}}`)...)
	if _, err := decodePlainStateForTest(state.Site, objectInfoForState(object), duplicate); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("duplicate unknown key error = %v", err)
	}
	trailing := append(append([]byte(nil), validJSON...), []byte(` {}`)...)
	if _, err := decodePlainStateForTest(state.Site, objectInfoForState(object), trailing); err == nil {
		t.Fatal("trailing JSON value was accepted")
	}
	unsupported := []byte(`{"schemaVersion":99,"site":42,"committed":false}`)
	if _, err := decodePlainStateForTest(state.Site, objectInfoForState(object), unsupported); err == nil || !strings.Contains(err.Error(), "unsupported site publish state schema version 99") {
		t.Fatalf("unsupported schema was not rejected before other fields: %v", err)
	}
	if _, err := decodePlainStateForTest(state.Site, objectInfoForState(object), []byte(`{"schemaVersion":1,"schemaVersion":1}`)); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("duplicate schema key error = %v", err)
	}
	if _, err := decodePlainStateForTest(state.Site, objectInfoForState(object), bytes.Repeat([]byte("x"), maxSitePublishStateJSONBytes+1)); err == nil {
		t.Fatal("oversize decompressed JSON was accepted")
	}
	missingObjects := []byte(`{"schemaVersion":1,"site":"sre","committed":{"inputRoot":"` + strings.Repeat("b", 64) + `","generation":"` + strings.Repeat("d", 64) + `"}}`)
	if _, err := decodePlainStateForTest(state.Site, objectInfoForState(object), missingObjects); err == nil {
		t.Fatal("missing required objects array was accepted")
	}
}

func TestDecodeSitePublishStateRejectsBodyAndGzipDrift(t *testing.T) {
	state := validSitePublishState()
	object, err := buildSitePublishStateObject(state.Site, state)
	if err != nil {
		t.Fatal(err)
	}
	info := objectInfoForState(object)
	if _, err := decodeSitePublishState("sre", info, append(append([]byte(nil), object.Bytes...), 0)); err == nil {
		t.Fatal("body-size mismatch was accepted")
	}
	mutated := append([]byte(nil), object.Bytes...)
	mutated[len(mutated)-1] ^= 0xff
	if _, err := decodeSitePublishState("sre", info, mutated); err == nil {
		t.Fatal("body digest mismatch was accepted")
	}
	trailing := append(append([]byte(nil), object.Bytes...), []byte("junk")...)
	if _, err := decodeCompressedForState("sre", info, trailing); err == nil {
		t.Fatal("gzip trailing data was accepted")
	}
	secondMember := append([]byte(nil), object.Bytes...)
	secondMember = append(secondMember, object.Bytes...)
	if _, err := decodeCompressedForState("sre", info, secondMember); err == nil {
		t.Fatal("concatenated gzip members were accepted")
	}
	for _, field := range []string{"artifact-pages-site", "artifact-pages-publish-input-root", "artifact-pages-publish-pending"} {
		mismatched := cloneStateInfo(info)
		switch field {
		case "artifact-pages-site":
			mismatched.Metadata[field] = "other"
		case "artifact-pages-publish-input-root":
			mismatched.Metadata[field] = strings.Repeat("d", 64)
		case "artifact-pages-publish-pending":
			mismatched.Metadata[field] = "true"
		}
		if _, err := decodeSitePublishState("sre", mismatched, object.Bytes); err == nil {
			t.Errorf("body/header mismatch for %s was accepted", field)
		}
	}
}

func TestDecodeSitePublishStateRejectsOversizeCompressedAndDecompressedState(t *testing.T) {
	// The encoded representation expands beyond the 64 MiB JSON ceiling while
	// staying highly compressible, so this checks the decompression bomb bound.
	tooLargeJSON := []byte(`{"schemaVersion":1,"site":"sre","committed":{"inputRoot":"` + strings.Repeat("b", 64) + `","generation":"` + strings.Repeat("d", 64) + `","objects":[]},"padding":"` + strings.Repeat("x", maxSitePublishStateJSONBytes+1) + `"}`)
	compressed := gzipForTest(t, tooLargeJSON)
	if len(compressed) > maxSitePublishStateGzipBytes {
		t.Fatalf("test gzip unexpectedly exceeds compressed limit: %d", len(compressed))
	}
	info := stateInfoForBytes(compressed, "sre", strings.Repeat("b", 64), strings.Repeat("d", 64))
	if _, err := decodeSitePublishState("sre", info, compressed); err == nil || !strings.Contains(err.Error(), "JSON exceeds") {
		t.Fatalf("decompression limit error = %v", err)
	}
	info.Size = maxSitePublishStateGzipBytes + 1
	if err := validateSitePublishStateHead("sre", info); err == nil {
		t.Fatal("oversize compressed HEAD was accepted")
	}
}

func validSitePublishState() sitePublishState {
	return sitePublishState{
		SchemaVersion: sitePublishStateSchemaVersion,
		Site:          "sre",
		Committed: sitePublishCommitted{
			InputRoot:  strings.Repeat("b", 64),
			Generation: strings.Repeat("d", 64),
			Objects: []sitePublishObject{
				{
					Key: "_artifacts/sre/docs/start.md", SHA256: strings.Repeat("a", 64), Size: 17,
					ContentType: "text/markdown; charset=utf-8", ContentDisposition: "inline", CacheControl: artifactCacheControl,
				},
				{
					Key: "_indexes/sre/index.json", SHA256: strings.Repeat("c", 64), Size: 23,
					ContentType: "application/json; charset=utf-8", ContentDisposition: "inline", CacheControl: indexCacheControl,
				},
			},
		},
	}
}

func objectInfoForState(object Object) ObjectInfo {
	return ObjectInfo{
		ETag: `"state-etag"`, Size: int64(len(object.Bytes)), ContentType: object.ContentType,
		ContentDisposition: "inline", ContentEncoding: object.ContentEncoding, CacheControl: object.Cache,
		Metadata: cloneStringMap(object.Metadata),
	}
}

func cloneStateInfo(info ObjectInfo) ObjectInfo {
	info.Metadata = cloneStringMap(info.Metadata)
	return info
}

func cloneStringMap(input map[string]string) map[string]string {
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func cloneSitePublishState(state sitePublishState) sitePublishState {
	state.Committed.Objects = append([]sitePublishObject(nil), state.Committed.Objects...)
	return state
}

func decodePlainStateForTest(site string, info ObjectInfo, plain []byte) (sitePublishState, error) {
	compressed := gzipForTestBytes(plain)
	info = cloneStateInfo(info)
	info.Size = int64(len(compressed))
	info.Metadata["artifact-pages-sha256"] = sha256Hex(compressed)
	return decodeSitePublishState(site, info, compressed)
}

func decodeCompressedForState(site string, info ObjectInfo, compressed []byte) (sitePublishState, error) {
	info = cloneStateInfo(info)
	info.Size = int64(len(compressed))
	info.Metadata["artifact-pages-sha256"] = sha256Hex(compressed)
	return decodeSitePublishState(site, info, compressed)
}

func stateInfoForBytes(compressed []byte, site, root, generation string) ObjectInfo {
	return ObjectInfo{
		ETag: `"state-etag"`, Size: int64(len(compressed)), ContentType: "application/octet-stream",
		ContentDisposition: "inline", CacheControl: sitePublishStateCacheControl,
		Metadata: map[string]string{
			"artifact-pages-publish-state-schema": "1", "artifact-pages-publish-input-root": root,
			"artifact-pages-publish-generation": generation, "artifact-pages-publish-pending": "false",
			"artifact-pages-sha256": sha256Hex(compressed), "artifact-pages-site": site,
		},
	}
}

func gzipForTest(t *testing.T, plain []byte) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := gzip.NewWriter(&output)
	if _, err := writer.Write(plain); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func gzipForTestBytes(plain []byte) []byte {
	var output bytes.Buffer
	writer := gzip.NewWriter(&output)
	_, _ = writer.Write(plain)
	_ = writer.Close()
	return output.Bytes()
}
