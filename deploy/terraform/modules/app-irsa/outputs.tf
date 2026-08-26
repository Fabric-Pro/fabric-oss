output "role_arn" {
  description = "IAM role ARN — set as Helm serviceAccount.roleArn so the SA annotation flows through to app pods"
  value       = aws_iam_role.this.arn
}

output "role_name" {
  description = "IAM role name"
  value       = aws_iam_role.this.name
}
