package publisher

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

// This separate opt-in sweep consumes the same actual BuildPrepared output as
// the layout prototype test. It owns workload cardinality and cost aggregation;
// it does not change the publisher or claim provider-wire measurements.
const (
	stateLayoutSweepEnv       = "ARTIFACT_PAGES_STATE_LAYOUT_SWEEP"
	stateLayoutSweepProfile   = "ARTIFACT_PAGES_STATE_LAYOUT_SWEEP_PROFILE"
	stateLayoutSweepOutputEnv = "ARTIFACT_PAGES_STATE_LAYOUT_SWEEP_OUTPUT"
	stateLayoutSweepMarker    = "zzt19layoutsweepdeltaproof"
)

var stateLayoutSweepSizes = []int{10, 100, 1000, 5000, 10000}

const (
	stateLayoutR2BillingGBBytes int64 = 1_000_000_000
	stateLayoutS3BillingGBBytes int64 = 1_073_741_824
)

func TestSitePublishStateLayoutSweep(t *testing.T) {
	if os.Getenv(stateLayoutSweepEnv) != "1" {
		t.Skip("set ARTIFACT_PAGES_STATE_LAYOUT_SWEEP=1 to run the state-layout workload sweep")
	}
	profile := os.Getenv(stateLayoutSweepProfile)
	if profile == "" {
		profile = "full"
	}
	sizes := stateLayoutSweepSizes
	includeMonthly := false
	if profile == "smoke" {
		sizes = []int{1000}
	} else if profile == "monthly" {
		sizes = []int{1000}
		includeMonthly = true
	} else if profile != "full" {
		t.Fatalf("unsupported %s=%q (want smoke, monthly, or full)", stateLayoutSweepProfile, profile)
	}

	ctx := context.Background()
	root, err := matrixGitRoot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(root, ".local", "publish-scale-state-layout-sweep", "work")
	if err := os.RemoveAll(work); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(work, 0o700); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(work)

	variants := stateLayoutSweepVariants()
	report := stateLayoutSweepReport{
		SchemaVersion:  3,
		Profile:        profile,
		Model:          "prototype serialized-state operations and actual indexer desired projections; not provider-wire captures or shipped adapters",
		Seed:           sitePublishStateLayoutSeed,
		SourceRevision: stateLayoutSweepDatasetCurrentBuildInputs(t, root),
		HarnessFiles:   []string{"cli/internal/publisher/site_publish_difference_matrix_test.go", "cli/internal/publisher/site_publish_state_layout_matrix_test.go", "cli/internal/publisher/site_publish_state_layout_sweep_test.go"},
		HarnessSHA256:  stateLayoutSweepHarnessDigest(t, root),
		GoVersion:      runtime.Version(),
		Pricing:        stateLayoutSweepPricingSnapshot(),
		ProviderNotes: []string{
			"State-only operations are isolated from common artifact/index projection deltas; request counters are prototype-store logical operations.",
			"emptyPrefixCommittedSnapshot reports the exact serialized private-state body PUT count/bytes needed to seed one already-committed snapshot. It is not the complete first-publish transaction: it excludes the pending-state CAS, the common cache-retry journal, projection uploads, registry/preview work, and missing-state inventory's two LISTs plus HEADs for listed objects.",
			"InputRootMatches is a prepared-fingerprint eligibility result in this harness, not a captured PublishSite.BuildSkipped field; no-op counters assert one HEAD and no state-body or mutation calls.",
			"ListWireRequests models one charged list request per 1,000 listed keys; no HTTP headers, TLS bytes, or unobserved adapter calls are inferred.",
			"Per-scenario stored-GB-month costs assume the measured final state remains stored for a full month; the monthly replay instead measures R2's average daily persistent-storage peak.",
			"S3 external-runner transfer below is only compressed state object-body bytes read; it excludes list response bodies and HTTP protocol overhead and is a lower bound.",
			"Storage uses decimal GB for R2 (1,000,000,000 bytes, Cloudflare calculator) and binary GB for S3 (1,073,741,824 bytes, AWS S3 pricing docs).",
			"The S3 internet-egress allowance-available amount assumes the entire shared 100 GB is unused by all AWS services; the second amount assumes it has already been consumed.",
			"CloudFront viewer delivery and invalidation are common to all layouts and are outside the private _control state comparison.",
			"R2 standalone modeled bills treat this isolated state workload as the account's only usage and allocate it the complete Standard free allowance; marginal rates are reported before allowance and billing-unit rounding. The full publisher also uses requests for locks, cache retry, registry, preview pruning, and projection, so its account-level remaining allowance must be computed after aggregating those common operations.",
			"Persistent monthly replay executes serialized transitions on one store per variant; no-op runs execute exactly and changed runs use only a verified periodic cycle. R2 uses measured per-attempt transient and committed per-day storage peaks. S3 storage is shown as a conservative daily-peak upper bound because this harness does not assign real timestamps/durations to updates; it is not a time-weighted S3 invoice estimate.",
			"A bounded topology sensitivity remaps actual builder rows into synthetic flat/deep/broad/skewed key shapes; it isolates state-tree topology only and does not assert document-link correctness for remapped paths.",
			"S3 versioning is Suspended in the checked-in AWS module source, but deployed bucket state was not queried. Versioning-enabled storage is reported only as a conservative upper-bound sensitivity based on incoming state-body write volume, not an invoice estimate.",
		},
	}
	started := time.Now()
	for _, size := range sizes {
		dataset, err := stateLayoutSweepDatasetRun(t, ctx, root, work, size, variants, includeMonthly)
		if err != nil {
			t.Fatalf("size %d: %v", size, err)
		}
		report.Datasets = append(report.Datasets, dataset)
		if size == 1000 {
			topology, err := stateLayoutSweepTopologyRun(t, ctx, root, work, variants)
			if err != nil {
				t.Fatalf("topology sensitivity: %v", err)
			}
			report.Topology = append(report.Topology, topology)
		}
	}
	report.ElapsedMS = durationMS(time.Since(started))
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	out := os.Getenv(stateLayoutSweepOutputEnv)
	if out == "" {
		out = filepath.Join(root, ".local", "publish-scale-state-layout-sweep", "state-layout-sweep.json")
	} else if !filepath.IsAbs(out) {
		out = filepath.Join(root, out)
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(out, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Logf("SITE_PUBLISH_STATE_LAYOUT_SWEEP_JSON=%s", out)
	t.Logf("SITE_PUBLISH_STATE_LAYOUT_SWEEP_SUMMARY profile=%s datasets=%d variants=%d elapsedMs=%.1f", profile, len(report.Datasets), len(variants), report.ElapsedMS)
}

type stateLayoutSweepReport struct {
	SchemaVersion  int                       `json:"schemaVersion"`
	Profile        string                    `json:"profile"`
	Model          string                    `json:"model"`
	Seed           int64                     `json:"seed"`
	SourceRevision string                    `json:"sourceRevision"`
	HarnessFiles   []string                  `json:"harnessFiles"`
	HarnessSHA256  string                    `json:"harnessSha256"`
	GoVersion      string                    `json:"goVersion"`
	Pricing        stateLayoutSweepPrices    `json:"pricingSnapshot"`
	ProviderNotes  []string                  `json:"providerNotes"`
	Datasets       []stateLayoutSweepDataset `json:"datasets"`
	Topology       []stateLayoutTopology     `json:"topologySensitivity,omitempty"`
	ElapsedMS      float64                   `json:"elapsedMs"`
}

type stateLayoutSweepPrices struct {
	VerifiedDate                          string  `json:"verifiedDate"`
	R2StandardClassAUSDPerMillion         float64 `json:"r2StandardClassAUsdPerMillion"`
	R2StandardClassBUSDPerMillion         float64 `json:"r2StandardClassBUsdPerMillion"`
	R2StandardStorageUSDPerGBMonth        float64 `json:"r2StandardStorageUsdPerGbMonth"`
	R2FreeClassARequestsPerMonth          int     `json:"r2FreeClassARequestsPerMonth"`
	R2FreeClassBRequestsPerMonth          int     `json:"r2FreeClassBRequestsPerMonth"`
	R2FreeStorageGBMonth                  int     `json:"r2FreeStorageGbMonth"`
	R2BillingGBBytes                      int64   `json:"r2BillingGbBytes"`
	S3StandardUSEast1ClassAUSDPerThousand float64 `json:"s3StandardUsEast1ClassAUsdPerThousand"`
	S3StandardUSEast1ClassBUSDPerThousand float64 `json:"s3StandardUsEast1ClassBUsdPerThousand"`
	S3StandardUSEast1StorageUSDPerGBMonth float64 `json:"s3StandardUsEast1StorageUsdPerGbMonth"`
	S3BillingGBBytes                      int64   `json:"s3BillingGbBytes"`
	S3InternetFreeGBPerMonth              int     `json:"s3InternetFreeGbPerMonth"`
	S3InternetEgressUSDPerGB              float64 `json:"s3InternetEgressUsdPerGb"`
	CloudFrontFreeViewerRequestsPerMonth  int64   `json:"cloudFrontFreeViewerRequestsPerMonth"`
	CloudFrontFreeDataOutGBPerMonth       int     `json:"cloudFrontFreeDataOutGbPerMonth"`
	CloudFrontFreeInvalidationPaths       int     `json:"cloudFrontFreeInvalidationPaths"`
	CloudFrontInvalidationUSDPerPath      float64 `json:"cloudFrontInvalidationUsdPerPath"`
	R2PricingURL                          string  `json:"r2PricingUrl"`
	R2CalculatorURL                       string  `json:"r2CalculatorUrl"`
	S3PricingURL                          string  `json:"s3PricingUrl"`
	S3PriceListURL                        string  `json:"s3PriceListUrl"`
	CloudFrontPricingURL                  string  `json:"cloudFrontPricingUrl"`
	CloudFrontInvalidationURL             string  `json:"cloudFrontInvalidationUrl"`
}

type stateLayoutSweepDataset struct {
	FixtureSite                 string                       `json:"fixtureSite"`
	PublisherSite               string                       `json:"publisherSite"`
	SourceFiles                 int                          `json:"sourceFiles"`
	Pages                       int                          `json:"pages"`
	Resources                   int                          `json:"resources"`
	SourceBytes                 int64                        `json:"sourceBytes"`
	SourceSHA256                string                       `json:"sourceSha256"`
	GeneratedObjectsFullTextOff int                          `json:"generatedObjectsFullTextOff"`
	GeneratedBytesFullTextOff   int64                        `json:"generatedBytesFullTextOff"`
	GeneratedObjectsFullTextOn  int                          `json:"generatedObjectsFullTextOn"`
	GeneratedBytesFullTextOn    int64                        `json:"generatedBytesFullTextOn"`
	FullTextModes               []bool                       `json:"fullTextModes"`
	Bootstrap                   []stateLayoutBootstrapReport `json:"emptyPrefixCommittedSnapshot"`
	Scenarios                   []stateLayoutSweepScenario   `json:"scenarios"`
	MonthlyModels               []stateLayoutMonthlyModel    `json:"monthlyModels"`
}

type stateLayoutTopology struct {
	Model       string                     `json:"model"`
	SourceFiles int                        `json:"sourceFiles"`
	InputRows   int                        `json:"inputRowsFromActualBuild"`
	Shapes      []stateLayoutTopologyShape `json:"shapes"`
}

type stateLayoutTopologyShape struct {
	Name           string                        `json:"name"`
	DirectoryCount int                           `json:"directoryCount"`
	MaximumDepth   int                           `json:"maximumDepth"`
	SourceRows     int                           `json:"sourceRows"`
	Scenarios      []stateLayoutTopologyScenario `json:"scenarios"`
}

type stateLayoutTopologyScenario struct {
	Name               string                     `json:"name"`
	Distribution       string                     `json:"distribution"`
	ChangedSourcePaths int                        `json:"changedSourcePaths"`
	TouchedDirectories int                        `json:"touchedDirectories"`
	Variants           []stateLayoutVariantReport `json:"stateVariants"`
}

type stateLayoutSweepScenario struct {
	Name                    string                      `json:"name"`
	Kind                    string                      `json:"kind"`
	RateLabels              []string                    `json:"rateLabels,omitempty"`
	RequestedChanges        int                         `json:"requestedChanges"`
	Distribution            string                      `json:"distribution"`
	FullText                bool                        `json:"fullText"`
	PrepareBuildMS          float64                     `json:"prepareBuildHashMs"`
	BuildPreparedMS         float64                     `json:"buildPreparedMs"`
	BuildSkipped            bool                        `json:"buildSkippedOnMatchingRoot"`
	PrepareAndBuildMS       float64                     `json:"prepareAndBuildMs"`
	TransitionMS            float64                     `json:"transitionModelMs"`
	InputRootMatches        bool                        `json:"inputRootMatches"`
	ChangedSourcePaths      int                         `json:"changedSourcePaths"`
	AchievedChangedFraction float64                     `json:"achievedChangedFraction"`
	ChangedPathSample       []string                    `json:"changedPathSample,omitempty"`
	ChangedPages            int                         `json:"changedPages"`
	ChangedResources        int                         `json:"changedResources"`
	ChangedPathBytesBefore  int64                       `json:"changedPathBytesBefore"`
	ChangedPathBytesAfter   int64                       `json:"changedPathBytesAfter"`
	TouchedDirectories      int                         `json:"touchedDirectories"`
	InputRootChanged        bool                        `json:"inputRootChanged"`
	Projection              stateLayoutProjectionReport `json:"commonProjectionDelta"`
	CommonProjectionCost    stateLayoutCommonCost       `json:"commonProjectionCost"`
	Variants                []stateLayoutVariantReport  `json:"stateVariants"`
	Costs                   []stateLayoutSweepCost      `json:"marginalProviderCostModel"`
}

type stateLayoutSweepCost struct {
	VariantName                  string  `json:"variantName"`
	ClassARequests               int     `json:"classARequests"`
	ClassBRequests               int     `json:"classBRequests"`
	DeleteFreeRequests           int     `json:"deleteFreeRequests"`
	R2UnroundedRequestUSD        float64 `json:"r2StandardUnroundedRequestUsd"`
	S3RequestUSD                 float64 `json:"s3StandardUsEast1RequestUsd"`
	R2StandardStoredGBMonth      float64 `json:"r2StandardStoredGbMonth"`
	S3StandardStoredGBMonth      float64 `json:"s3StandardStoredGbMonth"`
	S3StateObjectBodyEgressBytes int64   `json:"s3ExternalRunnerStateObjectBodyEgressBytesLowerBound"`
	S3StateObjectBodyEgressGB    float64 `json:"s3ExternalRunnerStateObjectBodyEgressGbLowerBound"`
}

type stateLayoutCommonCost struct {
	ClassARequests      int     `json:"classARequests"`
	DeleteFreeRequests  int     `json:"deleteFreeRequests"`
	R2UnroundedUSD      float64 `json:"r2StandardUnroundedRequestUsd"`
	S3USEast1RequestUSD float64 `json:"s3StandardUsEast1RequestUsd"`
	PutBytes            int64   `json:"putBytes"`
}

type stateLayoutMonthlyModel struct {
	FullText                       bool                            `json:"fullText"`
	MixID                          string                          `json:"mixId"`
	RunMix                         string                          `json:"runMix"`
	SparseRate                     string                          `json:"sparseRate"`
	Simulation                     string                          `json:"simulation"`
	RunCount                       int                             `json:"runCount"`
	Days                           int                             `json:"days"`
	NoopRuns                       int                             `json:"noopRuns"`
	MeasuredNoopTransitions        int                             `json:"measuredNoopTransitions"`
	CountedNoopTransitions         int                             `json:"countedNoopTransitions"`
	ExtrapolatedNoopTransitions    int                             `json:"extrapolatedNoopTransitions"`
	SparseRuns                     int                             `json:"sparseRuns"`
	DenseRuns                      int                             `json:"denseRuns"`
	RenameDeleteRuns               int                             `json:"renameDeleteRuns"`
	SimulatedChangedTransitions    int                             `json:"simulatedChangedTransitions"`
	ExtrapolatedChangedTransitions int                             `json:"extrapolatedChangedTransitions"`
	VerifiedCyclePeriod            int                             `json:"verifiedCyclePeriod"`
	Variants                       []stateLayoutMonthlyVariantCost `json:"variants"`
}

type stateLayoutRunMix struct {
	ID               string
	Description      string
	SparseRate       string
	NoopRuns         int
	SparseRuns       int
	DenseRuns        int
	RenameDeleteRuns int
}

type stateLayoutMonthlyVariantCost struct {
	VariantName                           string  `json:"variantName"`
	ClassARequests                        int64   `json:"classARequests"`
	ClassBRequests                        int64   `json:"classBRequests"`
	DeleteFreeRequests                    int64   `json:"deleteFreeRequests"`
	StateBodyReadBytes                    int64   `json:"stateBodyReadBytes"`
	StateBodyWriteBytes                   int64   `json:"stateBodyWriteBytes"`
	PersistentBytesStart                  int64   `json:"persistentBytesStart"`
	PersistentBytesFinal                  int64   `json:"persistentBytesFinal"`
	MaxSingleTransitionStateBytes         int64   `json:"maxSingleTransitionStateBytes,omitempty"`
	MaximumDailyPeakBytes                 int64   `json:"maximumDailyPeakBytes"`
	AverageDailyPeakBytes                 float64 `json:"averageDailyPeakBytes"`
	DailyPeakBytes                        []int64 `json:"dailyPeakBytes"`
	RetainedOrphanBytesBeforeGC           int64   `json:"retainedOrphanBytesBeforeGc"`
	RetainedOrphanBytesAfterGC            int64   `json:"retainedOrphanBytesAfterGc"`
	GCRuns                                int     `json:"gcRuns"`
	GCClassARequests                      int     `json:"gcClassARequests"`
	GCClassBRequests                      int     `json:"gcClassBRequests"`
	GCDeleteKeys                          int     `json:"gcDeleteKeys"`
	R2StandaloneInvoiceUSD                float64 `json:"r2StandaloneStateOnlyBillIfNoOtherAccountUsageUsd"`
	R2MarginalIfAllowancesConsumedUSD     float64 `json:"r2UnroundedMarginalIfAccountAllowancesAlreadyConsumedUsd"`
	S3SameRegionRequestStorageUSD         float64 `json:"s3SameRegionRequestsPlusDailyPeakStorageUpperBoundUsd"`
	S3ExternalEgressGB                    float64 `json:"s3ExternalRunnerStateBodyEgressGbLowerBound"`
	S3ExternalBillableWithFullAllowanceGB float64 `json:"s3ExternalEgressBillableGbWithFullSharedAllowanceAvailable"`
	S3ExternalTotalUSD                    float64 `json:"s3ExternalRunnerMonthlyRequestsPlusDailyPeakStorageUpperBoundAndEgressWithFullSharedAllowanceAvailableUsd"`
	S3ExternalTotalIfAllowanceConsumedUSD float64 `json:"s3ExternalRunnerMonthlyRequestsPlusDailyPeakStorageUpperBoundAndEgressIfSharedAllowanceConsumedUsd"`
	S3Versioning7DayAdditionalUSD         float64 `json:"s3Versioning7DayAdditionalStorageUsdUpperBound"`
	S3Versioning30DayAdditionalUSD        float64 `json:"s3Versioning30DayAdditionalStorageUsdUpperBound"`
	S3Versioning7DayAverageBytes          float64 `json:"s3Versioning7DayAverageAdditionalBytesUpperBound"`
	S3Versioning30DayAverageBytes         float64 `json:"s3Versioning30DayAverageAdditionalBytesUpperBound"`
	StorageBasis                          string  `json:"storageBasis"`
}

func stateLayoutSweepPricingSnapshot() stateLayoutSweepPrices {
	return stateLayoutSweepPrices{
		VerifiedDate:                  "2026-10-04",
		R2StandardClassAUSDPerMillion: 4.50, R2StandardClassBUSDPerMillion: 0.36, R2StandardStorageUSDPerGBMonth: 0.015,
		R2FreeClassARequestsPerMonth: 1_000_000, R2FreeClassBRequestsPerMonth: 10_000_000, R2FreeStorageGBMonth: 10,
		R2BillingGBBytes: stateLayoutR2BillingGBBytes, S3BillingGBBytes: stateLayoutS3BillingGBBytes,
		S3StandardUSEast1ClassAUSDPerThousand: 0.005, S3StandardUSEast1ClassBUSDPerThousand: 0.0004,
		S3StandardUSEast1StorageUSDPerGBMonth: 0.023, S3InternetFreeGBPerMonth: 100, S3InternetEgressUSDPerGB: 0.09,
		CloudFrontFreeViewerRequestsPerMonth: 10_000_000, CloudFrontFreeDataOutGBPerMonth: 1024,
		CloudFrontFreeInvalidationPaths: 1000, CloudFrontInvalidationUSDPerPath: 0.005,
		R2PricingURL:              "https://developers.cloudflare.com/r2/pricing/",
		R2CalculatorURL:           "https://r2-calculator.cloudflare.com/",
		S3PricingURL:              "https://aws.amazon.com/s3/pricing/",
		S3PriceListURL:            "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json",
		CloudFrontPricingURL:      "https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/",
		CloudFrontInvalidationURL: "https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PayingForInvalidation.html",
	}
}

func stateLayoutSweepVariants() []stateLayoutVariant {
	base := stateLayoutVariants()
	var out []stateLayoutVariant
	codecs := make(map[string]stateLayoutVariant)
	for _, variant := range base {
		if variant.layout == "fixed-two-slot" {
			codecs[variant.codec] = variant
			continue
		}
		out = append(out, variant)
	}
	for _, count := range []int{1, 4, 16, 64, 128, 256} {
		codecNames := make([]string, 0, len(codecs))
		for name := range codecs {
			codecNames = append(codecNames, name)
		}
		sort.Strings(codecNames)
		for _, codec := range codecNames {
			variant := codecs[codec]
			variant.shardCount = count
			variant.name = fmt.Sprintf("fixed-k%d-%s", count, strings.TrimSuffix(codec, "-v1"))
			out = append(out, variant)
		}
	}
	return out
}

func stateLayoutSweepDatasetRun(t *testing.T, ctx context.Context, root, work string, size int, variants []stateLayoutVariant, includeMonthly bool) (stateLayoutSweepDataset, error) {
	t.Helper()
	fixtureSite := fmt.Sprintf("verify-scale-%d", size)
	siteID := fmt.Sprintf("verify-layout-%d", size)
	fixtureSource := filepath.Join(root, "fixtures", "scale", "sites", fixtureSite, "source")
	profile := matrixCountSource(t, fixtureSource)
	if profile.SourceFiles != size {
		return stateLayoutSweepDataset{}, fmt.Errorf("fixture %s has %d source files, want %d", fixtureSite, profile.SourceFiles, size)
	}
	source := filepath.Join(work, fixtureSite, "source")
	if err := copyScaleTree(fixtureSource, source); err != nil {
		return stateLayoutSweepDataset{}, err
	}
	original, err := matrixReadSources(source)
	if err != nil {
		return stateLayoutSweepDataset{}, err
	}
	dataset := stateLayoutSweepDataset{FixtureSite: fixtureSite, PublisherSite: siteID,
		SourceFiles: profile.SourceFiles, Pages: profile.Pages, Resources: profile.Resources,
		SourceBytes: stateLayoutSourceBytes(original), SourceSHA256: matrixSourcesDigest(original), FullTextModes: []bool{false, true}}
	baseOff, err := layoutBuildProjection(ctx, t, root, work, source, siteID, layoutBuildOptions{FullText: false})
	if err != nil {
		return dataset, err
	}
	baseOn, err := layoutBuildProjection(ctx, t, root, work, source, siteID, layoutBuildOptions{FullText: true})
	if err != nil {
		return dataset, err
	}
	dataset.GeneratedObjectsFullTextOff, dataset.GeneratedBytesFullTextOff = stateLayoutGeneratedProjectionSize(baseOff)
	dataset.GeneratedObjectsFullTextOn, dataset.GeneratedBytesFullTextOn = stateLayoutGeneratedProjectionSize(baseOn)
	for _, fullTextProjection := range []struct {
		projection layoutProjection
		fullText   bool
	}{{baseOff, false}, {baseOn, true}} {
		for _, variant := range variants {
			bootstrap, err := stateLayoutBootstrap(siteID, fullTextProjection.projection, variant, fullTextProjection.fullText)
			if err != nil {
				return dataset, fmt.Errorf("bootstrap %s fulltext=%t: %w", variant.name, fullTextProjection.fullText, err)
			}
			dataset.Bootstrap = append(dataset.Bootstrap, bootstrap)
		}
	}
	core := matrixCoreScenarios(size)
	monthlyScenarioNames := make(map[string]map[string]string)
	for _, spec := range core {
		name := spec.Name
		buildMS := 0.0
		before := baseOff
		if spec.Count == 0 {
			caseReport, err := stateLayoutSweepCompare(t, siteID, stateLayoutScenario{name: name, kind: spec.Kind, count: spec.Count,
				distribution: spec.Distribution, fullText: false}, before, before, variants)
			if err != nil {
				return dataset, err
			}
			caseReport.RateLabels = append([]string(nil), spec.RateLabels...)
			dataset.Scenarios = append(dataset.Scenarios, caseReport)
			if containsString(spec.RateLabels, "0%") && spec.Distribution == "none" {
				monthlyScenarioNames["off"] = stateLayoutSweepEnsureMap(monthlyScenarioNames["off"])
				monthlyScenarioNames["off"]["noop"] = name
			}
			continue
		}
		if err := stateLayoutSweepRestore(source, original, nil); err != nil {
			return dataset, err
		}
		mutation := stateLayoutScenario{name: name, kind: spec.Kind, count: spec.Count,
			distribution: spec.Distribution, fullText: false}
		changed, oldBytes, newBytes, kinds, err := matrixMutateSources(source, original, spec, size)
		if err != nil {
			return dataset, fmt.Errorf("mutate %s: %w", name, err)
		}
		start := time.Now()
		desired, err := layoutBuildProjection(ctx, t, root, work, source, siteID, layoutBuildOptions{FullText: false})
		buildMS = durationMS(time.Since(start))
		if err != nil {
			return dataset, fmt.Errorf("build %s: %w", name, err)
		}
		caseReport, err := stateLayoutSweepCompare(t, siteID, mutation, before, desired, variants)
		if err != nil {
			return dataset, err
		}
		caseReport.RateLabels = append([]string(nil), spec.RateLabels...)
		caseReport.PrepareAndBuildMS = buildMS
		stateLayoutSweepRecordMutation(&caseReport, changed, oldBytes, newBytes, kinds, profile.SourceFiles)
		dataset.Scenarios = append(dataset.Scenarios, caseReport)
		if containsString(spec.RateLabels, "1%") && spec.Distribution == "uniform-scattered" {
			monthlyScenarioNames["off"] = stateLayoutSweepEnsureMap(monthlyScenarioNames["off"])
			monthlyScenarioNames["off"]["sparse1"] = name
		}
		if containsString(spec.RateLabels, "0.1%") && spec.Distribution == "uniform-scattered" {
			monthlyScenarioNames["off"] = stateLayoutSweepEnsureMap(monthlyScenarioNames["off"])
			monthlyScenarioNames["off"]["sparse01"] = name
		}
		if spec.Count == size && spec.Distribution == "all" {
			monthlyScenarioNames["off"] = stateLayoutSweepEnsureMap(monthlyScenarioNames["off"])
			monthlyScenarioNames["off"]["dense"] = name
		}
		if err := stateLayoutSweepRestore(source, original, changed); err != nil {
			return dataset, err
		}
	}
	// Full-text-on no-op/sparse/dense rows make a second, explicitly labeled
	// monthly workload model without doubling the entire matrix.
	for _, spec := range core {
		if !(spec.Count == 0 && spec.Distribution == "none" ||
			(containsString(spec.RateLabels, "1%") || containsString(spec.RateLabels, "0.1%")) && spec.Distribution == "uniform-scattered" ||
			spec.Count == size && spec.Distribution == "all") {
			continue
		}
		name := "fulltext-on-" + spec.Name
		if spec.Count == 0 {
			caseReport, err := stateLayoutSweepCompare(t, siteID, stateLayoutScenario{name: name, kind: "no-op", distribution: "none", fullText: true}, baseOn, baseOn, variants)
			if err != nil {
				return dataset, err
			}
			caseReport.RateLabels = []string{"0%"}
			dataset.Scenarios = append(dataset.Scenarios, caseReport)
			monthlyScenarioNames["on"] = stateLayoutSweepEnsureMap(monthlyScenarioNames["on"])
			monthlyScenarioNames["on"]["noop"] = name
			continue
		}
		if err := stateLayoutSweepRestore(source, original, nil); err != nil {
			return dataset, err
		}
		changed, oldBytes, newBytes, kinds, err := matrixMutateSources(source, original, spec, size)
		if err != nil {
			return dataset, fmt.Errorf("mutate %s: %w", name, err)
		}
		buildStarted := time.Now()
		desired, err := layoutBuildProjection(ctx, t, root, work, source, siteID, layoutBuildOptions{FullText: true})
		buildMS := durationMS(time.Since(buildStarted))
		if err != nil {
			return dataset, err
		}
		caseReport, err := stateLayoutSweepCompare(t, siteID, stateLayoutScenario{name: name, kind: spec.Kind, count: spec.Count,
			distribution: spec.Distribution, fullText: true}, baseOn, desired, variants)
		if err != nil {
			return dataset, err
		}
		caseReport.RateLabels = append([]string(nil), spec.RateLabels...)
		caseReport.PrepareAndBuildMS = buildMS
		stateLayoutSweepRecordMutation(&caseReport, changed, oldBytes, newBytes, kinds, profile.SourceFiles)
		dataset.Scenarios = append(dataset.Scenarios, caseReport)
		if spec.Count == size && spec.Distribution == "all" {
			monthlyScenarioNames["on"] = stateLayoutSweepEnsureMap(monthlyScenarioNames["on"])
			monthlyScenarioNames["on"]["dense"] = name
		}
		if err := stateLayoutSweepRestore(source, original, changed); err != nil {
			return dataset, err
		}
	}
	// Full-text sparse page-only cases vary directory locality independently of
	// resources, so search object changes are measured under each path shape.
	if size >= 100 {
		labels := []string{"1%"}
		if size >= 1000 {
			labels = []string{"0.1%", "1%"}
		}
		for _, label := range labels {
			count := max(1, int(math.Round(float64(size)*map[string]float64{"0.1%": .001, "1%": .01}[label])))
			for _, distribution := range []string{"uniform-scattered", "clustered", "skewed-80-subtree"} {
				name := fmt.Sprintf("fulltext-page-only-%s-%s", label, distribution)
				if err := stateLayoutSweepRestore(source, original, nil); err != nil {
					return dataset, err
				}
				changed, oldBytes, newBytes, kinds, err := stateLayoutSweepMutateKind(source, original, count, distribution, "page", name)
				if err != nil {
					return dataset, err
				}
				buildStarted := time.Now()
				desired, err := layoutBuildProjection(ctx, t, root, work, source, siteID, layoutBuildOptions{FullText: true})
				buildMS := durationMS(time.Since(buildStarted))
				if err != nil {
					return dataset, err
				}
				caseReport, err := stateLayoutSweepCompare(t, siteID, stateLayoutScenario{name: name, kind: "page-only", count: count,
					distribution: distribution, fullText: true}, baseOn, desired, variants)
				if err != nil {
					return dataset, err
				}
				caseReport.RateLabels = []string{label}
				caseReport.PrepareAndBuildMS = buildMS
				stateLayoutSweepRecordMutation(&caseReport, changed, oldBytes, newBytes, kinds, profile.SourceFiles)
				searchChanged := stateLayoutChangedSearchObjects(baseOn, desired, siteID)
				if kinds.Pages != len(changed) || caseReport.Projection.ChangedGeneratedCount == 0 || searchChanged == 0 || !stateLayoutSearchRootContains(desired, siteID, stateLayoutSweepMarker) || stateLayoutSearchRootContains(baseOn, siteID, stateLayoutSweepMarker) {
					return dataset, fmt.Errorf("%s failed page/fulltext projection assertion: pages=%d generated=%d changedSearch=%d markerPresent=%t", name, kinds.Pages, caseReport.Projection.ChangedGeneratedCount, searchChanged, stateLayoutSearchRootContains(desired, siteID, stateLayoutSweepMarker))
				}
				dataset.Scenarios = append(dataset.Scenarios, caseReport)
				if distribution == "uniform-scattered" {
					monthlyScenarioNames["on"] = stateLayoutSweepEnsureMap(monthlyScenarioNames["on"])
					if label == "0.1%" {
						monthlyScenarioNames["on"]["sparse01"] = name
					} else {
						monthlyScenarioNames["on"]["sparse1"] = name
					}
				}
				if err := stateLayoutSweepRestore(source, original, changed); err != nil {
					return dataset, err
				}
			}
		}
	}
	// Source resource-only sparse workloads expose whether byte-only changes
	// leave generated search/index rows stable. Include all three distributions.
	for _, distribution := range []string{"uniform-scattered", "clustered", "skewed-80-subtree"} {
		count := max(1, int(math.Round(float64(size)*.01)))
		name := "resource-only-1-percent-" + distribution
		if err := stateLayoutSweepRestore(source, original, nil); err != nil {
			return dataset, err
		}
		changed, oldBytes, newBytes, kinds, err := stateLayoutSweepMutateKind(source, original, count, distribution, "resource", name)
		if err != nil {
			return dataset, err
		}
		buildStarted := time.Now()
		desired, err := layoutBuildProjection(ctx, t, root, work, source, siteID, layoutBuildOptions{FullText: false})
		buildMS := durationMS(time.Since(buildStarted))
		if err != nil {
			return dataset, err
		}
		caseReport, err := stateLayoutSweepCompare(t, siteID, stateLayoutScenario{name: name, kind: "resource-only", count: count,
			distribution: distribution, fullText: false}, baseOff, desired, variants)
		if err != nil {
			return dataset, err
		}
		caseReport.RateLabels = []string{"1%"}
		caseReport.PrepareAndBuildMS = buildMS
		stateLayoutSweepRecordMutation(&caseReport, changed, oldBytes, newBytes, kinds, profile.SourceFiles)
		dataset.Scenarios = append(dataset.Scenarios, caseReport)
		if err := stateLayoutSweepRestore(source, original, changed); err != nil {
			return dataset, err
		}
	}
	// Rename/delete mixes one indexed page removal with one resource rename.
	if err := stateLayoutSweepRestore(source, original, nil); err != nil {
		return dataset, err
	}
	renameName := "rename-resource-and-delete-page"
	changed, oldBytes, newBytes, kinds, err := stateLayoutMutate(source, original,
		stateLayoutScenario{name: renameName, kind: "rename-delete", distribution: "fixed-first-pair", fullText: false})
	if err != nil {
		return dataset, err
	}
	buildStarted := time.Now()
	desiredRename, err := layoutBuildProjection(ctx, t, root, work, source, siteID, layoutBuildOptions{FullText: false})
	buildMS := durationMS(time.Since(buildStarted))
	if err != nil {
		return dataset, err
	}
	renameReport, err := stateLayoutSweepCompare(t, siteID, stateLayoutScenario{name: renameName, kind: "rename-delete", distribution: "fixed-first-pair", fullText: false}, baseOff, desiredRename, variants)
	if err != nil {
		return dataset, err
	}
	renameReport.PrepareAndBuildMS = buildMS
	stateLayoutSweepRecordMutation(&renameReport, changed, oldBytes, newBytes, kinds, profile.SourceFiles)
	dataset.Scenarios = append(dataset.Scenarios, renameReport)
	if err := stateLayoutSweepRestore(source, original, changed); err != nil {
		return dataset, err
	}
	// Site metadata and global build policy changes alter the input root even
	// when source bytes are fixed; these are part of the no-op/diff cost model.
	globalChanges := []struct {
		name    string
		options layoutBuildOptions
	}{
		{name: "global-site-title-change", options: layoutBuildOptions{FullText: true, Title: "State Layout Verification Renamed"}},
		{name: "global-repository-ref-change", options: layoutBuildOptions{FullText: true, Repository: "verification/state-layout-other", RepositoryURL: "https://example.invalid/verification/other", Ref: "layout-next"}},
		{name: "global-builder-policy-change", options: layoutBuildOptions{FullText: true, InputPolicy: sitePublishInputPolicy + "+state-layout-policy-v2"}},
	}
	for _, global := range globalChanges {
		buildStarted := time.Now()
		desired, err := layoutBuildProjection(ctx, t, root, work, source, siteID, global.options)
		buildMS := durationMS(time.Since(buildStarted))
		if err != nil {
			return dataset, err
		}
		caseReport, err := stateLayoutSweepCompare(t, siteID, stateLayoutScenario{name: global.name, kind: "global-input-change", distribution: "none", fullText: true}, baseOn, desired, variants)
		if err != nil {
			return dataset, err
		}
		caseReport.PrepareAndBuildMS = buildMS
		caseReport.InputRootChanged = baseOn.InputRoot != desired.InputRoot
		if !caseReport.InputRootChanged {
			return dataset, fmt.Errorf("%s did not alter input root", global.name)
		}
		dataset.Scenarios = append(dataset.Scenarios, caseReport)
	}
	// Projection policy toggles have no source mutation but must withdraw or
	// recreate all full-text-only objects as the builder contract requires.
	for _, toggle := range []struct {
		name     string
		from, to layoutProjection
		fullText bool
	}{
		{name: "fulltext-off-to-on", from: baseOff, to: baseOn, fullText: true},
		{name: "fulltext-on-to-off", from: baseOn, to: baseOff, fullText: false},
	} {
		caseReport, err := stateLayoutSweepCompare(t, siteID, stateLayoutScenario{name: toggle.name, kind: "fulltext-toggle", distribution: "none", fullText: toggle.fullText}, toggle.from, toggle.to, variants)
		if err != nil {
			return dataset, err
		}
		dataset.Scenarios = append(dataset.Scenarios, caseReport)
	}
	if includeMonthly && size == 1000 {
		allPaths := make([]string, 0, len(original))
		for _, file := range original {
			allPaths = append(allPaths, file.RelativePath)
		}
		for _, fullText := range []bool{false, true} {
			initial := baseOff
			if fullText {
				initial = baseOn
			}
			snapshots, err := stateLayoutSweepMonthlySnapshots(t, ctx, root, work, source, original, allPaths, siteID, fullText, initial)
			if err != nil {
				return dataset, err
			}
			for _, mix := range stateLayoutSweepRunMixes("sparse1") {
				monthly, err := stateLayoutSweepPersistentMonthly(t, siteID, initial, snapshots, variants, fullText, mix, 30)
				if err != nil {
					return dataset, err
				}
				dataset.MonthlyModels = append(dataset.MonthlyModels, monthly)
			}
		}
	}
	return dataset, nil
}

func stateLayoutSweepCompare(t *testing.T, site string, scenario stateLayoutScenario, before, after layoutProjection, variants []stateLayoutVariant) (stateLayoutSweepScenario, error) {
	return stateLayoutSweepCompareInner(t, site, scenario, before, after, variants)
}

func stateLayoutSweepCompareInner(t *testing.T, site string, scenario stateLayoutScenario, before, after layoutProjection, variants []stateLayoutVariant) (stateLayoutSweepScenario, error) {
	started := time.Now()
	result, err := stateLayoutCompareScenario(t, site, scenario, before, after, variants)
	if err != nil {
		return stateLayoutSweepScenario{}, err
	}
	caseReport := stateLayoutSweepScenario{Kind: scenario.kind, RequestedChanges: scenario.count,
		Distribution: scenario.distribution, FullText: scenario.fullText, InputRootChanged: before.InputRoot != after.InputRoot,
		Projection: result.Projection, Variants: result.Variants, TransitionMS: durationMS(time.Since(started))}
	caseReport.InputRootMatches = before.InputRoot == after.InputRoot
	if caseReport.InputRootMatches {
		caseReport.PrepareBuildMS = before.PrepareBuildMS
		caseReport.BuildSkipped = true
		caseReport.PrepareAndBuildMS = before.PrepareBuildMS
	} else {
		caseReport.PrepareBuildMS = after.PrepareBuildMS
		caseReport.BuildPreparedMS = after.BuildPreparedMS
		caseReport.PrepareAndBuildMS = after.PrepareBuildMS + after.BuildPreparedMS
	}
	caseReport.CommonProjectionCost = stateLayoutSweepCommonCost(result.Projection)
	caseReport.Name = scenario.name
	for _, variant := range result.Variants {
		if caseReport.InputRootMatches {
			calls := variant.StateCalls
			if calls.Head != 1 || calls.Get != 0 || calls.Put != 0 || calls.List != 0 || calls.ListWireRequests != 0 || calls.Delete != 0 || variant.StateBodyReadBytes != 0 || variant.StateBodyWriteBytes != 0 || variant.PersistentBytesBefore != variant.PersistentBytesAfter {
				return stateLayoutSweepScenario{}, fmt.Errorf("no-op state transition for %s issued unexpected calls: %+v", variant.Name, calls)
			}
		}
		caseReport.Costs = append(caseReport.Costs, stateLayoutSweepCostForVariant(variant))
	}
	return caseReport, nil
}

func stateLayoutSweepCommonCost(projection stateLayoutProjectionReport) stateLayoutCommonCost {
	return stateLayoutCommonCost{ClassARequests: projection.Puts, DeleteFreeRequests: projection.Deletes,
		R2UnroundedUSD:      float64(projection.Puts) * 4.50 / 1_000_000,
		S3USEast1RequestUSD: float64(projection.Puts) * 0.005 / 1000,
		PutBytes:            projection.PutBytes}
}

func stateLayoutSweepCostForVariant(variant stateLayoutVariantReport) stateLayoutSweepCost {
	calls := variant.StateCalls
	classA := calls.Put + calls.ListWireRequests
	classB := calls.Head + calls.Get
	bytes := variant.StateBodyReadBytes
	gb := float64(bytes) / float64(stateLayoutS3BillingGBBytes)
	r2StateGBMonth := float64(variant.PersistentBytesAfter) / float64(stateLayoutR2BillingGBBytes)
	s3StateGBMonth := float64(variant.PersistentBytesAfter) / float64(stateLayoutS3BillingGBBytes)
	return stateLayoutSweepCost{VariantName: variant.Name, ClassARequests: classA, ClassBRequests: classB,
		DeleteFreeRequests: calls.Delete, R2UnroundedRequestUSD: float64(classA)*4.50/1_000_000 + float64(classB)*0.36/1_000_000,
		S3RequestUSD:            float64(classA)*0.005/1000 + float64(classB)*0.0004/1000,
		R2StandardStoredGBMonth: r2StateGBMonth, S3StandardStoredGBMonth: s3StateGBMonth,
		S3StateObjectBodyEgressBytes: bytes, S3StateObjectBodyEgressGB: gb}
}

func stateLayoutSweepTopologyRun(t *testing.T, ctx context.Context, root, work string, variants []stateLayoutVariant) (stateLayoutTopology, error) {
	t.Helper()
	const size = 1000
	const fixtureSite = "verify-scale-1000"
	const site = "verify-layout-topology"
	fixtureSource := filepath.Join(root, "fixtures", "scale", "sites", fixtureSite, "source")
	profile := matrixCountSource(t, fixtureSource)
	source := filepath.Join(work, "topology", "source")
	if err := copyScaleTree(fixtureSource, source); err != nil {
		return stateLayoutTopology{}, err
	}
	actual, err := layoutBuildProjection(ctx, t, root, work, source, site, layoutBuildOptions{FullText: false})
	if err != nil {
		return stateLayoutTopology{}, err
	}
	report := stateLayoutTopology{Model: "synthetic key-topology sensitivity over actual indexer BuildPrepared output; source object paths are remapped after build; generated rows and object bytes/HTTP metadata are preserved. This isolates state-tree fanout/depth and does not claim remapped pages remain link-correct.",
		SourceFiles: profile.SourceFiles, InputRows: len(actual.Rows)}
	for _, shapeName := range []string{"flat", "deep-12", "broad-1000", "skewed-80-subtree"} {
		base, shape, err := stateLayoutSweepRelayout(actual, site, shapeName)
		if err != nil {
			return report, err
		}
		shapeReport := stateLayoutTopologyShape{Name: shapeName, DirectoryCount: shape.directoryCount,
			MaximumDepth: shape.maximumDepth, SourceRows: len(shape.sourceKeys)}
		scenarios := []struct {
			name, distribution string
			count              int
		}{
			{name: "no-op", distribution: "none", count: 0},
			{name: "single-file", distribution: "single-file", count: 1},
			{name: "sparse-1pct-clustered", distribution: "clustered", count: max(1, int(math.Round(float64(len(shape.sourceKeys))*.01)))},
			{name: "sparse-1pct-uniform", distribution: "uniform-scattered", count: max(1, int(math.Round(float64(len(shape.sourceKeys))*.01)))},
			{name: "sparse-1pct-skewed80", distribution: "skewed-80-subtree", count: max(1, int(math.Round(float64(len(shape.sourceKeys))*.01)))},
		}
		for _, current := range scenarios {
			selected := stateLayoutSweepPickTopology(shape, current.count, current.distribution, shapeName+"/"+current.name)
			after := base
			if len(selected) != 0 {
				after = stateLayoutSweepMutateProjection(base, site, selected, "T19-topology-"+shapeName+"-"+current.name)
			}
			reports, err := stateLayoutTopologyVariantReports(t, site, current.name, base, after, variants)
			if err != nil {
				return report, fmt.Errorf("%s/%s: %w", shapeName, current.name, err)
			}
			touchedDirs := stateLayoutTopologyTouchedDirectories(selected)
			shapeReport.Scenarios = append(shapeReport.Scenarios, stateLayoutTopologyScenario{Name: current.name,
				Distribution: current.distribution, ChangedSourcePaths: len(selected), TouchedDirectories: touchedDirs, Variants: reports})
		}
		report.Shapes = append(report.Shapes, shapeReport)
	}
	return report, nil
}

type stateLayoutSweepShape struct {
	name            string
	directoryCount  int
	maximumDepth    int
	sourceKeys      []string
	keysByDirectory map[string][]string
}

func stateLayoutSweepRelayout(projection layoutProjection, site, shape string) (layoutProjection, stateLayoutSweepShape, error) {
	prefix := "_artifacts/" + site + "/"
	oldSourceKeys := make([]string, 0)
	for key := range projection.Objects {
		if strings.HasPrefix(key, prefix) {
			oldSourceKeys = append(oldSourceKeys, key)
		}
	}
	sort.Strings(oldSourceKeys)
	if len(oldSourceKeys) == 0 {
		return layoutProjection{}, stateLayoutSweepShape{}, fmt.Errorf("actual build has no source artifact rows")
	}
	remapped := make(map[string]string, len(oldSourceKeys))
	seenDirs := make(map[string]struct{})
	maxDepth := 0
	for index, oldKey := range oldSourceKeys {
		ext := path.Ext(oldKey)
		base := fmt.Sprintf("object-%05d%s", index, extOrBin(ext))
		var relative string
		switch shape {
		case "flat":
			relative = base
		case "deep-12":
			parts := make([]string, 12)
			for level := range parts {
				parts[level] = fmt.Sprintf("d%02d", level)
			}
			relative = path.Join(append(parts, base)...)
		case "broad-1000":
			relative = path.Join(fmt.Sprintf("branch-%05d", index), base)
		case "skewed-80-subtree":
			if index < (len(oldSourceKeys)*80+99)/100 {
				relative = path.Join("hot", "shared", base)
			} else {
				relative = path.Join(fmt.Sprintf("cold-%05d", index), base)
			}
		default:
			return layoutProjection{}, stateLayoutSweepShape{}, fmt.Errorf("unknown synthetic topology %q", shape)
		}
		newKey := prefix + relative
		remapped[oldKey] = newKey
		directory := path.Dir(relative)
		if directory != "." {
			seenDirs[directory] = struct{}{}
			maxDepth = max(maxDepth, len(strings.Split(directory, "/")))
		}
	}
	result := layoutProjection{InputRoot: stateLayoutHash([]byte(projection.InputRoot + "\\nsynthetic-topology:" + shape)),
		Rows: make([]sitePublishObject, 0, len(projection.Rows)), Objects: make(map[string]Object, len(projection.Objects))}
	for _, row := range projection.Rows {
		oldKey := row.Key
		if newKey, ok := remapped[oldKey]; ok {
			row.Key = newKey
		}
		result.Rows = append(result.Rows, row)
		object, ok := projection.Objects[oldKey]
		if !ok {
			return layoutProjection{}, stateLayoutSweepShape{}, fmt.Errorf("actual build row %q has no object body", oldKey)
		}
		result.Objects[row.Key] = cloneStateLayoutObject(object)
	}
	sort.Slice(result.Rows, func(i, j int) bool { return result.Rows[i].Key < result.Rows[j].Key })
	shapeInfo := stateLayoutSweepShape{name: shape, directoryCount: len(seenDirs), maximumDepth: maxDepth,
		sourceKeys: make([]string, 0, len(remapped)), keysByDirectory: make(map[string][]string)}
	for _, key := range remapped {
		shapeInfo.sourceKeys = append(shapeInfo.sourceKeys, key)
		relative := strings.TrimPrefix(key, prefix)
		shapeInfo.keysByDirectory[path.Dir(relative)] = append(shapeInfo.keysByDirectory[path.Dir(relative)], key)
	}
	sort.Strings(shapeInfo.sourceKeys)
	for directory := range shapeInfo.keysByDirectory {
		sort.Strings(shapeInfo.keysByDirectory[directory])
	}
	if len(result.Rows) != len(projection.Rows) || len(result.Objects) != len(projection.Objects) {
		return layoutProjection{}, stateLayoutSweepShape{}, fmt.Errorf("relayout changed source/generated row cardinality")
	}
	return result, shapeInfo, nil
}

func extOrBin(ext string) string {
	if ext == "" {
		return ".bin"
	}
	return ext
}

func stateLayoutSweepPickTopology(shape stateLayoutSweepShape, count int, distribution, seed string) []string {
	if count <= 0 {
		return nil
	}
	if count > len(shape.sourceKeys) {
		count = len(shape.sourceKeys)
	}
	if distribution == "single-file" {
		return append([]string(nil), shape.sourceKeys[:1]...)
	}
	if distribution == "uniform-scattered" {
		return matrixPickUniform(shape.sourceKeys, count, seed)
	}
	groups := make([]string, 0, len(shape.keysByDirectory))
	for directory := range shape.keysByDirectory {
		groups = append(groups, directory)
	}
	sort.Slice(groups, func(i, j int) bool {
		left, right := len(shape.keysByDirectory[groups[i]]), len(shape.keysByDirectory[groups[j]])
		if left == right {
			return groups[i] < groups[j]
		}
		return left > right
	})
	if len(groups) == 0 {
		return nil
	}
	selected := append([]string(nil), shape.keysByDirectory[groups[0]]...)
	if distribution == "skewed-80-subtree" {
		target := int(math.Ceil(float64(count) * .80))
		if len(selected) > target {
			selected = selected[:target]
		}
		remaining := make([]string, 0, len(shape.sourceKeys)-len(selected))
		used := make(map[string]struct{}, len(selected))
		for _, key := range selected {
			used[key] = struct{}{}
		}
		for _, key := range shape.sourceKeys {
			if _, ok := used[key]; !ok {
				remaining = append(remaining, key)
			}
		}
		selected = append(selected, matrixPickUniform(remaining, min(count-len(selected), len(remaining)), seed+"/outside")...)
	} else {
		if len(selected) > count {
			selected = selected[:count]
		}
		if len(selected) < count {
			used := make(map[string]struct{}, len(selected))
			for _, key := range selected {
				used[key] = struct{}{}
			}
			remaining := make([]string, 0, len(shape.sourceKeys)-len(selected))
			for _, key := range shape.sourceKeys {
				if _, ok := used[key]; !ok {
					remaining = append(remaining, key)
				}
			}
			selected = append(selected, matrixPickUniform(remaining, count-len(selected), seed+"/outside")...)
		}
	}
	sort.Strings(selected)
	return selected
}

func stateLayoutSweepMutateProjection(base layoutProjection, site string, keys []string, marker string) layoutProjection {
	result := layoutProjection{InputRoot: stateLayoutHash([]byte(base.InputRoot + "\\nsynthetic-change:" + marker)),
		Rows: append([]sitePublishObject(nil), base.Rows...), Objects: cloneStateLayoutObjectMap(base.Objects)}
	selected := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		selected[key] = struct{}{}
	}
	for index := range result.Rows {
		row := &result.Rows[index]
		if _, ok := selected[row.Key]; !ok {
			continue
		}
		object := result.Objects[row.Key]
		object.Bytes = append(object.Bytes, []byte("\\nT19 synthetic payload delta "+marker+"\\n")...)
		digest := sha256Hex(object.Bytes)
		object.Metadata = cloneObjectMetadata(object.Metadata)
		object.Metadata["artifact-pages-sha256"] = digest
		result.Objects[row.Key] = object
		row.SHA256 = digest
		row.Size = int64(len(object.Bytes))
	}
	return result
}

func stateLayoutTopologyVariantReports(t *testing.T, site, scenario string, before, after layoutProjection, variants []stateLayoutVariant) ([]stateLayoutVariantReport, error) {
	t.Helper()
	result, err := stateLayoutCompareScenario(t, site, stateLayoutScenario{name: scenario, kind: "synthetic-topology", fullText: false}, before, after, variants)
	if err != nil {
		return nil, err
	}
	return result.Variants, nil
}

func stateLayoutTopologyTouchedDirectories(keys []string) int {
	set := make(map[string]struct{})
	for _, key := range keys {
		relative := strings.TrimPrefix(key, "_artifacts/verify-layout-topology/")
		set[path.Dir(relative)] = struct{}{}
	}
	return len(set)
}

func stateLayoutGeneratedProjectionSize(projection layoutProjection) (int, int64) {
	count := 0
	var bytes int64
	for key, object := range projection.Objects {
		if strings.HasPrefix(key, "_indexes/") {
			count++
			bytes += int64(len(object.Bytes))
		}
	}
	return count, bytes
}

func stateLayoutChangedSearchObjects(before, after layoutProjection, site string) int {
	prefix := "_indexes/" + site + "/search/"
	keys := make(map[string]struct{})
	for key := range before.Objects {
		if strings.HasPrefix(key, prefix) {
			keys[key] = struct{}{}
		}
	}
	for key := range after.Objects {
		if strings.HasPrefix(key, prefix) {
			keys[key] = struct{}{}
		}
	}
	changed := 0
	for key := range keys {
		old, hadOld := before.Objects[key]
		current, hasCurrent := after.Objects[key]
		if !hadOld || !hasCurrent || !reflect.DeepEqual(old, current) {
			changed++
		}
	}
	return changed
}

func stateLayoutSearchRootContains(projection layoutProjection, site, token string) bool {
	prefix := "_indexes/" + site + "/search/root-"
	for key, object := range projection.Objects {
		if !strings.HasPrefix(key, prefix) || !strings.HasSuffix(key, ".gz") {
			continue
		}
		reader, err := gzip.NewReader(bytes.NewReader(object.Bytes))
		if err != nil {
			continue
		}
		raw, err := io.ReadAll(reader)
		_ = reader.Close()
		if err == nil && strings.Contains(string(raw), token) {
			return true
		}
	}
	return false
}

func stateLayoutSweepRunMixes(rateKey string) []stateLayoutRunMix {
	rateLabel := "1%"
	if rateKey == "sparse01" {
		rateLabel = "0.1%"
	}
	return []stateLayoutRunMix{
		{ID: "no-op-only", Description: "1,000 no-op runs/site/month", SparseRate: rateLabel, NoopRuns: 1000},
		{ID: "quiet", Description: "970 no-op, 9 sparse, 1 full update, 20 rename/delete updates", SparseRate: rateLabel, NoopRuns: 970, SparseRuns: 9, DenseRuns: 1, RenameDeleteRuns: 20},
		{ID: "reference", Description: "870 no-op, 90 sparse, 10 full updates, 30 rename/delete updates", SparseRate: rateLabel, NoopRuns: 870, SparseRuns: 90, DenseRuns: 10, RenameDeleteRuns: 30},
		{ID: "active", Description: "470 no-op, 450 sparse, 50 full updates, 30 rename/delete updates", SparseRate: rateLabel, NoopRuns: 470, SparseRuns: 450, DenseRuns: 50, RenameDeleteRuns: 30},
		{ID: "dense-heavy", Description: "70 no-op, 900 full updates, 30 rename/delete updates", SparseRate: rateLabel, NoopRuns: 70, DenseRuns: 900, RenameDeleteRuns: 30},
	}
}

type stateLayoutMonthlySnapshots struct {
	SparseA       layoutProjection
	SparseB       layoutProjection
	DenseA        layoutProjection
	DenseB        layoutProjection
	RenameDeleteA layoutProjection
	RenameDeleteB layoutProjection
}

func stateLayoutSweepMonthlySnapshots(t *testing.T, ctx context.Context, root, work, source string, original []matrixSourceFile,
	allPaths []string, site string, fullText bool, initial layoutProjection) (stateLayoutMonthlySnapshots, error) {
	t.Helper()
	count := max(1, int(math.Round(float64(len(original))*.01)))
	selected := matrixSelectSourcePaths(original, count, "uniform-scattered", "t19/monthly/sparse", "all")
	if fullText {
		pages, _ := matrixPartition(original)
		selected = matrixPickUniform(pages, count, "t19/monthly/fulltext-pages")
		if len(selected) != count {
			return stateLayoutMonthlySnapshots{}, fmt.Errorf("full-text sparse snapshot needs %d pages, found %d", count, len(selected))
		}
	}
	build := func(label string, paths []string) (layoutProjection, error) {
		if err := stateLayoutSweepRestore(source, original, allPaths); err != nil {
			return layoutProjection{}, err
		}
		if err := stateLayoutSweepMutateVersion(source, original, paths, label); err != nil {
			return layoutProjection{}, err
		}
		return layoutBuildProjection(ctx, t, root, work, source, site, layoutBuildOptions{FullText: fullText})
	}
	var snapshots stateLayoutMonthlySnapshots
	var err error
	if snapshots.SparseA, err = build("T19-MONTHLY-SPARSE-A", selected); err != nil {
		return snapshots, err
	}
	if snapshots.SparseB, err = build("T19-MONTHLY-SPARSE-B", selected); err != nil {
		return snapshots, err
	}
	if snapshots.DenseA, err = build("T19-MONTHLY-DENSE-A", allPaths); err != nil {
		return snapshots, err
	}
	if snapshots.DenseB, err = build("T19-MONTHLY-DENSE-B", allPaths); err != nil {
		return snapshots, err
	}
	buildRenameDelete := func(label string) (layoutProjection, error) {
		if err := stateLayoutRestoreSources(source, original); err != nil {
			return layoutProjection{}, err
		}
		if _, _, _, _, err := stateLayoutMutate(source, original, stateLayoutScenario{
			name: "monthly-rename-delete", kind: "rename-delete", distribution: "fixed-first-pair",
		}); err != nil {
			return layoutProjection{}, err
		}
		mutated, err := matrixReadSources(source)
		if err != nil {
			return layoutProjection{}, err
		}
		var renamed *matrixSourceFile
		for index := range mutated {
			if filepath.Base(mutated[index].RelativePath) == "layout-renamed-resource.txt" {
				renamed = &mutated[index]
				break
			}
		}
		if renamed == nil {
			return layoutProjection{}, fmt.Errorf("monthly rename/delete snapshot has no renamed resource")
		}
		filename := filepath.Join(source, filepath.FromSlash(renamed.RelativePath))
		contents := append(append([]byte(nil), renamed.Bytes...), []byte("\nT19-MONTHLY-RENAME-DELETE "+label+"\n")...)
		if err := os.WriteFile(filename, contents, renamed.Mode); err != nil {
			return layoutProjection{}, err
		}
		mtime := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).Add(time.Hour)
		if err := os.Chtimes(filename, mtime, mtime); err != nil {
			return layoutProjection{}, err
		}
		return layoutBuildProjection(ctx, t, root, work, source, site, layoutBuildOptions{FullText: fullText})
	}
	if snapshots.RenameDeleteA, err = buildRenameDelete("A"); err != nil {
		return snapshots, err
	}
	if snapshots.RenameDeleteB, err = buildRenameDelete("B"); err != nil {
		return snapshots, err
	}
	if err := stateLayoutRestoreSources(source, original); err != nil {
		return snapshots, err
	}
	for label, projection := range map[string]layoutProjection{
		"sparse A": snapshots.SparseA, "sparse B": snapshots.SparseB,
		"dense A": snapshots.DenseA, "dense B": snapshots.DenseB,
		"rename/delete A": snapshots.RenameDeleteA, "rename/delete B": snapshots.RenameDeleteB,
	} {
		if projection.InputRoot == initial.InputRoot {
			return snapshots, fmt.Errorf("%s snapshot unexpectedly has base input root", label)
		}
	}
	return snapshots, nil
}

