# Aspire CLI Usage Guide

Run Fabric's local development stack with Aspire.

- **Audience**: Fabric developers
- **Owner**: Engineering team

## Overview

This project uses **.NET Aspire** for orchestrating all development services, including infrastructure (PostgreSQL, Redis, Qdrant, Temporal), observability (Prometheus, Grafana, Jaeger), LangGraph agents, and the Next.js web application.

## Quick Start

### Recommended: Native Aspire CLI

Install the [Aspire CLI 17.0.0 bundle and other prerequisites](../aspire/README.md#prerequisites), then run the following from the repository root.

```bash
# Start all services
cd aspire/Fabric.AppHost && aspire run
```

Press Ctrl+C to stop the AppHost. Persistent infrastructure containers keep running and retain their data volumes. Before switching checkouts, stop those containers as described in the [Aspire troubleshooting guide](../aspire/README.md#run-one-fabric-stack-at-a-time).

### Alternative: Convenience Script

If you prefer, you can use the wrapper script:

```bash
# Start all services
./aspire.sh run
```

## Service Architecture

### Infrastructure Services
- **PostgreSQL 17** (port 5432) - Primary database with the existing `fabric-postgres-data` volume mounted at `/var/lib/postgresql/data`
- **Redis 8.6** - Cache and session storage with the existing `fabric-redis-data` volume and non-TLS connections. Use the `cache` resource endpoint in the Aspire dashboard to find the assigned host port.
- **Qdrant** (ports 6333, 6334) - Vector database with persistent volume
- **Temporal** (port 7233) - Workflow orchestration server
- **Temporal UI** (port 8083) - Temporal dashboard
- **MinIO** (ports 9000, 9001) - S3-compatible object storage

### Observability Services
- **Prometheus** (port 9090) - Metrics collection
- **Grafana** (port 3200) - Metrics visualization (login: admin/admin)
- **Jaeger** (port 16686) - Distributed tracing UI
- **Node Exporter** (port 9100) - System metrics

### LangGraph Agents (TypeScript)
- **Document Generator** (port 8124) - Document creation agent
- **Project Document Generator** (port 8125) - Project documentation agent
- **Prompt Enhancer** (port 8134) - Prompt optimization agent

### Applications
- **Web App** (port 3001) - Next.js application
- **Temporal Worker** - Background workflow processor

## Access URLs

When services are running:

| Service | URL | Notes |
|---------|-----|-------|
| 🎯 Aspire Dashboard | https://localhost:17134 | Main orchestration dashboard |
| 🌐 Web Application | http://localhost:3001 | Next.js app |
| 📊 Grafana | http://localhost:3200 | Credentials: admin/admin |
| 📈 Prometheus | http://localhost:9090 | Metrics database |
| 🔍 Jaeger | http://localhost:16686 | Tracing UI |
| ⏱️ Temporal UI | http://localhost:8083 | Workflow orchestration |
| 💾 MinIO Console | http://localhost:9001 | Credentials: minioadmin/minioadmin |
| 🤖 Document Generator | http://localhost:8124/ok | Health check endpoint |
| 🤖 Project Doc Gen | http://localhost:8125/ok | Health check endpoint |
| 🤖 Prompt Enhancer | http://localhost:8134/ok | Health check endpoint |

## Command Reference

### Start Services

```bash
# Option 1: Native Aspire CLI (recommended)
cd aspire/Fabric.AppHost && aspire run

# Option 2: Convenience script
./aspire.sh run
```

### Stop Services

Press Ctrl+C in the terminal where Aspire is running to stop the AppHost.

### Check Status

```bash
./aspire.sh status
```

Example output:
```
NAMES                      STATUS          PORTS
postgres-67728638          Up 5 minutes    0.0.0.0:5432->5432/tcp
...
```

### Resource Commands

Local development adds three custom commands to the Aspire dashboard, on top of the
built-in Start / Stop / Restart. They are dev-only — none of them exist in publish mode.
Open a resource in the dashboard and use its **⋯** menu, or the resource's detail page.

| Resource | Command | What it does |
|----------|---------|--------------|
| Each LangGraph agent | **Rebuild & restart** | Runs `pnpm build` inside the container, streams the build output into the resource's console log, then restarts the container. |
| `postgres` | **Run seed** | Prompts for one of the local `seed*` scripts from `packages/database/package.json`, then runs `pnpm --filter @repo/database <script>`. |
| `postgres` | **Apply RLS policies** | Runs `pnpm --filter @repo/database apply:rls`. |

**Why "Rebuild & restart" exists**: in dev mode each agent container runs
`if [ ! -f dist/<entry> ]; then pnpm build; fi`, so it only builds when the bundle is
missing. Picking up a source change otherwise means a build followed by a manual
restart — this collapses those into one button. It is offered only while the resource
is Running.

The build runs **inside** the container (`docker exec` into the running container, found
by the `com.docker.compose.service=<resource-name>` label the AppHost stamps on every
dev-mode agent container *and* the container name, which is the Aspire instance id
`<resource-name>-<suffix>`; the command refuses to run unless exactly one container
matches both, so a stale container left by another checkout cannot be built by
mistake), not on your host. The container's own first-run
build executes as root against the bind-mounted checkout, so on Linux each agent's
`dist/` is root-owned and a host-side `tsup` build fails with `EACCES` trying to unlink
the previous chunks. Building where the entrypoint builds keeps the ownership consistent.
If you use podman, set `DcpPublisher:ContainerRuntime` (or `DOTNET_ASPIRE_CONTAINER_RUNTIME`)
as you already would for Aspire itself — the command follows the same setting.

`data-analyst` has no rebuild command: it runs `pnpm exec tsx unified-server.ts` straight
from source, so the plain **Restart** already picks up a source change.

The two database commands run on the host, so they act on whatever `DATABASE_URL` /
`DIRECT_URL` your `.env.local` points at — the local Aspire Postgres container unless
`FABRIC_LOCAL_EXTERNAL_DB` is enabled. That is identical to running the same script from
a terminal. Only the local seed scripts are offered; the `:staging` and `:prod` variants
are never listed.

The same commands are available over MCP:

```
execute_resource_command(resourceName: "task-planner", commandName: "rebuild")
execute_resource_command(resourceName: "postgres", commandName: "seed", arguments: { script: "seed:prompts" })
execute_resource_command(resourceName: "postgres", commandName: "apply-rls")
```

### Shell Into a Running Container

Aspire names each container `<resource-name>-<suffix>`, and the suffix differs per
checkout, so `docker exec weave-planners sh` never matches. Skip the name: every
dev-mode container carries a `com.docker.compose.service=<resource-name>` label, so
resolve the id by label instead.

```bash
docker exec -it "$(docker ps -q --filter label=com.docker.compose.service=weave-planners --filter status=running)" sh
```

Any resource name shown in the dashboard works in place of `weave-planners`,
infrastructure containers included (`postgres`, `temporal`, `qdrant`, ...). The shell
runs inside the live container, so it sees that container's environment
(`DATABASE_URL`, `REDIS_URI`, ...) and, for the agents, the bind-mounted checkout at
`/app`. If the substitution expands to more than one id, a persistent container from
another checkout of this repo is still running under the same label; list them with
`docker ps --filter label=com.docker.compose.service=<resource-name>` and stop the stale
one.

Aspire 17's stable `WithTerminal()` runs the resource's configured process under a
pseudo-terminal so the dashboard can attach to it. For an agent, that process is
the Node server. Use `docker exec` as shown above to open a new shell inside the
running container.

### Restart All Services

```bash
./aspire.sh restart
```

### Open Aspire Dashboard

```bash
./aspire.sh dashboard
# Opens https://localhost:17134 in your browser
```

### Remove All Data (Destructive!)

```bash
./aspire.sh clean
```

⚠️ **Warning**: This removes all containers AND volumes, deleting all data!

## Configuration

### Environment Variables

All environment variables are loaded from `.env.local` at the repository root.

Required variables:
```env
# Database
DATABASE_URL="postgresql://postgres:password@localhost:5432/fabric"
DIRECT_URL="postgresql://postgres:password@localhost:5432/fabric"

# Application
NEXT_PUBLIC_SITE_URL="http://localhost:3001"
BETTER_AUTH_SECRET="your-secret-key"

# Storage
NEXT_PUBLIC_AVATARS_BUCKET_NAME="avatars"
AWS_ACCESS_KEY_ID="your-access-key"
AWS_SECRET_ACCESS_KEY="your-secret-key"
AWS_REGION="us-east-1"

# AI Providers
OPENAI_API_KEY="sk-..."
ANTHROPIC_API_KEY="sk-ant-..."
```

### Local Models (Ollama, LocalAI)

Developers with the hardware can serve some tasks from local models instead of the
organization's configured AI provider. Each local provider is switched on alone in
`.env.local`, so a developer without a GPU leaves it off and nothing changes:

| Provider | Switch | Tasks | Default models |
|---|---|---|---|
| Ollama | `FABRIC_LOCAL_OLLAMA` | Embeddings, decisions | `qwen3-embedding:4b`, `qwen3:4b-instruct` |
| LocalAI | `FABRIC_LOCAL_LOCALAI` | Image generation | `flux.2-klein-4b` |

```env
FABRIC_LOCAL_OLLAMA="true"
FABRIC_LOCAL_OLLAMA_GPU="true"                 # pass an NVIDIA GPU through
FABRIC_LOCAL_OLLAMA_EMBEDDING_MODEL="qwen3-embedding:4b"
FABRIC_LOCAL_OLLAMA_DECISION_MODEL="off"       # "off" keeps a task on the configured provider
FABRIC_LOCAL_OLLAMA_DECISION_CPU="true"        # decide on the CPU, leaving the GPU to the rest
FABRIC_LOCAL_LOCALAI="true"
FABRIC_LOCAL_LOCALAI_GPU="true"
FABRIC_LOCAL_LOCALAI_IMAGE_MODEL="flux.2-klein-4b"
```

Aspire then runs an `ollama` and/or `localai` container, downloads the models into
their volumes once (`ollama-pull`, `localai-setup`), and points `web`,
`temporal-worker` and `weave-planners` at them through `FABRIC_LOCAL_<TASK>_BASE_URL`
/ `_MODEL`. Those variables can also point at a server you run elsewhere. Settings →
AI Models shows the local model on each task it serves.

- **Embeddings** must return 1536-dimension vectors when asked for them, the width of
  every Qdrant collection; each request asks for 1536. Vectors indexed with another
  model do not match, so re-index existing documents after switching.
- **Decisions** run on the chat model: each question is answered with one option
  letter, and the letter's logprobs give the probabilities the callers' confidence
  thresholds read. A refusal falls back to the regular AI model, as before.
- **Images** are drawn at about 0.6 MP (768×768, or the same area at the requested
  aspect ratio), which fits FLUX.2 klein 4B next to the embedding model on an 8 GB GPU.
  Editing an input image is not supported locally. Generated images are stored in
  MinIO, like gateway images.

On an 8 GB GPU, run embeddings and images on the GPU and decisions on the CPU
(`FABRIC_LOCAL_OLLAMA_DECISION_CPU=true`). The app honours the `FABRIC_LOCAL_*`
task variables only under `NODE_ENV=development` (`packages/ai/lib/local-models.ts`);
deployed environments are unaffected.

### Aspire Secrets

Use `aspire secret` from the AppHost directory to manage local parameters. The commands default to the Development environment. When you omit the value, Aspire prompts for it without displaying it.

```bash
cd aspire/Fabric.AppHost

aspire secret set Parameters:postgres-password
aspire secret set Parameters:minio-root-user
aspire secret set Parameters:minio-root-password
aspire secret set Parameters:grafana-admin-password

# Show the local secrets file path
aspire secret path
```

On startup, Aspire imports legacy .NET user secrets if the Aspire Development secrets file is missing. Aspire secrets override values in appsettings and legacy .NET user secrets. Environment variables and AppHost command-line arguments can override Aspire secrets.

### Public Tunnel (OAuth callbacks and webhooks)

OAuth providers and webhook senders need a reachable HTTPS URL. The AppHost can
forward requests to the local web app on port 3001 through a Microsoft dev
tunnel. The tunnel is off by default and is available only in local run mode.

Install the [dev tunnel CLI](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started)
and sign in with `devtunnel user login`. Aspire can prompt for sign-in when the
tunnel starts. From the AppHost directory, set a fixed ID and restart the AppHost.

```bash
aspire secret set Parameters:dev-tunnel-id fabric-dev-example
```

Choose an ID unique to you and available to your account. Use 3–60 lowercase
ASCII letters, digits, or hyphens, with a letter or digit at each end. Aspire
reuses the fixed ID across runs so callback URLs can stay stable. The tunnel
requests a 720-hour expiration.

Open the `tunnel-web-http` resource in the Aspire dashboard to find the URL.
The dev tunnels service assigns its host when it first creates the tunnel, for
example `https://abcd1234-3001.usw3.devtunnels.ms`; the host is not built from
the ID. Aspire reuses the tunnel with that ID, so the host stays the same across
AppHost restarts. A new ID, or a tunnel that was deleted or expired after 30
days without use, gets a new host, and its callbacks must be registered again.
The web app and Temporal worker receive that origin as `NEXT_PUBLIC_SITE_URL`.
The web app also receives it as `DEV_TUNNEL_URL` for Better Auth's trusted
origins and Next's `allowedDevOrigins`. An explicit `NEXT_PUBLIC_APP_URL` in `.env.local` still
overrides the integration callbacks.

Register the dashboard URL with the relevant `/api/...` callback paths in your
OAuth provider or webhook sender. Use the tunnel host in your browser while
testing. Session cookies, OAuth state, and passkeys are bound to the host where
you sign in, so a flow started on localhost cannot complete on the tunnel.
The web endpoint allows anonymous tunnel access so providers can reach it.
Anyone with the URL can reach your local web app.

To disable the tunnel, stop the AppHost and set an explicit empty Development
value from the AppHost directory.

```bash
aspire secret set Parameters:dev-tunnel-id "" --environment Development
```

Remove any higher-precedence environment variable or AppHost command-line
override, such as `Parameters__dev-tunnel-id`, before restarting. The empty
value overrides an ID in appsettings or legacy .NET user secrets. Deleting
the override can let a configured ID take effect again.

If you start a tunnel by hand outside Aspire, set `DEV_TUNNEL_URL` and
`NEXT_PUBLIC_SITE_URL` in `.env.local` to its HTTPS origin. The first adds the
host to the development origin lists, and the second makes redirects and
links use it. Better Auth accepts ngrok and Microsoft dev tunnel hosts for
`DEV_TUNNEL_URL` and ignores it in production.

### Postgres MCP server

The AppHost exposes a read-only Postgres MCP server at
`http://localhost:8150/sse` when using the local database. The server runs in
restricted mode and is omitted when the AppHost uses an external database.

```bash
claude mcp add --transport sse fabric-postgres http://localhost:8150/sse
```

## Startup Behavior

### Non-Blocking Agent Initialization

The web application uses a **non-blocking startup pattern**:

1. **Infrastructure starts first** (PostgreSQL, Redis, Qdrant, Temporal)
2. **Web app starts immediately** (~2-3 seconds) without waiting for agents
3. **Agents start in parallel** and register when ready
4. **CopilotKit endpoint** handles agent registration lazily

This means:
- ✅ Fast startup during development
- ✅ Web app available immediately
- ✅ Agents become available when ready (check `/ok` endpoints)
- ✅ No blocking on slow agent initialization

### Check Agent Status

```bash
# Document Generator
curl http://localhost:8124/ok

# Project Document Generator
curl http://localhost:8125/ok

# Prompt Enhancer
curl http://localhost:8134/ok
```

## Troubleshooting

### Persistent Containers Still Running After Ctrl+C

Follow [Run One Fabric Stack at a Time](../aspire/README.md#run-one-fabric-stack-at-a-time) to stop persistent containers before starting the stack from another checkout.

### Port Already in Use

If you get port conflicts:

```bash
# Check what's using the port (example: port 5432)
lsof -ti:5432

# Kill the process
lsof -ti:5432 | xargs kill -9

# Or use the cleanup script
./aspire.sh down
```

### Agent Fails to Start

Check the Aspire Dashboard (https://localhost:17134) for detailed logs.

Common issues:
- **Missing dependencies**: Run `pnpm install` in agent directory
- **Port conflict**: Check if port is already in use
- **Environment variables**: Verify `.env.local` is configured

### Database Connection Issues

```bash
# Check if PostgreSQL is running
docker ps | grep postgres

# Test connection
psql postgresql://postgres:password@localhost:5432/fabric

# View logs in Aspire Dashboard
open https://localhost:17134
```

### Clean Slate (Remove All Data)

If you want to start completely fresh:

```bash
# Stop all services
Ctrl+C

# Remove all containers and volumes
./aspire.sh clean

# Start fresh
./aspire.sh run
```

## Advanced Usage

### Running Individual Services

Aspire doesn't support running individual services, but you can comment out services in `aspire/Fabric.AppHost/Program.cs` if needed.

### Custom Configuration

Edit `aspire/Fabric.AppHost/Program.cs` to customize:
- Port mappings
- Environment variables
- Resource dependencies
- Health check endpoints

### Development Workflow

Recommended workflow:

1. **Start services**: `cd aspire/Fabric.AppHost && aspire run`
2. **Develop**: Services auto-reload on code changes
3. **Monitor**: Use Aspire Dashboard (https://localhost:17134)
4. **Stop**: Press Ctrl+C when done
5. **Repeat**: Start again - data persists in volumes!

## Performance Tips

- **Fast startup**: Web app starts in 2-3 seconds
- **Parallel agents**: Agents start simultaneously
- **Persistent volumes**: Data survives restarts
- **Live reload**: Most services support hot reload

## Migration Guide

### From Docker Compose

If you were previously using Docker Compose:

```bash
# Old approach
docker compose up -d
docker compose down

# New approach (Aspire)
./aspire.sh run
Ctrl+C
```

**Benefits**:
- Better observability (Aspire Dashboard)
- Automatic health checks
- Better error messages
- Native .NET integration
- Unified management of all services

### From Manual Scripts

If you were starting services manually:

**Before**:
```bash
# Start each service individually
docker run postgres...
docker run redis...
npm run dev
# etc...
```

**Now**:
```bash
# One command starts everything
./aspire.sh run
```

## Additional Resources

- [.NET Aspire Documentation](https://learn.microsoft.com/en-us/dotnet/aspire/)
- [Aspire Dashboard Guide](https://learn.microsoft.com/en-us/dotnet/aspire/fundamentals/dashboard)
- [Project Architecture](../AGENTS.md)

## Support

For issues or questions:
1. Check the Aspire Dashboard logs
2. Review this documentation
3. Check project README.md
4. Open an issue on the repository
