//go:build ignore

// Excluded from the monorepo build: scripts/validate.sh copies this helper (without the
// build constraint) into the CLI tree so that it may import the CLI-internal config package.

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"reflect"
	"strings"

	"github.com/artifact-pages/artifact-pages/cli/internal/config"
	"go.yaml.in/yaml/v3"
)

type request struct {
	YAML                   string `json:"yaml"`
	Provider               string `json:"provider"`
	ExpectedBucket         string `json:"expected_bucket"`
	ExpectedAccount        string `json:"expected_account_id"`
	ExpectedRegion         string `json:"expected_region"`
	ExpectedDistributionID string `json:"expected_distribution_id"`
}

func main() {
	var input request
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		fail("decode Terraform contract query: %v", err)
	}
	parsed, err := config.Parse([]byte(input.YAML))
	if err != nil {
		fail("parse evaluated Terraform output with the Artifact Pages CLI config parser: %v", err)
	}
	if parsed.Provider != input.Provider {
		fail("parsed provider = %q, want %q", parsed.Provider, input.Provider)
	}
	if retention := integerField(reflect.ValueOf(parsed), "PreviewRetentionDays"); retention != 0 {
		fail("CLI config unexpectedly contains preview retention %d", retention)
	}
	target := parsed.AWS
	if target == nil {
		fail("parsed AWS target is missing")
	}
	if target.Bucket != input.ExpectedBucket {
		fail("parsed bucket = %q, want effective bucket %q", target.Bucket, input.ExpectedBucket)
	}
	if target.Region != input.ExpectedRegion {
		fail("parsed region = %q, want %q", target.Region, input.ExpectedRegion)
	}
	accountID := stringField(reflect.ValueOf(target), "AccountID")
	if accountID != input.ExpectedAccount {
		fail("parsed accountId = %q, want target account %q", accountID, input.ExpectedAccount)
	}
	if target.DistributionID != input.ExpectedDistributionID {
		fail("parsed distributionId = %q, want mocked distribution ID %q", target.DistributionID, input.ExpectedDistributionID)
	}
	root := yamlRoot(input.YAML)
	aws := mappingValue(root, "aws")
	for field, expected := range map[string]string{
		"accountId":      input.ExpectedAccount,
		"region":         input.ExpectedRegion,
		"bucket":         input.ExpectedBucket,
		"distributionId": input.ExpectedDistributionID,
	} {
		if actual := stringValue(mappingValue(aws, field)); actual != expected {
			fail("raw Terraform YAML field aws.%s = %q, want %q", field, actual, expected)
		}
	}
	if mappingValue(root, "previewRetentionDays") != nil {
		fail("generated CLI YAML must not include previewRetentionDays")
	}
	for _, field := range []string{"accessKeyId", "secretAccessKey", "apiToken"} {
		if mappingValue(aws, field) != nil {
			fail("generated AWS CLI YAML must not include aws.%s", field)
		}
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{
		"provider":  parsed.Provider,
		"bucket":    target.Bucket,
		"accountId": accountID,
	})
}

func integerField(value reflect.Value, name string) int {
	field := value.FieldByName(name)
	if field.IsValid() && field.CanInt() {
		return int(field.Int())
	}
	return 0
}

func stringField(value reflect.Value, name string) string {
	if value.Kind() == reflect.Pointer {
		value = value.Elem()
	}
	field := value.FieldByName(name)
	if field.IsValid() && field.Kind() == reflect.String {
		return field.String()
	}
	return ""
}

func yamlRoot(contents string) *yaml.Node {
	decoder := yaml.NewDecoder(strings.NewReader(contents))
	var root yaml.Node
	if err := decoder.Decode(&root); err != nil {
		fail("decode raw Terraform YAML for contract assertions: %v", err)
	}
	var extra yaml.Node
	if err := decoder.Decode(&extra); err != io.EOF {
		fail("raw Terraform YAML must contain exactly one document")
	}
	node := &root
	if node.Kind == yaml.DocumentNode && len(node.Content) == 1 {
		node = node.Content[0]
	}
	return node
}

func mappingValue(mapping *yaml.Node, name string) *yaml.Node {
	if mapping == nil || mapping.Kind != yaml.MappingNode {
		return nil
	}
	for index := 0; index+1 < len(mapping.Content); index += 2 {
		if mapping.Content[index].Value == name {
			return mapping.Content[index+1]
		}
	}
	return nil
}

func stringValue(value *yaml.Node) string {
	if value != nil && value.Kind == yaml.ScalarNode {
		return value.Value
	}
	return ""
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
