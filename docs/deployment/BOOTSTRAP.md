# Fabric — Bootstrap Guide

The exhaustive day-by-day walkthrough. Each step is callable in order; copy-paste commands as you go. If you've never seen this codebase before, start here.

For the condensed reference, see [AWS-DEPLOYMENT.md](./AWS-DEPLOYMENT.md). For *what to type*, this file. For *why we chose this*, [ARCHITECTURE.md](./ARCHITECTURE.md).

## Schedule

- **Day 0** — accounts, tools, Terraform.
- **Day 1** — secrets, GitLab variables, first deploy.
- **Day 2** — optional HTTPS upgrade.
- **Teardown** — when you're done.

Total wall-clock from a clean machine to a logged-in admin user: about 90 minutes of actual work spread across 2–3 hours (Phase 1 of `terraform apply` runs in the background for ~20 min).

---

## Day 0 — Foundations

### 0.1 Set up your accounts

Work through `EXTERNAL-SERVICES.md` and capture every credential in a secure scratch file (1Password / Bitwarden / `pass`). At minimum:

- [ ] AWS account, root access **disabled**, an IAM user with programmatic access.
- [ ] GitLab project + runner authentication token (`glrt-...`).
- [ ] Cloudflare account ID + API token + Turnstile site key/secret + a self-generated `SANDBOX_AUTH_SECRET`.
- [ ] Temporal Cloud namespace + address + API key.
- [ ] Upstash Redis REST URL + REST token.
- [ ] One AI provider key (Anthropic or OpenAI).
- [ ] One OAuth provider client ID + secret (Google / GitHub / Microsoft Graph).
- [ ] Resend API key (the only supported email provider).
- [ ] Decided your `cluster_name` (defaults to `fabric-dev`), `region` (defaults to `us-east-1`), and whether you want a domain.

### 0.2 Set the account-wide AWS billing alert (do this NOW)

Separate from the `module.budgets` Terraform module, which gates spend at $50/$100/$200. The account-wide alert is your last-resort guard against a runaway spend caused by, say, accidentally provisioning the prod-shape stack.

```bash
aws budgets create-budget \
  --account-id "$(aws sts get-caller-identity --query Account --output text)" \
  --budget '{
    "BudgetName": "account-wide-alert",
    "BudgetLimit": { "Amount": "300", "Unit": "USD" },
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST"
  }' \
  --notifications-with-subscribers '[
    {
      "Notification": {
        "NotificationType": "ACTUAL",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 90,
        "ThresholdType": "PERCENTAGE"
      },
      "Subscribers": [{ "SubscriptionType": "EMAIL", "Address": "you@example.com" }]
    }
  ]'
```

The MVP Fabric stack costs ~$222/month; $300 is a generous over-shoot that catches any accidental over-provisioning.

### 0.3 Configure the AWS CLI

```bash
aws configure
# AWS Access Key ID: <your IAM user's key>
# AWS Secret Access Key: <your IAM user's secret>
# Default region name: us-east-1
# Default output format: json

aws sts get-caller-identity
```

The last command should print your account ID and IAM user ARN. If it errors, the credentials aren't picking up — check `~/.aws/credentials` or your `AWS_PROFILE` env var.

### 0.4 Install local tools

Minimum versions (CI matches these; older locally is fine for diagnostics but install matching versions when in doubt):

