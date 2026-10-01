package publisher

import (
	"context"
	"errors"
)

var (
	ErrObjectNotFound     = errors.New("deployment object not found")
	ErrPreconditionFailed = errors.New("deployment object condition did not match")
)

// Object is the provider-neutral representation of a projected static object.
// Provider adapters translate its metadata and bytes to their native API.
type Object struct {
	Bytes              []byte
	ContentType        string
	ContentDisposition string
	ContentEncoding    string
	Cache              string
	Metadata           map[string]string
}

type ObjectInfo struct {
	ETag               string
	Size               int64
	ContentType        string
	ContentDisposition string
	ContentEncoding    string
	CacheControl       string
	Metadata           map[string]string
}

// DeploymentBackend is the narrow provider boundary used by the application
// and site publication flows. Implementations own bucket/container selection,
// pagination, delete batching, cache revalidation, and provider error mapping.
// AWS and Cloudflare adapters must satisfy this same contract.
type DeploymentBackend interface {
	PutObject(context.Context, string, Object) error
	ListKeys(context.Context, string) ([]string, error)
	DeleteObjects(context.Context, []string) error
	Invalidate(context.Context, []string) (string, error)
}

// ObjectMetadataBackend exposes origin metadata reads for workflows that need
// to distinguish an unchanged object from a changed deployment. Provider
// adapters keep the native metadata API behind this small interface.
type ObjectMetadataBackend interface {
	DeploymentBackend
	HeadObject(context.Context, string) (ObjectInfo, error)
}

// ObjectCondition makes a write conditional on the current origin version.
// At most one condition may be set. Provider adapters translate it to their
// native compare-and-swap request; the publishing workflow stays provider-free.
type ObjectCondition struct {
	IfMatchETag string
	IfNoneMatch bool
}

// ConditionalObjectBackend extends the static projection API with the small
// origin reads and compare-and-swap writes required by registry and lock
// control objects. It deliberately leaves provider SDK types at the adapter.
type ConditionalObjectBackend interface {
	DeploymentBackend
	GetObject(context.Context, string) (Object, string, error)
	HeadObject(context.Context, string) (ObjectInfo, error)
	PutObjectConditional(context.Context, string, Object, ObjectCondition) (string, error)
}

// InvalidationValidator checks local provider credentials/configuration for a
// non-empty cache invalidation request before a workflow mutates origin data.
// Providers without this optional capability keep their existing behavior.
type InvalidationValidator interface {
	ValidateInvalidation([]string) error
}

// InvalidationPlanner exposes adapter-specific path compaction to read-only
// plans and reports without issuing a cache request.
type InvalidationPlanner interface {
	PlanInvalidation([]string) []string
}

func plannedInvalidationPaths(backend DeploymentBackend, paths []string) []string {
	if planner, ok := backend.(InvalidationPlanner); ok {
		return planner.PlanInvalidation(paths)
	}
	return paths
}

func validateInvalidation(backend DeploymentBackend, paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	if validator, ok := backend.(InvalidationValidator); ok {
		return validator.ValidateInvalidation(paths)
	}
	return nil
}
