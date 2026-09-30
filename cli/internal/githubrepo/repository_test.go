package githubrepo

import (
	"strings"
	"testing"
)

func TestValidRepositoryName(t *testing.T) {
	for _, name := range []string{".github", "platform.config", "123project", strings.Repeat("a", 100)} {
		if !ValidRepositoryName(name) {
			t.Errorf("ValidRepositoryName(%q) = false, want true", name)
		}
	}

	for _, name := range []string{"", ".", "..", strings.Repeat("a", 101), "bad/name", "bad\\name", "bad name", "bad?name", "name.git", "name.GIT", "名前"} {
		if ValidRepositoryName(name) {
			t.Errorf("ValidRepositoryName(%q) = true, want false", name)
		}
	}
}
