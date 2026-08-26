output "cluster_name" {
  description = "EKS cluster name"
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "EKS API server endpoint"
  value       = module.eks.cluster_endpoint
}

output "cluster_certificate_authority_data" {
  description = "Base64-encoded cluster CA certificate"
  value       = module.eks.cluster_certificate_authority_data
}

output "cluster_oidc_issuer_url" {
  description = "OIDC issuer URL for IRSA"
  value       = module.eks.cluster_oidc_issuer_url
}

output "oidc_provider_arn" {
  description = "OIDC provider ARN — used by IRSA role trust policies"
  value       = module.eks.oidc_provider_arn
}

output "cluster_security_group_id" {
  description = "Cluster (control-plane) security group ID"
  value       = module.eks.cluster_security_group_id
}

output "node_security_group_id" {
  description = <<-EOT
    Node security group ID — attached to worker nodes' ENIs (incl. the VPC-CNI
    secondary ENIs that carry pod traffic). This is the source SG for pod
    egress, so RDS/ElastiCache ingress must allow THIS, not the control-plane
    cluster_security_group_id (pods do not egress from the cluster SG).
  EOT
  value       = module.eks.node_security_group_id
}
