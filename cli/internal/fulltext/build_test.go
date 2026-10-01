package fulltext

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"reflect"
	"strings"
	"testing"

	"golang.org/x/net/html"
)

func TestStaticBodyExtractionAndNormalization(t *testing.T) {
	doc, err := html.Parse(strings.NewReader(`<head><title>excluded</title><style>excluded</style></head><body><p>Ｃａｃｈｅ re<span>try</span> &amp; 再試行</p><p hidden>hidden</p><p aria-hidden="TRUE">hidden</p><p data-search-ignore>hidden</p><script>runtime</script><template>template</template><noscript>fallback</noscript><div>Second<br>line</div></body>`))
	if err != nil {
		t.Fatal(err)
	}
	if got := ExtractText(doc); got != "cache retry & 再試行 second line" {
		t.Fatalf("extraction = %q", got)
	}
	for _, pair := range [][2]string{{"ΟΣ İ K Ａ", "ος i\u0307 k a"}, {"A\ufeffB\u0085C", "a b\u0085c"}, {"ｶﾀｶﾅ\u3000再試行", "カタカナ 再試行"}} {
		if got := Normalize(pair[0]); got != pair[1] {
			t.Errorf("Normalize(%q) = %q; want %q", pair[0], got, pair[1])
		}
	}
}

func TestProjectionIsDeterministicAndContentAddressed(t *testing.T) {
	records := []Record{{"b.md", "cache retry"}, {"a 日本.html", "cache rare"}, {"empty.html", ""}}
	a, err := Build(context.Background(), "sre", records)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Build(context.Background(), "sre", []Record{records[2], records[1], records[0]})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, b) {
		t.Fatal("input order changed projection")
	}
	check := func(ref ObjectRef) {
		name := strings.TrimPrefix(ref.URL, "/_indexes/sre/search/")
		data := a.Files[name]
		sum := sha256.Sum256(data)
		if ref.Bytes != len(data) || ref.SHA256 != hex.EncodeToString(sum[:]) {
			t.Fatalf("invalid reference %+v", ref)
		}
	}
	check(a.Manifest.Root)
	for _, ref := range a.Manifest.Shards {
		if ref != nil {
			check(*ref)
		}
	}
	if len(a.Manifest.Shards) != 128 || a.Manifest.Documents != 3 {
		t.Fatal("invalid manifest")
	}
	empty, err := Build(context.Background(), "sre", nil)
	if err != nil || empty.Manifest.Documents != 0 || len(empty.Files) != 2 {
		t.Fatalf("empty projection = %+v, %v", empty, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Build(ctx, "sre", records); err == nil {
		t.Fatal("cancelled build succeeded")
	}
	if _, err := Build(context.Background(), "sre", []Record{records[0], records[0]}); err == nil {
		t.Fatal("duplicate paths accepted")
	}
}

func TestGenerationChangesWhenOnlyPostingsChange(t *testing.T) {
	a, err := Build(context.Background(), "sre", []Record{{"a.html", "common x"}, {"b.html", "common x"}, {"c.html", "common y"}, {"d.html", "common y"}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := Build(context.Background(), "sre", []Record{{"a.html", "common y"}, {"b.html", "common x"}, {"c.html", "common x"}, {"d.html", "common y"}})
	if err != nil {
		t.Fatal(err)
	}
	if a.Manifest.Root != b.Manifest.Root {
		t.Fatal("posting-only update unexpectedly changed root")
	}
	if a.Manifest.Generation == b.Manifest.Generation {
		t.Fatal("generation does not cover leaf updates")
	}
}
