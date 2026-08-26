output "secret_arns" {
  description = "Map of group name -> Secret ARN (consumed by ESO ExternalSecret + IRSA policy)"
  value       = { for k, v in aws_secretsmanager_secret.this : k => v.arn }
}

output "secret_names" {
  description = "Map of group name -> Secret full name (e.g. fabric/dev/database)"
  value       = { for k, v in aws_secretsmanager_secret.this : k => v.name }
}
