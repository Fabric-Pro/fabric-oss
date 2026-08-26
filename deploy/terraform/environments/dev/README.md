# `fabric-dev` Terraform environment

End-to-end provisioning of the Fabric stack on AWS: VPC + EKS + RDS + ElastiCache + ECR + S3 + Secrets Manager + cluster controllers + GitLab CI/CD wiring.

## Prerequisites

- AWS account + CLI configured with credentials (`aws sts get-caller-identity` works)
- Terraform 1.7+
- `kubectl` 1.34+ (within ±1 minor of the 1.35 cluster)
- `helm` 3.14+
- A GitLab project (your fork of this repo)
- A GitLab runner authentication token (`glrt-…` ; Settings -> CI/CD -> Runners -> New project runner). This is the modern auth token, not a legacy registration token.

## One-time state backend setup

The S3 + DynamoDB backend must exist before the first `terraform init`. Use the bootstrap script:

```bash
cd deploy/terraform
./bootstrap.sh
```

The script creates `fabric-tfstate-<ACCOUNT_ID>` (S3) and `fabric-tfstate-lock` (DynamoDB) with versioning + SSE on the bucket.

## Init + apply (two-phase)

The Helm and Kubernetes providers reference `module.eks.cluster_endpoint`, which is unknown before the cluster exists. So the in-cluster modules are gated behind `var.enable_k8s_addons` (default `false`): the first apply provisions the foundational AWS infra with the addons disabled (count=0, providers never connect), then a second apply enables them once the cluster is healthy:

```bash
cd environments/dev
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — fill in gitlab_project_path, gitlab_runner_token, alert_email

terraform init \
  -backend-config="bucket=fabric-tfstate-$(aws sts get-caller-identity --query Account --output text)" \
  -backend-config="key=dev/terraform.tfstate" \
  -backend-config="region=us-east-1" \
  -backend-config="dynamodb_table=fabric-tfstate-lock" \
  -backend-config="encrypt=true"

# Phase 1 — foundational AWS infra (enable_k8s_addons defaults to false, so the in-cluster
# helm/kubernetes modules are count=0 and those providers never connect)
terraform apply

# Phase 2 — cluster controllers + remaining wiring, once the cluster is healthy
terraform apply -var enable_k8s_addons=true

# Subsequent applies: single `terraform apply` works — cluster endpoint is known.
```

## Capturing outputs for GitLab CI / Helm

```bash
terraform output -raw deployer_role_arn         # -> GitLab CI variable DEPLOYER_ROLE_ARN (NOT AWS_ROLE_ARN — that name is a reserved AWS SDK IRSA var and shadows the Kaniko build pods' web-identity role)
terraform output -raw ecr_registry_url          # -> GitLab CI variable ECR_REGISTRY
terraform output -raw app_irsa_role_arn         # -> GitLab CI variable APP_IRSA_ROLE_ARN (required after Phase 2 — deploy job refuses to run if unset)
terraform output -raw cluster_name              # -> GitLab CI variable CLUSTER_NAME
terraform output -raw region                    # -> GitLab CI variable AWS_REGION

# Note: CLUSTER_NAME (fabric-dev) and AWS_REGION (us-east-1) are pre-pinned as defaults in
# ci/gitlab/00-variables.yml — they only need to be set for a non-default environment.

# Helm environment wiring — set as GitLab CI/CD variables, NOT edited into
# values-dev.yaml (see deploy/helm/fabric/README.md "Environment wiring"):
terraform output -raw app_irsa_role_arn         # -> APP_IRSA_ROLE_ARN
terraform output -json s3_buckets                # -> S3_BUCKET_PREFIX (the shared "<prefix>-" leader)
# elasticache_endpoint is informational only — REDIS_URL ships via Secrets Manager.
```

## Filling Secrets Manager (everything except the auto-populated groups)

Terraform auto-populates `fabric/dev/{database, redis, qdrant, agents}` (database from the RDS outputs; redis from ElastiCache; qdrant and agents from generated keys). The remaining 10 of the 14 secret groups (auth, ai-providers, oauth, integrations, temporal, cloudflare, storage, email, payments, upstash) must be populated by you. See `docs/deployment/BOOTSTRAP.md` for the `aws secretsmanager put-secret-value` commands per group.

> **Note:** The `fabric/dev/temporal` secret MUST use the JSON key `TEMPORAL_CLOUD_API_KEY` (not `TEMPORAL_API_KEY`) — that is the exact env var `packages/temporal/src/client.ts` reads; the wrong name crash-loops the temporal worker.

## Storage

The dev cluster ships no default StorageClass (only an unmarked `gp2`), so PVCs (e.g. qdrant) must pin `storageClassName: gp2` in `values-dev.yaml`. TODO: add a default `gp3` (`ebs.csi.aws.com`) StorageClass in terraform.

## Teardown

```bash
terraform destroy
```

All dev resources are set to destroy-friendly (`force_destroy`, `force_delete`, `skip_final_snapshot`, `recovery_window_in_days = 0`). Total uptime cost: ~$0.31/hour while running.
