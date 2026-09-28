// Package githubrepo contains shared validation for GitHub repository names.
package githubrepo

import "strings"

// ValidRepositoryName reports whether name is a canonical repository name
// component. It deliberately validates only the repository name, not its
// owner. The .git suffix is excluded because product locators use owner/repo,
// not clone URL spellings.
func ValidRepositoryName(name string) bool {
	if len(name) == 0 || len(name) > 100 || name == "." || name == ".." {
		return false
	}
	if strings.HasSuffix(strings.ToLower(name), ".git") {
		return false
	}
	for _, character := range []byte(name) {
		if (character >= 'A' && character <= 'Z') ||
			(character >= 'a' && character <= 'z') ||
			(character >= '0' && character <= '9') ||
			character == '_' || character == '.' || character == '-' {
			continue
		}
		return false
	}
	return true
}
