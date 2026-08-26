variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "cluster_name" {
  description = "EKS cluster name (also used as VPC name + IAM role prefix)"
  type        = string
  default     = "fabric-dev"
}

variable "environment" {
  description = "Environment label (dev / staging / prod). Used in Secrets Manager paths fabric/<env>/<group>."
  type        = string
  default     = "dev"
}

variable "kubernetes_version" {
  # Pinned to 1.34 — the live fabric-dev cluster was stepped up from 1.30 and
  # stopped here (standard support, no extended-support surcharge; standard support
  # ends 2026-12-01 — more runway than 1.33's 2026-07). Latest available is 1.35; to
  # go further, bump one minor per apply (EKS forbids multi-minor jumps):
  #   for v in 1.35; do terraform apply -var kubernetes_version=$v; done
  description = "EKS Kubernetes version (standard-support release; step one minor per apply when upgrading)"
  type        = string
  default     = "1.34"
}

variable "gitlab_project_path" {
  description = "GitLab project path (e.g. \"myuser/fabric-test\"). Scopes the OIDC trust policy."
  type        = string
}

variable "gitlab_runner_token" {
  description = "GitLab runner authentication token (`glrt-…`). UNUSED since CI builds moved to GitLab SaaS runners and the in-cluster gitlab_runner module was removed; retained (optional) so re-enabling the in-cluster runner needs no tfvars change."
  type        = string
  sensitive   = true
  default     = ""
}

variable "eks_public_access_cidrs" {
  description = "CIDRs allowed to reach the public EKS API endpoint. Defaults to open (0.0.0.0/0) for dev convenience; restrict to your CI runner NAT + admin IPs for anything beyond a throwaway cluster."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "domain_name" {
  description = "Optional domain. Empty -> HTTP-only ALB; set to enable Route 53 + External DNS."
  type        = string
  default     = ""
}

variable "alert_email" {
  description = "Email for AWS Budgets alerts"
  type        = string
}

variable "web_origins" {
  description = <<-EOT
    Browser origins allowed by S3 bucket CORS for presigned PUT/GET uploads
    (avatars, workspace/project documents, etc). Set this to the PUBLIC origin
    the app is served from, or browser uploads fail the CORS preflight:
      - custom domain (domain_name set):  ["https://app.example.com"]
      - HTTP-only ALB (no domain yet):    ["http://<alb-dns-name>"]
    The ALB DNS name is assigned by AWS only AFTER the first deploy, so it is set
    by hand in terraform.tfvars once known (kubectl get ingress -n fabric). The
    localhost entries cover the Aspire dev server developing against a real S3
    bucket. Override per-environment in terraform.tfvars — see
    terraform.tfvars.example.
  EOT
  type        = list(string)
  default     = ["http://localhost:3000", "http://localhost:3001"]
}

variable "enable_k8s_addons" {
  description = <<-EOT
    Phase-2 toggle. The helm/kubernetes providers and in-cluster controllers
    (alb_controller, external_secrets, external_dns, gitlab_runner) only work
    once the EKS cluster exists. First apply: leave `false`; second apply (after
    `module.eks` is up): set to `true`. See deploy/terraform/environments/dev/README.md
    § Two-phase apply.
  EOT
  type        = bool
  default     = false
}

# --- RDS posture (dev defaults; a production deployment overrides these) ---

variable "rds_skip_final_snapshot" {
  description = "Skip the RDS final snapshot on destroy. true for a throwaway dev DB; production MUST set false (which also turns on deletion protection)."
  type        = bool
  default     = true
}

variable "rds_multi_az" {
  description = "Run RDS Multi-AZ with automatic standby failover (SOC 2 A1.2). Production sets true."
  type        = bool
  default     = false
}

variable "rds_backup_retention_period" {
  description = "Days of automated RDS backups to retain. Production sets 14-30."
  type        = number
  default     = 7
}

variable "rds_apply_immediately" {
  description = "Apply RDS changes immediately vs. in the maintenance window. Production sets false to avoid unplanned restarts."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Common tags applied to every resource"
  type        = map(string)
  default = {
    Project = "fabric"
    Env     = "dev"
  }
}
