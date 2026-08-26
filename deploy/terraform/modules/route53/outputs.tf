output "zone_id" {
  description = "Route 53 hosted zone ID (null if domain_name is empty)"
  value       = try(aws_route53_zone.this[0].zone_id, null)
}

output "name_servers" {
  description = "NS records the user must delegate from their registrar (empty list if zone not created)"
  value       = try(aws_route53_zone.this[0].name_servers, [])
}
