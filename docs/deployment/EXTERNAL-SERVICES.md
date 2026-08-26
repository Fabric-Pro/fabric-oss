# Fabric — External Services Checklist

Every account, key, and token you need outside AWS — what each service does, where to sign up, and how it maps onto the deployment's environment variables and Secrets Manager groups.

## How to read this document

Each service entry lists:

- **What it's for** — the runtime role.
- **Signup link** — direct URL.
- **Free tier** — what fits in the free band (where applicable).
- **Where to find the credential** — exact dashboard path.
- **Permissions/scopes** — minimum required.
- **Env vars** — the variable names the app expects.
- **Secrets Manager group** — which `fabric/<env>/<group>` JSON contains the keys.

> The env vars and Secrets Manager mapping are the contract between this checklist and `ENVIRONMENT-VARIABLES.md`. Names are case-sensitive and load-bearing — the ExternalSecret CRD uses `dataFrom: extract:` which projects every JSON key as an env var of that exact name.

## Required vs Optional

### Required (the deploy will fail or be unusable without these)

1. [GitLab.com](#gitlabcom)
2. [Cloudflare](#cloudflare)
3. [Temporal Cloud](#temporal-cloud)
4. [Upstash Redis](#upstash-redis)
5. [At least one AI provider](#ai-providers): Anthropic **or** OpenAI
6. [At least one OAuth provider](#oauth-providers): Google **or** GitHub **or** Microsoft Graph
7. [Email (Resend)](#email-resend)

### Optional

- [Google AI / Vertex AI](#google-ai)
- [Groq](#groq), [Cerebras](#cerebras), [DeepSeek](#deepseek) (extra AI providers)
- [Qdrant Cloud](#qdrant-cloud) (vector DB — only if not using the in-cluster default)
- [LangSmith](#langsmith) (agent observability)
- [Letta](#letta) (agent memory)
- [LangGraph Cloud](#langgraph-cloud)
- [Vercel AI Gateway](#vercel-ai-gateway)
- Payments: [Stripe](#payments-provider-stripe)
- Analytics: [PostHog](#analytics-provider-posthog)
- [Your own domain](#your-domain) (required for HTTPS)

---

## Required

### GitLab.com

**What it's for.** Source control + CI/CD. The Fabric pipeline templates live in `ci/gitlab/`; you push to your fork or new project, the pipeline runs, and `helm upgrade` + `wrangler deploy` happen as a result.

**Signup.** <https://gitlab.com/users/sign_up>

**Free tier.** 5 GB storage / 10 GB transfer / 400 CI minutes per month for shared runners. Self-hosted runner usage is unlimited — and is what this deploy uses.

**What to set up.**
1. Create a project. Either fork `https://github.com/...` to GitLab via Import (UI: New project → Import project → Repo by URL) or create a blank project and `git push` the cloned repo to it.
2. Settings → CI/CD → Variables: set the variables listed in [AWS-DEPLOYMENT.md §4](./AWS-DEPLOYMENT.md#4-configuring-gitlab-cicd-variables).
3. Settings → CI/CD → Runners → New project runner: tag exactly `fabric-runner`, untoggle "Run untagged jobs", copy the `glrt-` token into `terraform.tfvars`.

**No env vars.** GitLab credentials never reach the running pods.

---

### Cloudflare

**What it's for.** Three workloads:

- **PartyKit (`party-cf`)** — real-time collaboration WebSocket fan-out (Yjs CRDT sync).
  Cloudflare is only **one** of three options — PartyKit can also be self-hosted in your
  Kubernetes cluster or disabled entirely. See [PARTYKIT.md](./PARTYKIT.md).
- **`sandbox-worker`** — code execution sandbox used by AI agent tools.
- **Turnstile** — CAPTCHA on auth endpoints (configurable kill switch via `NEXT_PUBLIC_ENABLE_CAPTCHA`).

**Signup.** <https://dash.cloudflare.com/sign-up>

**Free tier.** Workers free plan: 100k requests/day per worker; Turnstile free standalone tier: unlimited.

**Account ID.** Cloudflare dashboard → right sidebar → **Account ID** (32-char hex). Goes into the GitLab CI variable `CLOUDFLARE_ACCOUNT_ID`.

**API token.**
1. My Profile (top-right avatar) → API Tokens → Create Token → Custom token.
2. Permissions:
   - Account → **Workers Scripts** → Edit
   - Account → **Account Settings** → Read
   - Account → **Workers R2 Storage** → Edit (only if a downstream worker uses R2)
3. Account resources: Include → specific account → your account.
4. TTL: optional. Copy the token; goes into the GitLab CI variable `CLOUDFLARE_API_TOKEN`.

**Turnstile site key + secret.**
1. Dashboard → Turnstile → Add site → name = "Fabric dev", domain = your ALB host or domain. Widget mode: Managed.
2. After creating the site, copy:
   - **Site key** → public, goes into ConfigMap as `NEXT_PUBLIC_TURNSTILE_SITE_KEY`. (Not currently rendered from Helm — set via `--set-string` or add to `config-map.yaml` in a follow-up.)
   - **Secret key** → goes into Secrets Manager group `cloudflare` as `TURNSTILE_SECRET_KEY`.

**Sandbox auth secret.** Not a Cloudflare-issued value — you generate it. Both the web app and the sandbox-worker must agree. Stored as `SANDBOX_AUTH_SECRET` in the `cloudflare` group.

```bash
openssl rand -base64 32
```

**Env vars.**

| Var | Source | Where it lives |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | API token | GitLab CI variable (build-time only) |
| `CLOUDFLARE_ACCOUNT_ID` | dashboard | GitLab CI variable (build-time only) |
| `TURNSTILE_SECRET_KEY` | Turnstile site | `fabric/<env>/cloudflare` |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Turnstile site | ConfigMap (public) |
| `SANDBOX_AUTH_SECRET` | self-generated | `fabric/<env>/cloudflare` |
| `SANDBOX_WORKER_URL` | post-deploy | ConfigMap |
| `NEXT_PUBLIC_PARTYKIT_HOST` | post-deploy | ConfigMap (via `collaboration.partykitHost`) |

The PartyKit and sandbox-worker `*.workers.dev` hostnames are produced by `wrangler deploy` during the `61-deploy-cloudflare` CI job. Capture them and feed them back into `values-dev.yaml` before the next deploy.

---

### Temporal Cloud

**What it's for.** Durable workflow execution. Fabric uses Temporal for long-running orchestration (agent runs, scheduled retention, integration syncs).

**Signup.** <https://cloud.temporal.io/signup>

**Free tier.** 10,000 actions / month. Sufficient for evaluation; runs out quickly on real workloads.

**What to capture.**
1. Create a namespace. Pick a name (e.g. `fabric-dev`), Cloud picks a suffix → full namespace looks like `fabric-dev.abcde`.
2. Namespace overview page lists the gRPC endpoint, e.g. `fabric-dev.abcde.tmprl.cloud:7233`. This is the `TEMPORAL_ADDRESS`.
3. Settings → API Keys → Generate API Key. Copy the key.

**Env vars.**

| Var | Where it lives |
|---|---|
| `TEMPORAL_ADDRESS` | ConfigMap (set via `temporal.address`; optional `TEMPORAL_ADDRESS` CI variable, defaults from `values.yaml`) |
| `TEMPORAL_NAMESPACE` | ConfigMap (set via `temporal.namespace`, from the required `TEMPORAL_NAMESPACE` CI variable) |
| `TEMPORAL_CLOUD_API_KEY` | `fabric/<env>/temporal` |
| `ENABLE_TEMPORAL_WORKFLOWS` | ConfigMap (set to `"true"`) |

> **Warning.** The JSON key inside `fabric/<env>/temporal` MUST be exactly `TEMPORAL_CLOUD_API_KEY` — `TEMPORAL_API_KEY` is not read by the worker and crash-loops it.

> **Alternative auth.** Temporal Cloud also supports mTLS with a client cert pair. The Helm chart's env wiring is designed for the API key path (`TEMPORAL_CLOUD_API_KEY`); switching to mTLS requires mounting the cert files and changing the worker's connection options (the mTLS path consumes `TEMPORAL_CLIENT_CERT` / `TEMPORAL_TLS` rather than the API key). API key is the simpler MVP path.

---

### Upstash Redis

**What it's for.** Two HTTP-only callers:

- The **rate-limit middleware** in `apps/web` (`@upstash/redis` REST client).
- The **MCP route** (`apps/web/app/api/mcp/...`) — uses Upstash's transactional commands over HTTPS.

This is *distinct* from the in-cluster ElastiCache, which speaks the standard Redis protocol over `REDIS_URL`. Both are required; they serve different code paths.

**Signup.** <https://upstash.com>

**Free tier.** 10,000 commands / day, 256 MB max DB size.

**What to capture.**
1. Console → Create Database → Global. Region: pick one near your AWS region.
2. After creation, the Details tab lists:
   - **UPSTASH_REDIS_REST_URL** — `https://<id>.upstash.io`
   - **UPSTASH_REDIS_REST_TOKEN** — long base64 string

**Env vars.**

| Var | Where it lives |
|---|---|
| `UPSTASH_REDIS_REST_URL` | `fabric/<env>/upstash` |
| `UPSTASH_REDIS_REST_TOKEN` | `fabric/<env>/upstash` |

> **Why a dedicated `upstash` group.** ElastiCache's `REDIS_URL` (with TLS scheme + generated AUTH token) is Terraform-managed and lives in `fabric/<env>/redis`. Putting Upstash REST credentials in the same group meant `aws secretsmanager put-secret-value` would replace the entire JSON and clobber the Terraform-written `REDIS_URL` — leaving the cluster unreachable. Keeping the two in separate groups is the cleanest split: Terraform owns `redis`, operators own `upstash`.

---

### AI providers

You need at least one. The agents and conversational features check whichever keys are present and route requests accordingly.

#### Anthropic

**Signup.** <https://console.anthropic.com>

**Free tier.** $5 of credit on signup; pay-as-you-go after. Pricing: see <https://www.anthropic.com/pricing>.

**Where to find the key.** Console → Settings → API Keys → Create Key.

**Env var.** `ANTHROPIC_API_KEY` in `fabric/<env>/ai-providers`.

#### OpenAI

**Signup.** <https://platform.openai.com/signup>

**Free tier.** $5 of credit on first $5 deposit (occasional). Mostly pay-as-you-go. Pricing: <https://openai.com/api/pricing>.

**Where to find the key.** Platform → API Keys → Create new secret key.

**Env var.** `OPENAI_API_KEY` in `fabric/<env>/ai-providers`.

---

### OAuth providers

You need at least one to log in. The Helm chart wires all three; configure whichever you have.

For each provider, the redirect URI follows the pattern:

```
<protocol>://<host>/api/auth/callback/<provider>
```

`<protocol>` is `http` or `https` depending on `ingress.tls`. `<host>` is the ALB hostname or your domain. `<provider>` is the provider's lowercase identifier (see the cheat sheet below).

#### Google

**Console.** <https://console.cloud.google.com/apis/credentials>

1. Project → APIs & Services → OAuth consent screen → User Type: External → fill required fields → Save.
2. Credentials → Create Credentials → OAuth client ID → Application type: Web application.
3. Authorized redirect URIs: add `http://<alb-host>/api/auth/callback/google` (or the https equivalent later).
4. Create. Copy client ID and secret.

**Env vars.**

| Var | Where |
|---|---|
| `GOOGLE_CLIENT_ID` | `fabric/<env>/oauth` |
| `GOOGLE_CLIENT_SECRET` | `fabric/<env>/oauth` |

#### GitHub

**Console.** <https://github.com/settings/developers> → OAuth Apps → New OAuth App.

- Application name: anything.
- Homepage URL: `http://<alb-host>` (or your domain).
- Authorization callback URL: `http://<alb-host>/api/auth/callback/github`.

Register. The app page shows the Client ID; click "Generate a new client secret" for the secret.

**Env vars.**

| Var | Where |
|---|---|
| `FABRIC_GITHUB_CLIENT_ID` | `fabric/<env>/oauth` |
| `FABRIC_GITHUB_CLIENT_SECRET` | `fabric/<env>/oauth` |

> The `FABRIC_` prefix exists because there's a separate `GITHUB_*` set used elsewhere (push-event webhook); they are not the same credential pair.

#### Microsoft Graph

**Portal.** <https://entra.microsoft.com> → Applications → App registrations → New registration.

- Supported account types: "Accounts in any organizational directory and personal Microsoft accounts" (multi-tenant + personal).
- Redirect URI: Web → `http://<alb-host>/api/auth/callback/microsoft`.

After registration:
- Application (client) ID → `MICROSOFT_GRAPH_CLIENT_ID`.
- Certificates & secrets → New client secret → copy value (only shown once) → `MICROSOFT_GRAPH_CLIENT_SECRET`.

API permissions: add Microsoft Graph → Delegated → the full set below. Click **Grant admin consent** if you have the privilege; otherwise users will be prompted on first sign-in.

| Permission | What it is for |
|---|---|
| `openid`, `profile`, `email` | Sign-in |
| `offline_access` | Refresh tokens |
| `User.Read` | The signed-in user's profile |
| `User.ReadBasic.All` | Directory lookup for the Teams `list_users` tool |
| `Team.ReadBasic.All` | Listing teams |
| `Channel.ReadBasic.All` | Listing channels |
| `Chat.Read`, `ChatMessage.Read` | Reading chats and chat messages |
| `ChannelMessage.Read.All` | Reading and searching channel messages |
| `ChannelMessage.Send` | Posting Release Notes to a connected channel |
| `ChatMessage.Send` | Posting to a 1:1 or group chat |
| `Files.Read.All`, `Sites.Read.All` | Files shared in a channel |
| `OnlineMeetings.Read` | Meeting lookup |
| `OnlineMeetingTranscript.Read.All` | Meeting transcripts |
| `Calendars.Read` | Calendar reads — Meeting Digest, upcoming meetings |
| `Calendars.ReadWrite` | The workflow create-calendar-event action |
| `Mail.Read`, `Mail.Send` | The workflow mail-folder read and send-email actions |

> This list must match the `scopes` array in `packages/api/modules/integrations/lib/oauth-providers.ts`. A permission has to be in **both** places to work: the array decides what lands in an issued token, this registration decides what may be requested at all. A permission in one but not the other is a 403 at runtime, and neither list looks wrong on its own — that drift went unnoticed for months (Fizzy #2192).

> `ChannelMessage.Send` and `ChatMessage.Send` are supported for work or school accounts only — Microsoft Graph does not support message posting with a personal Microsoft account. Whether a tenant admin must grant consent depends on the tenant's user-consent policy, not on the permission itself. Existing users must reconnect Microsoft before a newly added permission takes effect: refreshing a token returns its originally-consented scope set.

**Env vars.**

| Var | Where |
|---|---|
| `MICROSOFT_GRAPH_CLIENT_ID` | `fabric/<env>/oauth` |
| `MICROSOFT_GRAPH_CLIENT_SECRET` | `fabric/<env>/oauth` |

---

### Email (Resend)

Email is required for magic links (Better Auth's primary login flow), invites, password resets, and the audit log digest. Resend is the only supported provider (`packages/mail/src/provider/index.ts` re-exports `./resend`).

**Signup.** <https://resend.com/signup>. Free tier: 3,000 emails/month.

**Key.** Dashboard → API Keys → Create API Key. Permissions: Full access.

**Env var.** `RESEND_API_KEY` in `fabric/<env>/email`.

> Resend requires a verified sending domain for non-test sends. The on-boarding flow walks you through DNS records; if you don't have a domain yet, you can send from `onboarding@resend.dev` for the first few tests.

---

## Optional

### Google AI

**What it's for.** Additional AI provider (Gemini family).

**Signup.** <https://aistudio.google.com> → Get API Key.

**Env var.** Currently the Helm wiring does not include a Google AI provider key. To enable, add `GOOGLE_AI_API_KEY` to `fabric/<env>/ai-providers` and verify the app's provider routing recognizes it; the `@repo/ai` package's resolver picks up provider keys by name.

### Groq

**What it's for.** Ultra-low-latency open-model inference (Llama, Mixtral). Free tier with generous rate limits.

**Signup.** <https://console.groq.com>

**Env var.** `GROQ_API_KEY` in `fabric/<env>/ai-providers`.

### Cerebras

**What it's for.** High-throughput open-model inference. Free tier available.

**Signup.** <https://inference.cerebras.ai>

**Env var.** Add `CEREBRAS_API_KEY` to `fabric/<env>/ai-providers` once the chart's env wiring includes it; otherwise use the Vercel AI Gateway path (below).

### DeepSeek

**What it's for.** Cost-effective reasoning models. Free trial; pay-as-you-go after.

**Signup.** <https://platform.deepseek.com>

**Env var.** `DEEPSEEK_API_KEY` in `fabric/<env>/ai-providers`.

### Qdrant Cloud

**What it's for.** Vector DB for RAG. Stores 1536-dim OpenAI `text-embedding-3-small` vectors for project contexts, workspace documents, chat artifacts, orchestrator episodic memory, and agent semantic memory. Used by `packages/rag` for hybrid (dense + BM25 sparse) search with RRF fusion.

**Default: in-cluster, no signup needed.** This deploy runs Qdrant as a single-node StatefulSet (`qdrant.enabled: true` in `values.yaml`) backed by an EBS gp3 PVC. The API key is auto-generated by Terraform (`random_password.qdrant_api_key`), stored in `fabric/<env>/qdrant`, and synced into pods by External Secrets Operator. App pods reach it at `http://qdrant.fabric.svc.cluster.local:6333` over the cluster network — no public exposure, no DNS, no certificates.

**When to swap to Qdrant Cloud.** The bundled OSS Helm chart is community-support only — Qdrant explicitly lists missing features for production: no zero-downtime upgrades, no automatic shard rebalancing, no built-in cluster backup/DR, no automatic PV scaling. Acceptable for dev. Before promoting to a real production cluster, decide between:

- **Stay in-cluster.** Add EBS volume snapshots via the AWS EBS CSI driver (`VolumeSnapshotClass` + cron) for backup. Run multi-node by raising `replicas` and adding pod anti-affinity. Pin a specific image tag (`qdrant.image.tag`) and stage upgrades via a separate cluster first.
- **Move to Qdrant Cloud / Hybrid Cloud.** Set `qdrant.enabled: false` in `values-prod.yaml`, set `qdrant.externalUrl` to the managed cluster's URL, and populate `fabric/<env>/qdrant` with `QDRANT_API_KEY` from the dashboard. No app code changes needed — the `@repo/rag` client reads `QDRANT_URL` and `QDRANT_API_KEY` from the standard env vars.

**Signup (only if swapping).** <https://cloud.qdrant.io/signup>. Free forever tier: 1 GB RAM / 0.5 vCPU / 4 GB disk — enough for prototyping but undersized for production RAG workloads. Paid tiers start at ~$25/month for a 1 GB instance.

**Env vars (override the in-cluster default).**

| Var | Where it lives |
|---|---|
| `QDRANT_URL` | ConfigMap (auto-rendered to in-cluster URL when `qdrant.enabled: true`; set via `qdrant.externalUrl` when `false`) |
| `QDRANT_API_KEY` | `fabric/<env>/qdrant` |

> The `QDRANT_GRPC_URL` env var is also rendered for the in-cluster case (gRPC on port 6334) but is not used in the current `@repo/rag` client paths.

### LangSmith

**What it's for.** Trace and evaluate LangChain / LangGraph agent runs. The agents emit traces to LangSmith when `LANGSMITH_API_KEY` is set.

**Signup.** <https://smith.langchain.com>

**Free tier.** 5,000 traces/month.

**Env var.** `LANGSMITH_API_KEY` in `fabric/<env>/integrations`.

### Letta

**What it's for.** Long-term agent memory. `apps/web/lib/memory/letta-client.ts` calls Letta when configured; otherwise memory degrades to short-term context.

**Signup.** <https://www.letta.com>

**Env vars.**

| Var | Where |
|---|---|
| `LETTA_BASE_URL` | ConfigMap (defaults to `https://api.letta.com`) |
| `LETTA_API_KEY` | `fabric/<env>/integrations` |

### LangGraph Cloud

**What it's for.** Hosted LangGraph deployments. Optional — the in-cluster agents already cover the MVP feature set.

**Signup.** <https://langchain.com/langgraph-platform>

**Env vars.**

| Var | Where |
|---|---|
| `LANGGRAPH_CLOUD_URL` | ConfigMap |
| `LANGGRAPH_API_KEY` | `fabric/<env>/integrations` |

### Vercel AI Gateway

**What it's for.** Single gateway in front of all AI providers — for token budget, metered billing, and unified observability.

**Signup.** <https://vercel.com/ai-gateway>

**Env vars.** `FABRIC_AI_URL`, `FABRIC_AI_API_KEY`, `FABRIC_SERVER_API_KEY` — wired via `fabric/<env>/integrations`. The Stripe-restricted access key (`STRIPE_AI_GATEWAY_RESTRICTED_KEY`) goes into `fabric/<env>/payments` if metered billing is enabled.

### Payments provider (Stripe)

Stripe is the only supported billing provider (`packages/payments/provider/index.ts` re-exports `./stripe`).

**Signup.** <https://dashboard.stripe.com/register>

**Env vars.** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, optionally `STRIPE_AI_GATEWAY_RESTRICTED_KEY` for AI Gateway metering. All in `fabric/<env>/payments`.

### Analytics provider (PostHog)

Optional; the app no-ops gracefully when unset. PostHog is the only wired provider (`apps/web/modules/analytics/index.tsx` re-exports `./provider/posthog`).

**Signup.** <https://posthog.com>. Free tier: 1M events/month.

**Env vars.** `NEXT_PUBLIC_POSTHOG_KEY`, optionally `NEXT_PUBLIC_POSTHOG_HOST` (defaults to the US cloud). Set via ConfigMap; publicly inlined into the browser bundle, so use a project API key, not a personal one.

---

## OAuth redirect URI cheat sheet

Every provider validates the exact redirect URI registered against the URI presented at callback time. A mismatch (HTTP vs HTTPS, trailing slash, port number) yields `redirect_uri_mismatch`.

Pattern: `<protocol>://<host>/api/auth/callback/<provider>`

| Provider | Provider identifier | Example (HTTP-only) | Example (HTTPS) |
|---|---|---|---|
| Google | `google` | `http://fabric-1234.us-east-1.elb.amazonaws.com/api/auth/callback/google` | `https://fabric.example.com/api/auth/callback/google` |
| GitHub | `github` | `http://fabric-1234.us-east-1.elb.amazonaws.com/api/auth/callback/github` | `https://fabric.example.com/api/auth/callback/github` |
| Microsoft Graph | `microsoft` | `http://fabric-1234.us-east-1.elb.amazonaws.com/api/auth/callback/microsoft` | `https://fabric.example.com/api/auth/callback/microsoft` |

When switching from HTTP-only to HTTPS, update the URI at the provider before the Helm `tls: true` flip — otherwise the existing OAuth sessions remain valid but new logins fail until you update.

---

## Your domain + email

These are not third-party SaaS, but you do need them.

### Domain (required for HTTPS)

If you want TLS in front of the ALB, you need either:

- A domain you own (e.g. `example.com`), or
- A subdomain you can delegate to AWS Route 53 (e.g. `fabric.example.com`).

You'll set `domain_name = "fabric.example.com"` in `terraform.tfvars`. Terraform's `route53` module creates a hosted zone; `terraform output -json route53_name_servers` lists the four NS records to set at your registrar (or at the parent zone if you control `example.com`).

You also need an ACM certificate for that domain (us-east-1) — see [AWS-DEPLOYMENT.md §8](./AWS-DEPLOYMENT.md#8-adding-https-optional).

### Email address

Used for:
- AWS Budget alert delivery (`alert_email` in `terraform.tfvars`).
- ACM certificate validation, if you choose email-validation. (DNS-validated certs don't need this; they validate via the Route 53 zone Terraform already created.)
- The Cloud-provider account holder address (each SaaS will email you about quotas, billing, etc.).
- The first admin user account in the app (§7 of AWS-DEPLOYMENT.md).

A single inbox covers all of the above. Use a real, monitored inbox — the Budget alert is the first line of defence against an account-runaway bill.

---

## Quick checklist

Before running `terraform apply`, confirm:

- [ ] AWS CLI authenticates: `aws sts get-caller-identity` returns your account.
- [ ] GitLab project exists; runner authentication token (`glrt-…`) in hand.
- [ ] Cloudflare account ID + API token in hand.
- [ ] Temporal Cloud namespace + API key in hand.
- [ ] Upstash Redis REST URL + token in hand.
- [ ] At least one AI provider key in hand (Anthropic or OpenAI).
- [ ] At least one OAuth client ID/secret in hand (Google / GitHub / Microsoft Graph).
- [ ] Resend API key in hand.
- [ ] Budget alert email decided.
- [ ] (Optional) Domain choice decided.

Once all of the above are checked, proceed with the steps in [AWS-DEPLOYMENT.md §2](./AWS-DEPLOYMENT.md#2-one-time-setup) or the day-by-day in [BOOTSTRAP.md](./BOOTSTRAP.md).
