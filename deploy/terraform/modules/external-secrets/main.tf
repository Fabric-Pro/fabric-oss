terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.50" }
    helm       = { source = "hashicorp/helm", version = "~> 2.13" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.30" }
    null       = { source = "hashicorp/null", version = "~> 3.2" }
    local      = { source = "hashicorp/local", version = "~> 2.5" }
  }
}

# IAM policy: ESO reads Secrets Manager values, but scoped to our fabric/* secrets.
# The KMS Decrypt statement is required because fabric/* secrets are encrypted
# with a customer-managed key (modules/kms — alias "secrets"). The CMK policy
# delegates to IAM (allows root → IAM identities), so the ESO IAM role itself
# must carry kms:Decrypt on that CMK or GetSecretValue returns AccessDenied at
# the decrypt step.
data "aws_iam_policy_document" "eso" {
  statement {
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
      "secretsmanager:ListSecretVersionIds",
    ]
    resources = var.secret_arns
  }

  statement {
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [var.secrets_kms_key_arn]
  }
}

resource "aws_iam_policy" "eso" {
  name        = "fabric-${var.cluster_name}-eso"
  description = "External Secrets Operator — read fabric/* secrets"
  policy      = data.aws_iam_policy_document.eso.json
  tags        = var.tags
}

module "irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.39"

  role_name = "fabric-${var.cluster_name}-eso"

  role_policy_arns = {
    eso = aws_iam_policy.eso.arn
  }

  oidc_providers = {
    main = {
      provider_arn               = var.oidc_provider_arn
      namespace_service_accounts = ["external-secrets:external-secrets"]
    }
  }

  tags = var.tags
}

resource "kubernetes_namespace" "external_secrets" {
  metadata {
    name = "external-secrets"
  }
}

resource "helm_release" "eso" {
  name       = "external-secrets"
  repository = "https://charts.external-secrets.io"
  chart      = "external-secrets"
  version    = var.chart_version
  namespace  = kubernetes_namespace.external_secrets.metadata[0].name

  set {
    name  = "installCRDs"
    value = "true"
  }
  set {
    name  = "serviceAccount.create"
    value = "true"
  }
  set {
    name  = "serviceAccount.name"
    value = "external-secrets"
  }
  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.irsa.iam_role_arn
  }

  depends_on = [module.irsa]
}

# ClusterSecretStore named `aws-secrets-manager` — referenced by the Fabric Helm chart's ExternalSecret.
#
# Uses null_resource + local-exec (kubectl) instead of kubernetes_manifest because
# kubernetes_manifest validates the CRD schema at PLAN time. Since the ESO Helm
# chart (which registers the ClusterSecretStore CRD) hasn't run yet when Terraform
# plans, the plan-time check always fails with "CRD may not be installed".
# local-exec runs kubectl at apply time, after the Helm chart has installed the CRDs.
resource "local_file" "cluster_secret_store_manifest" {
  filename = "/tmp/fabric-cluster-secret-store.yaml"
  content  = <<-YAML
    apiVersion: external-secrets.io/v1beta1
    kind: ClusterSecretStore
    metadata:
      name: aws-secrets-manager
    spec:
      provider:
        aws:
          service: SecretsManager
          region: ${var.region}
          auth:
            jwt:
              serviceAccountRef:
                name: external-secrets
                namespace: external-secrets
    YAML
}

resource "null_resource" "cluster_secret_store" {
  triggers = {
    manifest_hash = local_file.cluster_secret_store_manifest.content_sha256
  }

  provisioner "local-exec" {
    # Sleep 30s to let ESO CRDs fully register after Helm install completes.
    command = "sleep 30 && kubectl apply -f ${local_file.cluster_secret_store_manifest.filename}"
  }

  depends_on = [helm_release.eso, local_file.cluster_secret_store_manifest]
}