func stateLayoutSweepMutateVersion(root string, original []matrixSourceFile, selected []string, label string) error {
	byPath := make(map[string]matrixSourceFile, len(original))
	for _, file := range original {
		byPath[file.RelativePath] = file
	}
	for index, relative := range selected {
		file, ok := byPath[relative]
		if !ok {
			return fmt.Errorf("monthly mutation selected unknown source %q", relative)
		}
		filename := filepath.Join(root, filepath.FromSlash(relative))
		updated := append([]byte(nil), file.Bytes...)
		marker := []byte("\nzzt19monthlyvisiblemarker " + label + ".\n")
		ext := strings.ToLower(filepath.Ext(relative))
		if extIsPage(ext) && (ext == ".html" || ext == ".htm") {
			lower := strings.ToLower(string(updated))
			if index := strings.LastIndex(lower, "</body>"); index >= 0 {
				updated = append(append(append([]byte(nil), updated[:index]...), marker...), updated[index:]...)
			} else {
				updated = append(updated, marker...)
			}
		} else {
			updated = append(updated, marker...)
		}
		if err := os.WriteFile(filename, updated, file.Mode); err != nil {
			return err
		}
		mtime := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(index+1) * time.Second)
		if err := os.Chtimes(filename, mtime, mtime); err != nil {
			return err
		}
	}
	return nil
}

