variable "cluster_name" {
  description = "EKS cluster name"
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

variable "hosted_zone_id" {
  description = "Route 53 hosted zone ID. If null/empty, the module is a no-op."
  type        = string
  default     = null
}

variable "domain_filter" {
  description = "Domain filter (e.g. \"fabric.example.com\") — required when hosted_zone_id is set"
  type        = string
  default     = ""
}

variable "chart_version" {
  description = "external-dns Helm chart version"
  type        = string
  default     = "1.14.5"
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
