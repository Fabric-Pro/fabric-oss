terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.50" }
    tls = { source = "hashicorp/tls", version = "~> 4.0" }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  cluster_arn = "arn:${data.aws_partition.current.partition}:eks:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:cluster/${var.cluster_name}"
}

# Fetch GitLab's TLS certificate to extract the thumbprint AWS needs for OIDC verification.
data "tls_certificate" "gitlab" {
  url = var.gitlab_url
}

resource "aws_iam_openid_connect_provider" "gitlab" {
  url             = var.gitlab_url
  client_id_list  = [var.gitlab_url]
  thumbprint_list = data.tls_certificate.gitlab.certificates[*].sha1_fingerprint
  tags            = var.tags
}

# Trust policy SCOPED to specific refs only — default-branch pushes + semver tags.
# DO NOT add a wildcard `ref:*` line — that would let any branch (including
# unmerged MR branches with push access) assume the deployer role and push to
# ECR / mutate the cluster.
#
# The branch is `master`: that is the default branch, and every AWS-touching job
# in ci/gitlab gates on `$CI_COMMIT_BRANCH == "master"` (16 of them). This
# previously read `main`, which no pipeline ever pushes to — so the first
# AWS-touching job on a real deploy would have failed AssumeRoleWithWebIdentity
# with a trust mismatch.
#
# `release` is deliberately NOT trusted. It is the production branch, but
# production deploys are triggered by a `v*` TAG with a manual gate
# (ci/gitlab/60-deploy-aws.yml), not by a push to the branch — so nothing
# AWS-touching ever runs with a `release` branch subject, and granting it would
# widen the trust for no reason.
#
# Two separate Allow statements (OR semantics): the branch statement uses
# StringEquals for exact-match (no wildcard semantics whatsoever), the tag
# statement uses StringLike specifically for the `v*` glob. Audience is
# StringEquals in both.
data "aws_iam_policy_document" "trust" {
  statement {
    sid     = "GitLabDefaultBranch"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.gitlab.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "gitlab.com:sub"
      values   = ["project_path:${var.gitlab_project_path}:ref_type:branch:ref:master"]
    }
    condition {
      test     = "StringEquals"
      variable = "gitlab.com:aud"
      values   = [var.gitlab_url]
    }
  }

  statement {
    sid     = "GitLabSemverTags"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.gitlab.arn]
    }

    condition {
      test     = "StringLike"
      variable = "gitlab.com:sub"
      values   = ["project_path:${var.gitlab_project_path}:ref_type:tag:ref:v*"]
    }
    condition {
      test     = "StringEquals"
      variable = "gitlab.com:aud"
      values   = [var.gitlab_url]
    }
  }
}

resource "aws_iam_role" "deployer" {
  name               = "FabricDeployer-${var.cluster_name}"
  assume_role_policy = data.aws_iam_policy_document.trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "deployer" {
  name = "FabricDeployer-${var.cluster_name}-inline"
  role = aws_iam_role.deployer.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ECRAuthToken"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "ECRPushPull"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:ListImages",
          "ecr:DescribeRepositories",
          "ecr:DescribeImages",
        ]
        Resource = var.ecr_arns
      },
      {
        Sid      = "EKSDescribeCluster"
        Effect   = "Allow"
        Action   = ["eks:DescribeCluster"]
        Resource = local.cluster_arn
      },
      {
        # ListClusters has no resource-level scoping in AWS — by design,
        # the only way to discover clusters is account-wide. Keep narrow.
        Sid      = "EKSListClusters"
        Effect   = "Allow"
        Action   = ["eks:ListClusters"]
        Resource = "*"
      },
      {
        Sid    = "SecretsManagerRead"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ]
        Resource = var.secret_arns
      },
    ]
  })
}

# Grant cluster-admin via EKS Access Entry (1.30+ preferred over aws-auth ConfigMap).
resource "aws_eks_access_entry" "deployer" {
  cluster_name  = var.cluster_name
  principal_arn = aws_iam_role.deployer.arn
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "deployer" {
  cluster_name  = var.cluster_name
  principal_arn = aws_iam_role.deployer.arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"

  access_scope {
    type = "cluster"
  }

  # The association targets the principal's access entry; AWS rejects it if the entry
  # does not exist yet. Neither resource references the other (both only use the IAM
  # role + cluster), so without this depends_on Terraform may attempt the association
  # before the access entry on a fresh apply.
  depends_on = [aws_eks_access_entry.deployer]
}
