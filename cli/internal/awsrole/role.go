// Package awsrole derives the per-site IAM role names used by the AWS module.
package awsrole

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/artifact-pages/artifact-pages/cli/internal/config"
	"github.com/artifact-pages/artifact-pages/cli/internal/registry"
)

const defaultNamePrefix = "artifact-pages"

var namePrefixPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{1,30}$`)

// RoleName mirrors local.satellite_role_names in terraform/modules/aws/main.tf.
func RoleName(namePrefix, siteID string) (string, error) {
	if !namePrefixPattern.MatchString(namePrefix) {
		return "", errors.New("aws.namePrefix must match ^[a-z][a-z0-9-]{1,30}$")
	}
	if err := registry.ValidateSiteID(siteID); err != nil {
		return "", err
	}
	full := fmt.Sprintf("%s-%s-publisher", namePrefix, siteID)
	if len(full) <= 64 {
		return full, nil
	}
	sum := sha256.Sum256([]byte(siteID))
	return fmt.Sprintf("%s-s-%s-pub", namePrefix, hex.EncodeToString(sum[:])[:20]), nil
}

// ForSite returns the site-specific role ARN described by terraform/modules/aws.
func ForSite(deployment config.DeploymentConfig, siteID string) (string, error) {
	if deployment.Provider != "aws" || deployment.AWS == nil {
		return "", errors.New("registry role-arn requires an AWS deployment config")
	}
	if deployment.AWS.AccountID == "" {
		return "", errors.New("aws.accountId is required to derive a site role ARN")
	}
	if len(deployment.AWS.AccountID) != 12 {
		return "", errors.New("aws.accountId must be a 12-digit AWS account ID")
	}
	for _, digit := range deployment.AWS.AccountID {
		if digit < '0' || digit > '9' {
			return "", errors.New("aws.accountId must be a 12-digit AWS account ID")
		}
	}
	if err := registry.ValidateSiteID(siteID); err != nil {
		return "", err
	}
	if deployment.Sites == nil {
		return "", errors.New("deployment config must include a sites mapping for registry role-arn")
	}
	if _, registered := deployment.Sites[siteID]; !registered {
		return "", fmt.Errorf("site %q is not registered in the deployment config", siteID)
	}
	prefix := deployment.AWS.NamePrefix
	if prefix == "" {
		prefix = defaultNamePrefix
	}
	name, err := RoleName(prefix, siteID)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("arn:aws:iam::%s:role/%s", deployment.AWS.AccountID, name), nil
}

// ReadLocalConfig loads an explicit regular local file. It deliberately does
// not consult environment defaults or remote config locators.
func ReadLocalConfig(path string) (config.DeploymentConfig, error) {
	if path == "" || strings.Contains(path, "://") {
		return config.DeploymentConfig{}, errors.New("--config must name a local deployment config file")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return config.DeploymentConfig{}, fmt.Errorf("resolve deployment config path: %w", err)
	}
	contents, err := readNoSymlink(abs)
	if err != nil {
		return config.DeploymentConfig{}, fmt.Errorf("read deployment config: %w", err)
	}
	deployment, err := config.Parse(contents)
	if err != nil {
		return config.DeploymentConfig{}, fmt.Errorf("parse local deployment config: %w", err)
	}
	return deployment, nil
}

func readNoSymlink(path string) ([]byte, error) {
	volume := filepath.VolumeName(path)
	remainder := strings.TrimPrefix(path, volume)
	current := volume + string(filepath.Separator)
	parts := strings.Split(strings.TrimPrefix(remainder, string(filepath.Separator)), string(filepath.Separator))
	for index, part := range parts {
		if part == "" || part == "." {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("config path must not traverse a symlink")
		}
		if index < len(parts)-1 && !info.IsDir() {
			return nil, errors.New("config parent path must be a directory")
		}
		if index == len(parts)-1 && !info.Mode().IsRegular() {
			return nil, errors.New("config must be a regular file")
		}
	}
	return os.ReadFile(path)
}
