terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws  = { source = "hashicorp/aws", version = "~> 5.50" }
    helm = { source = "hashicorp/helm", version = "~> 2.13" }
  }
}

locals {
  enabled = var.hosted_zone_id != null && var.hosted_zone_id != ""
}

data "aws_iam_policy_document" "external_dns" {
  count = local.enabled ? 1 : 0

  statement {
    effect = "Allow"
    actions = [
      "route53:ChangeResourceRecordSets",
    ]
    resources = ["arn:aws:route53:::hostedzone/${var.hosted_zone_id}"]
  }
  statement {
    effect = "Allow"
    actions = [
      "route53:ListHostedZones",
      "route53:ListResourceRecordSets",
      "route53:ListTagsForResource",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "external_dns" {
  count = local.enabled ? 1 : 0

  name        = "fabric-${var.cluster_name}-external-dns"
  description = "External DNS — manage Route 53 records for ${var.domain_filter}"
  policy      = data.aws_iam_policy_document.external_dns[0].json
  tags        = var.tags
}

module "irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.39"

  create_role = local.enabled
  role_name   = "fabric-${var.cluster_name}-external-dns"

  role_policy_arns = local.enabled ? { dns = aws_iam_policy.external_dns[0].arn } : {}

  oidc_providers = {
    main = {
      provider_arn               = var.oidc_provider_arn
      namespace_service_accounts = ["kube-system:external-dns"]
    }
  }

  tags = var.tags
}

resource "helm_release" "this" {
  count = local.enabled ? 1 : 0

  name       = "external-dns"
  repository = "https://kubernetes-sigs.github.io/external-dns/"
  chart      = "external-dns"
  version    = var.chart_version
  namespace  = "kube-system"

  set {
    name  = "provider"
    value = "aws"
  }
  set {
    name  = "domainFilters[0]"
    value = var.domain_filter
  }
  set {
    name  = "txtOwnerId"
    value = var.cluster_name
  }
  set {
    name  = "serviceAccount.create"
    value = "true"
  }
  set {
    name  = "serviceAccount.name"
    value = "external-dns"
  }
  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.irsa.iam_role_arn
  }
  set {
    name  = "policy"
    value = "sync" # also delete records when Ingress is deleted — appropriate for dev
  }

  depends_on = [module.irsa]
}
