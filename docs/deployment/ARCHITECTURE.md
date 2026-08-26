# Fabric on AWS — Architecture Overview

How the pieces fit together. Topology, request flow, build flow, and the rationale for each load-bearing decision.

## 1. Topology

```
                  ┌──────────────────────────────────────────────────────────────┐
                  │                          AWS                                 │
                  │                                                              │
  ┌────────────┐  │   ┌──────────────────────────── VPC ────────────────────┐    │
  │  Browser   │──┼──▶│                                                     │    │
  └────────────┘  │   │   ┌────────────┐         ┌──────────────────────┐   │    │
                  │   │   │    ALB     │────────▶│         EKS          │   │    │
                  │   │   │ (Ingress)  │         │  ┌────────────────┐  │   │    │
                  │   │   └────────────┘         │  │   namespace:   │  │   │    │
                  │   │         ▲                │  │     fabric     │  │   │    │
                  │   │         │ Route 53       │  │                │  │   │    │
                  │   │   ┌────────────┐         │  │  web (×N)      │  │   │    │
                  │   │   │  Route 53  │ (opt)   │  │  temporal-     │  │   │    │
                  │   │   └────────────┘         │  │    worker      │  │   │    │
                  │   │                          │  │  mcp-stdio-    │  │   │    │
                  │   │   ┌────────────┐         │  │    wrapper     │  │   │    │
                  │   │   │    RDS     │◀────────┤  │  11 LangGraph  │  │   │    │
                  │   │   │ Postgres16 │         │  │     agents     │  │   │    │
                  │   │   └────────────┘         │  │  (configmap +  │  │   │    │
                  │   │                          │  │  fabric-app-   │  │   │    │
                  │   │   ┌────────────┐         │  │  secrets ESO)  │  │   │    │
                  │   │   │ElastiCache │◀────────┤  └────────────────┘  │   │    │
                  │   │   │  Redis 7.1 │         │                      │   │    │
                  │   │   └────────────┘         │  IRSA → ServiceAcct  │   │    │
                  │   │                          └──────────────────────┘   │    │
                  │   │                                  │                  │    │
                  │   │   ┌────────────┐                 │                  │    │
                  │   │   │    ECR     │◀────────────────┘                  │    │
                  │   │   │ (14 repos) │   (image pulls)                    │    │
                  │   │   └────────────┘                                    │    │
                  │   │                                                     │    │
                  │   │   ┌────────────┐   ┌────────────┐   ┌───────────┐   │    │
                  │   │   │     S3     │   │  Secrets   │   │    KMS    │   │    │
                  │   │   │ (7 bckts)  │   │  Manager   │   │  (5 keys) │   │    │
                  │   │   └────────────┘   │ (14 grps)  │   └───────────┘   │    │
                  │   │                    └──────┬─────┘                   │    │
                  │   │                           │ ESO sync                │    │
                  │   │                           ▼                         │    │
                  │   │                       (rendered                     │    │
                  │   │                       k8s Secret)                   │    │
                  │   │                                                     │    │
                  │   └─────────────────────────────────────────────────────┘    │
                  │                                                              │
                  └──────────────────────────────────────────────────────────────┘

       │                                            │
       │                                            ▼
       │                                ┌──────────────────────────┐
       │                                │       Cloudflare          │
       │                                │                           │
       │                                │  PartyKit (collab)        │
       ▼                                │  sandbox-worker           │
   ┌────────────┐                       │  Turnstile (CAPTCHA)      │
   │   GitLab   │                       └──────────────────────────┘
   │            │
   │ ┌────────┐ │              ┌──────────────────────┐
   │ │  CI    │ │─OIDC assume─▶│  External services   │
   │ │ (.yml) │ │  short-lived │                      │
   │ └────────┘ │   AWS creds  │  Temporal Cloud      │
   │ ┌────────┐ │              │  AI providers        │
   │ │ Self-  │ │              │   (Anthropic /       │
   │ │ hosted │ │              │    OpenAI / ...)     │
   │ │ Runner │◀┼─tagged       │  Upstash Redis       │
   │ │ on EKS │ │ fabric-runner│   (rate-limit/MCP)   │
   │ └────────┘ │              │  OAuth providers     │
   └────────────┘              │   (Google/GitHub/    │
                               │    Microsoft Graph)  │
                               │  SMTP provider       │
                               └──────────────────────┘
```

### Components

#### AWS

