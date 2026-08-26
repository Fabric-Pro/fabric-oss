# Weave Service Secrets Reference

Which secret each service uses, trust boundaries, and rotation expectations.

- **Audience**: DevOps, Backend developers
- **Last updated**: 2026-03-25

---

## Secret Inventory

| Secret | Key Vault Name | Env Var | Used By | Purpose |
|--------|---------------|---------|---------|---------|
| Agent Service Secret | `agent-service-secret` | `AGENT_SERVICE_SECRET` | All 3 weave services, Temporal worker | HMAC signing/verification for inter-service A2A calls |
| AI Token Secret | `ai-token-secret` | `AI_TOKEN_SECRET` | All 3 weave services, Temporal worker | Decrypt per-user AI provider API keys from database |
| Fabric AI API Key | `fabric-ai-api-key` | `FABRIC_AI_API_KEY` / `AI_API_KEY` | All 3 weave services | Authenticate requests to the Fabric AI server |
| Fabric API URL | `fabric-api-url` | `FABRIC_API_URL` | All 3 weave services, Temporal worker | Base URL for callbacks and token exchange |
| Agent API Key | `agent-api-key` | `AGENT_API_KEY` | All 3 weave services | Legacy agent authentication (being phased out by HMAC) |
| Fabric Internal URL | `fabric-internal-url` | `FABRIC_INTERNAL_URL` | weave-shuttle only | Internal URL for the Next.js app (coding-run bridge target) |
| Database URL | `database-url` | `DATABASE_URL` | weave-planners only | Direct Prisma access for Pattern plan persistence |

---

## Trust Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│  BOUNDARY 1: User → API (session auth)                      │
│  Browser/client authenticates via Better Auth session        │
│  Secret: BETTER_AUTH_SECRET (not weave-specific)             │
└─────────────┬───────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  BOUNDARY 2: API → Weave Services (HMAC)                    │
│  Temporal worker / API server signs A2A requests with HMAC  │
│  Secret: AGENT_SERVICE_SECRET                                │
│  Headers: X-Agent-Service-Token, X-Tenant-Context-*          │
│  Verification: serviceAuth() middleware on all 3 services    │
└─────────────┬───────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  BOUNDARY 3: Weave Services → LLM Providers (API key)       │
│  Reader agents decrypt per-user API keys via AI_TOKEN_SECRET │
│  Pattern uses @repo/agent-core model resolution              │
│  Secret: AI_TOKEN_SECRET (decryption), FABRIC_AI_API_KEY     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  BOUNDARY 4: Shuttle → Internal API (reuses AGENT_SERVICE_SECRET) │
│  Shuttle calls /api/internal/weave-coding-run on Next.js    │
│  Secret: AGENT_SERVICE_SECRET (same as Boundary 2)           │
│  Header: X-Agent-Service-Token                               │
│  Verification: route handler checks exact match              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  BOUNDARY 5: Pattern → Database (connection string)         │
│  Pattern persists plans directly via Prisma                  │
│  Secret: DATABASE_URL                                        │
└─────────────────────────────────────────────────────────────┘
```

---

## Which Secrets Are Shared

| Secret | Shared With | Notes |
|--------|-------------|-------|
| `AGENT_SERVICE_SECRET` | Temporal worker, all agent services (weave + non-weave) | Single HMAC key for all inter-service auth. Same value everywhere. |
| `AI_TOKEN_SECRET` | Temporal worker, all agent services | Decrypts user API keys from the `EncryptedProviderKey` table. Must match the encryption key used by Better Auth. |
| `FABRIC_AI_API_KEY` | Temporal worker, all agent services, Fabric AI server | Authenticates client→server requests. Server validates via `FABRIC_SERVER_API_KEY`. These SHOULD be the same value. |
| `AGENT_SERVICE_SECRET` | All weave services, Temporal worker, Next.js app | Single HMAC key for all inter-service auth including Shuttle's coding-run bridge. |
| `DATABASE_URL` | weave-planners, Temporal worker, Next.js app | Full PostgreSQL connection string. Pattern needs direct DB access. |

---

## Rotation Expectations

| Secret | Rotation Impact | Procedure |
|--------|----------------|-----------|
| `AGENT_SERVICE_SECRET` | **Service disruption** — all inter-service calls fail until all services restart with new value. | 1. Update Key Vault. 2. Restart all container apps simultaneously. |
| `AI_TOKEN_SECRET` | **Breaks AI calls** — existing encrypted keys can't be decrypted. | Must be rotated together with re-encryption of all stored provider keys. Avoid rotating unless compromised. |
| `FABRIC_AI_API_KEY` | **Moderate** — AI server rejects requests until both sides updated. | Update `fabric-ai-api-key` and `fabric-server-api-key` in Key Vault simultaneously, restart AI server + agents. |

| `DATABASE_URL` | **Critical** — all DB access fails. | Coordinate with Prisma connection pooling. Update all consumers simultaneously. |

---

## Provisioning Checklist

Secrets must exist in three places:

1. **Azure Key Vault** — `deployment/azure/main.bicep` (`secrets` arrays)
2. **GitHub Actions** — `.github/workflows/deploy-azure-container-apps.yml` (`ensure_secret` block)
3. **Manual setup script** — `deployment/azure/configure-keyvault-secrets.sh`

For local development, add to `.env.local` and `docker-compose.weave.yml`.

---

## Related Files

| File | What it configures |
|------|-------------------|
| `deployment/azure/main.bicep` | Bicep: Key Vault refs + container env injection |
| `.github/workflows/deploy-azure-container-apps.yml` | CI: Key Vault pre-population |
| `deployment/azure/configure-keyvault-secrets.sh` | Manual: interactive secret setup |
| `agents/langchain/docker-compose.weave.yml` | Local: env var passthrough |
| `packages/agent-runtime/src/security/middleware.ts` | Runtime: `serviceAuth()` HMAC verification |
| `agents/langchain/weave-shuttle/src/lib/coding-run-bridge.ts` | Runtime: `AGENT_SERVICE_SECRET` for coding-run bridge auth |
