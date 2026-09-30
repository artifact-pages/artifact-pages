package config

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/tasuku43/git-artifact-pages/cli/internal/githubrepo"
	"github.com/tasuku43/git-artifact-pages/cli/internal/registry"
	"go.yaml.in/yaml/v4"
)

const (
	SchemaVersion       = 1
	ConfigEnvironment   = "ARTIFACT_PAGES_CONFIG"
	defaultConfigName   = "artifact-pages.yaml"
	savedLocatorName    = "default-config"
	githubAPIBaseURL    = "https://api.github.com"
	maxRemoteConfigSize = 512 << 10
	maxAPIResponseSize  = 2 << 20
)

var (
	providerNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)
	environmentPattern  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	commitPattern       = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)
	cloudflareIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
	awsAccountIDPattern = regexp.MustCompile(`^[0-9]{12}$`)
)

type LocalTarget struct {
	Root string `yaml:"root"`
}

type AWSTarget struct {
	AccountID      string `yaml:"accountId,omitempty"`
	Region         string `yaml:"region"`
	Bucket         string `yaml:"bucket"`
	DistributionID string `yaml:"distributionId"`
}

type CloudflareTarget struct {
	AccountID                        string `yaml:"accountId"`
	Bucket                           string `yaml:"bucket"`
	ZoneID                           string `yaml:"zoneId"`
	PublicBaseURL                    string `yaml:"publicBaseURL"`
	R2Endpoint                       string `yaml:"r2Endpoint,omitempty"`
	APIBaseURL                       string `yaml:"apiBaseURL,omitempty"`
	AccessKeyIDEnv                   string `yaml:"accessKeyIdEnv"`
	SecretAccessKeyEnv               string `yaml:"secretAccessKeyEnv"`
	SessionTokenEnv                  string `yaml:"sessionTokenEnv,omitempty"`
	RegistryReaderAccessKeyIDEnv     string `yaml:"registryReaderAccessKeyIdEnv,omitempty"`
	RegistryReaderSecretAccessKeyEnv string `yaml:"registryReaderSecretAccessKeyEnv,omitempty"`
	RegistryReaderSessionTokenEnv    string `yaml:"registryReaderSessionTokenEnv,omitempty"`
	APITokenEnv                      string `yaml:"apiTokenEnv"`
}

// GCSLocalTarget configures the emulator-only JSON API adapter used by the
// local edge conformance profile. It is not a production Google Cloud target.
type GCSLocalTarget struct {
	Endpoint string `yaml:"endpoint"`
	Bucket   string `yaml:"bucket"`
}

type DeploymentConfig struct {
	SchemaVersion int                      `yaml:"schemaVersion"`
	Provider      string                   `yaml:"provider"`
	Local         *LocalTarget             `yaml:"local"`
	AWS           *AWSTarget               `yaml:"aws"`
	Cloudflare    *CloudflareTarget        `yaml:"cloudflare"`
	GCSLocal      *GCSLocalTarget          `yaml:"gcpLocal"`
	Sites         map[string]registry.Site `yaml:"sites,omitempty"`
}

type ResolvedConfig struct {
	Config     DeploymentConfig
	Locator    string
	CommitSHA  string
	ContentSHA string
}

type Resolver struct {
	WorkingDir       string
	ConfigDir        string
	Getenv           func(string) string
	HTTPClient       *http.Client
	GitHubAPIBaseURL string // Set only by tests using an httptest server.
}

type remoteLocator struct {
	Owner string
	Repo  string
	File  string
	Ref   string
}

type githubRepository struct {
	DefaultBranch string `json:"default_branch"`
}

type githubCommit struct {
	SHA string `json:"sha"`
}

type githubContent struct {
	Type     string `json:"type"`
	Encoding string `json:"encoding"`
	Content  string `json:"content"`
	SHA      string `json:"sha"`
}

// Parse validates one complete provider-target document.
func Parse(contents []byte) (DeploymentConfig, error) {
	layer, err := parseConfigLayer(contents, false)
	if err != nil {
		return DeploymentConfig{}, err
	}
	config, err := layer.WithDefaults()
	if err != nil {
		return DeploymentConfig{}, err
	}
	if err := config.Validate(); err != nil {
		return DeploymentConfig{}, err
	}
	return config, nil
}