func stateLayoutSweepPersistentMonthly(t *testing.T, site string, initial layoutProjection, snapshots stateLayoutMonthlySnapshots,
	variants []stateLayoutVariant, fullText bool, mix stateLayoutRunMix, days int) (stateLayoutMonthlyModel, error) {
	t.Helper()
	if days != 30 || mix.NoopRuns+mix.SparseRuns+mix.DenseRuns+mix.RenameDeleteRuns != 1000 {
		return stateLayoutMonthlyModel{}, fmt.Errorf("persistent monthly model requires 30 days and exactly 1,000 runs")
	}
	events := stateLayoutMonthlyEventKinds(mix.SparseRuns, mix.DenseRuns, mix.RenameDeleteRuns)
	period := stateLayoutMonthlyStatePeriod(mix.SparseRuns, mix.DenseRuns, mix.RenameDeleteRuns)
	simulatedEvents := len(events)
	if period > 0 && len(events) >= period*3 {
		simulatedEvents = period * 3
	}
	model := stateLayoutMonthlyModel{FullText: fullText, MixID: mix.ID, RunMix: mix.Description, SparseRate: "1%",
		Simulation: "1,000 persistent serialized-state runs spread over 30 days. For each layout/mix, one no-op transition is executed and asserted HEAD-only with an unchanged state body; its exact operation and byte counts are multiplied by the scheduled no-op frequency. Changed runs execute up to three update cycles, compare cycles two and three byte-for-byte in calls/payload/footprint, then extrapolate only verified periodic cycles. Sparse, dense, and rename/delete source snapshots alternate. One end-of-month directory GC is charged where applicable.",
		RunCount:   mix.NoopRuns + mix.SparseRuns + mix.DenseRuns + mix.RenameDeleteRuns, Days: days, NoopRuns: mix.NoopRuns, SparseRuns: mix.SparseRuns, DenseRuns: mix.DenseRuns, RenameDeleteRuns: mix.RenameDeleteRuns,
		SimulatedChangedTransitions: simulatedEvents, ExtrapolatedChangedTransitions: len(events) - simulatedEvents, VerifiedCyclePeriod: period}
	for _, variant := range variants {
		sequence, err := newStateLayoutSequence(site, initial, variant)
		if err != nil {
			return model, fmt.Errorf("%s monthly seed: %w", variant.name, err)
		}
		startBytes := sequence.store.persistentBytes()
		simulated := simulatedEvents
		steps := make([]stateLayoutStepResult, 0, simulated)
		bytesAfter := make([]int64, 0, simulated)
		current := initial
		sparseVersion, denseVersion, renameDeleteVersion := 0, 0, 0
		for eventIndex := 0; eventIndex < simulated; eventIndex++ {
			kind := events[eventIndex]
			target := snapshots.SparseA
			switch kind {
			case "dense":
				target = snapshots.DenseA
				if denseVersion%2 == 1 {
					target = snapshots.DenseB
				}
				denseVersion++
			case "rename-delete":
				target = snapshots.RenameDeleteA
				if renameDeleteVersion%2 == 1 {
					target = snapshots.RenameDeleteB
				}
				renameDeleteVersion++
			default:
				if sparseVersion%2 == 1 {
					target = snapshots.SparseB
				}
				sparseVersion++
			}
			beforePersistentBytes := sequence.store.persistentBytes()
			step, err := sequence.Apply(target, stateLayoutFailure{})
			if err != nil || !step.StateCommitted {
				return model, fmt.Errorf("%s monthly update %d/%d (%s): %+v: %w", variant.name, eventIndex+1, simulated, kind, step, err)
			}
			afterPersistentBytes := sequence.store.persistentBytes()
			if step.AttemptPeakPersistentBytes < max(beforePersistentBytes, afterPersistentBytes) {
				return model, fmt.Errorf("%s monthly update %d/%d reports transient peak %d below committed boundary %d..%d",
					variant.name, eventIndex+1, simulated, step.AttemptPeakPersistentBytes, beforePersistentBytes, afterPersistentBytes)
			}
			steps = append(steps, step)
			bytesAfter = append(bytesAfter, afterPersistentBytes)
			current = target
		}
		if simulated == period*3 && period > 0 {
			for offset := 0; offset < period; offset++ {
				first := steps[period+offset]
				second := steps[2*period+offset]
				if !stateLayoutMonthlyStepCostEqual(first, second) || bytesAfter[period+offset] != bytesAfter[2*period+offset] {
					return model, fmt.Errorf("%s monthly cycle did not stabilize at step %d: cycle2=%+v/%d cycle3=%+v/%d", variant.name, offset,
						first.Report.StateCalls, bytesAfter[period+offset], second.Report.StateCalls, bytesAfter[2*period+offset])
				}
			}
		}
		steady := simulated == period*3 && period > 0
		if steady {
			if err := sequence.store.assertProjectionRows(current.Rows); err != nil {
				return model, fmt.Errorf("%s monthly cycle-three committed rows: %w", variant.name, err)
			}
			if !equalStateLayoutObjectMaps(siteProjectionObjects(sequence.origin, site), current.Objects) {
				return model, fmt.Errorf("%s monthly cycle-three origin differs from actual BuildPrepared projection", variant.name)
			}
		}

		var calls stateLayoutCallCounts
		var readBytes, writeBytes int64
		for _, step := range steps {
			stateLayoutAccumulateStep(&calls, &readBytes, &writeBytes, step)
		}
		for eventIndex := simulated; eventIndex < len(events); eventIndex++ {
			if !steady {
				return model, fmt.Errorf("%s monthly event %d lacks a verified repeat cycle", variant.name, eventIndex)
			}
			steadyStep := steps[2*period+(eventIndex%period)]
			stateLayoutAccumulateStep(&calls, &readBytes, &writeBytes, steadyStep)
		}

		// One real no-op transition establishes the exact per-run operations and
		// proves that repeating it cannot change state. Count the remaining
		// scheduled runs arithmetically instead of re-decoding the same state body
		// thousands of times in this cost model.
		if mix.NoopRuns > 0 {
			beforeNoopBytes := sequence.store.persistentBytes()
			step, err := sequence.Apply(current, stateLayoutFailure{})
			if err != nil || !step.StateCommitted || step.Report.StateCalls != (stateLayoutCallCounts{Head: 1}) ||
				step.Report.StateBodyReadBytes != 0 || step.Report.StateBodyWriteBytes != 0 ||
				sequence.store.persistentBytes() != beforeNoopBytes {
				return model, fmt.Errorf("%s monthly no-op transition was not a stable HEAD-only read: %+v: %w", variant.name, step, err)
			}
			model.MeasuredNoopTransitions = 1
			model.CountedNoopTransitions = mix.NoopRuns
			model.ExtrapolatedNoopTransitions = mix.NoopRuns - 1
			calls.Head += step.Report.StateCalls.Head * mix.NoopRuns
		}

		// Map real or verified periodic event costs onto the 30 days to calculate
		// per-day peaks and object-version sensitivity without replaying 900 identical cycles.
		dailyPeaks := make([]int64, days)
		dailyWrites := make([]int64, days)
		currentStateBytes := startBytes
		for day := 0; day < days; day++ {
			startEvent := len(events) * day / days
			endEvent := len(events) * (day + 1) / days
			peak := currentStateBytes
			for eventIndex := startEvent; eventIndex < endEvent; eventIndex++ {
				var eventCommittedBytes, eventPeakBytes, eventWrite int64
				if eventIndex < simulated {
					eventCommittedBytes = bytesAfter[eventIndex]
					eventPeakBytes = steps[eventIndex].AttemptPeakPersistentBytes
					eventWrite = steps[eventIndex].Report.StateBodyWriteBytes
				} else {
					if !steady {
						return model, fmt.Errorf("%s monthly day %d requires an unverified repeat cycle", variant.name, day+1)
					}
					steadyIndex := 2*period + (eventIndex % period)
					eventCommittedBytes = bytesAfter[steadyIndex]
					eventPeakBytes = steps[steadyIndex].AttemptPeakPersistentBytes
					eventWrite = steps[steadyIndex].Report.StateBodyWriteBytes
				}
				currentStateBytes = eventCommittedBytes
				peak = max(peak, eventPeakBytes, eventCommittedBytes)
				dailyWrites[day] += eventWrite
			}
			dailyPeaks[day] = peak
		}

		var gcClassA, gcClassB, gcDeleteKeys int
		var orphanBeforeGC int64
		if variant.layout == "directory-two-slot" {
			orphanBeforeGC = sequence.store.orphanBytes()
			gc, err := sequence.GC()
			if err != nil {
				return model, fmt.Errorf("%s monthly directory GC: %w", variant.name, err)
			}
			calls.Head += gc.Calls.Head
			calls.Get += gc.Calls.Get
			calls.List += gc.Calls.List
			calls.ListWireRequests += gc.Calls.ListWireRequests
			calls.Delete += gc.Calls.Delete
			calls.DeleteKeys += gc.Calls.DeleteKeys
			gcClassA = gc.Calls.Put + gc.Calls.ListWireRequests
			gcClassB = gc.Calls.Head + gc.Calls.Get
			gcDeleteKeys = gc.Calls.DeleteKeys
			readBytes += gc.StateBodyReadBytes
		}
		finalBytes := sequence.store.persistentBytes()
		var maxDaily int64
		var sumDaily int64
		for _, peak := range dailyPeaks {
			maxDaily = max(maxDaily, peak)
			sumDaily += peak
		}
		averageDaily := float64(sumDaily) / float64(days)
		classA := calls.Put + calls.ListWireRequests
		classB := calls.Head + calls.Get
		r2StorageGB := averageDaily / float64(stateLayoutR2BillingGBBytes)
		s3StorageGB := averageDaily / float64(stateLayoutS3BillingGBBytes)
		r2Cost := stateLayoutRoundR2(int64(classA), int64(classB), r2StorageGB)
		r2MarginalConsumed := float64(classA)*4.50/1_000_000 + float64(classB)*0.36/1_000_000 + r2StorageGB*0.015
		s3Requests := float64(classA)*.005/1000 + float64(classB)*.0004/1000
		s3Storage := s3StorageGB * .023
		s3EgressGB := float64(readBytes) / float64(stateLayoutS3BillingGBBytes)
		stateVersion7 := stateLayoutMonthlyVersionBytes(dailyWrites, 7)
		stateVersion30 := stateLayoutMonthlyVersionBytes(dailyWrites, 30)
		avgVersion7Bytes := averageInt64(stateVersion7)
		avgVersion30Bytes := averageInt64(stateVersion30)
		avgVersion7 := avgVersion7Bytes / float64(stateLayoutS3BillingGBBytes)
		avgVersion30 := avgVersion30Bytes / float64(stateLayoutS3BillingGBBytes)
		orphanAfter := sequence.store.orphanBytes()
		model.Variants = append(model.Variants, stateLayoutMonthlyVariantCost{
			VariantName: variant.name, ClassARequests: int64(classA), ClassBRequests: int64(classB), DeleteFreeRequests: int64(calls.DeleteKeys),
			StateBodyReadBytes: readBytes, StateBodyWriteBytes: writeBytes, PersistentBytesStart: startBytes, PersistentBytesFinal: finalBytes,
			MaximumDailyPeakBytes: maxDaily, AverageDailyPeakBytes: averageDaily, DailyPeakBytes: dailyPeaks,
			RetainedOrphanBytesBeforeGC: orphanBeforeGC, RetainedOrphanBytesAfterGC: orphanAfter,
			GCRuns: boolInt(variant.layout == "directory-two-slot"), GCClassARequests: gcClassA, GCClassBRequests: gcClassB,
			GCDeleteKeys: gcDeleteKeys, R2StandaloneInvoiceUSD: r2Cost,
			R2MarginalIfAllowancesConsumedUSD: r2MarginalConsumed, S3SameRegionRequestStorageUSD: s3Requests + s3Storage,
			S3ExternalEgressGB: s3EgressGB, S3ExternalBillableWithFullAllowanceGB: math.Max(0, s3EgressGB-100),
			S3ExternalTotalUSD:                    s3Requests + s3Storage + stateLayoutS3EgressCost(readBytes, 100),
			S3ExternalTotalIfAllowanceConsumedUSD: s3Requests + s3Storage + stateLayoutS3EgressCost(readBytes, 0),
			S3Versioning7DayAdditionalUSD:         avgVersion7 * .023, S3Versioning30DayAdditionalUSD: avgVersion30 * .023,
			S3Versioning7DayAverageBytes: avgVersion7Bytes, S3Versioning30DayAverageBytes: avgVersion30Bytes,
			StorageBasis: "R2 uses average of 30 per-day persistent byte peaks, including measured pending-state high-water marks; no-op HEADs and up to three update cycles executed; additional changed cycles use a measured cycle only after cycle 2 and 3 have identical calls, bytes and per-step persistent footprint; monthly directory GC measured once. S3 uses the same daily-peak average only as a conservative upper bound because update timestamps/durations are not modeled. Versioning sensitivity uses incoming state PUT bytes as an upper bound for retained prior bodies",
		})
	}
	return model, nil
}

