package publisher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"github.com/artifact-pages/artifact-pages/cli/internal/compat"
	"github.com/artifact-pages/artifact-pages/cli/internal/config"
	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
	"github.com/artifact-pages/artifact-pages/cli/internal/registry"
)

const appVersionsKey = "_control/versions/app.json"
const registryVersionsKey = "_control/versions/registry.json"

type compatibilityContextKey struct{}
type CompatibilityOptions struct {
	Pinned         bool
	WebVersion     string
	AcceptBreaking bool
}

// WithCompatibility carries deployment-wide pins without changing adapter capabilities.
func WithCompatibility(ctx context.Context, configuration config.DeploymentConfig, acceptBreaking bool) context.Context {
	options := CompatibilityOptions{Pinned: configuration.CLI != nil || configuration.Web != nil, AcceptBreaking: acceptBreaking}
	if configuration.Web != nil {
		options.WebVersion = configuration.Web.Version
	}
	return context.WithValue(ctx, compatibilityContextKey{}, options)
}

func compatibilityOptions(ctx context.Context) CompatibilityOptions {
	options, _ := ctx.Value(compatibilityContextKey{}).(CompatibilityOptions)
	return options
}

type versionRecord struct {
	PendingWrites map[string]int   `json:"pendingWrites,omitempty"`
	Pending       bool             `json:"pending,omitempty"`
	SchemaVersion int              `json:"schemaVersion"`
	WebVersion    string           `json:"webVersion,omitempty"`
	CLIVersion    string           `json:"cliVersion,omitempty"`
	Reads         map[string][]int `json:"reads,omitempty"`
	Writes        map[string]int   `json:"writes,omitempty"`
}

func siteVersionsKey(site string) string { return "_control/sites/" + site + "/versions.json" }

func readVersionRecord(ctx context.Context, backend ConditionalObjectBackend, key string) (versionRecord, bool, error) {
	object, _, err := backend.GetObject(ctx, key)
	if errors.Is(err, ErrObjectNotFound) {
		return versionRecord{}, false, nil
	}
	if err != nil {
		return versionRecord{}, false, fmt.Errorf("read %s: %w", key, err)
	}
	if err := compat.CheckSchemaVersion(key, object.Bytes, 1); err != nil {
		return versionRecord{}, false, err
	}
	var record versionRecord
	if err := json.Unmarshal(object.Bytes, &record); err != nil {
		return record, false, fmt.Errorf("decode %s: %w", key, err)
	}
	if record.SchemaVersion != 1 || (key == appVersionsKey && (record.WebVersion == "" || len(record.Reads) == 0)) || (key != appVersionsKey && (record.CLIVersion == "" || len(record.Writes) == 0)) {
		return record, false, fmt.Errorf("invalid version record %s", key)
	}
	for name, schema := range record.Writes {
		if name == "" || schema < 1 {
			return record, false, fmt.Errorf("invalid formats in %s", key)
		}
	}
	for format, schema := range record.PendingWrites {
		if !record.Pending || schema < 1 || record.Writes[format] != schema {
			return record, false, fmt.Errorf("invalid pending formats in %s", key)
		}
	}
	if err := validateWebReads(record.Reads); err != nil {
		return record, false, fmt.Errorf("%s: %w", key, err)
	}
	return record, true, nil
}

func fetchWebReads(ctx context.Context, version string) (map[string][]int, error) {
	archive := "artifact-pages-web-v" + version + ".tar.gz"
	address := "https://github.com/artifact-pages/artifact-pages/releases/download/" + url.PathEscape("web/v"+version) + "/" + archive + ".json"
	contents, err := downloadReleaseAsset(ctx, address, 2<<20)
	if err != nil {
		return nil, err
	}
	var manifest releaseManifest
	if err := json.Unmarshal(contents, &manifest); err != nil {
		return nil, err
	}
	if manifest.SchemaVersion != 1 || manifest.Product != "artifact-pages" || manifest.Component != "web" || manifest.Version != version || manifest.Archive != archive || len(manifest.Reads) == 0 {
		return nil, errors.New("web release manifest has invalid identity or missing reads")
	}
	if err := validateWebReads(manifest.Reads); err != nil {
		return nil, err
	}
	return manifest.Reads, nil
}