| Tool | Minimum | Recommended | Install |
|---|---|---|---|
| `terraform` | 1.7.0 | 1.7.5 | `brew install terraform` / mise / [download](https://developer.hashicorp.com/terraform/downloads) |
| `helm` | 3.14.0 | 3.14.x | `brew install helm` / mise |
| `kubectl` | 1.34.0 | 1.34.x | `brew install kubectl` |
| `awscli` | 2.15.0 | 2.x | `brew install awscli` / [installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) |
| `jq` | any | latest | `brew install jq` |
| `glab` | any | latest | `brew install glab` (optional — for GitLab CI variable management from terminal) |

**Recommended: `mise` for version management.** Install with `curl https://mise.run | sh`, then drop a `.mise.toml` in your `$HOME` or this repo's root:

```toml
[tools]
terraform = "1.7.5"
helm = "3.14.0"
kubectl = "1.34.0"
awscli = "2.15.0"
```

`mise install` then provisions everything. The repo's CI uses these exact versions (see `ci/gitlab/00-variables.yml`).

Verify each tool:

```bash
terraform version    # should print >=1.7.0
helm version         # >=3.14.0
kubectl version --client    # >=1.34.0
aws --version        # >=2.15.0
jq --version
```

### 0.5 Clone the repo to your GitLab

**Option A — Fork on GitLab**

UI flow: gitlab.com → New project → Run CI/CD for external repository → connect by URL → paste this repo's URL. GitLab clones and creates a project under your namespace.

**Option B — Push manually**

```bash
git clone <this-repo-url> fabric
cd fabric
git remote rename origin upstream
# Create an empty project on gitlab.com first (UI: New project → Create blank project), then:
git remote add origin git@gitlab.com:youruser/fabric-test.git
git push -u origin master
```

Note the project path (e.g. `youruser/fabric-test`); you'll need it as `gitlab_project_path` in `terraform.tfvars`.

### 0.6 Get the GitLab runner authentication token

UI flow (essential — the API path is not equivalent here):

1. Open your project at `https://gitlab.com/youruser/fabric-test`.
2. Settings (left sidebar) → CI/CD → expand **Runners**.
3. Click **New project runner**.
4. **Operating system**: Linux. **Tags**: type `fabric-runner` exactly (no quotes, no leading slash). Toggle **Run untagged jobs** to OFF. Leave everything else default.
5. Click **Create runner**.
6. The next page shows an authentication token starting with `glrt-`. **Copy it now** — refreshing the page does not show it again. (You can revoke and reissue if you lose it.) This is a runner *authentication* token, not a legacy registration token — GitLab.com no longer issues registration tokens.

Save the token in your scratch file as `gitlab_runner_token`.

### 0.7 Bootstrap the Terraform state backend

```bash
cd deploy/terraform
./bootstrap.sh
```

The script creates:
- S3 bucket `fabric-tfstate-<ACCOUNT_ID>` (versioned, SSE encrypted, public access blocked).
- DynamoDB table `fabric-tfstate-lock` (pay-per-request).

It then prints a `terraform init` command — copy the whole block, you'll use it in 0.9.

The script is idempotent. Re-running on an account that already has the resources is safe; it skips and reports existing ones.

### 0.8 Configure `terraform.tfvars`

```bash
cd deploy/terraform/environments/dev
cp terraform.tfvars.example terraform.tfvars
```

Open `terraform.tfvars` in your editor and fill it in:

```hcl
region       = "us-east-1"
cluster_name = "fabric-dev"
environment  = "dev"

# REQUIRED: your GitLab project path.
gitlab_project_path = "youruser/fabric-test"

# REQUIRED: runner authentication token from step 0.6.
gitlab_runner_token = "glrt-XXXXXXXXXXXXXXXXXXXX"

# REQUIRED: budget alert recipient.
alert_email = "you@example.com"

# OPTIONAL: empty for HTTP-only. Set to a subdomain to enable Route 53 + HTTPS later.
domain_name = ""

tags = {
  Project = "fabric"
  Owner   = "you"
  Env     = "dev"
}
```

`terraform.tfvars` is gitignored — never commit it.

### 0.9 `terraform init`

Paste the command emitted by `bootstrap.sh`. It looks like:

```bash
terraform init \
  -backend-config="bucket=fabric-tfstate-123456789012" \
  -backend-config="key=dev/terraform.tfstate" \
  -backend-config="region=us-east-1" \
  -backend-config="dynamodb_table=fabric-tfstate-lock" \
  -backend-config="encrypt=true"
```

Expected output ends with `Terraform has been successfully initialized!`. If you see provider download errors, your machine probably can't reach the HashiCorp releases CDN — check VPN/proxy settings.

### 0.10 Phase 1 of `terraform apply`

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

Type `yes` at the prompt. **Expect 15–20 minutes** — EKS control plane provisioning dominates. While you wait, you can start filling Secrets Manager (Day 1 steps below) once `module.secrets` is applied, which happens early in the apply sequence.

> **Why two phases?** The `helm` and `kubernetes` providers in `main.tf` reference `module.eks.cluster_endpoint` — unknown until EKS is created. Targeted apply skips them.

If Phase 1 fails (often: quota errors for EIP, NAT GW, or VPC), see `TROUBLESHOOTING.md § Terraform`.

### 0.11 Phase 2 of `terraform apply`

All in-cluster modules are gated on `enable_k8s_addons`, which defaults to `false`. Set it to `true` first — otherwise this apply is a no-op for the controllers (no ESO, no ALB Controller, no GitLab Runner, no `app_irsa` role), `app_irsa_role_arn` comes back empty, and the first `deploy:aws:*` job hard-fails on the `APP_IRSA_ROLE_ARN` guard.

```bash
echo 'enable_k8s_addons = true' >> terraform.tfvars
terraform apply
```

Type `yes`. Expect 5–10 minutes. This installs the ALB Controller, External Secrets Operator, External DNS (no-op without a domain), GitLab OIDC provider, the self-hosted GitLab Runner, the `app_irsa` IRSA role, and the Budgets module.

### 0.12 Capture Terraform outputs

Keep this output handy — you'll need it in Day 1.

```bash
terraform output -raw deployer_role_arn         # → GitLab CI variable DEPLOYER_ROLE_ARN (NOT AWS_ROLE_ARN — reserved AWS SDK IRSA var)
terraform output -raw ecr_registry_url          # → GitLab CI variable ECR_REGISTRY
terraform output -raw cluster_name              # → GitLab CI variable CLUSTER_NAME
terraform output -raw region                    # → GitLab CI variable AWS_REGION
terraform output -raw app_irsa_role_arn         # → GitLab CI variable APP_IRSA_ROLE_ARN (required — deploy:aws:* hard-fails without it)
terraform output -json s3_buckets               # → GitLab CI variable S3_BUCKET_PREFIX (the shared "<prefix>-" leader of all seven names)
terraform output -raw elasticache_endpoint      # → informational only; REDIS_URL ships via Secrets Manager, the chart key has no consumer
terraform output -json route53_name_servers     # → registrar NS records (empty without domain)
```

Stash to a scratch file:

```bash
terraform output -json > /tmp/fabric-tf-outputs.json
```

### 0.13 Set up local kubectl context

```bash
aws eks update-kubeconfig --name fabric-dev --region us-east-1
kubectl get nodes
```

You should see 2 nodes in `Ready` state (node_desired_size = 2, t3.large). If you see `error: You must be logged in to the server (Unauthorized)`, the EKS Access Entry for your IAM principal isn't configured — see `TROUBLESHOOTING.md`.

End of Day 0. Optional resting point — you can `terraform destroy` and resume tomorrow, or push on into Day 1.

---

## Day 1 — Secrets, CI, first deploy

### 1.1 Fill Secrets Manager

Each `aws secretsmanager put-secret-value` command below populates one of the operator-filled groups. Four groups are Terraform-managed — leave them alone: `database` (RDS), `redis` (ElastiCache `REDIS_URL`), `qdrant` (random API key), and `agents` (random `AGENT_API_KEY`/`AI_TOKEN_SECRET`/`COLLAB_JWT_SECRET`).

Secrets Manager holds **14 groups total** — 4 Terraform-managed (`database`, `redis`, `qdrant`, `agents`) and 10 operator-filled — so you can cross-check the full set against the verify loop in step 1.1.11.

Replace placeholder values with the credentials you gathered in step 0.1.

#### 1.1.1 `auth`

`BETTER_AUTH_SECRET` (random) and `AGENT_SERVICE_SECRET` (random, but you'll also paste it into GitLab CI variables so the Cloudflare PartyKit worker can verify tokens). `AGENT_API_KEY`/`AI_TOKEN_SECRET`/`COLLAB_JWT_SECRET` are NOT set here — Terraform generates them in the `agents` group (which extracts after `auth`, so anything you put here is overridden anyway).

```bash
AGENT_SERVICE_SECRET=$(openssl rand -base64 32)
echo "AGENT_SERVICE_SECRET: $AGENT_SERVICE_SECRET  # save this for GitLab CI"

aws secretsmanager put-secret-value \
  --secret-id fabric/dev/auth \
  --secret-string "$(jq -nc \
    --arg better_auth_secret "$(openssl rand -base64 48)" \
    --arg agent_service_secret "$AGENT_SERVICE_SECRET" \
    '{
       BETTER_AUTH_SECRET:    $better_auth_secret,
       AGENT_SERVICE_SECRET:  $agent_service_secret
     }')"
```

#### 1.1.2 `ai-providers`

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

At least one key required. Empty strings for unused providers.

#### 1.1.3 `oauth`

Set the pair for whichever provider you registered.

```bash
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/oauth \
  --secret-string '{
    "GOOGLE_CLIENT_ID":             "XXXXX.apps.googleusercontent.com",
    "GOOGLE_CLIENT_SECRET":         "GOCSPX-XXXX",
    "FABRIC_GITHUB_CLIENT_ID":      "",
    "FABRIC_GITHUB_CLIENT_SECRET":  "",
    "MICROSOFT_GRAPH_CLIENT_ID":    "",
    "MICROSOFT_GRAPH_CLIENT_SECRET":""
  }'
```

> **Registration order matters.** You can register the OAuth app before or after the deploy, but the redirect URI must match what the ALB actually serves. If you don't know the ALB hostname yet, register with a placeholder like `http://localhost/api/auth/callback/google`, deploy, then update the redirect URI at the provider once you have the real hostname.

#### 1.1.4 `integrations`

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

All optional. Empty strings are fine for now.

#### 1.1.5 `upstash` (Upstash REST credentials)

```bash
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/upstash \
  --secret-string '{
    "UPSTASH_REDIS_REST_URL":   "https://XXXX.upstash.io",
    "UPSTASH_REDIS_REST_TOKEN": "AX..."
  }'
```

**Do NOT touch `fabric/dev/redis`.** It is Terraform-managed — `REDIS_URL` (`rediss://default:<auth-token>@<endpoint>:6379`) is written from the ElastiCache outputs with `ignore_changes`. There is no ConfigMap fallback, so a `put-secret-value` against `fabric/dev/redis` erases the connection string and pods lose ElastiCache access with no automatic recovery.

#### 1.1.6 `temporal`

```bash
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/temporal \
  --secret-string '{
    "TEMPORAL_CLOUD_API_KEY": "XXXX"
  }'
```

The env var name must be `TEMPORAL_CLOUD_API_KEY` — it has to match `packages/temporal/src/client.ts` exactly because ESO injects Secrets Manager JSON keys as env vars verbatim. A key named `TEMPORAL_API_KEY` is never read, so the worker connects with no API key and crash-loops.

`TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` go into Helm values, not here.

#### 1.1.7 `cloudflare`

```bash
SANDBOX_AUTH_SECRET=$(openssl rand -base64 32)
echo "SANDBOX_AUTH_SECRET: $SANDBOX_AUTH_SECRET  # also configure same value in wrangler.toml secret for sandbox-worker"

aws secretsmanager put-secret-value \
  --secret-id fabric/dev/cloudflare \
  --secret-string "$(jq -nc \
    --arg turnstile "0xXXXX" \
    --arg sandbox   "$SANDBOX_AUTH_SECRET" \
    '{
       TURNSTILE_SECRET_KEY: $turnstile,
       SANDBOX_AUTH_SECRET:  $sandbox
     }')"
```

(The `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are build-time only — they live in GitLab CI variables, set in step 1.2.)

#### 1.1.8 `storage` (optional with IRSA)

The `fabric` ServiceAccount has an IRSA role with S3 permissions on the 7 application buckets. With IRSA, leave these blank — the SDK auto-discovers credentials:

```bash
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/storage \
  --secret-string '{
    "S3_ACCESS_KEY_ID":     "",
    "S3_SECRET_ACCESS_KEY": ""
  }'
```

Only set explicit keys if you're pointing storage at a non-AWS S3-compatible store.

#### 1.1.9 `email`

Resend is the only supported email provider:

```bash
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/email \
  --secret-string '{ "RESEND_API_KEY": "re_XXXX" }'
```

#### 1.1.10 `payments` (optional)

Skip if you're not testing billing. Stripe is the only supported provider — see `EXTERNAL-SERVICES.md` for the shape. Minimum to leave the group well-formed:

```bash
aws secretsmanager put-secret-value \
  --secret-id fabric/dev/payments \
  --secret-string '{}'
```

#### 1.1.11 Verify

```bash
for g in database auth ai-providers oauth integrations redis temporal cloudflare storage email payments qdrant agents upstash; do
  echo "--- $g ---"
  aws secretsmanager get-secret-value \
    --secret-id "fabric/dev/$g" \
    --query 'SecretString' --output text \
  | jq 'keys'
done
```

Confirm each group has the expected keys.

### 1.2 Set GitLab CI/CD variables

UI flow: project → Settings → CI/CD → expand **Variables** → **Add variable**. For each one below, set **Type = Variable**, **Mask variable = ✓**, **Protect variable = ✓**.

| Name | Value source |
|---|---|
| `DEPLOYER_ROLE_ARN` (NOT `AWS_ROLE_ARN` — reserved AWS SDK IRSA var) | `terraform output -raw deployer_role_arn` |
| `ECR_REGISTRY` | `terraform output -raw ecr_registry_url` |
| `AWS_REGION` | `us-east-1` |
| `CLUSTER_NAME` | `fabric-dev` |
| `APP_IRSA_ROLE_ARN` | `terraform output -raw app_irsa_role_arn` — **required**; `deploy:aws:*` hard-fails without it (app pods would have no S3/KMS identity) |
| `CLOUDFLARE_API_TOKEN` | your Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account ID |
| `AGENT_SERVICE_SECRET` | the same value you wrote into `fabric/dev/auth` |
| `ACM_CERT_ARN` | **Any TLS deploy**, scoped `[ENV]` — production, and dev after the §2.3 HTTPS upgrade. Set with `--scope dev` / `--scope production`; a TLS deploy hard-fails without it |

`FABRIC_API_URL` is set after the first deploy (once you have the ALB hostname).

CLI alternative (faster):

```bash
glab variable set DEPLOYER_ROLE_ARN     "$(terraform output -raw deployer_role_arn)" --masked --protected
glab variable set ECR_REGISTRY          "$(terraform output -raw ecr_registry_url)"  --masked --protected
glab variable set AWS_REGION            "us-east-1"                                  --protected
glab variable set CLUSTER_NAME          "fabric-dev"                                 --protected

# ── [ENV] deploy-only: SCOPED to `dev` ────────────────────────────────────────
# `--scope dev` is not decoration. Both deploy jobs declare an environment, so
# scoping works, and it is what stops a later production deploy from picking up
# dev's IRSA role, buckets and Temporal namespace. Repeat with `--scope
# production` when you stand prod up.
glab variable set APP_IRSA_ROLE_ARN  "$(terraform output -raw app_irsa_role_arn)" --masked --protected --scope dev
glab variable set S3_BUCKET_PREFIX   "$(terraform output -json s3_buckets | jq -r '.avatars | sub("-avatars$";"")')" --scope dev
glab variable set TEMPORAL_NAMESPACE "<namespace>.<account>"                      --protected --scope dev
# glab variable set TEMPORAL_ADDRESS "<region>.aws.api.temporal.io:7233"          --scope dev   # only outside the chart's default region
# glab variable set VPC_CIDR         "10.0.0.0/16"                                --scope dev   # optional; narrows the NetworkPolicy
# ACM_CERT_ARN is also [ENV] — needed by ANY TLS deploy, not just prod. Set it
# with --scope dev for the Day-2 HTTPS upgrade (§2.3), --scope production for prod.
# WEB_ALB_HOSTNAME is set in §1.3 Pass 2 — the ALB does not exist until the first deploy creates it.
glab variable set CLOUDFLARE_API_TOKEN  "XXXX"                                       --masked --protected
glab variable set CLOUDFLARE_ACCOUNT_ID "XXXX"                                       --masked --protected
glab variable set AGENT_SERVICE_SECRET  "$AGENT_SERVICE_SECRET"                      --masked --protected
# Any TLS deploy — production, and dev after the §2.3 HTTPS upgrade. Scoped [ENV]:
# glab variable set ACM_CERT_ARN        "arn:aws:acm:us-east-1:...:certificate/..." --masked --protected --scope dev
```

### 1.3 Set the Helm environment wiring (and the first-deploy ordering)

**Nothing is edited into `values-dev.yaml`.** The chart carries sizing and
profile only; the account-bound values come from the GitLab CI/CD variables set
in §1.2 and are written into a generated override by `ci/gitlab/60-deploy-aws.yml`
at deploy time. `deploy:aws:*` hard-fails if a required one is missing, so a
deploy cannot come up green pointed at infrastructure that does not exist.

> **StorageClass note.** The dev cluster has no default StorageClass, so qdrant
> must keep `qdrant.storage.storageClassName: gp2` in `values-dev.yaml` until a
> default `gp3` (`ebs.csi.aws.com`) StorageClass is created. That one *is* a
> profile value and stays in the file. Without it, qdrant's PVC stays `Pending`
> on a fresh cluster.

#### The first deploy needs two passes

`NEXT_PUBLIC_SITE_URL` is compiled into the web bundle by `next build` — a
runtime env var or ConfigMap cannot change it afterwards. So the public URL has
to be known *before* the image is built. On a brand-new cluster with no domain
it is not: the ALB is created by the very deploy that needs its hostname.

The build job fails closed rather than silently baking `http://localhost:3000`
into client code, so break the cycle explicitly:

**Pass 1 — bring the ALB into existence.** One variable:

```bash
# A placeholder just for this run; it is removed in pass 2.
glab variable set NEXT_PUBLIC_SITE_URL "http://bootstrap.invalid" --protected
```

That satisfies the *build* job. The *deploy* job needs nothing extra: when
`WEB_ALB_HOSTNAME` is unset and no `fabric` release exists yet, it detects the
genesis case, leaves `global.siteUrl` empty (a supported chart state that
renders a host-less Ingress) and logs a warning telling you to complete pass 2.
That detection re-arms into a hard failure the moment a release exists, so it
cannot become a way to ship a permanently URL-less deployment.

Push (§1.4). The stack deploys and the ALB is created. The app is reachable, but
auth magic-links and absolute URLs still point at the placeholder — expected.

**Pass 2 — bake the real hostname.** After §1.5 captures the ALB hostname, set
`WEB_ALB_HOSTNAME`, remove the placeholder, and push a **new commit**:

```bash
glab variable set WEB_ALB_HOSTNAME "$ALB_HOSTNAME"   # unscoped — the build reads it
glab variable delete NEXT_PUBLIC_SITE_URL

# A NEW COMMIT, not a pipeline re-run. Images are tagged $CI_COMMIT_SHA and the
# ECR repositories are immutable, so re-running the same pipeline re-pushes a
# tag that already exists and the build fails with ImageTagAlreadyExistsException.
# An empty commit is enough — it is a new SHA, so a fresh set of image tags.
git commit --allow-empty -m "chore: rebuild web image with the real site URL"
git push
```

> **Do not retry just the deploy job.** The image built in Pass 1 has the
> placeholder URL compiled into it; retrying the deploy alone would redeploy that
> same image. The web image has to be rebuilt, which means a new commit.

**If you already have a domain, skip the two passes.** Point DNS at the ALB
after it exists, or for a TLS/prod deploy set `PROD_DOMAIN` (and `ACM_CERT_ARN`)
up front — a known hostname removes the cycle entirely, which is why the prod
path has no bootstrap dance.

### 1.4 First deploy

The push triggered the pipeline. Watch it:

```
https://gitlab.com/youruser/fabric-test/-/pipelines
```

Or via CLI:

```bash
glab ci view
glab ci status --live
```

Stages in order:
- `validate` (1–2 min)
- `test` (2–5 min)
- `security` (2–4 min)
- `build` ×14 in parallel (5–10 min)
- `migrate` (<1 min — renders manifest; actual migration runs as Helm hook)
- `deploy-aws` (5–10 min)
- `deploy-cloudflare` (2–3 min, allowed to fail)
- `smoke` (<1 min)

Expect **15–25 minutes** end-to-end on the first run.

> **Redeploy without rebuilding.** To skip the 14-image rebuild and redeploy known-good ECR images, run the pipeline with `SKIP_BUILD=true` and `IMAGE_TAG=<known-good-sha>`. This requires setting the GitLab project's `ci_pipeline_variables_minimum_override_role` away from its default `no_one_allowed` (Settings → CI/CD → Variables) so trigger-time variables are honored — otherwise the values are silently dropped.

While the build runs, verify from your laptop:

```bash
aws eks update-kubeconfig --name fabric-dev --region us-east-1
kubectl get pods -n fabric -w
```

You'll see pods come up over the course of the deploy stage.

### 1.5 Open your app

```bash
kubectl get ingress fabric-web -n fabric
```

The `ADDRESS` column shows a long `fabric-XXXX.us-east-1.elb.amazonaws.com` hostname. Visit `http://<that-hostname>` — you should see the Fabric marketing landing page.

If you configured `global.domain`, External DNS will create an A/AAAA record pointing your domain at the ALB; allow ~2 minutes for propagation.

Capture the URL for the next step:

```bash
ALB_HOSTNAME=$(kubectl get ingress fabric-web -n fabric -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
echo "App URL: http://$ALB_HOSTNAME"
```

Set `FABRIC_API_URL` in GitLab CI variables to this value:

```bash
glab variable set FABRIC_API_URL "http://$ALB_HOSTNAME" --masked --protected
```

The next pipeline run (when `61-deploy-cloudflare` re-runs) will use this for the PartyKit worker.

### 1.6 Create the first admin user

Two paths. Pick one.

#### 1.6.1 OAuth-first (recommended)

1. Update the OAuth app's redirect URI to match the actual ALB hostname:
   - Google Console: `http://$ALB_HOSTNAME/api/auth/callback/google`.
   - GitHub: `http://$ALB_HOSTNAME/api/auth/callback/github`.
   - Microsoft: `http://$ALB_HOSTNAME/api/auth/callback/microsoft`.
2. (Optional) Force ESO to pull the latest Secrets Manager state if you recently changed it:
   ```bash
   kubectl annotate externalsecret/fabric-app-secrets force-sync=$(date +%s) -n fabric --overwrite
   kubectl rollout restart deployment/web -n fabric
   ```
3. Visit `http://$ALB_HOSTNAME`, click "Sign in with Google" (or whichever provider you configured), complete the OAuth flow.
4. Promote yourself to admin. The pod that has Prisma + `DATABASE_URL` is `temporal-worker`:
   ```bash
   kubectl exec -it -n fabric deploy/temporal-worker -- /bin/sh

   # Inside the pod:
   pnpm --filter @repo/database exec prisma db execute \
     --stdin --schema=./prisma/schema.prisma <<'SQL'
   UPDATE "User" SET role = 'admin' WHERE email = 'you@example.com';
   SQL
   ```

#### 1.6.2 Seed-first (unattended)

```bash
helm upgrade --install fabric ./deploy/helm/fabric \
  -f deploy/helm/fabric/values-dev.yaml \
  -n fabric --create-namespace \
  --set seed.enabled=true \
  --set 'seed.usersJson=[{"email":"you@example.com","name":"You","role":"admin"}]' \
  --set seed.orgSlug=acme \
  --set seed.orgName=Acme \
  --set global.imageRegistry="$(terraform -chdir=deploy/terraform/environments/dev output -raw ecr_registry_url)" \
  --set global.imageTag=latest \
  --atomic --timeout 15m
```

Then flip seed off:

```bash
helm upgrade --install fabric ./deploy/helm/fabric \
  -f deploy/helm/fabric/values-dev.yaml -n fabric \
  --set seed.enabled=false \
  --atomic --timeout 15m
```

(Or edit `values-dev.yaml` to set `seed.enabled: false` and let the next pipeline run handle the upgrade.)

End of Day 1. You have a working admin account on an HTTP-only deploy. If that's all you need (e.g. an internal-network deployment), you're done.

---

## Day 2 — HTTPS upgrade (optional)

Only do this if you have a domain you can delegate to AWS.

### 2.1 Delegate the domain

Edit `deploy/terraform/environments/dev/terraform.tfvars`:

```hcl
domain_name = "fabric.example.com"
```

```bash
cd deploy/terraform/environments/dev
terraform apply
terraform output -json route53_name_servers
```

The output lists 4 NS hostnames. At your domain registrar (or parent zone), set these as the NS records for `fabric.example.com`. Propagation:

```bash
dig +short NS fabric.example.com
# Should return the four AWS NS hostnames within a few minutes.
```

### 2.2 Request an ACM certificate

```bash
CERT_ARN=$(aws acm request-certificate \
  --domain-name fabric.example.com \
  --validation-method DNS \
  --region us-east-1 \
  --query CertificateArn --output text)

echo "Cert ARN: $CERT_ARN"

# Get the validation CNAME ACM emits:
aws acm describe-certificate --certificate-arn "$CERT_ARN" --region us-east-1 \
  --query 'Certificate.DomainValidationOptions[*].ResourceRecord' --output table
```

Add the `Name`/`Value` CNAME to your hosted zone:

```bash
ZONE_ID=$(terraform output -raw route53_zone_id 2>/dev/null || aws route53 list-hosted-zones-by-name \
  --dns-name fabric.example.com. \
  --query 'HostedZones[0].Id' --output text | sed 's|/hostedzone/||')

NAME=$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region us-east-1 \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Name' --output text)
VALUE=$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region us-east-1 \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Value' --output text)

aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
  --change-batch "{
    \"Changes\": [{
      \"Action\": \"UPSERT\",
      \"ResourceRecordSet\": {
        \"Name\": \"$NAME\", \"Type\": \"CNAME\", \"TTL\": 300,
        \"ResourceRecords\": [{ \"Value\": \"$VALUE\" }]
      }
    }]
  }"

# Wait for issuance (1–5 minutes typically)
aws acm wait certificate-validated --certificate-arn "$CERT_ARN" --region us-east-1
```

### 2.3 Flip Ingress to HTTPS

Set these GitLab CI/CD variables — **not** a values-file edit:

```bash
glab variable set DEV_TLS      "true"
glab variable set DEV_DOMAIN   "app.example.com"
glab variable set ACM_CERT_ARN "$CERT_ARN" --masked --protected --scope dev
glab variable set DEV_ENV_URL   "https://app.example.com"   # the GitLab "View app" link
```

Re-run the pipeline (an empty commit is enough). The deploy job switches from
`global.siteUrl` to `global.domain` + `ingress.tls`, and — because
`NEXT_PUBLIC_SITE_URL` is compiled into the bundle — the web image is rebuilt
with the `https://` URL baked in. The ALB accepts HTTPS within ~2 minutes.

> **Why not the values file.** `global.siteUrl` takes precedence over
> `global.domain`, and the deploy job sets `siteUrl` on every non-TLS deploy. A
> domain committed to `values-dev.yaml` while `DEV_TLS` is unset is therefore
> silently ignored — you would get a TLS Ingress fronting an app that still
> believes it lives at the ALB hostname. The variable flips both halves at once.

### 2.4 Update OAuth redirect URIs

At each OAuth provider, change the redirect URI to the new HTTPS URL:
- Google: `https://fabric.example.com/api/auth/callback/google`
- GitHub: `https://fabric.example.com/api/auth/callback/github`
- Microsoft: `https://fabric.example.com/api/auth/callback/microsoft`

Forgetting this step is the #1 cause of post-HTTPS login failures.

### 2.5 Update GitLab CI variable `FABRIC_API_URL`

```bash
glab variable set FABRIC_API_URL "https://fabric.example.com" --masked --protected
```

Trigger one more pipeline run so the PartyKit worker picks up the new URL.

---

## Teardown

When you're done testing — or pausing for the night to save the ~$0.31/hour:

```bash
cd deploy/terraform/environments/dev
terraform destroy
```

Type `yes`. Expect ~15 minutes.

### What destroy cleans up

- VPC, EKS, RDS, ElastiCache, ECR (force-deleted with images), S3 (force-destroyed with objects), Secrets Manager (immediate delete), KMS keys, ALB Controller, ESO, External DNS, OIDC provider, GitLab Runner, Budgets, Route 53 zone.

### What destroy LEAVES behind on purpose

- `fabric-tfstate-<account>` S3 bucket — your Terraform state lives here, outside the dev env.
- `fabric-tfstate-lock` DynamoDB table — same reason.
- The OIDC provider thumbprint cache in AWS (~24 hours after the last assume-role call). Harmless.
- Cloudflare workers (PartyKit, sandbox-worker) — not Terraform-managed; delete via Cloudflare dashboard if desired.
- Upstash Redis DB, Temporal Cloud namespace, SaaS accounts — manage via their respective dashboards.

### If destroy hangs

| Symptom | Common cause | Fix |
|---|---|---|
| Stuck on subnet delete | NAT GW still has an ENI | Wait 5 min; if still stuck, detach the offending ENI in the EC2 console. |
| Stuck on ECR delete | Image still in use somewhere | `force_delete = true` in the dev module should prevent this; if not, manually delete images. |
| Stuck on S3 delete | Objects in versioned bucket | `force_destroy = true` covers it for managed buckets; for the state bucket, you have to empty + delete manually. |
| Stuck on KMS delete | `recovery_window_in_days > 0` (not in dev) | Dev module uses 0; if you copied to prod and hit this, the keys go into "pending deletion" with a 7-day window. Schedule key deletion or wait. |
| Stuck on RDS delete | `deletion_protection` flipped to `true` | Disable it in the RDS console, then re-run destroy. |
| EKS Access Entry blocking | OIDC provider remnants | `aws iam delete-open-id-connect-provider --open-id-connect-provider-arn <arn>` to clean up. |

### Verify

```bash
aws eks list-clusters --region us-east-1 | jq .
# Should be empty (or no fabric-dev)

aws rds describe-db-instances --region us-east-1 \
  --query 'DBInstances[].DBInstanceIdentifier' | jq .
# Should not include "fabric-dev-pg"

aws s3api list-buckets --query 'Buckets[?starts_with(Name, `fabric-dev-`)]' | jq .
# Should be empty (except possibly fabric-tfstate-<account> which is intentional)
```

If everything's empty, destroy worked. The hourly cost stops accruing immediately for compute (EKS, EC2) and within minutes for storage (S3, EBS).

---

## Resume after teardown

When you're ready to spin up again:

1. `cd deploy/terraform/environments/dev`
2. `terraform init` (re-init against the existing state bucket — bootstrap.sh is idempotent and not needed)
3. Phase 1 + Phase 2 apply (steps 0.10 + 0.11). EKS provisioning takes ~20 minutes again.
4. **Secrets Manager state was wiped** — repeat step 1.1 (the 10 `put-secret-value` commands). Keep your scratch file from Day 0 with the credentials.
5. **Helm release was wiped** — first pipeline push after Phase 2 re-installs everything fresh.
6. **First admin user must be recreated** — repeat step 1.6.

Resuming end-to-end is typically 30–45 minutes once you've done it once.
