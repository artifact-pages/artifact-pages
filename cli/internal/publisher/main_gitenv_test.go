package publisher

import (
	"os"
	"testing"

	"github.com/artifact-pages/artifact-pages/cli/internal/gittestenv"
)

func TestMain(m *testing.M) {
	gittestenv.Apply()
	_ = os.Unsetenv("GITHUB_TOKEN")
	_ = os.Unsetenv("GH_TOKEN")
	os.Exit(m.Run())
}
