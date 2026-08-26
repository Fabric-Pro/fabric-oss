# IRSA role for the application's `fabric` ServiceAccount.
#
# Without this, the `fabric` SA has no AWS identity: the AWS SDK falls through
# the credential chain and signed-URL / object operations fail at runtime. With
# this role attached (Helm sets serviceAccount.roleArn from app_role_arn output),
# the SDK exchanges the projected SA token for STS credentials and inherits the
# role's S3 + KMS permissions below.

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.50" }
  }
}

data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${replace(var.cluster_oidc_issuer_url, "https://", "")}:sub"
      values   = ["system:serviceaccount:${var.namespace}:${var.service_account_name}"]
    }
    condition {
      test     = "StringEquals"
      variable = "${replace(var.cluster_oidc_issuer_url, "https://", "")}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = "${var.cluster_name}-app"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "app" {
  # S3 object-level operations on the 7 application buckets.
  statement {
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObjectAttributes",
      "s3:GetObjectTagging",
      "s3:PutObjectTagging",
    ]
    resources = [for arn in var.bucket_arns : "${arn}/*"]
  }

  # ListBucket / GetBucketLocation needed for presigned URL generation + general SDK behavior.
  statement {
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
      "s3:GetBucketCors",
    ]
    resources = var.bucket_arns
  }

  # SSE-KMS reads/writes need Decrypt + GenerateDataKey on the bucket-encrypting CMK.
  # Without this, every S3 PUT/GET against a CMK-encrypted bucket fails with
  # KMS.AccessDeniedException.
  statement {
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:DescribeKey",
    ]
    resources = [var.s3_kms_key_arn]
  }

  # Telemetry export. The otel-collector (awsemf / awscloudwatchlogs / awsxray
  # exporters) and Fluent Bit (cloudwatch_logs output) DaemonSets run under this
  # same `fabric` ServiceAccount, so without these actions telemetry export fails
  # with AccessDenied. Scoped to /fabric/* log groups; X-Ray and PutMetricData
  # have no resource-level permissions and must use "*". (Granting these to the
  # shared app SA is the pragmatic trade-off for the DaemonSets sharing it; a
  # dedicated observability SA + role would be the stricter alternative.)
  statement {
    sid    = "TelemetryCloudWatchLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:PutRetentionPolicy",
      "logs:DescribeLogStreams",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/fabric/*",
      "arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/fabric/*:log-stream:*",
    ]
  }

  statement {
    sid       = "TelemetryCloudWatchMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
  }

  statement {
    sid    = "TelemetryXRay"
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
      "xray:GetSamplingStatisticSummaries",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "this" {
  name   = "${var.cluster_name}-app"
  policy = data.aws_iam_policy_document.app.json
  tags   = var.tags
}

resource "aws_iam_role_policy_attachment" "this" {
  role       = aws_iam_role.this.name
  policy_arn = aws_iam_policy.this.arn
}
