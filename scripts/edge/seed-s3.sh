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
aws --endpoint-url "$endpoint" s3 cp /seed/storage "$destination" --recursive \
  --exclude '*' --include '*.html' --include '*.htm' --content-type 'text/html; charset=utf-8' --only-show-errors
aws --endpoint-url "$endpoint" s3 cp /seed/storage "$destination" --recursive \
  --exclude '*' --include '*.md' --content-type 'text/markdown; charset=utf-8' --only-show-errors
aws --endpoint-url "$endpoint" s3 cp /seed/storage "$destination" --recursive \
  --exclude '*' --include '*.json' --content-type 'application/json; charset=utf-8' --only-show-errors
aws --endpoint-url "$endpoint" s3 cp /seed/storage "$destination" --recursive \
  --exclude '*' --include '*.css' --content-type 'text/css; charset=utf-8' --only-show-errors
aws --endpoint-url "$endpoint" s3 cp /seed/storage "$destination" --recursive \
  --exclude '*' --include '*.js' --content-type 'application/javascript; charset=utf-8' --only-show-errors
aws --endpoint-url "$endpoint" s3 cp /seed/storage "$destination" --recursive \
  --exclude '*' --include '*.svg' --content-type 'image/svg+xml' --only-show-errors
aws --endpoint-url "$endpoint" s3 cp /seed/storage "$destination" --recursive \
  --exclude '*' --include '*.pdf' --content-type 'application/pdf' --only-show-errors
aws --endpoint-url "$endpoint" s3 cp /seed/storage "$destination" --recursive \
  --exclude '*' --include '*.png' --content-type 'image/png' --only-show-errors
aws --endpoint-url "$endpoint" s3 cp /seed/storage "$destination" --recursive \
  --exclude '*' --include '*.jpg' --include '*.jpeg' --content-type 'image/jpeg' --only-show-errors
aws --endpoint-url "$endpoint" s3 cp /seed/storage "$destination" --recursive \
  --exclude '*' --include '*.woff2' --content-type 'font/woff2' --only-show-errors
aws --endpoint-url "$endpoint" s3 cp /seed/storage "$destination" --recursive \
  --exclude '*' --include '*.wasm' --content-type 'application/wasm' --only-show-errors
