package publisher

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/artifact-pages/artifact-pages/cli/internal/registry"
)

// awsLiveSmokeVersionAPI is deliberately narrower than the production S3
// interface. The live tests need version-aware cleanup, but ordinary
// production operations do not.
type awsLiveSmokeVersionAPI interface {
	ListObjectVersions(context.Context, *s3.ListObjectVersionsInput, ...func(*s3.Options)) (*s3.ListObjectVersionsOutput, error)
	DeleteObjects(context.Context, *s3.DeleteObjectsInput, ...func(*s3.Options)) (*s3.DeleteObjectsOutput, error)
}

type awsLiveSmokePrefixSpec struct {
	root          string
	site          string
	label         string
	randomHexSize int
}

var (
	awsPreviewFlowSmokePrefixSpec = awsLiveSmokePrefixSpec{
		root: "_previews", label: "artifact-pages-preview-flow-smoke", randomHexSize: 32,
	}
	awsArtifactSmokePrefixSpec = awsLiveSmokePrefixSpec{
		root: "_artifacts", label: "artifact-pages-aws-smoke", randomHexSize: 24,
	}
)

const awsLiveSmokeCleanupAttempts = 3

func validateAWSLiveSmokePrefix(prefix string, spec awsLiveSmokePrefixSpec) error {
	switch {
	case spec.root == "_previews" && spec.label == "artifact-pages-preview-flow-smoke" && spec.randomHexSize == 32:
	case spec.root == "_artifacts" && spec.label == "artifact-pages-aws-smoke" && spec.randomHexSize == 24:
	default:
		return fmt.Errorf("unsupported AWS smoke namespace shape %q/%q with %d random hex characters", spec.root, spec.label, spec.randomHexSize)
	}
	if err := registry.ValidateSiteID(spec.site); err != nil {
		return fmt.Errorf("invalid AWS smoke site %q: %w", spec.site, err)
	}
	if spec.label == "" || spec.randomHexSize < 1 {
		return errors.New("AWS smoke namespace requires a label and random token length")
	}
	base := fmt.Sprintf("%s/%s/.%s-", spec.root, spec.site, spec.label)
	if !strings.HasPrefix(prefix, base) || len(prefix) != len(base)+spec.randomHexSize+1 || prefix[len(prefix)-1] != '/' {
		return fmt.Errorf("refusing AWS smoke cleanup outside one exact generated prefix: %q", prefix)
	}
	token := prefix[len(base) : len(prefix)-1]
	if len(token) != spec.randomHexSize {
		return fmt.Errorf("refusing AWS smoke cleanup with malformed random token in prefix %q", prefix)
	}
	if _, err := hex.DecodeString(token); err != nil {
		return fmt.Errorf("refusing AWS smoke cleanup with malformed random token in prefix %q: %w", prefix, err)
	}
	return nil
}

