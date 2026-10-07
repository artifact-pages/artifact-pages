package config

import (
	"context"
	"errors"
	"fmt"
	"go.yaml.in/yaml/v3"
)

// ExactVersion validates the stable release spelling used by official assets.
func ExactVersion(value string) bool { return exactVersionPattern.MatchString(value) }

// ResolveCLIVersion shares all locator, authentication and layer loading with
// the strict resolver. Only the stable component-version fields are interpreted:
// a future config schema must be able to select a CLI which understands it.
func (resolver Resolver) ResolveCLIVersion(ctx context.Context, locators []string) (string, error) {
	resolved, err := resolver.resolveLayers(ctx, locators, parseBootstrapLayers)
	if err != nil {
		return "", err
	}
	if resolved.Config.CLI == nil {
		return "", nil
	}
	return resolved.Config.CLI.Version, nil
}

func parseBootstrapLayers(layers [][]byte, _ bool) (DeploymentConfig, error) {
	var result DeploymentConfig
	seen := false
	for i, contents := range layers {
		nodes, err := decodeYAMLDocuments[yaml.Node](contents, false)
		if err != nil {
			return result, fmt.Errorf("config layer %d: %w", i+1, err)
		}
		if len(nodes) != 1 || len(nodes[0].Content) != 1 || nodes[0].Content[0].Kind != yaml.MappingNode {
			return result, errors.New("deployment config must contain exactly one mapping document")
		}
		root := nodes[0].Content[0]
		if err := rejectDuplicateKeys(root); err != nil {
			return result, err
		}
		cli, web := nodeMappingValue(root, "cli"), nodeMappingValue(root, "web")
		if cli == nil && web == nil {
			continue
		}
		if seen {
			return result, errors.New("cli and web may be set by at most one config layer")
		}
		seen = true
		for name, node := range map[string]*yaml.Node{"cli": cli, "web": web} {
			if node == nil {
				continue
			}
			if node.Kind != yaml.MappingNode {
				return result, fmt.Errorf("%s must be a mapping", name)
			}
			if err := rejectDuplicateKeys(node); err != nil {
				return result, err
			}
			v := nodeMappingValue(node, "version")
			if v == nil || v.Kind != yaml.ScalarNode || v.ShortTag() != "!!str" || !ExactVersion(v.Value) {
				return result, fmt.Errorf("%s.version must be exact MAJOR.MINOR.PATCH", name)
			}
			if name == "cli" {
				result.CLI = &ComponentVersion{Version: v.Value}
			} else {
				result.Web = &ComponentVersion{Version: v.Value}
			}
		}
	}
	return result, nil
}
