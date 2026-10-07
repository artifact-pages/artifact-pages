locals {
  aws_account_id                  = data.aws_caller_identity.current.account_id
  github_oidc_provider_account_id = split(":", var.github_oidc_provider_arn)[4]
  bucket_name                     = coalesce(var.bucket_name, "artifact-pages-${local.aws_account_id}-${var.aws_region}")
  bucket_arn                      = "arn:aws:s3:::${local.bucket_name}"
  bucket_objects                  = "${local.bucket_arn}/*"
  origin_id                       = "${var.name_prefix}-s3-origin"
  github_issuer                   = trimprefix(var.github_oidc_issuer_url, "https://")

  satellite_role_names = {
    for site_id in keys(var.satellite_github_subjects) :
    site_id => length("${var.name_prefix}-${site_id}-publisher") <= 64 ?
    "${var.name_prefix}-${site_id}-publisher" :
    "${var.name_prefix}-s-${substr(sha256(site_id), 0, 20)}-pub"
  }

  cache_behaviors = {
    indexes = {
      path_pattern    = "/_indexes/*"
      cache_policy_id = aws_cloudfront_cache_policy.indexes.id
      allowed_methods = ["GET", "HEAD"]
      cached_methods  = ["GET", "HEAD"]
    }
    artifacts = {
      path_pattern    = "/_artifacts/*"
      cache_policy_id = aws_cloudfront_cache_policy.artifacts.id
      allowed_methods = ["GET", "HEAD"]
      cached_methods  = ["GET", "HEAD"]
    }
    previews = {
      path_pattern    = "/_previews/*"
      cache_policy_id = aws_cloudfront_cache_policy.no_store.id
      allowed_methods = ["GET", "HEAD"]
      cached_methods  = ["GET", "HEAD"]
    }
    assets = {
      path_pattern    = "/assets/*"
      cache_policy_id = aws_cloudfront_cache_policy.immutable_assets.id
      allowed_methods = ["GET", "HEAD"]
      cached_methods  = ["GET", "HEAD"]
    }
    errors = {
      path_pattern    = "/_errors/*"
      cache_policy_id = aws_cloudfront_cache_policy.no_store.id
      allowed_methods = ["GET", "HEAD"]
      cached_methods  = ["GET", "HEAD"]
    }
  }

  admin_statements = [
    {
      Sid      = "ListProjectionPrefixes"
      Effect   = "Allow"
      Action   = ["s3:ListBucket"]
      Resource = local.bucket_arn
      Condition = {
        StringLike = {
          "s3:prefix" = [
            "index.html",
            "preview-bridge.js",
            "LICENSE",
            "THIRD_PARTY_NOTICES.txt",
            "assets/*",
            "_artifacts/*",
            "_indexes/*",
            "_previews/*",
            "_control/*",
          ]
        }
      }
    },
    {
      Sid    = "ReadRegistryAppAndControlState"
      Effect = "Allow"
      Action = ["s3:GetObject"]
      Resource = [
        "${local.bucket_arn}/_indexes/sites.json",
        "${local.bucket_arn}/_control/*",
        "${local.bucket_arn}/index.html",
        "${local.bucket_arn}/preview-bridge.js",
        "${local.bucket_arn}/LICENSE",
        "${local.bucket_arn}/THIRD_PARTY_NOTICES.txt",
        "${local.bucket_arn}/assets/*",
      ]
    },
    {
      Sid    = "WriteApplicationRegistryAndControlState"
      Effect = "Allow"
      Action = ["s3:PutObject"]
      Resource = [
        "${local.bucket_arn}/index.html",
        "${local.bucket_arn}/preview-bridge.js",
        "${local.bucket_arn}/LICENSE",
        "${local.bucket_arn}/THIRD_PARTY_NOTICES.txt",
        "${local.bucket_arn}/assets/*",
        "${local.bucket_arn}/_indexes/sites.json",
        "${local.bucket_arn}/_control/*",
      ]
    },
    {
      Sid    = "DeleteUnregisteredProjectionObjects"
      Effect = "Allow"
      Action = ["s3:DeleteObject"]
      Resource = [
        "${local.bucket_arn}/_artifacts/*",
        "${local.bucket_arn}/_indexes/*/*",
        "${local.bucket_arn}/_previews/*",
        "${local.bucket_arn}/_control/*",
        "${local.bucket_arn}/index.html",
        "${local.bucket_arn}/preview-bridge.js",
        "${local.bucket_arn}/LICENSE",
        "${local.bucket_arn}/THIRD_PARTY_NOTICES.txt",
        "${local.bucket_arn}/assets/*",
      ]
    },
    {
      Sid      = "RevalidateDistribution"
      Effect   = "Allow"
      Action   = ["cloudfront:CreateInvalidation"]
      Resource = aws_cloudfront_distribution.site.arn
    },
  ]
}

