// Research-only text extraction; does not change the production index contract.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	goldmarkhtml "github.com/yuin/goldmark/renderer/html"
	"golang.org/x/net/html"
)

type record struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

func main() {
	var records []record
	markdown := goldmark.New(goldmark.WithExtensions(extension.GFM), goldmark.WithRendererOptions(goldmarkhtml.WithUnsafe()))
	for _, root := range os.Args[1:] {
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return nil
			}
			ext := strings.ToLower(filepath.Ext(path))
			if ext != ".html" && ext != ".htm" && ext != ".md" {
				return nil
			}
			if !entry.Type().IsRegular() {
				return fmt.Errorf("not a regular file: %s", path)
			}
			source, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if ext == ".md" {
				var rendered bytes.Buffer
				if err := markdown.Convert(source, &rendered); err != nil {
					return err
				}
				source = rendered.Bytes()
			}
			doc, err := html.Parse(bytes.NewReader(source))
			if err != nil {
				return err
			}
			var text strings.Builder
			var visit func(*html.Node)
			visit = func(node *html.Node) {
				if node.Type == html.ElementNode {
					switch node.Data {
					case "head", "script", "style", "template", "noscript":
						return
					}
					for _, attr := range node.Attr {
						if attr.Key == "hidden" || (attr.Key == "aria-hidden" && attr.Val == "true") || attr.Key == "data-search-ignore" {
							return
						}
					}
				}
				if node.Type == html.TextNode {
					text.WriteString(node.Data)
				}
				// Separate blocks while retaining inline word/phrase continuity.
				block := node.Type == html.ElementNode && strings.Contains("|p|div|section|article|main|nav|header|footer|aside|h1|h2|h3|h4|h5|h6|li|ul|ol|pre|blockquote|table|tr|td|th|br|hr|", "|"+node.Data+"|")
				if block {
					text.WriteByte(' ')
				}
				for child := node.FirstChild; child != nil; child = child.NextSibling {
					visit(child)
				}
				if block {
					text.WriteByte(' ')
				}
			}
			visit(doc)
			records = append(records, record{filepath.ToSlash(path), strings.Join(strings.Fields(text.String()), " ")})
			return nil
		})
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(records); err != nil {
		panic(err)
	}
}
