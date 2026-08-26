#!/usr/bin/env bash
# Aspire orchestration helper for local development
# Thin wrapper around native Aspire CLI for convenience
# 
# NOTE: With the updated configuration, containers now stop automatically when you Ctrl+C.
# You can also use native Aspire commands directly:
#   cd aspire/Fabric.AppHost && aspire run    # Start all services (enables MCP discovery)
#   Ctrl+C                                    # Stop all services
#
# Usage:
#   bash aspire.sh run          # start Aspire AppHost (all services) - alias for 'up'
#   bash aspire.sh up           # start Aspire AppHost (all services)
#   bash aspire.sh down         # cleanup any orphaned containers (usually not needed)
#   bash aspire.sh restart      # restart Aspire AppHost
#   bash aspire.sh status       # show container status
#   bash aspire.sh clean        # remove all containers + volumes (destructive!)
#   bash aspire.sh dashboard    # open Aspire Dashboard in browser

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASPIRE_DIR="$ROOT_DIR/aspire/Fabric.AppHost"

info() { echo -e "\033[1;34m[info]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
err()  { echo -e "\033[1;31m[error]\033[0m $*"; }
success() { echo -e "\033[1;32m[success]\033[0m $*"; }

need_dotnet() {
  if ! command -v dotnet &>/dev/null; then
    err "dotnet is not installed. Install .NET 10 SDK from: https://dotnet.microsoft.com/download"
    exit 1
  fi
  
  local version
  version=$(dotnet --version | cut -d. -f1)
  if [[ "$version" -lt 10 ]]; then
    err "dotnet version 10 or higher required. Current: $(dotnet --version)"
    exit 1
  fi
}

need_docker() {
  if ! command -v docker &>/dev/null; then
    err "docker is not installed"
    exit 1
  fi
}

check_aspire_dir() {
  if [[ ! -d "$ASPIRE_DIR" ]]; then
    err "Aspire AppHost directory not found: $ASPIRE_DIR"
    exit 1
  fi
}

up() {
  check_aspire_dir
  need_dotnet
  need_docker

  info "Starting Aspire AppHost..."
  info "This will start all infrastructure, observability, agents, and applications"
  info ""
  info "To stop all services, press Ctrl+C (containers will stop automatically)"
  info "Aspire Dashboard will be available at https://localhost:17134"
  echo ""

  cd "$ASPIRE_DIR"

  # Set environment variable to disable dashboard authentication
  export ASPIRE__DASHBOARD__FRONTEND__AUTHMODE=Unsecured
  export DOTNET_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=true

  # Run via Aspire CLI so the backchannel (Unix socket) is established,
  # enabling MCP tools and `aspire log` to discover this AppHost.
  aspire run
}

down() {
  need_docker

  info "Cleaning up Aspire containers and processes..."
  echo ""

  # Kill any running dotnet Fabric.AppHost processes first
  if pgrep -f "Fabric.AppHost" >/dev/null; then
    info "Stopping Aspire AppHost process..."
    pkill -TERM -f "Fabric.AppHost" || true
    sleep 2
    # Force kill if still running
    if pgrep -f "Fabric.AppHost" >/dev/null; then
      pkill -KILL -f "Fabric.AppHost" || true
    fi
    success "Stopped Aspire AppHost process"
  fi

  # Kill any DCP processes (Aspire's container orchestrator)
  if pgrep -f "dcp" >/dev/null; then
    info "Stopping DCP processes..."
    pkill -TERM -f "dcp" || true
    sleep 1
  fi

  # Kill orphaned Node.js processes started by Aspire for Fabric project
  # Use more specific patterns to avoid killing unrelated Node processes
  # Patterns are anchored to Fabric-specific paths and identifiers
  local node_patterns=(
    "fabric.*next-server"       # Fabric's Next.js server
    "fabric.*temporal.*worker"  # Fabric's Temporal worker
    "fabric.*partykit"          # Fabric's PartyKit server
    "apps/web.*next dev"        # Fabric's web app in dev mode (with full path context)
  )

  for pattern in "${node_patterns[@]}"; do
    if pgrep -f "$pattern" >/dev/null 2>&1; then
      info "Stopping orphaned Node.js process: $pattern"
      pkill -TERM -f "$pattern" 2>/dev/null || true
    fi
  done

  # Give processes time to terminate gracefully
  sleep 1

  # Force kill any remaining Fabric Node.js processes
  for pattern in "${node_patterns[@]}"; do
    if pgrep -f "$pattern" >/dev/null 2>&1; then
      pkill -KILL -f "$pattern" 2>/dev/null || true
    fi
  done

  # Kill processes bound to Fabric's Aspire ports, but only if they match expected patterns
  # Port 3001: Fabric web app, Port 1999: PartyKit
  for port in 3001 1999; do
    local pid=$(lsof -ti :$port 2>/dev/null || true)
    if [[ -n "$pid" ]]; then
      # Verify the process is actually a Fabric-related process before killing
      local proc_cmd=$(ps -p $pid -o args= 2>/dev/null || true)
      if [[ "$proc_cmd" == *"fabric"* ]] || [[ "$proc_cmd" == *"apps/web"* ]] || [[ "$proc_cmd" == *"partykit"* ]]; then
        info "Killing Fabric process on port $port (PID: $pid)"
        kill -9 $pid 2>/dev/null || true
      else
        warn "Skipping non-Fabric process on port $port (PID: $pid): $proc_cmd"
      fi
    fi
  done

  # Find Aspire containers by their naming pattern (name-XXXXXXXX suffix)
  local aspire_containers
  aspire_containers=$(docker ps -a --format "{{.Names}}" | grep -E ".*-[a-z0-9]{8}$" | grep -v "omarchy" || true)

  # Also find containers by known service names (without the suffix pattern)
  local named_containers
  named_containers=$(docker ps -a --format "{{.Names}}" | grep -E "^(postgres|cache|redis|qdrant|temporal|minio|prometheus|grafana|jaeger|node-exporter|document-generator|project-document-generator|prompt-enhancer|weave-readers|weave-shuttle|weave-planners|web|temporal-worker|temporal-ui|aspire)" || true)

  # Combine and deduplicate
  local all_containers
  all_containers=$(echo -e "${aspire_containers}\n${named_containers}" | sort -u | grep -v "^$" || true)

  if [[ -n "$all_containers" ]]; then
    local count=$(echo "$all_containers" | wc -l)
    info "Found $count Aspire container(s) to stop"
    echo "$all_containers"
    echo ""

    # Stop containers
    echo "$all_containers" | xargs -r docker stop 2>/dev/null || true

    # Remove containers
    echo "$all_containers" | xargs -r docker rm 2>/dev/null || true

    success "Cleaned up Aspire containers"
  else
    info "No Aspire containers found"
  fi

  # Clean up Aspire networks
  local aspire_networks
  aspire_networks=$(docker network ls --format "{{.Name}}" | grep -E "aspire" || true)
  if [[ -n "$aspire_networks" ]]; then
    info "Removing Aspire networks..."
    echo "$aspire_networks" | xargs -r docker network rm 2>/dev/null || true
  fi

  success "Cleanup complete!"
}

restart() {
  down
  sleep 2
  up
}

status() {
  need_docker
  
  info "Aspire Container Status:"
  echo ""
  
  # Show all containers (running or stopped)
  docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "(NAMES|postgres|redis|qdrant|temporal|minio|prometheus|grafana|jaeger|node-exporter|document-generator|project-document-generator|weave-readers|weave-shuttle|weave-planners|web|worker)" || {
    warn "No Aspire containers found"
  }
  
  echo ""
  info "Aspire AppHost Process:"
  if pgrep -f "Fabric.AppHost" >/dev/null; then
    success "Running (PID: $(pgrep -f "Fabric.AppHost"))"
  else
    warn "Not running"
  fi
}


clean() {
  need_docker

  warn "This will stop and REMOVE all containers, volumes, and networks"
  read -p "Are you sure? (y/N) " -n 1 -r
  echo

  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    info "Cancelled"
    exit 0
  fi

  info "Stopping all containers..."
  docker stop $(docker ps -q) 2>/dev/null || true

  info "Removing all containers..."
  docker container prune -f

  info "Removing all volumes..."
  docker volume prune -f

  info "Removing all networks..."
  docker network prune -f

  success "Cleanup complete!"
}

dashboard() {
  info "Opening Aspire Dashboard..."

  # Try to find the dashboard URL from running containers
  local dashboard_url="https://localhost:17134"

  if command -v xdg-open &>/dev/null; then
    xdg-open "$dashboard_url" 2>/dev/null || true
  elif command -v open &>/dev/null; then
    open "$dashboard_url" 2>/dev/null || true
  else
    info "Dashboard URL: $dashboard_url"
  fi
}

# Monitor and restart failed containers (up to max_retries times)
monitor() {
  need_docker

  local max_retries="${1:-3}"
  local check_interval="${2:-30}"

  info "Monitoring Aspire containers (max $max_retries retries per container, checking every ${check_interval}s)"
  info "Press Ctrl+C to stop monitoring"
  echo ""

  declare -A retry_counts

  while true; do
    # Find exited Aspire containers
    local exited_containers
    exited_containers=$(docker ps -a --filter "status=exited" --format "{{.Names}}" | grep -E ".*-[a-z0-9]{8}$" | grep -v "omarchy" || true)

    if [[ -n "$exited_containers" ]]; then
      for container in $exited_containers; do
        local current_retries="${retry_counts[$container]:-0}"

        if [[ $current_retries -lt $max_retries ]]; then
          current_retries=$((current_retries + 1))
          retry_counts[$container]=$current_retries

          warn "Container '$container' exited. Restarting (attempt $current_retries/$max_retries)..."
          docker restart "$container" 2>/dev/null || true

          # Wait a bit for the container to start
          sleep 5

          # Check if it's running now
          if docker ps --format "{{.Names}}" | grep -q "^${container}$"; then
            success "Container '$container' restarted successfully"
          else
            err "Container '$container' failed to restart"
          fi
        else
          # Only warn once when max retries reached
          if [[ $current_retries -eq $max_retries ]]; then
            retry_counts[$container]=$((current_retries + 1))
            err "Container '$container' exceeded max retries ($max_retries). Manual intervention required."
          fi
        fi
      done
    fi

    sleep "$check_interval"
  done
}

# One-time check and restart of failed containers
fix() {
  need_docker

  local max_retries="${1:-3}"

  info "Checking for failed Aspire containers..."
  echo ""

  # Find exited Aspire containers
  local exited_containers
  exited_containers=$(docker ps -a --filter "status=exited" --format "{{.Names}}" | grep -E ".*-[a-z0-9]{8}$" | grep -v "omarchy" || true)

  if [[ -z "$exited_containers" ]]; then
    success "All Aspire containers are running!"
    return 0
  fi

  local restart_count=0
  local fail_count=0

  for container in $exited_containers; do
    local attempt=1
    local restarted=false

    while [[ $attempt -le $max_retries ]]; do
      warn "Restarting '$container' (attempt $attempt/$max_retries)..."
      docker restart "$container" 2>/dev/null || true

      # Wait for container to stabilize
      sleep 10

      # Check if it's running
      if docker ps --format "{{.Names}}" | grep -q "^${container}$"; then
        success "Container '$container' is now running"
        restarted=true
        restart_count=$((restart_count + 1))
        break
      fi

      attempt=$((attempt + 1))
    done

    if [[ "$restarted" != "true" ]]; then
      err "Failed to restart '$container' after $max_retries attempts"
      fail_count=$((fail_count + 1))
    fi
  done

  echo ""
  if [[ $fail_count -eq 0 ]]; then
    success "All containers restarted successfully! ($restart_count restarted)"
  else
    warn "Restart complete: $restart_count succeeded, $fail_count failed"
  fi
}

staging() {
  local env_file="${1:-.env.staging}"

  info "Starting Staging Deployment (Web Only)..."
  info "Loading environment from: $ROOT_DIR/$env_file"
  info ""
  info "This mode runs ONLY the Next.js web app."
  info "All services (Database, Temporal, Storage, etc.) come from cloud providers via env vars."
  info ""

  # Check if env file exists
  if [[ ! -f "$ROOT_DIR/$env_file" ]]; then
    err "Environment file not found: $ROOT_DIR/$env_file"
    err ""
    err "Create $env_file with your cloud service configurations."
    err "See .env.staging.example for a template."
    exit 1
  fi

  # Load environment variables
  set -a
  source "$ROOT_DIR/$env_file"
  set +a

  info "Starting Next.js web app on port ${PORT:-3001}..."
  echo ""

  cd "$ROOT_DIR/apps/web"
  pnpm dev
}

usage() {
  cat <<USAGE
Usage: bash aspire.sh <command>

Commands:
  run         Start Aspire AppHost (all services) - primary command
  up          Start Aspire AppHost (alias for 'run')
  down        Stop and cleanup all Aspire containers
  restart     Restart Aspire AppHost
  status      Show container and process status
  fix         Restart any failed containers (up to 3 retries each)
  monitor     Continuously monitor and restart failed containers
  clean       Remove all containers + volumes (destructive!)
  dashboard   Open Aspire Dashboard in browser
  staging [env_file]  Cloud-only mode: runs ONLY Next.js with cloud services
                      Default env_file: .env.staging
                      Example: ./aspire.sh staging .env.production

✨ RECOMMENDED: Use Native Aspire CLI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  cd aspire/Fabric.AppHost && aspire run    # Start all services (enables MCP)
  Press Ctrl+C                              # Stop all services (automatic cleanup!)

Services Started by Aspire:
  Infrastructure:   postgres, redis, qdrant, temporal, minio
  Observability:    prometheus, grafana, jaeger, node-exporter
  Agents:           document-generator, project-document-generator, prompt-enhancer
  Applications:     web, temporal-worker

Access URLs (when running):
  🎯 Aspire Dashboard:       https://localhost:17134
  🌐 Web Application:        http://localhost:3001
  📊 Grafana:                http://localhost:3100 (admin/admin)
  📈 Prometheus:             http://localhost:9090
  🔍 Jaeger UI:              http://localhost:16686
  ⏱️  Temporal UI:            http://localhost:8233
  💾 MinIO Console:          http://localhost:9001 (minioadmin/minioadmin)
  🤖 Document Generator:     http://localhost:8124/ok
  🤖 Project Doc Generator:  http://localhost:8125/ok
  🤖 Task Planner:           http://localhost:8126/ok
  🤖 Story Breakdown:        http://localhost:8127/ok
  🤖 Data Analyst:           http://localhost:8130/health
  🤖 API Agent:              http://localhost:8131/ok
  🤖 Prompt Enhancer:        http://localhost:8134/ok

Important Notes:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Agent containers have built-in retry logic for network failures
✅ Data volumes persist between sessions (no data loss)
✅ Faster startup with non-blocking agent initialization
✅ Web app available in 2-3 seconds (agents start in parallel)

🛠️  Troubleshooting:
  - If containers fail: Run './aspire.sh fix' to restart failed containers
  - If containers don't stop: Run './aspire.sh down'
  - Continuous monitoring: Run './aspire.sh monitor' in another terminal
  - To remove all data: Run './aspire.sh clean' (destructive!)
  - Check service status: './aspire.sh status'

Configuration:
  - Environment variables in .env.local at repository root
  - Secrets managed via: dotnet user-secrets (see aspire/Fabric.AppHost/)
USAGE
}

# Only check for dotnet/docker for commands that need them
case "${1:-help}" in
  run|up)
    need_dotnet
    need_docker
    up ;;
  restart)
    need_dotnet
    need_docker
    restart ;;
  down)
    need_docker
    down ;;
  status)
    need_docker
    status ;;
  fix)
    need_docker
    fix "${2:-3}" ;;
  monitor)
    need_docker
    monitor "${2:-3}" "${3:-30}" ;;
  clean)
    need_docker
    clean ;;
  dashboard)
    dashboard ;;
  staging)
    staging "${2:-.env.staging}" ;;
  *)
    usage ;;
esac