| Component | Purpose | Provisioned by |
|---|---|---|
| VPC | 3 public + 3 private subnets, single NAT GW (dev) | `module.vpc` |
| EKS | Kubernetes 1.35 (standard support — avoids the extended-support surcharge), managed node group (t3.large ×2 dev; 40Gi root volumes; autoscale 2-4) | `module.eks` |
| RDS | Postgres 16, db.t4g.micro, 20 GB gp3 (dev); SG ingress wired to the EKS **node** security group, not the cluster SG | `module.rds` |
| ElastiCache | Redis 7.1, cache.t4g.micro single AZ (dev); SG ingress wired to the EKS **node** security group, not the cluster SG | `module.elasticache` |
| ECR | 14 private repos with image scanning | `module.ecr` |
| S3 | 7 application buckets, account-prefix for global uniqueness | `module.s3` |
| Secrets Manager | 14 secret groups (`fabric/<env>/<group>`) | `module.secrets` |
| KMS | 5 customer-managed keys (eks / rds / s3 / secrets / ecr) | `module.kms` |
| ALB | One application load balancer per Ingress, managed by ALB Controller | ALB Controller addon |
| Route 53 | Hosted zone (opt-in via `domain_name`) | `module.route53` |

> RDS and ElastiCache ingress is wired to the EKS **node** security group (`module.eks.node_security_group_id`), not the cluster/control-plane SG, because pod traffic egresses from the worker-node ENIs. Wiring it to the cluster SG silently blocks all DB/Redis traffic.

#### EKS workload

| Workload | Image | Source |
|---|---|---|
| `web` | `fabric-web` (Next.js standalone) | `apps/web` |
| `temporal-worker` | `fabric-temporal-worker` | `packages/temporal` |
| `mcp-stdio-wrapper` | `fabric-mcp-stdio-wrapper` | `packages/mcp-stdio-wrapper` |
| 11 agents | `fabric-<agent-name>` | `agents/langchain/<name>` |
| `qdrant` | upstream (self-hosted vector DB, StatefulSet) | `deploy/helm/fabric` |
| migrate Job | reuses temporal-worker image | Helm pre-upgrade hook |
| seed Job | reuses temporal-worker image | opt-in via `seed.enabled=true` |
| OTEL Collector | upstream | DaemonSet, ships to CloudWatch |
| FluentBit | upstream | DaemonSet, ships to CloudWatch — disabled in dev (CrashLoopBackOff blocks helm `--wait`); re-enable once IRSA/config is fixed |

`custom-agent-runtime` is wired but disabled (`customAgentRuntime.enabled: false`) — the MVP ships 14 services, with the runtime as a follow-up.

> **Memory limits.** `web` and `temporal-worker` both require a memory limit of **≥1.5Gi** (`values-dev.yaml` pins both to `limits.memory: 1536Mi`). Under 512Mi the Node runtime OOMs — `web` crash-loops with a V8 "Allocation failed", and `temporal-worker` exits 134 after ~60s. Shrinking these limits without keeping the headroom reintroduces the crash.

> **`mcp-stdio-wrapper` security context.** This service deliberately omits pod-level `runAsNonRoot: true`: its image `USER` is the non-numeric name `mcpwrapper` (from `useradd -r`, no pinned UID), so `runAsNonRoot` without a numeric `runAsUser` causes `CreateContainerConfigError`.

> **Dev profile is smaller.** The `11 agents` figure (8 application + 3 weave: weave-readers/weave-shuttle/weave-planners) is the `values.yaml` default. The dev profile (`values-dev.yaml`) **defers all three weave agents** and **disables FluentBit**, so a dev deploy runs 8 agents and is smaller than the 14-service default/prod footprint.

> **Qdrant storage.** The cluster has no default StorageClass (only an unmarked `gp2`), so dev pins `qdrant.storage.storageClassName=gp2`; otherwise the Qdrant PVC stays `Pending` forever. (TODO: create a default `gp3` `ebs.csi.aws.com` StorageClass so the `values.yaml` default `''` resolves.)

#### Cluster-side controllers

| Controller | Role | Module |
|---|---|---|
| AWS Load Balancer Controller | Realizes Ingress as ALB | `module.alb_controller` |
| External Secrets Operator | Syncs Secrets Manager → k8s `Secret` | `module.external_secrets` |
| External DNS | Manages Route 53 records for Ingress hosts (only when `domain_name` set) | `module.external_dns` |
| GitLab Runner | Executes pipeline jobs in-cluster | `module.gitlab_runner` |