func stateLayoutMonthlyStatePeriod(sparse, dense, renameDelete int) int {
	total := sparse + dense + renameDelete
	if total == 0 {
		return 0
	}
	divisor := stateLayoutGCD(stateLayoutGCD(sparse, dense), renameDelete)
	period := total / divisor
	if (sparse/divisor)%2 == 1 || (dense/divisor)%2 == 1 || (renameDelete/divisor)%2 == 1 {
		period *= 2 // restore every independent A/B snapshot phase.
	}
	return period
}

func stateLayoutGCD(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	if a < 0 {
		return -a
	}
	return a
}

func stateLayoutMonthlyStepCostEqual(left, right stateLayoutStepResult) bool {
	return reflect.DeepEqual(left.Report.StateCalls, right.Report.StateCalls) &&
		left.AttemptPeakPersistentBytes == right.AttemptPeakPersistentBytes &&
		left.Report.StateBodyReadBytes == right.Report.StateBodyReadBytes &&
		left.Report.StateBodyWriteBytes == right.Report.StateBodyWriteBytes &&
		left.ProjectionPuts == right.ProjectionPuts && left.ProjectionDeletes == right.ProjectionDeletes
}

func stateLayoutMonthlyEventKinds(sparse, dense, renameDelete int) []string {
	total := sparse + dense + renameDelete
	result := make([]string, 0, total)
	for index := 0; index < total; index++ {
		if total > 0 && (index+1)*dense/total > index*dense/total {
			result = append(result, "dense")
		} else if total > 0 && (index+1)*(dense+renameDelete)/total > index*(dense+renameDelete)/total {
			result = append(result, "rename-delete")
		} else {
			result = append(result, "sparse")
		}
	}
	return result
}