func listAWSLiveSmokeVersions(ctx context.Context, client awsLiveSmokeVersionAPI, bucket, prefix string, spec awsLiveSmokePrefixSpec) ([]types.ObjectIdentifier, error) {
	if err := validateAWSLiveSmokePrefix(prefix, spec); err != nil {
		return nil, err
	}
	if client == nil {
		return nil, errors.New("AWS smoke version client is required")
	}
	if bucket == "" {
		return nil, errors.New("AWS smoke bucket is required")
	}

	var identifiers []types.ObjectIdentifier
	seenIdentifiers := make(map[string]struct{})
	seenMarkers := make(map[string]struct{})
	var keyMarker, versionIDMarker *string
	for {
		result, err := client.ListObjectVersions(ctx, &s3.ListObjectVersionsInput{
			Bucket: aws.String(bucket), Prefix: aws.String(prefix),
			KeyMarker: keyMarker, VersionIdMarker: versionIDMarker,
		})
		if err != nil {
			return nil, fmt.Errorf("list versions for s3://%s/%s: %w", bucket, prefix, err)
		}
		if result == nil {
			return nil, fmt.Errorf("S3 returned an empty version listing for %q", prefix)
		}
		if result.IsTruncated == nil {
			return nil, fmt.Errorf("S3 version listing is missing truncation status for %q", prefix)
		}
		for _, version := range result.Versions {
			if err := appendAWSLiveSmokeIdentifier(&identifiers, seenIdentifiers, prefix, aws.ToString(version.Key), aws.ToString(version.VersionId)); err != nil {
				return nil, err
			}
		}
		for _, marker := range result.DeleteMarkers {
			if err := appendAWSLiveSmokeIdentifier(&identifiers, seenIdentifiers, prefix, aws.ToString(marker.Key), aws.ToString(marker.VersionId)); err != nil {
				return nil, err
			}
		}
		if !aws.ToBool(result.IsTruncated) {
			break
		}
		if result.NextKeyMarker == nil || aws.ToString(result.NextKeyMarker) == "" {
			return nil, fmt.Errorf("S3 returned a truncated version listing without a next key marker for %q", prefix)
		}
		if !strings.HasPrefix(aws.ToString(result.NextKeyMarker), prefix) {
			return nil, fmt.Errorf("S3 returned a next key marker outside requested prefix %q: %q", prefix, aws.ToString(result.NextKeyMarker))
		}
		if result.NextVersionIdMarker != nil && aws.ToString(result.NextVersionIdMarker) == "" {
			return nil, fmt.Errorf("S3 returned an empty next version marker for %q", prefix)
		}
		markerKey := aws.ToString(result.NextKeyMarker) + "\x00"
		if result.NextVersionIdMarker != nil {
			markerKey += aws.ToString(result.NextVersionIdMarker)
		}
		if _, exists := seenMarkers[markerKey]; exists {
			return nil, fmt.Errorf("S3 returned a repeated version listing marker for %q", prefix)
		}
		seenMarkers[markerKey] = struct{}{}
		keyMarker = result.NextKeyMarker
		versionIDMarker = result.NextVersionIdMarker
	}
	return identifiers, nil
}

func appendAWSLiveSmokeIdentifier(identifiers *[]types.ObjectIdentifier, seen map[string]struct{}, prefix, key, versionID string) error {
	if key == "" || versionID == "" {
		return fmt.Errorf("S3 version listing contains an entry without a key or version ID for %q", prefix)
	}
	if !strings.HasPrefix(key, prefix) {
		return fmt.Errorf("S3 version listing returned key %q outside exact requested prefix %q", key, prefix)
	}
	identity := key + "\x00" + versionID
	if _, exists := seen[identity]; exists {
		return fmt.Errorf("S3 version listing repeated key %q version %q", key, versionID)
	}
	seen[identity] = struct{}{}
	*identifiers = append(*identifiers, types.ObjectIdentifier{Key: aws.String(key), VersionId: aws.String(versionID)})
	return nil
}

func deleteAWSLiveSmokeVersions(ctx context.Context, client awsLiveSmokeVersionAPI, bucket, prefix string, identifiers []types.ObjectIdentifier, spec awsLiveSmokePrefixSpec) error {
	if err := validateAWSLiveSmokePrefix(prefix, spec); err != nil {
		return err
	}
	if client == nil {
		return errors.New("AWS smoke version client is required")
	}
	if bucket == "" {
		return errors.New("AWS smoke bucket is required")
	}
	for index, identifier := range identifiers {
		key, versionID := aws.ToString(identifier.Key), aws.ToString(identifier.VersionId)
		if key == "" || versionID == "" || !strings.HasPrefix(key, prefix) {
			return fmt.Errorf("refusing AWS smoke version deletion outside exact prefix %q: key=%q version=%q", prefix, key, versionID)
		}
		identifiers[index] = types.ObjectIdentifier{Key: aws.String(key), VersionId: aws.String(versionID)}
	}

	var failures []string
	for start := 0; start < len(identifiers); start += 1000 {
		end := min(start+1000, len(identifiers))
		result, err := client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(bucket),
			Delete: &types.Delete{Objects: identifiers[start:end], Quiet: aws.Bool(true)},
		})
		if err != nil {
			failures = append(failures, fmt.Sprintf("batch %d-%d request: %v", start, end-1, err))
			continue
		}
		if result == nil {
			failures = append(failures, fmt.Sprintf("batch %d-%d returned an empty response", start, end-1))
			continue
		}
		for _, failure := range result.Errors {
			failures = append(failures, fmt.Sprintf("key %q version %q: %s (%s)", aws.ToString(failure.Key), aws.ToString(failure.VersionId), aws.ToString(failure.Message), aws.ToString(failure.Code)))
		}
	}
	if len(failures) != 0 {
		return fmt.Errorf("delete versions from s3://%s/%s: %s", bucket, prefix, strings.Join(failures, "; "))
	}
	return nil
}