// ParseLayers overlays ordered config documents. Site mappings are inherited
// when omitted and replaced as a whole when explicitly present. A provider
// target is always replaced as a whole.
func ParseLayers(contents [][]byte) (DeploymentConfig, error) {
	if len(contents) == 0 {
		return DeploymentConfig{}, errors.New("at least one deployment config layer is required")
	}
	var config DeploymentConfig
	for index, layerContents := range contents {
		layer, err := parseConfigLayer(layerContents, true)
		if err != nil {
			return DeploymentConfig{}, fmt.Errorf("config layer %d: %w", index+1, err)
		}
		if index == 0 {
			config.SchemaVersion = layer.SchemaVersion
		} else if layer.SchemaVersion != config.SchemaVersion {
			return DeploymentConfig{}, errors.New("all deployment config layers must use the same schemaVersion")
		}
		if layer.Provider != "" {
			config.Provider = layer.Provider
			config.Local = layer.Local
			config.AWS = layer.AWS
			config.Cloudflare = layer.Cloudflare
			config.GCSLocal = layer.GCSLocal
		}
		if layer.Sites != nil {
			config.Sites = cloneSites(layer.Sites)
		}
	}
	config, err := config.WithDefaults()
	if err != nil {
		return DeploymentConfig{}, err
	}
	if err := config.Validate(); err != nil {
		return DeploymentConfig{}, err
	}
	return config, nil
}

func parseConfigLayer(contents []byte, allowPartial bool) (DeploymentConfig, error) {
	var nodes []yaml.Node
	if err := yaml.Load(contents, &nodes, yaml.WithAllDocuments()); err != nil {
		return DeploymentConfig{}, fmt.Errorf("decode deployment config: %w", err)
	}
	if len(nodes) != 1 {
		return DeploymentConfig{}, errors.New("deployment config must contain exactly one YAML document")
	}
	if err := validateConfigNode(&nodes[0], allowPartial); err != nil {
		return DeploymentConfig{}, err
	}
	var documents []DeploymentConfig
	if err := yaml.Load(contents, &documents, yaml.WithAllDocuments(), yaml.WithKnownFields(), yaml.WithUniqueKeys()); err != nil {
		return DeploymentConfig{}, fmt.Errorf("decode deployment config: %w", err)
	}
	if len(documents) != 1 {
		return DeploymentConfig{}, errors.New("deployment config must contain exactly one YAML document")
	}
	layer := documents[0]
	if layer.SchemaVersion != SchemaVersion {
		return DeploymentConfig{}, fmt.Errorf("deployment config schemaVersion must be %d", SchemaVersion)
	}
	return layer, nil
}

func cloneSites(sites map[string]registry.Site) map[string]registry.Site {
	clone := make(map[string]registry.Site, len(sites))
	for id, site := range sites {
		clone[id] = site
	}
	return clone
}

// WithDefaults returns a copy with provider defaults resolved. It does not
// discover credentials or contact a provider.
func (config DeploymentConfig) WithDefaults() (DeploymentConfig, error) {
	switch config.Provider {
	case "aws":
		if config.AWS == nil {
			return config, nil
		}
		target := *config.AWS
		if target.AccountID != "" && !awsAccountIDPattern.MatchString(target.AccountID) {
			return DeploymentConfig{}, errors.New("aws.accountId must be a 12-digit AWS account ID")
		}
		if strings.TrimSpace(target.Bucket) == "" {
			if strings.TrimSpace(target.AccountID) == "" {
				return DeploymentConfig{}, errors.New("aws.accountId is required when aws.bucket is omitted")
			}
			if strings.TrimSpace(target.Region) == "" {
				return DeploymentConfig{}, errors.New("aws.region is required")
			}
			target.Bucket = fmt.Sprintf("artifact-pages-%s-%s", target.AccountID, target.Region)
		}
		config.AWS = &target
	case "cloudflare":
		if config.Cloudflare == nil {
			return config, nil
		}
		target := *config.Cloudflare
		if strings.TrimSpace(target.Bucket) == "" {
			target.Bucket = "artifact-pages"
		}
		if target.AccessKeyIDEnv == "" {
			target.AccessKeyIDEnv = "CF_R2_ACCESS_KEY_ID"
		}
		if target.SecretAccessKeyEnv == "" {
			target.SecretAccessKeyEnv = "CF_R2_SECRET_ACCESS_KEY"
		}
		if target.APITokenEnv == "" {
			target.APITokenEnv = "CF_API_TOKEN"
		}
		config.Cloudflare = &target
	}
	return config, nil
}