func stateLayoutAccumulateStep(calls *stateLayoutCallCounts, readBytes, writeBytes *int64, step stateLayoutStepResult) {
	current := step.Report.StateCalls
	calls.Head += current.Head
	calls.Get += current.Get
	calls.List += current.List
	calls.ListWireRequests += current.ListWireRequests
	calls.Put += current.Put
	calls.Delete += current.Delete
	calls.DeleteKeys += current.DeleteKeys
	calls.CoordinatorPuts += current.CoordinatorPuts
	calls.LeafGets += current.LeafGets
	calls.LeafPuts += current.LeafPuts
	*readBytes += step.Report.StateBodyReadBytes
	*writeBytes += step.Report.StateBodyWriteBytes
}

func stateLayoutMonthlyVersionBytes(dailyWrites []int64, retentionDays int) []int64 {
	result := make([]int64, len(dailyWrites))
	if len(dailyWrites) == 0 || retentionDays <= 0 {
		return result
	}
	if retentionDays > len(dailyWrites) {
		retentionDays = len(dailyWrites)
	}
	for day := range dailyWrites {
		for offset := 1; offset <= retentionDays; offset++ {
			prior := (day - offset + len(dailyWrites)) % len(dailyWrites)
			result[day] += dailyWrites[prior]
		}
	}
	return result
}