func cleanupAWSLiveSmokePrefix(ctx context.Context, client awsLiveSmokeVersionAPI, bucket, prefix string, spec awsLiveSmokePrefixSpec) error {
	if err := validateAWSLiveSmokePrefix(prefix, spec); err != nil {
		return err
	}
	var lastDeleteErr error
	for attempt := 1; attempt <= awsLiveSmokeCleanupAttempts; attempt++ {
		identifiers, err := listAWSLiveSmokeVersions(ctx, client, bucket, prefix, spec)
		if err != nil {
			return err
		}
		if len(identifiers) == 0 {
			return nil
		}
		lastDeleteErr = deleteAWSLiveSmokeVersions(ctx, client, bucket, prefix, identifiers, spec)

		// Relist after every delete attempt, including partial per-object
		// failures, so success is based on observed provider state.
		remaining, listErr := listAWSLiveSmokeVersions(ctx, client, bucket, prefix, spec)
		if listErr != nil {
			return fmt.Errorf("verify AWS smoke cleanup after delete attempt %d (delete error: %v): %w", attempt, lastDeleteErr, listErr)
		}
		if len(remaining) == 0 {
			return nil
		}
		if attempt == awsLiveSmokeCleanupAttempts {
			return fmt.Errorf("AWS smoke cleanup left %d object versions or delete markers beneath %q after %d attempts (last delete error: %v); residuals: %s", len(remaining), prefix, attempt, lastDeleteErr, describeAWSLiveSmokeResiduals(remaining))
		}
	}
	return fmt.Errorf("AWS smoke cleanup did not complete beneath %q (last delete error: %v)", prefix, lastDeleteErr)
}

func describeAWSLiveSmokeResiduals(identifiers []types.ObjectIdentifier) string {
	values := make([]string, 0, len(identifiers))
	for _, identifier := range identifiers {
		values = append(values, fmt.Sprintf("%s@%s", aws.ToString(identifier.Key), aws.ToString(identifier.VersionId)))
	}
	sort.Strings(values)
	if len(values) > 5 {
		values = append(values[:5], fmt.Sprintf("... (%d more)", len(identifiers)-5))
	}
	return strings.Join(values, ", ")
}

type awsLiveSmokeVersionItem struct {
	key          string
	versionID    string
	deleteMarker bool
}

type awsLiveSmokeVersionFake struct {
	items            []awsLiveSmokeVersionItem
	pageSize         int
	injectOutside    bool
	failOnce         map[string]bool
	retain           map[string]bool
	listRequests     []*s3.ListObjectVersionsInput
	listNextMarkers  []awsLiveSmokeListMarker
	deleteBatchSizes []int
	deleteFailures   []types.Error
}

type awsLiveSmokeListMarker struct {
	key       string
	versionID string
	truncated bool
}

func (client *awsLiveSmokeVersionFake) ListObjectVersions(_ context.Context, input *s3.ListObjectVersionsInput, _ ...func(*s3.Options)) (*s3.ListObjectVersionsOutput, error) {
	copyInput := *input
	client.listRequests = append(client.listRequests, &copyInput)
	prefix := aws.ToString(input.Prefix)
	items := make([]awsLiveSmokeVersionItem, 0, len(client.items))
	for _, item := range client.items {
		if strings.HasPrefix(item.key, prefix) {
			items = append(items, item)
		}
	}
	if client.injectOutside {
		items = append(items, awsLiveSmokeVersionItem{key: strings.TrimSuffix(prefix, "/") + "-outside/object", versionID: "outside-v1"})
		client.injectOutside = false
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].key == items[j].key {
			return items[i].versionID < items[j].versionID
		}
		return items[i].key < items[j].key
	})
	start := 0
	if input.KeyMarker != nil {
		found := false
		for index, item := range items {
			if item.key == aws.ToString(input.KeyMarker) && item.versionID == aws.ToString(input.VersionIdMarker) {
				start, found = index+1, true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("unknown version continuation marker %q@%q", aws.ToString(input.KeyMarker), aws.ToString(input.VersionIdMarker))
		}
	}
	pageSize := client.pageSize
	if pageSize <= 0 {
		pageSize = 1000
	}
	end := min(start+pageSize, len(items))
	result := &s3.ListObjectVersionsOutput{IsTruncated: aws.Bool(end < len(items))}
	for _, item := range items[start:end] {
		if item.deleteMarker {
			result.DeleteMarkers = append(result.DeleteMarkers, types.DeleteMarkerEntry{Key: aws.String(item.key), VersionId: aws.String(item.versionID)})
		} else {
			result.Versions = append(result.Versions, types.ObjectVersion{Key: aws.String(item.key), VersionId: aws.String(item.versionID)})
		}
	}
	if end < len(items) {
		last := items[end-1]
		result.NextKeyMarker = aws.String(last.key)
		result.NextVersionIdMarker = aws.String(last.versionID)
	}
	client.listNextMarkers = append(client.listNextMarkers, awsLiveSmokeListMarker{
		key: aws.ToString(result.NextKeyMarker), versionID: aws.ToString(result.NextVersionIdMarker), truncated: aws.ToBool(result.IsTruncated),
	})
	return result, nil
}

