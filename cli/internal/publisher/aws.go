package publisher

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cloudfront"
	cloudfronttypes "github.com/aws/aws-sdk-go-v2/service/cloudfront/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

type s3API interface {
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	ListObjectsV2(context.Context, *s3.ListObjectsV2Input, ...func(*s3.Options)) (*s3.ListObjectsV2Output, error)
	DeleteObjects(context.Context, *s3.DeleteObjectsInput, ...func(*s3.Options)) (*s3.DeleteObjectsOutput, error)
}

type s3GetObjectAPI interface {
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
}

type s3HeadObjectAPI interface {
	HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
}

type cloudFrontAPI interface {
	CreateInvalidation(context.Context, *cloudfront.CreateInvalidationInput, ...func(*cloudfront.Options)) (*cloudfront.CreateInvalidationOutput, error)
}

type awsClients struct {
	s3         s3API
	cloudFront cloudFrontAPI
}

type AWSOptions struct {
	Region         string
	Bucket         string
	DistributionID string
}

// s3CompatibleBackend implements object operations shared by AWS S3 and R2.
// Provider-specific configuration and cache invalidation stay in their wrappers.
type s3CompatibleBackend struct {
	client s3API
	bucket string
}

// awsBackend combines the shared S3-compatible object operations with AWS's
// CloudFront invalidation API. The publication flow sees only backend interfaces.
type awsBackend struct {
	*s3CompatibleBackend
	cloudFront     cloudFrontAPI
	distributionID string
}

var _ DeploymentBackend = (*awsBackend)(nil)
var _ ConditionalObjectBackend = (*awsBackend)(nil)

func NewAWSBackend(ctx context.Context, options AWSOptions) (DeploymentBackend, error) {
	if options.Bucket == "" {
		return nil, fmt.Errorf("AWS deployment bucket is required")
	}
	clients, err := newAWSClients(ctx, options)
	if err != nil {
		return nil, err
	}
	return newAWSBackend(clients, options)
}

func newAWSBackend(clients awsClients, options AWSOptions) (*awsBackend, error) {
	if clients.s3 == nil {
		return nil, fmt.Errorf("AWS S3 client is required")
	}
	if options.Bucket == "" {
		return nil, fmt.Errorf("AWS deployment bucket is required")
	}
	objects, err := newS3CompatibleBackend(clients.s3, options.Bucket)
	if err != nil {
		return nil, err
	}
	return &awsBackend{
		s3CompatibleBackend: objects,
		cloudFront:          clients.cloudFront,
		distributionID:      options.DistributionID,
	}, nil
}

func newS3CompatibleBackend(client s3API, bucket string) (*s3CompatibleBackend, error) {
	if client == nil {
		return nil, fmt.Errorf("S3-compatible object client is required")
	}
	if bucket == "" {
		return nil, fmt.Errorf("S3-compatible object bucket is required")
	}
	return &s3CompatibleBackend{client: client, bucket: bucket}, nil
}

func (backend *s3CompatibleBackend) PutObject(ctx context.Context, key string, object Object) error {
	return putObject(ctx, backend.client, backend.bucket, key, object)
}

func (backend *s3CompatibleBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	client, ok := backend.client.(s3GetObjectAPI)
	if !ok {
		return Object{}, "", errors.New("S3-compatible client does not support object reads")
	}
	result, err := client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(backend.bucket), Key: aws.String(key)})
	if err != nil {
		return Object{}, "", mapS3ConditionError(err)
	}
	if result == nil || result.Body == nil {
		return Object{}, "", errors.New("S3-compatible service returned an empty object response")
	}
	defer result.Body.Close()
	contents, err := io.ReadAll(result.Body)
	if err != nil {
		return Object{}, "", fmt.Errorf("read s3://%s/%s: %w", backend.bucket, key, err)
	}
	object := Object{
		Bytes: contents, ContentType: aws.ToString(result.ContentType),
		ContentDisposition: aws.ToString(result.ContentDisposition), ContentEncoding: aws.ToString(result.ContentEncoding),
		Cache: aws.ToString(result.CacheControl), Metadata: result.Metadata,
	}
	return object, aws.ToString(result.ETag), nil
}

