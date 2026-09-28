package preview

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
	html "golang.org/x/net/html"
)

var (
	cssURLPattern    = regexp.MustCompile(`(?is)url\(\s*['"]?([^'")]+)['"]?\s*\)`)
	cssImportPattern = regexp.MustCompile(`(?is)@import\s+['"]([^'"]+)['"]`)
	jsImportPattern  = regexp.MustCompile(`(?m)\b(import|export)\b[^;\n]*?['"]([^'"\n]+)['"]`)
)

func isDocumentPath(value string) bool { return documentFormat(value) != "" }

func collectResources(ctx context.Context, repoRoot string, tree map[string]treeEntry, files map[string][]byte, initial []string) error {
	queue := append([]string(nil), initial...)
	sort.Strings(queue)
	queued := make(map[string]bool, len(queue))
	visited := make(map[string]bool, len(queue))
	for _, resource := range queue {
		queued[resource] = true
	}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if visited[current] {
			continue
		}
		visited[current] = true
		content, alreadyCopied := files[current]
		if !alreadyCopied {
			entry, exists := tree[current]
			if !exists {
				return fmt.Errorf("preview resource %q is missing from the source head tree", current)
			}
			if isDocumentPath(current) {
				return fmt.Errorf("preview resource %q is a document; unchanged documents cannot be included as resources", current)
			}
			var err error
			content, err = readTreeBlob(ctx, repoRoot, entry)
			if err != nil {
				return err
			}
			files[current] = content
		}
		for _, reference := range localReferences(current, content) {
			target, ok, err := resolveLocalResource(current, reference)
			if err != nil {
				return fmt.Errorf("resource reference in %q: %w", current, err)
			}
			if !ok {
				continue
			}
			if !queued[target] {
				queued[target] = true
				queue = append(queue, target)
			}
		}
	}
	return nil
}

func localReferences(from string, content []byte) []string {
	var references []string
	switch strings.ToLower(path.Ext(from)) {
	case ".md":
		doc := goldmark.DefaultParser().Parse(text.NewReader(content))
		_ = ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
			if !entering {
				return ast.WalkContinue, nil
			}
			if image, ok := node.(*ast.Image); ok {
				references = append(references, string(image.Destination))
			}
			return ast.WalkContinue, nil
		})
	case ".html", ".htm", ".xhtml", ".svg":
		root, err := html.Parse(bytes.NewReader(content))
		if err != nil {
			break
		}
		var visit func(*html.Node)
		visit = func(node *html.Node) {
			if node.Type == html.ElementNode {
				for _, attribute := range node.Attr {
					name, value := strings.ToLower(attribute.Key), strings.TrimSpace(attribute.Val)
					if name == "style" {
						references = append(references, cssReferences(value)...)
					}
					if name == "src" || name == "poster" || name == "data" {
						switch strings.ToLower(node.Data) {
						case "img", "script", "source", "video", "audio", "track", "input", "embed", "object", "iframe":
							references = append(references, value)
						}
					}
					if name == "srcset" && (strings.EqualFold(node.Data, "img") || strings.EqualFold(node.Data, "source")) {
						for _, candidate := range strings.Split(value, ",") {
							if parts := strings.Fields(strings.TrimSpace(candidate)); len(parts) > 0 {
								references = append(references, parts[0])
							}
						}
					}
					if name == "href" && strings.EqualFold(node.Data, "link") && isResourceLinkRel(attributeValue(node.Attr, "rel"), attributeValue(node.Attr, "as")) {
						references = append(references, value)
					}
					if name == "href" && (strings.EqualFold(node.Data, "image") || strings.EqualFold(node.Data, "use")) {
						references = append(references, value)
					}
				}
				if node.Data == "style" {
					references = append(references, cssReferences(textContent(node))...)
				}
			}
			for child := node.FirstChild; child != nil; child = child.NextSibling {
				visit(child)
			}
		}
		visit(root)
	case ".css":
		references = append(references, cssReferences(string(content))...)
	case ".js", ".mjs", ".cjs":
		for _, match := range jsImportPattern.FindAllSubmatch(content, -1) {
			references = append(references, string(match[2]))
		}
	}
	return uniqueStrings(references)
}