func (config DeploymentConfig) Validate() error {
	if config.SchemaVersion != SchemaVersion {
		return fmt.Errorf("deployment config schemaVersion must be %d", SchemaVersion)
	}
	if !providerNamePattern.MatchString(config.Provider) {
		return errors.New("deployment config provider must be local, aws, cloudflare, or gcp-local")
	}
	switch config.Provider {
	case "local":
		if config.Local == nil || config.AWS != nil || config.Cloudflare != nil || config.GCSLocal != nil {
			return errors.New("local deployment config must contain only the local settings block")
		}
		if strings.TrimSpace(config.Local.Root) == "" {
			return errors.New("local.root is required")
		}
	case "aws":
		if config.AWS == nil || config.Local != nil || config.Cloudflare != nil || config.GCSLocal != nil {
			return errors.New("aws deployment config must contain only the aws settings block")
		}
		if strings.TrimSpace(config.AWS.Region) == "" {
			return errors.New("aws.region is required")
		}
		if config.AWS.AccountID != "" && !awsAccountIDPattern.MatchString(config.AWS.AccountID) {
			return errors.New("aws.accountId must be a 12-digit AWS account ID")
		}
		if strings.TrimSpace(config.AWS.Bucket) == "" {
			return errors.New("aws.bucket is required")
		}
	case "cloudflare":
		if config.Cloudflare == nil || config.Local != nil || config.AWS != nil || config.GCSLocal != nil {
			return errors.New("cloudflare deployment config must contain only the cloudflare settings block")
		}
		target := config.Cloudflare
		if !cloudflareIDPattern.MatchString(target.AccountID) || !cloudflareIDPattern.MatchString(target.ZoneID) {
			return errors.New("cloudflare.accountId and cloudflare.zoneId must be 32-character hexadecimal IDs")
		}
		if strings.TrimSpace(target.Bucket) == "" {
			return errors.New("cloudflare.bucket is required")
		}
		if err := validatePublicBaseURL(target.PublicBaseURL); err != nil {
			return fmt.Errorf("cloudflare.publicBaseURL: %w", err)
		}
		if (target.R2Endpoint == "") != (target.APIBaseURL == "") {
			return errors.New("cloudflare.r2Endpoint and cloudflare.apiBaseURL must be set together for local conformance profiles")
		}
		if target.R2Endpoint != "" {
			if err := validateLocalHTTPOrigin(target.R2Endpoint, false); err != nil {
				return fmt.Errorf("cloudflare.r2Endpoint: %w", err)
			}
			if err := validateLocalHTTPOrigin(target.APIBaseURL, true); err != nil {
				return fmt.Errorf("cloudflare.apiBaseURL: %w", err)
			}
		}
		for name, value := range map[string]string{
			"accessKeyIdEnv":     target.AccessKeyIDEnv,
			"secretAccessKeyEnv": target.SecretAccessKeyEnv,
			"apiTokenEnv":        target.APITokenEnv,
		} {
			if !environmentPattern.MatchString(value) {
				return fmt.Errorf("cloudflare.%s must name an environment variable", name)
			}
		}
		if target.SessionTokenEnv != "" && !environmentPattern.MatchString(target.SessionTokenEnv) {
			return errors.New("cloudflare.sessionTokenEnv must name an environment variable when set")
		}
		registryReaderConfigured := target.RegistryReaderAccessKeyIDEnv != "" || target.RegistryReaderSecretAccessKeyEnv != "" || target.RegistryReaderSessionTokenEnv != ""
		if registryReaderConfigured && (target.RegistryReaderAccessKeyIDEnv == "" || target.RegistryReaderSecretAccessKeyEnv == "") {
			return errors.New("cloudflare.registryReaderAccessKeyIdEnv and registryReaderSecretAccessKeyEnv must be set together")
		}
		for name, value := range map[string]string{
			"registryReaderAccessKeyIdEnv":     target.RegistryReaderAccessKeyIDEnv,
			"registryReaderSecretAccessKeyEnv": target.RegistryReaderSecretAccessKeyEnv,
			"registryReaderSessionTokenEnv":    target.RegistryReaderSessionTokenEnv,
		} {
			if value != "" && !environmentPattern.MatchString(value) {
				return fmt.Errorf("cloudflare.%s must name an environment variable", name)
			}
		}
	case "gcp-local":
		if config.GCSLocal == nil || config.Local != nil || config.AWS != nil || config.Cloudflare != nil {
			return errors.New("gcp-local deployment config must contain only the gcpLocal settings block")
		}
		if strings.TrimSpace(config.GCSLocal.Bucket) == "" {
			return errors.New("gcpLocal.bucket is required")
		}
		if err := validateLocalHTTPOrigin(config.GCSLocal.Endpoint, false); err != nil {
			return fmt.Errorf("gcpLocal.endpoint: %w", err)
		}
	default:
		return fmt.Errorf("unsupported deployment provider %q", config.Provider)
	}
	if config.Sites != nil {
		if _, err := registry.ProjectSites(config.Sites); err != nil {
			return err
		}
	}
	return nil
}

