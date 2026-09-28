package preview

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/tdewolff/parse/v2"
	jsparser "github.com/tdewolff/parse/v2/js"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
	html "golang.org/x/net/html"
)

var (
	cssURLPattern      = regexp.MustCompile(`(?is)url\(\s*['"]?([^'")]+)['"]?\s*\)`)
	cssImportPattern   = regexp.MustCompile(`(?is)@import\s+['"]([^'"]+)['"]`)
	jsMultiPunctuators = []string{
		"===", "!==", ">>>", "...", "=>", "==", "!=", "<=", ">=", "++", "--", "&&", "||", "??", "?.", "**", "<<", ">>",
		"+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
	}
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
		rawHTMLByBlock := make(map[ast.Node][]byte)
		var rawHTMLBlocks []ast.Node
		_ = ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
			if !entering {
				return ast.WalkContinue, nil
			}
			if image, ok := node.(*ast.Image); ok {
				references = append(references, string(image.Destination))
			}
			switch node := node.(type) {
			case *ast.RawHTML:
				block := markdownInlineBlock(node)
				if block == nil {
					references = append(references, markdownHTMLImageReferences(node.Text(content))...)
					break
				}
				if _, exists := rawHTMLByBlock[block]; !exists {
					rawHTMLBlocks = append(rawHTMLBlocks, block)
				}
				rawHTMLByBlock[block] = append(rawHTMLByBlock[block], ' ')
				rawHTMLByBlock[block] = append(rawHTMLByBlock[block], node.Text(content)...)
			case *ast.HTMLBlock:
				references = append(references, markdownHTMLImageReferences(node.Text(content))...)
			}
			return ast.WalkContinue, nil
		})
		for _, block := range rawHTMLBlocks {
			references = append(references, markdownHTMLImageReferences(rawHTMLByBlock[block])...)
		}
	case ".html", ".htm", ".xhtml", ".svg":
		root, err := html.Parse(bytes.NewReader(content))
		if err != nil {
			break
		}
		var visit func(*html.Node)
		visit = func(node *html.Node) {
			if node.Type == html.ElementNode {
				if strings.EqualFold(node.Data, "script") &&
					isHTMLModuleScriptType(attributeValue(node.Attr, "type")) &&
					!hasHTMLAttribute(node.Attr, "src") {
					references = append(references, javascriptModuleReferences([]byte(textContent(node)))...)
				}
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
		references = append(references, javascriptModuleReferences(content)...)
	}
	return uniqueStrings(references)
}

func markdownInlineBlock(node ast.Node) ast.Node {
	for parent := node.Parent(); parent != nil; parent = parent.Parent() {
		switch parent.(type) {
		case *ast.Paragraph, *ast.Heading:
			return parent
		}
	}
	return nil
}