#### Cloudflare

| Worker | Purpose |
|---|---|
| `party-cf` (PartyKit) | WebSocket fan-out for real-time collaboration (Yjs) |
| `sandbox-worker` | Tool execution sandbox for AI agents |
| Turnstile widget | CAPTCHA on auth endpoints |

#### External SaaS

| Service | Purpose |
|---|---|
| Temporal Cloud | Durable workflow execution |
| Upstash Redis | Rate-limit middleware + MCP route (REST API only) |
| AI providers | Anthropic / OpenAI / Google AI / Groq / Cerebras / DeepSeek |
| OAuth providers | Google / GitHub / Microsoft Graph login |
| Resend | Email delivery (the only supported provider) |

#### GitLab

| Element | Purpose |
|---|---|
| Project repo | Source of truth |
| CI pipeline | `ci/gitlab/*.yml` templates included by `.gitlab-ci.yml` |
| OIDC trust | Federation with `module.gitlab_oidc` → assume `FabricDeployer` role |
| Self-hosted runner | Tagged `fabric-runner`, runs in-cluster |

---

## 2. Request flow — web app golden path

A logged-in user opens the dashboard:

```
1. Browser
   ↓ TCP/443 (or :80 in HTTP-only mode)
2. ALB
   ↓ HTTP/1.1, target group = web Service
3. web pod (Next.js)
   ↓ React Server Component renders, calls server actions / oRPC procedures
4a. RDS Postgres
       ↑ Prisma query for tenant data (DATABASE_URL from fabric-app-secrets)
       (the app + migrate Postgres connections set `PGSSLMODE=no-verify` because node-postgres
        defaults to no SSL and RDS rejects unencrypted connections — SQLSTATE 28000; prod follow-up
        is `verify-full` + the RDS CA bundle)
4b. ElastiCache Redis
       ↑ Better Auth session lookup, caching (REDIS_URL from fabric-app-secrets — Terraform-managed `redis` group, rediss:// + AUTH)
       (rate-limit counters + MCP route use Upstash REST, not this — UPSTASH_REDIS_REST_* from the `upstash` group)
4c. Agent (cluster DNS)
       ↑ http://<agent>.fabric.svc.cluster.local:<port>/invoke
4d. Temporal Cloud
       ↑ workflow start / signal (TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_CLOUD_API_KEY)
       (the JSON key in the `fabric/<env>/temporal` Secrets Manager group must be exactly
        `TEMPORAL_CLOUD_API_KEY`; TEMPORAL_ADDRESS/TEMPORAL_NAMESPACE come from the ConfigMap, not this secret)
4e. PartyKit (Cloudflare)
       ↑ WebSocket establish for live collab — token signed by web, verified by PartyKit
       ↑ NEXT_PUBLIC_PARTYKIT_HOST in ConfigMap
4f. S3
       ↑ presigned PUT/GET for uploads, IRSA-signed
4g. AI providers
       ↑ outbound HTTPS via NAT GW
5. Response streams back to the browser; UI re-renders with the data.
```

### Identity flow (OAuth)

```
1. Browser  → GET /login → web returns SignIn UI
2. Browser  → GET /api/auth/sign-in/google → web 302 → Google
3. Google   → 302 callback → /api/auth/callback/google
4. web       ↑ Google token exchange (GOOGLE_CLIENT_ID/SECRET from oauth secret)
   web       ↓ Better Auth creates/updates User, mints session
5. Browser  → cookie set, redirected to /app
```

OAuth providers require the redirect URI to match exactly. With HTTPS off, the URI is `http://<alb-host>/api/auth/callback/<provider>`; with HTTPS on, it is `https://<your-domain>/api/auth/callback/<provider>`. Switching modes requires updating the URI at the provider.

---

## 3. Build & deploy flow

