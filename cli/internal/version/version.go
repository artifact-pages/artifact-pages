// Package version holds the product version of the Artifact Pages CLI.
//
// The CLI uses the root vMAJOR.MINOR.PATCH tag series. Web and Action releases
// use their own component tag series (docs/backlog/technical-design/TD17).
// The release commit sets Product, so source builds and packaged binaries from
// the same commit report the same CLI version without linker overrides.
package version

import (
	"runtime"
	"runtime/debug"
)

// Product is the CLI version this source tree releases. It is set in the
// release commit, so the tree already names the version being prepared. For
// app deploy, config web.version selects the independent web bundle; legacy
// configs without component pins retain the original CLI-version bundle path.
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