// markdownHTMLImageReferences follows the rendered image subset allowed by
// the Markdown sanitizer: img[src] and picture-contained source[srcset]. Other
// HTML resource attributes are intentionally excluded from the bundle.
func markdownHTMLImageReferences(source []byte) []string {
	root, err := html.Parse(bytes.NewReader(source))
	if err != nil {
		return nil
	}
	var references []string
	var visit func(*html.Node, bool)
	visit = func(node *html.Node, insidePicture bool) {
		insidePicture = insidePicture || node.Type == html.ElementNode && strings.EqualFold(node.Data, "picture")
		if node.Type == html.ElementNode {
			switch strings.ToLower(node.Data) {
			case "img":
				if value := attributeValue(node.Attr, "src"); value != "" {
					references = append(references, value)
				}
			case "source":
				if !insidePicture {
					break
				}
				for _, attribute := range node.Attr {
					if strings.EqualFold(attribute.Key, "srcset") {
						references = append(references, sourceSetReferences(attribute.Val)...)
					}
				}
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			visit(child, insidePicture)
		}
	}
	visit(root, false)
	return references
}

// sourceSetReferences reads candidate URLs without splitting commas inside
// data URLs. HTML requires whitespace before descriptors; a trailing comma
// on a URL token ends a descriptor-free candidate.
func sourceSetReferences(value string) []string {
	var references []string
	for index := 0; index < len(value); {
		for index < len(value) && (isHTMLSpace(value[index]) || value[index] == ',') {
			index++
		}
		if index >= len(value) {
			break
		}

		start := index
		for index < len(value) && !isHTMLSpace(value[index]) {
			index++
		}
		candidate := value[start:index]
		trimmed := strings.TrimRight(candidate, ",")
		if trimmed != candidate {
			if trimmed != "" {
				references = append(references, trimmed)
			}
			continue
		}
		if candidate != "" {
			references = append(references, candidate)
		}

		for index < len(value) && value[index] != ',' {
			index++
		}
		if index < len(value) {
			index++
		}
	}
	return references
}

func isHTMLSpace(value byte) bool {
	switch value {
	case '\t', '\n', '\f', '\r', ' ':
		return true
	default:
		return false
	}
}

type jsModuleTokenKind uint8

const (
	jsIdentifierToken jsModuleTokenKind = iota
	jsStringToken
	jsNumberToken
	jsPunctuatorToken
	jsOpaqueToken
)

type jsModuleToken struct {
	kind            jsModuleTokenKind
	value           string
	lineBreakBefore bool
}

// javascriptModuleReferences recognizes static imports and re-exports from
// the module AST. Invalid or newer syntax falls back to the tolerant scanner
// so resource collection does not become a JavaScript syntax validator.
func javascriptModuleReferences(source []byte) []string {
	if references, err := parsedJavaScriptModuleReferences(source); err == nil {
		return uniqueStrings(references)
	}
	return lexJavaScriptModuleReferences(source)
}

func parsedJavaScriptModuleReferences(source []byte) ([]string, error) {
	module, err := jsparser.Parse(parse.NewInputBytes(source), jsparser.Options{})
	if err != nil {
		return nil, err
	}
	var references []string
	for _, statement := range module.BlockStmt.List {
		switch statement := statement.(type) {
		case *jsparser.ImportStmt:
			if reference, ok := decodeJavaScriptStringLiteral(statement.Module); ok {
				references = append(references, reference)
			}
		case *jsparser.ExportStmt:
			if reference, ok := decodeJavaScriptStringLiteral(statement.Module); ok {
				references = append(references, reference)
			}
		}
	}
	return references, nil
}

func decodeJavaScriptStringLiteral(source []byte) (string, bool) {
	if len(source) == 0 {
		return "", false
	}
	value, next, ok := scanJSStringLiteral(source, 0)
	return value, ok && next == len(source)
}

// lexJavaScriptModuleReferences is a tolerant fallback for syntax that the
// module parser does not yet accept. It recognizes only static declarations.
func lexJavaScriptModuleReferences(source []byte) []string {
	tokens := lexJavaScriptModuleTokens(source)
	var references []string
	for index, token := range tokens {
		if token.kind != jsIdentifierToken {
			continue
		}
		switch token.value {
		case "import":
			if reference, ok := parseJSImport(tokens, index+1); ok {
				references = append(references, reference)
			}
		case "export":
			if reference, ok := parseJSReExport(tokens, index+1); ok {
				references = append(references, reference)
			}
		}
	}
	return uniqueStrings(references)
}

func parseJSImport(tokens []jsModuleToken, index int) (string, bool) {
	if index >= len(tokens) {
		return "", false
	}
	if tokens[index].kind == jsStringToken {
		return tokens[index].value, true
	}

	switch {
	case tokens[index].kind == jsIdentifierToken:
		// A leading identifier is the default import binding.
		index++
		if !isJSPunctuator(tokens, index, ",") {
			return parseJSFromClause(tokens, index)
		}
		index++
	case isJSPunctuator(tokens, index, "*"):
		if !isJSIdentifier(tokens, index+1, "as") || index+2 >= len(tokens) || tokens[index+2].kind != jsIdentifierToken {
			return "", false
		}
		index += 3
	case isJSPunctuator(tokens, index, "{"):
		closing, ok := matchingJSBrace(tokens, index)
		if !ok {
			return "", false
		}
		index = closing + 1
	default:
		// import.meta and import() are not static module declarations.
		return "", false
	}
	if isJSPunctuator(tokens, index, "*") {
		if !isJSIdentifier(tokens, index+1, "as") || index+2 >= len(tokens) || tokens[index+2].kind != jsIdentifierToken {
			return "", false
		}
		index += 3
	} else if isJSPunctuator(tokens, index, "{") {
		closing, ok := matchingJSBrace(tokens, index)
		if !ok {
			return "", false
		}
		index = closing + 1
	}
	return parseJSFromClause(tokens, index)
}

func parseJSReExport(tokens []jsModuleToken, index int) (string, bool) {
	if isJSPunctuator(tokens, index, "*") {
		index++
		if isJSIdentifier(tokens, index, "as") {
			if index+1 >= len(tokens) || tokens[index+1].kind != jsIdentifierToken {
				return "", false
			}
			index += 2
		}
		return parseJSFromClause(tokens, index)
	}
	if !isJSPunctuator(tokens, index, "{") {
		return "", false
	}
	closing, ok := matchingJSBrace(tokens, index)
	if !ok {
		return "", false
	}
	return parseJSFromClause(tokens, closing+1)
}

func parseJSFromClause(tokens []jsModuleToken, index int) (string, bool) {
	if !isJSIdentifier(tokens, index, "from") || index+1 >= len(tokens) || tokens[index+1].kind != jsStringToken {
		return "", false
	}
	return tokens[index+1].value, true
}

func matchingJSBrace(tokens []jsModuleToken, opening int) (int, bool) {
	depth := 0
	for index := opening; index < len(tokens); index++ {
		if isJSPunctuator(tokens, index, "{") {
			depth++
		} else if isJSPunctuator(tokens, index, "}") {
			depth--
			if depth == 0 {
				return index, true
			}
		}
	}
	return 0, false
}

func isJSIdentifier(tokens []jsModuleToken, index int, value string) bool {
	return index >= 0 && index < len(tokens) && tokens[index].kind == jsIdentifierToken && tokens[index].value == value
}

func isJSPunctuator(tokens []jsModuleToken, index int, value string) bool {
	return index >= 0 && index < len(tokens) && tokens[index].kind == jsPunctuatorToken && tokens[index].value == value
}

func lexJavaScriptModuleTokens(source []byte) []jsModuleToken {
	var tokens []jsModuleToken
	lineBreakBefore := false
	appendToken := func(token jsModuleToken) {
		token.lineBreakBefore = lineBreakBefore
		tokens = append(tokens, token)
		lineBreakBefore = false
	}
	for index := 0; index < len(source); {
		if index == 0 && len(source) >= 2 && source[0] == '#' && source[1] == '!' {
			index = skipJSLineComment(source, index)
			continue
		}
		r, size := utf8.DecodeRune(source[index:])
		if unicode.IsSpace(r) || r == '\uFEFF' {
			lineBreakBefore = lineBreakBefore || isJSLineTerminator(r)
			index += size
			continue
		}
		if source[index] == '/' && index+1 < len(source) {
			switch source[index+1] {
			case '/':
				index = skipJSLineComment(source, index)
				continue
			case '*':
				end := skipJSBlockComment(source, index)
				lineBreakBefore = lineBreakBefore || containsJSLineTerminator(source[index:end])
				index = end
				continue
			}
			if canStartJSRegex(tokens) {
				index = skipJSRegexLiteral(source, index)
				appendToken(jsModuleToken{kind: jsOpaqueToken, value: "regex"})
				continue
			}
		}
		if source[index] == '\'' || source[index] == '"' {
			value, next, ok := scanJSStringLiteral(source, index)
			if ok {
				appendToken(jsModuleToken{kind: jsStringToken, value: value})
			}
			index = max(next, index+1)
			continue
		}
		if source[index] == '`' {
			index = skipJSTemplateLiteral(source, index)
			appendToken(jsModuleToken{kind: jsOpaqueToken, value: "template"})
			continue
		}
		if isJSIdentifierStart(r) {
			start := index
			index += size
			for index < len(source) {
				part, partSize := utf8.DecodeRune(source[index:])
				if !isJSIdentifierPart(part) {
					break
				}
				index += partSize
			}
			appendToken(jsModuleToken{kind: jsIdentifierToken, value: string(source[start:index])})
			continue
		}
		if source[index] >= '0' && source[index] <= '9' {
			start := index
			for index < len(source) {
				c := source[index]
				if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '.') {
					break
				}
				index++
			}
			appendToken(jsModuleToken{kind: jsNumberToken, value: string(source[start:index])})
			continue
		}
		punctuator := readJSPunctuator(source, index)
		appendToken(jsModuleToken{kind: jsPunctuatorToken, value: punctuator})
		index += len(punctuator)
	}
	return tokens
}

