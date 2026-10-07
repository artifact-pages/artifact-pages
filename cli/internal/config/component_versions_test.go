package config

import (
	"strings"
	"testing"
)

func TestComponentPinsAndLayerBoundary(t *testing.T) {
	base := "schemaVersion: 1\nprovider: local\nlocal:\n  root: /tmp/storage\nsites: {}\n"
	for _, pins := range []string{"cli:\n  version: 0.3.0\nweb:\n  version: 0.2.1\n", "cli:\n  version: 0.3.0\n", "web:\n  version: 0.2.1\n"} {
		if _, err := Parse([]byte(base + pins)); err != nil {
			t.Fatal(err)
		}
		if _, err := ParseLayers([][]byte{[]byte(base + pins), []byte("schemaVersion: 1\nweb:\n  version: 0.2.1\n")}); err == nil || !strings.Contains(err.Error(), "at most one") {
			t.Fatalf("duplicate deployment version layer: %v", err)
		}
	}
	for _, version := range []string{"latest", "1.0", "01.0.0", "1.0.0-rc.1", "1.0.0+build", "", ">=1.0.0"} {
		if _, err := Parse([]byte(base + "web:\n  version: '" + version + "'\n")); err == nil {
			t.Errorf("accepted pin %q", version)
		}
	}
	for _, pins := range []string{"web: null\n", "cli: []\n", "web:\n  version: 1\n", "cli:\n  version: 1.0.0\n  source: arbitrary\n"} {
		if _, err := Parse([]byte(base + pins)); err == nil {
			t.Errorf("accepted %q", pins)
		}
	}
}
