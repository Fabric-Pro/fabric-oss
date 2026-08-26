output "endpoint" {
  description = "RDS hostname:port (use the host portion for DATABASE_URL construction)"
  value       = aws_db_instance.this.endpoint
}

output "address" {
  description = "RDS hostname only (no port)"
  value       = aws_db_instance.this.address
}

output "port" {
  description = "RDS port"
  value       = aws_db_instance.this.port
}

output "username" {
  description = "Master username"
  value       = aws_db_instance.this.username
}

output "password" {
  description = "Master password — populates fabric/<env>/database secret in env/dev wiring. Sensitive."
  value       = random_password.master.result
  sensitive   = true
}

output "db_name" {
  description = "Initial database name"
  value       = aws_db_instance.this.db_name
}
