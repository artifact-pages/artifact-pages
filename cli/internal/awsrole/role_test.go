package awsrole

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/artifact-pages/artifact-pages/cli/internal/config"
	"github.com/artifact-pages/artifact-pages/cli/internal/registry"
)

func TestRoleNameMatchesTerraformSatelliteRoleNames(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller did not return the package source path")
	}
	fixturePath := filepath.Join(filepath.Dir(source), "../../../terraform/modules/aws/tests/fixtures/satellite-role-names.json")
	fixtureBytes, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read shared Terraform/CLI role-name fixture: %v", err)
	}
	var fixture struct {
		NamePrefix string `json:"namePrefix"`
		Cases      []struct {
			SiteID   string `json:"siteID"`
			RoleName string `json:"roleName"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatalf("decode shared role-name fixture: %v", err)
	}
	if len(fixture.Cases) != 2 || len(fixture.Cases[0].RoleName) != 64 || len(fixture.Cases[1].SiteID) <= len(fixture.Cases[0].SiteID) {
		t.Fatalf("fixture must cover the 64-character boundary and a longer site ID: %+v", fixture)
	}
	for _, test := range fixture.Cases {
		got, err := RoleName(fixture.NamePrefix, test.SiteID)
		if err != nil || got != test.RoleName {
			t.Errorf("RoleName(%q, %q) = %q, %v; want %q", fixture.NamePrefix, test.SiteID, got, err, test.RoleName)
		}
		if len(got) > 64 {
			t.Errorf("role name is %d characters, over AWS's 64-character limit: %q", len(got), got)
		}
	}
	if got, err := RoleName("artifact-pages", "docs"); err != nil || got != "artifact-pages-docs-publisher" {
		t.Fatalf("RoleName default-prefix example = %q, %v", got, err)
	}
}

func TestRoleNameRejectsInvalidPrefixAndSite(t *testing.T) {
	for _, test := range []struct{ prefix, site, want string }{
		{"A-prefix", "docs", "aws.namePrefix"},
		{"a", "docs", "aws.namePrefix"},
		{"valid-prefix", "Assets", "invalid site ID"},
		{"valid-prefix", "a--b", "invalid site ID"},
	} {
		_, err := RoleName(test.prefix, test.site)
		if err == nil || !strings.Contains(err.Error(), test.want) {
			t.Errorf("RoleName(%q, %q) error = %v; want %q", test.prefix, test.site, err, test.want)
		}
	}
}

func TestForSiteRequiresAWSAccountAndRegisteredSite(t *testing.T) {
	base := config.DeploymentConfig{
		Provider: "aws",
		AWS:      &config.AWSTarget{AccountID: "123456789012", NamePrefix: "custom", Region: "us-east-1", Bucket: "pages"},
		Sites:    map[string]registry.Site{"docs": {Name: "Docs", Repository: "acme/docs", SourcePath: "public"}},
	}
	got, err := ForSite(base, "docs")
	if err != nil || got != "arn:aws:iam::123456789012:role/custom-docs-publisher" {
		t.Fatalf("ForSite() = %q, %v", got, err)
	}
	base.AWS.NamePrefix = ""
	got, err = ForSite(base, "docs")
	if err != nil || got != "arn:aws:iam::123456789012:role/artifact-pages-docs-publisher" {
		t.Fatalf("ForSite() default prefix = %q, %v", got, err)
	}
	if _, err := ForSite(base, "missing"); err == nil || !strings.Contains(err.Error(), "not registered") {
		t.Fatalf("unregistered site error = %v", err)
	}
	base.AWS.AccountID = ""
	if _, err := ForSite(base, "docs"); err == nil || !strings.Contains(err.Error(), "aws.accountId is required") {
		t.Fatalf("missing account ID error = %v", err)
	}
	base.AWS.AccountID = "12345678901x"
	if _, err := ForSite(base, "docs"); err == nil || !strings.Contains(err.Error(), "12-digit") {
		t.Fatalf("invalid account ID error = %v", err)
	}
	base.Provider = "cloudflare"
	if _, err := ForSite(base, "docs"); err == nil || !strings.Contains(err.Error(), "requires an AWS") {
		t.Fatalf("wrong provider error = %v", err)
	}
}

func TestReadLocalConfigRejectsRemoteAndSymlinkPaths(t *testing.T) {
	if _, err := ReadLocalConfig("github://acme/admin/artifact-pages.yaml"); err == nil {
		t.Fatal("ReadLocalConfig accepted a remote locator")
	}
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	outsideDirectory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(outsideDirectory, "config.yaml")
	if err := os.WriteFile(outside, []byte("schemaVersion: 1\nprovider: aws\naws: {region: us-east-1, bucket: pages}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "config.yaml")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := ReadLocalConfig(link); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("ReadLocalConfig symlink error = %v", err)
	}
}
