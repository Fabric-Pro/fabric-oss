# Fabric Portal - .NET Aspire Orchestration

This directory contains the .NET Aspire 13.3 orchestration layer for the Fabric Portal polyglot agent architecture.

## Overview

.NET Aspire provides unified orchestration for all services in the Fabric Portal stack:
- **TypeScript Agents** (LangGraph)
- **Python Agents** (LangGraph)
- **C# Agents** (Microsoft Agent Framework)
- **Next.js Web Application**
- **Infrastructure Services** (PostgreSQL, Redis, Qdrant, Temporal, MinIO)

## Prerequisites

1. **.NET 10 SDK** (10.0.0 or later)
   ```bash
   dotnet --version
   ```

2. **Aspire CLI 13.3+** (required for MCP tool discovery; 13.3 ships as a NativeAOT global tool with instant startup)
   ```bash
   aspire --version
   # Install/update: dotnet tool install -g Aspire.Cli
   # Or update an existing install: aspire update --self
   ```

3. **.NET Aspire 13 Templates** (Aspire 13 no longer requires a workload)
   ```bash
   dotnet new install Aspire.ProjectTemplates --force
   ```

3. **Docker Desktop** (for containers)
   ```bash
   docker --version
   ```

4. **Node.js 22+** with pnpm
   ```bash
   node --version
   pnpm --version
   ```

## Quick Start

### 1. Configure Environment

Copy the example configuration:
```bash
cp Fabric.AppHost/appsettings.Development.json.example Fabric.AppHost/appsettings.Development.json
```

Edit `Fabric.AppHost/appsettings.Development.json` with your settings:
```json
{
  "Parameters": {
    "postgres-password": "your-secure-password",
    "minio-root-user": "minioadmin",
    "minio-root-password": "your-secure-password"
  }
}
```

**Important**: Never commit `appsettings.Development.json` to version control!

### 2. Install Dependencies

```bash
# From repository root
cd aspire/Fabric.AppHost
dotnet restore
```

### 3. Run the Application

**Recommended: Use Native Aspire CLI**

```bash
# Start all services (use aspire run, not dotnet run, for MCP discovery)
cd aspire/Fabric.AppHost
aspire run

# Stop all services (containers stop automatically!)
Press Ctrl+C
```

**Alternative: Use Convenience Script**

```bash
# From repository root
./aspire.sh run

# Stop all services
Press Ctrl+C
```

### ✨ What's New (November 2025)

- **Automatic Cleanup**: Containers now stop when you press Ctrl+C
- **Data Persists**: Docker volumes persist between sessions (no data loss)
- **Simpler Workflow**: No need for manual cleanup commands
- **Fast Startup**: Web app starts in 2-3 seconds, agents start in parallel

### Other Commands

```bash
./aspire.sh status      # Show container status
./aspire.sh restart     # Restart all services
./aspire.sh down        # Cleanup orphaned containers (rarely needed)
./aspire.sh dashboard   # Open Aspire Dashboard
./aspire.sh clean       # Remove all containers, volumes, and networks (destructive!)
```

For detailed usage guide, see [docs/ASPIRE_USAGE.md](../../docs/ASPIRE_USAGE.md)

This single command starts:

**Infrastructure Services (Docker Containers)**
- ✅ PostgreSQL database (port 5432)
- ✅ Redis cache (port 6379)
- ✅ Qdrant vector database (port 6333, 6334)
- ✅ Temporal server (port 7233, 8233)
- ✅ Temporal UI (port 8233)
- ✅ MinIO storage (port 9000, 9001)
- ✅ Prometheus metrics (port 9090)
- ✅ Grafana dashboards (port 3100)
- ✅ Jaeger tracing (port 16686, 4318, 4317)
- ✅ Node Exporter metrics (port 9100)

**LangGraph Agents (Docker Containers)**
- ✅ Document Generator Agent (port 8124) - TypeScript LangGraph agent
- ✅ Project Document Generator Agent (port 8125) - TypeScript LangGraph agent

**Application Services (Native Processes)**
- ✅ Next.js Web Application (port 3000)
- ✅ Temporal Worker

