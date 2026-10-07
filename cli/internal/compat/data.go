package compat

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"github.com/artifact-pages/artifact-pages/cli/internal/version"
	"sort"
	"strings"
)

//go:embed compatibility.json
var compatibilityData []byte

type Data struct {
	SchemaVersion int            `json:"schemaVersion"`
	CLIVersion    string         `json:"cliVersion"`
	ConfigReads   []int          `json:"configReads"`
	Writes        map[string]int `json:"writes"`
}

func Current() Data {
	var data Data
	if err := json.Unmarshal(compatibilityData, &data); err != nil {
		panic(err)
	}
	data.CLIVersion = version.Product
	return data
}

func CheckReads(reads map[string][]int, writes map[string]int) error {
	var failures []string
	for format, schema := range writes {
		supported := false
		for _, candidate := range reads[format] {
			if schema == candidate {
				supported = true
			}
		}
		if !supported {
			failures = append(failures, fmt.Sprintf("%s schemaVersion %d", format, schema))
		}
	}
	sort.Strings(failures)
	if len(failures) > 0 {
		return fmt.Errorf("web cannot read %s", strings.Join(failures, ", "))
	}
	return nil
}
