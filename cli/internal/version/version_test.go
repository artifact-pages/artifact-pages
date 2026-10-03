package version

import (
	"regexp"
	"runtime"
	"runtime/debug"
	"testing"
)

func TestProductIsSemver(t *testing.T) {
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(Product) {
		t.Fatalf("Product = %q, want MAJOR.MINOR.PATCH", Product)
	}
}

func TestReadBuildReportsGoVersion(t *testing.T) {
	build := ReadBuild()
	if build.GoVersion != runtime.Version() {
		t.Fatalf("GoVersion = %q, want %q", build.GoVersion, runtime.Version())
	}
	if info, ok := debug.ReadBuildInfo(); ok && (build.ModuleVersion != info.Main.Version || build.ModuleSum != info.Main.Sum) {
		t.Fatalf("module = %q %q, want %q %q", build.ModuleVersion, build.ModuleSum, info.Main.Version, info.Main.Sum)
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