data "aws_caller_identity" "current" {}

resource "terraform_data" "target_account_guard" {
  input = local.aws_account_id

  lifecycle {
    precondition {
      condition     = local.aws_account_id == local.github_oidc_provider_account_id
      error_message = "The AWS provider account must match the account ID in github_oidc_provider_arn."
    }
  }
}

resource "aws_s3_bucket" "origin" {
  depends_on = [terraform_data.target_account_guard]

  bucket = local.bucket_name
  tags   = var.tags
}

resource "aws_s3_bucket_public_access_block" "origin" {
  depends_on = [terraform_data.target_account_guard]

  bucket                  = aws_s3_bucket.origin.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "origin" {
  depends_on = [terraform_data.target_account_guard]

  bucket = aws_s3_bucket.origin.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "origin" {
  depends_on = [terraform_data.target_account_guard]

  bucket = aws_s3_bucket.origin.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "origin" {
  depends_on = [terraform_data.target_account_guard]

  bucket = aws_s3_bucket.origin.id

  versioning_configuration {
    # S3 versioning is bucket-wide, so suspend it here. The prefix-scoped
    # lifecycle rules below also clean up any noncurrent versions that remain.
    status = "Suspended"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "origin" {
  bucket = aws_s3_bucket.origin.id

  depends_on = [terraform_data.target_account_guard, aws_s3_bucket_versioning.origin]

  rule {
    id     = "expire-preview-projection"
    status = "Enabled"

    filter {
      prefix = "_previews/"
    }

    expiration {
      days = var.preview_retention_days
    }
  }

  rule {
    id     = "expire-noncurrent-preview-projection"
    status = "Enabled"

    filter {
      prefix = "_previews/"
    }

    noncurrent_version_expiration {
      noncurrent_days = var.preview_retention_days
    }
  }

  rule {
    id     = "remove-expired-preview-delete-markers"
    status = "Enabled"

    filter {
      prefix = "_previews/"
    }

    expiration {
      expired_object_delete_marker = true
    }
  }

  rule {
    id     = "abort-incomplete-preview-uploads"
    status = "Enabled"

    filter {
      prefix = "_previews/"
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_cloudfront_origin_access_control" "origin" {
  depends_on = [terraform_data.target_account_guard]

  name                              = "${var.name_prefix}-s3-oac"
  description                       = "Signed CloudFront access to the private Artifact Pages origin."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "routes" {
  depends_on = [terraform_data.target_account_guard]

  name    = "${var.name_prefix}-logical-routes"
  runtime = "cloudfront-js-2.0"
  comment = "Keep storage keys private from navigation and send logical routes to the SPA shell."
  publish = true
  code    = file("${path.module}/routes.js")
}

resource "aws_cloudfront_response_headers_policy" "artifact_csp" {
  depends_on = [terraform_data.target_account_guard]

  name    = "${var.name_prefix}-artifact-csp"
  comment = "Enforce the trusted-HTML resource policy on artifact, raw preview and error responses."

  security_headers_config {
    content_security_policy {
      content_security_policy = join("; ", [
        "default-src https: data: blob:",
        "script-src https: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:",
        "style-src https: 'unsafe-inline' data: blob:",
      ])
      override = true
    }

    content_type_options {
      override = true
    }
  }
}

resource "aws_cloudfront_cache_policy" "no_store" {
  depends_on = [terraform_data.target_account_guard]

  name        = "${var.name_prefix}-no-store"
  comment     = "No shared-cache freshness for the SPA shell and local preview bytes."
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_cache_policy" "indexes" {
  depends_on = [terraform_data.target_account_guard]

  name        = "${var.name_prefix}-indexes"
  comment     = "Registry and site indexes have at most 60 seconds of shared-cache freshness."
  min_ttl     = 0
  default_ttl = 60
  max_ttl     = 60

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_cache_policy" "artifacts" {
  depends_on = [terraform_data.target_account_guard]

  name        = "${var.name_prefix}-artifacts"
  comment     = "Artifact objects have at most 300 seconds of shared-cache freshness."
  min_ttl     = 0
  default_ttl = 300
  max_ttl     = 300

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_cache_policy" "immutable_assets" {
  depends_on = [terraform_data.target_account_guard]

  name        = "${var.name_prefix}-immutable-assets"
  comment     = "Honor application asset Cache-Control; allow hashed assets up to one year."
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_distribution" "site" {
  depends_on = [terraform_data.target_account_guard, terraform_data.waf_guard, aws_wafv2_web_acl.viewer]

  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name_prefix} static application and content planes"
  aliases         = var.aliases
  price_class     = var.price_class
  web_acl_id      = local.effective_web_acl_arn

  origin {
    domain_name              = aws_s3_bucket.origin.bucket_regional_domain_name
    origin_id                = local.origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.origin.id

    s3_origin_config {
      origin_access_identity = ""
    }
  }

  default_root_object = "index.html"

  default_cache_behavior {
    target_origin_id       = local.origin_id
    viewer_protocol_policy = var.viewer_protocol_policy
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = aws_cloudfront_cache_policy.no_store.id
    compress               = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.routes.arn
    }
  }

  dynamic "ordered_cache_behavior" {
    for_each = local.cache_behaviors

    content {
      path_pattern               = ordered_cache_behavior.value.path_pattern
      target_origin_id           = local.origin_id
      viewer_protocol_policy     = var.viewer_protocol_policy
      allowed_methods            = ordered_cache_behavior.value.allowed_methods
      cached_methods             = ordered_cache_behavior.value.cached_methods
      cache_policy_id            = ordered_cache_behavior.value.cache_policy_id
      compress                   = true
      response_headers_policy_id = contains(["artifacts", "errors", "previews"], ordered_cache_behavior.key) ? aws_cloudfront_response_headers_policy.artifact_csp.id : null

      function_association {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.routes.arn
      }

    }
  }

  custom_error_response {
    error_code            = 403
    response_code         = 404
    response_page_path    = "/_errors/not-found.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/_errors/not-found.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = length(var.aliases) == 0
    acm_certificate_arn            = length(var.aliases) > 0 ? var.acm_certificate_arn : null
    ssl_support_method             = length(var.aliases) > 0 ? "sni-only" : null
    minimum_protocol_version       = length(var.aliases) > 0 ? "TLSv1.2_2021" : null
  }

  tags = var.tags
}

resource "aws_s3_object" "not_found" {
  depends_on = [terraform_data.target_account_guard, aws_s3_bucket_public_access_block.origin]

  bucket                 = aws_s3_bucket.origin.id
  key                    = "_errors/not-found.html"
  content                = "<!doctype html><meta charset=utf-8><title>Not found</title><p>Not found</p>"
  content_type           = "text/html; charset=utf-8"
  cache_control          = "no-store"
  server_side_encryption = "AES256"

}

resource "aws_s3_bucket_policy" "origin" {
  depends_on = [terraform_data.target_account_guard, aws_s3_bucket_public_access_block.origin]

  bucket = aws_s3_bucket.origin.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOACReadOnly"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = ["s3:GetObject"]
      Resource  = local.bucket_objects
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn } }
    }]
  })

}