```
git push origin main
        ↓
GitLab pipeline starts
        ↓
┌── validate ──┐      ┌── test ──┐      ┌── security ──┐
│ helm lint    │      │ vitest   │      │ semgrep      │
│ kubeconform  │      │ (turbo   │      │ osv-scanner  │
│ tf validate  │      │ affected)│      │ trufflehog   │
│ detect-      │      │          │      │ trivy        │
│  changes     │      │          │      │              │
└──────┬───────┘      └────┬─────┘      └──────┬───────┘
       │                   │                   │
       └──────────┬────────┴───────────────────┘
                  ↓
         ┌── build (×14 parallel matrix) ──┐
         │ ECR auth via runner IRSA role   │
         │   (not the deployer role)       │
         │ Kaniko → ECR push               │
         │   (immutable :$CI_COMMIT_SHA    │
         │    tag)                         │
         └─────────────────┬───────────────┘
                           ↓
                    ┌── migrate ──┐
                    │ render the  │
                    │ migrate Job │
                    │  manifest   │
                    │ (visibility │
                    │   only)     │
                    └──────┬──────┘
                           ↓
                ┌── deploy-aws ──┐  ┌── deploy-cloudflare ──┐
                │ assume         │  │ wrangler deploy        │
                │  FabricDeployer│  │   party-cf             │
                │  via OIDC web  │  │ wrangler deploy        │
                │  identity token│  │   sandbox-worker       │
                │ aws eks update │  │ (skipped, not failed,  │
                │  -kubeconfig   │  │  when CLOUDFLARE_API_   │
                │ helm upgrade   │  │  TOKEN is unset)        │
                │  --install     │  │                        │
                │  --atomic      │  │                        │
                │   (hook runs   │  │                        │
                │    migrate)    │  │                        │
                └────────┬───────┘  └───────────┬────────────┘
                         ↓                      ↓
                  ┌── smoke ──┐
                  │ curl ALB  │
                  │ /api/     │
                  │  health   │
                  └───────────┘
```

The build matrix always builds **all 14 images** for the commit SHA — it does not narrow the set based on affected-file detection. (Per-SHA completeness is deliberate: `deploy` sets one global `imageTag`, so a missing per-SHA image would break the rollout; the cost is mitigated by Kaniko layer reuse.) `detect-changes` still runs and produces a `SERVICES_TO_BUILD` artifact via Turbo's affected-file detection, but that output is currently informational only and is **not** consumed to narrow the build matrix.

For CI/Helm-only iterations there is a `SKIP_BUILD` + `IMAGE_TAG` escape hatch: set `SKIP_BUILD=true` and pin `IMAGE_TAG` to an existing tag to skip the 14-image rebuild and deploy images already in ECR. Driving it via trigger-time variables requires the GitLab project's `ci_pipeline_variables_minimum_override_role` to permit overrides (the default `no_one_allowed` blocks trigger-time variable overrides). Note the security `image-scan` gate can **never** be bypassed by `SKIP_BUILD`.

> **Smoke test caveat.** The `smoke` stage only `curl`s the web `/api/health` endpoint. `temporal-worker` has **no readiness probe** (only a `pgrep` liveness probe), so a broken Temporal Cloud connection crash-loops silently while `helm --wait` and the ALB smoke test still pass — you can see a "green" deploy with a dead worker. Check the worker logs/restart count after every deploy.

Helm runs migrations as a `pre-install`/`pre-upgrade` hook — the migrate Job completes before any Deployment rollout begins. The Job runs under a **dedicated `fabric-migrate` ServiceAccount** with its own DB-only `fabric-migrate-secrets` ExternalSecret, created as earlier-weighted hooks (weights `-20`/`-10`) so it can run before the app SA (`fabric`) and `fabric-app-secrets` exist on a fresh install (reusing the app SA caused `serviceaccount fabric not found` → `--atomic` rollback). The pre-upgrade ordering means **the OLD code must work against the NEW schema** for the rolling-update window, which is the standard expand-then-contract migration discipline (see TROUBLESHOOTING.md § Migration discipline).

---

## 4. Why the choices

### 4.1 Single Helm chart (not umbrella + sub-charts)

Every Fabric service is rendered from one chart at `deploy/helm/fabric/`. The Helm "release" wraps all 14 Deployments + the migrate hook + the cluster-side controllers' wiring in a single object.

**Why.** Helm rollback semantics are *per release*. If the web rollout succeeds but `task-planner` flaps, `--atomic` reverts the entire release together, including the migration hook (subject to the database-rollback caveat noted earlier). An umbrella chart with sub-charts would let `helm rollback` only revert the failing sub-chart, which is sometimes what you want but is dangerous when services share a schema and need to move in lock-step. The MVP picks the safer default.

Counter-argument: an umbrella chart makes it easier for downstream teams to subclass individual services. If you hit that limitation, fork the chart and extract sub-charts incrementally — the templates are organized by directory (`agents/`, `platform/`, `jobs/`, `observability/`) to make this straightforward.

### 4.2 External Secrets Operator (not the CSI Secrets Store driver)

