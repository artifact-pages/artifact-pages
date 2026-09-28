#!/bin/sh
set -eu

endpoint=http://minio:9000
bucket=artifact-pages
mode=${1:?usage: assert-cloudflare-unregister.sh before|after PROBE_KEY}
probe_key=${2:?usage: assert-cloudflare-unregister.sh before|after PROBE_KEY}

list_keys() {
  aws --endpoint-url "$endpoint" s3api list-objects-v2 --bucket "$bucket" \
    --prefix "$1" --query 'Contents[].Key' --output text
}

assert_nonempty() {
  prefix=$1
  keys=$(list_keys "$prefix")
  if [ -z "$keys" ] || [ "$keys" = None ]; then
    printf 'Expected objects under %s before unregister, found none.\n' "$prefix" >&2
    exit 1
  fi
}

assert_empty() {
  prefix=$1
  keys=$(list_keys "$prefix")
  if [ -n "$keys" ] && [ "$keys" != None ]; then
    printf 'Objects remain under %s after unregister: %s\n' "$prefix" "$keys" >&2
    exit 1
  fi
}

case "$mode" in
  before)
    assert_nonempty '_artifacts/sre/'
    assert_nonempty '_indexes/sre/'
    assert_nonempty '_previews/sre/'
    aws --endpoint-url "$endpoint" s3api head-object --bucket "$bucket" --key "$probe_key" >/dev/null
    ;;
  after)
    assert_empty '_artifacts/sre/'
    assert_empty '_indexes/sre/'
    assert_empty '_previews/sre/'
    assert_nonempty '_artifacts/frontend/'
    assert_nonempty '_indexes/frontend/'
    aws --endpoint-url "$endpoint" s3api head-object --bucket "$bucket" --key "$probe_key" >/dev/null
    ;;
  *)
    printf 'Unknown mode %s; expected before or after.\n' "$mode" >&2
    exit 2
    ;;
esac

printf 'Cloudflare local unregister %s-object assertions passed.\n' "$mode"
