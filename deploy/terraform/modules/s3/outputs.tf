output "bucket_names_map" {
  description = "Map of logical name (e.g. \"avatars\") -> fully-qualified bucket name (e.g. \"fabric-dev-12345678-avatars\")"
  value       = local.buckets
}

output "bucket_arns" {
  description = "Map of logical name -> ARN"
  value       = { for k, v in aws_s3_bucket.this : k => v.arn }
}