**Why.** ESO uses a declarative `ExternalSecret` CRD that's GitOps-friendly: a single YAML in the chart declares which Secrets Manager groups feed which Kubernetes Secret. The CSI driver mounts secrets as files on demand — that works fine, but it forces every pod that consumes a secret to mount the CSI volume, which adds template noise across all 14 services. ESO renders a single `Secret` that 14 `envFrom` blocks reference, which keeps the templates tight.

ESO also handles automatic refresh on `refreshInterval`, picks up out-of-band edits made via `aws secretsmanager put-secret-value`, and emits useful status conditions (`Ready=False` with a clear reason) when a group is missing or malformed.

### 4.3 OIDC (not static AWS keys in GitLab variables)

**Why.** The pipeline mints a short-lived JWT (`aud=https://gitlab.com`), exchanges it via `sts assume-role-with-web-identity`, and gets back AWS credentials with a 1-hour TTL. There is nothing long-lived to rotate, nothing to revoke if a job log accidentally exposes a token, and the trust policy is scoped to a specific GitLab project path — a fork of the repo running its own pipeline against the same AWS account fails the trust check.

Counter-argument: static keys are simpler. They are, but they're also a perennial source of credential leaks. The Terraform module wires OIDC in 30 lines; pay the one-time cost.

#### Required GitLab CI/CD variables

Even with OIDC, an operator must set a handful of GitLab CI/CD variables before the pipeline can deploy (see `ci/gitlab/README.md` and `ci/gitlab/00-variables.yml`):

| Variable | Purpose |
|---|---|
| `DEPLOYER_ROLE_ARN` | ARN of the `FabricDeployer` role the deploy/migrate/smoke jobs assume via OIDC. **Must be `DEPLOYER_ROLE_ARN`, never `AWS_ROLE_ARN`** — `AWS_ROLE_ARN` is a reserved AWS SDK IRSA variable that shadows the Kaniko build pods' role and breaks ECR push. |
| `ECR_REGISTRY` | ECR registry host (`<account>.dkr.ecr.<region>.amazonaws.com`). |
| `CLOUDFLARE_API_TOKEN` | Token for the `wrangler` Cloudflare worker deploys (deploys skip cleanly if unset). |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account for the worker deploys. |
| `FABRIC_API_URL` | Base URL the deployed app/agents call back to. |
| `AGENT_SERVICE_SECRET` | Shared secret for service-to-service agent auth. |

After the Phase-2 Terraform apply (see §4.5) you must also set `APP_IRSA_ROLE_ARN` (from `terraform output -raw app_irsa_role_arn`) as a GitLab CI/CD variable — `60-deploy-aws.yml` writes it into a generated values override passed with `-f`, and hard-fails (`APP_IRSA_ROLE_ARN is unset — refusing to deploy`) without it. Scope it to the environment.

### 4.4 Self-hosted GitLab Runner on EKS (not GitLab.com shared runners)

**Why.** GitLab.com's free tier limits shared runner usage to 400 CI minutes/month. A single full Fabric pipeline run uses ~30 minutes (build matrix dominates), so a handful of pushes a day exhausts the budget by the first week. The self-hosted runner is a Helm release installed by `module.gitlab_runner`; it shares the EKS node group with the workloads, scales by pod-spawning, and adds ~$0/month in marginal cost (it's just pods on existing nodes).

Counter-argument: shared runners are zero-setup. They're a fine starting point if you're only running validate/test/lint locally and only ship the full pipeline a few times a month — but the moment you want to iterate, the cap bites.

> **Runner IRSA gotcha.** The runner Helm chart's ServiceAccount-annotation key is `rbac.serviceAccountAnnotations`, **not** `serviceAccount.annotations` (the latter is silently ignored, so Kaniko build pods fall back to the node role and ECR push fails with `AccessDenied`). The runner SA's IRSA role must carry `ecr:Put*`/`ecr:Get*` on the `fabric-*` repos, since the whole build's ECR auth depends on it.

### 4.5 Two-phase Terraform apply

