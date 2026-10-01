// Package fulltext builds the provider-neutral, versioned static search projection.
package fulltext

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"sort"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

const Shards = 128

type Record struct{ Path, Text string }
type ObjectRef struct {
	URL      string `json:"url"`
	SHA256   string `json:"sha256"`
	Bytes    int    `json:"bytes"`
	RawBytes int    `json:"rawBytes"`
}
type Manifest struct {
	Generation string       `json:"generation"`
	Version    int          `json:"version"`
	Site       string       `json:"site"`
	Documents  int          `json:"documents"`
	Root       ObjectRef    `json:"root"`
	Shards     []*ObjectRef `json:"shards"`
}
type Projection struct {
	Files    map[string][]byte
	Manifest Manifest
}

// Normalize mirrors ECMAScript NFKC + toLowerCase + whitespace folding.
func Normalize(text string) string {
	text = cases.Lower(language.Und).String(norm.NFKC.String(text))
	return strings.Join(strings.FieldsFunc(text, func(r rune) bool {
		return (r >= 9 && r <= 13) || r == 32 || r == 0xa0 || r == 0x1680 ||
			(r >= 0x2000 && r <= 0x200a) || r == 0x2028 || r == 0x2029 ||
			r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
	}), " ")
}

// ExtractText includes static body text, preserving inline continuity. It does
// not execute scripts or infer CSS visibility. Publishers can mark exclusions
// explicitly with hidden, aria-hidden=true, or data-search-ignore.
func ExtractText(document *html.Node) string {
	var out strings.Builder
	var visit func(*html.Node)
	visit = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "head", "script", "style", "template", "noscript":
				return
			}
			for _, a := range n.Attr {
				if a.Key == "hidden" || a.Key == "data-search-ignore" || (a.Key == "aria-hidden" && strings.EqualFold(a.Val, "true")) {
					return
				}
			}
		}
		block := n.Type == html.ElementNode && strings.Contains("|p|div|section|article|main|nav|header|footer|aside|h1|h2|h3|h4|h5|h6|li|ul|ol|pre|blockquote|table|tr|td|th|br|hr|", "|"+n.Data+"|")
		if block {
			out.WriteByte(' ')
		}
		if n.Type == html.TextNode {
			out.WriteString(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			visit(c)
		}
		if block {
			out.WriteByte(' ')
		}
	}
	visit(document)
	return Normalize(out.String())
}

type writer []byte

func (w *writer) uint(n int) { *w = binary.AppendUvarint(*w, uint64(n)) }
func (w *writer) front(value, previous string) {
	prefix := 0
	for prefix < len(value) && prefix < len(previous) && value[prefix] == previous[prefix] {
		prefix++
	}
	w.uint(prefix)
	w.uint(len(value) - prefix)
	*w = append(*w, value[prefix:]...)
}
func shard(token string) int {
	h := fnv.New32a()
	h.Write([]byte(token))
	return int(h.Sum32() % Shards)
}

// Posting modes match the browser codec: delta, bitmap, runs, complement, all.
// Choose the shortest raw representation, then gzip the whole leaf so shared
// patterns across lists remain compressible. Equal lists are interned per leaf.
func posting(values []int, documents int) []byte {
	wrap := func(mode int, payload []byte) []byte {
		var w writer
		w.uint(mode)
		w.uint(len(values))
		return append(w, payload...)
	}
	delta := func(v []int) []byte {
		var w writer
		previous := 0
		for _, n := range v {
			w.uint(n - previous)
			previous = n
		}
		return w
	}
	best := wrap(0, delta(values))
	choose := func(v []byte) {
		if len(v) < len(best) {
			best = v
		}
	}
	if len(values) == documents {
		choose(wrap(4, nil))
		return best
	}
	// Avoid allocating a dense bitmap for a sparse posting.
	if (documents+7)/8 < len(best) {
		bitmap := make([]byte, (documents+7)/8)
		for _, n := range values {
			bitmap[n/8] |= 1 << uint(n%8)
		}
		choose(wrap(1, bitmap))
	}
	type run struct{ start, length int }
	runs := []run{}
	for _, n := range values {
		if len(runs) > 0 && runs[len(runs)-1].start+runs[len(runs)-1].length == n {
			runs[len(runs)-1].length++
		} else {
			runs = append(runs, run{n, 1})
		}
	}
	var r writer
	r.uint(len(runs))
	end := 0
	for _, v := range runs {
		r.uint(v.start - end)
		r.uint(v.length)
		end = v.start + v.length
	}
	choose(wrap(2, r))
	if len(values) > documents/2 {
		absent := []int{}
		p := 0
		for n := 0; n < documents; n++ {
			if p < len(values) && values[p] == n {
				p++
			} else {
				absent = append(absent, n)
			}
		}
		choose(wrap(3, delta(absent)))
	}
	return best
}

