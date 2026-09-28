package preview

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestIsHTMLModuleScriptType(t *testing.T) {
	for _, testCase := range []struct {
		value string
		want  bool
	}{
		{value: "module", want: true},
		{value: "MODULE", want: true},
		{value: " \tMoDuLe\n", want: true},
		{value: "\u00a0module\u00a0", want: false},
		{value: "application/json", want: false},
	} {
		t.Run(testCase.value, func(t *testing.T) {
			if got := isHTMLModuleScriptType(testCase.value); got != testCase.want {
				t.Fatalf("isHTMLModuleScriptType(%q) = %t, want %t", testCase.value, got, testCase.want)
			}
		})
	}
}

func TestJavaScriptModuleReferences(t *testing.T) {
	source := strings.Join([]string{
		`import "./side-effect.js";`,
		`import main from "./default.js";`,
		`import { label as named } from "./named.js";`,
		"import {\n  multilineLabel\n}\nfrom './multiline.js'",
		`import * as namespace from "./namespace.js";`,
		`import "./\u0065scaped.js";`,
		`export { item } from "./re-export.js";`,
		`export * from "./re-export-all.js";`,
		`export * as tools from "./re-export-namespace.js";`,
		`export const label = "Ready";`,
		`const quoted = "import './string-decoy.js'";`,
		`// import "./line-comment-decoy.js";`,
		`/* export * from "./block-comment-decoy.js"; */`,
		`import("./dynamic-import.js");`,
		`const constructed = import("./" + runtimeName);`,
		`const memberQuotient = record.return / 2;`,
		`if (ready) /import "\.\/control-regex-decoy\.js"/.test(source);`,
		`if (ready) {} /import "\.\/block-regex-decoy\.js"/.test(source);`,
		`{} /import "\.\/empty-block-regex-decoy\.js"/.test(source);`,
		`function declarationBlock() {} /import "\.\/function-block-regex-decoy\.js"/.test(source);`,
		`const functionQuotient = function expressionBody() {} / 2;`,
		`const classQuotient = class ExpressionBody {} / 2;`,
		`import "./after-block.js";`,
		`import "./after-expression.js";`,
		"const template = `import \"./template-decoy.js\"; ${\"import './template-expression-decoy.js'\"}`;",
		`const regex = /import ["']\.\/regex-decoy\.js["']/;`,
		`const meta = import.meta.url;`,
	}, "\n")
	want := []string{
		"./side-effect.js", "./default.js", "./named.js", "./multiline.js", "./namespace.js", "./escaped.js",
		"./re-export.js", "./re-export-all.js", "./re-export-namespace.js",
		"./after-block.js",
		"./after-expression.js",
	}
	if _, err := parsedJavaScriptModuleReferences([]byte(source)); err != nil {
		t.Fatalf("parsedJavaScriptModuleReferences() error = %v", err)
	}
	if got := javascriptModuleReferences([]byte(source)); !reflect.DeepEqual(got, want) {
		t.Fatalf("javascriptModuleReferences() = %#v, want %#v", got, want)
	}
}

func TestJavaScriptModuleReferencesToleratesImportAttributes(t *testing.T) {
	source := `import data from "./data.json" with { type: "json" };
const functionQuotient = function expressionBody() {} / 2;
const classQuotient = class ExpressionBody {} / 2;
const newFunctionQuotient = 1 + new
function newFunctionExpressionBody() {} / 2;
const newClassQuotient = 1 + new
class NewClassExpressionBody {} / 2;
const memberKeyword = object.new
function memberExpressionBody() {} /import "\.\/member-decoy.js"/.test(source);
function* generator() {
  yield
  function yieldedDeclaration() {} /import "\.\/yield-decoy.js"/.test(source);
}
const template = ` + "`" + `${(() => {
  const value = 1
  function templateDeclaration() {}
  /[}]import "\.\/template-decoy.js"/.test(source);
})()}` + "`" + `;
import "./after-expression.js";
`
	want := []string{"./data.json", "./after-expression.js"}
	if got := javascriptModuleReferences([]byte(source)); !reflect.DeepEqual(got, want) {
		t.Fatalf("javascriptModuleReferences() = %#v, want %#v", got, want)
	}
}

func TestJavaScriptModuleReferencesToleratesImportAttributesWithASIBoundaries(t *testing.T) {
	prefix := `import data from "./data.json" with { type: "json" };
const value = 1`
	suffix := `function f() {} /import "\.\/fake.js"/.test(source)
import "./real.js";`
	for _, testCase := range []struct {
		name      string
		separator string
	}{
		{name: "line feed", separator: "\n"},
		{name: "carriage return", separator: "\r"},
		{name: "carriage return line feed", separator: "\r\n"},
		{name: "line separator", separator: "\u2028"},
		{name: "paragraph separator", separator: "\u2029"},
		{name: "multiline block comment", separator: "/*\n*/"},
		{name: "block comment with paragraph separator", separator: "/*\u2029*/"},
		{name: "line comment", separator: "// boundary\n"},
		{name: "line comment with Unicode separator", separator: "// boundary\u2028"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			source := prefix + testCase.separator + suffix
			want := []string{"./data.json", "./real.js"}
			if got := javascriptModuleReferences([]byte(source)); !reflect.DeepEqual(got, want) {
				t.Fatalf("javascriptModuleReferences() = %#v, want %#v", got, want)
			}
		})
	}
}

