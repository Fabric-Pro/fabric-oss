variable "cluster_name" {
  description = "EKS cluster name"
  type        = string
}

variable "cluster_oidc_issuer_url" {
  description = "EKS OIDC issuer URL (from eks module output)"
  type        = string
}

variable "oidc_provider_arn" {
  description = "EKS OIDC provider ARN"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID (passed to the controller's vpcId Helm value)"
  type        = string
}

variable "region" {
  description = "AWS region"
  type        = string
}

variable "controller_version" {
  description = "AWS Load Balancer Controller chart version"
  type        = string
  default     = "1.7.2"
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
