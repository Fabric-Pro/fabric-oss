output "primary_endpoint" {
  description = "Redis primary endpoint hostname (no port). Used to construct REDIS_URL=redis://<endpoint>:6379"
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "port" {
  description = "Redis port"
  value       = aws_elasticache_replication_group.this.port
}

output "auth_token" {
  description = "Redis AUTH token (required by clients when transit_encryption_enabled = true)"
  value       = random_password.auth_token.result
  sensitive   = true
}