**Management Interfaces**
- ✅ Aspire Dashboard (https://localhost:17134)

### 4. Access the Application

- **Web App**: http://localhost:3001
- **Aspire Dashboard**: https://localhost:17134 *(No authentication required in development)*
  - The `web` resource exposes a child `web-browser-logs` resource (Aspire 13.3 `Aspire.Hosting.Browsers`). Use **Open tracked browser** to launch a Chromium tab whose console logs, errors, and network events stream into the dashboard alongside server-side OTLP. Requires a Chromium-based browser (Edge or Chrome) installed locally.
- **Document Generator**: http://localhost:8124/health
- **Project Document Generator**: http://localhost:8125/health
- **Temporal UI**: http://localhost:8233
- **MinIO Console**: http://localhost:9001
- **Prometheus**: http://localhost:9090
- **Grafana**: http://localhost:3100 (admin/admin)
- **Jaeger UI**: http://localhost:16686
- **Node Exporter**: http://localhost:9100/metrics

## Project Structure

```
aspire/
├── Fabric.AppHost/              # Main orchestration project
│   ├── Program.cs              # Service configuration
│   ├── appsettings.json        # Base configuration
│   ├── appsettings.Development.json  # Local dev settings (gitignored)
│   └── Properties/
│       └── launchSettings.json # Launch profiles
│
├── Fabric.ServiceDefaults/      # Shared service configuration
│   ├── Extensions.cs           # Service defaults (telemetry, health checks)
│   └── Fabric.ServiceDefaults.csproj
│
└── Fabric.sln                   # Solution file
```

## Service Discovery

Aspire automatically injects environment variables for service discovery:

### Format
```bash
# Connection strings
ConnectionStrings__<resource-name>=<connection-string>

# Service URLs
services__<service-name>__http__0=http://localhost:<port>
services__<service-name>__https__0=https://localhost:<port>

# Direct endpoint variables
<SERVICE_NAME>_HTTP=http://localhost:<port>
<SERVICE_NAME>_HTTPS=https://localhost:<port>
```

### Example
When the web app references the document-generator agent:
```bash
ConnectionStrings__fabric_db="Host=localhost;Port=5432;Database=fabric;..."
services__document_generator__http__0="http://localhost:8124"
DOCUMENT_GENERATOR_HTTP="http://localhost:8124"
```

## Health Checks

All services expose health check endpoints:
- **Infrastructure**: Automatic health checks via Aspire
- **Agents**: Custom `/health` endpoints
- **Web App**: `/health` endpoint

View health status in the Aspire Dashboard at https://localhost:17134

## Observability

### Aspire Dashboard

The Aspire Dashboard (https://localhost:17134) provides:
- **Console Logs**: Real-time logs from all services
- **Structured Logs**: Searchable, filterable logs
- **Traces**: Distributed tracing across services
- **Metrics**: Performance metrics and resource usage

**Authentication**: Disabled in development mode (`appsettings.Development.json` sets `Dashboard.Frontend.AuthMode` to `Unsecured`). No token required!

## Development Workflow

### Fast Startup (Non-Blocking Architecture)

The web application starts **immediately** without waiting for agent services:

**Startup Timeline:**
1. **0-2s**: Infrastructure services start (PostgreSQL, Redis, Qdrant, Temporal)
2. **2-3s**: ✅ **Web app is ready** at http://localhost:3001
3. **3-30s**: Agents start in parallel (install dependencies, compile, start servers)

**Key Benefits:**
- Fast iteration during development
- No waiting for agent dependencies to initialize
- Agents become available asynchronously
- Web app handles agent unavailability gracefully

**How It Works:**
- Agents are registered **lazily** when the CopilotKit endpoint is called
- No blocking operations during agent adapter initialization
- Health checks are performed at request time, not startup
- UI shows loading states and error messages when agents aren't ready

See [Non-Blocking Agent Startup Architecture](../docs/architecture/NON_BLOCKING_AGENT_STARTUP.md) for details.

### Hot Reload
All services support hot reload:
- TypeScript agents: Automatic reload on file changes
- Python agents: Automatic reload with `--reload` flag
- C# agents: Hot reload with `dotnet watch`
- Next.js: Fast Refresh

### Debugging
1. Start Aspire: `aspire run`
2. Attach debugger to specific service
3. Set breakpoints in your IDE
4. Debug as normal

### Viewing Logs
- **Aspire Dashboard**: https://localhost:17134 > Resources > [Service] > Logs
- **Terminal**: View logs in the Aspire terminal output

## Troubleshooting

### Port Already in Use
```bash
# Find process using port
lsof -i :3001  # macOS/Linux
netstat -ano | findstr :3001  # Windows

# Kill process
kill -9 <PID>  # macOS/Linux
taskkill /PID <PID> /F  # Windows
```

### Database Connection Failed
```bash
# Check if Postgres is running
docker ps | grep postgres

# Restart Postgres
docker restart <container-id>
```

### Agent Not Responding
```bash
# Check agent health
curl http://localhost:8124/health

# View logs in Aspire Dashboard
# Navigate to https://localhost:17134 > Resources > document-generator > Logs
```

## Documentation

For detailed documentation, see:
- [Aspire Usage Guide](../docs/ASPIRE_USAGE.md)
- [Deployment Guide](../docs/deployment.md)
- [Agent System](../docs/agent-system.md)

## Support

For issues or questions:
1. Check the [Troubleshooting Guide](../docs/ASPIRE_USAGE.md#troubleshooting)
2. View logs in Aspire Dashboard
3. Check service health endpoints
4. Review documentation in `/docs`

