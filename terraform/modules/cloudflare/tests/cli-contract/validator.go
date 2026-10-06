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
	YAML                  string `json:"yaml"`
	Provider              string `json:"provider"`
	ExpectedBucket        string `json:"expected_bucket"`
	ExpectedAccount       string `json:"expected_account_id"`
	ExpectedZone          string `json:"expected_zone_id"`
	ExpectedBaseURL       string `json:"expected_public_base_url"`
	ExpectedAccess        string `json:"expected_access_key_env"`
	ExpectedSecret        string `json:"expected_secret_key_env"`
	ExpectedAPIToken      string `json:"expected_api_token_env"`
	ExpectedReaderAccess  string `json:"expected_registry_reader_access_key_id_env"`
	ExpectedReaderSecret  string `json:"expected_registry_reader_secret_access_key_env"`
	ExpectedReaderSession string `json:"expected_registry_reader_session_token_env"`
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

	target := parsed.Cloudflare
	if target == nil {
		fail("parsed Cloudflare target is missing")
	}
	if target.Bucket != input.ExpectedBucket {
		fail("parsed bucket = %q, want effective bucket %q", target.Bucket, input.ExpectedBucket)
	}
	if target.AccountID != input.ExpectedAccount || target.ZoneID != input.ExpectedZone {
		fail("parsed account/zone IDs = %q/%q, want %q/%q", target.AccountID, target.ZoneID, input.ExpectedAccount, input.ExpectedZone)
	}
	if target.PublicBaseURL != input.ExpectedBaseURL {
		fail("parsed publicBaseURL = %q, want %q", target.PublicBaseURL, input.ExpectedBaseURL)
	}
	if target.AccessKeyIDEnv != input.ExpectedAccess || target.SecretAccessKeyEnv != input.ExpectedSecret || target.APITokenEnv != input.ExpectedAPIToken {
		fail("parsed credential environment names = %q/%q/%q, want %q/%q/%q", target.AccessKeyIDEnv, target.SecretAccessKeyEnv, target.APITokenEnv, input.ExpectedAccess, input.ExpectedSecret, input.ExpectedAPIToken)
	}
	if target.SessionTokenEnv != "" || target.RegistryReaderAccessKeyIDEnv != input.ExpectedReaderAccess || target.RegistryReaderSecretAccessKeyEnv != input.ExpectedReaderSecret || target.RegistryReaderSessionTokenEnv != input.ExpectedReaderSession {
		fail("parsed advanced credential environment names = %q/%q/%q/%q, want primary session empty and registry-reader %q/%q/%q", target.SessionTokenEnv, target.RegistryReaderAccessKeyIDEnv, target.RegistryReaderSecretAccessKeyEnv, target.RegistryReaderSessionTokenEnv, input.ExpectedReaderAccess, input.ExpectedReaderSecret, input.ExpectedReaderSession)
	}
	root := yamlRoot(input.YAML)
	cloudflare := mappingValue(root, "cloudflare")
	for field, expected := range map[string]string{
		"bucket":        input.ExpectedBucket,
		"accountId":     input.ExpectedAccount,
		"zoneId":        input.ExpectedZone,
		"publicBaseURL": input.ExpectedBaseURL,
	} {
		if actual := stringValue(mappingValue(cloudflare, field)); actual != expected {
			fail("raw Terraform YAML field cloudflare.%s = %q, want %q", field, actual, expected)
		}
	}
	if mappingValue(root, "previewRetentionDays") != nil {
		fail("generated CLI YAML must not include previewRetentionDays")
	}
	if target.AccessKeyIDEnv == "CF_R2_ACCESS_KEY_ID" && mappingValue(cloudflare, "accessKeyIdEnv") != nil {
		fail("default accessKeyIdEnv should be omitted from the minimal generated YAML")
	}
	if target.SecretAccessKeyEnv == "CF_R2_SECRET_ACCESS_KEY" && mappingValue(cloudflare, "secretAccessKeyEnv") != nil {
		fail("default secretAccessKeyEnv should be omitted from the minimal generated YAML")
	}
	if target.APITokenEnv == "CF_API_TOKEN" && mappingValue(cloudflare, "apiTokenEnv") != nil {
		fail("default apiTokenEnv should be omitted from the minimal generated YAML")
	}
	for _, field := range []string{"accessKeyId", "secretAccessKey", "apiToken", "sessionTokenEnv"} {
		if mappingValue(cloudflare, field) != nil {
			fail("generated CLI YAML must not include cloudflare.%s", field)
		}
	}
	for field, expected := range map[string]string{
		"registryReaderAccessKeyIdEnv":     input.ExpectedReaderAccess,
		"registryReaderSecretAccessKeyEnv": input.ExpectedReaderSecret,
		"registryReaderSessionTokenEnv":    input.ExpectedReaderSession,
	} {
		actual := stringValue(mappingValue(cloudflare, field))
		if actual != expected {
			fail("raw Terraform YAML field cloudflare.%s = %q, want %q", field, actual, expected)
		}
	}
	for field, expected := range map[string]string{
		"accessKeyIdEnv":     input.ExpectedAccess,
		"secretAccessKeyEnv": input.ExpectedSecret,
		"apiTokenEnv":        input.ExpectedAPIToken,
	} {
		if expected != "CF_R2_ACCESS_KEY_ID" && expected != "CF_R2_SECRET_ACCESS_KEY" && expected != "CF_API_TOKEN" {
			if actual := stringValue(mappingValue(cloudflare, field)); actual != expected {
				fail("raw Terraform YAML field cloudflare.%s = %q, want override %q", field, actual, expected)
			}
		}
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{
		"provider": parsed.Provider,
		"bucket":   target.Bucket,
	})
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

func integerField(value reflect.Value, name string) int {
	field := value.FieldByName(name)
	if field.IsValid() && field.CanInt() {
		return int(field.Int())
	}
	return 0
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
