terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.50" }
    helm       = { source = "hashicorp/helm", version = "~> 2.13" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.30" }
  }
}

resource "kubernetes_namespace" "runner" {
  metadata {
    name = var.namespace
  }
}

# IRSA: the runner's SA gets direct ECR push permissions so build jobs don't have to
# re-assume the deployer role per job.
data "aws_iam_policy_document" "runner" {
  statement {
    effect = "Allow"
    actions = [
      "ecr:GetAuthorizationToken",
    ]
    resources = ["*"]
  }
  statement {
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
    ]
    resources = var.ecr_arns
  }
}

resource "aws_iam_policy" "runner" {
  name        = "fabric-${var.cluster_name}-gitlab-runner"
  description = "GitLab Runner — ECR push for fabric repos"
  policy      = data.aws_iam_policy_document.runner.json
  tags        = var.tags
}

module "irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.39"

  role_name = "fabric-${var.cluster_name}-gitlab-runner"

  role_policy_arns = {
    runner = aws_iam_policy.runner.arn
  }

  oidc_providers = {
    main = {
      provider_arn               = var.oidc_provider_arn
      namespace_service_accounts = ["${var.namespace}:gitlab-runner"]
    }
  }

  tags = var.tags
}

resource "helm_release" "this" {
  name       = "gitlab-runner"
  repository = "https://charts.gitlab.io"
  chart      = "gitlab-runner"
  version    = var.chart_version
  namespace  = kubernetes_namespace.runner.metadata[0].name

  set {
    name  = "gitlabUrl"
    value = "https://gitlab.com/"
  }
  # Use `runnerToken` (the runner authentication token, `glrt-…`, from the
  # "New project runner" UI), NOT the deprecated `runnerRegistrationToken`.
  # GitLab.com disabled the legacy registration-token workflow (16.0) and it is
  # removed in 17.0 — wiring a `glrt-` token into runnerRegistrationToken fails
  # registration and the pod crashloops.
  set_sensitive {
    name  = "runnerToken"
    value = var.runner_token
  }
  set {
    name  = "concurrent"
    value = var.concurrent
  }
  set {
    name  = "rbac.create"
    value = "true"
  }
  set {
    name  = "serviceAccount.create"
    value = "true"
  }
  set {
    name  = "serviceAccount.name"
    value = "gitlab-runner"
  }
  # The gitlab-runner chart (v0.65.x) reads ServiceAccount annotations from
  # rbac.serviceAccountAnnotations, NOT serviceAccount.annotations — the latter
  # is silently ignored, so the SA gets no eks.amazonaws.com/role-arn and build
  # pods fall back to the EKS node-group instance role (ECR push → AccessDenied
  # on ecr:InitiateLayerUpload).
  set {
    name  = "rbac.serviceAccountAnnotations.eks\\.amazonaws\\.com/role-arn"
    value = module.irsa.iam_role_arn
  }
  # runners.config and runners.tags are passed via values (YAML -f) rather than
  # set (--set) because runners.config is a multi-line TOML block; --set cannot
  # handle multi-line values or values containing commas reliably.
  # NOTE: privileged mode is intentionally OFF — builds use Kaniko (user-space,
  # no docker-in-docker) with ECR auth via the runner's IRSA role.
  # service_account pins build pods to the gitlab-runner SA so they inherit the
  # IRSA role-arn annotation; without it Kaniko's ecr-login has no web-identity
  # token and ECR push fails.
  values = [
    <<-VALUES
      runners:
        tags: "fabric-runner"
        config: |
          [[runners]]
            [runners.kubernetes]
              namespace = "${var.namespace}"
              image = "alpine:3.19"
              poll_timeout = 600
              service_account = "gitlab-runner"
      VALUES
  ]

  depends_on = [module.irsa]
}