func (backend *s3CompatibleBackend) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	client, ok := backend.client.(s3HeadObjectAPI)
	if !ok {
		return ObjectInfo{}, errors.New("S3-compatible client does not support object metadata reads")
	}
	result, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(backend.bucket), Key: aws.String(key)})
	if err != nil {
		err = mapS3ConditionError(err)
		if errors.Is(err, ErrObjectNotFound) || !isS3ResponseStatus(err, 404) || isS3APIErrorCode(err, "NoSuchBucket") {
			return ObjectInfo{}, err
		}

		// S3-compatible HEAD responses can return an ambiguous 404. Confirm
		// absence with a listing scoped to this key, then compare exact keys so
		// a longer prefix neighbor does not make the missing object look present.
		keys, confirmErr := listKeys(ctx, backend.client, backend.bucket, key)
		if confirmErr != nil {
			return ObjectInfo{}, fmt.Errorf("HeadObject for s3://%s/%s returned an ambiguous 404: %w; ListBucket confirmation failed: %w", backend.bucket, key, err, confirmErr)
		}
		for _, listedKey := range keys {
			if listedKey == key {
				return ObjectInfo{}, err
			}
		}
		return ObjectInfo{}, fmt.Errorf("%w: %v", ErrObjectNotFound, err)
	}
	if result == nil {
		return ObjectInfo{}, errors.New("S3-compatible service returned an empty object metadata response")
	}
	return ObjectInfo{
		ETag: aws.ToString(result.ETag), Size: aws.ToInt64(result.ContentLength),
		ContentType: aws.ToString(result.ContentType), ContentDisposition: aws.ToString(result.ContentDisposition),
		ContentEncoding: aws.ToString(result.ContentEncoding), CacheControl: aws.ToString(result.CacheControl),
		Metadata: result.Metadata,
	}, nil
}

func (backend *s3CompatibleBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	if condition.IfNoneMatch && condition.IfMatchETag != "" {
		return "", errors.New("conditional object write cannot use both If-Match and If-None-Match")
	}
	input := &s3.PutObjectInput{
		Bucket: aws.String(backend.bucket), Key: aws.String(key), Body: bytes.NewReader(object.Bytes),
		ContentLength: aws.Int64(int64(len(object.Bytes))), ContentType: aws.String(object.ContentType),
		CacheControl: aws.String(object.Cache), Metadata: object.Metadata,
	}
	if object.ContentDisposition != "" {
		input.ContentDisposition = aws.String(object.ContentDisposition)
	}
	if object.ContentEncoding != "" {
		input.ContentEncoding = aws.String(object.ContentEncoding)
	}
	if condition.IfNoneMatch {
		input.IfNoneMatch = aws.String("*")
	}
	if condition.IfMatchETag != "" {
		input.IfMatch = aws.String(condition.IfMatchETag)
	}
	result, err := backend.client.PutObject(ctx, input)
	if err != nil {
		return "", mapS3ConditionError(err)
	}
	if result == nil {
		return "", nil
	}
	return aws.ToString(result.ETag), nil
}

func (backend *s3CompatibleBackend) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	return listKeys(ctx, backend.client, backend.bucket, prefix)
}

func (backend *s3CompatibleBackend) DeleteObjects(ctx context.Context, keys []string) error {
	return deleteKeys(ctx, backend.client, backend.bucket, keys)
}

func (backend *awsBackend) Invalidate(ctx context.Context, paths []string) (string, error) {
	return invalidate(ctx, backend.cloudFront, backend.distributionID, backend.PlanInvalidation(paths))
}

