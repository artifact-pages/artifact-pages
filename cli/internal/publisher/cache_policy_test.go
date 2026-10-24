package publisher

import "testing"

func TestCacheControlPoliciesPreserveExistingHeaders(t *testing.T) {
	tests := []struct {
		class cacheObjectClass
		want  string
	}{
		{cacheClassSiteRoot, "public, max-age=0, s-maxage=60, must-revalidate"},
		{cacheClassSearchManifest, "public, max-age=0, s-maxage=60, must-revalidate"},
		{cacheClassArtifact, "public, max-age=0, s-maxage=300, must-revalidate"},
		{cacheClassPreviewCatalog, "public, max-age=0, s-maxage=60, must-revalidate"},
		{cacheClassPreviewFile, "public, max-age=0, s-maxage=300, must-revalidate"},
		{cacheClassAppShell, "no-cache, max-age=0, must-revalidate"},
		{cacheClassHashedAsset, "public, max-age=31536000, immutable"},
		{cacheClassPrivateControl, "no-store"},
	}
	for _, test := range tests {
		t.Run(string(test.class), func(t *testing.T) {
			if got := cacheControl(test.class); got != test.want {
				t.Errorf("cacheControl(%q) = %q, want %q", test.class, got, test.want)
			}
		})
	}
}

func TestCacheObjectClassesKeepSearchAndAppAssetKindsDistinct(t *testing.T) {
	if cacheClassSearchManifest == cacheClassSiteRoot {
		t.Fatal("search manifest must have its own object class")
	}
	if got := siteIndexObjectClass("search/manifest.json"); got != cacheClassSearchManifest {
		t.Fatalf("search manifest class = %q", got)
	}
	if got := siteIndexObjectClass("search/abcd1234.gz"); got != cacheClassHashedAsset {
		t.Fatalf("hashed search blob class = %q", got)
	}
	if got := siteIndexObjectClass("index.json"); got != cacheClassSiteRoot {
		t.Fatalf("site index class = %q", got)
	}
	if got := cacheControl(appFileCacheClass("assets/app-AbC123xY.js")); got != cacheControl(cacheClassHashedAsset) {
		t.Fatalf("hashed app asset policy = %q", got)
	}
	if got := cacheControl(appFileCacheClass("assets/app.js")); got != cacheControl(cacheClassAppShell) {
		t.Fatalf("fixed app asset policy = %q", got)
	}
}
