package preview

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sort"
)

var (
	// ErrObjectNotFound means the requested preview object is confirmed absent.
	// Provider adapters must keep this distinct from transport and authorization errors.
	ErrObjectNotFound = errors.New("preview object not found")
	// ErrImmutableObjectConflict means an immutable key already contains different bytes.
	ErrImmutableObjectConflict = errors.New("immutable preview object already contains different bytes")
)

// PreviewStore is the provider boundary for preview projection writes. Keys are
// the canonical /_previews/... paths returned by CatalogKey, ManifestKey, and
// FileKey, with file path segments percent-encoded once. Implementations
// validate and decode those segments exactly once when mapping them to raw
// provider keys or local filenames. Implementations provide origin reads,
// create-once immutable objects, mutable catalog replacement, and the
// cooperative per-site lock used by preview publication, production
// reconciliation, and unregister.
//
// ReadObject must return ErrObjectNotFound only for confirmed absence. A
// provider's network or authorization errors must remain ordinary errors so
// callers never mistake them for stale references.
type PreviewStore interface {
	WithSiteLock(ctx context.Context, site string, operation func(context.Context) error) error
	ReadObject(ctx context.Context, key string) ([]byte, error)
	CreateImmutableObject(ctx context.Context, key string, contents []byte) error
	ReplaceMutableObject(ctx context.Context, key string, contents []byte) error
}

// CatalogReconciliationChange describes whether a preview catalog group is
// retained or removed based on the availability of its completion manifest at
// the object-store origin.
type CatalogReconciliationChange struct {
	Action  string `json:"action"`
	GroupID string `json:"groupId"`
	HeadSHA string `json:"headSha"`
	Reason  string `json:"reason"`
}

// CatalogReconciliationPlan contains one decision for every group in the
// selected site's preview catalog. Changes are sorted by group ID and head SHA.
type CatalogReconciliationPlan struct {
	Changes     []CatalogReconciliationChange `json:"changes"`
	site        string
	catalog     Catalog
	hasRemovals bool
}

// PublicationObjectChange describes whether an immutable preview file or
// manifest would be created or retained. Paths are source-relative; the
// manifest uses the reserved "manifest.json" name.
type PublicationObjectChange struct {
	Action      string `json:"action"`
	Path        string `json:"path"`
	ContentType string `json:"contentType"`
}

type PublicationCatalogChange struct {
	Action  string `json:"action"`
	GroupID string `json:"groupId"`
	HeadSHA string `json:"headSha"`
	Reason  string `json:"reason,omitempty"`
}

// PublicationPlan is a read-only plan for one preview update. The unexported
// desired catalog and flag are only consumed by Publish while holding the site
// lock; callers can safely serialize the public change summary.
type PublicationPlan struct {
	Outcome        Outcome                    `json:"outcome"`
	Objects        []PublicationObjectChange  `json:"objects"`
	CatalogChanges []PublicationCatalogChange `json:"catalogChanges"`
	site           string
	catalog        Catalog
	writeCatalog   bool
}

const (
	catalogManifestPresentReason     = "manifest-present"
	catalogManifestMissingReason     = "manifest-missing"
	catalogManifestUnavailableReason = "manifest-unavailable"
)

// Publish writes a preview through a provider-neutral store. The revision
// files are made durable before the completion manifest; only then is the
// mutable discovery catalog updated.
func Publish(ctx context.Context, store PreviewStore, result BuildResult) error {
	_, err := PublishWithPlan(ctx, store, result)
	return err
}

// PublishWithPlan applies a freshly read plan while holding the store's site
// lock and returns the exact plan that governed the writes.
func PublishWithPlan(ctx context.Context, store PreviewStore, result BuildResult) (PublicationPlan, error) {
	if err := validatePublicationArgs(ctx, store, result); err != nil {
		return PublicationPlan{}, err
	}
	var appliedPlan PublicationPlan
	err := store.WithSiteLock(ctx, result.Site, func(lockedContext context.Context) error {
		if err := lockedContext.Err(); err != nil {
			return err
		}
		plan, err := PlanPublication(lockedContext, store, result)
		if err != nil {
			return err
		}
		appliedPlan = plan
		if result.Outcome == OutcomePublished {
			if err := installImmutableRevision(lockedContext, store, result); err != nil {
				return err
			}
		}
		if !plan.writeCatalog {
			return nil
		}
		return writeCatalog(lockedContext, store, result.Site, plan.catalog)
	})
	return appliedPlan, err
}