func (client *awsLiveSmokeVersionFake) DeleteObjects(_ context.Context, input *s3.DeleteObjectsInput, _ ...func(*s3.Options)) (*s3.DeleteObjectsOutput, error) {
	objects := input.Delete.Objects
	client.deleteBatchSizes = append(client.deleteBatchSizes, len(objects))
	result := &s3.DeleteObjectsOutput{}
	for _, object := range objects {
		key, versionID := aws.ToString(object.Key), aws.ToString(object.VersionId)
		identity := key + "\x00" + versionID
		if client.failOnce[identity] {
			delete(client.failOnce, identity)
			failure := types.Error{Key: aws.String(key), VersionId: aws.String(versionID), Code: aws.String("InjectedFailure"), Message: aws.String("retry cleanup")}
			result.Errors = append(result.Errors, failure)
			client.deleteFailures = append(client.deleteFailures, failure)
			continue
		}
		if client.retain[identity] {
			continue
		}
		for index, item := range client.items {
			if item.key == key && item.versionID == versionID {
				client.items = append(client.items[:index], client.items[index+1:]...)
				break
			}
		}
	}
	return result, nil
}

func testAWSLiveSmokePrefixSpec(root string) (string, awsLiveSmokePrefixSpec) {
	spec := awsLiveSmokePrefixSpec{root: root, site: "sre", label: "artifact-pages-preview-flow-smoke", randomHexSize: 32}
	return fmt.Sprintf("%s/%s/.%s-%s/", spec.root, spec.site, spec.label, strings.Repeat("a", spec.randomHexSize)), spec
}

func TestAWSLiveSmokeVersionCleanupPaginatesAndBatches(t *testing.T) {
	prefix, spec := testAWSLiveSmokePrefixSpec("_previews")
	client := &awsLiveSmokeVersionFake{pageSize: 137}
	for index := 0; index < 1005; index++ {
		client.items = append(client.items, awsLiveSmokeVersionItem{
			key: prefix + fmt.Sprintf("key-%04d", index), versionID: fmt.Sprintf("version-%04d", index), deleteMarker: index%11 == 0,
		})
	}
	if err := cleanupAWSLiveSmokePrefix(context.Background(), client, "disposable-bucket", prefix, spec); err != nil {
		t.Fatalf("cleanupAWSLiveSmokePrefix(): %v", err)
	}
	if len(client.items) != 0 {
		t.Fatalf("residual versions and delete markers = %d, want 0", len(client.items))
	}
	if len(client.deleteBatchSizes) != 2 || client.deleteBatchSizes[0] != 1000 || client.deleteBatchSizes[1] != 5 {
		t.Fatalf("DeleteObjects batch sizes = %v, want [1000 5]", client.deleteBatchSizes)
	}
	if len(client.listRequests) != 9 {
		t.Fatalf("ListObjectVersions calls = %d, want 9 pages for initial relist plus final empty verification", len(client.listRequests))
	}
	for index, request := range client.listRequests {
		if aws.ToString(request.Prefix) != prefix || aws.ToString(request.Bucket) != "disposable-bucket" {
			t.Fatalf("list request %d escaped bucket/prefix: %+v", index, request)
		}
		if index == 0 {
			if request.KeyMarker != nil || request.VersionIdMarker != nil {
				t.Fatalf("first list request has continuation markers: %+v", request)
			}
			continue
		}
		if index < 8 {
			previousPage := client.listNextMarkers[index-1]
			if !previousPage.truncated || aws.ToString(request.KeyMarker) != previousPage.key || aws.ToString(request.VersionIdMarker) != previousPage.versionID {
				t.Fatalf("version listing request %d marker = %q@%q; previous page marker=%+v", index, aws.ToString(request.KeyMarker), aws.ToString(request.VersionIdMarker), previousPage)
			}
		} else if request.KeyMarker != nil || request.VersionIdMarker != nil {
			t.Fatalf("post-delete verification did not restart listing at the prefix: %+v", request)
		}
	}
	if len(client.deleteFailures) != 0 {
		t.Fatalf("unexpected per-object deletion errors: %+v", client.deleteFailures)
	}
}

