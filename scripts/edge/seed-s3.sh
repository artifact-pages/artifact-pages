#!/bin/sh
set -eu

endpoint=http://minio:9000
bucket=artifact-pages
destination="s3://${bucket}"

until aws --endpoint-url "$endpoint" s3api list-buckets >/dev/null 2>&1; do
  sleep 1
done
if ! aws --endpoint-url "$endpoint" s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
  aws --endpoint-url "$endpoint" s3api create-bucket --bucket "$bucket"
fi

aws --endpoint-url "$endpoint" s3api put-bucket-policy --bucket "$bucket" \
  --policy '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":["arn:aws:s3:::artifact-pages/index.html","arn:aws:s3:::artifact-pages/assets/*","arn:aws:s3:::artifact-pages/_indexes/*","arn:aws:s3:::artifact-pages/_artifacts/*","arn:aws:s3:::artifact-pages/_previews/*"]}]}'

# Delete first so reruns cannot retain publish-only objects or stale bytes when
# a fixture and an emulator object happen to have the same size.
aws --endpoint-url "$endpoint" s3 rm "$destination" --recursive --quiet
aws --endpoint-url "$endpoint" s3 sync /seed/storage "$destination" --delete --no-progress --only-show-errors

# Keep browser MIME behavior stable across platforms and Python mimetype tables.
# The seeds model objects written by an older CLI, so objects under the content
# prefixes also carry that CLI's legacy Cache-Control for their class. A later
# `s3 cp` replaces object metadata, so the header is set in the same call as the
# content type: one pass for every object, then one pass per prefix.
legacy60='public, max-age=0, s-maxage=60, must-revalidate'
legacy300='public, max-age=0, s-maxage=300, must-revalidate'

# usage: seed_type <content-type> <extension-glob>...
seed_type() {
  content_type=$1
  shift
  includes=""
  for ext in "$@"; do includes="$includes --include $ext"; done
  # shellcheck disable=SC2086
  aws --endpoint-url "$endpoint" s3 cp /seed/storage "$destination" --recursive \
    --exclude '*' $includes --content-type "$content_type" --only-show-errors
  for rule in "_indexes/*|$legacy60" "_artifacts/*|$legacy300" "_previews/*/revisions/*|$legacy300"; do
    prefix=${rule%%|*}
    cache_control=${rule#*|}
    includes=""
    for ext in "$@"; do includes="$includes --include $prefix${ext#\*}"; done
    # shellcheck disable=SC2086
    aws --endpoint-url "$endpoint" s3 cp /seed/storage "$destination" --recursive \
      --exclude '*' $includes --content-type "$content_type" --cache-control "$cache_control" --only-show-errors
  done
}

seed_type 'text/html; charset=utf-8' '*.html' '*.htm'
seed_type 'text/markdown; charset=utf-8' '*.md'
seed_type 'application/json; charset=utf-8' '*.json'
aws --endpoint-url "$endpoint" s3 cp /seed/storage "$destination" --recursive \
  --exclude '*' --include '_previews/*/catalog.json' --content-type 'application/json; charset=utf-8' --cache-control "$legacy60" --only-show-errors
seed_type 'text/css; charset=utf-8' '*.css'
seed_type 'application/javascript; charset=utf-8' '*.js'
seed_type 'image/svg+xml' '*.svg'
seed_type 'application/pdf' '*.pdf'
seed_type 'image/png' '*.png'
seed_type 'image/jpeg' '*.jpg' '*.jpeg'
seed_type 'font/woff2' '*.woff2'
seed_type 'application/wasm' '*.wasm'