// PlanPublication reads the current immutable revision and discovery catalog
// at the store origin without taking a lock or mutating the store. Callers that
// apply a plan must re-plan while holding the site lock first.
func PlanPublication(ctx context.Context, store PreviewStore, result BuildResult) (PublicationPlan, error) {
	if err := validatePublicationArgs(ctx, store, result); err != nil {
		return PublicationPlan{}, err
	}
	plan := PublicationPlan{Outcome: result.Outcome, Objects: []PublicationObjectChange{}, CatalogChanges: []PublicationCatalogChange{}}
	catalog, err := readCatalog(ctx, store, result.Site)
	if err != nil {
		return plan, err
	}
	catalogBefore := catalog
	catalog, pruned, err := pruneMissingGroups(ctx, store, result.Site, catalog)
	if err != nil {
		return plan, err
	}
	for _, existing := range catalogBefore.Groups {
		if hasGroup(catalog, existing.ID) {
			continue
		}
		plan.CatalogChanges = append(plan.CatalogChanges, PublicationCatalogChange{
			Action: "remove", GroupID: existing.ID, HeadSHA: existing.HeadSHA, Reason: "manifest-missing",
		})
	}
	plan.site, plan.catalog = result.Site, catalog
	if result.Outcome == OutcomeNoPreview {
		filtered := make([]Group, 0, len(catalog.Groups))
		removed := false
		for _, existing := range catalog.Groups {
			if existing.ID == result.Group.ID {
				removed = true
				continue
			}
			filtered = append(filtered, existing)
		}
		if removed {
			plan.CatalogChanges = append(plan.CatalogChanges, PublicationCatalogChange{
				Action: "remove", GroupID: result.Group.ID, HeadSHA: result.Group.HeadSHA, Reason: "no-previewable-documents",
			})
			plan.catalog.Groups = filtered
		}
		sortPublicationCatalogChanges(plan.CatalogChanges)
		plan.writeCatalog = pruned || removed
		return plan, nil
	}
	if err := validateBuildResult(result); err != nil {
		return PublicationPlan{}, err
	}
	manifestKey, err := ManifestKey(result.Site, result.Manifest.HeadSHA)
	if err != nil {
		return PublicationPlan{}, err
	}
	manifestBytes, manifestErr := store.ReadObject(ctx, manifestKey)
	manifestAction := "create"
	if manifestErr == nil {
		existing, decodeErr := DecodeManifest(manifestBytes)
		if decodeErr != nil {
			return PublicationPlan{}, fmt.Errorf("existing preview manifest is invalid: %w", decodeErr)
		}
		if !sameImmutableProjection(existing, result.Manifest) {
			return PublicationPlan{}, ErrImmutableRevisionMismatch
		}
		manifestAction = "retain"
	} else if !errors.Is(manifestErr, ErrObjectNotFound) {
		return PublicationPlan{}, fmt.Errorf("read existing preview manifest: %w", manifestErr)
	}
	paths := make([]string, 0, len(result.Files))
	for filePath := range result.Files {
		paths = append(paths, filePath)
	}
	sort.Strings(paths)
	for _, filePath := range paths {
		key, keyErr := FileKey(result.Site, result.Manifest.HeadSHA, filePath)
		if keyErr != nil {
			return PublicationPlan{}, keyErr
		}
		existing, readErr := store.ReadObject(ctx, key)
		action := "create"
		if readErr == nil {
			if !reflect.DeepEqual(existing, result.Files[filePath]) {
				return PublicationPlan{}, fmt.Errorf("existing immutable preview file %q differs from its recorded bytes: %w", filePath, ErrImmutableRevisionMismatch)
			}
			action = "retain"
		} else if !errors.Is(readErr, ErrObjectNotFound) {
			return PublicationPlan{}, fmt.Errorf("read existing preview file %q: %w", filePath, readErr)
		} else if manifestAction == "retain" {
			return PublicationPlan{}, fmt.Errorf("existing immutable preview file %q is unavailable: %w", filePath, readErr)
		}
		plan.Objects = append(plan.Objects, PublicationObjectChange{Action: action, Path: filePath, ContentType: contentTypeFor(filePath)})
	}
	plan.Objects = append(plan.Objects, PublicationObjectChange{Action: manifestAction, Path: "manifest.json", ContentType: "application/json; charset=utf-8"})
	groupChanged := upsertPlannedGroup(&plan.catalog, result.Group)
	plan.writeCatalog = pruned || groupChanged
	if groupChanged {
		action := "create"
		for _, existing := range catalog.Groups {
			if existing.ID == result.Group.ID {
				action = "update"
				break
			}
		}
		plan.CatalogChanges = append(plan.CatalogChanges, PublicationCatalogChange{Action: action, GroupID: result.Group.ID, HeadSHA: result.Group.HeadSHA})
	}
	sortPublicationCatalogChanges(plan.CatalogChanges)
	return plan, nil
}