func validateConfigNode(document *yaml.Node, allowPartial bool) error {
	root := document
	if root.Kind == yaml.DocumentNode {
		if len(root.Content) != 1 {
			return errors.New("deployment config must contain one mapping document")
		}
		root = root.Content[0]
	}
	if root.Kind != yaml.MappingNode {
		return errors.New("deployment config root must be a mapping")
	}
	for index := 0; index < len(root.Content); index += 2 {
		if root.Content[index].Kind != yaml.ScalarNode || root.Content[index].ShortTag() != "!!str" {
			return errors.New("deployment config keys must be strings")
		}
	}
	version := nodeMappingValue(root, "schemaVersion")
	if version == nil || version.Kind != yaml.ScalarNode || version.ShortTag() != "!!int" {
		return errors.New("schemaVersion must be an integer")
	}
	provider := nodeMappingValue(root, "provider")
	if provider == nil && !allowPartial {
		return errors.New("provider must be a string")
	}
	if provider != nil && (provider.Kind != yaml.ScalarNode || provider.ShortTag() != "!!str") {
		return errors.New("provider must be a string")
	}
	if allowPartial {
		targetBlocks := 0
		for _, blockName := range []string{"local", "aws", "cloudflare", "gcpLocal"} {
			if nodeMappingValue(root, blockName) != nil {
				targetBlocks++
			}
		}
		if provider == nil && targetBlocks != 0 {
			return errors.New("provider is required when a provider target is configured")
		}
		if provider != nil {
			if targetBlocks != 1 {
				return errors.New("a config layer with provider must contain exactly one provider target")
			}
			blockName := providerTargetBlock(provider.Value)
			if blockName == "" || nodeMappingValue(root, blockName) == nil {
				return fmt.Errorf("provider %q requires its matching settings block", provider.Value)
			}
		}
	}
	for _, blockName := range []string{"local", "aws", "cloudflare", "gcpLocal"} {
		block := nodeMappingValue(root, blockName)
		if block == nil {
			continue
		}
		if block.Kind != yaml.MappingNode {
			return fmt.Errorf("%s settings must be a mapping", blockName)
		}
		for index := 0; index < len(block.Content); index += 2 {
			keyNode, valueNode := block.Content[index], block.Content[index+1]
			if keyNode.Kind != yaml.ScalarNode || keyNode.ShortTag() != "!!str" {
				return fmt.Errorf("%s setting names must be strings", blockName)
			}
			if valueNode.Kind != yaml.ScalarNode || valueNode.ShortTag() != "!!str" {
				return fmt.Errorf("%s.%s must be a string", blockName, keyNode.Value)
			}
			if optionalNonblankOverride(blockName, keyNode.Value) && strings.TrimSpace(valueNode.Value) == "" {
				return fmt.Errorf("%s.%s must not be empty when set", blockName, keyNode.Value)
			}
		}
	}
	if sites := nodeMappingValue(root, "sites"); sites != nil {
		if sites.Kind != yaml.MappingNode {
			return errors.New("sites must be a mapping (use sites: {} for an empty registry)")
		}
		for index := 0; index < len(sites.Content); index += 2 {
			idNode, siteNode := sites.Content[index], sites.Content[index+1]
			if idNode.Kind != yaml.ScalarNode || idNode.ShortTag() != "!!str" {
				return errors.New("site IDs must be strings")
			}
			if siteNode.Kind != yaml.MappingNode {
				return fmt.Errorf("site %q must be a mapping", idNode.Value)
			}
			for fieldIndex := 0; fieldIndex < len(siteNode.Content); fieldIndex += 2 {
				keyNode, valueNode := siteNode.Content[fieldIndex], siteNode.Content[fieldIndex+1]
				if keyNode.Kind != yaml.ScalarNode || keyNode.ShortTag() != "!!str" {
					return fmt.Errorf("site %q field names must be strings", idNode.Value)
				}
				if valueNode.Kind != yaml.ScalarNode || valueNode.ShortTag() != "!!str" {
					return fmt.Errorf("site %q field %q must be a string", idNode.Value, keyNode.Value)
				}
			}
		}
	}
	return nil
}