func averageInt64(values []int64) float64 {
	if len(values) == 0 {
		return 0
	}
	var sum int64
	for _, value := range values {
		sum += value
	}
	return float64(sum) / float64(len(values))
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func stateLayoutSweepMonthly(t *testing.T, scenarios []stateLayoutSweepScenario, variants []stateLayoutVariant, fullText bool, names map[string]string, mix stateLayoutRunMix, rateKey string) (stateLayoutMonthlyModel, error) {
	t.Helper()
	if names == nil || names["noop"] == "" || names["dense"] == "" || (mix.SparseRuns > 0 && names[rateKey] == "") {
		return stateLayoutMonthlyModel{}, fmt.Errorf("missing monthly scenario names for fullText=%t: %v", fullText, names)
	}
	byName := make(map[string]stateLayoutSweepScenario, len(scenarios))
	for _, scenario := range scenarios {
		byName[scenario.Name] = scenario
	}
	noop, okNoop := byName[names["noop"]]
	dense, okDense := byName[names["dense"]]
	var sparse stateLayoutSweepScenario
	okSparse := mix.SparseRuns == 0
	if mix.SparseRuns > 0 {
		sparse, okSparse = byName[names[rateKey]]
	}
	if !okNoop || !okSparse || !okDense {
		return stateLayoutMonthlyModel{}, fmt.Errorf("monthly model references missing scenarios: %v", names)
	}
	sparseRate := mix.SparseRate
	if mix.SparseRuns == 0 {
		sparseRate = ""
	}
	model := stateLayoutMonthlyModel{FullText: fullText, MixID: mix.ID, RunMix: mix.Description,
		SparseRate: sparseRate, NoopRuns: mix.NoopRuns, SparseRuns: mix.SparseRuns, DenseRuns: mix.DenseRuns}
	for variantIndex, variant := range variants {
		if variantIndex >= len(noop.Variants) || (mix.SparseRuns > 0 && variantIndex >= len(sparse.Variants)) || variantIndex >= len(dense.Variants) {
			return stateLayoutMonthlyModel{}, fmt.Errorf("scenario variant count mismatch")
		}
		no := noop.Variants[variantIndex]
		de := dense.Variants[variantIndex]
		var sp stateLayoutVariantReport
		if mix.SparseRuns > 0 {
			sp = sparse.Variants[variantIndex]
		}
		if no.Name != variant.name || (mix.SparseRuns > 0 && sp.Name != variant.name) || de.Name != variant.name {
			return stateLayoutMonthlyModel{}, fmt.Errorf("variant ordering mismatch for %s", variant.name)
		}
		classA := int64(no.StateCalls.Put+no.StateCalls.ListWireRequests)*int64(mix.NoopRuns) + int64(sp.StateCalls.Put+sp.StateCalls.ListWireRequests)*int64(mix.SparseRuns) + int64(de.StateCalls.Put+de.StateCalls.ListWireRequests)*int64(mix.DenseRuns)
		classB := int64(no.StateCalls.Head+no.StateCalls.Get)*int64(mix.NoopRuns) + int64(sp.StateCalls.Head+sp.StateCalls.Get)*int64(mix.SparseRuns) + int64(de.StateCalls.Head+de.StateCalls.Get)*int64(mix.DenseRuns)
		deletes := int64(no.StateCalls.Delete)*int64(mix.NoopRuns) + int64(sp.StateCalls.Delete)*int64(mix.SparseRuns) + int64(de.StateCalls.Delete)*int64(mix.DenseRuns)
		readBytes := no.StateBodyReadBytes*int64(mix.NoopRuns) + sp.StateBodyReadBytes*int64(mix.SparseRuns) + de.StateBodyReadBytes*int64(mix.DenseRuns)
		maxPersistent := no.PeakPersistentBytes
		if mix.SparseRuns > 0 {
			maxPersistent = max(maxPersistent, sparse.Variants[variantIndex].PeakPersistentBytes)
		}
		if mix.DenseRuns > 0 {
			maxPersistent = max(maxPersistent, de.PeakPersistentBytes)
		}
		r2Request := float64(classA)*4.50/1_000_000 + float64(classB)*0.36/1_000_000
		r2Standalone := stateLayoutRoundR2(classA, classB, float64(maxPersistent)/1e9)
		s3Request := float64(classA)*0.005/1000 + float64(classB)*0.0004/1000
		storageGB := float64(maxPersistent) / float64(stateLayoutR2BillingGBBytes)
		s3StorageGB := float64(maxPersistent) / float64(stateLayoutS3BillingGBBytes)
		s3Storage := s3StorageGB * 0.023
		s3EgressGB := float64(readBytes) / float64(stateLayoutS3BillingGBBytes)
		s3ExternalBillable := math.Max(0, s3EgressGB-100)
		s3ExternalWithAllowance := s3Request + s3Storage + stateLayoutS3EgressCost(readBytes, 100)
		s3ExternalIfConsumed := s3Request + s3Storage + stateLayoutS3EgressCost(readBytes, 0)
		model.Variants = append(model.Variants, stateLayoutMonthlyVariantCost{VariantName: variant.name,
			ClassARequests: classA, ClassBRequests: classB, DeleteFreeRequests: deletes,
			StateBodyReadBytes: readBytes, MaxSingleTransitionStateBytes: maxPersistent,
			R2StandaloneInvoiceUSD: r2Standalone, R2MarginalIfAllowancesConsumedUSD: r2Request + storageGB*0.015,
			S3SameRegionRequestStorageUSD: s3Request + s3Storage, S3ExternalEgressGB: s3EgressGB,
			S3ExternalBillableWithFullAllowanceGB: s3ExternalBillable, S3ExternalTotalUSD: s3ExternalWithAllowance,
			S3ExternalTotalIfAllowanceConsumedUSD: s3ExternalIfConsumed,
			StorageBasis:                          "largest measured before/after/peak footprint among isolated transitions, conservatively held for the full month; excludes cross-transition orphan and S3 object-version history"})
	}
	return model, nil
}

func stateLayoutRoundR2(classA, classB int64, storageGB float64) float64 {
	roundedA := roundBillableMillion(int(classA), 1_000_000)
	roundedB := roundBillableMillion(int(classB), 10_000_000)
	storageBillable := math.Ceil(math.Max(0, storageGB-10))
	return float64(roundedA)/1_000_000*4.50 + float64(roundedB)/1_000_000*0.36 + storageBillable*0.015
}

func stateLayoutS3EgressCost(bodyBytes int64, remainingSharedFreeGB float64) float64 {
	billableGB := math.Max(0, float64(bodyBytes)/float64(stateLayoutS3BillingGBBytes)-remainingSharedFreeGB)
	return billableGB * 0.09
}

func TestStateLayoutR2BillingThresholds(t *testing.T) {
	tests := []struct {
		name    string
		classA  int64
		classB  int64
		storage float64
		want    float64
	}{
		{name: "all allowances exactly consumed", classA: 1_000_000, classB: 10_000_000, storage: 10, want: 0},
		{name: "one class A over allowance rounds a million", classA: 1_000_001, classB: 10_000_000, storage: 10, want: 4.50},
		{name: "one class B over allowance rounds a million", classA: 1_000_000, classB: 10_000_001, storage: 10, want: 0.36},
		{name: "storage epsilon over allowance rounds a GB", classA: 1_000_000, classB: 10_000_000, storage: 10.000001, want: 0.015},
		{name: "all three over allowances", classA: 1_000_001, classB: 10_000_001, storage: 10.000001, want: 4.875},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := stateLayoutRoundR2(test.classA, test.classB, test.storage); math.Abs(got-test.want) > 1e-12 {
				t.Fatalf("stateLayoutRoundR2(%d,%d,%.9f)=%f, want %f", test.classA, test.classB, test.storage, got, test.want)
			}
		})
	}
}

