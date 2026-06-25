# Temporary deploy-bundle handoff for cd-aws.yml. SSM documents include runtime parameters in the 64 KiB
# document limit, so the workflow uploads the exact-SHA infra bundle here and sends only the S3 URI via SSM.
resource "aws_s3_bucket" "deploy_artifacts" {
  # checkov:skip=CKV_AWS_18:short-lived deploy artifacts do not warrant a separate access-log bucket
  # checkov:skip=CKV_AWS_144:single-region experiment deploy artifact bucket; cross-region replication is out of scope
  # checkov:skip=CKV_AWS_145:SSE-S3 is sufficient for transient committed infra files; no secrets are stored here
  # checkov:skip=CKV2_AWS_62:event notifications add no value for short-lived deploy artifacts
  bucket        = "${var.prefix}-${data.aws_caller_identity.current.account_id}-${var.aws_region}-deploy-artifacts"
  force_destroy = true
  tags          = { Name = "${var.prefix}-deploy-artifacts" }
}

resource "aws_s3_bucket_public_access_block" "deploy_artifacts" {
  bucket                  = aws_s3_bucket.deploy_artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "deploy_artifacts" {
  bucket = aws_s3_bucket.deploy_artifacts.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "deploy_artifacts" {
  bucket = aws_s3_bucket.deploy_artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "deploy_artifacts" {
  bucket = aws_s3_bucket.deploy_artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "deploy_artifacts" {
  # checkov:skip=CKV_AWS_300:false positive; abort_incomplete_multipart_upload is configured below
  bucket = aws_s3_bucket.deploy_artifacts.id

  rule {
    id     = "expire-deploy-bundles"
    status = "Enabled"

    filter {
      prefix = "deploy-bundles/"
    }

    expiration {
      days = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}
