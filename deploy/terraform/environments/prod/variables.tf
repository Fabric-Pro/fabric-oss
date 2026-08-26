# =============================================================================
# Production Terraform profile — variables (SOC 2, card 1721 FR-2)
# =============================================================================
# This is the SEPARATE, explicitly-labeled production profile (distinct from
# environments/dev, the dev/MVP profile). Defaults here encode a PRODUCTION
# posture: Multi-AZ RDS with failover, deletion protection, a restricted EKS
# endpoint, retained backups, and no force-destroy. Values that MUST be chosen
# per deployment (endpoint allowlist, domain, alert email, GitLab path) have NO
# default, so `terraform plan` fails fast rather than provisioning an insecure
# default. No secrets are ever hardcoded here (see README §Secrets).

variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "cluster_name" {
  description = "EKS cluster name (also used as VPC name + IAM role prefix)"
  type        = string
  default     = "fabric-prod"
}

variable "environment" {
  description = "Environment label. Used in Secrets Manager paths fabric/<env>/<group>."
  type        = string
  default     = "prod"
}

variable "kubernetes_version" {
  description = "EKS Kubernetes version (standard-support release; step one minor per apply when upgrading)"
  type        = string
  default     = "1.34"
}

variable "gitlab_project_path" {
  description = "GitLab project path (e.g. \"myuser/fabric\"). Scopes the OIDC trust policy. Required."
  type        = string
}

variable "gitlab_runner_token" {
  description = "GitLab runner authentication token (`glrt-…`). UNUSED since CI builds moved to GitLab SaaS runners; retained (optional) so re-enabling the in-cluster runner needs no tfvars change."
  type        = string
  sensitive   = true
  default     = ""
}

variable "eks_public_access_cidrs" {
  description = "CIDRs allowed to reach the public EKS API endpoint. REQUIRED in production — restrict to the operator/admin + CI-runner NAT egress IPs. Open access (0.0.0.0/0) is not permitted for a production cluster (SOC 2 CC6.6). Set to [] to make the endpoint private-only if you operate via VPN/bastion."
  type        = list(string)
  # No default: production MUST make an explicit, restricted choice.
}

variable "domain_name" {
  description = "Public domain for the deployment (e.g. \"app.customer.com\"). REQUIRED in production: it provisions the Route 53 zone + ACM certificate that terminate TLS at the ALB, so there is no HTTP-only listener (SOC 2 CC6.7 / FR-2 'no HTTP-only listener')."
  type        = string
}

variable "alert_email" {
  description = "Email for AWS Budgets + operational alerts. Required."
  type        = string
}

variable "web_origins" {
  description = "Browser origins allowed by S3 bucket CORS for presigned uploads. In production this is the app's HTTPS origin, e.g. [\"https://app.customer.com\"]. Defaults to empty — set it in terraform.tfvars once the domain is live, or in-app uploads fail CORS preflight."
  type        = list(string)
  default     = []
}

variable "enable_k8s_addons" {
  description = <<-EOT
    Phase-2 toggle. The helm/kubernetes providers and in-cluster controllers
    (alb_controller, external_secrets, external_dns) only work once the EKS
    cluster exists. First apply: leave `false`; second apply (after `module.eks`
    is up): set to `true`. See README § Two-phase apply.
  EOT
  type        = bool
  default     = false
}

# --- RDS posture: production defaults (SOC 2 A1.2 availability + backup) ---

variable "rds_multi_az" {
  description = "Run RDS Multi-AZ with an automatic standby failover (SOC 2 A1.2). Production default: true."
  type        = bool
  default     = true
}

variable "rds_backup_retention_period" {
  description = "Days of automated RDS backups (point-in-time recovery window) to retain. Production default: 30. RDS caps this at 35."
  type        = number
  default     = 30
}

variable "rds_apply_immediately" {
  description = "Apply RDS modifications immediately vs. during the maintenance window. Production default: false, so changes never trigger an unplanned restart."
  type        = bool
  default     = false
}

variable "node_instance_types" {
  description = "EC2 instance types for the EKS managed node group."
  type        = list(string)
  default     = ["t3.xlarge"]
}

variable "node_desired_size" {
  description = "Desired node count. Production default 3 spreads the app tier across AZs for HA (SOC 2 A1.2)."
  type        = number
  default     = 3
}

variable "node_min_size" {
  description = "Minimum node count. Production default 3 keeps at least one node per AZ."
  type        = number
  default     = 3
}

variable "node_max_size" {
  description = "Maximum node count for surge during rolling updates / autoscaling."
  type        = number
  default     = 6
}

variable "tags" {
  description = "Common tags applied to every resource"
  type        = map(string)
  default = {
    Project = "fabric"
    Env     = "prod"
  }
}