func TestAWSLiveSmokeVersionCleanupRejectsOutsidePrefix(t *testing.T) {
	prefix, spec := testAWSLiveSmokePrefixSpec("_previews")
	client := &awsLiveSmokeVersionFake{pageSize: 10, injectOutside: true}
	if err := cleanupAWSLiveSmokePrefix(context.Background(), client, "disposable-bucket", prefix, spec); err == nil || !strings.Contains(err.Error(), "outside exact requested prefix") {
		t.Fatalf("cleanup with an outside-prefix listing returned %v; want refusal", err)
	}
	if len(client.deleteBatchSizes) != 0 {
		t.Fatalf("DeleteObjects calls = %v, want none after outside-prefix listing", client.deleteBatchSizes)
	}
	before := len(client.listRequests)
	if err := cleanupAWSLiveSmokePrefix(context.Background(), client, "disposable-bucket", "_previews/sre/", spec); err == nil {
		t.Fatal("cleanup accepted a broad site prefix; want exact-random-prefix refusal")
	}
	if len(client.listRequests) != before {
		t.Fatalf("broad prefix refusal issued a ListObjectVersions request: before=%d after=%d", before, len(client.listRequests))
	}
}

func TestAWSLiveSmokeVersionCleanupRetriesPartialDeleteFailure(t *testing.T) {
	prefix, spec := testAWSLiveSmokePrefixSpec("_previews")
	failedIdentity := prefix + "catalog.json\x00catalog-v1"
	client := &awsLiveSmokeVersionFake{
		pageSize: 10,
		items: []awsLiveSmokeVersionItem{
			{key: prefix + "catalog.json", versionID: "catalog-v1"},
			{key: prefix + "file.html", versionID: "file-v1"},
			{key: prefix + "lock.json", versionID: "lock-delete-marker", deleteMarker: true},
		},
		failOnce: map[string]bool{failedIdentity: true},
	}
	if err := cleanupAWSLiveSmokePrefix(context.Background(), client, "disposable-bucket", prefix, spec); err != nil {
		t.Fatalf("cleanup after one partial failure: %v", err)
	}
	if len(client.items) != 0 || len(client.deleteBatchSizes) != 2 || len(client.deleteFailures) != 1 {
		t.Fatalf("retry result: residuals=%v batches=%v failures=%v; want empty, two attempts, one injected failure", client.items, client.deleteBatchSizes, client.deleteFailures)
	}
}

func TestAWSLiveSmokeVersionCleanupReportsPersistentResidual(t *testing.T) {
	prefix, spec := testAWSLiveSmokePrefixSpec("_previews")
	identity := prefix + "retained.json\x00retained-v1"
	client := &awsLiveSmokeVersionFake{
		pageSize: 10,
		items:    []awsLiveSmokeVersionItem{{key: prefix + "retained.json", versionID: "retained-v1"}},
		retain:   map[string]bool{identity: true},
	}
	err := cleanupAWSLiveSmokePrefix(context.Background(), client, "disposable-bucket", prefix, spec)
	if err == nil || !strings.Contains(err.Error(), "left 1 object versions or delete markers") || !strings.Contains(err.Error(), "retained-v1") {
		t.Fatalf("cleanup persistent residual error = %v; want residual key and version", err)
	}
	if len(client.listRequests) != awsLiveSmokeCleanupAttempts*2 || len(client.deleteBatchSizes) != awsLiveSmokeCleanupAttempts {
		t.Fatalf("cleanup did not relist after each attempt: list calls=%d delete calls=%d", len(client.listRequests), len(client.deleteBatchSizes))
	}
}
