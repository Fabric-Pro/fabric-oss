data "aws_caller_identity" "current" {}

provider "aws" {
  region = var.region
}

# helm + kubernetes providers use `exec` (not a static token) so the auth token
# is re-fetched per API call rather than baked in at plan time — applies can run
# longer than the 15-minute EKS token lifetime without breaking midway.
#
# Provider configuration is lazy: as long as no helm_release / kubernetes_* resource
# is in the plan (Phase-1 apply with var.enable_k8s_addons = false), these blocks
# never connect, so the empty cluster_endpoint on first apply is harmless.

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.region]
    }
  }
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.region]
  }
}

# --- Foundational AWS resources (Phase 1 of two-phase apply) ---

module "vpc" {
  source       = "../../modules/vpc"
  region       = var.region
  cluster_name = var.cluster_name
  tags         = var.tags
}

module "kms" {
  source      = "../../modules/kms"
  key_aliases = ["eks", "rds", "s3", "secrets", "ecr"]
  tags        = var.tags
}

module "eks" {
  source             = "../../modules/eks"
  cluster_name       = var.cluster_name
  kubernetes_version = var.kubernetes_version
  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  kms_key_arn        = module.kms.key_arns["eks"]
  # Builds run on GitLab SaaS now (not in-cluster), so the node group is sized for the
  # APP workload alone. Live pod requests total ~2.4 vCPU / ~5Gi and real usage ~8-10Gi
  # (web + temporal-worker at ~1.5Gi each dominate). 2 x t3.large (~3.9 vCPU / ~14Gi
  # allocatable) fits with headroom; max=4 lets the managed node group surge during
  # rolling updates and leaves room for a future cluster-autoscaler.
  node_instance_types = ["t3.large"]
  node_desired_size   = 2
  node_min_size       = 2
  node_max_size       = 4
  public_access_cidrs = var.eks_public_access_cidrs
  tags                = var.tags
}

module "rds" {
  source     = "../../modules/rds"
  identifier = "${var.cluster_name}-pg"
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids
  # Node SG, not cluster (control-plane) SG: pod traffic egresses from the
  # worker-node ENIs, so that is the source SG Postgres ingress must allow.
  eks_security_group_id = module.eks.node_security_group_id
  kms_key_arn           = module.kms.key_arns["rds"]
  skip_final_snapshot   = var.rds_skip_final_snapshot
  # HA + backup posture. Defaults match dev (single-AZ, 7-day, apply-now); a
  # production deployment sets rds_multi_az=true, a longer retention, and
  # rds_apply_immediately=false in its tfvars (SOC 2 A1.2). See the reference
  # architecture: docs/compliance/soc2/self-hosted/03-production-reference-architecture.md.
  multi_az                = var.rds_multi_az
  backup_retention_period = var.rds_backup_retention_period
  apply_immediately       = var.rds_apply_immediately
  tags                    = var.tags
}

module "elasticache" {
  source     = "../../modules/elasticache"
  name       = "${var.cluster_name}-redis"
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids
  # Node SG (see rds module note) — pods egress from the node ENIs, so Redis
  # ingress must allow the node SG, not the control-plane cluster SG.
  eks_security_group_id = module.eks.node_security_group_id
  tags                  = var.tags
}

module "ecr" {
  source = "../../modules/ecr"
  repository_names = [
    "fabric-web",
    "fabric-temporal-worker",
    "fabric-mcp-stdio-wrapper",
    "fabric-document-generator",
    "fabric-project-document-generator",
    "fabric-task-planner",
    "fabric-story-breakdown",
    "fabric-api-agent",
    "fabric-prompt-enhancer",
    "fabric-data-analyst",
    "fabric-backlog-updater",
    "fabric-weave-readers",
    "fabric-weave-shuttle",
    "fabric-weave-planners",
  ]
  kms_key_arn  = module.kms.key_arns["ecr"]
  force_delete = true # dev convenience
  tags         = var.tags
}

module "s3" {
  source          = "../../modules/s3"
  environment     = var.environment
  bucket_prefix   = "fabric-${var.environment}-${substr(data.aws_caller_identity.current.account_id, 0, 8)}"
  kms_key_arn     = module.kms.key_arns["s3"]
  force_destroy   = true # dev convenience
  allowed_origins = var.web_origins
  tags            = var.tags
}

module "secrets" {
  source                  = "../../modules/secrets"
  environment             = var.environment
  kms_key_arn             = module.kms.key_arns["secrets"]
  recovery_window_in_days = 0 # immediate delete for dev — prod must use >=7
  tags                    = var.tags
}