func isJSIdentifierStart(r rune) bool {
	return r == '$' || r == '_' || unicode.IsLetter(r) || r == '\u200C' || r == '\u200D'
}

func isJSIdentifierPart(r rune) bool {
	return isJSIdentifierStart(r) || unicode.IsDigit(r) || unicode.In(r, unicode.Mn, unicode.Mc, unicode.Pc)
}

func readJSPunctuator(source []byte, index int) string {
	for _, punctuator := range jsMultiPunctuators {
		if bytes.HasPrefix(source[index:], []byte(punctuator)) {
			return punctuator
		}
	}
	return string(source[index])
}

func canStartJSRegex(tokens []jsModuleToken) bool {
	if len(tokens) == 0 {
		return true
	}
	closing := len(tokens) - 1
	if isJSPunctuator(tokens, closing, ")") && closesJSControlCondition(tokens, closing) {
		return true
	}
	if tokens[closing].kind == jsIdentifierToken && closing > 0 &&
		(isJSPunctuator(tokens, closing-1, ".") || isJSPunctuator(tokens, closing-1, "?.")) {
		// IdentifierName is allowed after member access even when its spelling
		// is normally an operator keyword, as in record.return / 2.
		return false
	}
	if isJSPunctuator(tokens, closing, "}") && closesJSStatementBlock(tokens, closing) {
		return true
	}
	return canStartJSRegexAfter(tokens[len(tokens)-1])
}

