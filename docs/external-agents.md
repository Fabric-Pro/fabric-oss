# External Agents

This document describes how to set up and manage external agents that are maintained in separate repositories but integrated with the Fabric Portal.

## Overview

Fabric Portal supports both **internal agents** (part of the monorepo) and **external agents** (separate repositories). External agents are integrated using Git submodules for development and can be deployed via Docker images in production.

## Current External Agents

| Agent | Repository | Submodule Path | Description |
|-------|------------|----------------|-------------|
| CUGA | `git@github.com:Fabric-Pro/cuga.git` | `agents/langchain/cuga` | Configurable Universal Generalist Agent with browser automation, code execution, and task planning |

## Development Setup

### Initial Clone (New Developers)

When cloning the Fabric repository for the first time, include submodules:

```bash
# Clone with submodules
git clone --recurse-submodules git@github.com:Fabric-Pro/fabric.git

# Or if already cloned without submodules:
git submodule update --init --recursive
```

### Updating Submodules

To get the latest changes from external agent repositories:

```bash
# Update all submodules to their latest commits
git submodule update --remote

# Update a specific submodule
git submodule update --remote agents/langchain/cuga
```

### Working on External Agents

External agents are regular Git repositories. You can work on them independently:

```bash
cd agents/langchain/cuga

# Check current branch
git branch

# Switch to a feature branch
git checkout feature/A2A-Support

# Make changes, commit, and push
git add .
git commit -m "Your changes"
git push origin feature/A2A-Support
```

### Recording Submodule Changes in Fabric

After updating a submodule to a new commit, record this in the parent repo:

```bash
# From fabric root
git add agents/langchain/cuga
git commit -m "chore: update CUGA submodule to latest"
```

## Architecture

### CUGA Agent Architecture

CUGA uses a two-service architecture managed by Aspire:

```
┌─────────────────────────────────────────────────────────┐
│                    Aspire Orchestration                  │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐    ┌─────────────────────┐    │
│  │   cuga-wrapper      │    │   cuga-backend      │    │
│  │   (Node.js)         │───▶│   (Python)          │    │
│  │   Port: 9999        │    │   Port: 7860        │    │
│  │   - A2A Protocol    │    │   - FastAPI         │    │
│  │   - AG-UI Protocol  │    │   - Browser Agent   │    │
│  └─────────────────────┘    │   - Code Executor   │    │
│            ▲                └─────────────────────┘    │
│            │ A2A/AG-UI                                 │
│  ┌─────────┴─────────┐                                 │
│  │   Fabric Loom     │                                │
│  └───────────────────┘                                 │
└─────────────────────────────────────────────────────────┘
```

**Port Configuration:**
- `7860`: CUGA Python backend (internal, FastAPI with native UI)
- `9999`: AG-UI wrapper (exposed, provides A2A protocol endpoints)

## Production Deployment (Future)

For production, use pre-built Docker images instead of building from source.

### GitHub Container Registry

Publish images from the CUGA repository's CI/CD, then update Aspire:

```csharp
// Development: Build from local Dockerfile
#if DEBUG
var cugaBackend = builder.AddDockerfile("cuga-backend", "../../agents/langchain/cuga", "Dockerfile")
#else
// Production: Use pre-built image from registry
var cugaBackend = builder.AddContainer("cuga-backend", "ghcr.io/fabric-pro/cuga", "v1.0.0")
#endif
    .WithHttpEndpoint(port: 7860, targetPort: 7860, name: "http");
```

## Troubleshooting

### Submodule Not Initialized
```bash
git submodule update --init agents/langchain/cuga
```

### A2A Protocol Not Working
1. Verify wrapper: `curl http://localhost:9999/health`
2. Check agent card: `curl http://localhost:9999/.well-known/agent.json`
3. Verify database URL: `SELECT "deploymentUrl" FROM registered_agent WHERE "agentId" = 'cuga_generalist';`

## Adding New External Agents

```bash
git submodule add git@github.com:Fabric-Pro/new-agent.git agents/langchain/new-agent
git add .gitmodules agents/langchain/new-agent
git commit -m "feat: add new-agent as submodule"
```

Then update `aspire/Fabric.AppHost/Program.cs` to orchestrate the new agent.