func (backend *awsBackend) PlanInvalidation(paths []string) []string {
	return awsSiteInvalidationPaths(paths)
}

// CloudFront cannot invalidate a tilde path, and literal '*' resource URLs
// cannot be expressed as an exact invalidation. Bulk site publishes also must
// not send an unbounded exact-path batch. Coalesce only the affected site's
// artifact subtree, leaving indexes, other sites, and application paths alone.
func awsSiteInvalidationPaths(paths []string) []string {
	counts := make(map[string]int)
	fallback := make(map[string]bool)
	prefixFor := func(p string) string {
		parts := strings.SplitN(strings.TrimPrefix(p, "/_artifacts/"), "/", 2)
		if !strings.HasPrefix(p, "/_artifacts/") || len(parts) != 2 || validateLockSite(parts[0]) != nil {
			return ""
		}
		return "/_artifacts/" + parts[0] + "/"
	}
	for _, p := range paths {
		prefix := prefixFor(p)
		if prefix == "" {
			continue
		}
		counts[prefix]++
		decoded, _ := url.PathUnescape(p)
		if strings.Contains(decoded, "~") || strings.Contains(strings.ToUpper(p), "%2A") || len(p) > 4000 || counts[prefix] > 1000 {
			fallback[prefix] = true
		}
	}
	if len(fallback) == 0 {
		return paths
	}
	set := make(map[string]bool)
	for _, p := range paths {
		if prefix := prefixFor(p); fallback[prefix] {
			set[prefix+"*"] = true
		} else {
			set[p] = true
		}
	}
	result := make([]string, 0, len(set))
	for p := range set {
		result = append(result, p)
	}
	sort.Strings(result)
	return result
}

func newAWSClients(ctx context.Context, options AWSOptions) (awsClients, error) {
	loadOptions := make([]func(*config.LoadOptions) error, 0, 1)
	if options.Region != "" {
		loadOptions = append(loadOptions, config.WithRegion(options.Region))
	}
	cfg, err := config.LoadDefaultConfig(ctx, loadOptions...)
	if err != nil {
		return awsClients{}, fmt.Errorf("load AWS configuration: %w", err)
	}
	cloudFrontConfig := cfg
	cloudFrontConfig.Region = "us-east-1"
	return awsClients{
		s3:         s3.NewFromConfig(cfg),
		cloudFront: cloudfront.NewFromConfig(cloudFrontConfig),
	}, nil
}

func putObject(ctx context.Context, client s3API, bucket, key string, object Object) error {
	input := &s3.PutObjectInput{
		Bucket:        aws.String(bucket),
		Key:           aws.String(key),
		Body:          bytes.NewReader(object.Bytes),
		ContentLength: aws.Int64(int64(len(object.Bytes))),
		ContentType:   aws.String(object.ContentType),
		CacheControl:  aws.String(object.Cache),
		Metadata:      object.Metadata,
	}
	if object.ContentDisposition != "" {
		input.ContentDisposition = aws.String(object.ContentDisposition)
	}
	if object.ContentEncoding != "" {
		input.ContentEncoding = aws.String(object.ContentEncoding)
	}
	_, err := client.PutObject(ctx, input)
	if err != nil {
		return fmt.Errorf("upload s3://%s/%s: %w", bucket, key, err)
	}
	return nil
}

func invalidate(ctx context.Context, client cloudFrontAPI, distributionID string, paths []string) (string, error) {
	if len(paths) == 0 || strings.TrimSpace(distributionID) == "" {
		return "", nil
	}
	if client == nil {
		return "", errors.New("CloudFront client is required to invalidate non-empty paths")
	}
	callerReference := fmt.Sprintf("artifact-pages-%d", time.Now().UnixNano())
	result, err := client.CreateInvalidation(ctx, &cloudfront.CreateInvalidationInput{
		DistributionId: aws.String(distributionID),
		InvalidationBatch: &cloudfronttypes.InvalidationBatch{
			CallerReference: aws.String(callerReference),
			Paths: &cloudfronttypes.Paths{
				Quantity: aws.Int32(int32(len(paths))),
				Items:    paths,
			},
		},
	})
	if err != nil {
		return "", fmt.Errorf("invalidate CloudFront distribution %s: %w", distributionID, err)
	}
	if result != nil && result.Invalidation != nil {
		return aws.ToString(result.Invalidation.Id), nil
	}
	return "", nil
}

