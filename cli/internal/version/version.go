// Package version holds the product version of Artifact Pages.
//
// One tag series vMAJOR.MINOR.PATCH versions the CLI, the composite Actions and
// the web bundle together (docs/backlog/technical-design/TD2). The release
// commit sets Product; -ldflags are not used because `go install` and the
// Actions' `go build` cannot pass them.
package version

import (
	"runtime"
	"runtime/debug"
)

// Product is the product version this source tree releases. It is set in the
// release commit, so the tree already names the version being prepared. The
// version is also the web bundle pin: without --archive, `app deploy` downloads
// the release assets tagged v<Product>. A build from a tree whose tag has not
// been published yet therefore fails to download those assets; pass --archive
// with a locally packaged bundle until the release exists.
const Product = "0.2.0"

// Build describes the VCS state recorded in the Go build info.
type Build struct {
	Revision string // full VCS revision, empty when unavailable
	Modified bool   // the working tree had uncommitted changes

	ModuleVersion string // main module version from the build info; "(devel)" for a source build, empty when unavailable
	ModuleSum     string // main module checksum (h1:...); empty unless built from a downloaded module
	GoVersion     string // Go toolchain that built the binary
}

// ReadBuild returns the module version and sum, Go version, VCS revision and
// modified flag of the running binary.
func ReadBuild() Build {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return Build{GoVersion: runtime.Version()}
	}
	build := buildFromSettings(info.Settings)
	build.ModuleVersion = info.Main.Version
	build.ModuleSum = info.Main.Sum
	build.GoVersion = runtime.Version()
	return build
}

func buildFromSettings(settings []debug.BuildSetting) Build {
	var build Build
	for _, setting := range settings {
		switch setting.Key {
		case "vcs.revision":
			build.Revision = setting.Value
		case "vcs.modified":
			build.Modified = setting.Value == "true"
		}
	}
	return build
}