**Why.** The `helm` and `kubernetes` providers in `environments/dev/main.tf` reference `module.eks.cluster_endpoint`. Terraform's provider configuration is evaluated at plan time for every resource in the configuration, including the foundational AWS resources that don't actually use those providers. With an unknown `cluster_endpoint` (because EKS hasn't been created yet), Terraform reports `Provider configuration not present` and refuses to plan anything.

The fix: split the apply.
- **Phase 1** uses `-target=` to plan only the resources whose providers resolve from data already in state — VPC, KMS, EKS itself, RDS, ElastiCache, ECR, S3, Secrets Manager, plus the DATABASE_URL Secrets Manager population.
- **Phase 2** is unrestricted; by now `module.eks.cluster_endpoint` has a known value, so the `helm`/`kubernetes` providers configure cleanly and the addon modules apply.

The alternative is to split into two distinct Terraform stacks (e.g. `environments/dev-foundation/` and `environments/dev-cluster/`), which doubles the state file count and complicates output passing. Two-phase apply within a single stack is the lower-friction option for an MVP.

> **Manual follow-up.** After the Phase-2 apply, set `APP_IRSA_ROLE_ARN` (from `terraform output -raw app_irsa_role_arn`) as a GitLab CI/CD variable — `60-deploy-aws.yml` writes it into a generated values override passed with `-f` and refuses to run without it (`APP_IRSA_ROLE_ARN is unset — refusing to deploy`). See §4.3 *Required GitLab CI/CD variables*.

### 4.6 HTTP-only default (not enforced HTTPS)

**Why.** The fastest path from `git clone` to a working deploy should not require domain delegation, ACM certificate request, DNS propagation wait, or registrar coordination. The ALB happily serves on its `*.elb.amazonaws.com` hostname over plain HTTP from the moment Ingress is realized — no extra steps. Operators evaluating the platform can have a live URL within 25 minutes of a fresh `terraform apply`.

The trade-off: OAuth and Better Auth's secure-cookie defaults assume HTTPS. Logins work over HTTP for local-style testing, but production deployments must add TLS. The chart makes HTTPS opt-in (`ingress.tls=true` + cert ARN) so the upgrade path is a single Helm value change once you have a cert; see AWS-DEPLOYMENT.md §8.

In HTTP-only mode the public URL is wired via the `global.siteUrl` chart override (set it to the raw ALB hostname). `global.siteUrl` drives `NEXT_PUBLIC_SITE_URL` and **takes precedence over `global.domain`**, keeping the Ingress host-less/wildcard. Set it post-deploy so OAuth/auth callbacks resolve to the live ALB host.

### 4.7 Upstash Redis *and* ElastiCache (both, not one)

**Why.** Two different APIs serve two different needs.
- **ElastiCache** speaks the standard Redis protocol. Better Auth sessions, rate-limit counters within the app, agent inter-call coordination — all use a `REDIS_URL` and the standard `ioredis` / `node-redis` client. ElastiCache is in-VPC and adds zero latency, but it isn't reachable from outside the cluster.
- **Upstash** exposes a stateless REST API over HTTPS. The rate-limit middleware and the MCP route call Upstash through `@upstash/redis`. They were designed to be edge-portable (the same code paths run on Cloudflare Workers); using the REST API keeps that portability and avoids opening ElastiCache to the public internet.

Counter-argument: pick one and proxy the other. That would consolidate the dependency surface but add a moving part (e.g. a Lambda fronting ElastiCache for the REST callers). Both providers have free tiers that comfortably cover a personal-test deploy; the MVP keeps the simpler two-service split.

---

## 5. Out-of-MVP scope

| Topic | Note |
|---|---|
| Multi-region | Single region per environment. Cross-region disaster recovery requires duplicating the stack and standing up replication; see AWS DocDB / Aurora Global Database patterns when this becomes relevant. |
| Production environment | `environments/prod/` is not provided. Copy `environments/dev`, flip the destroy-friendly flags (`skip_final_snapshot=false`, `force_destroy=false`, `recovery_window_in_days>=7`), increase replica/instance counts, and enable NetworkPolicy. |
| Auto-scaling | Cluster Autoscaler / Karpenter are not installed. The managed node group has a fixed size in dev; production deployments should add Karpenter via a separate addon module. |
| SOC2 / HIPAA compliance | The chart and Terraform produce a working stack but make no compliance claims. Audit-grade deployments need at minimum: encrypted EBS for node volumes, VPC flow logs, CloudTrail multi-region trail, Config rules, GuardDuty, and an SBOM/attestation pipeline. |
| Cost optimization | Spot node groups, Savings Plans, and Fargate hybrid models are all reasonable next steps not implemented in MVP. |
| `custom-agent-runtime` | Wired as a disabled deployment in the chart. Will be enabled in a follow-up when the runtime image is published. |
