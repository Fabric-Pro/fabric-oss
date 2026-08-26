# Scripts

Utility scripts for setup, maintenance, testing, and deployment of the Fabric AI platform.

## Setup

| Script | Purpose | Usage |
|--------|---------|-------|
| `START_SERVICES.sh` | Start all infrastructure services | `./scripts/START_SERVICES.sh` |
| `compose-infra.sh` | Docker Compose orchestration for infrastructure | `./scripts/compose-infra.sh up\|down\|status\|logs` |
| `setup-eval-feature.sh` | Initialize the document evaluation feature | `./scripts/setup-eval-feature.sh` |
| `setup-r2-buckets.sh` | Create Cloudflare R2 storage buckets | `./scripts/setup-r2-buckets.sh` |
| `setup-project-cleanup-schedule.ts` | Set up scheduled project cleanup workflows | `npx tsx scripts/setup-project-cleanup-schedule.ts` |

`compose-infra.sh` uses committed `.env.compose.example` defaults and an optional
gitignored `.env.compose` override for machine-specific values.

## Maintenance

| Script | Purpose | Usage |
|--------|---------|-------|
| `cleanup-stale-orchestrator-tasks.ts` | Remove stale orchestrator task records | `npx tsx scripts/cleanup-stale-orchestrator-tasks.ts` |
| `health-check-agents.ts` | Check health of all registered agents | `npx tsx scripts/health-check-agents.ts` |
| `trigger-mcp-reingestion.ts` | Trigger re-ingestion of MCP server tools | `npx tsx scripts/trigger-mcp-reingestion.ts` |
| `validate-agents.ts` | Validate agent configurations | `npx tsx scripts/validate-agents.ts` |
| `verify-agents.ts` | Verify agent endpoints are reachable | `npx tsx scripts/verify-agents.ts` |
| `encrypt-key.js` | Encrypt an API key for storage | `node scripts/encrypt-key.js <key>` |

## Deployment

| Script | Purpose | Usage |
|--------|---------|-------|
| `deploy-utils.sh` | Shared deployment utility functions | Sourced by other deploy scripts |
| `azure-keyvault-secrets.sh` | Configure Azure Key Vault secrets | `./scripts/azure-keyvault-secrets.sh <dev\|staging\|prod>` |
| `vercel-add-agent-vars.sh` | Add agent endpoint URLs to Vercel env | `./scripts/vercel-add-agent-vars.sh` |
| `vercel-env-sync.sh` | Sync environment variables to Vercel | `./scripts/vercel-env-sync.sh <staging\|production>` |
| `verify-prompt-enhancer.sh` | Verify prompt enhancer agent deployment | `./scripts/verify-prompt-enhancer.sh` |

## Testing & Debugging

| Script | Purpose | Usage |
|--------|---------|-------|
| `test-letta-connection.ts` | Test connectivity to Letta memory service | `npx tsx scripts/test-letta-connection.ts` |
| `test-orchestrator-memory.ts` | Test orchestrator memory operations | `npx tsx scripts/test-orchestrator-memory.ts` |

## Prerequisites

- Most TypeScript scripts require `.env.local` to be configured
- Shell scripts may require specific CLI tools (Azure CLI, Vercel CLI, etc.)
- Run from the repository root directory
