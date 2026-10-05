package publisher

import (
	"strings"
	"testing"

	deploymentconfig "github.com/artifact-pages/artifact-pages/cli/internal/config"
	"github.com/artifact-pages/artifact-pages/cli/internal/registry"
)

// testRegistryProjection embeds a sites fixture in the unified local config
// schema before parsing it. Registry tests exercise deployed JSON separately.
func testRegistryProjection(t *testing.T, fixture string) registry.Projection {
	t.Helper()
	config, err := deploymentconfig.Parse(testUnifiedConfigFixture(fixture))
	if err != nil {
		t.Fatalf("parse unified registry fixture: %v", err)
	}
	projection, err := registry.ProjectSites(config.Sites)
	if err != nil {
		t.Fatalf("project unified registry fixture: %v", err)
	}
	return projection
}

func testUnifiedConfigFixture(fixture string) []byte {
	fixture = strings.TrimPrefix(fixture, "schemaVersion: 1\n")
	return []byte("schemaVersion: 1\nprovider: local\nlocal:\n  root: .local/storage\n" + fixture)
}

func testRegistryBytes(t *testing.T, fixture string) []byte {
	t.Helper()
	contents, err := registry.Encode(testRegistryProjection(t, fixture))
	if err != nil {
		t.Fatalf("encode unified registry fixture: %v", err)
	}
	return contents
}

func testRegistryBuild(t *testing.T, fixture []byte) ([]byte, registry.Projection, error) {
	t.Helper()
	projection := testRegistryProjection(t, string(fixture))
	contents, err := registry.Encode(projection)
	return contents, projection, err
}
