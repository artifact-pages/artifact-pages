package compat

import (
	"errors"
	"strings"
	"testing"
)

func TestCheckSchemaVersion(t *testing.T) {
	for _, ok := range []string{`{"schemaVersion":1}`, `{"schemaVersion":1,"extra":[1]}`, `{}`, `[]`, `not json`, `{"schemaVersion":"x"}`, `{"schemaVersion":1.5}`} {
		if err := CheckSchemaVersion("thing", []byte(ok), 1); err != nil {
			t.Errorf("CheckSchemaVersion(%s) = %v, want nil (left to ordinary validation)", ok, err)
		}
	}
	err := CheckSchemaVersion("thing", []byte(`{"schemaVersion":2,"shape":"new"}`), 1)
	var unsupported *UnsupportedSchemaError
	if !errors.As(err, &unsupported) || unsupported.Found != 2 || !Is(err) {
		t.Fatalf("v2 error = %v", err)
	}
	for _, want := range []string{"thing", "schemaVersion 2", "newer major version", "Upgrade the CLI", "upgrade procedure"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("newer-version message %q lacks %q", err, want)
		}
	}
	older := CheckSchemaVersion("thing", []byte(`{"schemaVersion":0}`), 1)
	if older == nil || !strings.Contains(older.Error(), "older") {
		t.Fatalf("older-version message = %v", older)
	}
}