# --- RDS-derived DATABASE_URL population in Secrets Manager ---
# CRITICAL: without this, the fabric/dev/database secret stays {} and every pod CrashLoops.
locals {
  database_url = format(
    "postgresql://%s:%s@%s/%s?schema=public",
    module.rds.username,
    module.rds.password,
    module.rds.endpoint,
    module.rds.db_name,
  )
}

resource "aws_secretsmanager_secret_version" "database" {
  secret_id = module.secrets.secret_arns["database"]
  secret_string = jsonencode({
    DATABASE_URL = local.database_url
    # Prisma requires DIRECT_URL too; identical to DATABASE_URL for non-pgbouncer setups.
    DIRECT_URL = local.database_url
  })

  lifecycle {
    # Subsequent updates via aws CLI / console should NOT be reverted by terraform apply.
    ignore_changes = [secret_string]
  }

  depends_on = [module.rds, module.secrets]
}

# --- Dedicated BYPASSRLS worker-role credentials ---
# The Temporal worker uses raw Prisma (`db`) with no per-request tenant context,
# so under FORCE RLS it sees zero rows as the app role. The apply-rls-direct.ts
# step (migrate hook) creates a `fabric_worker` LOGIN role WITH BYPASSRLS using
# WORKER_DB_PASSWORD; the worker pod connects via WORKER_DATABASE_URL. The app
# role (fabric) stays RLS-enforced. Gated by Helm temporalWorker.bypassRlsRole.
resource "random_password" "worker_db" {
  length  = 48
  special = false # alphanumeric — safe to embed in the CREATE ROLE SQL literal
}

resource "aws_secretsmanager_secret_version" "database_worker" {
  secret_id = module.secrets.secret_arns["database-worker"]
  secret_string = jsonencode({
    # Distinct key names (NOT DATABASE_URL): the migrate hook extracts both this
    # and the app `database` secret, and must keep the privileged `fabric`
    # DATABASE_URL for running migrations + creating the role.
    WORKER_DATABASE_URL = format(
      "postgresql://fabric_worker:%s@%s/%s?schema=public",
      random_password.worker_db.result,
      module.rds.endpoint,
      module.rds.db_name,
    )
    WORKER_DB_PASSWORD = random_password.worker_db.result
  })

  lifecycle {
    ignore_changes = [secret_string]
  }

  depends_on = [module.rds, module.secrets]
}

# REDIS_URL uses rediss:// (TLS) because transit_encryption_enabled = true on ElastiCache.
# Default-user AUTH via `default:<token>@` works with the ioredis / node-redis clients.
locals {
  redis_url = format(
    "rediss://default:%s@%s:%s",
    module.elasticache.auth_token,
    module.elasticache.primary_endpoint,
    module.elasticache.port,
  )
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id = module.secrets.secret_arns["redis"]
  secret_string = jsonencode({
    REDIS_URL = local.redis_url
  })

  lifecycle {
    ignore_changes = [secret_string]
  }

  depends_on = [module.elasticache, module.secrets]
}

# --- Self-hosted Qdrant API key ---
# Generated once, stored in fabric/<env>/qdrant. The qdrant StatefulSet reads
# it as QDRANT__SERVICE__API_KEY; app pods read it as QDRANT_API_KEY (both
# resolve to the same JSON key — see Helm StatefulSet env wiring).
resource "random_password" "qdrant_api_key" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret_version" "qdrant" {
  secret_id = module.secrets.secret_arns["qdrant"]
  secret_string = jsonencode({
    QDRANT_API_KEY = random_password.qdrant_api_key.result
  })

  lifecycle {
    ignore_changes = [secret_string]
  }

  depends_on = [module.secrets]
}

# --- Agent-to-server auth secrets ---
# AGENT_API_KEY      : signed by /api/copilotkit (web) and project-document-generation
#                      activity (temporal-worker); validated by every LangGraph agent
#                      container. Without it agents return 401 and CopilotKit + Temporal
#                      document generation flows are broken.
# AI_TOKEN_SECRET    : used by /api/copilotkit/route.ts to mint per-request AI tokens
#                      consumed by agents. Without it the CopilotKit endpoint refuses to
#                      issue tokens.
# COLLAB_JWT_SECRET  : signs PartyKit collaboration JWTs (apps/web/app/api/collab/*).
#                      Without it real-time collaboration tokens fail verification.
#
# Generated once per env, stored together in fabric/<env>/agents, synced into every pod
# by the ExternalSecret. `ignore_changes` lets operators rotate the JSON without TF
# fighting them on the next apply.
resource "random_password" "agent_api_key" {
  length  = 48
  special = false
}

