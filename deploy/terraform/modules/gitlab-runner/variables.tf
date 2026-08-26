variable "runner_token" {
  description = "GitLab runner authentication token (`glrt-…`) from Settings → CI/CD → Runners → New project runner. NOT a legacy registration token. Sensitive."
  type        = string
  sensitive   = true
}

variable "cluster_name" {
  description = "EKS cluster name (for IRSA role naming)"
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

variable "ecr_arns" {
  description = "List of ECR repository ARNs the runner can push to (for image builds in CI)"
  type        = list(string)
}

variable "namespace" {
  description = "Kubernetes namespace for the runner"
  type        = string
  default     = "gitlab"
}

variable "concurrent" {
  description = "Concurrent jobs the runner pod can dispatch"
  type        = number
  default     = 4
}

variable "chart_version" {
  description = "gitlab-runner Helm chart version"
  type        = string
  default     = "0.65.0"
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
