output "runner_role_arn" {
  description = "IRSA role ARN for the runner"
  value       = module.irsa.iam_role_arn
}

output "namespace" {
  description = "Namespace the runner is installed in"
  value       = kubernetes_namespace.runner.metadata[0].name
}