func closesJSStatementBlock(tokens []jsModuleToken, closing int) bool {
	depth := 0
	for index := closing; index >= 0; index-- {
		if isJSPunctuator(tokens, index, "}") {
			depth++
		} else if isJSPunctuator(tokens, index, "{") {
			depth--
			if depth != 0 {
				continue
			}
			if index == 0 {
				return true
			}
			if isJSPunctuator(tokens, index-1, ";") || isJSPunctuator(tokens, index-1, "{") ||
				isJSPunctuator(tokens, index-1, "}") {
				return true
			}
			if isJSPunctuator(tokens, index-1, ")") &&
				(closesJSControlCondition(tokens, index-1) || isJSFunctionDeclarationBody(tokens, index)) {
				return true
			}
			if index > 0 && tokens[index-1].kind == jsIdentifierToken {
				switch tokens[index-1].value {
				case "do", "else", "finally", "try":
					return true
				}
			}
			if isJSClassDeclarationBody(tokens, index) {
				return true
			}
			return false
		}
	}
	return false
}

func isJSFunctionDeclarationBody(tokens []jsModuleToken, openingBrace int) bool {
	closingParen := openingBrace - 1
	if !isJSPunctuator(tokens, closingParen, ")") {
		return false
	}
	depth := 0
	openingParen := -1
	for index := closingParen; index >= 0; index-- {
		if isJSPunctuator(tokens, index, ")") {
			depth++
		} else if isJSPunctuator(tokens, index, "(") {
			depth--
			if depth == 0 {
				openingParen = index
				break
			}
		}
	}
	if openingParen < 0 {
		return false
	}
	functionIndex := openingParen - 1
	if functionIndex >= 0 && tokens[functionIndex].kind == jsIdentifierToken && tokens[functionIndex].value != "function" {
		functionIndex--
	}
	if isJSPunctuator(tokens, functionIndex, "*") {
		functionIndex--
	}
	if !isJSIdentifier(tokens, functionIndex, "function") {
		return false
	}
	return isJSStatementStart(tokens, functionIndex)
}

