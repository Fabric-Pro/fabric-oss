variable "gitlab_project_path" {
  description = "GitLab project path (e.g. \"myuser/fabric-test\"). Used in the IAM trust policy to scope role assumption."
  type        = string
}

variable "gitlab_url" {
  description = "GitLab instance URL (gitlab.com for SaaS; otherwise self-hosted)"
  type        = string
  default     = "https://gitlab.com"
}

variable "cluster_name" {
  description = "EKS cluster name — referenced for Access Entry granting"
  type        = string
}

variable "ecr_arns" {
  description = "List of ECR repository ARNs the deployer role can push to"
  type        = list(string)
}

variable "secret_arns" {
  description = "List of Secrets Manager Secret ARNs the deployer role can read (for the migrate Job's IRSA chain)"
  type        = list(string)
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
