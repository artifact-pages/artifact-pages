package publisher

import (
	"strings"
)

// cachePolicyRevision identifies the fixed Cache-Control policy used in the
// site publish input fingerprint.
const cachePolicyRevision = "d-lt-v1"

// cacheObjectClass names the object classes whose Cache-Control headers are
// owned by the CLI. Keep this deliberately private and fixed per CLI version.
type cacheObjectClass string

const (
	cacheClassSiteRoot       cacheObjectClass = "site-root"
	cacheClassSearchManifest cacheObjectClass = "search-manifest"
	cacheClassArtifact       cacheObjectClass = "artifact"
	cacheClassPreviewCatalog cacheObjectClass = "preview-catalog"
	cacheClassPreviewFile    cacheObjectClass = "preview-file"
	cacheClassAppShell       cacheObjectClass = "app-shell"
	cacheClassHashedAsset    cacheObjectClass = "hashed-asset"
	cacheClassPrivateControl cacheObjectClass = "private-control"
)

var cacheControlByClass = map[cacheObjectClass]string{
	cacheClassSiteRoot:       "public, max-age=0, s-maxage=5, must-revalidate, stale-if-error=0",
	cacheClassSearchManifest: "public, max-age=0, s-maxage=0, must-revalidate, stale-if-error=0",
	cacheClassArtifact:       "public, max-age=0, s-maxage=0, must-revalidate, stale-if-error=0",
	cacheClassPreviewCatalog: "public, max-age=0, s-maxage=0, must-revalidate, stale-if-error=0",
	cacheClassPreviewFile:    "public, max-age=0, s-maxage=0, must-revalidate, stale-if-error=0",
	cacheClassAppShell:       "no-cache, max-age=0, must-revalidate, stale-if-error=0",
	cacheClassHashedAsset:    "public, max-age=31536000, immutable",
	cacheClassPrivateControl: "no-store",
}

func cacheControl(class cacheObjectClass) string { return cacheControlByClass[class] }

func appFileCacheClass(relative string) cacheObjectClass {
	if pathHashedAppAsset(relative) {
		return cacheClassHashedAsset
	}
	return cacheClassAppShell
}

func siteIndexObjectClass(relative string) cacheObjectClass {
	switch {
	case relative == "search/manifest.json":
		return cacheClassSearchManifest
	case strings.HasPrefix(relative, "search/") && strings.HasSuffix(relative, ".gz"):
		return cacheClassHashedAsset
	default:
		return cacheClassSiteRoot
	}
}

// cacheControlAccepted reports whether a stored object header is one of the
// explicitly supported policy revisions for its class. Arbitrary TTLs remain invalid.
func cacheControlAccepted(class cacheObjectClass, value string) bool {
	if value == cacheControl(class) {
		return true
	}
	legacy := map[cacheObjectClass]string{
		cacheClassSiteRoot:       "public, max-age=0, s-maxage=60, must-revalidate",
		cacheClassSearchManifest: "public, max-age=0, s-maxage=60, must-revalidate",
		cacheClassArtifact:       "public, max-age=0, s-maxage=300, must-revalidate",
		cacheClassPreviewCatalog: "public, max-age=0, s-maxage=60, must-revalidate",
		cacheClassPreviewFile:    "public, max-age=0, s-maxage=300, must-revalidate",
		cacheClassAppShell:       "no-cache, max-age=0, must-revalidate",
		cacheClassHashedAsset:    "public, max-age=31536000, immutable",
		cacheClassPrivateControl: "no-store",
	}
	return value == legacy[class]
}

func sitePublishCacheClass(site, key string) (cacheObjectClass, bool) {
	if strings.HasPrefix(key, "_artifacts/"+site+"/") {
		return cacheClassArtifact, true
	}
	prefix := "_indexes/" + site + "/"
	if !strings.HasPrefix(key, prefix) {
		return "", false
	}
	relative := strings.TrimPrefix(key, prefix)
	if relative == "index.json" || relative == "meta.json" {
		return cacheClassSiteRoot, true
	}
	return siteIndexObjectClass(relative), true
}