func isJSClassDeclarationBody(tokens []jsModuleToken, openingBrace int) bool {
	for index := openingBrace - 1; index >= 0; index-- {
		if isJSIdentifier(tokens, index, "class") {
			return isJSStatementStart(tokens, index)
		}
		if isJSPunctuator(tokens, index, ";") || isJSPunctuator(tokens, index, "{") ||
			isJSPunctuator(tokens, index, "}") || isJSPunctuator(tokens, index, "=") {
			return false
		}
	}
	return false
}

func isJSStatementStart(tokens []jsModuleToken, index int) bool {
	if index <= 0 {
		return true
	}
	previous := index - 1
	if tokens[index].lineBreakBefore && canEndJSStatement(tokens, previous) {
		return true
	}
	if isJSPunctuator(tokens, previous, ";") || isJSPunctuator(tokens, previous, "{") || isJSPunctuator(tokens, previous, "}") {
		return true
	}
	if isJSPunctuator(tokens, previous, ")") && closesJSControlCondition(tokens, previous) {
		return true
	}
	if isJSIdentifier(tokens, previous, "else") || isJSIdentifier(tokens, previous, "async") || isJSIdentifier(tokens, previous, "export") {
		return isJSStatementStart(tokens, previous)
	}
	if isJSIdentifier(tokens, previous, "default") && isJSIdentifier(tokens, previous-1, "export") {
		return isJSStatementStart(tokens, previous-1)
	}
	return false
}

func canEndJSStatement(tokens []jsModuleToken, index int) bool {
	token := tokens[index]
	if token.kind != jsPunctuatorToken {
		if token.kind == jsIdentifierToken {
			if isJSPunctuator(tokens, index-1, ".") || isJSPunctuator(tokens, index-1, "?.") {
				return true
			}
			switch token.value {
			case "await", "case", "delete", "in", "instanceof", "new", "of", "throw", "typeof", "void":
				return false
			}
		}
		return true
	}
	switch token.value {
	case ")", "]", "}", "++", "--":
		return true
	default:
		return false
	}
}

func isJSLineTerminator(r rune) bool {
	return r == '\n' || r == '\r' || r == '\u2028' || r == '\u2029'
}

func containsJSLineTerminator(source []byte) bool {
	for len(source) > 0 {
		r, size := utf8.DecodeRune(source)
		if isJSLineTerminator(r) {
			return true
		}
		source = source[size:]
	}
	return false
}

func closesJSControlCondition(tokens []jsModuleToken, closing int) bool {
	depth := 0
	for index := closing; index >= 0; index-- {
		if isJSPunctuator(tokens, index, ")") {
			depth++
		} else if isJSPunctuator(tokens, index, "(") {
			depth--
			if depth != 0 {
				continue
			}
			if index > 0 && tokens[index-1].kind == jsIdentifierToken {
				switch tokens[index-1].value {
				case "catch", "for", "if", "switch", "while", "with":
					return true
				case "await":
					return index > 1 && isJSIdentifier(tokens, index-2, "for")
				}
			}
			return false
		}
	}
	return false
}

func canStartJSRegexAfter(previous jsModuleToken) bool {
	if previous.kind == jsIdentifierToken {
		switch previous.value {
		case "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of", "return", "throw", "typeof", "void", "yield":
			return true
		default:
			return false
		}
	}
	if previous.kind != jsPunctuatorToken {
		return false
	}
	switch previous.value {
	case ")", "]", "}", "++", "--", ".", "?.":
		return false
	default:
		return true
	}
}

func skipJSLineComment(source []byte, index int) int {
	for index < len(source) {
		r, size := utf8.DecodeRune(source[index:])
		if isJSLineTerminator(r) {
			break
		}
		index += size
	}
	return index
}