func writerFormats(names ...string) map[string]int {
	result := map[string]int{}
	for _, name := range names {
		result[name] = compat.Current().Writes[name]
	}
	return result
}
func checkWriter(ctx context.Context, backend ConditionalObjectBackend, writes map[string]int) error {
	record, present, err := readVersionRecord(ctx, backend, appVersionsKey)
	if err != nil {
		return err
	}
	if present && record.Pending {
		return errors.New("deployed web compatibility is unknown: app deployment is incomplete; retry app deploy")
	}
	options := compatibilityOptions(ctx)
	if !present {
		if options.WebVersion != "" {
			record.Reads, err = fetchWebReads(ctx, options.WebVersion)
			if err != nil {
				return err
			}
		} else if options.Pinned {
			return errors.New("web compatibility is unknown: deploy web or set web.version")
		} else {
			return nil
		}
	}
	if err := compat.CheckReads(record.Reads, writes); err != nil && !options.AcceptBreaking {
		return err
	}
	return nil
}

func prepareWriterRecord(ctx context.Context, backend ConditionalObjectBackend, key string, writes map[string]int) (versionRecord, error) {
	prior, _, err := readVersionRecord(ctx, backend, key)
	if err != nil {
		return versionRecord{}, err
	}
	if prior.Pending {
		if len(prior.PendingWrites) == 0 {
			return versionRecord{}, errors.New("site or registry version record has unknown incomplete writes; retry its original operation")
		}
		for format := range prior.PendingWrites {
			if _, covered := writes[format]; !covered {
				return versionRecord{}, fmt.Errorf("incomplete %s write must be retried before writing this plane", format)
			}
		}
	}
	prior.PendingWrites = nil
	if prior.Writes == nil {
		prior.Writes = map[string]int{}
	}
	for name, schema := range writes {
		prior.Writes[name] = schema
	}
	prior.Pending = false
	prior.SchemaVersion = 1
	prior.CLIVersion = compat.Current().CLIVersion
	return prior, nil
}

func writeVersionRecord(ctx context.Context, backend DeploymentBackend, key string, record versionRecord) error {
	if lock, held := ctx.Value(previewSiteLockContextKey{}).(previewSiteLock); held {
		if key != siteVersionsKey(lock.site) {
			return errors.New("version record is outside active site lock")
		}
		if conditional, ok := backend.(ConditionalObjectBackend); ok {
			if err := (&ObjectPreviewStore{backend: conditional}).verifySiteLock(ctx, lock.site, lock); err != nil {
				return err
			}
		}
	}
	contents, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if conditional, ok := backend.(ConditionalObjectBackend); ok {
		object, _, readErr := conditional.GetObject(ctx, key)
		if readErr == nil && bytes.Equal(object.Bytes, contents) {
			return nil
		}
		if readErr != nil && !errors.Is(readErr, ErrObjectNotFound) {
			return readErr
		}
	}
	return backend.PutObject(ctx, key, Object{Bytes: contents, ContentType: "application/json; charset=utf-8", Cache: "no-store"})
}