func TestBuildFromGitCollectsStaticJavaScriptModulesTransitively(t *testing.T) {
	repo := newTestRepository(t)
	writeTestFile(t, repo, "site/docs/guide.html", `<title>Guide</title><script type="module" src="../assets/app.js"></script>`)
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "base guide")
	gitTest(t, repo, "branch", "preview")

	gitTest(t, repo, "checkout", "preview")
	writeTestFile(t, repo, "site/docs/guide.html", `<title>Preview Guide</title><script type="module" src="../assets/app.js"></script>`)
	writeTestFile(t, repo, "site/assets/app.js", `import "./side-effect.js";
const memberQuotient = record.return / 2;
{} /import "\.\/empty-block-regex-decoy\.js"/.test(source);
function declarationBlock() {} /import "\.\/function-block-regex-decoy\.js"/.test(source);
const functionQuotient = function expressionBody() {} / 2;
const classQuotient = class ExpressionBody {} / 2;
import main from "./default.js";
import { namedValue } from "./named.js";
import {
  multilineValue
} from "./multiline.js";
export { reExported } from "./re-export.js";
export * from "./re-export-all.js";
export * as namespaced from "./re-export-namespace.js";
export const label = "Ready";
const quoted = "import './string-decoy.js'";
// import "./line-comment-decoy.js";
/* export * from "./block-comment-decoy.js"; */
if (ready) {} /import "\.\/block-regex-decoy\.js"/.test(source);
import "./after-block.js";
import "./after-expression.js";
`)
	writeTestFile(t, repo, "site/assets/side-effect.js", `import "./transitive.js";
export const effect = true;
`)
	writeTestFile(t, repo, "site/assets/default.js", `export default 1;
`)
	writeTestFile(t, repo, "site/assets/named.js", `export const namedValue = 2;
`)
	writeTestFile(t, repo, "site/assets/multiline.js", `export const multilineValue = 3;
`)
	writeTestFile(t, repo, "site/assets/re-export.js", `export const reExported = 4;
`)
	writeTestFile(t, repo, "site/assets/re-export-all.js", `export const fromAll = 5;
`)
	writeTestFile(t, repo, "site/assets/re-export-namespace.js", `export const fromNamespace = 6;
`)
	writeTestFile(t, repo, "site/assets/transitive.js", `export const transitive = true;
`)
	writeTestFile(t, repo, "site/assets/after-block.js", `export const afterBlock = true;
`)
	writeTestFile(t, repo, "site/assets/after-expression.js", `export const afterExpression = true;
`)
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "preview guide and module graph")

	result, err := BuildFromGit(context.Background(), BuildOptions{
		RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: "main", HeadRef: "preview",
	})
	if err != nil {
		t.Fatalf("BuildFromGit() error = %v", err)
	}
	want := []string{
		"docs/guide.html", "assets/app.js", "assets/default.js", "assets/multiline.js", "assets/named.js",
		"assets/re-export-all.js", "assets/re-export-namespace.js", "assets/re-export.js", "assets/side-effect.js", "assets/transitive.js",
		"assets/after-block.js",
		"assets/after-expression.js",
	}
	if len(result.Files) != len(want) {
		t.Fatalf("collected %d files, want %d: %#v", len(result.Files), len(want), result.Files)
	}
	for _, filePath := range want {
		if _, ok := result.Files[filePath]; !ok {
			t.Errorf("static module dependency %q was not collected", filePath)
		}
	}
	for _, decoy := range []string{"assets/Ready", "assets/string-decoy.js", "assets/line-comment-decoy.js", "assets/block-comment-decoy.js"} {
		if _, ok := result.Files[decoy]; ok {
			t.Errorf("non-specifier value %q was incorrectly collected", decoy)
		}
	}
}

