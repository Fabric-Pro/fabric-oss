# Fabric — AWS Deployment Guide

End-to-end guide for standing Fabric up on AWS using the Helm chart in `deploy/helm/fabric/`, the Terraform modules in `deploy/terraform/`, and the GitLab CI templates in `ci/gitlab/`.

> **Audience.** A platform engineer who has admin (or scoped equivalent) access to a fresh AWS account and a GitLab project. No prior knowledge of this codebase is assumed.

## Contents

1. [Prerequisites](#1-prerequisites)
2. [One-time setup](#2-one-time-setup)
3. [Populating Secrets Manager](#3-populating-secrets-manager)
4. [Configuring GitLab CI/CD variables](#4-configuring-gitlab-cicd-variables)
5. [Updating Helm values for your environment](#5-updating-helm-values-for-your-environment)
6. [First deploy](#6-first-deploy)
7. [Creating the first admin user](#7-creating-the-first-admin-user)
8. [Adding HTTPS (optional)](#8-adding-https-optional)
9. [Updates and rollbacks](#9-updates-and-rollbacks)
10. [Tearing down](#10-tearing-down)

---

## 1. Prerequisites

### AWS

A single AWS account is sufficient. You need permissions to create and manage:

| Service | Why |
|---|---|
| IAM | OIDC provider, GitLab deployer role, IRSA roles for ALB / ESO / External DNS / GitLab Runner |
| EKS | Kubernetes control plane + managed node group (dev: `t3.large` ×2, min 2 / max 4, 40Gi root volumes — plan quota/cost accordingly) |
| EC2 / VPC | VPC, subnets, NAT GW, security groups, ALB |
| RDS | Postgres 16 instance for the application database |
| ElastiCache | Redis 7.1 for caching and Better Auth sessions |
| ECR | 14 container repositories |
| S3 | 7 application buckets + state bucket |
| Secrets Manager | 14 secret groups (one per logical domain) |
| Route 53 | Optional — only if you're terminating TLS on a custom domain |
| KMS | Customer-managed keys for EKS / RDS / S3 / Secrets Manager / ECR |
| ELB | ALB managed by the AWS Load Balancer Controller |
| DynamoDB | Terraform state lock table |
| Budgets | Cost-guardrail alerts |

If you're using a scoped role rather than admin, the trust policy must allow these services and the role must have permission to create IAM roles (for IRSA + OIDC). The bootstrap script and `terraform apply` will fail loudly on any missing permission.

### GitLab

Either:

- **Fork this repository on GitLab.com**, or
- **Create a new GitLab project** and `git push` the repo to it.

The deployer role's OIDC trust policy is scoped to the GitLab project path (e.g. `youruser/fabric-test`), so the project path must be known before you run `terraform apply` — you provide it via `gitlab_project_path` in `terraform.tfvars`.

### Cloudflare

The collaboration layer (PartyKit) and the AI sandbox both run on Cloudflare Workers. Sign up for a free Cloudflare account; the deploy uses the free tier.

| Used for | Plan |
|---|---|
| PartyKit (real-time collab) | Workers |
| `sandbox-worker` (AI tool sandbox) | Workers |
| Turnstile (CAPTCHA for auth) | Free standalone tier |

You will need an **API token** with the following permissions:
- `Account.Workers Scripts:Edit`
- `Account.Account Settings:Read`
- `Account.Workers R2 Storage:Edit` (only if R2 is used downstream)

### Temporal Cloud

Sign up at <https://cloud.temporal.io>. The free tier is sufficient for development (10k actions/month). You need:
- **Namespace** (e.g. `fabric-dev.abcde`)
- **Address** (e.g. `fabric-dev.abcde.tmprl.cloud:7233`)
- **API key** (or mTLS cert pair — API key is simpler)

### AI providers

At least one of:
- Anthropic (`ANTHROPIC_API_KEY`)
- OpenAI (`OPENAI_API_KEY`)

Additional providers (Google AI, Groq, Cerebras, DeepSeek) are optional. See `EXTERNAL-SERVICES.md` for the full list.

### Upstash Redis

Sign up at <https://upstash.com>. The free tier is sufficient. You will need the **REST URL** and **REST token** — Upstash is used by the rate-limit middleware and the MCP route, both of which use the `@upstash/redis` REST client. This is *separate* from the in-cluster ElastiCache, which uses the standard Redis protocol over `REDIS_URL`.

### Domain (optional)

Required only if you want HTTPS. Without one, the ALB serves on its `*.elb.amazonaws.com` hostname over plain HTTP. OAuth flows that require HTTPS will not function correctly — see [§8 Adding HTTPS](#8-adding-https-optional).

### Local tools

| Tool | Minimum | Purpose |
|---|---|---|
| `terraform` | 1.7.0 | Infrastructure provisioning |
| `helm` | 3.14.0 | Chart install (CI does this for you, useful for local debug) |
| `kubectl` | 1.34.x | Cluster diagnostics (within ±1 minor of the 1.35 cluster) |
| `aws` (CLI v2) | 2.15.0 | Bootstrap, Secrets Manager population |
| `jq` | any | JSON parsing |
| `glab` | any | Optional — GitLab CLI for setting CI variables |

`mise` (`brew install mise` on macOS, see <https://mise.jdx.dev>) is the recommended version manager — the repo's `.mise.toml` (when present) pins versions.

---

## 2. One-time setup

### 2.1 Bootstrap the Terraform state backend

The S3 state bucket and DynamoDB lock table must exist before the first `terraform init`:

```bash
cd deploy/terraform
./bootstrap.sh
```

The script:
- creates `fabric-tfstate-<ACCOUNT_ID>` (S3) with versioning + SSE
- creates `fabric-tfstate-lock` (DynamoDB) with pay-per-request billing
- prints the `terraform init` command with `-backend-config=...` flags filled in — copy this output

The script is idempotent. Re-running it on an account that already has the resources is safe; it skips existing ones.

### 2.2 Configure `terraform.tfvars`

```bash
cd deploy/terraform/environments/dev
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

```hcl
region       = "us-east-1"
cluster_name = "fabric-dev"
environment  = "dev"

# Required: your GitLab project path. Scopes the OIDC trust policy.
gitlab_project_path = "youruser/fabric-test"

# Required: runner authentication token from GitLab UI (see §2.3).
gitlab_runner_token = "glrt-XXXXXXXXXXXXXXXXXXXX"

# Required: receives Budget alerts. Also used as ACM cert validation email if domain_name is set.
alert_email = "you@example.com"

# Optional: empty for HTTP-only ALB. Set to a subdomain to enable Route 53 + HTTPS.
domain_name = ""

tags = {
  Project = "fabric"
  Owner   = "you"
  Env     = "dev"
}
```

### 2.3 Get the GitLab runner authentication token

1. Open your GitLab project in the browser.
2. **Settings → CI/CD → Runners** (left sidebar).
3. Under **Project runners**, click **New project runner**.
4. **Tags**: enter exactly `fabric-runner` (no quotes, no spaces). The pipeline templates select runners with this tag, so it must match. Toggle **Run untagged jobs** **off**.
5. Click **Create runner**.
6. GitLab displays an authentication token starting with `glrt-`. **Copy it now** — GitLab will not show it again. (This is a runner *authentication* token, not a legacy registration token — GitLab.com no longer issues registration tokens.)
7. Paste the token into `terraform.tfvars` as `gitlab_runner_token`.

> **Decision.** This deploy uses a **self-hosted GitLab Runner on EKS** (installed by the `gitlab-runner` Terraform module) rather than the shared SaaS runners. Reason: the SaaS free tier caps at 400 CI minutes/month, which a single full deploy run exceeds. The self-hosted runner runs as a Helm release inside the cluster after Phase 2 completes.

### 2.4 `terraform init`

Paste the command emitted by `bootstrap.sh`. It will look roughly like:

```bash
cd deploy/terraform/environments/dev
terraform init \
  -backend-config="bucket=fabric-tfstate-123456789012" \
  -backend-config="key=dev/terraform.tfstate" \
  -backend-config="region=us-east-1" \
  -backend-config="dynamodb_table=fabric-tfstate-lock" \
  -backend-config="encrypt=true"
```

### 2.5 Two-phase `terraform apply`

The `helm` and `kubernetes` providers in `main.tf` reference `module.eks.cluster_endpoint`, which Terraform cannot resolve at plan time before the cluster exists. Provider configuration must resolve at plan time even for resources you're not creating in this run, so a single unrestricted apply fails with:

> `Error: Provider configuration not present` (or a closely related `unknown value` plan error).

Solution: apply in two phases.

**Phase 1 — foundational AWS infrastructure** (no Kubernetes resources):

```bash
terraform apply \
  -target=module.vpc \
  -target=module.kms \
  -target=module.eks \
  -target=module.rds \
  -target=module.elasticache \
  -target=module.ecr \
  -target=module.s3 \
  -target=module.secrets \
  -target=aws_secretsmanager_secret_version.database
```

Expect **15–20 minutes** — EKS control plane provisioning dominates the wall-clock.

**Phase 2 — cluster controllers + remaining wiring**:

First flip the gate that all in-cluster modules are counted on — it defaults to `false`, and **a plain `terraform apply` without it is a no-op for the controllers**: ESO, the ALB Controller, External DNS, the GitLab Runner, and the `app_irsa` role are never created, so `app_irsa_role_arn` stays empty and the first `deploy:aws:*` job hard-fails on the `APP_IRSA_ROLE_ARN` guard.

```bash
echo 'enable_k8s_addons = true' >> terraform.tfvars
terraform apply
```

Expect **5–10 minutes**. This installs the ALB Controller, External Secrets Operator, External DNS (no-op if `domain_name = ""`), GitLab OIDC provider, the self-hosted GitLab Runner, the `app_irsa` IRSA role, and the Budgets module.

After Phase 2 completes, subsequent applies (e.g. resizing the node group, adding a domain later) work with a single `terraform apply`.

### 2.6 Capture Terraform outputs

```bash
terraform output -raw deployer_role_arn         # → DEPLOYER_ROLE_ARN (NOT AWS_ROLE_ARN — reserved AWS SDK IRSA var)
terraform output -raw ecr_registry_url          # → ECR_REGISTRY
terraform output -raw cluster_name              # → CLUSTER_NAME
terraform output -raw region                    # → AWS_REGION
terraform output -raw elasticache_endpoint      # → Helm values
terraform output -json s3_buckets               # → Helm values
terraform output -json route53_name_servers     # → registrar NS records (only if domain set)
```

Keep this terminal open or paste the values into a scratch file — you will need them in §4 and §5.

---

## 3. Populating Secrets Manager

The `secrets` Terraform module creates 14 secret skeletons under `fabric/<env>/<group>`:

```
fabric/dev/database          ← auto-populated by Terraform from RDS outputs (DO NOT TOUCH)
fabric/dev/auth
fabric/dev/ai-providers
fabric/dev/oauth
fabric/dev/integrations
fabric/dev/redis             ← auto-populated by Terraform from ElastiCache outputs (DO NOT TOUCH)
fabric/dev/upstash
fabric/dev/temporal
fabric/dev/cloudflare
fabric/dev/storage
fabric/dev/email
fabric/dev/payments
fabric/dev/qdrant            ← auto-populated by Terraform (random API key) (DO NOT TOUCH)
fabric/dev/agents            ← auto-populated by Terraform (random AGENT_API_KEY / AI_TOKEN_SECRET / COLLAB_JWT_SECRET) (DO NOT TOUCH)
```

The Helm chart's `ExternalSecret` (`deploy/helm/fabric/templates/secrets/external-secrets.yaml`) uses `dataFrom: extract:` to read each secret as a JSON map and project every key as an env var on the rendered `Secret`. **The JSON keys must exactly match the env var names** the application expects.

For each group below, run the `aws secretsmanager put-secret-value` command after filling in your values. The full env-var contract lives in `ENVIRONMENT-VARIABLES.md`; this section is the copy-paste minimum.

> **Three groups are Terraform-managed — leave them alone.** `database`
> (RDS-derived `DATABASE_URL`/`DIRECT_URL`), `redis` (ElastiCache-derived
> `REDIS_URL` with the TLS scheme + AUTH token), `qdrant` (random API key),
> and `agents` (random `AGENT_API_KEY`/`AI_TOKEN_SECRET`/`COLLAB_JWT_SECRET`)
> are all written by `aws_secretsmanager_secret_version.*` resources in
> `environments/dev/main.tf` with `ignore_changes = [secret_string]`. Editing
> them via `put-secret-value` replaces the whole JSON and erases the
> Terraform-written values (Terraform won't restore them — `ignore_changes`).

### 3.1 `auth`

`AGENT_API_KEY`, `AI_TOKEN_SECRET`, and `COLLAB_JWT_SECRET` are **not** set here —
Terraform generates them in the `agents` group (extracted after `auth`, so they'd
override anything you put here anyway). This group only carries `BETTER_AUTH_SECRET`
and `AGENT_SERVICE_SECRET` (the latter must be shared with the Cloudflare PartyKit
worker, so it's operator-set rather than Terraform-random).

```bash
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/auth \
  --secret-string "$(jq -nc \
    --arg better_auth_secret "$(openssl rand -base64 48)" \
    --arg agent_service_secret "$(openssl rand -base64 32)" \
    '{
       BETTER_AUTH_SECRET:    $better_auth_secret,
       AGENT_SERVICE_SECRET:  $agent_service_secret
     }')"
```

Save `AGENT_SERVICE_SECRET` somewhere — you will paste the same value into GitLab CI variables in §4 so the PartyKit worker can verify tokens.

### 3.2 `ai-providers`

At least one provider key is required. Add only the ones you have:

```bash
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/ai-providers \
  --secret-string '{
    "ANTHROPIC_API_KEY": "sk-ant-XXXX",
    "OPENAI_API_KEY":    "sk-XXXX",
    "GROQ_API_KEY":      "",
    "DEEPSEEK_API_KEY":  ""
  }'
```

### 3.3 `oauth`

OAuth provider client IDs and secrets. Configure at least one — you need it to log in (§7).

```bash
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/oauth \
  --secret-string '{
    "GOOGLE_CLIENT_ID":             "XXXXX.apps.googleusercontent.com",
    "GOOGLE_CLIENT_SECRET":         "XXXX",
    "FABRIC_GITHUB_CLIENT_ID":      "",
    "FABRIC_GITHUB_CLIENT_SECRET":  "",
    "MICROSOFT_GRAPH_CLIENT_ID":    "",
    "MICROSOFT_GRAPH_CLIENT_SECRET":""
  }'
```

Redirect URIs follow the pattern `<protocol>://<host>/api/auth/callback/<provider>`. See `EXTERNAL-SERVICES.md` for the full cheat sheet and the per-provider registration steps.

### 3.4 `integrations`

LangSmith, Letta, LangGraph Cloud, Vercel AI Gateway, etc. All optional in MVP:

```bash
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/integrations \
  --secret-string '{
    "LANGSMITH_API_KEY":  "",
    "LETTA_API_KEY":      "",
    "LANGGRAPH_API_KEY":  "",
    "FABRIC_AI_API_KEY":  "",
    "FABRIC_SERVER_API_KEY": ""
  }'
```

### 3.5 `upstash`

Upstash REST credentials (rate-limit middleware + MCP route). These go in the
dedicated `upstash` group — **not** `redis`.

```bash
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/upstash \
  --secret-string '{
    "UPSTASH_REDIS_REST_URL":   "https://XXXX.upstash.io",
    "UPSTASH_REDIS_REST_TOKEN": "XXXX"
  }'
```

> **Do NOT touch `fabric/dev/redis`.** It is Terraform-managed: the
> `aws_secretsmanager_secret_version.redis` resource writes `REDIS_URL`
> (`rediss://default:<auth-token>@<endpoint>:6379`) from the ElastiCache module
> outputs. There is no ConfigMap fallback — running `put-secret-value` against
> `fabric/dev/redis` with the Upstash keys (as earlier revisions of this guide
> instructed) erases the only `REDIS_URL` and leaves pods unable to reach
> ElastiCache, with no automatic recovery (`ignore_changes`).

### 3.6 `temporal`

```bash
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/temporal \
  --secret-string '{
    "TEMPORAL_CLOUD_API_KEY":     "XXXX"
  }'
```

> The key MUST be `TEMPORAL_CLOUD_API_KEY` (matches `packages/temporal/src/client.ts`) — `TEMPORAL_API_KEY` is silently ignored and crash-loops the worker.

`TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` go into the ConfigMap via the `TEMPORAL_NAMESPACE` / `TEMPORAL_ADDRESS` GitLab CI variables (see §5), not here and not a values file.

### 3.7 `cloudflare`

```bash
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/cloudflare \
  --secret-string "$(jq -nc \
    --arg sandbox_auth_secret "$(openssl rand -base64 32)" \
    '{
       TURNSTILE_SECRET_KEY:   "XXXX",
       SANDBOX_AUTH_SECRET:    $sandbox_auth_secret
     }')"
```

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` live in GitLab CI variables (§4), not here — they are build-time, not runtime.

### 3.8 `storage` (optional with IRSA)

The web app and temporal worker can sign S3 requests using either explicit access keys or the IRSA role attached to the `fabric` ServiceAccount (recommended). If you're using IRSA, leave this group as empty values; if you want explicit keys (e.g. for a parallel non-AWS S3-compatible store), put them here.

```bash
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/storage \
  --secret-string '{
    "S3_ACCESS_KEY_ID":     "",
    "S3_SECRET_ACCESS_KEY": ""
  }'
```

### 3.9 `email`

Pick **one** provider. Setting multiple does not cause errors but is wasted config.

```bash
# Resend (the only supported email provider)
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/email \
  --secret-string '{
    "RESEND_API_KEY": "re_XXXX"
  }'
```

### 3.10 `payments` (optional)

Skip entirely if you're not testing billing flows. Stripe is the only supported provider:

```bash
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/payments \
  --secret-string '{
    "STRIPE_SECRET_KEY":   "",
    "STRIPE_WEBHOOK_SECRET":""
  }'
```

### 3.11 Verify

```bash
# Operator-filled groups. (database/redis/qdrant/agents are Terraform-managed —
# check them too if you like, but never put-secret-value against them.)
for g in auth ai-providers oauth integrations upstash temporal cloudflare storage email payments; do
  echo "--- $g ---"
  aws secretsmanager get-secret-value \
    --secret-id "fabric/dev/$g" \
    --query 'SecretString' --output text \
  | jq 'keys'
done
```

You should see the expected key names for each group. The External Secrets Operator polls every `refreshInterval` (1h by default) — after the first deploy you can force a re-sync with `kubectl annotate externalsecret/fabric-app-secrets force-sync=$(date +%s) -n fabric --overwrite`.

---

## 4. Configuring GitLab CI/CD variables

Open your GitLab project: **Settings → CI/CD → Variables → Expand → Add variable**.

For each variable below: set **Type = Variable**, **Mask variable = ✓**, **Protect variable = ✓**, **Expand variable reference = ✓**.

| Variable | Source | Notes |
|---|---|---|
| `DEPLOYER_ROLE_ARN` | `terraform output -raw deployer_role_arn` | GitLab→AWS OIDC assume-role target. Do NOT name it `AWS_ROLE_ARN` — that's the reserved AWS SDK web-identity var and would shadow the Kaniko build pods' IRSA role (ECR push → 401). |
| `ECR_REGISTRY` | `terraform output -raw ecr_registry_url` | e.g. `123456789012.dkr.ecr.us-east-1.amazonaws.com` |
| `AWS_REGION` | `terraform output -raw region` | Defaults to `us-east-1` in `00-variables.yml` — set explicitly if you changed it |
| `CLUSTER_NAME` | `terraform output -raw cluster_name` | Defaults to `fabric-dev` in `00-variables.yml` — same caveat |
| `APP_IRSA_ROLE_ARN` | `terraform output -raw app_irsa_role_arn` | **Required.** `deploy:aws:*` hard-fails without it — passed to Helm as `serviceAccount.roleArn` so app pods get an S3/KMS identity via IRSA |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens | Scopes: Workers Scripts:Edit, Account Settings:Read, R2:Edit (if used) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard sidebar | 32-char hex |
| `FABRIC_API_URL` | Your web URL | After first deploy, set to `http://<alb-host>` (or `https://<your-domain>` if HTTPS) |
| `AGENT_SERVICE_SECRET` | Same value you put in `fabric/dev/auth` | The PartyKit worker uses this to verify inter-service tokens |
| `ACM_CERT_ARN` | ACM certificate ARN (us-east-1) | **Any TLS deploy**, scoped `[ENV]` — production, and dev once the §8 HTTPS upgrade sets `DEV_TLS=true`. A TLS deploy hard-fails without it |

> **Why `Mask` and `Protect`.** `Mask` redacts the value from job logs. `Protect` restricts the variable to protected branches and tags — preventing exfiltration from a fork's MR pipeline. See the note below: `master` is protected automatically as the default branch, but `v*` tags are **not**, and prod deploys run on tags.

> **Protect the `v*` tags before your first production deploy.** GitLab protects
> the default branch (`master`) automatically, so `--protected` variables reach
> the dev pipeline without any extra step. It does **not** protect tags
> automatically. Production deploys run on a `v*` tag
> (`ci/gitlab/60-deploy-aws.yml`), so until you add a wildcard protected-tag rule
> — **Settings → Repository → Protected tags → `v*`** — every `--protected`
> variable is invisible to that pipeline. `ACM_CERT_ARN` is set `--protected`, so
> the prod deploy will stop on its "ACM_CERT_ARN is unset" guard and the cause
> will not be obvious from the error. This is also what the deployer role's IAM
> trust policy expects: it trusts the `master` branch and `v*` tags, nothing else.

`FABRIC_API_URL` and `AGENT_SERVICE_SECRET` are not strictly required for the first deploy (the PartyKit worker is in `61-deploy-cloudflare.yml`, which runs after `60-deploy-aws.yml`). You can add them between the two deploys if you prefer.

### CLI alternative (glab)

```bash
glab variable set DEPLOYER_ROLE_ARN     "$(terraform output -raw deployer_role_arn)" --masked --protected
glab variable set ECR_REGISTRY          "$(terraform output -raw ecr_registry_url)"  --masked --protected
glab variable set AWS_REGION            "us-east-1"                                  --protected
glab variable set CLUSTER_NAME          "fabric-dev"                                 --protected
# [ENV] — scoped, so prod cannot inherit dev's role. Use --scope production for prod.
glab variable set APP_IRSA_ROLE_ARN     "$(terraform output -raw app_irsa_role_arn)" --masked --protected --scope dev
glab variable set CLOUDFLARE_API_TOKEN  "XXXX"                                       --masked --protected
glab variable set CLOUDFLARE_ACCOUNT_ID "XXXX"                                       --masked --protected
# Any TLS deploy — production, and dev after the §8 HTTPS upgrade. Scoped [ENV]:
# glab variable set ACM_CERT_ARN        "arn:aws:acm:us-east-1:...:certificate/..." --masked --protected --scope dev
```

---

## 5. Setting the Helm environment wiring

The chart ships with empty placeholders for the resources Terraform creates.
**These are not edited into a values file** — `values-dev.yaml` / `values-prod.yaml`
carry sizing and profile only, so the same chart deploys to any account. The
account-bound values are GitLab CI/CD variables that
`ci/gitlab/60-deploy-aws.yml` writes into a generated override at deploy time,
and `deploy:aws:*` hard-fails if a required one is missing.

```bash
cd deploy/terraform/environments/dev

# All seven bucket names share one prefix — set the prefix, not the names.
terraform output -json s3_buckets | jq -r '.avatars | sub("-avatars$";"")'
terraform output -raw app_irsa_role_arn
```

Set in **Settings → CI/CD → Variables**. The **Scope** column is load-bearing —
see the note below the table:

| Variable | Scope | Value |
|---|---|---|
| `S3_BUCKET_PREFIX` | `dev` / `production` | the shared `fabric-<env>-<8-char-account-id>` leader |
| `APP_IRSA_ROLE_ARN` | `dev` / `production` | `terraform output -raw app_irsa_role_arn` |
| `TEMPORAL_NAMESPACE` | `dev` / `production` | `<namespace>.<account>` from Temporal Cloud |
| `TEMPORAL_ADDRESS` | `dev` / `production` | optional — only outside the chart's default region |
| `ACM_CERT_ARN` | `dev` / `production` | required by **any** TLS deploy — prod, and dev after the §8 HTTPS upgrade |
| `VPC_CIDR` | `dev` / `production` | optional — narrows the NetworkPolicy to the real VPC |
| `WEB_ALB_HOSTNAME` | **All** | dev/branch pipelines: the ALB hostname (see the two-pass note in `BOOTSTRAP.md` §1.3 — it does not exist before the first deploy) |
| `DEV_DOMAIN` / `DEV_TLS` | **All** | dev/branch pipelines after the §8 HTTPS upgrade |
| `PROD_DOMAIN` | **All** | prod/tag pipelines: the hostname on the ACM certificate |

> **Scope matters in both directions.**
>
> The **URL inputs** (`WEB_ALB_HOSTNAME`, `DEV_DOMAIN`, `DEV_TLS`, `PROD_DOMAIN`,
> `NEXT_PUBLIC_SITE_URL`) must be **unscoped**. `build:matrix` and `smoke` target
> no environment, and GitLab does not expose an environment-scoped variable to
> such a job. Since `NEXT_PUBLIC_SITE_URL` is compiled into the web bundle at
> build time, scoping the hostname would hide it from the build and ship an image
> with `localhost` baked into client code — which then deploys green. That is why
> dev and prod use different variable *names* here rather than one scoped name.
>
> Everything else (`APP_IRSA_ROLE_ARN`, `S3_BUCKET_PREFIX`, `TEMPORAL_NAMESPACE`,
> `TEMPORAL_ADDRESS`, `ACM_CERT_ARN`, `VPC_CIDR`) is **deploy-only and should be
> scoped** to `dev` / `production`. Both deploy jobs declare an environment, so
> scoping works — and it is what keeps the environments apart. Left unscoped, one
> IRSA role, one bucket prefix and one Temporal namespace serve both, so a
> production tag deploy quietly receives the dev role, dev buckets and dev
> namespace. Scope them even if you run only one environment today: the cost is
> nothing and the failure is silent.
>
> **What scoping does *not* solve.** `DEPLOYER_ROLE_ARN`, `ECR_REGISTRY`,
> `AWS_REGION` and `CLUSTER_NAME` are consumed by `build:matrix`, `sign`,
> `migrate:preview` and `smoke` — none of which declares an environment — so
> they cannot be scoped and remain single-valued. A tag pipeline runs under the
> same AWS identity, registry and cluster as a branch pipeline. This pipeline
> targets **one AWS environment at a time**; the scoping above separates the
> Helm wiring, not the AWS identity. A genuinely separate production account
> needs distinct `DEV_*`/`PROD_*` names for those four.

> **`elasticache.endpoint` is not on this list.** The chart defines the key but
> no template reads it: `REDIS_URL` is delivered by ExternalSecrets from the
> Terraform-managed `fabric/<env>/redis` secret, with the TLS scheme and AUTH
> token already applied.

The bucket prefix Terraform passes is `fabric-${env}-${first-8-chars-of-account-id}`,
which guarantees global uniqueness without colliding across accounts.

If you configured a domain (`domain_name` in tfvars), set `PROD_DOMAIN` — but
**do not** set `ingress.tls: true` until the ACM certificate is issued in §8.

Nothing to commit: the wiring lives in CI variables, so a new environment needs
no repository change for the Helm wiring. The four core AWS variables are the exception — see the limitation note above.

## 6. First deploy

> **GitLab production deploys are currently disabled.** `deploy:aws:prod` is
> `when: never`, and the migrate preview and both Cloudflare worker deploys have
> had their `v*` tag rules removed alongside it. A release tag still builds,
> scans and signs artifacts — it deploys nothing.
>
> The reason is that `CLUSTER_NAME`, `AWS_REGION`, `DEPLOYER_ROLE_ARN` and
> `ECR_REGISTRY` cannot be environment-scoped (the build, sign, migrate and
> smoke jobs declare no environment), so `CLUSTER_NAME` resolved to the **dev**
> cluster even in the production job — a tag would have upgraded the dev
> cluster's live release with production values. Re-enabling requires giving
> those four distinct `DEV_*`/`PROD_*` names selected by pipeline type. Until
> then this pipeline serves one AWS environment, and the `production` scopes
> described below are groundwork for that split rather than a working path.


Push to `master` (or merge an MR into `master`). The pipeline stages run in order:

```
validate → test → security → build → image-scan → sign → migrate → deploy → smoke
```

| Stage | What runs | Typical duration |
|---|---|---|
| `validate` | `helm lint`, `kubeconform`, `terraform validate`, change detection | 1–2 min |
| `test` | Vitest with Turbo affected-only filter | 2–5 min |
| `security` | Semgrep, osv-scanner, TruffleHog — source scans, before any image exists. All three run unconditionally on `v*` tags | 2–4 min |
| `build` | 14 parallel Docker builds → ECR push | 5–10 min |
| `image-scan` | Trivy against the images just built | 1–3 min |
| `sign` | cosign signature + SBOM attestation. Depends on `image-scan`, so an image that fails the scan is never signed | <1 min |
| `migrate` | Renders the migrate Job manifest for visibility | <1 min |
| `deploy` | `helm upgrade --install --atomic` (migration runs as the pre-upgrade hook) + `wrangler deploy` for PartyKit & sandbox | 5–10 min |
| `smoke` | Health check against the ALB this pipeline deployed to. HTTP: curls `/api/health` and cross-checks `WEB_ALB_HOSTNAME` against the live ALB. TLS: requires the domain to resolve to that ALB, then curls the domain pinned to it | <1 min (TLS adds up to 2 min waiting for DNS) |

Expect the **first** deploy to take **15–25 minutes** end-to-end. Subsequent deploys with warm ECR + Docker layer caches finish closer to 8–12 minutes.

Watch the pipeline at `https://gitlab.com/youruser/fabric-test/-/pipelines`. The PartyKit and `sandbox-worker` deploy jobs (`61-deploy-cloudflare.yml`) are SKIPPED entirely when `CLOUDFLARE_API_TOKEN` is unset/empty — they never run and never fail the pipeline.

### Visit your app

```bash
aws eks update-kubeconfig --name fabric-dev --region us-east-1

# Wait for the ALB hostname to appear (~60s after deploy completes)
kubectl get ingress fabric-web -n fabric -w
```

Copy the `ADDRESS` column (a long `*.elb.amazonaws.com` hostname) and open it in your browser. You should see the Fabric marketing landing page over plain HTTP.

If you configured `global.domain`, External DNS will create the A/AAAA records pointing the domain at the ALB within ~2 minutes — refresh `dig fabric.example.com` until the alias resolves.

---

## 7. Creating the first admin user

There are two ways to bootstrap an admin: OAuth-first or seed-first. Pick one.

### 7.1 OAuth-first (recommended for real use)

1. **Register a Google OAuth app** at <https://console.cloud.google.com/apis/credentials>.
   - Application type: Web application.
   - Authorized redirect URI: `http://<your-alb-host>/api/auth/callback/google` (or `https://fabric.example.com/api/auth/callback/google` if you configured a domain).
   - Copy the client ID and client secret into `fabric/dev/oauth` via §3.3.
2. Force an External Secrets re-sync so the new values reach the pods:
   ```bash
   kubectl annotate externalsecret/fabric-app-secrets force-sync=$(date +%s) -n fabric --overwrite
   kubectl rollout restart deployment/web -n fabric
   ```
3. Log into the app via "Sign in with Google".
4. Promote yourself to admin:
   ```bash
   # Get an interactive shell into the pod that has Prisma + the DATABASE_URL.
   kubectl exec -it -n fabric deploy/temporal-worker -- /bin/sh
   # Inside the pod:
   pnpm --filter @repo/database exec prisma db execute \
     --stdin --schema=./prisma/schema.prisma <<'SQL'
   UPDATE "User" SET role = 'admin' WHERE email = 'you@example.com';
   SQL
   ```

### 7.2 Seed-first (for fully unattended bootstrap)

```bash
helm upgrade --install fabric ./deploy/helm/fabric \
  -f deploy/helm/fabric/values-dev.yaml \
  -n fabric \
  --set seed.enabled=true \
  --set 'seed.usersJson=[{"email":"you@example.com","name":"You","role":"admin"}]' \
  --set seed.orgSlug=acme \
  --set seed.orgName=Acme \
  --atomic --timeout 15m
```

Then **immediately flip seed off again** so subsequent helm releases don't re-run it:

```bash
helm upgrade --install fabric ./deploy/helm/fabric \
  -f deploy/helm/fabric/values-dev.yaml -n fabric \
  --set seed.enabled=false \
  --atomic --timeout 15m
```

(Or revert your `values-dev.yaml` if you set `seed.enabled` in the file.)

The seed Job runs `packages/database/scripts/seed-*.ts` against the live database. It uses the temporal-worker image because that image ships the full pnpm workspace (the web image is a Next.js standalone build and doesn't contain `packages/database`).

---

## 8. Adding HTTPS (optional)

HTTPS requires:
1. A domain (or subdomain) delegated to Route 53.
2. An ACM certificate for that domain.
3. `values-dev.yaml` updated to point Ingress at the cert.

### 8.1 Delegate a domain to Route 53

Edit `terraform.tfvars`:

```hcl
domain_name = "fabric.example.com"
```

```bash
terraform apply
terraform output -json route53_name_servers
```

The output lists 4 AWS-assigned NS hostnames. Set these as the NS records for `fabric.example.com` at your registrar (or as NS records at the parent zone if you own `example.com`). Propagation takes anywhere from 30 seconds to 48 hours, but is typically <10 minutes.

Verify delegation:

```bash
dig +short NS fabric.example.com
```

Should return the four AWS NS hostnames.

### 8.2 Request an ACM certificate

```bash
aws acm request-certificate \
  --domain-name fabric.example.com \
  --validation-method DNS \
  --region us-east-1 \
  --query CertificateArn --output text
```

The request comes back with `Status: PENDING_VALIDATION`. Add the validation CNAME that ACM emits (visible via `aws acm describe-certificate --certificate-arn ...`) into the Route 53 hosted zone — Terraform's `route53` module already created the zone. After validation completes (~2 minutes for DNS-validated certs) the cert moves to `ISSUED`.

> **Shortcut.** If you'd rather have Terraform manage the cert too, add a wrapping module in your fork that calls `aws_acm_certificate` + `aws_acm_certificate_validation`. The MVP modules stop at the hosted zone so the cert lifecycle isn't entangled with the rest of the stack.

### 8.3 Flip Ingress to HTTPS

Set these GitLab CI/CD variables — **not** a values-file edit:

```bash
glab variable set DEV_TLS      "true"
glab variable set DEV_DOMAIN   "app.example.com"
glab variable set ACM_CERT_ARN "arn:aws:acm:us-east-1:123456789012:certificate/abcd-..." --masked --protected --scope dev
glab variable set DEV_ENV_URL   "https://app.example.com"   # the GitLab "View app" link
```

Then re-run the pipeline (an empty commit is enough). The deploy job switches to
`global.domain` + `ingress.tls`, and the web image is rebuilt with the `https://`
URL baked in.

> **Why not the values file.** `global.siteUrl` takes precedence over
> `global.domain` (`templates/secrets/config-map.yaml`), and the deploy job sets
> `siteUrl` on every non-TLS deploy — so a domain committed to `values-dev.yaml`
> while `DEV_TLS` is unset is silently ignored, and you get a TLS Ingress serving
> an app that still believes it lives at the ALB. Flipping the variable moves
> both halves together. It also keeps a real hostname out of a public chart.

Within ~2 minutes the ALB will listen on `:443` with the new cert, and the ALB Controller will configure the HTTP→HTTPS redirect listener.

Update OAuth redirect URIs at each provider to the `https://` host. Forgetting this step is the most common cause of post-HTTPS login failures.

---

## 9. Updates and rollbacks

### 9.1 Updating

The standard flow: push to `master`, the pipeline runs, the deploy job runs `helm upgrade --install --atomic`. The migrate hook runs first; if migrations succeed, the rollout proceeds; if any pod fails readiness, Helm rolls back.

> **Atomic with caveat.** `--atomic` reverts the Kubernetes resource state, but **does not** roll back a forward database migration. If the migration was reversible (Prisma generates a `migration.sql` that the same name + `migrate resolve --rolled-back` can undo), you can revert it manually. If the migration was destructive (column drop, type change), revert requires a forward-fix migration with the prior schema shape.

> **`temporal-worker` has no readiness probe** — a bad `TEMPORAL_*` config crash-loops it silently and `helm --wait` + the ALB smoke test still pass. After deploy, verify the worker explicitly: `kubectl logs deploy/temporal-worker -n fabric` should show a successful Temporal connection, not a reconnect loop.

### 9.2 Manual upgrade

For a hot-fix outside the pipeline:

```bash
helm upgrade fabric ./deploy/helm/fabric \
  -f deploy/helm/fabric/values-dev.yaml \
  -n fabric \
  --set global.imageTag=<sha-or-tag> \
  --atomic --timeout 15m
```

### 9.3 Rollback

```bash
helm history fabric -n fabric
helm rollback fabric <REVISION> -n fabric --wait --timeout 10m
```

`helm rollback` redeploys the manifest set from that revision. The forward migration is **not** undone — see the caveat above.

### 9.4 Skipping the build (YAML-only iterations)

When you're iterating on helm or CI YAML and don't need a fresh image, set `SKIP_BUILD=true` and `IMAGE_TAG=<known-good-sha>` to skip the 14-image rebuild and deploy existing ECR images instead (see `ci/gitlab/40-build.yml`, `00-variables.yml`, `60-deploy-aws.yml`).

> **Requires a project setting.** Using `SKIP_BUILD`/`IMAGE_TAG` via trigger-time variables requires **Settings → CI/CD → Pipelines → `ci_pipeline_variables_minimum_override_role`** to permit the override (e.g. `maintainer` or `developer`). The default `no_one_allowed` silently blocks trigger-time variable overrides, so the run still rebuilds. Note that `SKIP_BUILD=true` also excludes the Trivy image scan on untagged pipelines — there is no new image to scan. `SKIP_BUILD` cannot bypass any scan on a `v*` tag (its bypass rule requires `CI_COMMIT_TAG == null`), and no variable disables the source-level security scans at all.

### 9.5 Image promotion

The build matrix tags every image as `$CI_COMMIT_SHA`. Promotion between environments is a re-tag (`docker tag a:sha → a:staging` then push), or by passing the SHA as `global.imageTag` to a different environment's helm release. The CI does the latter automatically for semver tags pushed to the repo.

---

## 10. Tearing down

```bash
cd deploy/terraform/environments/dev
terraform destroy
```

About **15 minutes** end-to-end. The dev module is configured for destroy-friendliness:

- RDS: `skip_final_snapshot = true`
- ECR: `force_delete = true`
- S3: `force_destroy = true`
- Secrets Manager: `recovery_window_in_days = 0`
- KMS keys: tag-pinned `force_destroy` where the provider supports it

### Common hangs

| Symptom | Cause | Fix |
|---|---|---|
| `terraform destroy` waits on a subnet | NAT GW or ENI dependency | Wait — they self-clean within 5 min. If stuck >15 min, find and detach the offending ENI in the EC2 console. |
| Helm releases hang | Finalizers on cluster-side resources | `kubectl delete --all --all-namespaces` for stuck `ExternalSecret` / `Ingress`. |
| KMS deletion blocked | `recovery_window_in_days` > 0 in the module instance you're using | Confirm `recovery_window_in_days = 0` in `environments/dev/main.tf` (it is, by default). The keys move to "pending deletion" with a 7-day window otherwise, which Terraform reports as success but the keys persist. |
| `terraform destroy` keeps the state bucket | Intentional — the state backend lives outside the dev env | Empty + delete `fabric-tfstate-<account>` manually if you really want it gone. |

### What's left behind on purpose

- The S3 state bucket and DynamoDB lock table (`bootstrap.sh` resources). They are not in this Terraform state file; delete manually if you want a fully clean slate.
- The OIDC provider for GitLab is destroyed by Terraform — but the provider thumbprint cache stays in AWS until ~24 hours after the last assume-role-with-web-identity call. Harmless.
- Cloudflare workers + Upstash + Temporal Cloud resources are not managed by this Terraform — they live in their respective SaaS dashboards.

---

## Further reading

- `ARCHITECTURE.md` — topology diagram and request/build flows.
- `BOOTSTRAP.md` — exhaustive day-by-day walkthrough with every command.
- `EXTERNAL-SERVICES.md` — full checklist of accounts and tokens to register before §3.
- `ENVIRONMENT-VARIABLES.md` — complete env-var contract by service and by secret group.
- `TROUBLESHOOTING.md` — debugging guide for pipeline, pod, networking, ESO, and migration failures.
