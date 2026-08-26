# Background Agents Deployment Plan

## Overview
This document outlines the deployment strategy for integrating the background-agents (Open-Inspect) project with Fabric. This is deferred work — the current implementation focuses on the Fabric-side integration only, with the background-agents service expected to be deployed separately.

## Architecture
- Background-agents runs as a dedicated execution provider behind Fabric's `CodingExecutionProvider` abstraction
- Fabric is the control plane; background-agents is the execution plane
- Communication happens via HTTP REST API with HMAC-signed authentication

## Local Development (Aspire Integration)

### Option 1: External Process (Recommended for now)
Run background-agents separately using `wrangler dev --local`:
```bash
cd ~/projects/background-agents
pnpm dev  # Starts control-plane on port 8787
```

Set in `.env.local`:
```
BACKGROUND_AGENTS_URL=http://localhost:8787
BACKGROUND_AGENTS_INTERNAL_SECRET=dev-secret-change-me
```

### Option 2: Aspire Integration (Future)
Add background-agents as an Aspire resource in `Aspire/Aspire.AppHost/Program.cs`:
- Register as a container resource or executable
- Wire up environment variables automatically
- Health checks via `/health` endpoint

## Production Deployment

### Cloudflare Workers (Control Plane)
The background-agents control plane runs on Cloudflare Workers:
- Deploy via `wrangler deploy` or Terraform
- Uses Cloudflare D1 for session state
- Uses Cloudflare KV for caching
- Requires `INTERNAL_SECRET` for HMAC auth

### Modal (Execution Sandbox)
Code execution happens in Modal sandboxes:
- Each session gets an isolated container
- Git clone, code editing, and testing happen inside the sandbox
- PR creation uses GitHub API from within the sandbox

### Terraform Configuration
```hcl
# Future: Terraform module for background-agents deployment
# resource "cloudflare_worker_script" "background_agents" { ... }
```

## Secrets Management

### Azure Key Vault (Production)
Add the following secrets to Key Vault:
- `background-agents-url` — Control plane URL (e.g., `https://bg-agents.fabric.example.com`)
- `background-agents-internal-secret` — HMAC signing secret

### Bicep Integration
Add to `deployment/azure/main.bicep`:
```bicep
// Future: Add as env vars to the web container
{
  name: 'BACKGROUND_AGENTS_URL'
  value: backgroundAgentsUrl.properties.value
}
{
  name: 'BACKGROUND_AGENTS_INTERNAL_SECRET'
  secretRef: 'background-agents-internal-secret'
}
```

### GitHub Actions
Add to `.github/workflows/deploy-azure-container-apps.yml`:
- Pre-populate Key Vault secrets step
- Wire env vars to container app

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BACKGROUND_AGENTS_URL` | Yes | Base URL of background-agents control plane |
| `BACKGROUND_AGENTS_INTERNAL_SECRET` | Yes | HMAC secret for signing requests |

## Health Check
The control plane exposes `GET /health` for readiness checks. Fabric should verify connectivity on startup or first use.

## Timeline
1. **Phase 1 (Current)**: Fabric-side integration with `CodingExecutionProvider` abstraction
2. **Phase 2**: Local development setup with `wrangler dev --local`
3. **Phase 3**: Production deployment on Cloudflare/Modal
4. **Phase 4**: Aspire integration for unified local dev experience
