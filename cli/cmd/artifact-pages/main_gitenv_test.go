package main

import (
	"os"
	"testing"

	"github.com/artifact-pages/artifact-pages/cli/internal/gittestenv"
)

func TestMain(m *testing.M) {
	gittestenv.Apply()
	os.Exit(m.Run())
}
