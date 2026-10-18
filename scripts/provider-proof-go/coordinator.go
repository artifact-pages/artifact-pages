package providerproof

import (
	"context"
	"errors"
	"fmt"
)

var ErrDenied = errors.New("provider-proof request denied")

type Capability struct {
	Phase                  string
	Context                string
	ProofBucket            string
	PreservedBucket        string
	ProofDistribution      string
	PreservedDistribution  string
	CloudflareAccount      string
	CloudflareBucket       string
	CloudflareProductionID string
	ObservationStarted     bool
	ObservationClosed      bool
	ObservationCensored    bool
	A9Resolved             bool
	DestroyPlanAccepted    bool
}

type Operation struct {
	Service        string
	Action         string
	Method         string
	AccountID      string
	Bucket         string
	DistributionID string
	Key            string
	Keys           []string
	Paths          []string
	RawRequest     bool
	Endpoint       string
}

type Request struct {
	Operation Operation
	Body      []byte
}

type CredentialLoader func(context.Context) ([]byte, error)
type Transport func(context.Context, Request) error

type Client struct {
	capability Capability
	load       CredentialLoader
	transport  Transport
	serialize  func(Operation) ([]byte, error)
}

func NewClient(capability Capability, load CredentialLoader, transport Transport) *Client {
	return &Client{
		capability: capability,
		load:       load,
		transport:  transport,
		serialize: func(operation Operation) ([]byte, error) {
			return []byte(fmt.Sprintf("%s %s %s %s", operation.Method, operation.Service, operation.Action, operation.Key)), nil
		},
	}
}

func (client *Client) Request(ctx context.Context, operation Operation) error {
	if err := authorize(client.capability, operation); err != nil {
		return err
	}
	body, err := client.serialize(operation)
	if err != nil {
		return err
	}
	final := operation
	if err := authorize(client.capability, final); err != nil {
		return err
	}
	if client.load == nil || client.transport == nil {
		return fmt.Errorf("%w: missing guarded dependency", ErrDenied)
	}
	credentials, err := client.load(ctx)
	if err != nil {
		return err
	}
	request := Request{Operation: final, Body: append([]byte(nil), body...)}
	_ = credentials // Credentials remain in memory and are never formatted or logged.
	return client.transport(ctx, request)
}