func checkStoredFormats(ctx context.Context, backend ConditionalObjectBackend, reads map[string][]int, acceptBreaking bool) error {
	// Unknown record versions never become an accepted breaking-format change.
	registryRecord, present, err := readVersionRecord(ctx, backend, registryVersionsKey)
	if err != nil {
		return err
	}
	object, _, err := backend.GetObject(ctx, "_indexes/sites.json")
	if errors.Is(err, ErrObjectNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	projection, err := registry.DecodeProjection(object.Bytes)
	if err != nil {
		return err
	}
	var failures []string
	if !present || registryRecord.Pending {
		failures = append(failures, "registry: unknown")
	} else if err := compat.CheckReads(reads, registryRecord.Writes); err != nil {
		failures = append(failures, "registry: "+err.Error())
	}
	for _, site := range projection.Sites {
		record, present, err := readVersionRecord(ctx, backend, siteVersionsKey(site.ID))
		if err != nil {
			return err
		}
		if !present || record.Pending {
			failures = append(failures, site.ID+": unknown; republish required")
		} else if err := checkSiteRecordCompleteness(ctx, backend, site.ID, record); err != nil {
			if !errors.Is(err, errUnknownVersions) {
				return err
			}
			failures = append(failures, site.ID+": "+err.Error())
		} else if err := compat.CheckReads(reads, record.Writes); err != nil {
			failures = append(failures, site.ID+": republish required: "+err.Error())
		}
	}
	if len(failures) > 0 && !acceptBreaking {
		sort.Strings(failures)
		return fmt.Errorf("stored compatibility check failed: %s", strings.Join(failures, "; "))
	}
	return nil
}

func CheckConfig(ctx context.Context, backend ConditionalObjectBackend) error {
	options := compatibilityOptions(ctx)
	if options.WebVersion == "" {
		return errors.New("config check requires web.version")
	}
	reads, err := fetchWebReads(ctx, options.WebVersion)
	if err != nil {
		return err
	}
	if err := compat.CheckReads(reads, compat.Current().Writes); err != nil {
		return err
	}
	return checkStoredFormats(ctx, backend, reads, false)
}

func compatCurrentWrites() map[string]int { return compat.Current().Writes }

var errUnknownVersions = errors.New("format version unknown")

func checkSiteRecordCompleteness(ctx context.Context, backend ConditionalObjectBackend, site string, record versionRecord) error {
	for format, key := range map[string]string{"site-metadata": "_indexes/" + site + "/meta.json", "artifact-index": "_indexes/" + site + "/index.json", "full-text-manifest": "_indexes/" + site + "/search/manifest.json", "preview-catalog": "_previews/" + site + "/catalog.json"} {
		if record.Writes[format] != 0 {
			continue
		}
		if _, err := backend.HeadObject(ctx, key); err == nil {
			return fmt.Errorf("%w: %s; republish required", errUnknownVersions, format)
		} else if !errors.Is(err, ErrObjectNotFound) {
			return err
		}
	}
	if record.Writes["preview-manifest"] == 0 {
		keys, err := backend.ListKeys(ctx, "_previews/"+site+"/revisions/")
		if err != nil {
			return err
		}
		for _, key := range keys {
			parts := strings.Split(strings.TrimPrefix(key, "_previews/"+site+"/revisions/"), "/")
			if len(parts) == 2 && parts[1] == "manifest.json" {
				return fmt.Errorf("%w: preview-manifest; republish or cleanup required", errUnknownVersions)
			}
		}
	}
	return nil
}

func stageVersionRecord(ctx context.Context, backend ConditionalObjectBackend, key string, record versionRecord, pendingWrites ...map[string]int) error {
	contents, _ := json.Marshal(record)
	current, _, err := backend.GetObject(ctx, key)
	if err == nil && bytes.Equal(current.Bytes, contents) {
		return nil
	}
	if err != nil && !errors.Is(err, ErrObjectNotFound) {
		return err
	}
	record.Pending = true
	if len(pendingWrites) > 0 {
		record.PendingWrites = pendingWrites[0]
	} else {
		record.PendingWrites = record.Writes
	}
	return writeVersionRecord(ctx, backend, key, record)
}

func validateWebReads(reads map[string][]int) error {
	for name, schemas := range reads {
		if name == "" || len(schemas) == 0 {
			return errors.New("invalid readable formats")
		}
		for _, schema := range schemas {
			if schema < 1 {
				return errors.New("invalid readable schema versions")
			}
		}
	}
	return nil
}

func checkRegistrySiteRecordSchemas(ctx context.Context, backend ConditionalObjectBackend) error {
	// This preflight never reads the mutable registry: authoritative catalog
	// reconciliation still begins only after the registry lock is held.
	keys, err := backend.ListKeys(ctx, siteControlRoot)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if !strings.HasSuffix(key, "/versions.json") {
			continue
		}
		site := strings.TrimSuffix(strings.TrimPrefix(key, siteControlRoot), "/versions.json")
		if err := validateLockSite(site); err != nil || key != siteVersionsKey(site) {
			return fmt.Errorf("unsafe site version record key %s", key)
		}
		if _, _, err := readVersionRecord(ctx, backend, key); err != nil {
			return err
		}
	}
	return nil
}

// Retained immutable revisions remain directly readable after catalog changes.
// A new preview must not certify their format as current without validating it.
func validateRetainedPreviewManifests(ctx context.Context, backend ConditionalObjectBackend, site string) error {
	prefix := "_previews/" + site + "/revisions/"
	keys, err := backend.ListKeys(ctx, prefix)
	if err != nil {
		return fmt.Errorf("list retained preview manifests: %w", err)
	}
	for _, key := range keys {
		if !strings.HasPrefix(key, prefix) {
			return fmt.Errorf("retained preview listing returned out-of-scope key %s", key)
		}
		parts := strings.Split(strings.TrimPrefix(key, prefix), "/")
		if len(parts) != 2 || parts[1] != "manifest.json" {
			continue
		}
		expected, err := preview.ManifestKey(site, parts[0])
		if err != nil || strings.TrimPrefix(expected, "/") != key {
			return fmt.Errorf("invalid retained preview manifest key %s", key)
		}
		object, _, err := backend.GetObject(ctx, key)
		if errors.Is(err, ErrObjectNotFound) {
			continue
		}
		if err != nil {
			return fmt.Errorf("read retained preview manifest %s: %w", key, err)
		}
		manifest, err := preview.DecodeManifest(object.Bytes)
		if err != nil {
			return fmt.Errorf("retained preview revision %s cannot be certified; use a compatible CLI or clean unsupported preview history: %w", parts[0], err)
		}
		if manifest.Site != site || manifest.HeadSHA != parts[0] {
			return fmt.Errorf("retained preview manifest %s has mismatched identity", key)
		}
	}
	return nil
}