func skipJSBlockComment(source []byte, index int) int {
	if end := bytes.Index(source[index+2:], []byte("*/")); end >= 0 {
		return index + 2 + end + 2
	}
	return len(source)
}

func skipJSRegexLiteral(source []byte, index int) int {
	index++
	inCharacterClass := false
	for index < len(source) {
		r, size := utf8.DecodeRune(source[index:])
		if isJSLineTerminator(r) {
			return index
		}
		switch source[index] {
		case '\\':
			index++
			if index < len(source) {
				_, escapedSize := utf8.DecodeRune(source[index:])
				index += escapedSize
			}
		case '[':
			inCharacterClass = true
			index++
		case ']':
			inCharacterClass = false
			index++
		case '/':
			if !inCharacterClass {
				index++
				for index < len(source) {
					r, size := utf8.DecodeRune(source[index:])
					if !isJSIdentifierPart(r) {
						break
					}
					index += size
				}
				return index
			}
			index++
		default:
			index += size
		}
	}
	return index
}

func scanJSStringLiteral(source []byte, index int) (string, int, bool) {
	quote := source[index]
	index++
	var value strings.Builder
	for index < len(source) {
		c := source[index]
		if c == quote {
			return value.String(), index + 1, true
		}
		if c == '\n' || c == '\r' {
			return "", index + 1, false
		}
		if c != '\\' {
			r, size := utf8.DecodeRune(source[index:])
			value.WriteRune(r)
			index += size
			continue
		}
		index++
		if index >= len(source) {
			break
		}
		switch source[index] {
		case '\n':
			index++
		case '\r':
			index++
			if index < len(source) && source[index] == '\n' {
				index++
			}
		case 'n':
			value.WriteByte('\n')
			index++
		case 'r':
			value.WriteByte('\r')
			index++
		case 't':
			value.WriteByte('\t')
			index++
		case 'b':
			value.WriteByte('\b')
			index++
		case 'f':
			value.WriteByte('\f')
			index++
		case 'v':
			value.WriteByte('\v')
			index++
		case '0':
			value.WriteByte(0)
			index++
		case 'x':
			escaped, next, ok := readJSHexEscape(source, index+1, 2)
			if !ok {
				return "", next, false
			}
			value.WriteRune(rune(escaped))
			index = next
		case 'u':
			escaped, next, ok := readJSUnicodeEscape(source, index+1)
			if !ok {
				return "", next, false
			}
			value.WriteRune(escaped)
			index = next
		default:
			r, size := utf8.DecodeRune(source[index:])
			value.WriteRune(r)
			index += size
		}
	}
	return "", len(source), false
}

func readJSHexEscape(source []byte, index, digits int) (uint32, int, bool) {
	if index+digits > len(source) {
		return 0, len(source), false
	}
	value, err := strconv.ParseUint(string(source[index:index+digits]), 16, 32)
	if err != nil {
		return 0, index + digits, false
	}
	return uint32(value), index + digits, true
}

func readJSUnicodeEscape(source []byte, index int) (rune, int, bool) {
	if index < len(source) && source[index] == '{' {
		end := bytes.IndexByte(source[index+1:], '}')
		if end < 0 {
			return 0, len(source), false
		}
		end += index + 1
		value, err := strconv.ParseUint(string(source[index+1:end]), 16, 32)
		if err != nil || value > utf8.MaxRune || value >= 0xD800 && value <= 0xDFFF {
			return 0, end + 1, false
		}
		return rune(value), end + 1, true
	}
	value, next, ok := readJSHexEscape(source, index, 4)
	if !ok {
		return 0, next, false
	}
	if value >= 0xD800 && value <= 0xDBFF {
		if next+2 <= len(source) && source[next] == '\\' && source[next+1] == 'u' {
			low, after, lowOK := readJSHexEscape(source, next+2, 4)
			if lowOK && low >= 0xDC00 && low <= 0xDFFF {
				return rune(0x10000 + ((value - 0xD800) << 10) + (low - 0xDC00)), after, true
			}
		}
		return 0, next, false
	}
	if value >= 0xDC00 && value <= 0xDFFF {
		return 0, next, false
	}
	return rune(value), next, true
}

