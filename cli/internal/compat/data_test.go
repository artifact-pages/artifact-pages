package compat

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestCanonicalCompatibilityFormats(t *testing.T) {
	contents, err := os.ReadFile("../../../web/src/data/supported-schema-versions.json")
	if err != nil {
		t.Fatal(err)
	}
	var web struct {
		Reads map[string][]int `json:"reads"`
	}
	if err := json.Unmarshal(contents, &web); err != nil {
		t.Fatal(err)
	}
	current := Current()
	if len(current.Writes) != len(web.Reads) {
		t.Fatalf("CLI format names do not match canonical reader formats: %v, %v", current.Writes, web.Reads)
	}
	for name, schema := range current.Writes {
		if _, present := web.Reads[name]; !present {
			t.Errorf("unknown format %s", name)
		}
		if schema != 1 {
			t.Errorf("unexpected write version %s: %d", name, schema)
		}
	}
	if !reflect.DeepEqual(current.ConfigReads, []int{1}) || current.CLIVersion == "" {
		t.Fatal(current)
	}
	if err := CheckReads(web.Reads, current.Writes); err != nil {
		t.Fatal(err)
	}
	web.Reads["artifact-index"] = []int{2}
	if err := CheckReads(web.Reads, current.Writes); err == nil {
		t.Fatal("accepted incompatible format")
	}
}
