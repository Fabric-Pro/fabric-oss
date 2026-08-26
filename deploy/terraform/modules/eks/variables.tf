variable "cluster_name" {
  description = "EKS cluster name"
  type        = string
}

variable "kubernetes_version" {
  # Keep on a STANDARD-support EKS release — extended support adds +$0.60/hr/cluster
  # (~$430/mo). As of 2026-06: 1.33-1.35 are standard support; 1.30-1.32 are
  # extended. 1.35 is the latest (standard support through 2027-03).
  #
  # NOTE: EKS upgrades one MINOR version at a time. A NEW cluster is CREATED
  # directly at this version, but an EXISTING cluster several minors behind must
  # be stepped one minor per `terraform apply` (e.g. 1.30 -> 1.31 -> 1.32 -> 1.33
  # -> 1.34 -> 1.35) — you cannot jump multiple minors in a single apply.
  description = "Kubernetes version — must be a standard-support EKS release (latest is 1.35)"
  type        = string
  default     = "1.35"
}

variable "vpc_id" {
  description = "VPC ID from the vpc module"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for EKS nodes"
  type        = list(string)
}

variable "kms_key_arn" {
  description = "KMS key ARN for cluster secrets encryption"
  type        = string
}

variable "public_access_cidrs" {
  description = "CIDRs allowed to reach the public EKS API endpoint. Defaults to open (0.0.0.0/0); restrict for non-throwaway clusters."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "node_instance_types" {
  description = "EC2 instance types for managed node group"
  type        = list(string)
  default     = ["t3.medium"]
}

variable "node_desired_size" {
  description = "Desired node count"
  type        = number
  default     = 2
}

variable "node_min_size" {
  description = "Minimum nodes"
  type        = number
  default     = 2
}

variable "node_max_size" {
  description = "Maximum nodes"
  type        = number
  default     = 4
}

variable "node_disk_size" {
  description = "Root EBS volume size (GiB) per node. 40Gi covers the OS + kubelet + the app image cache. Builds run on GitLab SaaS now, so the large Kaniko scratch space (100Gi) is no longer needed; bump back up only if builds return in-cluster."
  type        = number
  default     = 40
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