func TestBuildFromGitCollectsInlineModuleDependencies(t *testing.T) {
	repo := newTestRepository(t)
	writeTestFile(t, repo, "site/docs/guide.html", `<title>Guide</title>`)
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "base guide")
	gitTest(t, repo, "branch", "preview")

	gitTest(t, repo, "checkout", "preview")
	writeTestFile(t, repo, "site/docs/guide.html", `<title>Preview Guide</title>
<script type="module">
import "./inline-app.js";
export { label } from "./inline-export.js";
import "https://cdn.example.test/remote.js";
const decoy = "import './string-decoy.js'";
</script>
<script>import "./ordinary-script-decoy.js";</script>
<script type="application/json">{"code":"import './data-script-decoy.js'"}</script>
<script type=" module ">import "./unicode-type-decoy.js";</script>
<script type="module" src="../assets/external-entry.js">import "./external-inline-decoy.js";</script>`)
	writeTestFile(t, repo, "site/docs/inline-app.js", `import "./modules/dependency.js";
export const loaded = true;
`)
	writeTestFile(t, repo, "site/docs/modules/dependency.js", `export const dependency = true;
`)
	writeTestFile(t, repo, "site/docs/inline-export.js", `export const label = "inline";
`)
	writeTestFile(t, repo, "site/assets/external-entry.js", `export const externalEntry = true;
`)
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "preview guide with inline module imports")

	result, err := BuildFromGit(context.Background(), BuildOptions{
		RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: "main", HeadRef: "preview",
	})
	if err != nil {
		t.Fatalf("BuildFromGit() error = %v", err)
	}
	want := []string{
		"assets/external-entry.js", "docs/guide.html", "docs/inline-app.js", "docs/inline-export.js", "docs/modules/dependency.js",
	}
	if len(result.Files) != len(want) {
		t.Fatalf("collected %d files, want %d: %#v", len(result.Files), len(want), result.Files)
	}
	manifestPaths := make(map[string]bool, len(result.Manifest.Files))
	for _, file := range result.Manifest.Files {
		manifestPaths[file.Path] = true
	}
	if len(manifestPaths) != len(want) {
		t.Fatalf("manifest lists %d files, want %d: %#v", len(manifestPaths), len(want), result.Manifest.Files)
	}
	for _, filePath := range want {
		if _, ok := result.Files[filePath]; !ok {
			t.Errorf("inline module dependency %q was not collected", filePath)
		}
		if !manifestPaths[filePath] {
			t.Errorf("inline module dependency %q is missing from the manifest", filePath)
		}
	}
	for _, decoy := range []string{
		"docs/string-decoy.js", "docs/ordinary-script-decoy.js", "docs/data-script-decoy.js", "docs/unicode-type-decoy.js", "docs/external-inline-decoy.js",
	} {
		if _, ok := result.Files[decoy]; ok {
			t.Errorf("non-module script content %q was incorrectly collected", decoy)
		}
	}
}

func TestBuildFromGitRejectsMissingAndOutOfTreeStaticModules(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		specifier string
		wantError string
	}{
		{name: "missing module", specifier: "./missing.js", wantError: `preview resource "assets/missing.js" is missing from the source head tree`},
		{name: "out-of-tree module", specifier: "../../../outside.js", wantError: "escapes the source tree"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			repo := newTestRepository(t)
			writeTestFile(t, repo, "site/docs/guide.html", `<title>Guide</title>`)
			gitTest(t, repo, "add", ".")
			gitTest(t, repo, "commit", "-m", "base guide")
			gitTest(t, repo, "branch", "preview")
			gitTest(t, repo, "checkout", "preview")
			writeTestFile(t, repo, "site/docs/guide.html", `<title>Preview Guide</title><script type="module" src="../assets/app.js"></script>`)
			writeTestFile(t, repo, "site/assets/app.js", `import "`+testCase.specifier+`";`)
			gitTest(t, repo, "add", ".")
			gitTest(t, repo, "commit", "-m", "preview guide with invalid module")

			_, err := BuildFromGit(context.Background(), BuildOptions{
				RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: "main", HeadRef: "preview",
			})
			if err == nil || !strings.Contains(err.Error(), testCase.wantError) {
				t.Fatalf("BuildFromGit() error = %v, want %q", err, testCase.wantError)
			}
		})
	}
}

func TestBuildFromGitRejectsMissingAndOutOfTreeInlineModuleDependencies(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		specifier string
		wantError string
	}{
		{name: "missing module", specifier: "./missing.js", wantError: `preview resource "docs/missing.js" is missing from the source head tree`},
		{name: "out-of-tree module", specifier: "../../../outside.js", wantError: "escapes the source tree"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			repo := newTestRepository(t)
			writeTestFile(t, repo, "site/docs/guide.html", `<title>Guide</title>`)
			gitTest(t, repo, "add", ".")
			gitTest(t, repo, "commit", "-m", "base guide")
			gitTest(t, repo, "branch", "preview")
			gitTest(t, repo, "checkout", "preview")
			writeTestFile(t, repo, "site/docs/guide.html", `<title>Preview Guide</title><script type="module">import "`+testCase.specifier+`";</script>`)
			gitTest(t, repo, "add", ".")
			gitTest(t, repo, "commit", "-m", "preview guide with invalid inline module")

			_, err := BuildFromGit(context.Background(), BuildOptions{
				RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: "main", HeadRef: "preview",
			})
			if err == nil || !strings.Contains(err.Error(), testCase.wantError) {
				t.Fatalf("BuildFromGit() error = %v, want %q", err, testCase.wantError)
			}
		})
	}
}