data "aws_iam_policy_document" "admin_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_issuer}:sub"
      values   = var.admin_github_subjects
    }
  }
}

resource "aws_iam_role" "admin" {
  depends_on = [terraform_data.target_account_guard]

  name               = "${var.name_prefix}-admin-publisher"
  assume_role_policy = data.aws_iam_policy_document.admin_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "admin" {
  depends_on = [terraform_data.target_account_guard]

  name = "${var.name_prefix}-admin-publisher"
  role = aws_iam_role.admin.id

  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.admin_statements
  })
}

data "aws_iam_policy_document" "satellite_trust" {
  for_each = var.satellite_github_subjects

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_issuer}:sub"
      values   = each.value
    }
  }
}

resource "aws_iam_role" "satellite" {
  depends_on = [terraform_data.target_account_guard]

  for_each = var.satellite_github_subjects

  name               = local.satellite_role_names[each.key]
  assume_role_policy = data.aws_iam_policy_document.satellite_trust[each.key].json
  tags               = merge(var.tags, { "artifact-pages-site" = each.key })
}

resource "aws_iam_role_policy" "satellite" {
  depends_on = [terraform_data.target_account_guard]

  for_each = var.satellite_github_subjects

  name = local.satellite_role_names[each.key]
  role = aws_iam_role.satellite[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadRegisteredSiteAndLock"
        Effect = "Allow"
        Action = ["s3:GetObject"]
        Resource = [
          "${local.bucket_arn}/_indexes/sites.json",
          # IMP-69: shared deployed-web compatibility is read-only for satellites.
          "${local.bucket_arn}/_control/versions/app.json",
          "${local.bucket_arn}/_indexes/${each.key}/*",
          "${local.bucket_arn}/_artifacts/${each.key}/*",
          "${local.bucket_arn}/_previews/${each.key}/*",
          "${local.bucket_arn}/_control/sites/${each.key}/*",
          # Transitional (IMP-66): exact pre-prefix keys, for CLIs that still use the old layout. Removed in a later module release.
          "${local.bucket_arn}/_control/locks/sites/${each.key}.json",
          "${local.bucket_arn}/_control/site-cache/${each.key}.json",
          "${local.bucket_arn}/_control/publish-state/${each.key}.json.gz",
          "${local.bucket_arn}/_control/preview-cleanup/${each.key}.json",
        ]
      },
      {
        Sid      = "ListSelectedSiteProjection"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = local.bucket_arn
        Condition = {
          StringLike = {
            "s3:prefix" = [
              "_indexes/${each.key}/*",
              "_artifacts/${each.key}/*",
              "_previews/${each.key}/*",
              "_control/sites/${each.key}/*",
              # Transitional (IMP-66): pre-prefix exact keys.
              "_control/locks/sites/${each.key}.json",
              "_control/site-cache/${each.key}.json",
              "_control/publish-state/${each.key}.json.gz",
            ]
          }
        }
      },
      {
        Sid    = "WriteSelectedSiteAndLock"
        Effect = "Allow"
        Action = ["s3:PutObject"]
        Resource = [
          "${local.bucket_arn}/_indexes/${each.key}/*",
          "${local.bucket_arn}/_artifacts/${each.key}/*",
          "${local.bucket_arn}/_previews/${each.key}/*",
          "${local.bucket_arn}/_control/sites/${each.key}/*",
          # Transitional (IMP-66): exact pre-prefix keys, for CLIs that still use the old layout. Removed in a later module release.
          "${local.bucket_arn}/_control/locks/sites/${each.key}.json",
          "${local.bucket_arn}/_control/site-cache/${each.key}.json",
          "${local.bucket_arn}/_control/publish-state/${each.key}.json.gz",
          "${local.bucket_arn}/_control/preview-cleanup/${each.key}.json",
        ]
      },
      {
        Sid    = "DeleteSelectedSiteStaleObjects"
        Effect = "Allow"
        Action = ["s3:DeleteObject"]
        Resource = [
          "${local.bucket_arn}/_artifacts/${each.key}/*",
          "${local.bucket_arn}/_indexes/${each.key}/*",
          "${local.bucket_arn}/_control/sites/${each.key}/*",
          # Transitional (IMP-66): pre-prefix exact keys. The legacy lock is never deleted.
          "${local.bucket_arn}/_control/site-cache/${each.key}.json",
          "${local.bucket_arn}/_control/publish-state/${each.key}.json.gz",
          "${local.bucket_arn}/_control/preview-cleanup/${each.key}.json",
          "${local.bucket_arn}/_previews/${each.key}/*",
        ]
      },
      {
        Sid      = "RevalidateSelectedSiteDistribution"
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation"]
        Resource = aws_cloudfront_distribution.site.arn
      },
    ]
  })
}
