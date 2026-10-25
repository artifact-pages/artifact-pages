// Package deploymentbackend builds a publisher backend from deployment config.
package deploymentbackend

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	deploymentconfig "github.com/artifact-pages/artifact-pages/cli/internal/config"
	"github.com/artifact-pages/artifact-pages/cli/internal/publisher"
)

// New builds the configured deployment backend.
func New(ctx context.Context, config deploymentconfig.DeploymentConfig, useRegistryReader bool) (publisher.DeploymentBackend, error) {
	var err error
	config, err = config.WithDefaults()
	if err != nil {
		return nil, err
	}
	if err := config.Validate(); err != nil {
		return nil, err
	}
	switch config.Provider {
	case "local":
		return publisher.NewDirectoryBackend(config.Local.Root)
	case "aws":
		return publisher.NewAWSBackend(ctx, publisher.AWSOptions{
			Region: config.AWS.Region, Bucket: config.AWS.Bucket, DistributionID: config.AWS.DistributionID,
		})
	case "cloudflare":
		credentials := config.Cloudflare
		var registryReaderAccessKeyID, registryReaderSecretAccessKey, registryReaderSessionToken string
		if useRegistryReader && credentials.RegistryReaderAccessKeyIDEnv != "" {
			registryReaderAccessKeyID = os.Getenv(credentials.RegistryReaderAccessKeyIDEnv)
			registryReaderSecretAccessKey = os.Getenv(credentials.RegistryReaderSecretAccessKeyEnv)
			registryReaderSessionToken = os.Getenv(credentials.RegistryReaderSessionTokenEnv)
			if strings.TrimSpace(registryReaderAccessKeyID) == "" || strings.TrimSpace(registryReaderSecretAccessKey) == "" {
				return nil, errors.New("Cloudflare registry reader credentials named by deployment config are not set")
			}
		}
		return publisher.NewCloudflareBackend(ctx, publisher.CloudflareOptions{
			AccountID: credentials.AccountID, Bucket: credentials.Bucket, ZoneID: credentials.ZoneID,
			PublicBaseURL: credentials.PublicBaseURL, AccessKeyID: os.Getenv(credentials.AccessKeyIDEnv),
			SecretKey: os.Getenv(credentials.SecretAccessKeyEnv), SessionToken: os.Getenv(credentials.SessionTokenEnv),
			RegistryReaderAccessKeyID:  registryReaderAccessKeyID,
			RegistryReaderSecretKey:    registryReaderSecretAccessKey,
			RegistryReaderSessionToken: registryReaderSessionToken,
			APITokenProvider:           func() string { return os.Getenv(credentials.APITokenEnv) },
			R2Endpoint:                 credentials.R2Endpoint, APIBaseURL: credentials.APIBaseURL,
		})
	case "gcp-local":
		return publisher.NewLocalGCSBackend(config.GCSLocal.Endpoint, config.GCSLocal.Bucket)
	default:
		return nil, fmt.Errorf("unsupported deployment provider %q", config.Provider)
	}
}