func listKeys(ctx context.Context, client s3API, bucket, prefix string) ([]string, error) {
	var keys []string
	var token *string
	seenTokens := make(map[string]struct{})
	for {
		result, err := client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(bucket),
			Prefix:            aws.String(prefix),
			ContinuationToken: token,
		})
		if err != nil {
			return nil, fmt.Errorf("list s3://%s/%s: %w", bucket, prefix, err)
		}
		if result == nil {
			return nil, fmt.Errorf("S3 returned an empty listing response for %q", prefix)
		}
		if result.IsTruncated == nil {
			return nil, fmt.Errorf("S3 listing response is missing truncation status for %q", prefix)
		}
		for _, object := range result.Contents {
			if object.Key == nil || *object.Key == "" {
				return nil, fmt.Errorf("S3 listing response contains an object without a key for %q", prefix)
			}
			if !strings.HasPrefix(*object.Key, prefix) {
				return nil, fmt.Errorf("S3 listing returned key %q outside requested prefix %q", *object.Key, prefix)
			}
			keys = append(keys, *object.Key)
		}
		if !*result.IsTruncated {
			break
		}
		token = result.NextContinuationToken
		if token == nil || *token == "" {
			return nil, fmt.Errorf("S3 returned a truncated listing without a continuation token for %q", prefix)
		}
		if _, exists := seenTokens[*token]; exists {
			return nil, fmt.Errorf("S3 returned a repeated continuation token for %q", prefix)
		}
		seenTokens[*token] = struct{}{}
	}
	return keys, nil
}

func deleteKeys(ctx context.Context, client s3API, bucket string, keys []string) error {
	for start := 0; start < len(keys); start += 1000 {
		end := min(start+1000, len(keys))
		objects := make([]types.ObjectIdentifier, 0, end-start)
		for _, key := range keys[start:end] {
			objects = append(objects, types.ObjectIdentifier{Key: aws.String(key)})
		}
		result, err := client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(bucket),
			Delete: &types.Delete{Objects: objects, Quiet: aws.Bool(true)},
		})
		if err != nil {
			return fmt.Errorf("delete stale objects from s3://%s: %w", bucket, err)
		}
		if result == nil {
			return fmt.Errorf("S3 returned an empty delete response for bucket %s", bucket)
		}
		if len(result.Errors) > 0 {
			failure := result.Errors[0]
			return fmt.Errorf("delete stale object %q from s3://%s: %s", aws.ToString(failure.Key), bucket, aws.ToString(failure.Message))
		}
	}
	return nil
}

func mapS3ConditionError(err error) error {
	var responseError *smithyhttp.ResponseError
	if errors.As(err, &responseError) {
		switch responseError.HTTPStatusCode() {
		case 404:
			if isS3APIErrorCode(err, "NoSuchKey") {
				return fmt.Errorf("%w: %v", ErrObjectNotFound, err)
			}
		case 409, 412:
			return fmt.Errorf("%w: %v", ErrPreconditionFailed, err)
		}
	}
	return err
}

func isS3ResponseStatus(err error, status int) bool {
	var responseError *smithyhttp.ResponseError
	return errors.As(err, &responseError) && responseError.HTTPStatusCode() == status
}

func isS3APIErrorCode(err error, code string) bool {
	var apiError smithy.APIError
	return errors.As(err, &apiError) && apiError.ErrorCode() == code
}