func cssReferences(content string) []string {
	var references []string
	for _, match := range cssURLPattern.FindAllStringSubmatch(content, -1) {
		candidate := strings.TrimSpace(match[1])
		if candidate != "" {
			references = append(references, candidate)
		}
	}
	for _, match := range cssImportPattern.FindAllStringSubmatch(content, -1) {
		if candidate := strings.TrimSpace(match[1]); candidate != "" {
			references = append(references, candidate)
		}
	}
	return references
}

func resolveLocalResource(from, reference string) (string, bool, error) {
	reference = strings.TrimSpace(reference)
	if reference == "" || strings.HasPrefix(reference, "#") || strings.HasPrefix(reference, "//") {
		return "", false, nil
	}
	parsed, err := url.Parse(reference)
	if err != nil {
		return "", false, fmt.Errorf("invalid URL %q: %w", reference, err)
	}
	if parsed.Scheme != "" || parsed.Host != "" || parsed.Path == "" {
		return "", false, nil
	}
	if strings.HasPrefix(parsed.Path, "/") {
		return "", false, fmt.Errorf("root-relative resource %q cannot resolve inside a revision bundle; use a path relative to the document", reference)
	}
	decoded, err := url.PathUnescape(parsed.EscapedPath())
	if err != nil {
		return "", false, fmt.Errorf("invalid escaped path %q: %w", reference, err)
	}
	if strings.Contains(decoded, `\`) {
		return "", false, fmt.Errorf("resource path %q contains a backslash", reference)
	}
	resolved := path.Clean(path.Join(path.Dir(from), decoded))
	if err := validateSourcePath(resolved); err != nil {
		return "", false, fmt.Errorf("resource path %q escapes the source tree: %w", reference, err)
	}
	return resolved, true, nil
}

func isResourceLinkRel(rel, as string) bool {
	for _, token := range strings.Fields(strings.ToLower(rel)) {
		if token == "stylesheet" || token == "icon" || token == "manifest" {
			return true
		}
		if token == "preload" {
			switch strings.ToLower(as) {
			case "style", "script", "font", "image", "fetch":
				return true
			}
		}
	}
	return false
}

func attributeValue(attributes []html.Attribute, name string) string {
	for _, attribute := range attributes {
		if strings.EqualFold(attribute.Key, name) {
			return attribute.Val
		}
	}
	return ""
}

func textContent(node *html.Node) string {
	var value strings.Builder
	var visit func(*html.Node)
	visit = func(current *html.Node) {
		if current.Type == html.TextNode {
			value.WriteString(current.Data)
		}
		for child := current.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
	}
	visit(node)
	return value.String()
}

func extractDocument(filePath string, content []byte) Document {
	title := ""
	format := documentFormat(filePath)
	if format == "markdown" {
		doc := goldmark.DefaultParser().Parse(text.NewReader(content))
		_ = ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
			if !entering || title != "" {
				return ast.WalkContinue, nil
			}
			heading, ok := node.(*ast.Heading)
			if ok && heading.Level == 1 {
				title = strings.TrimSpace(string(heading.Text(content)))
				if title == "" {
					title = strings.TrimSpace(string(heading.Text(content)))
				}
			}
			return ast.WalkContinue, nil
		})
	} else if format == "html" {
		if root, err := html.Parse(bytes.NewReader(content)); err == nil {
			var findTitle func(*html.Node)
			findTitle = func(node *html.Node) {
				if title != "" {
					return
				}
				if node.Type == html.ElementNode && node.Data == "title" {
					title = strings.TrimSpace(textContent(node))
					return
				}
				for child := node.FirstChild; child != nil; child = child.NextSibling {
					findTitle(child)
				}
			}
			findTitle(root)
		}
	}
	if title == "" {
		name := strings.TrimSuffix(path.Base(filePath), path.Ext(filePath))
		title = strings.TrimSpace(strings.NewReplacer("-", " ", "_", " ").Replace(name))
	}
	if title == "" {
		title = filePath
	}
	return Document{Path: filePath, Title: title, Format: format}
}

func contentTypeFor(filePath string) string {
	extension := strings.ToLower(path.Ext(filePath))
	known := map[string]string{
		".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8",
		".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
		".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
		".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".pdf": "application/pdf",
		".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".wasm": "application/wasm",
		".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".ogg": "audio/ogg",
	}
	if value, ok := known[extension]; ok {
		return value
	}
	return "application/octet-stream"
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}
