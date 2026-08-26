variable "cluster_name" {
  description = "EKS cluster name (used in IAM role naming)"
  type        = string
}

variable "cluster_oidc_issuer_url" {
  description = "OIDC issuer URL"
  type        = string
}

variable "oidc_provider_arn" {
  description = "OIDC provider ARN"
  type        = string
}

variable "region" {
  description = "AWS region"
  type        = string
}

variable "secret_arns" {
  description = "List of Secrets Manager Secret ARNs ESO is allowed to read"
  type        = list(string)
}

variable "secrets_kms_key_arn" {
  description = "CMK ARN used to encrypt fabric/* secrets — ESO needs kms:Decrypt on it to read CMK-encrypted Secrets Manager values"
  type        = string
}

variable "chart_version" {
  description = "external-secrets-operator Helm chart version"
  type        = string
  default     = "0.10.0"
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
