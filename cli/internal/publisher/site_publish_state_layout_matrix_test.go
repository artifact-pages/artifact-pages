package publisher

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/tasuku43/git-artifact-pages/cli/internal/indexer"
)

// This is an opt-in, provider-neutral state-layout model. It uses real
// indexer/publisher desired projections as inputs, then simulates only private
// state objects and common projection deltas. Directory/shard records are
// research prototypes, not deployed adapters.
const (
	sitePublishStateLayoutMatrixEnv       = "ARTIFACT_PAGES_STATE_LAYOUT_MATRIX"
	sitePublishStateLayoutMatrixOutputEnv = "ARTIFACT_PAGES_STATE_LAYOUT_MATRIX_OUTPUT"
	sitePublishStateLayoutSeed            = int64(0x61a7e2026)
	sitePublishStateLayoutPolicyVersion   = "http-policy-v1"
	sitePublishStateLayoutListPageSize    = 1000
)

func TestSitePublishStateLayoutMatrix(t *testing.T) {
	if os.Getenv(sitePublishStateLayoutMatrixEnv) != "1" {
		t.Skip("set ARTIFACT_PAGES_STATE_LAYOUT_MATRIX=1 to run the state-layout model")
	}
	ctx := context.Background()
	root, err := matrixGitRoot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(root, ".local", "publish-scale-state-layout-matrix", "work")
	if err := os.RemoveAll(work); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(work, 0o700); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(work)
	fixtureRoot := filepath.Join(root, "fixtures", "scale", "sites")
	siteID := "verify-layout-1000"
	fixtureSource := filepath.Join(fixtureRoot, "verify-scale-1000", "source")
	profile := matrixCountSource(t, fixtureSource)
	if profile.SourceFiles != 1000 {
		t.Fatalf("1000-file fixture has %d source files", profile.SourceFiles)
	}
	source := filepath.Join(work, "scale-1000", "source")
	if err := copyScaleTree(fixtureSource, source); err != nil {
		t.Fatal(err)
	}
	original, err := matrixReadSources(source)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	report := stateLayoutMatrixReport{
		SchemaVersion: 1, Model: "provider-neutral modeled state transitions; not shipped adapters",
		Seed: sitePublishStateLayoutSeed, PricingSource: "Cloudflare R2 Standard, current docs snapshot",
		PricingURL: "https://developers.cloudflare.com/r2/pricing/",
		Pricing: stateLayoutPricing{ClassAUSDPerMillion: 4.50, ClassBUSDPerMillion: 0.36, StorageUSDPerGBMonth: 0.015,
			FreeClassAMillion: 1, FreeClassBMillion: 10, FreeStorageGBMonth: 10,
			ListPageSize: sitePublishStateLayoutListPageSize, GBBytes: 1_000_000_000,
			MonthlyRuns: 1000, MonthlyMix: "90% no-op, 9% sparse (1% uniform), 1% dense (100%)",
		},
		Datasets: []stateLayoutDataset{{Site: siteID, FixtureSite: "verify-scale-1000", SourceFiles: profile.SourceFiles,
			Pages: profile.Pages, Resources: profile.Resources, SourceBytes: stateLayoutSourceBytes(original),
			FixtureSHA256: matrixSourcesDigest(original)}},
	}
	baseOff, err := layoutBuildProjection(ctx, t, root, work, source, siteID, layoutBuildOptions{FullText: false})
	if err != nil {
		t.Fatal(err)
	}
	baseOn, err := layoutBuildProjection(ctx, t, root, work, source, siteID, layoutBuildOptions{FullText: true})
	if err != nil {
		t.Fatal(err)
	}
	variants := stateLayoutVariants()
	scenarios := []stateLayoutScenario{
		{name: "pure-no-op", kind: "no-op", distribution: "none", fullText: false},
		{name: "resource-only-1-percent", kind: "resource-only", count: 10, distribution: "uniform-scattered", fullText: false},
		{name: "resource-only-10-percent", kind: "resource-only", count: 100, distribution: "uniform-scattered", fullText: false},
		{name: "page-resource-mixed-10-percent", kind: "page-and-resource-mixed", count: 100, distribution: "uniform-scattered", fullText: true},
		{name: "dense-100-percent", kind: "page-and-resource-mixed", count: 1000, distribution: "uniform-scattered", fullText: false},
		{name: "fulltext-off-to-on", kind: "fulltext-toggle", fullText: true},
		{name: "fulltext-on-to-off", kind: "fulltext-toggle", baseFullText: true, fullText: false},
		{name: "fulltext-page-1-percent-uniform", kind: "page-only", count: 10, distribution: "uniform-scattered", baseFullText: true, fullText: true},
		{name: "rename-and-delete", kind: "rename-delete", fullText: false},
	}
	for _, scenario := range scenarios {
		base := baseOff
		if scenario.baseFullText {
			base = baseOn
		}
		if scenario.kind == "no-op" {
			result, err := stateLayoutCompareScenario(t, siteID, scenario, base, base, variants)
			if err != nil {
				t.Fatal(err)
			}
			report.Scenarios = append(report.Scenarios, result)
			continue
		}
		if scenario.kind == "fulltext-toggle" {
			want := baseOn
			if scenario.baseFullText {
				want = baseOff
			}
			result, err := stateLayoutCompareScenario(t, siteID, scenario, base, want, variants)
			if err != nil {
				t.Fatal(err)
			}
			report.Scenarios = append(report.Scenarios, result)
			continue
		}
		if err := stateLayoutRestoreSources(source, original); err != nil {
			t.Fatal(err)
		}
		changedPaths, oldBytes, newBytes, changedTypes, err := stateLayoutMutate(source, original, scenario)
		if err != nil {
			t.Fatalf("mutate %s: %v", scenario.name, err)
		}
		desired, err := layoutBuildProjection(ctx, t, root, work, source, siteID, layoutBuildOptions{FullText: scenario.fullText})
		if err != nil {
			t.Fatalf("build %s desired projection: %v", scenario.name, err)
		}
		result, err := stateLayoutCompareScenario(t, siteID, scenario, base, desired, variants)
		if err != nil {
			t.Fatal(err)
		}
		result.ChangedSourcePaths = len(changedPaths)
		result.ChangedPathSample = stateLayoutSample(changedPaths, 5)
		result.ChangedPages, result.ChangedResources = changedTypes.Pages, changedTypes.Resources
		result.SourceBytesBefore, result.SourceBytesAfter = oldBytes, newBytes
		result.TouchedDirectories = len(matrixTouchedDirectories(changedPaths))
		if scenario.kind == "page-and-resource-mixed" && (changedTypes.Pages == 0 || changedTypes.Resources == 0) {
			t.Fatalf("%s did not mutate both pages and resources: %+v", scenario.name, changedTypes)
		}
		if scenario.kind == "page-and-resource-mixed" && result.Projection.ChangedGeneratedCount == 0 {
			t.Fatalf("%s changed pages but produced no generated index/search delta", scenario.name)
		}
		report.Scenarios = append(report.Scenarios, result)
		if err := stateLayoutRestoreSources(source, original); err != nil {
			t.Fatal(err)
		}
	}
	report.ElapsedMS = durationMS(time.Since(started))
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	out := os.Getenv(sitePublishStateLayoutMatrixOutputEnv)
	if out == "" {
		out = filepath.Join(root, ".local", "publish-scale-state-layout-matrix", "state-layout-matrix.json")
	} else if !filepath.IsAbs(out) {
		out = filepath.Join(root, out)
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(out, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Logf("SITE_PUBLISH_STATE_LAYOUT_MATRIX_JSON=%s", out)
	t.Logf("SITE_PUBLISH_STATE_LAYOUT_MATRIX_SUMMARY site=%s scenarios=%d variants=%d elapsedMs=%.1f", siteID, len(report.Scenarios), len(variants), report.ElapsedMS)
}

func TestSitePublishStateLayoutRecovery(t *testing.T) {
	if os.Getenv(sitePublishStateLayoutMatrixEnv) != "1" {
		t.Skip("set ARTIFACT_PAGES_STATE_LAYOUT_MATRIX=1 to run the state-layout recovery sequence")
	}
	ctx := context.Background()
	root, err := matrixGitRoot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(root, ".local", "publish-scale-state-layout-matrix", "recovery-work")
	if err := os.RemoveAll(work); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(work, 0o700); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(work)
	fixture := filepath.Join(root, "fixtures", "scale", "sites", "verify-scale-10", "source")
	profile := matrixCountSource(t, fixture)
	if profile.SourceFiles != 10 {
		t.Fatalf("recovery fixture has %d source files, want 10", profile.SourceFiles)
	}
	const site = "verify-layout-recovery"
	buildSnapshot := func(name string, spec *matrixScenarioSpec) layoutProjection {
		t.Helper()
		source := filepath.Join(work, name, "source")
		if err := copyScaleTree(fixture, source); err != nil {
			t.Fatal(err)
		}
		if spec != nil {
			original, err := matrixReadSources(source)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, _, _, err := matrixMutateSources(source, original, *spec, 10); err != nil {
				t.Fatalf("mutate %s: %v", name, err)
			}
		}
		projection, err := layoutBuildProjection(ctx, t, root, work, source, site, layoutBuildOptions{FullText: false, Ref: "layout-recovery-fixed"})
		if err != nil {
			t.Fatalf("build %s projection: %v", name, err)
		}
		return projection
	}
	base := buildSnapshot("base", nil)
	a := buildSnapshot("a-resource", &matrixScenarioSpec{Name: "recovery-a", Kind: "resource-only", Count: 1})
	b := buildSnapshot("b-resource", &matrixScenarioSpec{Name: "recovery-b", Kind: "resource-only", Count: 1})
	c := buildSnapshot("c-resource", &matrixScenarioSpec{Name: "recovery-c", Kind: "resource-only", Count: 2})
	cSource := filepath.Join(work, "c-resource", "source")
	dSource := filepath.Join(work, "d-renamed", "source")
	if err := copyScaleTree(cSource, dSource); err != nil {
		t.Fatal(err)
	}
	dSources, err := matrixReadSources(dSource)
	if err != nil {
		t.Fatal(err)
	}
	var oldRelative string
	for _, source := range dSources {
		if strings.HasPrefix(source.RelativePath, "assets/content/css/batch-") {
			oldRelative = source.RelativePath
			break
		}
	}
	if oldRelative == "" {
		t.Fatal("recovery fixture lacks the isolated nested CSS resource")
	}
	oldParent := path.Dir(oldRelative)
	for _, source := range dSources {
		if source.RelativePath != oldRelative && strings.HasPrefix(source.RelativePath, oldParent+"/") {
			t.Fatalf("recovery resource %q does not have an isolated directory subtree", oldRelative)
		}
	}
	newRelative := "00-new/subdir/renamed" + filepath.Ext(oldRelative)
	oldFilename := filepath.Join(dSource, filepath.FromSlash(oldRelative))
	newFilename := filepath.Join(dSource, filepath.FromSlash(newRelative))
	if err := os.MkdirAll(filepath.Dir(newFilename), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(oldFilename, newFilename); err != nil {
		t.Fatal(err)
	}
	d, err := layoutBuildProjection(ctx, t, root, work, dSource, site, layoutBuildOptions{FullText: false, Ref: "layout-recovery-fixed"})
	if err != nil {
		t.Fatalf("build rename projection: %v", err)
	}
	eSource := filepath.Join(work, "e-deleted", "source")
	if err := copyScaleTree(dSource, eSource); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(eSource, filepath.FromSlash(newRelative))); err != nil {
		t.Fatal(err)
	}
	e, err := layoutBuildProjection(ctx, t, root, work, eSource, site, layoutBuildOptions{FullText: false, Ref: "layout-recovery-fixed"})
	if err != nil {
		t.Fatalf("build delete projection: %v", err)
	}
	oldKey := "_artifacts/" + site + "/" + oldRelative
	newKey := "_artifacts/" + site + "/" + newRelative
	variants := stateLayoutVariants()
	neighborKey := "_artifacts/verify-layout-neighbor/keep.bin"
	neighbor := Object{Bytes: []byte("neighbor-preserved"), ContentType: "application/octet-stream", Metadata: map[string]string{"artifact-pages-site": "verify-layout-neighbor"}}
	recovery := stateLayoutRecoveryReport{SchemaVersion: 1, Model: "persistent store pending/retry sequence over real Build projections; prototype-only"}
	for _, variant := range variants {
		sequence, err := newStateLayoutSequence(site, base, variant)
		if err != nil {
			t.Fatalf("%s seed: %v", variant.name, err)
		}
		sequence.origin[neighborKey] = cloneStateLayoutObject(neighbor)
		steps := make([]stateLayoutStepResult, 0, 13)
		assertFailurePending := func(label string) {
			t.Helper()
			if !sequence.store.headPending {
				t.Fatalf("%s/%s did not leave durable pending state", variant.name, label)
			}
			if sequence.store.headInputRoot != sequence.committed.InputRoot {
				t.Fatalf("%s/%s changed committed input root before final CAS", variant.name, label)
			}
			pending, err := sequence.store.pendingTouchedKeys()
			if err != nil || len(pending) == 0 || !sort.StringsAreSorted(pending) {
				t.Fatalf("%s/%s pending touched keys invalid: %v (%v)", variant.name, label, pending, err)
			}
			if err := sequence.store.assertProjectionRows(sequence.committed.Rows); err != nil {
				t.Fatalf("%s/%s changed committed state before final CAS: %v", variant.name, label, err)
			}
		}
		step, err := sequence.Apply(a, stateLayoutFailure{AfterProjectionWrites: 2})
		if err == nil {
			t.Fatalf("%s first attempt unexpectedly succeeded", variant.name)
		}
		if err := sequence.RestartProcess(); err != nil {
			t.Fatalf("%s restart after projection interruption: %v", variant.name, err)
		}
		assertFailurePending("projection interruption")
		steps = append(steps, step)
		step, err = sequence.Apply(a, stateLayoutFailure{})
		if err != nil || !step.StateCommitted {
			t.Fatalf("%s same-source retry failed: result=%+v err=%v", variant.name, step, err)
		}
		steps = append(steps, step)
		secondFailure := stateLayoutFailure{FailFinalCAS: true}
		if variant.layout != "flat" {
			secondFailure = stateLayoutFailure{AfterLeafStatePuts: 1}
		}
		step, err = sequence.Apply(b, secondFailure)
		if err == nil {
			t.Fatalf("%s changed-source attempt unexpectedly succeeded", variant.name)
		}
		if err := sequence.RestartProcess(); err != nil {
			t.Fatalf("%s restart after changed-source interruption: %v", variant.name, err)
		}
		assertFailurePending("changed-source interruption")
		steps = append(steps, step)
		step, err = sequence.Apply(c, stateLayoutFailure{})
		if err != nil || !step.StateCommitted {
			t.Fatalf("%s changed-source retry failed: result=%+v err=%v", variant.name, step, err)
		}
		steps = append(steps, step)
		step, err = sequence.Apply(b, stateLayoutFailure{FailFinalCAS: true})
		if err == nil {
			t.Fatalf("%s final-CAS interruption unexpectedly succeeded", variant.name)
		}
		if err := sequence.RestartProcess(); err != nil {
			t.Fatalf("%s restart after final-CAS interruption: %v", variant.name, err)
		}
		assertFailurePending("final CAS interruption")
		steps = append(steps, step)
		step, err = sequence.Apply(c, stateLayoutFailure{})
		if err != nil || !step.StateCommitted {
			t.Fatalf("%s revert-to-committed retry failed: result=%+v err=%v", variant.name, step, err)
		}
		steps = append(steps, step)
		// A new projection key may already exist after a partial PUT. Reverting to
		// the committed projection must durably DELETE it on the next retry.
		step, err = sequence.Apply(d, stateLayoutFailure{AfterProjectionWrites: 1})
		if err == nil {
			t.Fatalf("%s partial new-key attempt unexpectedly succeeded", variant.name)
		}
		if _, exists := sequence.origin[newKey]; !exists {
			t.Fatalf("%s partial write did not create the new path first", variant.name)
		}
		if _, exists := sequence.origin[oldKey]; !exists {
			t.Fatalf("%s partial write removed the old path before failure", variant.name)
		}
		if variant.layout == "directory-two-slot" {
			gc, gcErr := sequence.GC()
			if gcErr == nil || gc.Calls.Get != 0 || gc.Calls.List != 0 || gc.Calls.Delete != 0 {
				t.Fatalf("%s pending GC was not refused before traversal: report=%+v err=%v", variant.name, gc, gcErr)
			}
		}
		if err := sequence.RestartProcess(); err != nil {
			t.Fatalf("%s restart after new-key interruption: %v", variant.name, err)
		}
		assertFailurePending("new-key interruption")
		steps = append(steps, step)
		step, err = sequence.Apply(c, stateLayoutFailure{})
		if err != nil || !step.StateCommitted {
			t.Fatalf("%s absent-new-key retry failed: result=%+v err=%v", variant.name, step, err)
		}
		if _, exists := sequence.origin[newKey]; exists {
			t.Fatalf("%s retry to absent desired path did not delete the uncertain new key", variant.name)
		}
		if _, exists := sequence.origin[oldKey]; !exists {
			t.Fatalf("%s retry to committed desired path lost the old key", variant.name)
		}
		steps = append(steps, step)

		// Fail after projection DELETE plus a leaf-state write. The removed
		// directory is then recreated by a fresh-process retry to the old state.
		leafFailure := stateLayoutFailure{FailFinalCAS: true}
		if variant.layout == "directory-two-slot" || variant.layout == "fixed-two-slot" || variant.layout == "hybrid-fixed-two-slot" {
			leafFailure = stateLayoutFailure{AfterLeafStatePuts: 1}
		}
		step, err = sequence.Apply(d, leafFailure)
		if err == nil {
			t.Fatalf("%s removed-subtree failure unexpectedly succeeded", variant.name)
		}
		if _, exists := sequence.origin[oldKey]; exists {
			t.Fatalf("%s failure did not remove the old subtree projection", variant.name)
		}
		if _, exists := sequence.origin[newKey]; !exists {
			t.Fatalf("%s failure lost the renamed projection", variant.name)
		}
		if err := sequence.RestartProcess(); err != nil {
			t.Fatalf("%s restart after removed-subtree failure: %v", variant.name, err)
		}
		assertFailurePending("removed-subtree failure")
		steps = append(steps, step)
		step, err = sequence.Apply(c, stateLayoutFailure{})
		if err != nil || !step.StateCommitted {
			t.Fatalf("%s removed-subtree recreation retry failed: result=%+v err=%v", variant.name, step, err)
		}
		if _, exists := sequence.origin[oldKey]; !exists {
			t.Fatalf("%s retry did not recreate the removed directory path", variant.name)
		}
		if _, exists := sequence.origin[newKey]; exists {
			t.Fatalf("%s retry did not delete the renamed path", variant.name)
		}
		steps = append(steps, step)
		step, err = sequence.Apply(d, stateLayoutFailure{})
		if err != nil || !step.StateCommitted {
			t.Fatalf("%s renamed subtree commit failed: result=%+v err=%v", variant.name, step, err)
		}
		steps = append(steps, step)
		step, err = sequence.Apply(e, stateLayoutFailure{FailFinalCAS: true})
		if err == nil {
			t.Fatalf("%s delete final-CAS failure unexpectedly succeeded", variant.name)
		}
		if err := sequence.RestartProcess(); err != nil {
			t.Fatalf("%s restart after delete final-CAS failure: %v", variant.name, err)
		}
		assertFailurePending("delete final-CAS failure")
		steps = append(steps, step)
		step, err = sequence.Apply(d, stateLayoutFailure{})
		if err != nil || !step.StateCommitted {
			t.Fatalf("%s deleted-subtree recreation retry failed: result=%+v err=%v", variant.name, step, err)
		}
		if _, exists := sequence.origin[newKey]; !exists {
			t.Fatalf("%s retry did not recreate the deleted nested path", variant.name)
		}
		steps = append(steps, step)

		var gcReport *stateLayoutGCReport
		if variant.layout == "directory-two-slot" {
			// Add enough abandoned slots to force two wire LIST pages and two
			// DeleteObjects batches at the modeled 1,000-key limit.
			for index := 0; index < sitePublishStateLayoutListPageSize+1; index++ {
				id := fmt.Sprintf("_artifacts/%s/gc-orphan-%04d|", site, index)
				sequence.store.nodes[layoutNodeStorageKey(id, 0)] = []byte("unreachable orphan body")
			}
			gc, gcErr := sequence.GC()
			if gcErr != nil {
				t.Fatalf("%s directory GC failed: %v", variant.name, gcErr)
			}
			if gc.ListPages < 2 || gc.DeleteBatches < 2 || gc.OrphanBytesAfter != 0 || gc.Calls.DeleteKeys < sitePublishStateLayoutListPageSize+1 {
				t.Fatalf("%s GC did not page and remove all orphans: %+v", variant.name, gc)
			}
			gcReport = &gc
		}
		if sequence.store.headPending || sequence.store.headInputRoot != d.InputRoot {
			t.Fatalf("%s final state HEAD is not committed", variant.name)
		}
		if err := sequence.store.assertProjectionRows(d.Rows); err != nil {
			t.Fatalf("%s final rows do not reconstruct: %v", variant.name, err)
		}
		if !equalStateLayoutObjectMaps(siteProjectionObjects(sequence.origin, site), d.Objects) {
			t.Fatalf("%s final origin map differs from desired projection", variant.name)
		}
		if !reflect.DeepEqual(sequence.origin[neighborKey], neighbor) {
			t.Fatalf("%s changed neighboring site object", variant.name)
		}
		recovery.Variants = append(recovery.Variants, stateLayoutRecoveryVariant{Variant: variant.name, Steps: steps,
			GC: gcReport, FinalPersistentBytes: sequence.store.persistentBytes(), RetainedOrphanBytes: sequence.store.orphanBytes()})
	}
	encoded, err := json.MarshalIndent(recovery, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(root, ".local", "publish-scale-state-layout-matrix", "recovery-sequence.json")
	if err := os.MkdirAll(filepath.Dir(out), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(out, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Logf("SITE_PUBLISH_STATE_LAYOUT_RECOVERY_JSON=%s", out)
	t.Logf("SITE_PUBLISH_STATE_LAYOUT_RECOVERY_SUMMARY variants=%d stepsThroughRetry=%d directoryGC=paginated", len(recovery.Variants), len(recovery.Variants[0].Steps))
}

type stateLayoutRecoveryReport struct {
	SchemaVersion int                          `json:"schemaVersion"`
	Model         string                       `json:"model"`
	Variants      []stateLayoutRecoveryVariant `json:"variants"`
}

type stateLayoutRecoveryVariant struct {
	Variant              string                  `json:"variant"`
	Steps                []stateLayoutStepResult `json:"steps"`
	GC                   *stateLayoutGCReport    `json:"directoryGc,omitempty"`
	FinalPersistentBytes int64                   `json:"finalPersistentBytes"`
	RetainedOrphanBytes  int64                   `json:"retainedOrphanBytes"`
}

type stateLayoutPricing struct {
	ClassAUSDPerMillion  float64 `json:"classAUsdPerMillion"`
	ClassBUSDPerMillion  float64 `json:"classBUsdPerMillion"`
	StorageUSDPerGBMonth float64 `json:"storageUsdPerGbMonth"`
	FreeClassAMillion    float64 `json:"freeClassAMillion"`
	FreeClassBMillion    float64 `json:"freeClassBMillion"`
	FreeStorageGBMonth   float64 `json:"freeStorageGbMonth"`
	ListPageSize         int     `json:"listPageSize"`
	GBBytes              int64   `json:"gbBytes"`
	MonthlyRuns          int     `json:"monthlyRuns"`
	MonthlyMix           string  `json:"monthlyMix"`
}

type stateLayoutMatrixReport struct {
	SchemaVersion int                         `json:"schemaVersion"`
	Model         string                      `json:"model"`
	Seed          int64                       `json:"seed"`
	PricingSource string                      `json:"pricingSource"`
	PricingURL    string                      `json:"pricingUrl"`
	Pricing       stateLayoutPricing          `json:"pricing"`
	Datasets      []stateLayoutDataset        `json:"datasets"`
	Scenarios     []stateLayoutScenarioReport `json:"scenarios"`
	ElapsedMS     float64                     `json:"elapsedMs"`
}

type stateLayoutDataset struct {
	Site          string `json:"site"`
	FixtureSite   string `json:"fixtureSite"`
	SourceFiles   int    `json:"sourceFiles"`
	Pages         int    `json:"pages"`
	Resources     int    `json:"resources"`
	SourceBytes   int64  `json:"sourceBytes"`
	FixtureSHA256 string `json:"fixtureSha256"`
}

// stateLayoutBootstrapReport describes the state-body PUTs needed to install
// one committed state from an empty private-state prefix. It is separate from
// transition deltas and excludes common origin projection uploads and legacy
// inventory requests.
type stateLayoutBootstrapReport struct {
	Variant             string                `json:"variant"`
	Layout              string                `json:"layout"`
	Codec               string                `json:"codec"`
	ShardCount          int                   `json:"shardCount,omitempty"`
	FullText            bool                  `json:"fullText"`
	StateCalls          stateLayoutCallCounts `json:"stateCalls"`
	StateBodyWriteBytes int64                 `json:"stateBodyWriteBytes"`
	InstalledObjects    int                   `json:"installedStateObjects"`
	PersistentBytes     int64                 `json:"persistentBytesAfterBootstrap"`
}

type stateLayoutScenario struct {
	name         string
	kind         string
	count        int
	distribution string
	baseFullText bool
	fullText     bool
}

type stateLayoutScenarioReport struct {
	Name               string                      `json:"name"`
	Kind               string                      `json:"kind"`
	SourceFiles        int                         `json:"sourceFiles"`
	GeneratedObjects   int                         `json:"generatedObjects"`
	GeneratedBytes     int64                       `json:"generatedBytes"`
	FullText           bool                        `json:"fullText"`
	Distribution       string                      `json:"distribution"`
	ChangedSourcePaths int                         `json:"changedSourcePaths"`
	ChangedPathSample  []string                    `json:"changedPathSample,omitempty"`
	ChangedPages       int                         `json:"changedPages"`
	ChangedResources   int                         `json:"changedResources"`
	SourceBytesBefore  int64                       `json:"sourceBytesBefore"`
	SourceBytesAfter   int64                       `json:"sourceBytesAfter"`
	TouchedDirectories int                         `json:"touchedDirectories"`
	Projection         stateLayoutProjectionReport `json:"commonProjectionDelta"`
	Variants           []stateLayoutVariantReport  `json:"variants"`
}

type stateLayoutProjectionReport struct {
	Puts                  int   `json:"puts"`
	PutBytes              int64 `json:"putBytes"`
	SourcePuts            int   `json:"sourcePuts"`
	SourcePutBytes        int64 `json:"sourcePutBytes"`
	GeneratedPuts         int   `json:"generatedPuts"`
	GeneratedPutBytes     int64 `json:"generatedPutBytes"`
	Deletes               int   `json:"deleteObjects"`
	ChangedObjectCount    int   `json:"changedObjectCount"`
	ChangedGeneratedCount int   `json:"changedGeneratedObjectCount"`
}

type stateLayoutVariantReport struct {
	Name                  string                `json:"name"`
	Layout                string                `json:"layout"`
	Codec                 string                `json:"codec"`
	ShardCount            int                   `json:"shardCount,omitempty"`
	StateCalls            stateLayoutCallCounts `json:"stateCalls"`
	StateBodyReadBytes    int64                 `json:"stateBodyReadBytes"`
	StateBodyWriteBytes   int64                 `json:"stateBodyWriteBytes"`
	PersistentBytesBefore int64                 `json:"persistentBytesBefore"`
	PersistentBytesAfter  int64                 `json:"persistentBytesAfter"`
	PeakPersistentBytes   int64                 `json:"peakPersistentBytes"`
	RetainedOrphanBytes   int64                 `json:"retainedOrphanBytes"`
	R2                    stateLayoutR2Cost     `json:"r2StandardMarginalCost"`
}

type stateLayoutCallCounts struct {
	Head             int `json:"head"`
	Get              int `json:"get"`
	List             int `json:"list"`
	ListWireRequests int `json:"listWireRequests"`
	Put              int `json:"put"`
	Delete           int `json:"delete"`
	DeleteKeys       int `json:"deleteKeys"`
	CoordinatorPuts  int `json:"coordinatorPuts"`
	LeafGets         int `json:"leafGets"`
	LeafPuts         int `json:"leafPuts"`
}

type stateLayoutR2Cost struct {
	ClassARequests         int     `json:"classARequests"`
	ClassBRequests         int     `json:"classBRequests"`
	DeleteFreeRequests     int     `json:"deleteFreeRequests"`
	StorageGBMonth         float64 `json:"storageGbMonth"`
	UnroundedRequestUSD    float64 `json:"unroundedMarginalRequestUsd"`
	UnroundedStorageUSD    float64 `json:"unroundedMarginalStorageUsd"`
	UnroundedTotalUSD      float64 `json:"unroundedMarginalTotalUsd"`
	MonthlyClassA          int     `json:"monthlyClassA"`
	MonthlyClassB          int     `json:"monthlyClassB"`
	MonthlyClassAOverFree  int     `json:"monthlyClassAOverFree"`
	MonthlyClassBOverFree  int     `json:"monthlyClassBOverFree"`
	MonthlyClassARounded   int     `json:"monthlyClassARoundedBillable"`
	MonthlyClassBRounded   int     `json:"monthlyClassBRoundedBillable"`
	MonthlyStorageGB       float64 `json:"monthlyStorageGb"`
	MonthlyStorageOverFree float64 `json:"monthlyStorageOverFreeGb"`
	MonthlyStorageRounded  float64 `json:"monthlyStorageRoundedBillableGb"`
	MonthlyTotalUSD        float64 `json:"monthlyEstimatedUsd"`
}

type layoutBuildOptions struct {
	FullText      bool
	Title         string
	Description   string
	Repository    string
	RepositoryURL string
	Ref           string
	InputPolicy   string
}

type layoutProjection struct {
	InputRoot       string
	Rows            []sitePublishObject
	Objects         map[string]Object
	PrepareBuildMS  float64
	BuildPreparedMS float64
}

func layoutBuildProjection(ctx context.Context, t *testing.T, root, work, source, site string, options layoutBuildOptions) (layoutProjection, error) {
	t.Helper()
	if options.Title == "" {
		options.Title = "State Layout Verification"
	}
	if options.Description == "" {
		options.Description = "Deterministic state-layout model input"
	}
	if options.Repository == "" {
		options.Repository = "verification/state-layout"
	}
	if options.RepositoryURL == "" {
		options.RepositoryURL = "https://example.invalid/verification/state-layout"
	}
	if options.Ref == "" {
		options.Ref = "layout-base"
	}
	if options.InputPolicy == "" {
		options.InputPolicy = sitePublishInputPolicy
	}
	output, err := os.MkdirTemp(work, "build-output-")
	if err != nil {
		return layoutProjection{}, err
	}
	defer os.RemoveAll(output)
	buildOptions := indexer.BuildOptions{
		SiteID: site, SiteTitle: options.Title, SiteDescription: options.Description,
		SourceDir: source, OutputDir: output, Repository: options.Repository,
		RepositoryURL: options.RepositoryURL, Ref: options.Ref, FullText: options.FullText,
		InputPolicy: options.InputPolicy, RejectSymlinks: true,
		Now: func() time.Time { return time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC) },
	}
	prepareStarted := time.Now()
	prepared, err := indexer.PrepareBuild(ctx, buildOptions)
	prepareMS := durationMS(time.Since(prepareStarted))
	if err != nil {
		return layoutProjection{}, fmt.Errorf("prepare real site projection: %w", err)
	}
	buildStarted := time.Now()
	build, err := indexer.BuildPrepared(ctx, prepared, output)
	buildMS := durationMS(time.Since(buildStarted))
	if err != nil {
		return layoutProjection{}, fmt.Errorf("build real site projection: %w", err)
	}
	desired, err := preparedSiteObjects(prepared, site)
	if err != nil {
		return layoutProjection{}, err
	}
	generated := []struct{ filename, name string }{{build.OutputPath, "index.json"}, {build.MetadataPath, "meta.json"}}
	for _, filename := range build.SearchFiles {
		generated = append(generated, struct{ filename, name string }{filename, "search/" + filepath.Base(filename)})
	}
	for _, item := range generated {
		data, err := os.ReadFile(item.filename)
		if err != nil {
			return layoutProjection{}, err
		}
		contentType, cache := "application/json; charset=utf-8", indexCacheControl
		if strings.HasSuffix(item.name, ".gz") {
			contentType, cache = "application/octet-stream", immutableCache
		}
		key := "_indexes/" + site + "/" + item.name
		desired = append(desired, desiredSiteObject{key: key, relative: item.name, data: data,
			digest: sha256Hex(data), object: Object{ContentType: contentType, ContentDisposition: "inline", Cache: cache,
				Metadata: map[string]string{"artifact-pages-site": site}}})
	}
	rows := rowsFromDesired(desired)
	objects := make(map[string]Object, len(desired))
	for _, item := range desired {
		object := item.object
		object.Bytes = append([]byte(nil), item.data...)
		object.Metadata = cloneObjectMetadata(object.Metadata)
		if object.Metadata == nil {
			object.Metadata = make(map[string]string)
		}
		object.Metadata["artifact-pages-sha256"] = item.digest
		objects[item.key] = object
	}
	return layoutProjection{InputRoot: prepared.InputRoot(), Rows: rows, Objects: objects,
		PrepareBuildMS: prepareMS, BuildPreparedMS: buildMS}, nil
}

func stateLayoutVariants() []stateLayoutVariant {
	return []stateLayoutVariant{
		{name: "flat-explicit-v1", layout: "flat", codec: "named-http-row-v1"},
		{name: "flat-profiled-v1", layout: "flat", codec: "profile-factored-v1"},
		{name: "directory-explicit-v1", layout: "directory-two-slot", codec: "named-http-row-v1"},
		{name: "directory-profiled-v1", layout: "directory-two-slot", codec: "profile-factored-v1"},
		{name: "fixed64-explicit-v1", layout: "fixed-two-slot", codec: "named-http-row-v1", shardCount: 64},
		{name: "fixed64-profiled-v1", layout: "fixed-two-slot", codec: "profile-factored-v1", shardCount: 64},
		{name: "hybrid-fixed64-explicit-v1", layout: "hybrid-fixed-two-slot", codec: "named-http-row-v1", shardCount: 64},
	}
}

type stateLayoutVariant struct {
	name       string
	layout     string
	codec      string
	shardCount int
}

type stateLayoutStore struct {
	site                string
	variant             stateLayoutVariant
	root                []byte
	headETag            string
	headSHA256          string
	headInputRoot       string
	headPending         bool
	headSite            string
	headSchema          int
	headContentType     string
	headEncoding        string
	headCacheControl    string
	flatBody            []byte
	nodes               map[string][]byte
	activeNodes         map[string]layoutNodeRef
	directoryReadCache  map[string]layoutDecodedNode
	shards              map[string][]byte
	activeShards        map[int]layoutShardRef
	shardReadCache      map[string][]sitePublishObject
	latestNodeSlot      map[string]int
	latestShardSlot     map[int]int
	seeding             bool
	failPendingCAS      bool
	failFinalCAS        bool
	failAfterLeafPuts   int
	leafPutsThisAttempt int
	counts              stateLayoutCallCounts
	readBytes           int64
	writeBytes          int64
	peakBytes           int64
	attemptPeakBytes    int64
}

type layoutHTTPPolicy struct {
	ContentType        string `json:"contentType"`
	ContentEncoding    string `json:"contentEncoding"`
	ContentDisposition string `json:"contentDisposition"`
	CacheControl       string `json:"cacheControl"`
}

type layoutPolicyEntry struct {
	Digest string           `json:"digest"`
	Policy layoutHTTPPolicy `json:"policy"`
}

type layoutCompactRow [4]any

// layoutFlatStateV1 preserves the original flat-state experiment locally so
// the verification report remains reproducible without retaining a production
// schema-1 reader.
type layoutFlatStateV1 struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Site          string              `json:"site"`
	Committed     layoutFlatCommitted `json:"committed"`
	Pending       *layoutPending      `json:"pending,omitempty"`
}

type layoutFlatCommitted struct {
	InputRoot string              `json:"inputRoot"`
	Objects   []sitePublishObject `json:"objects"`
}

type layoutPending struct {
	TouchedKeys []string `json:"touchedKeys"`
}

type layoutFlatDecodedState = layoutFlatStateV1

type layoutCompactState struct {
	SchemaVersion int                    `json:"schemaVersion"`
	CodecVersion  int                    `json:"codecVersion"`
	Site          string                 `json:"site"`
	Committed     layoutCompactCommitted `json:"committed"`
	Pending       *layoutPending         `json:"pending,omitempty"`
}

type layoutCompactCommitted struct {
	InputRoot    string              `json:"inputRoot"`
	HTTPProfiles []layoutPolicyEntry `json:"httpProfiles"`
	Objects      []layoutCompactRow  `json:"objects"`
}

type layoutNodeRef struct {
	LogicalHash string `json:"logicalHash"`
	Slot        int    `json:"slot"`
	BodySHA256  string `json:"bodySha256"`
}

type layoutShardRef struct {
	LogicalHash string `json:"logicalHash"`
	Slot        int    `json:"slot"`
	BodySHA256  string `json:"bodySha256"`
}

type layoutCoordinator struct {
	SchemaVersion int                       `json:"schemaVersion"`
	CodecVersion  int                       `json:"codecVersion"`
	Site          string                    `json:"site"`
	Layout        string                    `json:"layout"`
	InputRoot     string                    `json:"inputRoot"`
	Pending       *layoutPending            `json:"pending,omitempty"`
	SourceRoot    *layoutNodeRef            `json:"sourceRoot,omitempty"`
	GeneratedRoot *layoutNodeRef            `json:"generatedRoot,omitempty"`
	Buckets       []layoutCoordinatorBucket `json:"buckets,omitempty"`
	GeneratedRows []layoutEncodedRow        `json:"generatedRows,omitempty"`
}

type layoutCoordinatorBucket struct {
	ID  int            `json:"id"`
	Ref layoutShardRef `json:"ref"`
}

type layoutEncodedRow struct {
	Key                string `json:"key"`
	SHA256             string `json:"sha256"`
	Size               int64  `json:"size"`
	ContentType        string `json:"contentType"`
	ContentEncoding    string `json:"contentEncoding"`
	ContentDisposition string `json:"contentDisposition"`
	CacheControl       string `json:"cacheControl"`
}

type layoutNodeFile struct {
	Name               string `json:"name"`
	SHA256             string `json:"sha256"`
	Size               int64  `json:"size"`
	ContentType        string `json:"contentType,omitempty"`
	ContentEncoding    string `json:"contentEncoding,omitempty"`
	ContentDisposition string `json:"contentDisposition,omitempty"`
	CacheControl       string `json:"cacheControl,omitempty"`
}

type layoutStoredChild struct {
	Name string        `json:"name"`
	Ref  layoutNodeRef `json:"ref"`
}

type layoutStoredNode struct {
	SchemaVersion int                 `json:"schemaVersion"`
	CodecVersion  int                 `json:"codecVersion"`
	NodeID        string              `json:"nodeId"`
	LogicalHash   string              `json:"logicalHash"`
	Files         []layoutNodeFile    `json:"files"`
	CompactFiles  []layoutCompactRow  `json:"compactFiles,omitempty"`
	HTTPProfiles  []layoutPolicyEntry `json:"httpProfiles,omitempty"`
	Children      []layoutStoredChild `json:"children"`
}

type layoutDecodedNode struct {
	Node layoutStoredNode
	Rows []sitePublishObject
}

type layoutLogicalNode struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Files         []layoutEncodedRow   `json:"files"`
	Children      []layoutLogicalChild `json:"children"`
}

type layoutLogicalChild struct {
	Name        string `json:"name"`
	LogicalHash string `json:"logicalHash"`
}

type layoutDesiredNode struct {
	ID       string
	Name     string
	Area     string
	Dir      string
	Files    []layoutEncodedRow
	Children map[string]*layoutDesiredNode
	Hash     string
}

type layoutShardBody struct {
	SchemaVersion int                 `json:"schemaVersion"`
	CodecVersion  int                 `json:"codecVersion"`
	LogicalHash   string              `json:"logicalHash"`
	Objects       []layoutEncodedRow  `json:"objects,omitempty"`
	CompactRows   []layoutCompactRow  `json:"compactRows,omitempty"`
	HTTPProfiles  []layoutPolicyEntry `json:"httpProfiles,omitempty"`
}

type layoutShardLogical struct {
	SchemaVersion int                `json:"schemaVersion"`
	Objects       []layoutEncodedRow `json:"objects"`
}

func stateLayoutTransition(site string, before, after layoutProjection, variant stateLayoutVariant) (stateLayoutVariantReport, error) {
	sequence, err := newStateLayoutSequence(site, before, variant)
	if err != nil {
		return stateLayoutVariantReport{}, err
	}
	step, err := sequence.Apply(after, stateLayoutFailure{})
	if err != nil {
		return step.Report, err
	}
	return step.Report, nil
}

type stateLayoutFailure struct {
	AfterProjectionWrites int
	AfterLeafStatePuts    int
	FailPendingCAS        bool
	FailFinalCAS          bool
}

type stateLayoutStepResult struct {
	Report                     stateLayoutVariantReport `json:"report"`
	AttemptPeakPersistentBytes int64                    `json:"attemptPeakPersistentBytes"`
	PendingTouchedKeys         []string                 `json:"pendingTouchedKeys,omitempty"`
	ProjectionPuts             int                      `json:"projectionPuts"`
	ProjectionDeletes          int                      `json:"projectionDeletes"`
	ProjectionComplete         bool                     `json:"projectionComplete"`
	StateCommitted             bool                     `json:"stateCommitted"`
	Failure                    string                   `json:"failure,omitempty"`
}

type stateLayoutGCReport struct {
	LockAssumption        string                `json:"lockAssumption"`
	Calls                 stateLayoutCallCounts `json:"stateCalls"`
	StateBodyReadBytes    int64                 `json:"stateBodyReadBytes"`
	PersistentBytesBefore int64                 `json:"persistentBytesBefore"`
	PersistentBytesAfter  int64                 `json:"persistentBytesAfter"`
	AttemptPeakBytes      int64                 `json:"attemptPeakPersistentBytes"`
	ListedNodeKeys        int                   `json:"listedNodeKeys"`
	ListPages             int                   `json:"listPages"`
	ActiveNodes           int                   `json:"activeNodes"`
	DeletedKeys           int                   `json:"deletedKeys"`
	DeleteBatches         int                   `json:"deleteBatches"`
	OrphanBytesBefore     int64                 `json:"orphanBytesBefore"`
	OrphanBytesAfter      int64                 `json:"orphanBytesAfter"`
}

type stateLayoutSequence struct {
	store     *stateLayoutStore
	committed layoutProjection
	origin    map[string]Object
}

func newStateLayoutSequence(site string, initial layoutProjection, variant stateLayoutVariant) (*stateLayoutSequence, error) {
	store := &stateLayoutStore{site: site, variant: variant, nodes: make(map[string][]byte), activeNodes: make(map[string]layoutNodeRef),
		directoryReadCache: make(map[string]layoutDecodedNode), shards: make(map[string][]byte), activeShards: make(map[int]layoutShardRef),
		shardReadCache: make(map[string][]sitePublishObject), latestNodeSlot: make(map[string]int), latestShardSlot: make(map[int]int)}
	if err := store.seed(initial); err != nil {
		return nil, err
	}
	store.peakBytes = store.persistentBytes()
	store.attemptPeakBytes = store.peakBytes
	return &stateLayoutSequence{store: store, committed: initial, origin: cloneStateLayoutObjectMap(initial.Objects)}, nil
}

func stateLayoutBootstrap(site string, initial layoutProjection, variant stateLayoutVariant, fullText bool) (stateLayoutBootstrapReport, error) {
	sequence, err := newStateLayoutSequence(site, initial, variant)
	if err != nil {
		return stateLayoutBootstrapReport{}, err
	}
	store := sequence.store
	leafObjects := len(store.nodes) + len(store.shards)
	bytes := store.persistentBytes()
	return stateLayoutBootstrapReport{
		Variant: variant.name, Layout: variant.layout, Codec: variant.codec, ShardCount: variant.shardCount,
		FullText:            fullText,
		StateCalls:          stateLayoutCallCounts{Put: 1 + leafObjects, CoordinatorPuts: 1, LeafPuts: leafObjects},
		StateBodyWriteBytes: bytes, InstalledObjects: 1 + leafObjects, PersistentBytes: bytes,
	}, nil
}

func TestStateLayoutBootstrapAccountsForEveryInstalledStateBody(t *testing.T) {
	const site = "bootstrap-test"
	body := []byte("body { color: black }\n")
	digest := sha256Hex(body)
	key := "_artifacts/" + site + "/assets/site.css"
	row := sitePublishObject{Key: key, SHA256: digest, Size: int64(len(body)), ContentType: "text/css; charset=utf-8",
		ContentDisposition: "inline", CacheControl: artifactCacheControl}
	object := Object{Bytes: append([]byte(nil), body...), ContentType: row.ContentType,
		ContentDisposition: row.ContentDisposition, Cache: row.CacheControl,
		Metadata: map[string]string{"artifact-pages-site": site, "artifact-pages-sha256": digest}}
	projection := layoutProjection{InputRoot: sha256Hex([]byte("bootstrap-input")), Rows: []sitePublishObject{row},
		Objects: map[string]Object{key: object}}
	for _, variant := range stateLayoutSweepVariants() {
		report, err := stateLayoutBootstrap(site, projection, variant, false)
		if err != nil {
			t.Fatalf("%s: %v", variant.name, err)
		}
		if report.StateCalls.Put != report.InstalledObjects || report.StateBodyWriteBytes != report.PersistentBytes || report.StateCalls.Put < 1 {
			t.Errorf("%s bootstrap accounting does not match stored state: %+v", variant.name, report)
		}
		if report.StateCalls.Head != 0 || report.StateCalls.Get != 0 || report.StateCalls.List != 0 || report.StateCalls.Delete != 0 {
			t.Errorf("%s empty-prefix bootstrap unexpectedly read/listed/deleted state: %+v", variant.name, report.StateCalls)
		}
		if variant.layout == "flat" && report.StateCalls.Put != 1 {
			t.Errorf("flat bootstrap PUTs = %d, want single root body", report.StateCalls.Put)
		}
		if variant.layout == "directory-two-slot" && report.StateCalls.LeafPuts == 0 {
			t.Errorf("directory bootstrap did not account for its initial nodes: %+v", report)
		}
		if variant.layout == "fixed-two-slot" && report.StateCalls.LeafPuts == 0 {
			t.Errorf("fixed-shard bootstrap did not account for its initial shards: %+v", report)
		}
	}
}

func (sequence *stateLayoutSequence) Apply(desired layoutProjection, failure stateLayoutFailure) (result stateLayoutStepResult, err error) {
	store := sequence.store
	beforeBytes := store.persistentBytes()
	store.attemptPeakBytes = beforeBytes
	beforeCounts := store.counts
	beforeReadBytes, beforeWriteBytes := store.readBytes, store.writeBytes
	store.directoryReadCache = make(map[string]layoutDecodedNode)
	store.shardReadCache = make(map[string][]sitePublishObject)
	store.failPendingCAS, store.failFinalCAS = failure.FailPendingCAS, failure.FailFinalCAS
	store.failAfterLeafPuts, store.leafPutsThisAttempt = failure.AfterLeafStatePuts, 0
	defer func() {
		store.directoryReadCache = make(map[string]layoutDecodedNode)
		store.shardReadCache = make(map[string][]sitePublishObject)
		store.failPendingCAS, store.failFinalCAS = false, false
		store.failAfterLeafPuts, store.leafPutsThisAttempt = 0, 0
	}()

	store.counts.Head++
	if err := store.validateHeadForTransition(); err != nil {
		return sequence.stepResult(beforeBytes, beforeCounts, beforeReadBytes, beforeWriteBytes, nil, false, false, err), err
	}
	if desired.InputRoot == store.headInputRoot && !store.headPending {
		return sequence.stepResult(beforeBytes, beforeCounts, beforeReadBytes, beforeWriteBytes, nil, true, true, nil), nil
	}
	store.counts.Get++
	store.readBytes += int64(len(store.rootBody()))
	if store.headETag != stateLayoutHash(store.rootBody()) || store.headSHA256 != stateLayoutHash(store.rootBody()) {
		err := fmt.Errorf("state root changed between HEAD and GET")
		return sequence.stepResult(beforeBytes, beforeCounts, beforeReadBytes, beforeWriteBytes, nil, false, false, err), err
	}

	planned, err := store.planTouchedKeys(desired)
	if err != nil {
		return sequence.stepResult(beforeBytes, beforeCounts, beforeReadBytes, beforeWriteBytes, nil, false, false, err), err
	}
	pendingBefore, err := store.pendingTouchedKeys()
	if err != nil {
		return sequence.stepResult(beforeBytes, beforeCounts, beforeReadBytes, beforeWriteBytes, nil, false, false, err), err
	}
	touched := stateLayoutUnionKeys(pendingBefore, planned)
	oracle := stateLayoutUnionKeys(pendingBefore, stateLayoutChangedKeys(sequence.committed.Rows, desired.Rows))
	if !reflect.DeepEqual(touched, oracle) {
		err := fmt.Errorf("serialized %s transition diff disagrees with desired-projection oracle: planned %v, oracle %v", store.variant.name, touched, oracle)
		return sequence.stepResult(beforeBytes, beforeCounts, beforeReadBytes, beforeWriteBytes, touched, false, false, err), err
	}
	if len(touched) > 0 {
		if err := store.writePending(sequence.committed, touched); err != nil {
			return sequence.stepResult(beforeBytes, beforeCounts, beforeReadBytes, beforeWriteBytes, touched, false, false, err), err
		}
	}
	puts, deletes, err := sequence.applyProjection(desired, touched, failure.AfterProjectionWrites)
	if err != nil {
		return sequence.stepResult(beforeBytes, beforeCounts, beforeReadBytes, beforeWriteBytes, touched, false, false, err, puts, deletes), err
	}

	oldActiveNodes := cloneLayoutNodeRefs(store.activeNodes)
	oldActiveShards := cloneLayoutShardRefs(store.activeShards)
	if err := store.writeCommitted(desired); err != nil {
		store.activeNodes, store.activeShards = oldActiveNodes, oldActiveShards
		return sequence.stepResult(beforeBytes, beforeCounts, beforeReadBytes, beforeWriteBytes, touched, true, false, err, puts, deletes), err
	}
	if err := store.assertProjectionRows(desired.Rows); err != nil {
		store.activeNodes, store.activeShards = oldActiveNodes, oldActiveShards
		return sequence.stepResult(beforeBytes, beforeCounts, beforeReadBytes, beforeWriteBytes, touched, true, false, err, puts, deletes), err
	}
	if !equalStateLayoutObjectMaps(siteProjectionObjects(sequence.origin, sequence.store.site), desired.Objects) {
		return sequence.stepResult(beforeBytes, beforeCounts, beforeReadBytes, beforeWriteBytes, touched, false, false, fmt.Errorf("origin projection does not converge to desired map"), puts, deletes), fmt.Errorf("origin projection does not converge to desired map")
	}
	sequence.committed = desired
	return sequence.stepResult(beforeBytes, beforeCounts, beforeReadBytes, beforeWriteBytes, touched, true, true, nil, puts, deletes), nil
}

func (sequence *stateLayoutSequence) GC() (stateLayoutGCReport, error) {
	store := sequence.store
	if store.variant.layout != "directory-two-slot" {
		return stateLayoutGCReport{}, fmt.Errorf("orphan GC is only required for recursive directory state")
	}
	beforeBytes := store.persistentBytes()
	store.attemptPeakBytes = beforeBytes
	beforeCounts, beforeReadBytes := store.counts, store.readBytes
	report := stateLayoutGCReport{LockAssumption: "caller holds the exclusive site publish lock", PersistentBytesBefore: beforeBytes,
		OrphanBytesBefore: store.orphanBytes()}
	finish := func(err error) (stateLayoutGCReport, error) {
		report.Calls = stateLayoutCallCountsDelta(store.counts, beforeCounts)
		report.StateBodyReadBytes = store.readBytes - beforeReadBytes
		report.PersistentBytesAfter = store.persistentBytes()
		report.AttemptPeakBytes = store.attemptPeakBytes
		report.OrphanBytesAfter = store.orphanBytes()
		return report, err
	}
	store.counts.Head++
	if err := store.validateHeadForTransition(); err != nil {
		return finish(err)
	}
	if store.headPending {
		return finish(fmt.Errorf("orphan GC is forbidden while publish state is pending"))
	}
	store.counts.Get++
	store.readBytes += int64(len(store.rootBody()))
	if store.headETag != stateLayoutHash(store.rootBody()) || store.headSHA256 != stateLayoutHash(store.rootBody()) {
		return finish(fmt.Errorf("state root changed between GC HEAD and GET"))
	}
	coordinator, err := store.readRootCoordinator()
	if err != nil {
		return finish(err)
	}
	store.activeNodes = make(map[string]layoutNodeRef)
	store.directoryReadCache = make(map[string]layoutDecodedNode)
	seen := make(map[string]struct{})
	var liveRows []sitePublishObject
	if coordinator.SourceRoot != nil {
		rows, err := store.walkDirectoryForGC("_artifacts/"+store.site+"/|", *coordinator.SourceRoot, seen)
		if err != nil {
			return finish(err)
		}
		liveRows = append(liveRows, rows...)
	}
	if coordinator.GeneratedRoot != nil {
		rows, err := store.walkDirectoryForGC("_indexes/"+store.site+"/|", *coordinator.GeneratedRoot, seen)
		if err != nil {
			return finish(err)
		}
		liveRows = append(liveRows, rows...)
	}
	if !reflect.DeepEqual(sortedSiteRows(liveRows), sequence.committed.Rows) {
		return finish(fmt.Errorf("GC traversal does not reconstruct committed rows"))
	}
	prefix := fmt.Sprintf("_control/publish-state/%s/nodes/", store.site)
	listed := make([]string, 0, len(store.nodes))
	for key := range store.nodes {
		if strings.HasPrefix(key, prefix) {
			listed = append(listed, key)
		}
	}
	sort.Strings(listed)
	report.ListedNodeKeys = len(listed)
	report.ListPages = (len(listed) + sitePublishStateLayoutListPageSize - 1) / sitePublishStateLayoutListPageSize
	if report.ListPages == 0 {
		report.ListPages = 1
	}
	store.counts.List++
	store.counts.ListWireRequests += report.ListPages
	liveKeys := make(map[string]struct{}, len(store.activeNodes))
	for id, ref := range store.activeNodes {
		liveKeys[layoutNodeStorageKey(id, ref.Slot)] = struct{}{}
	}
	var remove []string
	for _, key := range listed {
		if _, ok := liveKeys[key]; !ok {
			remove = append(remove, key)
		}
	}
	for start := 0; start < len(remove); start += sitePublishStateLayoutListPageSize {
		end := start + sitePublishStateLayoutListPageSize
		if end > len(remove) {
			end = len(remove)
		}
		batch := remove[start:end]
		store.counts.Delete++
		store.counts.DeleteKeys += len(batch)
		for _, key := range batch {
			delete(store.nodes, key)
		}
	}
	report.ActiveNodes = len(store.activeNodes)
	report.DeletedKeys = len(remove)
	report.DeleteBatches = store.counts.Delete - beforeCounts.Delete
	for id, slot := range store.latestNodeSlot {
		if _, exists := store.nodes[layoutNodeStorageKey(id, slot)]; !exists {
			if ref, active := store.activeNodes[id]; active {
				store.latestNodeSlot[id] = ref.Slot
			} else {
				delete(store.latestNodeSlot, id)
			}
		}
	}
	if err := store.assertProjectionRows(sequence.committed.Rows); err != nil {
		return finish(err)
	}
	return finish(nil)
}

func (store *stateLayoutStore) walkDirectoryForGC(nodeID string, ref layoutNodeRef, seen map[string]struct{}) ([]sitePublishObject, error) {
	storageKey := layoutNodeStorageKey(nodeID, ref.Slot)
	if _, ok := seen[storageKey]; ok {
		return nil, fmt.Errorf("directory state contains a cycle or duplicate reference at %s", nodeID)
	}
	seen[storageKey] = struct{}{}
	node, rows, err := store.loadDirectoryNode(nodeID, ref)
	if err != nil {
		return nil, fmt.Errorf("GC read node %s: %w", nodeID, err)
	}
	store.activeNodes[nodeID] = ref
	all := append([]sitePublishObject(nil), rows...)
	for _, child := range node.Children {
		part, err := store.walkDirectoryForGC(layoutChildID(nodeID, child.Name), child.Ref, seen)
		if err != nil {
			return nil, err
		}
		all = append(all, part...)
	}
	return all, nil
}

func sortedSiteRows(rows []sitePublishObject) []sitePublishObject {
	result := append([]sitePublishObject(nil), rows...)
	sort.Slice(result, func(i, j int) bool { return result[i].Key < result[j].Key })
	return result
}

func (sequence *stateLayoutSequence) applyProjection(desired layoutProjection, touched []string, failAfter int) (puts, deletes int, err error) {
	for index, key := range touched {
		if object, ok := desired.Objects[key]; ok {
			sequence.origin[key] = cloneStateLayoutObject(object)
			puts++
		} else {
			delete(sequence.origin, key)
			deletes++
		}
		if failAfter > 0 && index+1 == failAfter {
			return puts, deletes, fmt.Errorf("injected projection interruption after %d touched keys", failAfter)
		}
	}
	return puts, deletes, nil
}

func (sequence *stateLayoutSequence) RestartProcess() error {
	old := sequence.store
	fresh := &stateLayoutStore{site: old.site, variant: old.variant, root: append([]byte(nil), old.root...),
		headETag: old.headETag, headSHA256: old.headSHA256, headInputRoot: old.headInputRoot, headPending: old.headPending,
		headSite: old.headSite, headSchema: old.headSchema, headContentType: old.headContentType, headEncoding: old.headEncoding,
		headCacheControl: old.headCacheControl, flatBody: append([]byte(nil), old.flatBody...), nodes: cloneLayoutByteMap(old.nodes),
		activeNodes: make(map[string]layoutNodeRef), directoryReadCache: make(map[string]layoutDecodedNode),
		shards: cloneLayoutByteMap(old.shards), activeShards: make(map[int]layoutShardRef),
		shardReadCache: make(map[string][]sitePublishObject), latestNodeSlot: make(map[string]int), latestShardSlot: make(map[int]int),
		counts: old.counts, readBytes: old.readBytes, writeBytes: old.writeBytes, peakBytes: old.peakBytes}
	sequence.store = fresh
	if fresh.variant.layout == "directory-two-slot" {
		if err := fresh.refreshActiveNodesFromRoot(); err != nil {
			return err
		}
		for id, ref := range fresh.activeNodes {
			fresh.latestNodeSlot[id] = ref.Slot
		}
	} else if fresh.variant.layout == "fixed-two-slot" || fresh.variant.layout == "hybrid-fixed-two-slot" {
		coordinator, err := fresh.readRootCoordinator()
		if err != nil {
			return err
		}
		for _, bucket := range coordinator.Buckets {
			fresh.activeShards[bucket.ID] = bucket.Ref
			fresh.latestShardSlot[bucket.ID] = bucket.Ref.Slot
		}
	}
	return nil
}

func cloneLayoutByteMap(source map[string][]byte) map[string][]byte {
	result := make(map[string][]byte, len(source))
	for key, value := range source {
		result[key] = append([]byte(nil), value...)
	}
	return result
}

func (sequence *stateLayoutSequence) stepResult(beforeBytes int64, beforeCounts stateLayoutCallCounts, beforeRead, beforeWrite int64,
	touched []string, projectionComplete, committed bool, failure error, projectionCounts ...int) stateLayoutStepResult {
	puts, deletes := 0, 0
	if len(projectionCounts) > 0 {
		puts = projectionCounts[0]
	}
	if len(projectionCounts) > 1 {
		deletes = projectionCounts[1]
	}
	store := sequence.store
	afterBytes := store.persistentBytes()
	report := store.report(beforeBytes, afterBytes)
	report.StateCalls = stateLayoutCallCountsDelta(store.counts, beforeCounts)
	report.StateBodyReadBytes = store.readBytes - beforeRead
	report.StateBodyWriteBytes = store.writeBytes - beforeWrite
	report.PersistentBytesBefore, report.PersistentBytesAfter = beforeBytes, afterBytes
	if store.peakBytes > report.PeakPersistentBytes {
		report.PeakPersistentBytes = store.peakBytes
	}
	result := stateLayoutStepResult{Report: report, AttemptPeakPersistentBytes: store.attemptPeakBytes, PendingTouchedKeys: append([]string(nil), touched...),
		ProjectionPuts: puts, ProjectionDeletes: deletes, ProjectionComplete: projectionComplete, StateCommitted: committed}
	if failure != nil {
		result.Failure = failure.Error()
	}
	return result
}

func stateLayoutCallCountsDelta(current, previous stateLayoutCallCounts) stateLayoutCallCounts {
	return stateLayoutCallCounts{Head: current.Head - previous.Head, Get: current.Get - previous.Get, List: current.List - previous.List,
		ListWireRequests: current.ListWireRequests - previous.ListWireRequests, Put: current.Put - previous.Put, Delete: current.Delete - previous.Delete,
		DeleteKeys: current.DeleteKeys - previous.DeleteKeys, CoordinatorPuts: current.CoordinatorPuts - previous.CoordinatorPuts, LeafGets: current.LeafGets - previous.LeafGets,
		LeafPuts: current.LeafPuts - previous.LeafPuts}
}

func stateLayoutUnionKeys(groups ...[]string) []string {
	set := make(map[string]struct{})
	for _, group := range groups {
		for _, key := range group {
			set[key] = struct{}{}
		}
	}
	return sortedSet(set)
}

func isSortedSubset(subset, superset []string) bool {
	if !sort.StringsAreSorted(subset) || !sort.StringsAreSorted(superset) {
		return false
	}
	set := make(map[string]struct{}, len(superset))
	for _, value := range superset {
		set[value] = struct{}{}
	}
	for _, value := range subset {
		if _, ok := set[value]; !ok {
			return false
		}
	}
	return true
}

func cloneStateLayoutObjectMap(source map[string]Object) map[string]Object {
	result := make(map[string]Object, len(source))
	for key, object := range source {
		result[key] = cloneStateLayoutObject(object)
	}
	return result
}

func cloneLayoutNodeRefs(source map[string]layoutNodeRef) map[string]layoutNodeRef {
	result := make(map[string]layoutNodeRef, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func cloneLayoutShardRefs(source map[int]layoutShardRef) map[int]layoutShardRef {
	result := make(map[int]layoutShardRef, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func cloneStateLayoutObject(object Object) Object {
	copyObject := object
	copyObject.Bytes = append([]byte(nil), object.Bytes...)
	if object.Metadata != nil {
		copyObject.Metadata = make(map[string]string, len(object.Metadata))
		for key, value := range object.Metadata {
			copyObject.Metadata[key] = value
		}
	}
	return copyObject
}

func equalStateLayoutObjectMaps(left, right map[string]Object) bool {
	if len(left) != len(right) {
		return false
	}
	for key, expected := range right {
		actual, ok := left[key]
		if !ok || !reflect.DeepEqual(actual, expected) {
			return false
		}
	}
	return true
}

func siteProjectionObjects(objects map[string]Object, site string) map[string]Object {
	result := make(map[string]Object)
	for key, object := range objects {
		if strings.HasPrefix(key, "_artifacts/"+site+"/") || strings.HasPrefix(key, "_indexes/"+site+"/") {
			result[key] = object
		}
	}
	return result
}

func (store *stateLayoutStore) seed(projection layoutProjection) error {
	store.seeding = true
	defer func() { store.seeding = false }()
	switch store.variant.layout {
	case "flat":
		body, err := store.encodeFlat(projection.InputRoot, projection.Rows, nil)
		if err != nil {
			return err
		}
		store.flatBody, store.root = body, body
	case "directory-two-slot":
		source, generated := layoutBuildDirectoryTrees(projection.Rows, store.site)
		sourceRef, err := store.seedDirectory(source)
		if err != nil {
			return err
		}
		generatedRef, err := store.seedDirectory(generated)
		if err != nil {
			return err
		}
		store.root, err = store.encodeCoordinator(projection.InputRoot, nil, sourceRef, generatedRef, nil, nil)
		if err != nil {
			return err
		}
	case "fixed-two-slot", "hybrid-fixed-two-slot":
		refs, generated, err := store.seedShards(projection.Rows)
		if err != nil {
			return err
		}
		store.root, err = store.encodeCoordinator(projection.InputRoot, nil, nil, nil, refs, generated)
		if err != nil {
			return err
		}
	default:
		return fmt.Errorf("unknown layout %q", store.variant.layout)
	}
	store.setRoot(store.root, projection.InputRoot, false)
	if err := store.assertProjectionRows(projection.Rows); err != nil {
		return err
	}
	return nil
}

func (store *stateLayoutStore) planTouchedKeys(after layoutProjection) ([]string, error) {
	switch store.variant.layout {
	case "flat":
		committed, err := store.decodeProjectionRows()
		if err != nil {
			return nil, err
		}
		return stateLayoutChangedKeys(committed, after.Rows), nil
	case "directory-two-slot":
		coordinator, err := store.readRootCoordinator()
		if err != nil {
			return nil, err
		}
		source, generated := layoutBuildDirectoryTrees(after.Rows, store.site)
		var oldRows, desiredRows []sitePublishObject
		if err := store.planDirectoryNode(source.ID, source, coordinator.SourceRoot, &oldRows, &desiredRows); err != nil {
			return nil, err
		}
		if err := store.planDirectoryNode(generated.ID, generated, coordinator.GeneratedRoot, &oldRows, &desiredRows); err != nil {
			return nil, err
		}
		return stateLayoutChangedKeys(oldRows, desiredRows), nil
	case "fixed-two-slot", "hybrid-fixed-two-slot":
		coordinator, err := store.readRootCoordinator()
		if err != nil {
			return nil, err
		}
		buckets, generated := store.layoutBuckets(after.Rows)
		oldRefs := make(map[int]layoutShardRef, len(coordinator.Buckets))
		for _, bucket := range coordinator.Buckets {
			oldRefs[bucket.ID] = bucket.Ref
		}
		idsSet := make(map[int]struct{}, len(oldRefs)+len(buckets))
		for id := range oldRefs {
			idsSet[id] = struct{}{}
		}
		for id := range buckets {
			idsSet[id] = struct{}{}
		}
		ids := make([]int, 0, len(idsSet))
		for id := range idsSet {
			ids = append(ids, id)
		}
		sort.Ints(ids)
		var oldRows, desiredRows []sitePublishObject
		for _, id := range ids {
			newRows, hasNew := buckets[id]
			oldRef, hasOld := oldRefs[id]
			if hasOld && hasNew && oldRef.LogicalHash == layoutShardLogicalHash(newRows) {
				continue
			}
			if hasOld {
				rows, err := store.loadShardRows(id, oldRef)
				if err != nil {
					return nil, err
				}
				oldRows = append(oldRows, rows...)
			}
			if hasNew {
				desiredRows = append(desiredRows, newRows...)
			}
		}
		if store.variant.layout == "hybrid-fixed-two-slot" {
			for _, row := range coordinator.GeneratedRows {
				oldRows = append(oldRows, layoutSiteObject(row))
			}
			for _, row := range generated {
				desiredRows = append(desiredRows, layoutSiteObject(row))
			}
		}
		return stateLayoutChangedKeys(oldRows, desiredRows), nil
	default:
		return nil, fmt.Errorf("unknown state layout %q", store.variant.layout)
	}
}

func (store *stateLayoutStore) planDirectoryNode(nodeID string, desired *layoutDesiredNode, previous *layoutNodeRef,
	oldRows, desiredRows *[]sitePublishObject) error {
	if desired != nil && previous != nil && desired.Hash == previous.LogicalHash {
		return nil
	}
	if previous == nil {
		appendLayoutDesiredRows(desired, desiredRows)
		return nil
	}
	decoded, rows, err := store.loadDirectoryNode(nodeID, *previous)
	if err != nil {
		return err
	}
	*oldRows = append(*oldRows, rows...)
	if desired != nil {
		for _, row := range desired.Files {
			*desiredRows = append(*desiredRows, layoutSiteObject(row))
		}
	}
	oldChildren := make(map[string]layoutNodeRef, len(decoded.Children))
	for _, child := range decoded.Children {
		oldChildren[child.Name] = child.Ref
	}
	childNames := make(map[string]struct{}, len(oldChildren))
	for name := range oldChildren {
		childNames[name] = struct{}{}
	}
	if desired != nil {
		for name := range desired.Children {
			childNames[name] = struct{}{}
		}
	}
	ordered := make([]string, 0, len(childNames))
	for name := range childNames {
		ordered = append(ordered, name)
	}
	sort.Strings(ordered)
	for _, name := range ordered {
		var childDesired *layoutDesiredNode
		if desired != nil {
			childDesired = desired.Children[name]
		}
		oldRef, hasOld := oldChildren[name]
		if !hasOld {
			appendLayoutDesiredRows(childDesired, desiredRows)
			continue
		}
		if childDesired != nil && childDesired.Hash == oldRef.LogicalHash {
			continue
		}
		if err := store.planDirectoryNode(layoutChildID(nodeID, name), childDesired, &oldRef, oldRows, desiredRows); err != nil {
			return err
		}
	}
	return nil
}

func appendLayoutDesiredRows(node *layoutDesiredNode, rows *[]sitePublishObject) {
	if node == nil {
		return
	}
	for _, row := range node.Files {
		*rows = append(*rows, layoutSiteObject(row))
	}
	names := make([]string, 0, len(node.Children))
	for name := range node.Children {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		appendLayoutDesiredRows(node.Children[name], rows)
	}
}

func layoutShardLogicalHash(rows []sitePublishObject) string {
	logical, _ := json.Marshal(layoutShardLogical{SchemaVersion: 1, Objects: layoutEncodedRows(rows)})
	return stateLayoutHash(logical)
}

func (store *stateLayoutStore) loadDirectoryNode(nodeID string, ref layoutNodeRef) (layoutStoredNode, []sitePublishObject, error) {
	storageKey := layoutNodeStorageKey(nodeID, ref.Slot)
	if cached, ok := store.directoryReadCache[storageKey]; ok {
		return cached.Node, append([]sitePublishObject(nil), cached.Rows...), nil
	}
	body := store.nodes[storageKey]
	node, rows, err := store.decodeDirectoryNode(nodeID, ref, body)
	if err != nil {
		return layoutStoredNode{}, nil, err
	}
	store.recordLeafGet(body)
	store.directoryReadCache[storageKey] = layoutDecodedNode{Node: node, Rows: append([]sitePublishObject(nil), rows...)}
	return node, rows, nil
}

func (store *stateLayoutStore) loadShardRows(id int, ref layoutShardRef) ([]sitePublishObject, error) {
	storageKey := layoutShardStorageKey(store.site, id, ref.Slot)
	if cached, ok := store.shardReadCache[storageKey]; ok {
		return append([]sitePublishObject(nil), cached...), nil
	}
	body := store.shards[storageKey]
	rows, err := store.decodeShardBody(id, ref, body)
	if err != nil {
		return nil, err
	}
	store.recordLeafGet(body)
	store.shardReadCache[storageKey] = append([]sitePublishObject(nil), rows...)
	return rows, nil
}

func (store *stateLayoutStore) writePending(before layoutProjection, touched []string) error {
	if !sort.StringsAreSorted(touched) {
		return fmt.Errorf("pending touched keys are not sorted")
	}
	for index, key := range touched {
		if index > 0 && touched[index-1] == key {
			return fmt.Errorf("pending touched keys contain duplicates")
		}
		if !managedSitePublishKey(store.site, key) {
			return fmt.Errorf("pending key %q is outside site ownership", key)
		}
	}
	oldPending, err := store.pendingTouchedKeys()
	if err != nil {
		return err
	}
	if !isSortedSubset(oldPending, touched) {
		return fmt.Errorf("pending touched key set must grow monotonically")
	}
	if store.headPending && reflect.DeepEqual(oldPending, touched) {
		return nil
	}
	pending := &layoutPending{TouchedKeys: touched}
	switch store.variant.layout {
	case "flat":
		committed, err := store.readFlatState()
		if err != nil {
			return err
		}
		if committed.Committed.InputRoot != before.InputRoot {
			return fmt.Errorf("flat pending CAS input root differs from stored committed baseline")
		}
		body, err := store.encodeFlat(committed.Committed.InputRoot, committed.Committed.Objects, pending)
		if err != nil {
			return err
		}
		if store.failPendingCAS {
			store.recordCoordinatorPut(body)
			return fmt.Errorf("injected pending-state CAS failure")
		}
		store.flatBody = body
		store.setRoot(body, before.InputRoot, true)
		store.recordCoordinatorPut(body)
	case "directory-two-slot", "fixed-two-slot", "hybrid-fixed-two-slot":
		var current layoutCoordinator
		var err error
		current, err = store.readRootCoordinator()
		if err != nil {
			return err
		}
		var sourceRef, generatedRef *layoutNodeRef
		if current.SourceRoot != nil {
			copyRef := *current.SourceRoot
			sourceRef = &copyRef
		}
		if current.GeneratedRoot != nil {
			copyRef := *current.GeneratedRoot
			generatedRef = &copyRef
		}
		body, err := store.encodeCoordinator(current.InputRoot, pending, sourceRef, generatedRef, current.Buckets, current.GeneratedRows)
		if err != nil {
			return err
		}
		if store.failPendingCAS {
			store.recordCoordinatorPut(body)
			return fmt.Errorf("injected pending-state CAS failure")
		}
		store.setRoot(body, current.InputRoot, true)
		store.recordCoordinatorPut(body)
	}
	store.refreshPeak()
	return nil
}

func (store *stateLayoutStore) writeCommitted(projection layoutProjection) error {
	switch store.variant.layout {
	case "flat":
		body, err := store.encodeFlat(projection.InputRoot, projection.Rows, nil)
		if err != nil {
			return err
		}
		if store.failFinalCAS {
			store.recordCoordinatorPut(body)
			return fmt.Errorf("injected final-state CAS failure")
		}
		store.flatBody = body
		store.setRoot(body, projection.InputRoot, false)
		if err := store.assertProjectionRows(projection.Rows); err != nil {
			return err
		}
		store.recordCoordinatorPut(body)
	case "directory-two-slot", "fixed-two-slot", "hybrid-fixed-two-slot":
		var current layoutCoordinator
		var err error
		current, err = store.readRootCoordinator()
		if err != nil {
			return err
		}
		var sourceRef, generatedRef *layoutNodeRef
		if store.variant.layout == "directory-two-slot" {
			source, generated := layoutBuildDirectoryTrees(projection.Rows, store.site)
			sourceRef, err = store.updateDirectoryTree(source, current.SourceRoot)
			if err != nil {
				return err
			}
			generatedRef, err = store.updateDirectoryTree(generated, current.GeneratedRoot)
			if err != nil {
				return err
			}
		} else {
			var buckets []layoutCoordinatorBucket
			var generatedRows []layoutEncodedRow
			buckets, generatedRows, err = store.updateShardRows(projection.Rows, current.Buckets)
			if err != nil {
				return err
			}
			body, err := store.encodeCoordinator(projection.InputRoot, nil, nil, nil, buckets, generatedRows)
			if err != nil {
				return err
			}
			if store.failFinalCAS {
				store.recordCoordinatorPut(body)
				return fmt.Errorf("injected final-state CAS failure")
			}
			store.setRoot(body, projection.InputRoot, false)
			if err := store.assertProjectionRows(projection.Rows); err != nil {
				return err
			}
			store.recordCoordinatorPut(body)
			store.refreshPeak()
			return nil
		}
		body, err := store.encodeCoordinator(projection.InputRoot, nil, sourceRef, generatedRef, nil, nil)
		if err != nil {
			return err
		}
		if store.failFinalCAS {
			store.recordCoordinatorPut(body)
			return fmt.Errorf("injected final-state CAS failure")
		}
		store.setRoot(body, projection.InputRoot, false)
		if err := store.assertProjectionRows(projection.Rows); err != nil {
			return err
		}
		store.recordCoordinatorPut(body)
	default:
		return fmt.Errorf("unknown layout %q", store.variant.layout)
	}
	store.refreshPeak()
	return nil
}

func (store *stateLayoutStore) encodeFlat(inputRoot string, rows []sitePublishObject, pending *layoutPending) ([]byte, error) {
	if store.variant.codec == "named-http-row-v1" {
		plain, err := json.Marshal(layoutFlatStateV1{SchemaVersion: 1, Site: store.site,
			Committed: layoutFlatCommitted{InputRoot: inputRoot, Objects: append([]sitePublishObject(nil), rows...)}, Pending: pending})
		if err != nil {
			return nil, err
		}
		return stateLayoutDeterministicGzip(plain)
	}
	profiles, compactRows := layoutCompactRows(rows, true)
	state := layoutCompactState{SchemaVersion: 1, CodecVersion: 1, Site: store.site,
		Committed: layoutCompactCommitted{InputRoot: inputRoot, HTTPProfiles: profiles, Objects: compactRows}, Pending: pending}
	plain, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	return stateLayoutDeterministicGzip(plain)
}

func (store *stateLayoutStore) encodeCoordinator(inputRoot string, pending *layoutPending, sourceRef, generatedRef *layoutNodeRef, buckets []layoutCoordinatorBucket, generatedRows []layoutEncodedRow) ([]byte, error) {
	coordinator := layoutCoordinator{SchemaVersion: 1, CodecVersion: 1, Site: store.site, Layout: store.variant.layout,
		InputRoot: inputRoot, Pending: pending, SourceRoot: sourceRef, GeneratedRoot: generatedRef,
		Buckets: append([]layoutCoordinatorBucket(nil), buckets...), GeneratedRows: append([]layoutEncodedRow(nil), generatedRows...)}
	plain, err := json.Marshal(coordinator)
	if err != nil {
		return nil, err
	}
	return stateLayoutDeterministicGzip(plain)
}

func (store *stateLayoutStore) rootBody() []byte { return store.root }

func (store *stateLayoutStore) recordCoordinatorPut(body []byte) {
	if store.seeding {
		return
	}
	store.counts.Put++
	store.counts.CoordinatorPuts++
	store.writeBytes += int64(len(body))
}

func (store *stateLayoutStore) setRoot(body []byte, inputRoot string, pending bool) {
	store.root = append([]byte(nil), body...)
	store.headETag = stateLayoutHash(body)
	store.headSHA256 = stateLayoutHash(body)
	store.headInputRoot = inputRoot
	store.headPending = pending
	store.headSite = store.site
	store.headSchema = 1
	store.headContentType = "application/octet-stream"
	store.headEncoding = ""
	store.headCacheControl = sitePublishStateCacheControl
}

func (store *stateLayoutStore) validateHead(expectedInputRoot string) error {
	if err := store.validateHeadForTransition(); err != nil {
		return err
	}
	if store.headInputRoot != expectedInputRoot {
		return fmt.Errorf("state HEAD input root differs from the committed fixture snapshot")
	}
	if store.headPending {
		return fmt.Errorf("fresh layout scenario unexpectedly seeded pending state")
	}
	return nil
}

func (store *stateLayoutStore) validateHeadForTransition() error {
	if err := store.validateHeadBytes(); err != nil {
		return err
	}
	if store.headETag != stateLayoutHash(store.root) {
		return fmt.Errorf("state HEAD ETag changed before body read")
	}
	if store.headSite != store.site || store.headSchema != 1 || store.headContentType != "application/octet-stream" || store.headEncoding != "" || store.headCacheControl != sitePublishStateCacheControl {
		return fmt.Errorf("state HEAD site, schema, or HTTP policy is invalid")
	}
	if !sitePublishStateHashPattern.MatchString(store.headInputRoot) {
		return fmt.Errorf("state HEAD input root is invalid")
	}
	return nil
}

func (store *stateLayoutStore) pendingTouchedKeys() ([]string, error) {
	if store.variant.layout != "flat" {
		coordinator, err := store.readRootCoordinator()
		if err != nil {
			return nil, err
		}
		if coordinator.Pending == nil {
			return nil, nil
		}
		return append([]string(nil), coordinator.Pending.TouchedKeys...), nil
	}
	state, err := store.readFlatState()
	if err != nil {
		return nil, err
	}
	if state.Pending == nil {
		return nil, nil
	}
	return append([]string(nil), state.Pending.TouchedKeys...), nil
}

func (store *stateLayoutStore) readFlatState() (layoutFlatDecodedState, error) {
	plain, err := layoutGunzipBounded(store.root)
	if err != nil {
		return layoutFlatDecodedState{}, err
	}
	if err := validateNoDuplicateJSONKeys(plain); err != nil {
		return layoutFlatDecodedState{}, err
	}
	if store.variant.codec == "named-http-row-v1" {
		var state layoutFlatDecodedState
		if err := json.Unmarshal(plain, &state); err != nil {
			return layoutFlatDecodedState{}, err
		}
		if err := validateLayoutFlatState(state, store.site); err != nil {
			return layoutFlatDecodedState{}, err
		}
		if state.Committed.InputRoot != store.headInputRoot || (state.Pending != nil) != store.headPending {
			return layoutFlatDecodedState{}, fmt.Errorf("flat body disagrees with HEAD state metadata")
		}
		return state, nil
	}
	var compact layoutCompactState
	if err := json.Unmarshal(plain, &compact); err != nil {
		return layoutFlatDecodedState{}, err
	}
	if compact.SchemaVersion != 1 || compact.CodecVersion != 1 || compact.Site != store.site || compact.Committed.InputRoot != store.headInputRoot || (compact.Pending != nil) != store.headPending {
		return layoutFlatDecodedState{}, fmt.Errorf("profile-factored flat state disagrees with HEAD or schema")
	}
	rows, err := layoutDecodeCompactRows(store.site, compact.Committed.HTTPProfiles, compact.Committed.Objects, true)
	if err != nil {
		return layoutFlatDecodedState{}, err
	}
	state := layoutFlatDecodedState{SchemaVersion: 1, Site: compact.Site,
		Committed: layoutFlatCommitted{InputRoot: compact.Committed.InputRoot, Objects: rows}, Pending: compact.Pending}
	if err := validateLayoutFlatState(state, store.site); err != nil {
		return layoutFlatDecodedState{}, err
	}
	return state, nil
}

func validateLayoutFlatState(state layoutFlatDecodedState, site string) error {
	if state.SchemaVersion != 1 || state.Site != site || !sitePublishStateHashPattern.MatchString(state.Committed.InputRoot) || state.Committed.Objects == nil {
		return fmt.Errorf("historical flat state has an invalid schema, site, root, or object list")
	}
	previous := ""
	for index, row := range state.Committed.Objects {
		if err := validateSitePublishRow(site, row); err != nil {
			return fmt.Errorf("historical flat row %d: %w", index, err)
		}
		if index > 0 && row.Key <= previous {
			return fmt.Errorf("historical flat rows are not sorted and unique")
		}
		previous = row.Key
	}
	if state.Pending != nil {
		if len(state.Pending.TouchedKeys) == 0 || !sort.StringsAreSorted(state.Pending.TouchedKeys) {
			return fmt.Errorf("historical flat pending keys are empty or unsorted")
		}
		for index, key := range state.Pending.TouchedKeys {
			if index > 0 && state.Pending.TouchedKeys[index-1] == key {
				return fmt.Errorf("historical flat pending keys contain duplicates")
			}
			if !managedSitePublishKey(site, key) {
				return fmt.Errorf("historical flat pending key %q is outside site ownership", key)
			}
		}
	}
	return nil
}

func (store *stateLayoutStore) decodeProjectionRows() ([]sitePublishObject, error) {
	plain, err := layoutGunzipBounded(store.root)
	if err != nil {
		return nil, err
	}
	if err := validateNoDuplicateJSONKeys(plain); err != nil {
		return nil, err
	}
	switch store.variant.layout {
	case "flat":
		state, err := store.readFlatState()
		if err != nil {
			return nil, err
		}
		return append([]sitePublishObject(nil), state.Committed.Objects...), nil
	case "directory-two-slot", "fixed-two-slot", "hybrid-fixed-two-slot":
		var coordinator layoutCoordinator
		if err := json.Unmarshal(plain, &coordinator); err != nil {
			return nil, err
		}
		if err := store.validateCoordinator(coordinator); err != nil {
			return nil, err
		}
		if store.variant.layout == "directory-two-slot" {
			var rows []sitePublishObject
			if coordinator.SourceRoot != nil {
				part, err := store.readDirectoryRows("_artifacts/"+store.site+"/|", *coordinator.SourceRoot)
				if err != nil {
					return nil, err
				}
				rows = append(rows, part...)
			}
			if coordinator.GeneratedRoot != nil {
				part, err := store.readDirectoryRows("_indexes/"+store.site+"/|", *coordinator.GeneratedRoot)
				if err != nil {
					return nil, err
				}
				rows = append(rows, part...)
			}
			sort.Slice(rows, func(i, j int) bool { return rows[i].Key < rows[j].Key })
			return rows, nil
		}
		var rows []sitePublishObject
		for _, item := range coordinator.Buckets {
			body := store.shards[layoutShardStorageKey(store.site, item.ID, item.Ref.Slot)]
			part, err := store.decodeShardBody(item.ID, item.Ref, body)
			if err != nil {
				return nil, err
			}
			rows = append(rows, part...)
		}
		for _, row := range coordinator.GeneratedRows {
			rows = append(rows, layoutSiteObject(row))
		}
		sort.Slice(rows, func(i, j int) bool { return rows[i].Key < rows[j].Key })
		return rows, nil
	default:
		return nil, fmt.Errorf("unknown state layout %q", store.variant.layout)
	}
}

func (store *stateLayoutStore) assertProjectionRows(expected []sitePublishObject) error {
	rows, err := store.decodeProjectionRows()
	if err != nil {
		return fmt.Errorf("decode committed %s state: %w", store.variant.name, err)
	}
	if !reflect.DeepEqual(rows, expected) {
		return fmt.Errorf("committed %s state does not reconstruct exact desired rows: got %d, want %d", store.variant.name, len(rows), len(expected))
	}
	return nil
}

func (store *stateLayoutStore) validateCoordinator(coordinator layoutCoordinator) error {
	if coordinator.SchemaVersion != 1 || coordinator.CodecVersion != 1 || coordinator.Site != store.site ||
		coordinator.Layout != store.variant.layout || coordinator.InputRoot != store.headInputRoot || (coordinator.Pending != nil) != store.headPending {
		return fmt.Errorf("coordinator schema, site, layout, root, or pending metadata mismatch")
	}
	if !sitePublishStateHashPattern.MatchString(coordinator.InputRoot) {
		return fmt.Errorf("coordinator input root is invalid")
	}
	if coordinator.Pending != nil {
		if !sort.StringsAreSorted(coordinator.Pending.TouchedKeys) {
			return fmt.Errorf("coordinator pending keys are not sorted")
		}
		for i, key := range coordinator.Pending.TouchedKeys {
			if i > 0 && coordinator.Pending.TouchedKeys[i-1] == key {
				return fmt.Errorf("coordinator has duplicate pending key")
			}
			if !managedSitePublishKey(store.site, key) {
				return fmt.Errorf("coordinator pending key %q is outside site ownership", key)
			}
		}
	}
	last := -1
	for _, bucket := range coordinator.Buckets {
		if bucket.ID <= last || bucket.ID < 0 || bucket.ID >= store.variant.shardCount {
			return fmt.Errorf("coordinator shard IDs are invalid or unsorted")
		}
		last = bucket.ID
		if err := layoutValidateShardRef(bucket.Ref); err != nil {
			return err
		}
	}
	if coordinator.SourceRoot != nil {
		if err := layoutValidateRef(*coordinator.SourceRoot); err != nil {
			return err
		}
	}
	if coordinator.GeneratedRoot != nil {
		if err := layoutValidateRef(*coordinator.GeneratedRoot); err != nil {
			return err
		}
	}
	for _, row := range coordinator.GeneratedRows {
		if !strings.HasPrefix(row.Key, "_indexes/"+store.site+"/") {
			return fmt.Errorf("hybrid generated row is outside site ownership")
		}
		if err := layoutValidateEncodedRow(store.site, row); err != nil {
			return err
		}
	}
	return nil
}

func (store *stateLayoutStore) validateHeadAndReadRoot(expectedRoot string) (layoutCoordinator, error) {
	if err := store.validateHead(expectedRoot); err != nil {
		return layoutCoordinator{}, err
	}
	body := store.rootBody()
	if len(body) == 0 || len(body) > maxSitePublishStateGzipBytes {
		return layoutCoordinator{}, fmt.Errorf("state root compressed body size is invalid")
	}
	if stateLayoutHash(body) != store.headSHA256 || store.headETag == "" {
		return layoutCoordinator{}, fmt.Errorf("state root digest or ETag changed between HEAD and GET")
	}
	plain, err := layoutGunzipBounded(body)
	if err != nil {
		return layoutCoordinator{}, err
	}
	if err := validateNoDuplicateJSONKeys(plain); err != nil {
		return layoutCoordinator{}, err
	}
	if store.variant.layout == "flat" {
		if _, err := store.decodeProjectionRows(); err != nil {
			return layoutCoordinator{}, err
		}
		return layoutCoordinator{}, nil
	}
	var coordinator layoutCoordinator
	if err := json.Unmarshal(plain, &coordinator); err != nil {
		return layoutCoordinator{}, err
	}
	if err := store.validateCoordinator(coordinator); err != nil {
		return layoutCoordinator{}, err
	}
	return coordinator, nil
}

func (store *stateLayoutStore) readDirectoryRows(nodeID string, ref layoutNodeRef) ([]sitePublishObject, error) {
	decoded, rows, err := store.decodeDirectoryNode(nodeID, ref, store.nodes[layoutNodeStorageKey(nodeID, ref.Slot)])
	if err != nil {
		return nil, err
	}
	store.activeNodes[nodeID] = ref
	for _, child := range decoded.Children {
		childID := layoutChildID(nodeID, child.Name)
		part, err := store.readDirectoryRows(childID, child.Ref)
		if err != nil {
			return nil, err
		}
		rows = append(rows, part...)
	}
	return rows, nil
}

func (store *stateLayoutStore) decodeDirectoryNode(nodeID string, ref layoutNodeRef, body []byte) (layoutStoredNode, []sitePublishObject, error) {
	if len(body) == 0 || len(body) > maxSitePublishStateGzipBytes || stateLayoutHash(body) != ref.BodySHA256 {
		return layoutStoredNode{}, nil, fmt.Errorf("directory node body digest/size mismatch")
	}
	plain, err := layoutGunzipBounded(body)
	if err != nil {
		return layoutStoredNode{}, nil, err
	}
	if err := validateNoDuplicateJSONKeys(plain); err != nil {
		return layoutStoredNode{}, nil, err
	}
	var node layoutStoredNode
	if err := json.Unmarshal(plain, &node); err != nil {
		return layoutStoredNode{}, nil, err
	}
	if node.SchemaVersion != 1 || node.NodeID != nodeID || node.LogicalHash != ref.LogicalHash {
		return layoutStoredNode{}, nil, fmt.Errorf("directory node identity or schema mismatch")
	}
	area, directory, ok := layoutSplitNodeID(nodeID)
	if !ok {
		return layoutStoredNode{}, nil, fmt.Errorf("directory node ID is malformed")
	}
	var files []sitePublishObject
	if node.CodecVersion == 1 {
		files, err = layoutDecodeCompactNodeFiles(store.site, area, directory, node.HTTPProfiles, node.CompactFiles)
	} else if node.CodecVersion == 0 {
		last := ""
		for _, file := range node.Files {
			if file.Name == "" || strings.Contains(file.Name, "/") || file.Name == "." || file.Name == ".." || file.Name <= last {
				return layoutStoredNode{}, nil, fmt.Errorf("directory files are invalid or unsorted")
			}
			last = file.Name
			key := layoutJoinOwnedPath(area, directory, file.Name)
			row := sitePublishObject{Key: key, SHA256: file.SHA256, Size: file.Size, ContentType: file.ContentType,
				ContentEncoding: file.ContentEncoding, ContentDisposition: file.ContentDisposition, CacheControl: file.CacheControl}
			if err := layoutValidateSiteRow(store.site, row); err != nil {
				return layoutStoredNode{}, nil, err
			}
			files = append(files, row)
		}
	} else {
		return layoutStoredNode{}, nil, fmt.Errorf("directory node codec version is unsupported")
	}
	if err != nil {
		return layoutStoredNode{}, nil, err
	}
	childNames := make([]string, 0, len(node.Children))
	for _, child := range node.Children {
		if child.Name == "" || strings.Contains(child.Name, "/") || child.Name == "." || child.Name == ".." {
			return layoutStoredNode{}, nil, fmt.Errorf("directory child name is invalid")
		}
		if err := layoutValidateRef(child.Ref); err != nil {
			return layoutStoredNode{}, nil, err
		}
		childNames = append(childNames, child.Name)
	}
	if !sort.StringsAreSorted(childNames) {
		return layoutStoredNode{}, nil, fmt.Errorf("directory children are not sorted")
	}
	logical := layoutLogicalNode{SchemaVersion: 1, Files: layoutEncodedRows(files), Children: make([]layoutLogicalChild, 0, len(node.Children))}
	for _, child := range node.Children {
		logical.Children = append(logical.Children, layoutLogicalChild{Name: child.Name, LogicalHash: child.Ref.LogicalHash})
	}
	logicalBytes, _ := json.Marshal(logical)
	actualLogicalHash := stateLayoutHash(logicalBytes)
	if actualLogicalHash != ref.LogicalHash {
		return layoutStoredNode{}, nil, fmt.Errorf("directory %s logical content hash mismatch: actual %s, ref %s", nodeID, actualLogicalHash, ref.LogicalHash)
	}
	return node, files, nil
}

func (store *stateLayoutStore) decodeShardBody(id int, ref layoutShardRef, body []byte) ([]sitePublishObject, error) {
	if len(body) == 0 || len(body) > maxSitePublishStateGzipBytes || stateLayoutHash(body) != ref.BodySHA256 {
		return nil, fmt.Errorf("shard %d body digest/size mismatch", id)
	}
	plain, err := layoutGunzipBounded(body)
	if err != nil {
		return nil, err
	}
	if err := validateNoDuplicateJSONKeys(plain); err != nil {
		return nil, err
	}
	var shard layoutShardBody
	if err := json.Unmarshal(plain, &shard); err != nil {
		return nil, err
	}
	if shard.SchemaVersion != 1 || shard.LogicalHash != ref.LogicalHash {
		return nil, fmt.Errorf("shard %d identity or schema mismatch", id)
	}
	var rows []sitePublishObject
	if shard.CodecVersion == 1 {
		rows, err = layoutDecodeCompactRows(store.site, shard.HTTPProfiles, shard.CompactRows, true)
	} else if shard.CodecVersion == 0 {
		rows = make([]sitePublishObject, 0, len(shard.Objects))
		for _, row := range shard.Objects {
			object := layoutSiteObject(row)
			if err := layoutValidateSiteRow(store.site, object); err != nil {
				return nil, err
			}
			rows = append(rows, object)
		}
	} else {
		return nil, fmt.Errorf("shard %d codec version is unsupported", id)
	}
	if err != nil {
		return nil, err
	}
	if !sort.SliceIsSorted(rows, func(i, j int) bool { return rows[i].Key < rows[j].Key }) {
		return nil, fmt.Errorf("shard %d rows are not sorted", id)
	}
	for index, row := range rows {
		if index > 0 && rows[index-1].Key == row.Key {
			return nil, fmt.Errorf("shard %d has duplicate object row", id)
		}
		digest := sha256.Sum256([]byte(row.Key))
		bucketHash := uint64(digest[0])<<56 | uint64(digest[1])<<48 | uint64(digest[2])<<40 | uint64(digest[3])<<32 |
			uint64(digest[4])<<24 | uint64(digest[5])<<16 | uint64(digest[6])<<8 | uint64(digest[7])
		if int(bucketHash%uint64(store.variant.shardCount)) != id {
			return nil, fmt.Errorf("shard %d contains key assigned to another bucket", id)
		}
	}
	logical, _ := json.Marshal(layoutShardLogical{SchemaVersion: 1, Objects: layoutEncodedRows(rows)})
	if stateLayoutHash(logical) != ref.LogicalHash {
		return nil, fmt.Errorf("shard %d logical hash mismatch", id)
	}
	return rows, nil
}

func (store *stateLayoutStore) validateHeadBytes() error {
	if len(store.root) == 0 || len(store.root) > maxSitePublishStateGzipBytes || store.headETag == "" || !sitePublishStateHashPattern.MatchString(store.headSHA256) {
		return fmt.Errorf("state HEAD policy or size is invalid")
	}
	if store.headSHA256 != stateLayoutHash(store.root) {
		return fmt.Errorf("state HEAD body digest does not match stored bytes")
	}
	return nil
}

func (store *stateLayoutStore) readRootCoordinator() (layoutCoordinator, error) {
	if err := store.validateHeadBytes(); err != nil {
		return layoutCoordinator{}, err
	}
	plain, err := layoutGunzipBounded(store.root)
	if err != nil {
		return layoutCoordinator{}, err
	}
	if err := validateNoDuplicateJSONKeys(plain); err != nil {
		return layoutCoordinator{}, err
	}
	var coordinator layoutCoordinator
	if err := json.Unmarshal(plain, &coordinator); err != nil {
		return layoutCoordinator{}, err
	}
	if err := store.validateCoordinator(coordinator); err != nil {
		return layoutCoordinator{}, err
	}
	return coordinator, nil
}

func layoutDecodeCompactRows(site string, profiles []layoutPolicyEntry, compact []layoutCompactRow, useFullKey bool) ([]sitePublishObject, error) {
	policies := make([]layoutHTTPPolicy, len(profiles))
	last := ""
	for index, profile := range profiles {
		if profile.Digest <= last {
			return nil, fmt.Errorf("HTTP profile table is not sorted/unique")
		}
		last = profile.Digest
		digest, err := layoutPolicyDigest(profile.Policy)
		if err != nil || digest != profile.Digest {
			return nil, fmt.Errorf("HTTP policy profile digest mismatch")
		}
		policies[index] = profile.Policy
	}
	rows := make([]sitePublishObject, 0, len(compact))
	lastKey := ""
	for _, encoded := range compact {
		key, ok := encoded[0].(string)
		if !ok || key == "" || (!useFullKey && strings.Contains(key, "/")) || key <= lastKey {
			return nil, fmt.Errorf("compact object rows are malformed or unsorted")
		}
		lastKey = key
		hash, ok := encoded[1].(string)
		if !ok || !sitePublishStateHashPattern.MatchString(hash) {
			return nil, fmt.Errorf("compact row SHA256 is invalid")
		}
		size, ok := layoutJSONInt64(encoded[2])
		if !ok || size < 0 {
			return nil, fmt.Errorf("compact row size is invalid")
		}
		profileID, ok := layoutJSONInt(encoded[3])
		if !ok || profileID < 0 || profileID >= len(policies) {
			return nil, fmt.Errorf("compact row profile index is invalid")
		}
		policy := policies[profileID]
		if !useFullKey {
			return nil, fmt.Errorf("compact row decoder requires full object keys")
		}
		row := sitePublishObject{Key: key, SHA256: hash, Size: size, ContentType: policy.ContentType,
			ContentEncoding: policy.ContentEncoding, ContentDisposition: policy.ContentDisposition, CacheControl: policy.CacheControl}
		if err := layoutValidateSiteRow(site, row); err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func layoutDecodeCompactNodeFiles(site, area, directory string, profiles []layoutPolicyEntry, compact []layoutCompactRow) ([]sitePublishObject, error) {
	rows, err := layoutDecodeCompactRows(site, profiles, compact, false)
	if err != nil {
		// Compact node rows store a basename, so decode ordinals and policies
		// here with the node's exact parent path.
		policies := make([]layoutHTTPPolicy, len(profiles))
		for index, profile := range profiles {
			digest, digestErr := layoutPolicyDigest(profile.Policy)
			if digestErr != nil || digest != profile.Digest {
				return nil, fmt.Errorf("node policy digest mismatch")
			}
			policies[index] = profile.Policy
		}
		rows = make([]sitePublishObject, 0, len(compact))
		last := ""
		for _, encoded := range compact {
			name, ok := encoded[0].(string)
			if !ok || name == "" || strings.Contains(name, "/") || name == "." || name == ".." || name <= last {
				return nil, fmt.Errorf("compact node file name invalid")
			}
			last = name
			hash, ok := encoded[1].(string)
			if !ok || !sitePublishStateHashPattern.MatchString(hash) {
				return nil, fmt.Errorf("compact node SHA invalid")
			}
			size, ok := layoutJSONInt64(encoded[2])
			if !ok || size < 0 {
				return nil, fmt.Errorf("compact node size invalid")
			}
			profileID, ok := layoutJSONInt(encoded[3])
			if !ok || profileID < 0 || profileID >= len(policies) {
				return nil, fmt.Errorf("compact node profile index invalid")
			}
			key := layoutJoinOwnedPath(area, directory, name)
			policy := policies[profileID]
			row := sitePublishObject{Key: key, SHA256: hash, Size: size, ContentType: policy.ContentType, ContentEncoding: policy.ContentEncoding, ContentDisposition: policy.ContentDisposition, CacheControl: policy.CacheControl}
			if err := layoutValidateSiteRow(site, row); err != nil {
				return nil, err
			}
			rows = append(rows, row)
		}
	}
	return rows, nil
}

func layoutJSONInt64(value any) (int64, bool) {
	switch number := value.(type) {
	case float64:
		if number != math.Trunc(number) {
			return 0, false
		}
		return int64(number), true
	case int:
		return int64(number), true
	case int64:
		return number, true
	}
	return 0, false
}

func layoutJSONInt(value any) (int, bool) {
	value64, ok := layoutJSONInt64(value)
	if !ok {
		return 0, false
	}
	return int(value64), true
}

func layoutSiteObject(row layoutEncodedRow) sitePublishObject {
	return sitePublishObject{Key: row.Key, SHA256: row.SHA256, Size: row.Size, ContentType: row.ContentType, ContentEncoding: row.ContentEncoding, ContentDisposition: row.ContentDisposition, CacheControl: row.CacheControl}
}

func layoutValidateSiteRow(site string, row sitePublishObject) error {
	if !sitePublishStateHashPattern.MatchString(row.SHA256) || row.Size < 0 {
		return fmt.Errorf("state row hash/size invalid for %q", row.Key)
	}
	expectedType, expectedDisposition, expectedEncoding, expectedCache, err := expectedSitePublishObjectPolicy(site, row.Key)
	if err != nil {
		return err
	}
	if row.ContentType != expectedType || row.ContentDisposition != expectedDisposition || row.ContentEncoding != expectedEncoding || row.CacheControl != expectedCache {
		return fmt.Errorf("state row HTTP policy mismatch for %q", row.Key)
	}
	return nil
}

func layoutValidateEncodedRow(site string, row layoutEncodedRow) error {
	return layoutValidateSiteRow(site, layoutSiteObject(row))
}

func layoutValidateRef(ref layoutNodeRef) error {
	if ref.Slot < 0 || ref.Slot > 1 || !sitePublishStateHashPattern.MatchString(ref.LogicalHash) || !sitePublishStateHashPattern.MatchString(ref.BodySHA256) {
		return fmt.Errorf("state node reference is invalid")
	}
	return nil
}

func layoutValidateShardRef(ref layoutShardRef) error {
	if ref.Slot < 0 || ref.Slot > 1 || !sitePublishStateHashPattern.MatchString(ref.LogicalHash) || !sitePublishStateHashPattern.MatchString(ref.BodySHA256) {
		return fmt.Errorf("state shard reference is invalid")
	}
	return nil
}

func layoutSplitNodeID(id string) (area, directory string, ok bool) {
	parts := strings.SplitN(id, "|", 2)
	if len(parts) != 2 || !(strings.HasPrefix(parts[0], "_artifacts/") || strings.HasPrefix(parts[0], "_indexes/")) {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func layoutChildID(parentID, name string) string {
	area, directory, _ := layoutSplitNodeID(parentID)
	if directory == "" {
		return area + "|" + name
	}
	return area + "|" + directory + "/" + name
}

func layoutJoinOwnedPath(area, directory, name string) string {
	if directory == "" {
		return area + name
	}
	return area + directory + "/" + name
}

func layoutGunzipBounded(body []byte) ([]byte, error) {
	if len(body) == 0 || len(body) > maxSitePublishStateGzipBytes {
		return nil, fmt.Errorf("state gzip size exceeds configured bounds")
	}
	reader, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	plain, err := io.ReadAll(io.LimitReader(reader, maxSitePublishStateJSONBytes+1))
	if err != nil {
		return nil, err
	}
	if len(plain) > maxSitePublishStateJSONBytes {
		return nil, fmt.Errorf("state JSON exceeds configured bound")
	}
	return plain, nil
}

func (store *stateLayoutStore) readDirectoryRowsCounted(nodeID string, ref layoutNodeRef) ([]sitePublishObject, error) {
	body := store.nodes[layoutNodeStorageKey(nodeID, ref.Slot)]
	node, rows, err := store.decodeDirectoryNode(nodeID, ref, body)
	if err != nil {
		return nil, err
	}
	store.recordLeafGet(body)
	var all []sitePublishObject
	all = append(all, rows...)
	store.activeNodes[nodeID] = ref
	for _, child := range node.Children {
		part, err := store.readDirectoryRowsCounted(layoutChildID(nodeID, child.Name), child.Ref)
		if err != nil {
			return nil, err
		}
		all = append(all, part...)
	}
	return all, nil
}

func (store *stateLayoutStore) refreshActiveNodesFromRoot() error {
	coordinator, err := store.readRootCoordinator()
	if err != nil {
		return err
	}
	active := make(map[string]layoutNodeRef)
	store.activeNodes = active
	if coordinator.SourceRoot != nil {
		if _, err := store.readDirectoryRows("_artifacts/"+store.site+"/|", *coordinator.SourceRoot); err != nil {
			return err
		}
	}
	if coordinator.GeneratedRoot != nil {
		if _, err := store.readDirectoryRows("_indexes/"+store.site+"/|", *coordinator.GeneratedRoot); err != nil {
			return err
		}
	}
	return nil
}

func (store *stateLayoutStore) recordLeafGet(body []byte) {
	if store.seeding {
		return
	}
	store.counts.Get++
	store.counts.LeafGets++
	store.readBytes += int64(len(body))
}

func (store *stateLayoutStore) recordLeafPut(body []byte) {
	if store.seeding {
		return
	}
	store.counts.Put++
	store.counts.LeafPuts++
	store.writeBytes += int64(len(body))
}

func (store *stateLayoutStore) afterLeafPut() error {
	store.leafPutsThisAttempt++
	if store.failAfterLeafPuts > 0 && store.leafPutsThisAttempt >= store.failAfterLeafPuts {
		return fmt.Errorf("injected interruption after %d state leaf PUTs", store.leafPutsThisAttempt)
	}
	return nil
}

func (store *stateLayoutStore) persistentBytes() int64 {
	total := int64(len(store.root))
	for _, body := range store.nodes {
		total += int64(len(body))
	}
	for _, body := range store.shards {
		total += int64(len(body))
	}
	return total
}

func (store *stateLayoutStore) refreshPeak() {
	current := store.persistentBytes()
	if current > store.peakBytes {
		store.peakBytes = current
	}
	if current > store.attemptPeakBytes {
		store.attemptPeakBytes = current
	}
}

func (store *stateLayoutStore) orphanBytes() int64 {
	var orphan int64
	if store.variant.layout == "directory-two-slot" {
		active := make(map[string]struct{}, len(store.activeNodes))
		for id, ref := range store.activeNodes {
			active[layoutNodeStorageKey(id, ref.Slot)] = struct{}{}
		}
		for key, body := range store.nodes {
			if _, ok := active[key]; !ok {
				orphan += int64(len(body))
			}
		}
	} else if store.variant.layout == "fixed-two-slot" || store.variant.layout == "hybrid-fixed-two-slot" {
		active := make(map[string]struct{}, len(store.activeShards))
		for id, ref := range store.activeShards {
			active[layoutShardStorageKey(store.site, id, ref.Slot)] = struct{}{}
		}
		for key, body := range store.shards {
			if _, ok := active[key]; !ok {
				orphan += int64(len(body))
			}
		}
	}
	return orphan
}

func (store *stateLayoutStore) report(beforeBytes, afterBytes int64) stateLayoutVariantReport {
	return stateLayoutVariantReport{StateCalls: store.counts, StateBodyReadBytes: store.readBytes,
		StateBodyWriteBytes: store.writeBytes, PersistentBytesBefore: beforeBytes, PersistentBytesAfter: afterBytes,
		PeakPersistentBytes: store.peakBytes, RetainedOrphanBytes: store.orphanBytes()}
}

func stateLayoutChangedKeys(before, after []sitePublishObject) []string {
	oldRows, newRows := rowsMap(before), rowsMap(after)
	set := make(map[string]struct{})
	for _, key := range unionRowKeys(oldRows, newRows) {
		if !equalSitePublishObject(oldRows[key], newRows[key]) {
			set[key] = struct{}{}
		}
	}
	return sortedSet(set)
}

func mustGunzip(body []byte) []byte {
	reader, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		panic(err)
	}
	defer reader.Close()
	plain, err := io.ReadAll(reader)
	if err != nil {
		panic(err)
	}
	return plain
}

func layoutEncodedRows(rows []sitePublishObject) []layoutEncodedRow {
	result := make([]layoutEncodedRow, 0, len(rows))
	for _, row := range rows {
		result = append(result, layoutEncodedRow{Key: row.Key, SHA256: row.SHA256, Size: row.Size,
			ContentType: row.ContentType, ContentEncoding: row.ContentEncoding, ContentDisposition: row.ContentDisposition, CacheControl: row.CacheControl})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Key < result[j].Key })
	return result
}

func layoutPolicyForRow(row layoutEncodedRow) layoutHTTPPolicy {
	return layoutHTTPPolicy{ContentType: row.ContentType, ContentEncoding: row.ContentEncoding,
		ContentDisposition: row.ContentDisposition, CacheControl: row.CacheControl}
}

func layoutPolicyDigest(policy layoutHTTPPolicy) (string, error) {
	encoded, err := json.Marshal(policy)
	if err != nil {
		return "", err
	}
	return stateLayoutHash(encoded), nil
}

func layoutCompactRows(rows []sitePublishObject, useKey bool) ([]layoutPolicyEntry, []layoutCompactRow) {
	policies := make(map[string]layoutHTTPPolicy)
	encodedRows := layoutEncodedRows(rows)
	for _, row := range encodedRows {
		policy := layoutPolicyForRow(row)
		digest, _ := layoutPolicyDigest(policy)
		policies[digest] = policy
	}
	ids := make([]string, 0, len(policies))
	for id := range policies {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	profiles := make([]layoutPolicyEntry, 0, len(ids))
	for _, id := range ids {
		profiles = append(profiles, layoutPolicyEntry{Digest: id, Policy: policies[id]})
	}
	ordinals := make(map[string]int, len(ids))
	for index, id := range ids {
		ordinals[id] = index
	}
	compact := make([]layoutCompactRow, 0, len(encodedRows))
	for _, row := range encodedRows {
		policyID, _ := layoutPolicyDigest(layoutPolicyForRow(row))
		name := row.Key
		if !useKey {
			name = path.Base(row.Key)
		}
		compact = append(compact, layoutCompactRow{name, row.SHA256, row.Size, ordinals[policyID]})
	}
	return profiles, compact
}

func layoutBuildDirectoryTrees(rows []sitePublishObject, site string) (*layoutDesiredNode, *layoutDesiredNode) {
	makeRoot := func(area string) *layoutDesiredNode {
		return &layoutDesiredNode{ID: area + "|", Name: "", Area: area, Children: make(map[string]*layoutDesiredNode)}
	}
	sourceRoot, generatedRoot := makeRoot("_artifacts/"+site+"/"), makeRoot("_indexes/"+site+"/")
	for _, row := range layoutEncodedRows(rows) {
		area, relative := "", ""
		if strings.HasPrefix(row.Key, "_artifacts/"+site+"/") {
			area, relative = sourceRoot.Area, strings.TrimPrefix(row.Key, sourceRoot.Area)
		} else if strings.HasPrefix(row.Key, "_indexes/"+site+"/") {
			area, relative = generatedRoot.Area, strings.TrimPrefix(row.Key, generatedRoot.Area)
		} else {
			continue
		}
		parts := strings.Split(relative, "/")
		node := sourceRoot
		if area == generatedRoot.Area {
			node = generatedRoot
		}
		for _, segment := range parts[:len(parts)-1] {
			child := node.Children[segment]
			if child == nil {
				dir := strings.Join(append(layoutNodeParts(node.Dir), segment), "/")
				child = &layoutDesiredNode{ID: area + "|" + dir, Name: segment, Area: area,
					Dir: dir, Children: make(map[string]*layoutDesiredNode)}
				node.Children[segment] = child
			}
			node = child
		}
		node.Files = append(node.Files, row)
	}
	layoutHashDirectory(sourceRoot)
	layoutHashDirectory(generatedRoot)
	return sourceRoot, generatedRoot
}

func layoutNodeParts(dir string) []string {
	if dir == "" {
		return nil
	}
	return strings.Split(dir, "/")
}

func layoutHashDirectory(node *layoutDesiredNode) string {
	sort.Slice(node.Files, func(i, j int) bool { return node.Files[i].Key < node.Files[j].Key })
	childNames := make([]string, 0, len(node.Children))
	for name := range node.Children {
		childNames = append(childNames, name)
	}
	sort.Strings(childNames)
	logical := layoutLogicalNode{SchemaVersion: 1, Files: append([]layoutEncodedRow{}, node.Files...), Children: make([]layoutLogicalChild, 0, len(childNames))}
	for _, name := range childNames {
		child := node.Children[name]
		layoutHashDirectory(child)
		logical.Children = append(logical.Children, layoutLogicalChild{Name: name, LogicalHash: child.Hash})
	}
	data, _ := json.Marshal(logical)
	node.Hash = stateLayoutHash(data)
	return node.Hash
}

func (store *stateLayoutStore) seedDirectory(root *layoutDesiredNode) (*layoutNodeRef, error) {
	if root == nil || len(root.Files) == 0 && len(root.Children) == 0 {
		return nil, nil
	}
	return store.writeDirectorySubtree(root, nil)
}

func (store *stateLayoutStore) updateDirectoryTree(desired *layoutDesiredNode, previous *layoutNodeRef) (*layoutNodeRef, error) {
	if desired == nil || len(desired.Files) == 0 && len(desired.Children) == 0 {
		if previous == nil {
			return nil, nil
		}
		if desired == nil {
			return nil, fmt.Errorf("cannot remove a directory node without its path identity")
		}
		return nil, store.removeDirectorySubtree(desired.ID, *previous)
	}
	var old *layoutStoredNode
	if previous != nil {
		if previous.LogicalHash == desired.Hash {
			return previous, nil
		}
		decoded, _, err := store.loadDirectoryNode(desired.ID, *previous)
		if err != nil {
			return nil, fmt.Errorf("decode changed directory node %s: %w", desired.ID, err)
		}
		old = &decoded
	}
	oldChildren := make(map[string]layoutNodeRef)
	if old != nil {
		for _, child := range old.Children {
			oldChildren[child.Name] = child.Ref
		}
	}
	childNames := make(map[string]struct{})
	for name := range desired.Children {
		childNames[name] = struct{}{}
	}
	for name := range oldChildren {
		childNames[name] = struct{}{}
	}
	ordered := make([]string, 0, len(childNames))
	for name := range childNames {
		ordered = append(ordered, name)
	}
	sort.Strings(ordered)
	children := make([]layoutStoredChild, 0, len(ordered))
	for _, name := range ordered {
		childDesired := desired.Children[name]
		oldRef, hasOld := oldChildren[name]
		var ref *layoutNodeRef
		var err error
		if childDesired != nil {
			if hasOld {
				ref, err = store.updateDirectoryTree(childDesired, &oldRef)
			} else {
				ref, err = store.writeDirectorySubtree(childDesired, nil)
			}
		} else if hasOld {
			err = store.removeDirectorySubtree(layoutChildID(desired.ID, name), oldRef)
		}
		if err != nil {
			return nil, err
		}
		if ref != nil {
			children = append(children, layoutStoredChild{Name: name, Ref: *ref})
		}
	}
	var targetSlot int
	if previous != nil {
		targetSlot = 1 - previous.Slot
	} else if last, ok := store.latestNodeSlot[desired.ID]; ok {
		targetSlot = 1 - last
	}
	body, err := store.encodeDirectoryNode(desired, children)
	if err != nil {
		return nil, err
	}
	store.nodes[layoutNodeStorageKey(desired.ID, targetSlot)] = body
	store.latestNodeSlot[desired.ID] = targetSlot
	store.recordLeafPut(body)
	if err := store.afterLeafPut(); err != nil {
		return nil, err
	}
	ref := &layoutNodeRef{LogicalHash: desired.Hash, Slot: targetSlot, BodySHA256: stateLayoutHash(body)}
	store.activeNodes[desired.ID] = *ref
	store.refreshPeak()
	return ref, nil
}

func (store *stateLayoutStore) writeDirectorySubtree(desired *layoutDesiredNode, _ *layoutNodeRef) (*layoutNodeRef, error) {
	children := make([]layoutStoredChild, 0, len(desired.Children))
	names := make([]string, 0, len(desired.Children))
	for name := range desired.Children {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		ref, err := store.writeDirectorySubtree(desired.Children[name], nil)
		if err != nil {
			return nil, err
		}
		children = append(children, layoutStoredChild{Name: name, Ref: *ref})
	}
	slot := 0
	if last, ok := store.latestNodeSlot[desired.ID]; ok {
		slot = 1 - last
	}
	body, err := store.encodeDirectoryNode(desired, children)
	if err != nil {
		return nil, err
	}
	store.nodes[layoutNodeStorageKey(desired.ID, slot)] = body
	store.latestNodeSlot[desired.ID] = slot
	store.recordLeafPut(body)
	if err := store.afterLeafPut(); err != nil {
		return nil, err
	}
	ref := &layoutNodeRef{LogicalHash: desired.Hash, Slot: slot, BodySHA256: stateLayoutHash(body)}
	store.activeNodes[desired.ID] = *ref
	store.refreshPeak()
	return ref, nil
}

func (store *stateLayoutStore) removeDirectorySubtree(nodeID string, ref layoutNodeRef) error {
	node, _, err := store.loadDirectoryNode(nodeID, ref)
	if err != nil {
		return fmt.Errorf("decode removed directory node %s: %w", nodeID, err)
	}
	for _, child := range node.Children {
		if err := store.removeDirectorySubtree(layoutChildID(nodeID, child.Name), child.Ref); err != nil {
			return err
		}
	}
	delete(store.activeNodes, nodeID)
	return nil
}

func (store *stateLayoutStore) encodeDirectoryNode(desired *layoutDesiredNode, children []layoutStoredChild) ([]byte, error) {
	files := make([]layoutNodeFile, 0, len(desired.Files))
	for _, row := range desired.Files {
		files = append(files, layoutNodeFile{Name: path.Base(row.Key), SHA256: row.SHA256, Size: row.Size,
			ContentType: row.ContentType, ContentEncoding: row.ContentEncoding, ContentDisposition: row.ContentDisposition, CacheControl: row.CacheControl})
	}
	node := layoutStoredNode{SchemaVersion: 1, NodeID: desired.ID, LogicalHash: desired.Hash, Children: children}
	if store.variant.codec == "profile-factored-v1" {
		rows := make([]sitePublishObject, 0, len(desired.Files))
		for _, row := range desired.Files {
			rows = append(rows, sitePublishObject{Key: row.Key, SHA256: row.SHA256, Size: row.Size, ContentType: row.ContentType,
				ContentEncoding: row.ContentEncoding, ContentDisposition: row.ContentDisposition, CacheControl: row.CacheControl})
		}
		profiles, compact := layoutCompactRows(rows, false)
		node.CodecVersion, node.CompactFiles, node.HTTPProfiles = 1, compact, profiles
	} else {
		node.Files = files
	}
	plain, err := json.Marshal(node)
	if err != nil {
		return nil, err
	}
	return stateLayoutDeterministicGzip(plain)
}

func layoutNodeStorageKey(id string, slot int) string {
	parts := strings.SplitN(id, "|", 2)
	area := parts[0]
	pathParts := strings.Split(area, "/")
	site := "unknown"
	if len(pathParts) > 1 {
		site = pathParts[1]
	}
	return fmt.Sprintf("_control/publish-state/%s/nodes/%s.slot%d.json.gz", site, stateLayoutHash([]byte(id)), slot)
}

func (store *stateLayoutStore) seedShards(rows []sitePublishObject) ([]layoutCoordinatorBucket, []layoutEncodedRow, error) {
	buckets, generated := store.layoutBuckets(rows)
	ids := make([]int, 0, len(buckets))
	for id := range buckets {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	refs := make([]layoutCoordinatorBucket, 0, len(ids))
	for _, id := range ids {
		body, logicalHash, err := store.encodeShard(id, buckets[id])
		if err != nil {
			return nil, nil, err
		}
		store.shards[layoutShardStorageKey(store.site, id, 0)] = body
		store.latestShardSlot[id] = 0
		ref := layoutShardRef{LogicalHash: logicalHash, Slot: 0, BodySHA256: stateLayoutHash(body)}
		store.activeShards[id] = ref
		refs = append(refs, layoutCoordinatorBucket{ID: id, Ref: ref})
	}
	return refs, generated, nil
}

func (store *stateLayoutStore) updateShardRows(rows []sitePublishObject, oldRows []layoutCoordinatorBucket) ([]layoutCoordinatorBucket, []layoutEncodedRow, error) {
	buckets, generated := store.layoutBuckets(rows)
	old := make(map[int]layoutShardRef, len(oldRows))
	for _, item := range oldRows {
		old[item.ID] = item.Ref
	}
	idsSet := make(map[int]struct{}, len(old)+len(buckets))
	for id := range old {
		idsSet[id] = struct{}{}
	}
	for id := range buckets {
		idsSet[id] = struct{}{}
	}
	ids := make([]int, 0, len(idsSet))
	for id := range idsSet {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	newRefs := make([]layoutCoordinatorBucket, 0, len(buckets))
	for _, id := range ids {
		newRows, hasNew := buckets[id]
		oldRef, hasOld := old[id]
		var newHash string
		if hasNew {
			logical, _ := json.Marshal(layoutShardLogical{SchemaVersion: 1, Objects: layoutEncodedRows(newRows)})
			newHash = stateLayoutHash(logical)
		}
		if hasOld && hasNew && oldRef.LogicalHash == newHash {
			newRefs = append(newRefs, layoutCoordinatorBucket{ID: id, Ref: oldRef})
			continue
		}
		if hasOld {
			if _, err := store.loadShardRows(id, oldRef); err != nil {
				return nil, nil, fmt.Errorf("read changed shard %d: %w", id, err)
			}
		}
		if !hasNew {
			delete(store.activeShards, id)
			continue
		}
		slot := 0
		if hasOld {
			slot = 1 - oldRef.Slot
		} else if last, ok := store.latestShardSlot[id]; ok {
			slot = 1 - last
		}
		body, hash, err := store.encodeShard(id, newRows)
		if err != nil {
			return nil, nil, err
		}
		if hash != newHash {
			return nil, nil, fmt.Errorf("shard %d logical hash changed during encode", id)
		}
		store.shards[layoutShardStorageKey(store.site, id, slot)] = body
		store.latestShardSlot[id] = slot
		ref := layoutShardRef{LogicalHash: hash, Slot: slot, BodySHA256: stateLayoutHash(body)}
		store.activeShards[id] = ref
		store.recordLeafPut(body)
		if err := store.afterLeafPut(); err != nil {
			return nil, nil, err
		}
		store.refreshPeak()
		newRefs = append(newRefs, layoutCoordinatorBucket{ID: id, Ref: ref})
	}
	return newRefs, generated, nil
}

func (store *stateLayoutStore) layoutBuckets(rows []sitePublishObject) (map[int][]sitePublishObject, []layoutEncodedRow) {
	buckets := make(map[int][]sitePublishObject)
	var generated []layoutEncodedRow
	for _, row := range rows {
		if store.variant.layout == "hybrid-fixed-two-slot" && strings.HasPrefix(row.Key, "_indexes/"+store.site+"/") {
			generated = append(generated, layoutEncodedRows([]sitePublishObject{row})[0])
			continue
		}
		digest := sha256.Sum256([]byte(row.Key))
		bucketHash := uint64(digest[0])<<56 | uint64(digest[1])<<48 | uint64(digest[2])<<40 | uint64(digest[3])<<32 |
			uint64(digest[4])<<24 | uint64(digest[5])<<16 | uint64(digest[6])<<8 | uint64(digest[7])
		id := int(bucketHash % uint64(store.variant.shardCount))
		buckets[id] = append(buckets[id], row)
	}
	for id := range buckets {
		sort.Slice(buckets[id], func(i, j int) bool { return buckets[id][i].Key < buckets[id][j].Key })
	}
	sort.Slice(generated, func(i, j int) bool { return generated[i].Key < generated[j].Key })
	return buckets, generated
}

func (store *stateLayoutStore) encodeShard(id int, rows []sitePublishObject) ([]byte, string, error) {
	fullRows := layoutEncodedRows(rows)
	logical, err := json.Marshal(layoutShardLogical{SchemaVersion: 1, Objects: fullRows})
	if err != nil {
		return nil, "", err
	}
	logicalHash := stateLayoutHash(logical)
	body := layoutShardBody{SchemaVersion: 1, LogicalHash: logicalHash}
	if store.variant.codec == "profile-factored-v1" {
		profiles, compact := layoutCompactRows(rows, true)
		body.CodecVersion, body.CompactRows, body.HTTPProfiles = 1, compact, profiles
	} else {
		body.Objects = fullRows
	}
	plain, err := json.Marshal(body)
	if err != nil {
		return nil, "", err
	}
	compressed, err := stateLayoutDeterministicGzip(plain)
	return compressed, logicalHash, err
}

func layoutShardStorageKey(site string, id, slot int) string {
	return fmt.Sprintf("_control/publish-state/%s/shards/%03d.slot%d.json.gz", site, id, slot)
}

func stateLayoutCompareScenario(t *testing.T, site string, scenario stateLayoutScenario, before, after layoutProjection, variants []stateLayoutVariant) (stateLayoutScenarioReport, error) {
	t.Helper()
	common, err := stateLayoutProjectionDelta(before.Objects, after.Objects)
	if err != nil {
		return stateLayoutScenarioReport{}, err
	}
	generatedCount, generatedBytes := stateLayoutGeneratedProjectionStats(before.Rows)
	result := stateLayoutScenarioReport{Name: scenario.name, Kind: scenario.kind,
		SourceFiles: stateLayoutSourceRowCount(before.Rows, site), GeneratedObjects: generatedCount, GeneratedBytes: generatedBytes, FullText: scenario.fullText,
		Distribution: scenario.distribution, Projection: common}
	for _, variant := range variants {
		modeled, err := stateLayoutTransition(site, before, after, variant)
		if err != nil {
			return stateLayoutScenarioReport{}, fmt.Errorf("layout %s: %w", variant.name, err)
		}
		modeled.Name, modeled.Layout, modeled.Codec, modeled.ShardCount = variant.name, variant.layout, variant.codec, variant.shardCount
		modeled.R2 = stateLayoutR2Estimate(modeled.StateCalls, modeled.PersistentBytesAfter, 1, 1)
		result.Variants = append(result.Variants, modeled)
	}
	return result, nil
}

func stateLayoutSourceRowCount(rows []sitePublishObject, site string) int {
	prefix := "_artifacts/" + site + "/"
	count := 0
	for _, row := range rows {
		if strings.HasPrefix(row.Key, prefix) {
			count++
		}
	}
	return count
}

func stateLayoutGeneratedProjectionStats(rows []sitePublishObject) (int, int64) {
	count := 0
	var size int64
	for _, row := range rows {
		if strings.HasPrefix(row.Key, "_indexes/") {
			count++
			size += row.Size
		}
	}
	return count, size
}

func stateLayoutProjectionDelta(before, after map[string]Object) (stateLayoutProjectionReport, error) {
	keys := make(map[string]struct{}, len(before)+len(after))
	for key := range before {
		keys[key] = struct{}{}
	}
	for key := range after {
		keys[key] = struct{}{}
	}
	var report stateLayoutProjectionReport
	for key := range keys {
		old, hadOld := before[key]
		current, hasCurrent := after[key]
		if hadOld && hasCurrent && reflect.DeepEqual(old, current) {
			continue
		}
		report.ChangedObjectCount++
		if strings.HasPrefix(key, "_indexes/") {
			report.ChangedGeneratedCount++
		}
		if !hasCurrent {
			report.Deletes++
			continue
		}
		report.Puts++
		report.PutBytes += int64(len(current.Bytes))
		if strings.HasPrefix(key, "_artifacts/") {
			report.SourcePuts++
			report.SourcePutBytes += int64(len(current.Bytes))
		} else {
			report.GeneratedPuts++
			report.GeneratedPutBytes += int64(len(current.Bytes))
		}
	}
	return report, nil
}

func stateLayoutMutate(root string, sources []matrixSourceFile, scenario stateLayoutScenario) ([]string, int64, int64, matrixChangedTypes, error) {
	spec := matrixScenarioSpec{Name: scenario.name, Kind: scenario.kind, Distribution: scenario.distribution, Count: scenario.count}
	if spec.Distribution == "" {
		spec.Distribution = "uniform-scattered"
	}
	if scenario.kind == "page-and-resource-mixed" {
		spec.Kind = "page-mixed"
	}
	if scenario.kind == "page-only" {
		var pages []string
		for _, source := range sources {
			if extIsPage(strings.ToLower(filepath.Ext(source.RelativePath))) {
				pages = append(pages, source.RelativePath)
			}
		}
		selected := matrixPickUniform(pages, min(scenario.count, len(pages)), fmt.Sprintf("%d/%s", sitePublishStateLayoutSeed, scenario.name))
		return stateLayoutMutateSelected(root, sources, selected, scenario.name)
	}
	if scenario.kind == "rename-delete" {
		var resource, page matrixSourceFile
		resource = matrixFirstSource(sources, false)
		page = matrixFirstSource(sources, true)
		if resource.RelativePath == "" || page.RelativePath == "" {
			return nil, 0, 0, matrixChangedTypes{}, fmt.Errorf("fixture needs a page and resource")
		}
		fromResource := filepath.Join(root, filepath.FromSlash(resource.RelativePath))
		toResource := filepath.Join(filepath.Dir(fromResource), "layout-renamed-resource.txt")
		if err := os.Rename(fromResource, toResource); err != nil {
			return nil, 0, 0, matrixChangedTypes{}, err
		}
		pagePath := filepath.Join(root, filepath.FromSlash(page.RelativePath))
		if err := os.Remove(pagePath); err != nil {
			return nil, 0, 0, matrixChangedTypes{}, err
		}
		updated, err := matrixReadSources(root)
		if err != nil {
			return nil, 0, 0, matrixChangedTypes{}, err
		}
		changed := matrixChangedPathList(sources, updated)
		return changed, int64(len(resource.Bytes) + len(page.Bytes)), int64(len(resource.Bytes)), matrixChangedTypes{Pages: 1, Resources: 1}, nil
	}
	return matrixMutateSources(root, sources, spec, len(sources))
}

func stateLayoutMutateSelected(root string, sources []matrixSourceFile, selected []string, name string) ([]string, int64, int64, matrixChangedTypes, error) {
	byPath := make(map[string]matrixSourceFile, len(sources))
	for _, source := range sources {
		byPath[source.RelativePath] = source
	}
	var oldBytes, newBytes int64
	changedTypes := matrixChangedTypes{}
	for index, relative := range selected {
		original, ok := byPath[relative]
		if !ok {
			return nil, 0, 0, matrixChangedTypes{}, fmt.Errorf("selected source path %q is absent", relative)
		}
		mutation := []byte(fmt.Sprintf("\n<!-- MATRIX:%s:%05d -->\n", name, index))
		if strings.EqualFold(filepath.Ext(relative), ".md") {
			mutation = []byte(fmt.Sprintf("\nFull-text layout mutation %s %05d.\n", name, index))
		}
		updated := append(append([]byte(nil), original.Bytes...), mutation...)
		filename := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.WriteFile(filename, updated, original.Mode); err != nil {
			return nil, 0, 0, matrixChangedTypes{}, err
		}
		mtime := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(index+1) * time.Second)
		if err := os.Chtimes(filename, mtime, mtime); err != nil {
			return nil, 0, 0, matrixChangedTypes{}, err
		}
		oldBytes += int64(len(original.Bytes))
		newBytes += int64(len(updated))
		if extIsPage(strings.ToLower(filepath.Ext(relative))) {
			changedTypes.Pages++
		} else {
			changedTypes.Resources++
		}
	}
	updated, err := matrixReadSources(root)
	if err != nil {
		return nil, 0, 0, matrixChangedTypes{}, err
	}
	changed := matrixChangedPathList(sources, updated)
	if len(changed) != len(selected) {
		return nil, 0, 0, matrixChangedTypes{}, fmt.Errorf("selected %d paths but observed %d changes", len(selected), len(changed))
	}
	return changed, oldBytes, newBytes, changedTypes, nil
}

func stateLayoutRestoreSources(root string, original []matrixSourceFile) error {
	wanted := make(map[string]matrixSourceFile, len(original))
	for _, file := range original {
		wanted[file.RelativePath] = file
	}
	current, err := matrixReadSources(root)
	if err != nil {
		return err
	}
	for _, file := range current {
		if _, keep := wanted[file.RelativePath]; keep {
			continue
		}
		if err := os.Remove(filepath.Join(root, filepath.FromSlash(file.RelativePath))); err != nil {
			return err
		}
	}
	for _, file := range original {
		filename := filepath.Join(root, filepath.FromSlash(file.RelativePath))
		if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(filename, file.Bytes, file.Mode); err != nil {
			return err
		}
		if err := os.Chtimes(filename, file.ModTime, file.ModTime); err != nil {
			return err
		}
	}
	return nil
}

func stateLayoutSourceBytes(sources []matrixSourceFile) int64 {
	var size int64
	for _, file := range sources {
		size += int64(len(file.Bytes))
	}
	return size
}

func stateLayoutSample(values []string, maxItems int) []string {
	if len(values) > maxItems {
		values = values[:maxItems]
	}
	return append([]string(nil), values...)
}

func stateLayoutR2Estimate(calls stateLayoutCallCounts, storedBytes int64, runs, dailyPeakDays int) stateLayoutR2Cost {
	if runs <= 0 {
		runs = 1
	}
	classA := calls.Put + calls.ListWireRequests
	classB := calls.Head + calls.Get
	storageGB := float64(storedBytes) / float64(1_000_000_000)
	requestUSD := float64(classA)/1_000_000*4.50 + float64(classB)/1_000_000*0.36
	storageUSD := storageGB * 0.015
	monthlyA, monthlyB := classA*runs, classB*runs
	monthlyStorageOverFree := math.Max(0, storageGB-10)
	return stateLayoutR2Cost{ClassARequests: classA, ClassBRequests: classB, DeleteFreeRequests: calls.Delete,
		StorageGBMonth: storageGB, UnroundedRequestUSD: requestUSD, UnroundedStorageUSD: storageUSD, UnroundedTotalUSD: requestUSD + storageUSD,
		MonthlyClassA: monthlyA, MonthlyClassB: monthlyB, MonthlyClassAOverFree: max(0, monthlyA-1_000_000),
		MonthlyClassBOverFree: max(0, monthlyB-10_000_000), MonthlyClassARounded: roundBillableMillion(monthlyA, 1_000_000),
		MonthlyClassBRounded: roundBillableMillion(monthlyB, 10_000_000), MonthlyStorageGB: storageGB,
		MonthlyStorageOverFree: monthlyStorageOverFree,
		MonthlyStorageRounded:  math.Ceil(monthlyStorageOverFree),
		MonthlyTotalUSD: float64(roundBillableMillion(monthlyA, 1_000_000))/1_000_000*4.50 +
			float64(roundBillableMillion(monthlyB, 10_000_000))/1_000_000*0.36 + math.Ceil(monthlyStorageOverFree)*0.015}
}

func roundBillableMillion(total, free int) int {
	billable := max(0, total-free)
	if billable == 0 {
		return 0
	}
	return ((billable + 999_999) / 1_000_000) * 1_000_000
}

func stateLayoutDeterministicGzip(data []byte) ([]byte, error) {
	var out bytes.Buffer
	writer, err := gzip.NewWriterLevel(&out, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	writer.Header.ModTime = time.Time{}
	writer.Header.Name, writer.Header.Comment, writer.Header.OS = "", "", 255
	if _, err := writer.Write(data); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func stateLayoutHash(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func stateLayoutCanonicalJSON(value any) ([]byte, error) { return json.Marshal(value) }

func stateLayoutRowsByKey(rows []sitePublishObject) map[string]sitePublishObject {
	result := make(map[string]sitePublishObject, len(rows))
	for _, row := range rows {
		result[row.Key] = row
	}
	return result
}

func stateLayoutObjectBytes(rows []sitePublishObject) int64 {
	var total int64
	for _, row := range rows {
		total += row.Size
	}
	return total
}

func stateLayoutDirName(key, site string) (string, string) {
	for _, area := range []string{"_artifacts/" + site + "/", "_indexes/" + site + "/"} {
		if strings.HasPrefix(key, area) {
			relative := strings.TrimPrefix(key, area)
			return strings.TrimSuffix(area, "/"), path.Dir(relative)
		}
	}
	return "", ""
}
