package main

import (
	"bytes"
	"encoding/json"
	"github.com/artifact-pages/artifact-pages/cli/internal/compat"
	"github.com/artifact-pages/artifact-pages/cli/internal/version"
	"testing"
)

func TestCompatibilityAssetCommand(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := run(t.Context(), []string{"compatibility", "--format", "json"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	var data compat.Data
	if err := json.Unmarshal(stdout.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if data.SchemaVersion != 1 || data.CLIVersion != version.Product || len(data.Writes) != 6 || len(data.ConfigReads) != 1 {
		t.Fatalf("invalid release compatibility contract: %+v", data)
	}
}
