package publisher

import (
	"strings"
)

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
	cacheClassSiteRoot:       "public, max-age=0, s-maxage=60, must-revalidate",
	cacheClassSearchManifest: "public, max-age=0, s-maxage=60, must-revalidate",
	cacheClassArtifact:       "public, max-age=0, s-maxage=300, must-revalidate",
	cacheClassPreviewCatalog: "public, max-age=0, s-maxage=60, must-revalidate",
	cacheClassPreviewFile:    "public, max-age=0, s-maxage=300, must-revalidate",
	cacheClassAppShell:       "no-cache, max-age=0, must-revalidate",
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
