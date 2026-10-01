package publisher

import (
	"fmt"
	"reflect"
	"testing"
)

func TestAWSSiteInvalidationCompactsUnsupportedAndBulkPaths(t *testing.T) {
	for _, special := range []string{"backup~.css", "backup%7E.css", "literal%2A.css"} {
		input := []string{"/_artifacts/sre/" + special, "/_artifacts/sre/report.html", "/_artifacts/docs/keep.html", "/_indexes/sre/index.json", "/_indexes/sre/meta.json"}
		want := []string{"/_artifacts/docs/keep.html", "/_artifacts/sre/*", "/_indexes/sre/index.json", "/_indexes/sre/meta.json"}
		if got := awsSiteInvalidationPaths(input); !reflect.DeepEqual(got, want) {
			t.Fatalf("special %s: paths=%v, want=%v", special, got, want)
		}
	}
	paths := []string{"/_indexes/sre/index.json", "/_indexes/sre/meta.json"}
	for i := 0; i < 20000; i++ {
		paths = append(paths, fmt.Sprintf("/_artifacts/sre/%d.html", i))
	}
	want := []string{"/_artifacts/sre/*", "/_indexes/sre/index.json", "/_indexes/sre/meta.json"}
	if got := awsSiteInvalidationPaths(paths); !reflect.DeepEqual(got, want) {
		t.Fatalf("bulk paths=%v, want=%v", got, want)
	}
	ordinary := []string{"/_artifacts/sre/report.html", "/_indexes/sre/index.json"}
	if got := awsSiteInvalidationPaths(ordinary); !reflect.DeepEqual(got, ordinary) {
		t.Fatalf("ordinary exact paths changed: %v", got)
	}
}

func TestSiteCachePathsIncludeRelativeResourceSpelling(t *testing.T) {
	got := siteCachePaths("sre", []Change{{Action: "update", Path: "_artifacts/sre/logo!.svg"}}, nil, nil)
	want := []string{"/_artifacts/sre/logo!.svg", "/_artifacts/sre/logo%21.svg"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("resource paths=%v, want=%v", got, want)
	}
	b := newLockMemoryBackend()
	if err := writeSiteCacheRetry(t.Context(), b, "sre", got, ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readSiteCacheRetry(t.Context(), b, "sre"); err != nil {
		t.Fatalf("relative resource retry rejected: %v", err)
	}
}