func sortPublicationCatalogChanges(changes []PublicationCatalogChange) {
	sort.Slice(changes, func(i, j int) bool {
		left, right := changes[i], changes[j]
		if left.GroupID != right.GroupID {
			return left.GroupID < right.GroupID
		}
		if left.HeadSHA != right.HeadSHA {
			return left.HeadSHA < right.HeadSHA
		}
		if left.Action != right.Action {
			return left.Action < right.Action
		}
		return left.Reason < right.Reason
	})
}

func validatePublicationArgs(ctx context.Context, store PreviewStore, result BuildResult) error {
	if ctx == nil {
		return errors.New("preview publication context is required")
	}
	if store == nil {
		return errors.New("preview store is required")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if result.Group.ID == "" || result.Group.HeadSHA == "" {
		return errors.New("preview build result has no group identity")
	}
	if !validSiteID(result.Site) {
		return fmt.Errorf("preview build result has invalid site identifier %q", result.Site)
	}
	if result.Group.HeadSHA != result.Manifest.HeadSHA && result.Outcome == OutcomePublished {
		return errors.New("preview group and manifest head SHAs do not match")
	}
	if result.Outcome == OutcomeNoPreview {
		return ValidateCatalog(Catalog{SchemaVersion: SchemaVersion, Site: result.Site, Groups: []Group{result.Group}})
	}
	if result.Outcome != OutcomePublished {
		return fmt.Errorf("unknown preview outcome %q", result.Outcome)
	}
	return validateBuildResult(result)
}

func hasGroup(catalog Catalog, groupID string) bool {
	for _, group := range catalog.Groups {
		if group.ID == groupID {
			return true
		}
	}
	return false
}

func upsertPlannedGroup(catalog *Catalog, group Group) bool {
	for index, existing := range catalog.Groups {
		if existing.ID != group.ID {
			continue
		}
		if existing.HeadSHA == group.HeadSHA && reflect.DeepEqual(existing.Documents, group.Documents) && existing.PRURL == group.PRURL {
			group.UpdatedAt = existing.UpdatedAt
		}
		if reflect.DeepEqual(existing, group) {
			return false
		}
		catalog.Groups[index] = group
		return true
	}
	catalog.Groups = append(catalog.Groups, group)
	return true
}

// BuildAndPublish keeps source selection ahead of all store mutations. A
// rejected Git change set, including one with no previewable documents, cannot
// alter the site's preview catalog or revision objects.
func BuildAndPublish(ctx context.Context, store PreviewStore, options BuildOptions) (BuildResult, error) {
	if ctx == nil {
		return BuildResult{}, errors.New("preview publication context is required")
	}
	if store == nil {
		return BuildResult{}, errors.New("preview store is required")
	}
	if err := ctx.Err(); err != nil {
		return BuildResult{}, err
	}
	result, err := BuildFromGit(ctx, options)
	if err != nil {
		return BuildResult{}, err
	}
	if err := Publish(ctx, store, result); err != nil {
		return result, err
	}
	return result, nil
}

// PlanCatalogReconciliation reads the selected site's catalog and referenced
// manifests without acquiring a lock or writing objects. Only a confirmed
// manifest absence is planned for removal; present or unavailable manifests
// produce keep changes.
func PlanCatalogReconciliation(ctx context.Context, store PreviewStore, site string) (CatalogReconciliationPlan, error) {
	if err := validateCatalogReconciliationArgs(ctx, store, site); err != nil {
		return CatalogReconciliationPlan{}, err
	}
	plan, _, _, err := planCatalogReconciliation(ctx, store, site)
	if err != nil {
		return CatalogReconciliationPlan{}, err
	}
	return plan, nil
}

// PlanCatalogReconciliationUnderSiteLock reads and plans while the caller
// already holds the selected site's cooperative lock. The returned plan can
// be applied after the production projection commits.
func PlanCatalogReconciliationUnderSiteLock(ctx context.Context, store PreviewStore, site string) (CatalogReconciliationPlan, error) {
	if err := validateCatalogReconciliationArgs(ctx, store, site); err != nil {
		return CatalogReconciliationPlan{}, err
	}
	plan, catalog, hasRemovals, err := planCatalogReconciliation(ctx, store, site)
	if err != nil {
		return CatalogReconciliationPlan{}, err
	}
	plan.site = site
	plan.catalog = catalog
	plan.hasRemovals = hasRemovals
	return plan, nil
}

// ApplyCatalogReconciliationUnderSiteLock writes the planned reduced catalog.
// The caller must still hold the same site lock used to create the plan.
func ApplyCatalogReconciliationUnderSiteLock(ctx context.Context, store PreviewStore, site string, plan CatalogReconciliationPlan) error {
	if err := validateCatalogReconciliationArgs(ctx, store, site); err != nil {
		return err
	}
	if plan.site != site {
		return fmt.Errorf("preview reconciliation plan is for site %q, not %q", plan.site, site)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if !plan.hasRemovals {
		return nil
	}
	return writeCatalog(ctx, store, site, plan.catalog)
}

// ReconcileCatalogUnderSiteLock plans and applies preview catalog pruning.
// The caller must already hold the selected site's cooperative lock.
//
// Read failures for individual manifests retain their catalog groups and are
// represented as keep changes. A catalog read or replacement failure is
// returned to the caller.
func ReconcileCatalogUnderSiteLock(ctx context.Context, store PreviewStore, site string) (CatalogReconciliationPlan, error) {
	plan, err := PlanCatalogReconciliationUnderSiteLock(ctx, store, site)
	if err != nil {
		return CatalogReconciliationPlan{}, err
	}
	if err := ApplyCatalogReconciliationUnderSiteLock(ctx, store, site, plan); err != nil {
		return plan.public(), err
	}
	return plan.public(), nil
}

// ReconcileCatalog removes only discovery entries whose revision manifests are
// confirmed absent at the store origin. Read failures preserve the entry so a
// temporary provider outage cannot be mistaken for preview expiry.
func ReconcileCatalog(ctx context.Context, store PreviewStore, site string) error {
	if err := validateCatalogReconciliationArgs(ctx, store, site); err != nil {
		return err
	}
	return store.WithSiteLock(ctx, site, func(lockedContext context.Context) error {
		_, err := ReconcileCatalogUnderSiteLock(lockedContext, store, site)
		return err
	})
}

func validateCatalogReconciliationArgs(ctx context.Context, store PreviewStore, site string) error {
	if ctx == nil {
		return errors.New("preview reconciliation context is required")
	}
	if store == nil {
		return errors.New("preview store is required")
	}
	if !validSiteID(site) {
		return fmt.Errorf("invalid preview site identifier %q", site)
	}
	return ctx.Err()
}

func planCatalogReconciliation(ctx context.Context, store PreviewStore, site string) (CatalogReconciliationPlan, Catalog, bool, error) {
	if err := ctx.Err(); err != nil {
		return CatalogReconciliationPlan{}, Catalog{}, false, err
	}
	catalog, err := readCatalog(ctx, store, site)
	if err != nil {
		return CatalogReconciliationPlan{}, Catalog{}, false, err
	}

	plan := CatalogReconciliationPlan{Changes: make([]CatalogReconciliationChange, 0, len(catalog.Groups))}
	retained := make([]Group, 0, len(catalog.Groups))
	hasRemovals := false
	for _, group := range catalog.Groups {
		if err := ctx.Err(); err != nil {
			return CatalogReconciliationPlan{}, Catalog{}, false, err
		}
		manifestKey, err := ManifestKey(site, group.HeadSHA)
		if err != nil {
			return CatalogReconciliationPlan{}, Catalog{}, false, err
		}
		_, readErr := store.ReadObject(ctx, manifestKey)
		if err := ctx.Err(); err != nil {
			return CatalogReconciliationPlan{}, Catalog{}, false, err
		}
		change := CatalogReconciliationChange{GroupID: group.ID, HeadSHA: group.HeadSHA}
		switch {
		case readErr == nil:
			change.Action = "keep"
			change.Reason = catalogManifestPresentReason
			retained = append(retained, group)
		case errors.Is(readErr, ErrObjectNotFound):
			change.Action = "remove"
			change.Reason = catalogManifestMissingReason
			hasRemovals = true
		default:
			// An origin read failure is not proof of expiry. Keep the discovery
			// reference, and expose the uncertainty in the returned plan.
			change.Action = "keep"
			change.Reason = catalogManifestUnavailableReason
			retained = append(retained, group)
		}
		plan.Changes = append(plan.Changes, change)
	}
	sort.Slice(plan.Changes, func(i, j int) bool {
		if plan.Changes[i].GroupID == plan.Changes[j].GroupID {
			return plan.Changes[i].HeadSHA < plan.Changes[j].HeadSHA
		}
		return plan.Changes[i].GroupID < plan.Changes[j].GroupID
	})
	catalog.Groups = retained
	return plan, catalog, hasRemovals, nil
}

func (plan CatalogReconciliationPlan) public() CatalogReconciliationPlan {
	plan.site = ""
	plan.catalog = Catalog{}
	plan.hasRemovals = false
	return plan
}

func validateBuildResult(result BuildResult) error {
	if err := ValidateManifest(result.Manifest); err != nil {
		return err
	}
	if result.Manifest.Site == "" || result.Manifest.Site != result.Site {
		return errors.New("preview manifest and catalog group must refer to the same site")
	}
	if result.Manifest.HeadSHA != result.Group.HeadSHA || !reflect.DeepEqual(result.Manifest.Documents, result.Group.Documents) {
		return errors.New("preview manifest and catalog group must refer to the same head and documents")
	}
	if err := ValidateCatalog(Catalog{SchemaVersion: SchemaVersion, Site: result.Manifest.Site, Groups: []Group{result.Group}}); err != nil {
		return err
	}
	if !reflect.DeepEqual(result.Manifest.Files, describeFiles(result.Files)) || result.Manifest.BundleDigest != digestBundle(result.Files) {
		return errors.New("preview manifest file records do not match the local bundle")
	}
	return nil
}

func installImmutableRevision(ctx context.Context, store PreviewStore, result BuildResult) error {
	manifestKey, err := ManifestKey(result.Manifest.Site, result.Manifest.HeadSHA)
	if err != nil {
		return err
	}
	if contents, readErr := store.ReadObject(ctx, manifestKey); readErr == nil {
		existing, decodeErr := DecodeManifest(contents)
		if decodeErr != nil {
			return fmt.Errorf("existing immutable preview manifest is invalid: %w", decodeErr)
		}
		if !sameImmutableProjection(existing, result.Manifest) {
			return fmt.Errorf("preview %s/%s: %w", result.Manifest.Site, result.Manifest.HeadSHA, ErrImmutableRevisionMismatch)
		}
		for _, file := range existing.Files {
			fileKey, keyErr := FileKey(result.Manifest.Site, result.Manifest.HeadSHA, file.Path)
			if keyErr != nil {
				return keyErr
			}
			actual, fileErr := store.ReadObject(ctx, fileKey)
			if fileErr != nil {
				return fmt.Errorf("existing immutable preview file %q is unavailable: %w", file.Path, fileErr)
			}
			if !reflect.DeepEqual(actual, result.Files[file.Path]) {
				return fmt.Errorf("existing immutable preview file %q differs from its recorded bytes", file.Path)
			}
		}
		return nil
	} else if !errors.Is(readErr, ErrObjectNotFound) {
		return fmt.Errorf("read existing preview manifest: %w", readErr)
	}

	paths := make([]string, 0, len(result.Files))
	for filePath := range result.Files {
		paths = append(paths, filePath)
	}
	sort.Strings(paths)
	for _, filePath := range paths {
		key, keyErr := FileKey(result.Manifest.Site, result.Manifest.HeadSHA, filePath)
		if keyErr != nil {
			return keyErr
		}
		if err := store.CreateImmutableObject(ctx, key, result.Files[filePath]); err != nil {
			return fmt.Errorf("write preview file %q: %w", filePath, err)
		}
	}
	encoded, err := EncodeManifest(result.Manifest)
	if err != nil {
		return err
	}
	if err := store.CreateImmutableObject(ctx, manifestKey, encoded); err != nil {
		return fmt.Errorf("write preview manifest: %w", err)
	}
	return nil
}

func sameImmutableProjection(left, right RevisionManifest) bool {
	return left.SchemaVersion == right.SchemaVersion && left.Site == right.Site && left.HeadSHA == right.HeadSHA &&
		left.MergeBase == right.MergeBase && left.BundleDigest == right.BundleDigest &&
		reflect.DeepEqual(left.Files, right.Files) && reflect.DeepEqual(left.Documents, right.Documents)
}

func upsertGroup(ctx context.Context, store PreviewStore, site string, group Group) error {
	catalog, err := readCatalog(ctx, store, site)
	if err != nil {
		return err
	}
	catalog, _, err = pruneMissingGroups(ctx, store, site, catalog)
	if err != nil {
		return err
	}
	for index, existing := range catalog.Groups {
		if existing.ID != group.ID {
			continue
		}
		if existing.HeadSHA == group.HeadSHA && reflect.DeepEqual(existing.Documents, group.Documents) && existing.PRURL == group.PRURL {
			group.UpdatedAt = existing.UpdatedAt
		}
		catalog.Groups[index] = group
		return writeCatalog(ctx, store, site, catalog)
	}
	catalog.Groups = append(catalog.Groups, group)
	return writeCatalog(ctx, store, site, catalog)
}

func removeGroup(ctx context.Context, store PreviewStore, site, groupID string) error {
	catalog, err := readCatalog(ctx, store, site)
	if err != nil {
		return err
	}
	catalog, changed, err := pruneMissingGroups(ctx, store, site, catalog)
	if err != nil {
		return err
	}
	filtered := catalog.Groups[:0]
	for _, existing := range catalog.Groups {
		if existing.ID != groupID {
			filtered = append(filtered, existing)
		} else {
			changed = true
		}
	}
	if !changed {
		return nil
	}
	catalog.Groups = filtered
	return writeCatalog(ctx, store, site, catalog)
}

func pruneMissingGroups(ctx context.Context, store PreviewStore, site string, catalog Catalog) (Catalog, bool, error) {
	filtered := make([]Group, 0, len(catalog.Groups))
	changed := false
	for _, group := range catalog.Groups {
		key, err := ManifestKey(site, group.HeadSHA)
		if err != nil {
			return Catalog{}, false, err
		}
		_, readErr := store.ReadObject(ctx, key)
		if errors.Is(readErr, ErrObjectNotFound) {
			changed = true
			continue
		}
		// Keep the reference when origin availability is unknown. The reader
		// exposes that uncertainty instead of treating it as expiry.
		filtered = append(filtered, group)
	}
	catalog.Groups = filtered
	return catalog, changed, nil
}

func readCatalog(ctx context.Context, store PreviewStore, site string) (Catalog, error) {
	key, err := CatalogKey(site)
	if err != nil {
		return Catalog{}, err
	}
	data, err := store.ReadObject(ctx, key)
	if errors.Is(err, ErrObjectNotFound) {
		return Catalog{SchemaVersion: SchemaVersion, Site: site, Groups: []Group{}}, nil
	}
	if err != nil {
		return Catalog{}, fmt.Errorf("read preview catalog: %w", err)
	}
	catalog, err := DecodeCatalog(data)
	if err != nil {
		return Catalog{}, fmt.Errorf("existing preview catalog is invalid: %w", err)
	}
	if catalog.Site != site {
		return Catalog{}, fmt.Errorf("preview catalog site %q does not match %q", catalog.Site, site)
	}
	return catalog, nil
}

func writeCatalog(ctx context.Context, store PreviewStore, site string, catalog Catalog) error {
	key, err := CatalogKey(site)
	if err != nil {
		return err
	}
	encoded, err := EncodeCatalog(catalog)
	if err != nil {
		return err
	}
	return store.ReplaceMutableObject(ctx, key, encoded)
}
