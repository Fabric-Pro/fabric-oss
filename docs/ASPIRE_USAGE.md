# Aspire CLI Usage Guide

## Overview

This project uses **.NET Aspire** for orchestrating all development services, including infrastructure (PostgreSQL, Redis, Qdrant, Temporal), observability (Prometheus, Grafana, Jaeger), LangGraph agents, and the Next.js web application.

## Quick Start

### Recommended: Native Aspire CLI

The simplest and most reliable way to use Aspire:

```bash
# Start all services
cd aspire/Fabric.AppHost && aspire run

# Stop all services
Press Ctrl+C
```

**That's it!** Containers now stop automatically when you press Ctrl+C. 🎉

### Alternative: Convenience Script

If you prefer, you can use the wrapper script:

```bash
# Start all services
./aspire.sh run

# Stop all services
Press Ctrl+C

# Cleanup orphaned containers (if needed)
./aspire.sh down
```

## Key Changes (November 2025)

### ✅ What Changed

1. **Automatic Container Cleanup**: Containers now use session lifetime instead of persistent lifetime
2. **Data Persists**: Docker volumes still persist between sessions, so you won't lose data
3. **Ctrl+C Works**: Pressing Ctrl+C properly stops all containers and processes
4. **Simpler Workflow**: No need for manual cleanup commands

### 🔄 Migration from Old Approach

**Before** (required manual cleanup):
```bash
./aspire.sh up       # Start services
./aspire.sh down     # Stop services (required!)
```

**Now** (automatic cleanup):
```bash
./aspire.sh run      # Start services
Ctrl+C               # Stop services (automatic!)
```

## Service Architecture

### Infrastructure Services
- **PostgreSQL** (port 5432) - Primary database with persistent volume
- **Redis** (port 6379) - Cache and session storage with persistent volume
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

```bash
# Simply press Ctrl+C in the terminal where Aspire is running
# Containers will stop automatically!
```

### Check Status

```bash
./aspire.sh status
```

Example output:
```
NAMES                      STATUS          PORTS
postgres-67728638          Up 5 minutes    0.0.0.0:5432->5432/tcp
redis-67728638             Up 5 minutes    0.0.0.0:6379->6379/tcp
...
```

### Cleanup Orphaned Containers

If containers don't stop properly (rare):

```bash
./aspire.sh down
```

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

### Aspire Secrets

Sensitive configuration is managed via .NET user secrets:

```bash
cd aspire/Fabric.AppHost

# Set a secret
dotnet user-secrets set "postgres-password" "your-password"
dotnet user-secrets set "minio-root-user" "minioadmin"
dotnet user-secrets set "minio-root-password" "minioadmin"
dotnet user-secrets set "grafana-admin-password" "admin"

# List all secrets
dotnet user-secrets list
```

Secrets are stored in: `~/.microsoft/usersecrets/fabric-apphost-secrets/`

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

### Containers Don't Stop After Ctrl+C

This should no longer happen with the new configuration. If it does:

```bash
./aspire.sh down
```

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