func providerTargetBlock(provider string) string {
	switch provider {
	case "local":
		return "local"
	case "aws":
		return "aws"
	case "cloudflare":
		return "cloudflare"
	case "gcp-local":
		return "gcpLocal"
	default:
		return ""
	}
}

func optionalNonblankOverride(block, field string) bool {
	switch block {
	case "aws":
		return field == "accountId" || field == "bucket"
	case "cloudflare":
		return field == "bucket" || field == "accessKeyIdEnv" || field == "secretAccessKeyEnv" || field == "apiTokenEnv"
	default:
		return false
	}
}

func validateLocalHTTPOrigin(raw string, allowPath bool) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("must be an HTTP loopback endpoint without credentials, query, or fragment")
	}
	host := parsed.Hostname()
	if host != "localhost" {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return errors.New("must be an HTTP loopback endpoint without credentials, query, or fragment")
		}
	}
	if !allowPath && parsed.Path != "" && parsed.Path != "/" {
		return errors.New("must be an HTTP loopback origin without a path")
	}
	return nil
}

func nodeMappingValue(mapping *yaml.Node, key string) *yaml.Node {
	for index := 0; index+1 < len(mapping.Content); index += 2 {
		if mapping.Content[index].Value == key {
			return mapping.Content[index+1]
		}
	}
	return nil
}

func validatePublicBaseURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return errors.New("must be an HTTPS origin without credentials, path, query, or fragment")
	}
	return nil
}

// Resolve applies the documented precedence and loads one config locator.
func (resolver Resolver) Resolve(ctx context.Context, explicitLocator string) (ResolvedConfig, error) {
	if strings.TrimSpace(explicitLocator) == "" {
		return resolver.ResolveLayers(ctx, nil)
	}
	return resolver.ResolveLayers(ctx, []string{explicitLocator})
}

