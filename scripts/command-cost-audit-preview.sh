#!/bin/sh
# Reproduce local Git-process and selected-bundle measurements for preview-local.
# This creates disposable Git repositories and output only under ignored .local/.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AUDIT_ROOT="$REPO_ROOT/.local/site-preview-audit/scale-v1"
SOURCE_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
GO_VERSION="$(go version)"
AUDIT_REAL_GIT="$(command -v git)"
export AUDIT_REAL_GIT

mkdir -p "$AUDIT_ROOT/bin"
printf 'preview-audit-script=v1 source_sha=%s %s\n' "$SOURCE_SHA" "$GO_VERSION"
{
  printf 'preview-audit-script=v1\nsource_sha=%s\n%s\n' "$SOURCE_SHA" "$GO_VERSION"
} > "$AUDIT_ROOT/run-info.txt"

(cd "$REPO_ROOT/cli" && go build -o "$AUDIT_ROOT/preview-local" ./cmd/preview-local)

cat > "$AUDIT_ROOT/bin/git" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$AUDIT_GIT_LOG"
exec "$AUDIT_REAL_GIT" "$@"
SH
chmod +x "$AUDIT_ROOT/bin/git"

make_repo() {
  scenario="$1"
  count="$2"
  case "$scenario" in
    shared_1|shared_100|unique_100|doc_100|noop_100) ;;
    *) printf 'unknown scenario: %s\n' "$scenario" >&2; exit 2 ;;
  esac

  case_root="$AUDIT_ROOT/$scenario"
  rm -rf "$case_root"
  repo="$case_root/repo"
  output="$case_root/out"
  log="$case_root/git.log"
  mkdir -p "$repo/docs/artifacts/docs" "$repo/docs/artifacts/assets" "$repo/docs/artifacts/images"
  "$AUDIT_REAL_GIT" -C "$repo" init -q -b main
  "$AUDIT_REAL_GIT" -C "$repo" config user.name 'Audit Fixture'
  "$AUDIT_REAL_GIT" -C "$repo" config user.email 'audit@example.invalid'
  "$AUDIT_REAL_GIT" -C "$repo" remote add origin https://github.com/acme/preview-cost-audit.git

  i=1
  while [ "$i" -le "$count" ]; do
    n=$(printf '%04d' "$i")
    case "$scenario" in
      shared_1|shared_100)
        printf '<title>Document %s</title><link rel="stylesheet" href="../assets/shared.css">\n' "$n" > "$repo/docs/artifacts/docs/doc-$n.html"
        ;;
      unique_100)
        printf '<title>Document %s</title><link rel="stylesheet" href="../assets/theme-%s.css">\n' "$n" "$n" > "$repo/docs/artifacts/docs/doc-$n.html"
        printf 'body { color: #%s; }\n' "$n" > "$repo/docs/artifacts/assets/theme-$n.css"
        ;;
      doc_100|noop_100)
        printf '<title>Document %s</title><h1>Base</h1>\n' "$n" > "$repo/docs/artifacts/docs/doc-$n.html"
        ;;
    esac
    i=$((i + 1))
  done

  case "$scenario" in
    shared_1|shared_100)
      printf 'body { background: url("../images/logo.svg"); color: #111; }\n' > "$repo/docs/artifacts/assets/shared.css"
      printf '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n' > "$repo/docs/artifacts/images/logo.svg"
      ;;
  esac
  "$AUDIT_REAL_GIT" -C "$repo" add .
  "$AUDIT_REAL_GIT" -C "$repo" commit -qm base
  "$AUDIT_REAL_GIT" -C "$repo" checkout -qb preview

  case "$scenario" in
    shared_1|shared_100)
      printf 'body { background: url("../images/logo.svg"); color: #222; }\n' > "$repo/docs/artifacts/assets/shared.css"
      ;;
    unique_100)
      printf 'body { color: #222; }\n' > "$repo/docs/artifacts/assets/theme-0001.css"
      ;;
    doc_100)
      printf '<title>Document 0001</title><h1>Changed</h1>\n' > "$repo/docs/artifacts/docs/doc-0001.html"
      ;;
    noop_100)
      "$AUDIT_REAL_GIT" -C "$repo" checkout -q main
      ;;
  esac

  "$AUDIT_REAL_GIT" -C "$repo" add .
  if [ "$scenario" != noop_100 ]; then
    "$AUDIT_REAL_GIT" -C "$repo" commit -qm preview
  fi
  : > "$log"
  if [ "$scenario" = noop_100 ]; then head_ref=main; else head_ref=preview; fi
  (
    cd "$repo"
    AUDIT_GIT_LOG="$log" PATH="$AUDIT_ROOT/bin:$PATH" "$AUDIT_ROOT/preview-local" \
      -site guide -source-path docs/artifacts -default-ref main -head-ref "$head_ref" -root "$output"
  ) > "$case_root/out.txt"

  git_calls=$(wc -l < "$log" | tr -d ' ')
  blob_calls=$(grep -c '^cat-file blob ' "$log" || true)
  if [ -d "$output/guide/revisions" ]; then
    selected_bytes=$(python3 -c 'from pathlib import Path; import sys; root=Path(sys.argv[1]); print(sum(p.stat().st_size for p in root.rglob("*") if p.is_file() and "files" in p.parts))' "$output/guide/revisions")
    selected_files=$(find "$output/guide/revisions" -type f ! -name manifest.json | wc -l | tr -d ' ')
  else
    selected_bytes=0
    selected_files=0
  fi
  printf '%s docs=%s head=%s git_processes=%s cat_file=%s selected_files=%s selected_source_bytes=%s\n' \
    "$scenario" "$count" "$head_ref" "$git_calls" "$blob_calls" "$selected_files" "$selected_bytes"
}

make_repo shared_1 1
make_repo shared_100 100
make_repo unique_100 100
make_repo doc_100 100
make_repo noop_100 100

# The memory-store fake asserts logical preview operations: initial 2-file
# publication uses one lock, four origin reads, and four writes; same-head
# verification adds four reads and zero writes.
printf 'preview_fake_store_test=TestPublishAppliesFreshLockedPlanWithoutDuplicateTargetReads\n'
(cd "$REPO_ROOT/cli" && go test ./internal/preview -run '^TestPublishAppliesFreshLockedPlanWithoutDuplicateTargetReads$' -count=1)
