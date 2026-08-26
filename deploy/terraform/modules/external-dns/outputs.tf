output "role_arn" {
  description = "IRSA role ARN (null when hosted_zone_id is not set)"
  value       = local.enabled ? module.irsa.iam_role_arn : null
}

output "enabled" {
  description = "Whether External DNS is installed"
  value       = local.enabled
}