// ResolveLayers loads ordered local config layers. A single GitHub locator is
// supported for remote configs; remote/local stacks are rejected so each
// invocation has one unambiguous remote provenance.
func (resolver Resolver) ResolveLayers(ctx context.Context, explicitLocators []string) (ResolvedConfig, error) {
	if err := ctx.Err(); err != nil {
		return ResolvedConfig{}, err
	}
	workingDir, err := resolver.workingDirectory()
	if err != nil {
		return ResolvedConfig{}, err
	}
	locators := make([]string, 0, len(explicitLocators))
	for _, explicitLocator := range explicitLocators {
		locator := strings.TrimSpace(explicitLocator)
		if locator == "" {
			return ResolvedConfig{}, errors.New("deployment config locator must not be empty")
		}
		locators = append(locators, locator)
	}
	if len(locators) == 0 {
		if locator := strings.TrimSpace(resolver.getenv(ConfigEnvironment)); locator != "" {
			locators = append(locators, locator)
		}
	}
	if len(locators) == 0 {
		localPath := filepath.Join(workingDir, defaultConfigName)
		info, statErr := os.Stat(localPath)
		if statErr == nil {
			if !info.Mode().IsRegular() {
				return ResolvedConfig{}, fmt.Errorf("repository config %s is not a regular file", localPath)
			}
			locators = append(locators, localPath)
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return ResolvedConfig{}, fmt.Errorf("inspect repository config: %w", statErr)
		}
	}
	if len(locators) == 0 {
		defaultPath, pathErr := resolver.savedLocatorPath()
		if pathErr != nil {
			return ResolvedConfig{}, pathErr
		}
		contents, readErr := os.ReadFile(defaultPath)
		if readErr == nil {
			locator := strings.TrimSpace(string(contents))
			if locator == "" {
				return ResolvedConfig{}, errors.New("saved default config locator is empty")
			}
			locators = append(locators, locator)
		} else if !errors.Is(readErr, os.ErrNotExist) {
			return ResolvedConfig{}, fmt.Errorf("read saved default config locator: %w", readErr)
		}
	}
	if len(locators) == 0 {
		return ResolvedConfig{}, errors.New("no deployment config found; pass --config, set ARTIFACT_PAGES_CONFIG, add artifact-pages.yaml, or save a default")
	}
	if len(locators) == 1 && strings.HasPrefix(locators[0], "github://") {
		contents, commitSHA, canonicalLocator, remoteErr := resolver.readRemoteConfig(ctx, locators[0])
		if remoteErr != nil {
			return ResolvedConfig{}, remoteErr
		}
		config, parseErr := Parse(contents)
		if parseErr != nil {
			return ResolvedConfig{}, fmt.Errorf("parse remote deployment config at commit %s: %w", commitSHA, parseErr)
		}
		return ResolvedConfig{Config: config, Locator: canonicalLocator, CommitSHA: commitSHA, ContentSHA: digest(contents)}, nil
	}
	for _, locator := range locators {
		if strings.HasPrefix(locator, "github://") {
			return ResolvedConfig{}, errors.New("remote config cannot be combined with other config layers; use one complete remote config or local layers")
		}
	}
	layers := make([][]byte, 0, len(locators))
	resolvedPaths := make([]string, 0, len(locators))
	var totalSize int64
	for _, locator := range locators {
		localPath, err := resolver.absoluteLocalPath(locator, workingDir)
		if err != nil {
			return ResolvedConfig{}, err
		}
		contents, err := os.ReadFile(localPath)
		if err != nil {
			return ResolvedConfig{}, fmt.Errorf("read deployment config %s: %w", localPath, err)
		}
		totalSize += int64(len(contents))
		if totalSize > maxRemoteConfigSize {
			return ResolvedConfig{}, fmt.Errorf("combined deployment config exceeds %d bytes", maxRemoteConfigSize)
		}
		layers = append(layers, contents)
		resolvedPaths = append(resolvedPaths, localPath)
	}
	config, err := ParseLayers(layers)
	if err != nil {
		return ResolvedConfig{}, fmt.Errorf("parse deployment config layers: %w", err)
	}
	var combined []byte
	for _, contents := range layers {
		combined = append(combined, contents...)
		combined = append(combined, 0)
	}
	return ResolvedConfig{
		Config: config, Locator: strings.Join(resolvedPaths, " + "), ContentSHA: digest(combined),
	}, nil
}

// SetDefault stores a non-secret config locator in the user's config directory.
func (resolver Resolver) SetDefault(locator string) (string, error) {
	locator = strings.TrimSpace(locator)
	if locator == "" {
		return "", errors.New("config locator is required")
	}
	if strings.HasPrefix(locator, "github://") {
		if _, err := parseRemoteLocator(locator); err != nil {
			return "", err
		}
	} else {
		workingDir, err := resolver.workingDirectory()
		if err != nil {
			return "", err
		}
		locator, err = resolver.absoluteLocalPath(locator, workingDir)
		if err != nil {
			return "", err
		}
	}
	path, err := resolver.savedLocatorPath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("create user config directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".default-config-*")
	if err != nil {
		return "", err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if _, err := io.WriteString(temporary, locator+"\n"); err != nil {
		_ = temporary.Close()
		return "", err
	}
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return "", err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return "", err
	}
	if err := temporary.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return "", fmt.Errorf("save default config locator: %w", err)
	}
	return path, nil
}

