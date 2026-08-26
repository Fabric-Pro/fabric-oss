output "role_arn" {
  description = "IAM role ARN — set this as the GitLab CI variable AWS_ROLE_ARN"
  value       = aws_iam_role.deployer.arn
}

output "role_name" {
  description = "IAM role name"
  value       = aws_iam_role.deployer.name
}

output "provider_arn" {
  description = "OIDC provider ARN"
  value       = aws_iam_openid_connect_provider.gitlab.arn
}
