// Package compat implements the reader rules for published data and control
// records (docs/backlog/technical-design/TD2): readers ignore unknown fields,
// and an unknown schemaVersion fails with a message that names the situation
// and the required action.
package compat

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/artifact-pages/artifact-pages/cli/internal/version"
)

// UnsupportedSchemaError reports data in a format this CLI cannot read.
type UnsupportedSchemaError struct {
	Format    string
	Found     int
	Supported int
}

func (err *UnsupportedSchemaError) Error() string {
	if err.Found > err.Supported {
		return fmt.Sprintf("%s has schemaVersion %d, but this CLI (version %s) reads schemaVersion %d: it was written by a newer major version of Artifact Pages. Upgrade the CLI to that release and follow the upgrade procedure in its release notes (registry sync, app deploy, then sync every site)",
			err.Format, err.Found, version.Product, err.Supported)
	}
	return fmt.Sprintf("%s has schemaVersion %d, but this CLI (version %s) reads schemaVersion %d: it was written by an older, no longer supported version. Republish it with this CLI, or use the older CLI release that matches the data",
		err.Format, err.Found, version.Product, err.Supported)
}

// CheckSchemaVersion peeks at the schemaVersion of a JSON document without
// validating anything else, so a document in a newer format is reported as
// unsupported rather than as a decoding error. Documents that are not JSON
// objects, or that lack an integer schemaVersion, are left to the caller's
// ordinary validation.
func CheckSchemaVersion(format string, data []byte, supported int) error {
	var peek struct {
		SchemaVersion *json.Number `json:"schemaVersion"`
	}
	if err := json.Unmarshal(data, &peek); err != nil || peek.SchemaVersion == nil {
		return nil
	}
	found, err := peek.SchemaVersion.Int64()
	if err != nil || found == int64(supported) {
		return nil
	}
	return &UnsupportedSchemaError{Format: format, Found: int(found), Supported: supported}
}

// Is reports whether err is an UnsupportedSchemaError.
func Is(err error) bool {
	var target *UnsupportedSchemaError
	return errors.As(err, &target)
}