func skipJSTemplateLiteral(source []byte, index int) int {
	index++
	for index < len(source) {
		switch source[index] {
		case '\\':
			index = min(index+2, len(source))
		case '`':
			return index + 1
		case '$':
			if index+1 < len(source) && source[index+1] == '{' {
				index = skipJSTemplateExpression(source, index+2)
				continue
			}
			index++
		default:
			_, size := utf8.DecodeRune(source[index:])
			index += size
		}
	}
	return index
}

func skipJSTemplateExpression(source []byte, index int) int {
	depth := 1
	var tokens []jsModuleToken
	lineBreakBefore := false
	appendToken := func(token jsModuleToken) {
		token.lineBreakBefore = lineBreakBefore
		tokens = append(tokens, token)
		lineBreakBefore = false
	}
	for index < len(source) {
		r, size := utf8.DecodeRune(source[index:])
		if unicode.IsSpace(r) || r == '\uFEFF' {
			lineBreakBefore = lineBreakBefore || isJSLineTerminator(r)
			index += size
			continue
		}
		if source[index] == '/' && index+1 < len(source) {
			switch source[index+1] {
			case '/':
				index = skipJSLineComment(source, index)
				continue
			case '*':
				end := skipJSBlockComment(source, index)
				lineBreakBefore = lineBreakBefore || containsJSLineTerminator(source[index:end])
				index = end
				continue
			}
			if canStartJSRegex(tokens) {
				index = skipJSRegexLiteral(source, index)
				appendToken(jsModuleToken{kind: jsOpaqueToken, value: "regex"})
				continue
			}
		}
		if source[index] == '\'' || source[index] == '"' {
			_, next, _ := scanJSStringLiteral(source, index)
			index = max(next, index+1)
			appendToken(jsModuleToken{kind: jsStringToken})
			continue
		}
		if source[index] == '`' {
			index = skipJSTemplateLiteral(source, index)
			appendToken(jsModuleToken{kind: jsOpaqueToken, value: "template"})
			continue
		}
		if source[index] == '{' {
			depth++
			appendToken(jsModuleToken{kind: jsPunctuatorToken, value: "{"})
			index++
			continue
		}
		if source[index] == '}' {
			depth--
			index++
			if depth == 0 {
				return index
			}
			appendToken(jsModuleToken{kind: jsPunctuatorToken, value: "}"})
			continue
		}
		if isJSIdentifierStart(r) {
			start := index
			index += size
			for index < len(source) {
				part, partSize := utf8.DecodeRune(source[index:])
				if !isJSIdentifierPart(part) {
					break
				}
				index += partSize
			}
			appendToken(jsModuleToken{kind: jsIdentifierToken, value: string(source[start:index])})
			continue
		}
		if source[index] >= '0' && source[index] <= '9' {
			index++
			for index < len(source) && ((source[index] >= '0' && source[index] <= '9') || (source[index] >= 'a' && source[index] <= 'z') || (source[index] >= 'A' && source[index] <= 'Z') || source[index] == '_' || source[index] == '.') {
				index++
			}
			appendToken(jsModuleToken{kind: jsNumberToken})
			continue
		}
		punctuator := readJSPunctuator(source, index)
		index += len(punctuator)
		appendToken(jsModuleToken{kind: jsPunctuatorToken, value: punctuator})
	}
	return index
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

func hasHTMLAttribute(attributes []html.Attribute, name string) bool {
	for _, attribute := range attributes {
		if strings.EqualFold(attribute.Key, name) {
			return true
		}
	}
	return false
}

func isHTMLModuleScriptType(value string) bool {
	value = strings.Trim(value, "\t\n\f\r ")
	if len(value) != len("module") {
		return false
	}
	for index := range value {
		character := value[index]
		if character >= 'A' && character <= 'Z' {
			character += 'a' - 'A'
		}
		if character != "module"[index] {
			return false
		}
	}
	return true
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