// Build uses path order as stable result order, independent of input order.
// All blobs are gzip files hashed over their compressed bytes. The one mutable
// manifest is published after its blobs; clients pin one manifest per search.
func Build(ctx context.Context, site string, input []Record) (Projection, error) {
	records := append([]Record(nil), input...)
	sort.Slice(records, func(i, j int) bool { return records[i].Path < records[j].Path })
	postings := make(map[string][]int)
	for doc, r := range records {
		if err := ctx.Err(); err != nil {
			return Projection{}, err
		}
		if doc > 0 && records[doc-1].Path == r.Path {
			return Projection{}, fmt.Errorf("duplicate search path %q", r.Path)
		}
		seen := make(map[string]bool)
		for _, token := range strings.Split(Normalize(r.Text), " ") {
			if token != "" && !seen[token] {
				seen[token] = true
				postings[token] = append(postings[token], doc)
			}
		}
	}
	tokens := make([]string, 0, len(postings))
	for token := range postings {
		tokens = append(tokens, token)
	}
	sort.Strings(tokens)
	type leaf struct {
		tokens []string
		ids    []int
		lists  [][]byte
		intern map[string]int
	}
	leaves := make([]leaf, Shards)
	for i := range leaves {
		leaves[i].intern = make(map[string]int)
	}
	var root writer
	root = append(root, []byte("GAPSR1")...)
	root.uint(len(records))
	root.uint(len(tokens))
	previous := ""
	for _, token := range tokens {
		if err := ctx.Err(); err != nil {
			return Projection{}, err
		}
		root.front(token, previous)
		previous = token
		values := postings[token]
		if len(values) == 1 {
			root.uint(values[0] + 1)
			continue
		}
		root.uint(0)
		l := &leaves[shard(token)]
		packed := posting(values, len(records))
		key := string(packed)
		id, found := l.intern[key]
		if !found {
			id = len(l.lists)
			l.intern[key] = id
			l.lists = append(l.lists, packed)
		}
		l.tokens = append(l.tokens, token)
		l.ids = append(l.ids, id)
	}
	// Front-code paths instead of the research prototype's JSON path table.
	previous = ""
	for _, r := range records {
		root.front(r.Path, previous)
		previous = r.Path
	}
	p := Projection{Files: make(map[string][]byte), Manifest: Manifest{Version: 1, Site: site, Documents: len(records), Shards: make([]*ObjectRef, Shards)}}
	add := func(kind string, raw []byte) (ObjectRef, error) {
		var compressed bytes.Buffer
		z, _ := gzip.NewWriterLevel(&compressed, gzip.BestCompression)
		if _, err := z.Write(raw); err != nil {
			return ObjectRef{}, err
		}
		if err := z.Close(); err != nil {
			return ObjectRef{}, err
		}
		data := compressed.Bytes()
		sum := sha256.Sum256(data)
		hash := hex.EncodeToString(sum[:])
		name := kind + "-" + hash + ".gz"
		p.Files[name] = data
		return ObjectRef{URL: "/_indexes/" + site + "/search/" + name, SHA256: hash, Bytes: len(data), RawBytes: len(raw)}, nil
	}
	var err error
	p.Manifest.Root, err = add("root", root)
	if err != nil {
		return Projection{}, err
	}
	for i, l := range leaves {
		if len(l.tokens) == 0 {
			continue
		}
		if err := ctx.Err(); err != nil {
			return Projection{}, err
		}
		var w writer
		w = append(w, []byte("GAPSL1")...)
		w.uint(len(records))
		w.uint(len(l.tokens))
		previous = ""
		for j, token := range l.tokens {
			w.front(token, previous)
			previous = token
			w.uint(l.ids[j])
		}
		w.uint(len(l.lists))
		for _, list := range l.lists {
			w.uint(len(list))
			w = append(w, list...)
		}
		ref, err := add("leaf", w)
		if err != nil {
			return Projection{}, err
		}
		p.Manifest.Shards[i] = &ref
	}
	identity, err := json.Marshal(p.Manifest)
	if err != nil {
		return Projection{}, err
	}
	sum := sha256.Sum256(identity)
	p.Manifest.Generation = hex.EncodeToString(sum[:])
	data, err := json.Marshal(p.Manifest)
	if err != nil {
		return Projection{}, err
	}
	p.Files["manifest.json"] = append(data, '\n')
	return p, nil
}
