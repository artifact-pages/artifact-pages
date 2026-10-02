package version

import (
	"regexp"
	"runtime/debug"
	"testing"
)

func TestProductIsSemver(t *testing.T) {
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(Product) {
		t.Fatalf("Product = %q, want MAJOR.MINOR.PATCH", Product)
	}
}

func TestBuildFromSettings(t *testing.T) {
	got := buildFromSettings([]debug.BuildSetting{
		{Key: "vcs", Value: "git"},
		{Key: "vcs.revision", Value: "abc123"},
		{Key: "vcs.modified", Value: "true"},
	})
	if got.Revision != "abc123" || !got.Modified {
		t.Fatalf("buildFromSettings() = %+v", got)
	}
	if got := buildFromSettings(nil); got != (Build{}) {
		t.Fatalf("empty settings = %+v", got)
	}
}