func (resolver Resolver) readRemoteConfig(ctx context.Context, rawLocator string) ([]byte, string, string, error) {
	locator, err := parseRemoteLocator(rawLocator)
	if err != nil {
		return nil, "", "", err
	}
	baseURL := resolver.GitHubAPIBaseURL
	if baseURL == "" {
		baseURL = githubAPIBaseURL
	}
	parsedBase, err := url.Parse(baseURL)
	if err != nil || parsedBase.Host == "" || (parsedBase.Scheme != "https" && resolver.GitHubAPIBaseURL == "") {
		return nil, "", "", errors.New("invalid GitHub API base URL")
	}
	client := resolver.httpClient()
	ref := locator.Ref
	if ref == "" {
		var repository githubRepository
		status, readErr := resolver.getGitHubJSON(ctx, client, baseURL, "/repos/"+url.PathEscape(locator.Owner)+"/"+url.PathEscape(locator.Repo), nil, &repository)
		if readErr != nil {
			return nil, "", "", readErr
		}
		if status != http.StatusOK || repository.DefaultBranch == "" {
			return nil, "", "", fmt.Errorf("GitHub repository metadata request failed (HTTP %d)", status)
		}
		ref = repository.DefaultBranch
	}
	commitSHA := ref
	if !commitPattern.MatchString(ref) {
		var commit githubCommit
		status, readErr := resolver.getGitHubJSON(ctx, client, baseURL, "/repos/"+url.PathEscape(locator.Owner)+"/"+url.PathEscape(locator.Repo)+"/commits/"+url.PathEscape(ref), nil, &commit)
		if readErr != nil {
			return nil, "", "", readErr
		}
		if status != http.StatusOK || !commitPattern.MatchString(commit.SHA) {
			return nil, "", "", fmt.Errorf("GitHub ref could not be resolved to a commit (HTTP %d)", status)
		}
		commitSHA = strings.ToLower(commit.SHA)
	}
	files := []string{locator.File}
	if locator.File == "" {
		files = []string{defaultConfigName}
	}
	for _, file := range files {
		var content githubContent
		query := url.Values{"ref": []string{commitSHA}}
		endpoint := "/repos/" + url.PathEscape(locator.Owner) + "/" + url.PathEscape(locator.Repo) + "/contents/" + escapeGitHubPath(file)
		status, readErr := resolver.getGitHubJSON(ctx, client, baseURL, endpoint, query, &content)
		if readErr != nil {
			return nil, "", "", readErr
		}
		if status != http.StatusOK {
			return nil, "", "", fmt.Errorf("GitHub config fetch failed for %s (HTTP %d)", file, status)
		}
		if content.Type != "file" || content.Encoding != "base64" {
			return nil, "", "", errors.New("GitHub config response is not a base64-encoded file")
		}
		decoded, decodeErr := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(content.Content), ""))
		if decodeErr != nil {
			return nil, "", "", errors.New("GitHub config response contained invalid base64")
		}
		if len(decoded) > maxRemoteConfigSize {
			return nil, "", "", fmt.Errorf("remote deployment config exceeds %d bytes", maxRemoteConfigSize)
		}
		canonical := fmt.Sprintf("github://%s/%s/%s?ref=%s", locator.Owner, locator.Repo, file, url.QueryEscape(commitSHA))
		return decoded, commitSHA, canonical, nil
	}
	return nil, "", "", errors.New("remote deployment config was not found")
}

func (resolver Resolver) getGitHubJSON(ctx context.Context, client *http.Client, baseURL, endpoint string, query url.Values, output any) (int, error) {
	requestURL := strings.TrimSuffix(baseURL, "/") + endpoint
	if len(query) > 0 {
		requestURL += "?" + query.Encode()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return 0, errors.New("create GitHub API request")
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "artifact-pages")
	token := resolver.getenv("GITHUB_TOKEN")
	if token == "" {
		token = resolver.getenv("GH_TOKEN")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, errors.New("GitHub config request failed")
	}
	defer response.Body.Close()
	if response.Request == nil || response.Request.URL == nil || response.Request.URL.Host != request.URL.Host || response.Request.URL.Scheme != "https" && resolver.GitHubAPIBaseURL == "" {
		return 0, errors.New("GitHub config request left the expected HTTPS origin")
	}
	contents, err := io.ReadAll(io.LimitReader(response.Body, maxAPIResponseSize+1))
	if err != nil {
		return response.StatusCode, errors.New("read GitHub API response")
	}
	if len(contents) > maxAPIResponseSize {
		return response.StatusCode, errors.New("GitHub API response is too large")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return response.StatusCode, nil
	}
	if err := json.Unmarshal(contents, output); err != nil {
		return response.StatusCode, errors.New("GitHub API response is malformed")
	}
	return response.StatusCode, nil
}

