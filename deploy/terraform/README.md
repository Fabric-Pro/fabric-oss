# Fabric — Terraform reference modules

Provisions the AWS infrastructure for Fabric on EKS. Modules live in `modules/`, environment wiring lives in `environments/`.

## Modules

| Module | Purpose |
|---|---|
| `vpc` | VPC + public/private subnets + NAT GW with EKS-discovery tags |
| `kms` | Customer-managed keys for EKS / RDS / S3 / Secrets Manager / ECR |
| `eks` | EKS cluster + managed node group + OIDC provider (dev: t3.large x2, 40Gi root volumes) |
| `rds` | Postgres 16 with `random_password` (populates `fabric/<env>/database` via env-wiring) |
| `elasticache` | Redis 7.1 (single AZ for dev) |
| `ecr` | 14 container repos with lifecycle policies |
| `s3` | 7 application buckets (KMS-encrypted, CORS-enabled, account-prefixed for global uniqueness) |
| `secrets` | Secrets Manager skeletons for 15 secret groups (database, auth, ai-providers, oauth, integrations, redis, temporal, cloudflare, storage, email, payments, qdrant, agents, upstash, databricks) |
| `alb-controller` | AWS Load Balancer Controller (Helm + IRSA) |
| `external-secrets` | External Secrets Operator + ClusterSecretStore (Helm + IRSA) |
| `app-irsa` | IRSA role for the application `fabric` ServiceAccount (S3 access without static keys; ARN exported as `APP_IRSA_ROLE_ARN` for CI) |
| `external-dns` | External DNS — only when a Route 53 hosted zone is configured |
| `route53` | Optional Route 53 hosted zone |
| `gitlab-oidc` | IAM OIDC provider for GitLab + `FabricDeployer` role (scoped trust policy) |
| `gitlab-runner` | Self-hosted GitLab Runner on EKS (Helm + IRSA) |
| `budgets` | AWS Budgets with email alerts |

## Environments

- `environments/dev/` — minimal personal-test configuration (single-AZ, smallest instance tiers, destroy-friendly). See `environments/dev/README.md` for setup.

Production-shape environment (`environments/prod/`) is not provided in MVP. Pattern: copy `environments/dev`, flip the destroy-friendly flags, increase replica/instance counts.

## Provider versions

`.terraform.lock.hcl` files are intentionally not committed (`deploy/terraform/.gitignore`). Providers resolve unpinned within the version constraints declared in each module; `terraform init` generates a local lockfile on first run. If you need reproducible provider resolution across machines, commit the lockfile your `terraform init` produces in your own fork.

## State backend

S3 + DynamoDB locking. Bootstrap once per account with `bootstrap.sh`.