func TestStateLayoutR2EstimateSubtractsStorageAllowance(t *testing.T) {
	for _, test := range []struct {
		name          string
		storedBytes   int64
		wantOverFree  float64
		wantRoundedGB float64
		wantMonthly   float64
	}{
		{name: "exactly free", storedBytes: 10_000_000_000, wantOverFree: 0, wantRoundedGB: 0, wantMonthly: 0},
		{name: "just over rounds one GB", storedBytes: 10_000_001_000, wantOverFree: .000001, wantRoundedGB: 1, wantMonthly: .015},
		{name: "twelve GB charges only two", storedBytes: 12_000_000_000, wantOverFree: 2, wantRoundedGB: 2, wantMonthly: .03},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := stateLayoutR2Estimate(stateLayoutCallCounts{}, test.storedBytes, 1, 1)
			if math.Abs(got.MonthlyStorageOverFree-test.wantOverFree) > 1e-9 ||
				got.MonthlyStorageRounded != test.wantRoundedGB || math.Abs(got.MonthlyTotalUSD-test.wantMonthly) > 1e-12 {
				t.Fatalf("R2 storage estimate = overFree %.9f GB rounded %.0f GB total $%.3f; want %.9f GB, %.0f GB, $%.3f",
					got.MonthlyStorageOverFree, got.MonthlyStorageRounded, got.MonthlyTotalUSD,
					test.wantOverFree, test.wantRoundedGB, test.wantMonthly)
			}
		})
	}
}