func authorize(capability Capability, operation Operation) error {
	if operation.RawRequest || operation.Endpoint == "" {
		return fmt.Errorf("%w: raw or unbound endpoint", ErrDenied)
	}
	if capability.Context == "offline" {
		return fmt.Errorf("%w: offline context", ErrDenied)
	}
	if operation.Bucket == capability.PreservedBucket || operation.DistributionID == capability.PreservedDistribution {
		if capability.Context != "inventory" && capability.Context != "preservation" {
			return fmt.Errorf("%w: preserved AWS resource", ErrDenied)
		}
		if !isRead(operation.Action) {
			return fmt.Errorf("%w: preserved resource is read-only", ErrDenied)
		}
	}
	if operation.AccountID == capability.CloudflareProductionID || operation.Bucket == "artifact-pages" {
		return fmt.Errorf("%w: production target", ErrDenied)
	}
	if operation.Bucket != "" && operation.Bucket != capability.ProofBucket && operation.Bucket != capability.PreservedBucket && operation.Bucket != capability.CloudflareBucket {
		return fmt.Errorf("%w: unrelated bucket", ErrDenied)
	}
	if operation.DistributionID != "" && operation.DistributionID != capability.ProofDistribution && operation.DistributionID != capability.PreservedDistribution {
		return fmt.Errorf("%w: unbound distribution", ErrDenied)
	}
	if capability.Context == "inventory" && (operation.Bucket == capability.ProofBucket) && !isAvailabilityRead(operation.Action) {
		return fmt.Errorf("%w: new AWS inventory is availability-only", ErrDenied)
	}
	if capability.Context == "proof" && operation.Bucket == capability.PreservedBucket {
		return fmt.Errorf("%w: proof-to-preserved target", ErrDenied)
	}
	if capability.Context == "lifecycle-owner" {
		if operation.Service == "cloudflare-api" && operation.Action == "UpdateLifecycle" {
			if operation.Key != "_previews/proof-life-20261018/" {
				return fmt.Errorf("%w: lifecycle prefix", ErrDenied)
			}
			return nil
		}
		if operation.Service == "state" && isLifecycleStateKey(operation.Key) && operation.Action != "DeleteStateObject" {
			return nil
		}
		return fmt.Errorf("%w: lifecycle owner scope", ErrDenied)
	}
	if capability.Context == "observer" {
		if !isRead(operation.Action) || !isLifeKey(operation.Key, operation.Keys) {
			return fmt.Errorf("%w: observation is read-only and life-scoped", ErrDenied)
		}
	}
	if capability.Context == "cleanup-post-a7" {
		if operation.Action == "TerraformDestroy" || isLifeKey(operation.Key, operation.Keys) {
			return fmt.Errorf("%w: post-a7 preserves life and stack", ErrDenied)
		}
	}
	if capability.Context == "cleanup-final-a8" {
		if !capability.ObservationClosed || !capability.A9Resolved || !capability.DestroyPlanAccepted {
			return fmt.Errorf("%w: final cleanup gate", ErrDenied)
		}
		if operation.Action == "TerraformDestroy" && operation.DistributionID == capability.PreservedDistribution {
			return fmt.Errorf("%w: preserved distribution", ErrDenied)
		}
	}
	if capability.Context == "proof" && (capability.Phase == "A7-proof" || capability.ObservationStarted) && containsLifeKey(operation.Key, operation.Keys) && !isRead(operation.Action) {
		return fmt.Errorf("%w: life observation freeze", ErrDenied)
	}
	if capability.Context == "proof" || capability.Context == "gzip" || capability.Context == "observer" || capability.Context == "cleanup" {
		for _, key := range append(append([]string(nil), operation.Keys...), operation.Key) {
			if key != "" && !isProofKey(key) && operation.Bucket == capability.ProofBucket {
				return fmt.Errorf("%w: proof key outside sealed namespace", ErrDenied)
			}
		}
	}
	return nil
}

func isRead(action string) bool {
	switch action {
	case "GetObject", "HeadObject", "ListObjectsV2", "ListObjectVersions", "GetBucketLifecycleConfiguration", "GetBucketVersioning", "GetDistribution", "GetDistributionConfig", "GetLifecycle", "GetStateObject":
		return true
	default:
		return false
	}
}

func isAvailabilityRead(action string) bool {
	return action == "HeadBucket" || action == "ListBuckets"
}

func isLifeKey(key string, keys []string) bool {
	if len(keys) > 0 {
		for _, item := range keys {
			if !isLifeKey(item, nil) {
				return false
			}
		}
		return true
	}
	return key == "_previews/proof-life-20261018/" || len(key) > len("_previews/proof-life-20261018/") && key[:len("_previews/proof-life-20261018/")] == "_previews/proof-life-20261018/"
}

func containsLifeKey(key string, keys []string) bool {
	if isLifeKey(key, nil) {
		return true
	}
	for _, item := range keys {
		if isLifeKey(item, nil) {
			return true
		}
	}
	return false
}

func isProofKey(key string) bool {
	return isLifeKey(key, nil) || containsProofSite(key)
}

func containsProofSite(key string) bool {
	for _, site := range []string{"proof-a-20261018", "proof-b-20261018", "proof-neighbor-20261018", "proof-life-20261018"} {
		if len(key) > len(site) && key[:len(site)] == site && key[len(site)] == '/' {
			return true
		}
		for _, prefix := range []string{"_indexes/", "_artifacts/", "_previews/", "_control/sites/"} {
			candidate := prefix + site + "/"
			if len(key) >= len(candidate) && key[:len(candidate)] == candidate {
				return true
			}
		}
	}
	return key == "_indexes/sites.json" || key == "index.html" || key == "preview-bridge.js" || len(key) > len("assets/") && key[:len("assets/")] == "assets/"
}

func isLifecycleStateKey(key string) bool {
	return key == "terraform/verify.tfstate" || key == "terraform/verify.tfstate.tflock"
}
