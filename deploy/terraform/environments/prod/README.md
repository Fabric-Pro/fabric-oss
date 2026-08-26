# Production Terraform profile (self-hosted Fabric)

The **separate, explicitly-labeled production profile** for a self-hosted Fabric
deployment on AWS (SOC 2 card 1721, **FR-2**). It is distinct from
[`../dev`](../dev) (the dev/MVP profile) and encodes a hardened production
posture by default.

It reuses the **same shared modules** as dev (`../../modules/*`) so the resource
logic never drifts between environments — only the *composition values* differ.

## How this profile satisfies FR-2

| FR-2 requirement | How it is enforced here |
|---|---|
| Separate, explicitly-labeled profile | This `environments/prod/` directory + prod state key (`key=prod/terraform.tfstate`). |
| **TLS termination** | `domain_name` is **required** (no default) → `module.route53` creates the zone + the ALB-controller provisions an ACM cert that terminates TLS at the ALB. The Helm `values-prod.yaml` sets `ingress.tls: true`. |
| **No HTTP-only listener** | Because `domain_name` is mandatory, there is always an HTTPS listener; the ingress uses `ssl-redirect` (443) so port-80 requests are redirected, never served. |
| **HA deployment (≥ app tier)** | RDS `multi_az = true` (automatic standby failover); EKS node group `desired = 3` spread across AZs; Helm `values-prod.yaml` runs every service at `replicas: 2`. |
| **Backup / DR hooks** | RDS automated backups `backup_retention_period = 30` (30-day PITR) + `skip_final_snapshot = false` (final snapshot on destroy) + deletion protection; Secrets Manager `recovery_window_in_days = 7`; S3/ECR `force_destroy`/`force_delete = false`. |
| **No hardcoded credentials / env files** | Zero secrets in this profile. Every app secret (DB URL, worker role, Redis, Qdrant, agent keys) is generated at apply time by `random_password` and written to Secrets Manager; `terraform.tfvars` is gitignored and carries only non-sensitive config. Enforced in CI by TruffleHog. |
| Restricted control plane | `eks_public_access_cidrs` is **required** (no `0.0.0.0/0` default) — restrict to operator/CI egress, or `[]` for a private-only endpoint. |

## What differs from `../dev`

| | dev | prod |
|---|---|---|
| RDS Multi-AZ | off | **on** |
| RDS backups | 7 days | **30 days** |
| RDS deletion protection | off (`skip_final_snapshot=true`) | **on** (`false`) |
| RDS changes | apply immediately | **maintenance window** |
| EKS endpoint | open (`0.0.0.0/0`) | **restricted (required)** |
| Domain / TLS | optional (HTTP-only allowed) | **required (HTTPS)** |
| Nodes | 2 × t3.large | **3 × t3.xlarge (AZ-spread)** |
| ECR `force_delete` / S3 `force_destroy` | true | **false** |
| Secrets recovery window | 0 (immediate) | **7 days** |

## Applying (two-phase, same as dev)

```bash
# 0. Bootstrap the state backend once (deploy/terraform/bootstrap.sh).
# 1. Init with the PROD state key:
terraform init \
  -backend-config="bucket=fabric-tfstate-<ACCOUNT_ID>" \
  -backend-config="key=prod/terraform.tfstate" \
  -backend-config="region=<REGION>" \
  -backend-config="dynamodb_table=fabric-tfstate-lock" \
  -backend-config="encrypt=true"

# 2. Phase 1 — foundational AWS infra (enable_k8s_addons defaults to false):
terraform apply

# 3. Phase 2 — after the cluster is healthy, provision in-cluster controllers:
terraform apply -var enable_k8s_addons=true
```

Then set the `terraform output` values as GitLab CI/CD variables — **not** in
`values-prod.yaml`, which carries sizing and profile only (see
[`../dev/README.md`](../dev/README.md) for the full output→variable mapping — it
is identical). Scope them to the `production` environment so they cannot be
served by dev's values; the URL variables are the exception and stay unscoped.
See `deploy/helm/fabric/README.md` § Environment wiring.

> **Pre-audit note.** This profile is authored to be reviewed with
> `terraform plan` against the customer's own AWS account before any `apply`. It
> provisions no resources on its own and contains no environment-specific
> secrets.