func TestStateLayoutS3ExternalEgressAllowance(t *testing.T) {
	tests := []struct {
		name      string
		bytes     int64
		remaining float64
		want      float64
	}{
		{name: "full shared allowance remains", bytes: 100 * stateLayoutS3BillingGBBytes, remaining: 100, want: 0},
		{name: "one GB after allowance", bytes: 101 * stateLayoutS3BillingGBBytes, remaining: 100, want: 0.09},
		{name: "allowance already consumed", bytes: 100 * stateLayoutS3BillingGBBytes, remaining: 0, want: 9},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := stateLayoutS3EgressCost(test.bytes, test.remaining); math.Abs(got-test.want) > 1e-12 {
				t.Fatalf("stateLayoutS3EgressCost(%d, %.1f)=%f, want %f", test.bytes, test.remaining, got, test.want)
			}
		})
	}
}

func stateLayoutSweepMutateKind(root string, sources []matrixSourceFile, count int, distribution, kind, seed string) ([]string, int64, int64, matrixChangedTypes, error) {
	if count <= 0 {
		return nil, 0, 0, matrixChangedTypes{}, nil
	}
	pages, resources := matrixPartition(sources)
	candidates := resources
	if kind == "page" {
		candidates = pages
	}
	if count > len(candidates) {
		return nil, 0, 0, matrixChangedTypes{}, fmt.Errorf("requested %d %s files from %d candidates", count, kind, len(candidates))
	}
	var selected []string
	switch distribution {
	case "clustered":
		selected = matrixPickCluster(candidates, count, fmt.Sprintf("%d/%s", sitePublishStateLayoutSeed, seed))
	case "skewed-80-subtree":
		target := int(math.Ceil(float64(count) * .8))
		subtree, _ := matrixSelectSubtree(candidates, target, fmt.Sprintf("%d/%s", sitePublishStateLayoutSeed, seed))
		selected = append(subtree, matrixPickUniform(candidatesExcept(candidates, subtree), count-len(subtree), seed+"/outside")...)
		sort.Strings(selected)
	default:
		selected = matrixPickUniform(candidates, count, fmt.Sprintf("%d/%s", sitePublishStateLayoutSeed, seed))
	}
	_ = resources
	before := make(map[string]matrixSourceFile, len(sources))
	for _, source := range sources {
		before[source.RelativePath] = source
	}
	var oldBytes, newBytes int64
	changedTypes := matrixChangedTypes{}
	for index, relative := range selected {
		original := before[relative]
		filename := filepath.Join(root, filepath.FromSlash(relative))
		mutation := []byte(fmt.Sprintf("\nLAYOUT-SWEEP:%s:%05d\n", seed, index))
		ext := strings.ToLower(filepath.Ext(relative))
		var updated []byte
		if extIsPage(ext) {
			if ext == ".html" || ext == ".htm" {
				visibleText := []byte(fmt.Sprintf("<p>Layout sweep update %s %05d. %s</p>", seed, index, stateLayoutSweepMarker))
				body := strings.ToLower(string(original.Bytes))
				if close := strings.LastIndex(body, "</body>"); close >= 0 {
					updated = make([]byte, 0, len(original.Bytes)+len(visibleText)+2)
					updated = append(updated, original.Bytes[:close]...)
					updated = append(updated, '\n')
					updated = append(updated, visibleText...)
					updated = append(updated, '\n')
					updated = append(updated, original.Bytes[close:]...)
				} else {
					updated = append(append([]byte(nil), original.Bytes...), visibleText...)
				}
			} else {
				mutation = []byte(fmt.Sprintf("\nLayout sweep update %s %05d. %s\n", seed, index, stateLayoutSweepMarker))
			}
			changedTypes.Pages++
		} else {
			changedTypes.Resources++
		}
		if updated == nil {
			updated = append(append([]byte(nil), original.Bytes...), mutation...)
		}
		if err := os.WriteFile(filename, updated, original.Mode); err != nil {
			return nil, 0, 0, matrixChangedTypes{}, err
		}
		mtime := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(index+1) * time.Second)
		if err := os.Chtimes(filename, mtime, mtime); err != nil {
			return nil, 0, 0, matrixChangedTypes{}, err
		}
		oldBytes += int64(len(original.Bytes))
		newBytes += int64(len(updated))
	}
	updated, err := matrixReadSources(root)
	if err != nil {
		return nil, 0, 0, matrixChangedTypes{}, err
	}
	changed := matrixChangedPathList(sources, updated)
	if len(changed) != len(selected) {
		return nil, 0, 0, matrixChangedTypes{}, fmt.Errorf("actual changed paths %d != selected %d", len(changed), len(selected))
	}
	return changed, oldBytes, newBytes, changedTypes, nil
}

func candidatesExcept(candidates, excluded []string) []string {
	set := make(map[string]struct{}, len(excluded))
	for _, item := range excluded {
		set[item] = struct{}{}
	}
	var result []string
	for _, item := range candidates {
		if _, ok := set[item]; !ok {
			result = append(result, item)
		}
	}
	return result
}

func stateLayoutSweepRecordMutation(report *stateLayoutSweepScenario, changed []string, oldBytes, newBytes int64, kinds matrixChangedTypes, sourceFiles int) {
	report.ChangedSourcePaths = len(changed)
	report.ChangedPathSample = stateLayoutSample(changed, 5)
	report.ChangedPages, report.ChangedResources = kinds.Pages, kinds.Resources
	report.ChangedPathBytesBefore, report.ChangedPathBytesAfter = oldBytes, newBytes
	report.TouchedDirectories = len(matrixTouchedDirectories(changed))
	if sourceFiles > 0 {
		report.AchievedChangedFraction = float64(len(changed)) / float64(sourceFiles)
	}
}

func stateLayoutSweepEnsureMap(value map[string]string) map[string]string {
	if value == nil {
		return make(map[string]string)
	}
	return value
}

func stateLayoutSweepRestore(root string, originals []matrixSourceFile, changed []string) error {
	if len(changed) == 0 {
		return nil
	}
	originalByPath := make(map[string]matrixSourceFile, len(originals))
	for _, original := range originals {
		originalByPath[original.RelativePath] = original
	}
	for _, relative := range changed {
		filename := filepath.Join(root, filepath.FromSlash(relative))
		original, exists := originalByPath[relative]
		if !exists {
			if err := os.Remove(filename); err != nil && !os.IsNotExist(err) {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(filename, original.Bytes, original.Mode); err != nil {
			return err
		}
		if err := os.Chtimes(filename, original.ModTime, original.ModTime); err != nil {
			return err
		}
	}
	return nil
}

func stateLayoutSweepDatasetCurrentBuildInputs(t *testing.T, root string) string {
	t.Helper()
	command := exec.Command("git", "rev-parse", "HEAD")
	command.Dir = root
	bytes, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(bytes))
}

func stateLayoutSweepHarnessDigest(t *testing.T, root string) string {
	t.Helper()
	files := []string{"cli/internal/publisher/site_publish_difference_matrix_test.go", "cli/internal/publisher/site_publish_state_layout_matrix_test.go", "cli/internal/publisher/site_publish_state_layout_sweep_test.go"}
	var content strings.Builder
	for _, relative := range files {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatal(err)
		}
		content.WriteString(relative)
		content.WriteByte(0)
		content.Write(data)
		content.WriteByte(0)
	}
	return stateLayoutHash([]byte(content.String()))
}