resource "random_password" "ai_token_secret" {
  length  = 48
  special = false
}

resource "random_password" "collab_jwt_secret" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret_version" "agents" {
  secret_id = module.secrets.secret_arns["agents"]
  secret_string = jsonencode({
    AGENT_API_KEY     = random_password.agent_api_key.result
    AI_TOKEN_SECRET   = random_password.ai_token_secret.result
    COLLAB_JWT_SECRET = random_password.collab_jwt_secret.result
  })

  lifecycle {
    ignore_changes = [secret_string]
  }

  depends_on = [module.secrets]
}

# --- Cluster controllers (Phase 2 of two-phase apply — needs cluster up first) ---
# Each module is gated with `count = var.enable_k8s_addons ? 1 : 0`. The first
# `terraform apply` runs with enable_k8s_addons = false (default), provisioning
# AWS resources only. The second apply, after the cluster is healthy, sets
# enable_k8s_addons = true and provisions the in-cluster helm releases.

module "alb_controller" {
  count                   = var.enable_k8s_addons ? 1 : 0
  source                  = "../../modules/alb-controller"
  cluster_name            = module.eks.cluster_name
  cluster_oidc_issuer_url = module.eks.cluster_oidc_issuer_url
  oidc_provider_arn       = module.eks.oidc_provider_arn
  vpc_id                  = module.vpc.vpc_id
  region                  = var.region
  tags                    = var.tags
}

module "external_secrets" {
  count                   = var.enable_k8s_addons ? 1 : 0
  source                  = "../../modules/external-secrets"
  cluster_name            = module.eks.cluster_name
  cluster_oidc_issuer_url = module.eks.cluster_oidc_issuer_url
  oidc_provider_arn       = module.eks.oidc_provider_arn
  region                  = var.region
  secret_arns             = values(module.secrets.secret_arns)
  secrets_kms_key_arn     = module.kms.key_arns["secrets"]
  tags                    = var.tags
}

# IRSA role for the application `fabric` ServiceAccount. CI passes the role_arn
# output as Helm serviceAccount.roleArn so app pods can hit S3 without static keys.
module "app_irsa" {
  count                   = var.enable_k8s_addons ? 1 : 0
  source                  = "../../modules/app-irsa"
  cluster_name            = module.eks.cluster_name
  cluster_oidc_issuer_url = module.eks.cluster_oidc_issuer_url
  oidc_provider_arn       = module.eks.oidc_provider_arn
  bucket_arns             = values(module.s3.bucket_arns)
  s3_kms_key_arn          = module.kms.key_arns["s3"]
  tags                    = var.tags
}

# Route 53 zone is a Phase-1 resource (pure AWS, no cluster dependency).
module "route53" {
  source      = "../../modules/route53"
  domain_name = var.domain_name
  create_zone = var.domain_name != ""
  tags        = var.tags
}

module "external_dns" {
  count                   = var.enable_k8s_addons ? 1 : 0
  source                  = "../../modules/external-dns"
  cluster_name            = module.eks.cluster_name
  cluster_oidc_issuer_url = module.eks.cluster_oidc_issuer_url
  oidc_provider_arn       = module.eks.oidc_provider_arn
  hosted_zone_id          = module.route53.zone_id # nullable; module no-ops when null
  domain_filter           = var.domain_name
  tags                    = var.tags
}

# --- CI/CD wiring ---

module "gitlab_oidc" {
  source              = "../../modules/gitlab-oidc"
  gitlab_project_path = var.gitlab_project_path
  cluster_name        = module.eks.cluster_name
  ecr_arns            = values(module.ecr.repository_arns)
  secret_arns         = values(module.secrets.secret_arns)
  tags                = var.tags
}

# In-cluster GitLab Runner removed: CI image builds moved to GitLab SaaS shared runners
# (ci/gitlab/40-build.yml), so the cluster no longer hosts the build storm — which is
# why the node group could shrink to 2 x t3.large. The module code is retained under
# modules/gitlab-runner for re-enabling if builds ever move back in-cluster.

# --- Cost guardrails ---

module "budgets" {
  source     = "../../modules/budgets"
  email      = var.alert_email
  thresholds = [50, 100, 200]
  tags       = var.tags
}
