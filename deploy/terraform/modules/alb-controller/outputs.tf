output "role_arn" {
  description = "IRSA role ARN for the AWS Load Balancer Controller"
  value       = module.irsa.iam_role_arn
}

output "service_account_name" {
  description = "ServiceAccount name in kube-system"
  value       = "aws-load-balancer-controller"
}
