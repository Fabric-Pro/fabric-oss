output "role_arn" {
  description = "IRSA role ARN for ESO"
  value       = module.irsa.iam_role_arn
}

output "cluster_secret_store_name" {
  description = "ClusterSecretStore resource name — matches the Fabric Helm chart's externalSecrets.secretStore default"
  value       = "aws-secrets-manager"
}

output "namespace" {
  description = "Namespace ESO is installed in"
  value       = kubernetes_namespace.external_secrets.metadata[0].name
}
