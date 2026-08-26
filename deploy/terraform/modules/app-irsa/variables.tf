variable "cluster_name" {
  description = "EKS cluster name — used for naming the role/policy"
  type        = string
}

variable "cluster_oidc_issuer_url" {
  description = "OIDC issuer URL from the EKS cluster"
  type        = string
}

variable "oidc_provider_arn" {
  description = "OIDC provider ARN from the EKS cluster"
  type        = string
}

variable "namespace" {
  description = "Kubernetes namespace where the application ServiceAccount lives"
  type        = string
  default     = "fabric"
}

variable "service_account_name" {
  description = "Application ServiceAccount name (must match Helm serviceAccount.name)"
  type        = string
  default     = "fabric"
}

variable "bucket_arns" {
  description = "Application S3 bucket ARNs the SA can read/write"
  type        = list(string)
}

variable "s3_kms_key_arn" {
  description = "KMS CMK ARN used to encrypt the application S3 buckets — SSE-KMS reads/writes need kms:Decrypt + GenerateDataKey on this key"
  type        = string
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