func (resolver Resolver) httpClient() *http.Client {
	client := &http.Client{Timeout: 15 * time.Second}
	if resolver.HTTPClient != nil {
		copy := *resolver.HTTPClient
		client = &copy
		if client.Timeout == 0 {
			client.Timeout = 15 * time.Second
		}
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return client
}

func parseRemoteLocator(raw string) (remoteLocator, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "github" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || parsed.Port() != "" {
		return remoteLocator{}, errors.New("remote config locator must use github://OWNER/REPO[/FILE]?ref=REF")
	}
	owner := parsed.Hostname()
	if !providerNamePattern.MatchString(strings.ToLower(owner)) || strings.Contains(owner, ".") || strings.Contains(owner, "_") {
		return remoteLocator{}, errors.New("remote config locator has an invalid GitHub owner")
	}
	escapedPath := strings.TrimPrefix(parsed.EscapedPath(), "/")
	parts := strings.Split(escapedPath, "/")
	if len(parts) == 0 || parts[0] == "" {
		return remoteLocator{}, errors.New("remote config locator must include a repository")
	}
	decodedParts := make([]string, len(parts))
	for index, part := range parts {
		decoded, decodeErr := url.PathUnescape(part)
		if decodeErr != nil || decoded == "" || decoded == "." || decoded == ".." || strings.Contains(decoded, "/") || strings.Contains(decoded, `\`) {
			return remoteLocator{}, errors.New("remote config locator contains an unsafe path")
		}
		decodedParts[index] = decoded
	}
	repository := decodedParts[0]
	if !githubrepo.ValidRepositoryName(repository) {
		return remoteLocator{}, errors.New("remote config locator has an invalid repository")
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return remoteLocator{}, errors.New("remote config locator has a malformed query")
	}
	for key, values := range query {
		if key != "ref" || len(values) != 1 || values[0] == "" {
			return remoteLocator{}, errors.New("remote config locator supports only one non-empty ref query")
		}
	}
	file := strings.Join(decodedParts[1:], "/")
	if file != "" && (path.Clean(file) != file || strings.HasPrefix(file, "/")) {
		return remoteLocator{}, errors.New("remote config file path must be canonical and repository-relative")
	}
	return remoteLocator{Owner: owner, Repo: repository, File: file, Ref: query.Get("ref")}, nil
}

func escapeGitHubPath(file string) string {
	parts := strings.Split(file, "/")
	for index, part := range parts {
		parts[index] = url.PathEscape(part)
	}
	return strings.Join(parts, "/")
}

func digest(contents []byte) string {
	sum := sha256.Sum256(contents)
	return hex.EncodeToString(sum[:])
}

func (resolver Resolver) workingDirectory() (string, error) {
	if resolver.WorkingDir != "" {
		return filepath.Abs(resolver.WorkingDir)
	}
	return os.Getwd()
}

func (resolver Resolver) absoluteLocalPath(locator, workingDir string) (string, error) {
	if strings.HasPrefix(locator, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home directory: %w", err)
		}
		locator = filepath.Join(home, locator[2:])
	}
	if !filepath.IsAbs(locator) {
		locator = filepath.Join(workingDir, locator)
	}
	return filepath.Abs(locator)
}

func (resolver Resolver) savedLocatorPath() (string, error) {
	directory := resolver.ConfigDir
	if directory == "" {
		var err error
		directory, err = os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("resolve user config directory: %w", err)
		}
	}
	return filepath.Join(directory, "artifact-pages", savedLocatorName), nil
}

func (resolver Resolver) getenv(name string) string {
	if resolver.Getenv != nil {
		return resolver.Getenv(name)
	}
	return os.Getenv(name)
}
