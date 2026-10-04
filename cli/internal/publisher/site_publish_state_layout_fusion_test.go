package publisher

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

const sitePublishStateLayoutFusionEnv = "ARTIFACT_PAGES_STATE_LAYOUT_FUSION"

// This opt-in comparison is a serialized-store prototype. The GET-only and
// fused retry-journal variants are not production adapters or accepted code.
func TestSitePublishStateLayoutFusion(t *testing.T) {
	if os.Getenv(sitePublishStateLayoutFusionEnv) != "1" {
		t.Skip("set ARTIFACT_PAGES_STATE_LAYOUT_FUSION=1 to run the state-layout fusion prototype")
	}
	ctx := context.Background()
	root, err := matrixGitRoot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	provenance, err := fusionReadProvenance(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(root, ".local", "publish-scale-state-layout-fusion", "work")
	if err := os.RemoveAll(work); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(work, 0o700); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(work)
	const site = "verify-layout-fusion"
	fixture := filepath.Join(root, "fixtures", "scale", "sites", "verify-scale-1000", "source")
	profile := matrixCountSource(t, fixture)
	if profile.SourceFiles != 1000 {
		t.Fatalf("fusion fixture has %d source files, want 1000", profile.SourceFiles)
	}
	baseSource := filepath.Join(work, "base", "source")
	if err := copyScaleTree(fixture, baseSource); err != nil {
		t.Fatal(err)
	}
	baseSources, err := matrixReadSources(baseSource)
	if err != nil {
		t.Fatal(err)
	}
	base, err := layoutBuildProjection(ctx, t, root, work, baseSource, site, layoutBuildOptions{FullText: false, Ref: "fusion-fixed"})
	if err != nil {
		t.Fatalf("build baseline projection: %v", err)
	}
	resources := make([]matrixSourceFile, 0)
	for _, source := range baseSources {
		if !extIsPage(strings.ToLower(filepath.Ext(source.RelativePath))) {
			resources = append(resources, source)
		}
	}
	if len(resources) < 2 {
		t.Fatal("fusion fixture needs at least two resources")
	}

	aSource := filepath.Join(work, "a-sparse", "source")
	if err := copyScaleTree(baseSource, aSource); err != nil {
		t.Fatal(err)
	}
	resourceOne := filepath.Join(aSource, filepath.FromSlash(resources[0].RelativePath))
	if err := writeFusionMutation(resourceOne, resources[0].Bytes, "A"); err != nil {
		t.Fatal(err)
	}
	a, err := layoutBuildProjection(ctx, t, root, work, aSource, site, layoutBuildOptions{FullText: false, Ref: "fusion-fixed"})
	if err != nil {
		t.Fatalf("build sparse projection: %v", err)
	}

	bSource := filepath.Join(work, "b-interrupted", "source")
	if err := copyScaleTree(baseSource, bSource); err != nil {
		t.Fatal(err)
	}
	if err := writeFusionMutation(filepath.Join(bSource, filepath.FromSlash(resources[0].RelativePath)), resources[0].Bytes, "B"); err != nil {
		t.Fatal(err)
	}
	addedRelative := "00-fusion-added.css"
	addedPath := filepath.Join(bSource, addedRelative)
	if err := os.WriteFile(addedPath, []byte("/* deterministic added resource */\nbody{--fusion-added:1}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(addedPath, time.Date(2026, 9, 1, 0, 0, 17, 0, time.UTC), time.Date(2026, 9, 1, 0, 0, 17, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	removedPath := filepath.Join(bSource, filepath.FromSlash(resources[1].RelativePath))
	if err := os.Remove(removedPath); err != nil {
		t.Fatal(err)
	}
	b, err := layoutBuildProjection(ctx, t, root, work, bSource, site, layoutBuildOptions{FullText: false, Ref: "fusion-fixed"})
	if err != nil {
		t.Fatalf("build interrupted projection: %v", err)
	}
	if _, err := stateLayoutProjectionDelta(a.Objects, b.Objects); err != nil {
		t.Fatal(err)
	}
	addedKey := "_artifacts/" + site + "/" + addedRelative
	removedKey := "_artifacts/" + site + "/" + resources[1].RelativePath
	if _, exists := b.Objects[addedKey]; !exists {
		t.Fatalf("interrupted projection lacks added key %q", addedKey)
	}
	if _, exists := b.Objects[removedKey]; exists {
		t.Fatalf("interrupted projection still contains removed key %q", removedKey)
	}

	variants := []fusionVariant{
		{Name: "current-head-get-separate-journal"},
		{Name: "get-only-separate-journal", GetOnly: true},
		{Name: "current-head-get-fused-cache-journal", FusedJournal: true},
		{Name: "get-only-fused-cache-journal", GetOnly: true, FusedJournal: true},
	}
	report := fusionReport{SchemaVersion: 2,
		Model:             "serialized state/cache-journal transactions over real Build projections; prototype-only",
		Provenance:        provenance,
		RequestAccounting: "ClassARequests and ClassBRequests count private state/cache-journal control calls only. ProjectionPUT/DELETE and ProjectionWriteBytes are reported separately and excluded from those class totals. DeleteFreeRequests counts cache-journal deletes only.",
		Limitations: []string{
			"Counts cover only state and site cache-retry control objects plus source/index projection writes; registry, preview, build, CDN invalidation and provider latency are excluded.",
			"GET-only reads and decodes the complete state body on no-op. It derives trusted metadata from the same GET response and removes the separate HEAD/GET generation race check.",
			"The prototype uses test-local schema-2 state and journal codecs to compare transaction designs; production uses the separate current schema-1 codec.",
			"Initial committed state and origin objects are preseeded outside per-step counters. The report omits cold bootstrap cost; see the separate state-layout sweep for bootstrap evidence.",
			"The same-projection input-root case changes only the serialized root to isolate generation semantics; it is not a separate Build invocation.",
			"The journal-only interruption is injected after journal PUT; the separate layout's pending-state CAS gates projection writes. Origin/cache failures are model injections; ETag preconditions are local comparisons, not provider-side CAS races or lost-response tests.",
			"Transaction IDs use crypto/rand, so state bytes and IDs are not byte-for-byte repeatable across runs.",
		},
		Fixture: fusionFixtureReport{Site: site, FixtureSite: "verify-scale-1000", SourceFiles: profile.SourceFiles,
			Pages: profile.Pages, Resources: profile.Resources, SourceBytes: stateLayoutSourceBytes(baseSources),
			FixtureSHA256: matrixSourcesDigest(baseSources)},
	}
	sparseTransactionIDs := make(map[string]struct{}, len(variants))
	for _, variant := range variants {
		engine, err := newFusionEngine(site, variant, base)
		if err != nil {
			t.Fatalf("%s seed: %v", variant.Name, err)
		}
		neighborKey := "_artifacts/verify-layout-neighbor/keep.bin"
		neighbor := Object{Bytes: []byte("neighbor preserved"), ContentType: "application/octet-stream",
			Metadata: map[string]string{"artifact-pages-site": "verify-layout-neighbor"}}
		engine.origin[neighborKey] = cloneStateLayoutObject(neighbor)
		variantReport := fusionVariantReport{Name: variant.Name, GetOnly: variant.GetOnly, FusedJournal: variant.FusedJournal}
		step, err := engine.Apply(base, 0)
		if err != nil || step.Outcome != "no-op" {
			t.Fatalf("%s no-op: %+v, %v", variant.Name, step, err)
		}
		variantReport.Steps = append(variantReport.Steps, step)
		step, err = engine.Apply(a, 0)
		if err != nil || step.Outcome != "published" {
			t.Fatalf("%s sparse change: %+v, %v", variant.Name, step, err)
		}
		step.Name = "sparse-change"
		if !equalStateLayoutObjectMaps(siteProjectionObjects(engine.origin, site), a.Objects) {
			t.Fatalf("%s sparse projection differs from fresh Build oracle", variant.Name)
		}
		committedBeforeRetry, err := engine.persistedState()
		if err != nil || committedBeforeRetry.Committed.Generation == fusionInitialGeneration() {
			t.Fatalf("%s sparse publish did not advance the independent generation: state=%+v err=%v", variant.Name, committedBeforeRetry.Committed, err)
		}
		if _, exists := sparseTransactionIDs[committedBeforeRetry.Committed.Generation]; exists {
			t.Fatalf("%s reused a transaction ID for the same projection from an independent engine", variant.Name)
		}
		sparseTransactionIDs[committedBeforeRetry.Committed.Generation] = struct{}{}
		variantReport.Steps = append(variantReport.Steps, step)
		step, err = engine.Apply(b, 1)
		if err == nil || step.Outcome != "interrupted" {
			t.Fatalf("%s interrupted projection: %+v, %v", variant.Name, step, err)
		}
		interruptedTransactionID := step.PendingTransactionID
		if !sitePublishStateHashPattern.MatchString(interruptedTransactionID) || step.PendingBaseGeneration != committedBeforeRetry.Committed.Generation ||
			interruptedTransactionID == committedBeforeRetry.Committed.Generation {
			t.Fatalf("%s interruption did not persist transaction identity and base generation: %+v", variant.Name, step)
		}
		expectedTouched := fusionChangedObjectKeys(a.Objects, b.Objects)
		if !engine.hasDurablePendingTransaction(a.InputRoot) {
			t.Fatalf("%s interruption did not persist touched-key transaction against committed base", variant.Name)
		}
		durableTouched, err := engine.durableTouchedKeys()
		if err != nil {
			t.Fatalf("%s durable pending keys: %v", variant.Name, err)
		}
		if !reflect.DeepEqual(durableTouched, expectedTouched) {
			t.Fatalf("%s durable pending key set differs from Build delta: got %d keys, want %d", variant.Name, len(durableTouched), len(expectedTouched))
		}
		if step.TouchedKeyCount != len(expectedTouched) || step.TouchedKeysSHA256 != fusionTouchedDigest(expectedTouched) {
			t.Fatalf("%s interruption summary does not match Build delta", variant.Name)
		}
		if _, exists := engine.origin[addedKey]; !exists {
			t.Fatalf("%s interruption did not apply the first sorted added key", variant.Name)
		}
		if _, exists := engine.origin[removedKey]; !exists {
			t.Fatalf("%s interruption removed a later key before the injected stop", variant.Name)
		}
		variantReport.Steps = append(variantReport.Steps, step)
		engine = engine.RestartProcess()
		step, err = engine.Apply(a, 0)
		if err != nil || step.Outcome != "published" {
			t.Fatalf("%s reverted retry: %+v, %v", variant.Name, step, err)
		}
		committedAfterRetry, err := engine.persistedState()
		if err != nil || committedAfterRetry.Committed.Generation != interruptedTransactionID {
			t.Fatalf("%s retry did not commit the original transaction ID: state=%+v err=%v", variant.Name, committedAfterRetry.Committed, err)
		}
		if _, exists := engine.origin[addedKey]; exists {
			t.Fatalf("%s revert retry did not remove the partial new key", variant.Name)
		}
		if _, exists := engine.origin[removedKey]; !exists {
			t.Fatalf("%s revert retry did not restore the removed key", variant.Name)
		}
		if err := engine.assertCommittedProjection(a); err != nil {
			t.Fatalf("%s final projection: %v", variant.Name, err)
		}
		if !reflect.DeepEqual(engine.origin[neighborKey], neighbor) {
			t.Fatalf("%s changed neighboring site", variant.Name)
		}
		if len(engine.journalBytes) != 0 {
			t.Fatalf("%s left a cache retry journal after successful invalidation", variant.Name)
		}
		step.Name = "revert-retry"
		if step.TouchedKeyCount != len(expectedTouched) || step.TouchedKeysSHA256 != fusionTouchedDigest(expectedTouched) {
			t.Fatalf("%s revert retry did not converge the persisted touched-key union", variant.Name)
		}
		variantReport.Steps = append(variantReport.Steps, step)
		variantReport.FinalStateBytes = int64(len(engine.state.Bytes))
		variantReport.FinalCacheJournalBytes = int64(len(engine.journalBytes))
		report.Variants = append(report.Variants, variantReport)
	}
	report.FreshTransactionIDsVerified = len(sparseTransactionIDs) == len(variants)
	baseline := report.Variants[0]
	for _, variant := range report.Variants[1:] {
		for index, baselineStep := range baseline.Steps {
			candidateStep := variant.Steps[index]
			if baselineStep.Name != candidateStep.Name || baselineStep.Outcome != candidateStep.Outcome ||
				baselineStep.TouchedKeyCount != candidateStep.TouchedKeyCount || baselineStep.TouchedKeysSHA256 != candidateStep.TouchedKeysSHA256 ||
				baselineStep.ProjectionPuts != candidateStep.ProjectionPuts || baselineStep.ProjectionDeletes != candidateStep.ProjectionDeletes ||
				baselineStep.ProjectionWriteBytes != candidateStep.ProjectionWriteBytes {
				t.Fatalf("%s/%s changed projection work relative to %s", variant.Name, candidateStep.Name, baseline.Name)
			}
			report.Comparisons = append(report.Comparisons, fusionCompare(baseline.Name, baselineStep, variant.Name, candidateStep))
		}
	}
	metadataOnly := a
	metadataOnly.InputRoot = sha256Hex([]byte("fusion metadata-only root update"))
	for _, variant := range variants {
		report.CacheFailureSequences = append(report.CacheFailureSequences,
			runFusionCacheFailureSequence(t, site, variant, base, a, metadataOnly, b))
	}
	cacheBaseline := report.CacheFailureSequences[0]
	for _, sequence := range report.CacheFailureSequences[1:] {
		for index, baselineStep := range cacheBaseline.Steps {
			candidateStep := sequence.Steps[index]
			if baselineStep.Name != candidateStep.Name || baselineStep.Outcome != candidateStep.Outcome ||
				baselineStep.TouchedKeyCount != candidateStep.TouchedKeyCount || baselineStep.TouchedKeysSHA256 != candidateStep.TouchedKeysSHA256 ||
				baselineStep.ProjectionPuts != candidateStep.ProjectionPuts || baselineStep.ProjectionDeletes != candidateStep.ProjectionDeletes ||
				baselineStep.ProjectionWriteBytes != candidateStep.ProjectionWriteBytes {
				t.Fatalf("%s/%s changed cache failure sequence projection work", sequence.Variant, candidateStep.Name)
			}
			report.Comparisons = append(report.Comparisons,
				fusionCompare(cacheBaseline.Variant+"-cache-sequence", baselineStep, sequence.Variant, candidateStep))
		}
	}
	for _, variant := range variants {
		report.JournalOnlyFailureSequences = append(report.JournalOnlyFailureSequences,
			runFusionJournalOnlyFailureSequence(t, site, variant, base, a))
	}
	journalBaseline := report.JournalOnlyFailureSequences[0]
	for _, sequence := range report.JournalOnlyFailureSequences[1:] {
		for index, baselineStep := range journalBaseline.Steps {
			candidateStep := sequence.Steps[index]
			if baselineStep.Name != candidateStep.Name || baselineStep.Outcome != candidateStep.Outcome ||
				baselineStep.TouchedKeyCount != candidateStep.TouchedKeyCount || baselineStep.TouchedKeysSHA256 != candidateStep.TouchedKeysSHA256 ||
				baselineStep.ProjectionPuts != candidateStep.ProjectionPuts || baselineStep.ProjectionDeletes != candidateStep.ProjectionDeletes ||
				baselineStep.ProjectionWriteBytes != candidateStep.ProjectionWriteBytes {
				t.Fatalf("%s/%s changed journal-only failure projection work", sequence.Variant, candidateStep.Name)
			}
			report.Comparisons = append(report.Comparisons,
				fusionCompare(journalBaseline.Variant+"-journal-only-sequence", baselineStep, sequence.Variant, candidateStep))
		}
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(root, ".local", "publish-scale-state-layout-fusion", "fusion.json")
	if err := os.MkdirAll(filepath.Dir(out), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(out, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Logf("SITE_PUBLISH_STATE_LAYOUT_FUSION_JSON=%s", out)
	t.Logf("SITE_PUBLISH_STATE_LAYOUT_FUSION_SUMMARY fixture=%s variants=%d primaryStepsPerVariant=4 cacheFailureSequences=%d stepsPerCacheSequence=5 journalOnlyFailureSequences=%d stepsPerJournalOnlySequence=3",
		report.Fixture.FixtureSite, len(report.Variants), len(report.CacheFailureSequences), len(report.JournalOnlyFailureSequences))
}

type fusionVariant struct {
	Name         string
	GetOnly      bool
	FusedJournal bool
}

type fusionFixtureReport struct {
	Site          string `json:"site"`
	FixtureSite   string `json:"fixtureSite"`
	SourceFiles   int    `json:"sourceFiles"`
	Pages         int    `json:"pages"`
	Resources     int    `json:"resources"`
	SourceBytes   int64  `json:"sourceBytes"`
	FixtureSHA256 string `json:"fixtureSha256"`
}

type fusionReport struct {
	SchemaVersion               int                         `json:"schemaVersion"`
	Model                       string                      `json:"model"`
	FreshTransactionIDsVerified bool                        `json:"freshTransactionIdsVerified"`
	RequestAccounting           string                      `json:"requestAccounting"`
	Provenance                  fusionProvenance            `json:"provenance"`
	Limitations                 []string                    `json:"limitations"`
	Fixture                     fusionFixtureReport         `json:"fixture"`
	Variants                    []fusionVariantReport       `json:"variants"`
	Comparisons                 []fusionComparison          `json:"comparisons"`
	CacheFailureSequences       []fusionCacheSequenceReport `json:"cacheFailureSequences"`
	JournalOnlyFailureSequences []fusionJournalOnlyReport   `json:"journalOnlyFailureSequences"`
}

type fusionProvenance struct {
	SourceRevision string `json:"sourceRevision"`
	HarnessSHA256  string `json:"harnessSha256"`
}

type fusionComparison struct {
	Baseline                    string `json:"baseline"`
	Variant                     string `json:"variant"`
	Step                        string `json:"step"`
	ClassARequestsDelta         int    `json:"classARequestsDelta"`
	ClassBRequestsDelta         int    `json:"classBRequestsDelta"`
	StateReadBytesDelta         int64  `json:"stateReadBytesDelta"`
	StateWriteBytesDelta        int64  `json:"stateWriteBytesDelta"`
	JournalReadBytesDelta       int64  `json:"journalReadBytesDelta"`
	JournalWriteBytesDelta      int64  `json:"journalWriteBytesDelta"`
	ControlWriteBytesDelta      int64  `json:"controlWriteBytesDelta"`
	CacheInvalidatesDelta       int    `json:"cacheInvalidatesDelta"`
	CacheInvalidationFailsDelta int    `json:"cacheInvalidationFailuresDelta"`
	ProjectionPUTDelta          int    `json:"projectionPutDelta"`
	ProjectionDELETEDelta       int    `json:"projectionDeleteDelta"`
	ProjectionWriteBytesDelta   int64  `json:"projectionWriteBytesDelta"`
}

type fusionVariantReport struct {
	Name                   string       `json:"name"`
	GetOnly                bool         `json:"getOnly"`
	FusedJournal           bool         `json:"fusedJournal"`
	Steps                  []fusionStep `json:"steps"`
	FinalStateBytes        int64        `json:"finalStateBytes"`
	FinalCacheJournalBytes int64        `json:"finalCacheJournalBytes"`
}

type fusionCacheSequenceReport struct {
	Variant                   string       `json:"variant"`
	Steps                     []fusionStep `json:"steps"`
	FirstCommittedGeneration  string       `json:"firstCommittedGeneration"`
	MetadataOnlyInputRoot     string       `json:"metadataOnlyInputRoot"`
	GenerationAfterMetadata   string       `json:"generationAfterMetadataOnlyUpdate"`
	SecondCommittedGeneration string       `json:"secondCommittedGeneration"`
	SecondTransactionBase     string       `json:"secondTransactionBaseGeneration"`
	OldCachePathCount         int          `json:"oldCachePathCount"`
	NewCachePathCount         int          `json:"newCachePathCount"`
	OldCachePathsPreserved    bool         `json:"oldCachePathsPreserved"`
}

type fusionJournalOnlyReport struct {
	Variant                          string       `json:"variant"`
	Steps                            []fusionStep `json:"steps"`
	TransactionID                    string       `json:"transactionId"`
	BaseGeneration                   string       `json:"baseGeneration"`
	CommittedGeneration              string       `json:"committedGeneration"`
	MismatchedBaseRejected           bool         `json:"mismatchedBaseRejected"`
	ProjectionUntouchedBeforeRestart bool         `json:"projectionUntouchedBeforeRestart"`
}

type fusionStep struct {
	Name                    string          `json:"name"`
	Outcome                 string          `json:"outcome"`
	Failure                 string          `json:"failure,omitempty"`
	ResumedPreOriginIntent  bool            `json:"resumedPreOriginIntent"`
	TouchedKeyCount         int             `json:"touchedKeyCount"`
	TouchedKeysSHA256       string          `json:"touchedKeysSha256,omitempty"`
	TouchedKeySample        []string        `json:"touchedKeySample,omitempty"`
	PendingKeyCount         int             `json:"pendingKeyCount"`
	PendingTransactionID    string          `json:"pendingTransactionId,omitempty"`
	PendingBaseGeneration   string          `json:"pendingBaseGeneration,omitempty"`
	PendingDesiredInputRoot string          `json:"pendingDesiredInputRoot,omitempty"`
	JournalTransactionID    string          `json:"journalTransactionId,omitempty"`
	JournalBaseGeneration   string          `json:"journalBaseGeneration,omitempty"`
	JournalDesiredInputRoot string          `json:"journalDesiredInputRoot,omitempty"`
	ProjectionPuts          int             `json:"projectionPuts"`
	ProjectionDeletes       int             `json:"projectionDeletes"`
	ProjectionWriteBytes    int64           `json:"projectionWriteBytes"`
	CommittedInputRoot      string          `json:"committedInputRoot"`
	CommittedGeneration     string          `json:"committedGeneration"`
	StateBytes              int64           `json:"stateBytes"`
	CacheJournalBytes       int64           `json:"cacheJournalBytes"`
	StateGetBytes           int64           `json:"stateGetBytes"`
	StatePutBytes           int64           `json:"statePutBytes"`
	JournalGetBytes         int64           `json:"journalGetBytes"`
	JournalPutBytes         int64           `json:"journalPutBytes"`
	Calls                   fusionCallDelta `json:"calls"`
}

type fusionCallDelta struct {
	StateHEAD            int   `json:"stateHead"`
	StateGET             int   `json:"stateGet"`
	JournalGET           int   `json:"journalGet"`
	StatePUT             int   `json:"statePut"`
	JournalPUT           int   `json:"journalPut"`
	JournalDELETE        int   `json:"journalDelete"`
	CacheInvalidates     int   `json:"cacheInvalidates"`
	CacheInvalidateFails int   `json:"cacheInvalidationFailures"`
	ProjectionPUT        int   `json:"projectionPut"`
	ProjectionDELETE     int   `json:"projectionDelete"`
	ClassARequests       int   `json:"classARequests"`
	ClassBRequests       int   `json:"classBRequests"`
	DeleteFreeRequests   int   `json:"deleteFreeRequests"`
	StateReadBytes       int64 `json:"stateReadBytes"`
	StateWriteBytes      int64 `json:"stateWriteBytes"`
	JournalReadBytes     int64 `json:"journalReadBytes"`
	JournalWriteBytes    int64 `json:"journalWriteBytes"`
	ProjectionWriteBytes int64 `json:"projectionWriteBytes"`
}

type fusionCounters struct {
	StateHEAD            int
	StateGET             int
	JournalGET           int
	StatePUT             int
	JournalPUT           int
	JournalDELETE        int
	CacheInvalidates     int
	CacheInvalidateFails int
	ProjectionPUT        int
	ProjectionDELETE     int
	StateReadBytes       int64
	StateWriteBytes      int64
	JournalReadBytes     int64
	JournalWriteBytes    int64
	ProjectionWriteBytes int64
}

type fusionRetryTransaction struct {
	ID               string   `json:"id"`
	BaseGeneration   string   `json:"baseGeneration"`
	DesiredInputRoot string   `json:"desiredInputRoot"`
	TouchedKeys      []string `json:"touchedKeys,omitempty"`
}

type fusionPersistedState struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Site          string               `json:"site"`
	Committed     fusionCommittedState `json:"committed"`
	Pending       *fusionPendingState  `json:"pending,omitempty"`
}

type fusionCommittedState struct {
	InputRoot  string              `json:"inputRoot"`
	Generation string              `json:"generation"`
	Objects    []sitePublishObject `json:"objects"`
}

type fusionPendingState struct {
	ID               string   `json:"id"`
	BaseGeneration   string   `json:"baseGeneration"`
	DesiredInputRoot string   `json:"desiredInputRoot"`
	TouchedKeys      []string `json:"touchedKeys"`
}

func fusionBuildStateObject(site string, state fusionPersistedState) (Object, error) {
	if err := fusionValidatePersistedState(site, state); err != nil {
		return Object{}, err
	}
	plain, err := json.Marshal(state)
	if err != nil {
		return Object{}, err
	}
	if len(plain) > maxSitePublishStateJSONBytes {
		return Object{}, fmt.Errorf("fusion state JSON exceeds %d bytes", maxSitePublishStateJSONBytes)
	}
	var compressed bytes.Buffer
	writer, err := gzip.NewWriterLevel(&compressed, gzip.BestCompression)
	if err != nil {
		return Object{}, err
	}
	writer.Header.ModTime = time.Time{}
	writer.Header.Name = ""
	writer.Header.Comment = ""
	writer.Header.OS = 255
	if _, err := writer.Write(plain); err != nil {
		return Object{}, err
	}
	if err := writer.Close(); err != nil {
		return Object{}, err
	}
	if compressed.Len() > maxSitePublishStateGzipBytes {
		return Object{}, fmt.Errorf("fusion state gzip exceeds %d bytes", maxSitePublishStateGzipBytes)
	}
	pending := "false"
	if state.Pending != nil {
		pending = "true"
	}
	return Object{Bytes: compressed.Bytes(), ContentType: "application/octet-stream", Cache: sitePublishStateCacheControl,
		Metadata: map[string]string{
			"artifact-pages-publish-state-schema": "2",
			"artifact-pages-publish-input-root":   state.Committed.InputRoot,
			"artifact-pages-publish-generation":   state.Committed.Generation,
			"artifact-pages-publish-pending":      pending,
			"artifact-pages-sha256":               sha256Hex(compressed.Bytes()),
			"artifact-pages-site":                 site,
		}}, nil
}

func fusionDecodeState(site string, info ObjectInfo, body []byte) (fusionPersistedState, error) {
	if err := fusionValidateStateHead(site, info); err != nil {
		return fusionPersistedState{}, err
	}
	if int64(len(body)) != info.Size || len(body) > maxSitePublishStateGzipBytes || sha256Hex(body) != info.Metadata["artifact-pages-sha256"] {
		return fusionPersistedState{}, errors.New("fusion state body size or SHA256 does not match HEAD")
	}
	plain, err := decompressSitePublishState(body)
	if err != nil {
		return fusionPersistedState{}, err
	}
	if err := validateNoDuplicateJSONKeys(plain); err != nil {
		return fusionPersistedState{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(plain))
	decoder.DisallowUnknownFields()
	var state fusionPersistedState
	if err := decoder.Decode(&state); err != nil {
		return fusionPersistedState{}, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fusionPersistedState{}, errors.New("fusion state must contain one JSON value")
	}
	if err := fusionValidatePersistedState(site, state); err != nil {
		return fusionPersistedState{}, err
	}
	pending := "false"
	if state.Pending != nil {
		pending = "true"
	}
	if state.Committed.InputRoot != info.Metadata["artifact-pages-publish-input-root"] ||
		state.Committed.Generation != info.Metadata["artifact-pages-publish-generation"] || pending != info.Metadata["artifact-pages-publish-pending"] {
		return fusionPersistedState{}, errors.New("fusion state body does not match HEAD metadata")
	}
	return state, nil
}

func fusionValidateStateHead(site string, info ObjectInfo) error {
	if err := validateStateSite(site); err != nil {
		return err
	}
	if strings.TrimSpace(info.ETag) == "" || info.Size <= 0 || info.Size > maxSitePublishStateGzipBytes ||
		info.ContentType != "application/octet-stream" || info.ContentEncoding != "" || info.CacheControl != sitePublishStateCacheControl ||
		(info.ContentDisposition != "" && info.ContentDisposition != "inline") {
		return errors.New("fusion state HEAD has invalid CAS, size, or HTTP policy")
	}
	if len(info.Metadata) != 6 || info.Metadata["artifact-pages-publish-state-schema"] != "2" || info.Metadata["artifact-pages-site"] != site ||
		!sitePublishStateHashPattern.MatchString(info.Metadata["artifact-pages-sha256"]) ||
		!sitePublishStateHashPattern.MatchString(info.Metadata["artifact-pages-publish-generation"]) ||
		(info.Metadata["artifact-pages-publish-input-root"] != "" && !sitePublishStateHashPattern.MatchString(info.Metadata["artifact-pages-publish-input-root"])) ||
		(info.Metadata["artifact-pages-publish-pending"] != "true" && info.Metadata["artifact-pages-publish-pending"] != "false") {
		return errors.New("fusion state HEAD metadata is incomplete or invalid")
	}
	return nil
}

func fusionValidatePersistedState(site string, state fusionPersistedState) error {
	if state.SchemaVersion != 2 || state.Site != site || !sitePublishStateHashPattern.MatchString(state.Committed.Generation) {
		return errors.New("fusion state schema, site, or committed generation is invalid")
	}
	if !sitePublishStateHashPattern.MatchString(state.Committed.InputRoot) || state.Committed.Objects == nil {
		return errors.New("fusion committed input root or object rows are invalid")
	}
	previous := ""
	for index, row := range state.Committed.Objects {
		if err := validateSitePublishRow(site, row); err != nil {
			return fmt.Errorf("fusion object %d: %w", index, err)
		}
		if index > 0 && row.Key <= previous {
			return errors.New("fusion object rows must be sorted by unique key")
		}
		previous = row.Key
	}
	if state.Pending != nil {
		pending := state.Pending
		transaction := fusionRetryTransaction{ID: pending.ID, BaseGeneration: pending.BaseGeneration,
			DesiredInputRoot: pending.DesiredInputRoot, TouchedKeys: pending.TouchedKeys}
		if pending.BaseGeneration != state.Committed.Generation {
			return errors.New("fusion pending transaction base does not match committed generation")
		}
		if err := fusionValidateTransaction(site, transaction); err != nil {
			return err
		}
	}
	return nil
}

type fusionRetryRecord struct {
	SchemaVersion int                     `json:"schemaVersion"`
	Paths         []string                `json:"paths"`
	Transaction   *fusionRetryTransaction `json:"publishTransaction,omitempty"`
}

type fusionEngine struct {
	site                string
	variant             fusionVariant
	state               Object
	stateETag           string
	journalBytes        []byte
	journalETag         string
	origin              map[string]Object
	oracleCommitted     layoutProjection
	counters            fusionCounters
	failAfterJournalPut bool
}

func newFusionEngine(site string, variant fusionVariant, initial layoutProjection) (*fusionEngine, error) {
	state, err := fusionBuildStateObject(site, fusionPersistedState{SchemaVersion: 2, Site: site,
		Committed: fusionCommittedState{InputRoot: initial.InputRoot, Generation: fusionInitialGeneration(), Objects: initial.Rows}})
	if err != nil {
		return nil, err
	}
	return &fusionEngine{site: site, variant: variant, state: state, stateETag: sha256Hex(state.Bytes),
		origin: cloneStateLayoutObjectMap(initial.Objects), oracleCommitted: initial}, nil
}

func writeFusionMutation(filename string, original []byte, label string) error {
	updated := append(append([]byte(nil), original...), []byte("\n/* FUSION:"+label+" */\n")...)
	if err := os.WriteFile(filename, updated, 0o600); err != nil {
		return err
	}
	mtime := time.Date(2026, 9, 1, 0, 0, 31, 0, time.UTC)
	return os.Chtimes(filename, mtime, mtime)
}

func (engine *fusionEngine) Apply(desired layoutProjection, failAfter int) (fusionStep, error) {
	return engine.ApplyWithFailures(desired, failAfter, false)
}

func (engine *fusionEngine) ApplyWithJournalOnlyFailure(desired layoutProjection) (fusionStep, error) {
	engine.failAfterJournalPut = true
	return engine.Apply(desired, 0)
}

func (engine *fusionEngine) ApplyWithFailures(desired layoutProjection, failAfter int, failCacheInvalidate bool) (fusionStep, error) {
	before := engine.counters
	step := fusionStep{Name: "transition"}
	journal, journalETag, err := engine.readJournal()
	if err != nil {
		return engine.finishStep(step, before, nil, err), err
	}
	state := fusionPersistedState{}
	var stateInfo ObjectInfo
	if engine.variant.GetOnly {
		state, stateInfo, err = engine.getState()
		if err != nil {
			return engine.finishStep(step, before, nil, err), err
		}
	} else {
		stateInfo, err = engine.headState()
		if err != nil {
			return engine.finishStep(step, before, nil, err), err
		}
		stateRoot := stateInfo.Metadata["artifact-pages-publish-input-root"]
		statePending := stateInfo.Metadata["artifact-pages-publish-pending"] == "true"
		stateGeneration := stateInfo.Metadata["artifact-pages-publish-generation"]
		transactionNeedsOrigin := journal.Transaction != nil && stateGeneration != journal.Transaction.ID
		if stateRoot == desired.InputRoot && !statePending && !transactionNeedsOrigin {
			if len(journal.Paths) > 0 {
				return engine.finishCacheRetry(step, before, journal, failCacheInvalidate)
			}
			step.Name, step.Outcome = "no-op", "no-op"
			return engine.finishStep(step, before, nil, nil), nil
		}
		state, stateInfo, err = engine.getState()
		if err != nil {
			return engine.finishStep(step, before, nil, err), err
		}
	}
	pendingKeys := []string{}
	var pendingTransaction *fusionRetryTransaction
	preOriginIntent := false
	if engine.variant.FusedJournal {
		if state.Pending != nil {
			err := errors.New("fused journal layout found a separate state pending row")
			return engine.finishStep(step, before, nil, err), err
		}
		if journal.Transaction != nil {
			switch state.Committed.Generation {
			case journal.Transaction.ID:
				// Origin commit completed; retain only cache invalidation work.
			case journal.Transaction.BaseGeneration:
				pendingTransaction = journal.Transaction
				pendingKeys = append(pendingKeys, journal.Transaction.TouchedKeys...)
			default:
				err := errors.New("fused retry transaction matches neither committed nor pending generation")
				return engine.finishStep(step, before, nil, err), err
			}
		}
	} else {
		if state.Pending != nil {
			if state.Pending.BaseGeneration != state.Committed.Generation {
				err := errors.New("separate pending transaction base does not match committed generation")
				return engine.finishStep(step, before, nil, err), err
			}
			pendingTransaction = &fusionRetryTransaction{ID: state.Pending.ID, BaseGeneration: state.Pending.BaseGeneration,
				DesiredInputRoot: state.Pending.DesiredInputRoot, TouchedKeys: append([]string(nil), state.Pending.TouchedKeys...)}
			if journal.Transaction == nil || journal.Transaction.ID != pendingTransaction.ID ||
				journal.Transaction.BaseGeneration != pendingTransaction.BaseGeneration {
				err := errors.New("separate retry journal marker does not match persisted pending transaction")
				return engine.finishStep(step, before, nil, err), err
			}
			pendingKeys = append(pendingKeys, state.Pending.TouchedKeys...)
		} else if journal.Transaction != nil {
			switch state.Committed.Generation {
			case journal.Transaction.ID:
				// The origin commit is complete; this record only holds cache paths.
			case journal.Transaction.BaseGeneration:
				// Journal PUT is durable but the pending-state CAS has not happened.
				// The protocol gates projection writes on that CAS, so this is safe to resume.
				pendingTransaction = journal.Transaction
				preOriginIntent = true
			default:
				err := errors.New("separate retry marker matches neither committed generation nor pre-origin base")
				return engine.finishStep(step, before, nil, err), err
			}
		}
	}
	step.ResumedPreOriginIntent = preOriginIntent
	if state.Committed.InputRoot == desired.InputRoot && state.Pending == nil && pendingTransaction == nil {
		if len(journal.Paths) > 0 {
			return engine.finishCacheRetry(step, before, journal, failCacheInvalidate)
		}
		step.Name, step.Outcome = "no-op", "no-op"
		return engine.finishStep(step, before, nil, nil), nil
	}
	planned := stateLayoutChangedKeys(state.Committed.Objects, desired.Rows)
	touched := stateLayoutUnionKeys(pendingKeys, planned)
	oracleDelta := fusionChangedObjectKeys(engine.oracleCommitted.Objects, desired.Objects)
	oracleTouched := stateLayoutUnionKeys(pendingKeys, oracleDelta)
	if !reflect.DeepEqual(touched, oracleTouched) {
		err := fmt.Errorf("serialized-state diff %v differs from projection oracle %v", touched, oracleTouched)
		return engine.finishStep(step, before, touched, err), err
	}
	step.TouchedKeyCount = len(touched)
	step.TouchedKeySample = stateLayoutSample(touched, 5)
	step.PendingKeyCount = len(pendingKeys)
	if len(touched) == 0 {
		if state.Committed.InputRoot != desired.InputRoot || state.Pending != nil {
			if err := engine.putState(stateInfo.ETag, fusionPersistedState{SchemaVersion: 2, Site: engine.site,
				Committed: fusionCommittedState{InputRoot: desired.InputRoot, Generation: state.Committed.Generation, Objects: desired.Rows}}); err != nil {
				return engine.finishStep(step, before, touched, err), err
			}
			engine.oracleCommitted = desired
		}
		if len(journal.Paths) > 0 {
			return engine.finishCacheRetry(step, before, journal, failCacheInvalidate)
		}
		step.Name, step.Outcome = "published", "published"
		return engine.finishStep(step, before, touched, nil), nil
	}
	changes := make([]Change, 0, len(touched))
	for _, key := range touched {
		changes = append(changes, Change{Action: "update", Path: key})
	}
	paths := siteCachePaths(engine.site, changes, nil, journal.Paths)
	var tx fusionRetryTransaction
	if pendingTransaction != nil {
		tx = *pendingTransaction
		tx.DesiredInputRoot = desired.InputRoot
		tx.TouchedKeys = append([]string(nil), touched...)
	} else {
		tx, err = fusionNewTransaction(state.Committed.Generation, desired.InputRoot, touched)
		if err != nil {
			return engine.finishStep(step, before, touched, err), err
		}
	}
	if engine.variant.FusedJournal {
		record := fusionRetryRecord{SchemaVersion: 2, Paths: paths, Transaction: &tx}
		if err := engine.putJournal(journalETag, record); err != nil {
			return engine.finishStep(step, before, touched, err), err
		}
		if engine.failAfterJournalPut {
			return engine.stopAfterJournalPut(step, before, touched)
		}
	} else {
		marker := tx
		marker.TouchedKeys = nil
		if err := engine.putJournal(journalETag, fusionRetryRecord{SchemaVersion: 2, Paths: paths, Transaction: &marker}); err != nil {
			return engine.finishStep(step, before, touched, err), err
		}
		if engine.failAfterJournalPut {
			return engine.stopAfterJournalPut(step, before, touched)
		}
		pending := fusionPersistedState{SchemaVersion: 2, Site: engine.site, Committed: state.Committed,
			Pending: &fusionPendingState{ID: tx.ID, BaseGeneration: tx.BaseGeneration, DesiredInputRoot: tx.DesiredInputRoot, TouchedKeys: touched}}
		if err := engine.putState(stateInfo.ETag, pending); err != nil {
			return engine.finishStep(step, before, touched, err), err
		}
		stateInfo = fusionObjectInfo(engine.stateETag, engine.state)
	}
	puts, deletes, writeBytes, err := engine.applyProjection(desired, touched, failAfter)
	step.ProjectionPuts, step.ProjectionDeletes, step.ProjectionWriteBytes = puts, deletes, writeBytes
	if err != nil {
		step.Name, step.Outcome = "interrupted", "interrupted"
		return engine.finishStep(step, before, touched, err), err
	}
	committed := fusionPersistedState{SchemaVersion: 2, Site: engine.site,
		Committed: fusionCommittedState{InputRoot: desired.InputRoot, Generation: tx.ID, Objects: desired.Rows}}
	if err := engine.putState(stateInfo.ETag, committed); err != nil {
		return engine.finishStep(step, before, touched, err), err
	}
	engine.oracleCommitted = desired
	if err := engine.invalidateJournal(paths, failCacheInvalidate); err != nil {
		step.Name, step.Outcome = "cache-invalidation-failed", "cache-invalidation-failed"
		return engine.finishStep(step, before, touched, err), err
	}
	step.Name, step.Outcome = "published", "published"
	return engine.finishStep(step, before, touched, nil), nil
}

func (engine *fusionEngine) stopAfterJournalPut(step fusionStep, before fusionCounters, touched []string) (fusionStep, error) {
	engine.failAfterJournalPut = false
	err := errors.New("injected stop after durable journal PUT and before origin writes")
	step.Name, step.Outcome = "interrupted-before-origin", "interrupted-before-origin"
	return engine.finishStep(step, before, touched, err), err
}

func (engine *fusionEngine) headState() (ObjectInfo, error) {
	engine.counters.StateHEAD++
	info := fusionObjectInfo(engine.stateETag, engine.state)
	if err := fusionValidateStateHead(engine.site, info); err != nil {
		return ObjectInfo{}, err
	}
	return info, nil
}

func (engine *fusionEngine) getState() (fusionPersistedState, ObjectInfo, error) {
	engine.counters.StateGET++
	engine.counters.StateReadBytes += int64(len(engine.state.Bytes))
	info := fusionObjectInfo(engine.stateETag, engine.state)
	state, err := fusionDecodeState(engine.site, info, engine.state.Bytes)
	return state, info, err
}

func fusionObjectInfo(etag string, object Object) ObjectInfo {
	return ObjectInfo{ETag: etag, Size: int64(len(object.Bytes)), ContentType: object.ContentType,
		ContentDisposition: object.ContentDisposition, ContentEncoding: object.ContentEncoding,
		CacheControl: object.Cache, Metadata: cloneObjectMetadata(object.Metadata)}
}

func (engine *fusionEngine) readJournal() (fusionRetryRecord, string, error) {
	engine.counters.JournalGET++
	if len(engine.journalBytes) == 0 {
		return fusionRetryRecord{SchemaVersion: 2, Paths: []string{}}, "", nil
	}
	engine.counters.JournalReadBytes += int64(len(engine.journalBytes))
	if err := validateNoDuplicateJSONKeys(engine.journalBytes); err != nil {
		return fusionRetryRecord{}, "", fmt.Errorf("decode cache retry journal: %w", err)
	}
	var envelope struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if err := json.Unmarshal(engine.journalBytes, &envelope); err != nil {
		return fusionRetryRecord{}, "", err
	}
	var record fusionRetryRecord
	decoder := json.NewDecoder(bytes.NewReader(engine.journalBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&record); err != nil {
		return fusionRetryRecord{}, "", err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fusionRetryRecord{}, "", errors.New("cache retry journal must contain one JSON value")
	}
	if envelope.SchemaVersion != 1 && envelope.SchemaVersion != 2 {
		return fusionRetryRecord{}, "", fmt.Errorf("unsupported cache retry journal schema version %d", envelope.SchemaVersion)
	}
	if record.SchemaVersion != envelope.SchemaVersion || record.Paths == nil || !sort.StringsAreSorted(record.Paths) {
		return fusionRetryRecord{}, "", errors.New("cache retry journal schema or path order is invalid")
	}
	for index, path := range record.Paths {
		if path == "" || (index > 0 && record.Paths[index-1] == path) {
			return fusionRetryRecord{}, "", errors.New("cache retry journal paths must be non-empty and unique")
		}
		decoded, err := url.PathUnescape(path)
		if err != nil || strings.ContainsAny(path, "?#*") || !(strings.HasPrefix(decoded, "/_artifacts/"+engine.site+"/") || strings.HasPrefix(decoded, "/_indexes/"+engine.site+"/")) {
			return fusionRetryRecord{}, "", fmt.Errorf("cache retry journal path %q is outside site scope", path)
		}
	}
	if record.SchemaVersion == 1 && record.Transaction != nil {
		return fusionRetryRecord{}, "", errors.New("schema 1 cache journal cannot contain a publish transaction")
	}
	if record.SchemaVersion == 2 {
		if record.Transaction == nil {
			if len(record.Paths) > 0 {
				return fusionRetryRecord{}, "", errors.New("schema 2 cache journal with paths requires a transaction marker")
			}
		} else if engine.variant.FusedJournal {
			if err := fusionValidateTransaction(engine.site, *record.Transaction); err != nil {
				return fusionRetryRecord{}, "", err
			}
		} else {
			if len(record.Transaction.TouchedKeys) != 0 {
				return fusionRetryRecord{}, "", errors.New("separate retry journal marker must not duplicate touched keys")
			}
			if err := fusionValidateTransactionIdentity(*record.Transaction); err != nil {
				return fusionRetryRecord{}, "", err
			}
		}
	}
	return record, engine.journalETag, nil
}

func (engine *fusionEngine) putJournal(expectedETag string, record fusionRetryRecord) error {
	if expectedETag != engine.journalETag {
		return errors.New("injected cache journal CAS precondition mismatch")
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	engine.counters.JournalPUT++
	engine.counters.JournalWriteBytes += int64(len(encoded))
	engine.journalBytes = append([]byte(nil), encoded...)
	engine.journalETag = sha256Hex(encoded)
	return nil
}

func (engine *fusionEngine) deleteJournal() {
	if len(engine.journalBytes) == 0 {
		return
	}
	engine.counters.JournalDELETE++
	engine.journalBytes = nil
	engine.journalETag = ""
}

func (engine *fusionEngine) putState(expectedETag string, state fusionPersistedState) error {
	if expectedETag != engine.stateETag {
		return errors.New("injected state CAS precondition mismatch")
	}
	object, err := fusionBuildStateObject(engine.site, state)
	if err != nil {
		return err
	}
	engine.counters.StatePUT++
	engine.counters.StateWriteBytes += int64(len(object.Bytes))
	engine.state = object
	engine.stateETag = sha256Hex(object.Bytes)
	return nil
}

func (engine *fusionEngine) applyProjection(desired layoutProjection, touched []string, failAfter int) (puts, deletes int, writtenBytes int64, err error) {
	for index, key := range touched {
		if object, ok := desired.Objects[key]; ok {
			engine.origin[key] = cloneStateLayoutObject(object)
			puts++
			writtenBytes += int64(len(object.Bytes))
			engine.counters.ProjectionPUT++
			engine.counters.ProjectionWriteBytes += int64(len(object.Bytes))
		} else {
			delete(engine.origin, key)
			deletes++
			engine.counters.ProjectionDELETE++
		}
		if failAfter > 0 && index+1 == failAfter {
			return puts, deletes, writtenBytes, fmt.Errorf("injected interruption after %d projected keys", failAfter)
		}
	}
	return puts, deletes, writtenBytes, nil
}

func (engine *fusionEngine) RestartProcess() *fusionEngine {
	return &fusionEngine{site: engine.site, variant: engine.variant, state: cloneStateLayoutObject(engine.state),
		stateETag: engine.stateETag, journalBytes: append([]byte(nil), engine.journalBytes...), journalETag: engine.journalETag,
		origin: cloneStateLayoutObjectMap(engine.origin), oracleCommitted: engine.oracleCommitted,
		counters: engine.counters}
}

func (engine *fusionEngine) persistedState() (fusionPersistedState, error) {
	return fusionDecodeState(engine.site, fusionObjectInfo(engine.stateETag, engine.state), engine.state.Bytes)
}

func (engine *fusionEngine) persistedJournal() (fusionRetryRecord, error) {
	before := engine.counters
	record, _, err := engine.readJournal()
	engine.counters = before
	return record, err
}

func (engine *fusionEngine) hasDurablePendingTransaction(base string) bool {
	state, err := fusionDecodeState(engine.site, fusionObjectInfo(engine.stateETag, engine.state), engine.state.Bytes)
	if err != nil || state.Committed.InputRoot != base {
		return false
	}
	if engine.variant.FusedJournal {
		before := engine.counters
		record, _, err := engine.readJournal()
		engine.counters = before
		return err == nil && record.Transaction != nil && state.Committed.Generation == record.Transaction.BaseGeneration && len(record.Transaction.TouchedKeys) > 0
	}
	return state.Pending != nil && state.Pending.BaseGeneration == state.Committed.Generation && len(state.Pending.TouchedKeys) > 0
}

func (engine *fusionEngine) durableTouchedKeys() ([]string, error) {
	state, err := fusionDecodeState(engine.site, fusionObjectInfo(engine.stateETag, engine.state), engine.state.Bytes)
	if err != nil {
		return nil, err
	}
	if state.Pending != nil {
		return append([]string(nil), state.Pending.TouchedKeys...), nil
	}
	if len(engine.journalBytes) == 0 {
		return nil, errors.New("no durable pending transaction")
	}
	before := engine.counters
	record, _, err := engine.readJournal()
	engine.counters = before
	if err != nil {
		return nil, err
	}
	if record.Transaction == nil {
		return nil, errors.New("cache retry journal has no publish transaction")
	}
	return append([]string(nil), record.Transaction.TouchedKeys...), nil
}

func (engine *fusionEngine) assertCommittedProjection(want layoutProjection) error {
	state, err := fusionDecodeState(engine.site, fusionObjectInfo(engine.stateETag, engine.state), engine.state.Bytes)
	if err != nil {
		return err
	}
	if state.Committed.InputRoot != want.InputRoot || state.Pending != nil || !reflect.DeepEqual(state.Committed.Objects, want.Rows) {
		return errors.New("serialized site state does not match the desired committed projection")
	}
	if !equalStateLayoutObjectMaps(siteProjectionObjects(engine.origin, engine.site), want.Objects) {
		return errors.New("origin source/index objects differ from the fresh Build projection")
	}
	return nil
}

func (engine *fusionEngine) finishCacheRetry(step fusionStep, before fusionCounters, journal fusionRetryRecord, fail bool) (fusionStep, error) {
	if err := engine.invalidateJournal(journal.Paths, fail); err != nil {
		step.Name, step.Outcome = "cache-retry-only", "cache-invalidation-failed"
		return engine.finishStep(step, before, nil, err), err
	}
	step.Name, step.Outcome = "cache-retry-only", "cache-retry-only"
	return engine.finishStep(step, before, nil, nil), nil
}

func (engine *fusionEngine) invalidateJournal(paths []string, fail bool) error {
	if len(paths) == 0 {
		return nil
	}
	engine.counters.CacheInvalidates++
	if fail {
		engine.counters.CacheInvalidateFails++
		return errors.New("injected cache invalidation failure")
	}
	engine.deleteJournal()
	return nil
}

func (engine *fusionEngine) finishStep(step fusionStep, before fusionCounters, touched []string, failure error) fusionStep {
	if failure != nil {
		step.Failure = failure.Error()
	}
	step.StateBytes = int64(len(engine.state.Bytes))
	step.CacheJournalBytes = int64(len(engine.journalBytes))
	state, err := fusionDecodeState(engine.site, fusionObjectInfo(engine.stateETag, engine.state), engine.state.Bytes)
	if err == nil {
		step.CommittedInputRoot = state.Committed.InputRoot
		step.CommittedGeneration = state.Committed.Generation
		if state.Pending != nil {
			step.PendingKeyCount = len(state.Pending.TouchedKeys)
			step.PendingTransactionID = state.Pending.ID
			step.PendingBaseGeneration = state.Pending.BaseGeneration
			step.PendingDesiredInputRoot = state.Pending.DesiredInputRoot
		}
	}
	if len(engine.journalBytes) > 0 {
		beforeCounters := engine.counters
		journal, _, journalErr := engine.readJournal()
		engine.counters = beforeCounters
		if journalErr == nil && journal.Transaction != nil {
			step.JournalTransactionID = journal.Transaction.ID
			step.JournalBaseGeneration = journal.Transaction.BaseGeneration
			step.JournalDesiredInputRoot = journal.Transaction.DesiredInputRoot
			if engine.variant.FusedJournal && step.CommittedGeneration != journal.Transaction.ID {
				if step.PendingKeyCount == 0 {
					step.PendingKeyCount = len(journal.Transaction.TouchedKeys)
				}
				step.PendingTransactionID = journal.Transaction.ID
				step.PendingBaseGeneration = journal.Transaction.BaseGeneration
				step.PendingDesiredInputRoot = journal.Transaction.DesiredInputRoot
			}
		}
	}
	step.Calls = fusionDelta(engine.counters, before)
	step.StateGetBytes = step.Calls.StateReadBytes
	step.StatePutBytes = step.Calls.StateWriteBytes
	step.JournalGetBytes = step.Calls.JournalReadBytes
	step.JournalPutBytes = step.Calls.JournalWriteBytes
	if len(touched) > 0 && step.TouchedKeyCount == 0 {
		step.TouchedKeyCount = len(touched)
		step.TouchedKeySample = stateLayoutSample(touched, 5)
	}
	if len(touched) > 0 {
		step.TouchedKeysSHA256 = fusionTouchedDigest(touched)
	}
	return step
}

func fusionTouchedDigest(touched []string) string {
	canonical := append([]string(nil), touched...)
	sort.Strings(canonical)
	sum := sha256.Sum256([]byte(strings.Join(canonical, "\x00")))
	return hex.EncodeToString(sum[:])
}

func fusionCompare(baselineName string, baseline fusionStep, variantName string, candidate fusionStep) fusionComparison {
	return fusionComparison{Baseline: baselineName, Variant: variantName, Step: candidate.Name,
		ClassARequestsDelta:         candidate.Calls.ClassARequests - baseline.Calls.ClassARequests,
		ClassBRequestsDelta:         candidate.Calls.ClassBRequests - baseline.Calls.ClassBRequests,
		StateReadBytesDelta:         candidate.Calls.StateReadBytes - baseline.Calls.StateReadBytes,
		StateWriteBytesDelta:        candidate.Calls.StateWriteBytes - baseline.Calls.StateWriteBytes,
		JournalReadBytesDelta:       candidate.Calls.JournalReadBytes - baseline.Calls.JournalReadBytes,
		JournalWriteBytesDelta:      candidate.Calls.JournalWriteBytes - baseline.Calls.JournalWriteBytes,
		ControlWriteBytesDelta:      candidate.Calls.StateWriteBytes + candidate.Calls.JournalWriteBytes - baseline.Calls.StateWriteBytes - baseline.Calls.JournalWriteBytes,
		CacheInvalidatesDelta:       candidate.Calls.CacheInvalidates - baseline.Calls.CacheInvalidates,
		CacheInvalidationFailsDelta: candidate.Calls.CacheInvalidateFails - baseline.Calls.CacheInvalidateFails,
		ProjectionPUTDelta:          candidate.Calls.ProjectionPUT - baseline.Calls.ProjectionPUT,
		ProjectionDELETEDelta:       candidate.Calls.ProjectionDELETE - baseline.Calls.ProjectionDELETE,
		ProjectionWriteBytesDelta:   candidate.Calls.ProjectionWriteBytes - baseline.Calls.ProjectionWriteBytes}
}

func fusionDelta(current, before fusionCounters) fusionCallDelta {
	delta := fusionCallDelta{StateHEAD: current.StateHEAD - before.StateHEAD, StateGET: current.StateGET - before.StateGET,
		JournalGET: current.JournalGET - before.JournalGET, StatePUT: current.StatePUT - before.StatePUT,
		JournalPUT: current.JournalPUT - before.JournalPUT, JournalDELETE: current.JournalDELETE - before.JournalDELETE,
		CacheInvalidates: current.CacheInvalidates - before.CacheInvalidates, CacheInvalidateFails: current.CacheInvalidateFails - before.CacheInvalidateFails,
		ProjectionPUT: current.ProjectionPUT - before.ProjectionPUT, ProjectionDELETE: current.ProjectionDELETE - before.ProjectionDELETE,
		StateReadBytes: current.StateReadBytes - before.StateReadBytes, StateWriteBytes: current.StateWriteBytes - before.StateWriteBytes,
		JournalReadBytes: current.JournalReadBytes - before.JournalReadBytes, JournalWriteBytes: current.JournalWriteBytes - before.JournalWriteBytes,
		ProjectionWriteBytes: current.ProjectionWriteBytes - before.ProjectionWriteBytes}
	delta.ClassARequests = delta.StatePUT + delta.JournalPUT
	delta.ClassBRequests = delta.StateHEAD + delta.StateGET + delta.JournalGET
	delta.DeleteFreeRequests = delta.JournalDELETE
	return delta
}

func runFusionCacheFailureSequence(t *testing.T, site string, variant fusionVariant, base, first, metadataOnly, changed layoutProjection) fusionCacheSequenceReport {
	t.Helper()
	engine, err := newFusionEngine(site, variant, base)
	if err != nil {
		t.Fatalf("%s cache-failure sequence seed: %v", variant.Name, err)
	}
	report := fusionCacheSequenceReport{Variant: variant.Name, MetadataOnlyInputRoot: metadataOnly.InputRoot}
	step, err := engine.ApplyWithFailures(first, 0, true)
	if err == nil || step.Outcome != "cache-invalidation-failed" {
		t.Fatalf("%s origin commit/cache failure: %+v, %v", variant.Name, step, err)
	}
	step.Name = "cache-failure-after-origin-commit"
	state, err := engine.persistedState()
	if err != nil {
		t.Fatalf("%s state after cache failure: %v", variant.Name, err)
	}
	if state.Committed.InputRoot != first.InputRoot || state.Pending != nil || state.Committed.Generation == fusionInitialGeneration() {
		t.Fatalf("%s origin did not durably commit before cache failure: %+v", variant.Name, state.Committed)
	}
	report.FirstCommittedGeneration = state.Committed.Generation
	journal, err := engine.persistedJournal()
	if err != nil || len(journal.Paths) == 0 || journal.Transaction == nil || journal.Transaction.ID != state.Committed.Generation {
		t.Fatalf("%s cache-failure journal does not identify committed transaction: %+v err=%v", variant.Name, journal, err)
	}
	if variant.FusedJournal && len(journal.Transaction.TouchedKeys) == 0 {
		t.Fatalf("%s fused journal omitted transaction touched keys", variant.Name)
	}
	if !variant.FusedJournal && len(journal.Transaction.TouchedKeys) != 0 {
		t.Fatalf("%s separate journal duplicated touched keys", variant.Name)
	}
	oldPaths := append([]string(nil), journal.Paths...)
	report.OldCachePathCount = len(oldPaths)
	report.Steps = append(report.Steps, step)

	engine = engine.RestartProcess()
	step, err = engine.ApplyWithFailures(metadataOnly, 0, true)
	if err == nil || step.Outcome != "cache-invalidation-failed" {
		t.Fatalf("%s same-projection metadata update/cache retry: %+v, %v", variant.Name, step, err)
	}
	step.Name = "same-projection-input-root-update"
	state, err = engine.persistedState()
	if err != nil || state.Committed.InputRoot != metadataOnly.InputRoot || state.Committed.Generation != report.FirstCommittedGeneration ||
		state.Pending != nil || !reflect.DeepEqual(state.Committed.Objects, first.Rows) {
		t.Fatalf("%s metadata-only update did not preserve committed generation: state=%+v err=%v", variant.Name, state.Committed, err)
	}
	report.GenerationAfterMetadata = state.Committed.Generation
	journal, err = engine.persistedJournal()
	if err != nil || !reflect.DeepEqual(journal.Paths, oldPaths) || journal.Transaction == nil || journal.Transaction.ID != report.FirstCommittedGeneration {
		t.Fatalf("%s metadata-only update changed completed cache retry: journal=%+v err=%v", variant.Name, journal, err)
	}
	report.Steps = append(report.Steps, step)

	cacheOnlyEngine := engine.RestartProcess()
	step, err = cacheOnlyEngine.Apply(metadataOnly, 0)
	if err != nil || step.Outcome != "cache-retry-only" || step.Calls.ProjectionPUT != 0 || step.Calls.ProjectionDELETE != 0 {
		t.Fatalf("%s changed-root same-projection retry was not cache-only: %+v, %v", variant.Name, step, err)
	}
	step.Name = "same-projection-cache-only-retry"
	state, err = cacheOnlyEngine.persistedState()
	if err != nil || state.Committed.InputRoot != metadataOnly.InputRoot || state.Committed.Generation != report.FirstCommittedGeneration ||
		len(cacheOnlyEngine.journalBytes) != 0 {
		t.Fatalf("%s same-projection cache-only retry changed generation or kept the journal: state=%+v err=%v", variant.Name, state.Committed, err)
	}
	if err := cacheOnlyEngine.assertCommittedProjection(metadataOnly); err != nil {
		t.Fatalf("%s same-projection cache-only retry changed projection: %v", variant.Name, err)
	}
	report.Steps = append(report.Steps, step)

	engine = engine.RestartProcess()
	step, err = engine.ApplyWithFailures(changed, 0, true)
	if err == nil || step.Outcome != "cache-invalidation-failed" {
		t.Fatalf("%s changed-input new transaction/cache failure: %+v, %v", variant.Name, step, err)
	}
	step.Name = "changed-input-new-transaction"
	state, err = engine.persistedState()
	if err != nil || state.Committed.InputRoot != changed.InputRoot || state.Pending != nil || state.Committed.Generation == report.FirstCommittedGeneration {
		t.Fatalf("%s changed input did not commit a fresh generation: state=%+v err=%v", variant.Name, state.Committed, err)
	}
	report.SecondCommittedGeneration = state.Committed.Generation
	report.SecondTransactionBase = report.FirstCommittedGeneration
	journal, err = engine.persistedJournal()
	if err != nil || journal.Transaction == nil || journal.Transaction.ID != state.Committed.Generation ||
		journal.Transaction.BaseGeneration != report.FirstCommittedGeneration || journal.Transaction.DesiredInputRoot != changed.InputRoot {
		t.Fatalf("%s second cache journal does not describe new transaction: journal=%+v err=%v", variant.Name, journal, err)
	}
	if variant.FusedJournal && !reflect.DeepEqual(journal.Transaction.TouchedKeys, fusionChangedObjectKeys(first.Objects, changed.Objects)) {
		t.Fatalf("%s new fused transaction touched set differs from actual projection delta", variant.Name)
	}
	if !variant.FusedJournal && len(journal.Transaction.TouchedKeys) != 0 {
		t.Fatalf("%s second separate journal duplicated touched keys", variant.Name)
	}
	report.NewCachePathCount = len(journal.Paths)
	report.OldCachePathsPreserved = fusionContainsAll(journal.Paths, oldPaths)
	if !report.OldCachePathsPreserved {
		t.Fatalf("%s new transaction lost paths from prior cache retry", variant.Name)
	}
	if err := engine.assertCommittedProjection(changed); err != nil {
		t.Fatalf("%s changed projection after cache failure: %v", variant.Name, err)
	}
	report.Steps = append(report.Steps, step)

	engine = engine.RestartProcess()
	step, err = engine.Apply(changed, 0)
	if err != nil || step.Outcome != "cache-retry-only" || step.Calls.ProjectionPUT != 0 || step.Calls.ProjectionDELETE != 0 {
		t.Fatalf("%s cache-only retry after committed origin: %+v, %v", variant.Name, step, err)
	}
	step.Name = "cache-only-retry-after-commit"
	state, err = engine.persistedState()
	if err != nil || state.Committed.Generation != report.SecondCommittedGeneration || len(engine.journalBytes) != 0 {
		t.Fatalf("%s cache-only retry changed generation or kept the journal: state=%+v err=%v", variant.Name, state.Committed, err)
	}
	if err := engine.assertCommittedProjection(changed); err != nil {
		t.Fatalf("%s final projection after cache retry: %v", variant.Name, err)
	}
	report.Steps = append(report.Steps, step)
	return report
}

func runFusionJournalOnlyFailureSequence(t *testing.T, site string, variant fusionVariant, base, desired layoutProjection) fusionJournalOnlyReport {
	t.Helper()
	engine, err := newFusionEngine(site, variant, base)
	if err != nil {
		t.Fatalf("%s journal-only sequence seed: %v", variant.Name, err)
	}
	initial, err := engine.persistedState()
	if err != nil {
		t.Fatalf("%s initial persisted state: %v", variant.Name, err)
	}
	report := fusionJournalOnlyReport{Variant: variant.Name, BaseGeneration: initial.Committed.Generation}
	step, err := engine.ApplyWithJournalOnlyFailure(desired)
	if err == nil || step.Outcome != "interrupted-before-origin" {
		t.Fatalf("%s journal-only interruption: %+v, %v", variant.Name, step, err)
	}
	step.Name = "journal-put-before-pending-state"
	if step.Calls.StatePUT != 0 || step.Calls.ProjectionPUT != 0 || step.Calls.ProjectionDELETE != 0 {
		t.Fatalf("%s wrote pending state or origin objects before injected stop: %+v", variant.Name, step.Calls)
	}
	state, err := engine.persistedState()
	if err != nil || state.Committed.Generation != initial.Committed.Generation || state.Pending != nil ||
		state.Committed.InputRoot != base.InputRoot {
		t.Fatalf("%s journal-only failure changed committed state: state=%+v err=%v", variant.Name, state.Committed, err)
	}
	if !equalStateLayoutObjectMaps(siteProjectionObjects(engine.origin, site), base.Objects) {
		t.Fatalf("%s journal-only failure wrote origin objects before pending-state CAS", variant.Name)
	}
	report.ProjectionUntouchedBeforeRestart = true
	record, err := engine.persistedJournal()
	if err != nil || record.Transaction == nil || len(record.Paths) == 0 ||
		record.Transaction.BaseGeneration != initial.Committed.Generation || record.Transaction.ID == initial.Committed.Generation {
		t.Fatalf("%s journal-only marker does not preserve a fresh transaction/base: record=%+v err=%v", variant.Name, record, err)
	}
	report.TransactionID = record.Transaction.ID
	if variant.FusedJournal {
		if !reflect.DeepEqual(record.Transaction.TouchedKeys, fusionChangedObjectKeys(base.Objects, desired.Objects)) {
			t.Fatalf("%s fused pre-origin journal omitted touched keys", variant.Name)
		}
	} else if len(record.Transaction.TouchedKeys) != 0 {
		t.Fatalf("%s separate pre-origin marker duplicated pending touched keys", variant.Name)
	}
	report.Steps = append(report.Steps, step)

	bad := engine.RestartProcess()
	badRecord, err := bad.persistedJournal()
	if err != nil || badRecord.Transaction == nil {
		t.Fatalf("%s read marker for fail-closed check: record=%+v err=%v", variant.Name, badRecord, err)
	}
	badRecord.Transaction.BaseGeneration = sha256Hex([]byte("fusion wrong transaction base"))
	encoded, err := json.Marshal(badRecord)
	if err != nil {
		t.Fatal(err)
	}
	bad.journalBytes = encoded
	bad.journalETag = sha256Hex(encoded)
	step, err = bad.Apply(desired, 0)
	if err == nil || !strings.Contains(err.Error(), "matches neither") {
		t.Fatalf("%s accepted mismatched transaction base: %+v, %v", variant.Name, step, err)
	}
	step.Name, step.Outcome = "mismatched-base-rejected", "mismatched-base-rejected"
	if step.Calls.ProjectionPUT != 0 || step.Calls.ProjectionDELETE != 0 || !equalStateLayoutObjectMaps(siteProjectionObjects(bad.origin, site), base.Objects) {
		t.Fatalf("%s mismatch rejection modified origin projection: %+v", variant.Name, step)
	}
	report.MismatchedBaseRejected = true
	report.Steps = append(report.Steps, step)

	engine = engine.RestartProcess()
	step, err = engine.Apply(desired, 0)
	if err != nil || step.Outcome != "published" {
		t.Fatalf("%s cold restart did not resume journal-only intent: %+v, %v", variant.Name, step, err)
	}
	step.Name = "cold-restart-resumed-transaction"
	if step.ResumedPreOriginIntent != !variant.FusedJournal {
		t.Fatalf("%s pre-origin classification mismatch: %+v", variant.Name, step)
	}
	state, err = engine.persistedState()
	if err != nil || state.Committed.Generation != report.TransactionID || state.Committed.InputRoot != desired.InputRoot || state.Pending != nil {
		t.Fatalf("%s resumed transaction did not commit its original ID: state=%+v err=%v", variant.Name, state.Committed, err)
	}
	if len(engine.journalBytes) != 0 {
		t.Fatalf("%s resumed transaction left a cache retry marker", variant.Name)
	}
	if err := engine.assertCommittedProjection(desired); err != nil {
		t.Fatalf("%s resumed projection: %v", variant.Name, err)
	}
	report.CommittedGeneration = state.Committed.Generation
	report.Steps = append(report.Steps, step)
	return report
}

func fusionContainsAll(haystack, needles []string) bool {
	set := make(map[string]struct{}, len(haystack))
	for _, value := range haystack {
		set[value] = struct{}{}
	}
	for _, value := range needles {
		if _, ok := set[value]; !ok {
			return false
		}
	}
	return true
}

func fusionChangedObjectKeys(before, after map[string]Object) []string {
	set := make(map[string]struct{}, len(before)+len(after))
	for key := range before {
		set[key] = struct{}{}
	}
	for key := range after {
		set[key] = struct{}{}
	}
	var changed []string
	for key := range set {
		oldObject, hadOld := before[key]
		newObject, hasNew := after[key]
		if hadOld != hasNew || !reflect.DeepEqual(oldObject, newObject) {
			changed = append(changed, key)
		}
	}
	sort.Strings(changed)
	return changed
}

func fusionInitialGeneration() string {
	return sha256Hex([]byte("artifact-pages-fusion-prototype-initial-generation-v2"))
}

func fusionReadProvenance(ctx context.Context, root string) (fusionProvenance, error) {
	command := exec.CommandContext(ctx, "git", "rev-parse", "HEAD")
	command.Dir = root
	revision, err := command.Output()
	if err != nil {
		return fusionProvenance{}, fmt.Errorf("read source revision: %w", err)
	}
	harness, err := os.ReadFile(filepath.Join(root, "cli", "internal", "publisher", "site_publish_state_layout_fusion_test.go"))
	if err != nil {
		return fusionProvenance{}, fmt.Errorf("read fusion harness for provenance: %w", err)
	}
	return fusionProvenance{SourceRevision: strings.TrimSpace(string(revision)), HarnessSHA256: sha256Hex(harness)}, nil
}

func fusionNewTransaction(base, desiredInputRoot string, touched []string) (fusionRetryTransaction, error) {
	var id [sha256.Size]byte
	if _, err := rand.Read(id[:]); err != nil {
		return fusionRetryTransaction{}, fmt.Errorf("generate fresh fusion transaction ID: %w", err)
	}
	return fusionRetryTransaction{ID: hex.EncodeToString(id[:]), BaseGeneration: base,
		DesiredInputRoot: desiredInputRoot, TouchedKeys: append([]string(nil), touched...)}, nil
}

func fusionValidateTransaction(site string, tx fusionRetryTransaction) error {
	if err := fusionValidateTransactionIdentity(tx); err != nil {
		return err
	}
	if len(tx.TouchedKeys) == 0 || !sort.StringsAreSorted(tx.TouchedKeys) {
		return errors.New("fused retry transaction touched keys are empty or unsorted")
	}
	for index, key := range tx.TouchedKeys {
		if err := validateSitePublishOwnedKey(site, key); err != nil {
			return err
		}
		if index > 0 && tx.TouchedKeys[index-1] == key {
			return errors.New("fused retry transaction contains duplicate touched keys")
		}
	}
	return nil
}

func fusionValidateTransactionIdentity(tx fusionRetryTransaction) error {
	if !sitePublishStateHashPattern.MatchString(tx.ID) || !sitePublishStateHashPattern.MatchString(tx.BaseGeneration) || !sitePublishStateHashPattern.MatchString(tx.DesiredInputRoot) {
		return errors.New("retry transaction contains an invalid ID, base generation, or desired input root")
	}
	return nil
}
