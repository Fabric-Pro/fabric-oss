#!/usr/bin/env bash
# Compose orchestration helper for local development
# Brings up core infrastructure with Docker Compose using .env.compose.example
# plus optional local overrides from .env.compose
# Usage:
#   bash scripts/compose-infra.sh up           # start infra only (postgres, minio, temporal, temporal-ui, qdrant, redis)
#   bash scripts/compose-infra.sh up:agents    # start only langgraph agents
#   bash scripts/compose-infra.sh up:apps      # start temporal-worker and web
#   bash scripts/compose-infra.sh up:all       # start infra + agents + apps
#   bash scripts/compose-infra.sh down         # stop and remove all containers
#   bash scripts/compose-infra.sh down:infra   # stop infra only
#   bash scripts/compose-infra.sh status       # show container status
#   bash scripts/compose-infra.sh logs         # tail infra logs

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE="docker compose"
ENV_FILE=".env.compose"
ENV_EXAMPLE_FILE=".env.compose.example"
ACTIVE_ENV_FILE="$ENV_FILE"
warned_missing_env=false

INFRA_SERVICES=(postgres minio temporal temporal-ui qdrant redis)
OBSERVABILITY_SERVICES=(prometheus grafana jaeger node-exporter)
AGENT_SERVICES=(document-generator-agent project-document-generator-agent)
APP_SERVICES=(temporal-worker web)

info() { echo -e "\033[1;34m[info]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
err()  { echo -e "\033[1;31m[error]\033[0m $*"; }

die_missing_env() {
  err "Missing both $ENV_FILE and $ENV_EXAMPLE_FILE. Restore $ENV_EXAMPLE_FILE from git, or create $ENV_FILE."
  exit 1
}

need_compose() {
  if ! command -v docker &>/dev/null; then err "docker is not installed"; exit 1; fi
  if ! docker compose version &>/dev/null; then err "docker compose plugin not available"; exit 1; fi
}

ensure_env() {
  if [[ -f "$ENV_FILE" ]]; then
    ACTIVE_ENV_FILE="$ENV_FILE"
    return
  fi

  if [[ -f "$ENV_EXAMPLE_FILE" ]]; then
    ACTIVE_ENV_FILE="$ENV_EXAMPLE_FILE"
    if [[ "$warned_missing_env" == false ]]; then
      warn "Missing $ENV_FILE; using committed $ENV_EXAMPLE_FILE defaults. Copy it to $ENV_FILE for local overrides."
      warned_missing_env=true
    fi
    return
  fi

  die_missing_env
}

up_infra() {
  ensure_env
  info "Starting INFRA services: ${INFRA_SERVICES[*]}"
  $COMPOSE --env-file "$ACTIVE_ENV_FILE" up -d "${INFRA_SERVICES[@]}"
  $COMPOSE ps
}

up_observability() {
  ensure_env
  info "Starting OBSERVABILITY services: ${OBSERVABILITY_SERVICES[*]}"
  $COMPOSE --env-file "$ACTIVE_ENV_FILE" up -d "${OBSERVABILITY_SERVICES[@]}"
  $COMPOSE ps
}

up_agents() {
  ensure_env
  info "Starting AGENT services: ${AGENT_SERVICES[*]}"
  $COMPOSE --env-file "$ACTIVE_ENV_FILE" up -d "${AGENT_SERVICES[@]}"
  $COMPOSE ps
}

up_apps() {
  ensure_env
  info "Starting APP services: ${APP_SERVICES[*]}"
  $COMPOSE --env-file "$ACTIVE_ENV_FILE" up -d "${APP_SERVICES[@]}"
  $COMPOSE ps
}

up_all() {
  up_infra
  up_observability
  up_agents
  up_apps
}

down_infra() {
  info "Stopping INFRA services: ${INFRA_SERVICES[*]}"
  $COMPOSE stop "${INFRA_SERVICES[@]}" || true
}

down_observability() {
  info "Stopping OBSERVABILITY services: ${OBSERVABILITY_SERVICES[*]}"
  $COMPOSE stop "${OBSERVABILITY_SERVICES[@]}" || true
}

down_all() {
  info "Stopping all compose services"
  $COMPOSE down
}

status() { $COMPOSE ps; }

logs_infra() { $COMPOSE logs -f "${INFRA_SERVICES[@]}"; }

logs_observability() { $COMPOSE logs -f "${OBSERVABILITY_SERVICES[@]}"; }

logs_all() { $COMPOSE logs -f; }

usage() {
  cat <<USAGE
Usage: bash scripts/compose-infra.sh <command>
Commands:
  up                  Start infra (postgres, minio, temporal, temporal-ui, qdrant, redis)
  up:observability    Start observability stack (prometheus, grafana, jaeger, node-exporter)
  up:agents           Start agents (document-generator-agent, project-document-generator-agent)
  up:apps             Start apps (temporal-worker, web)
  up:all              Start infra + observability + agents + apps
  down                Stop and remove all compose containers
  down:infra          Stop infra only
  down:observability  Stop observability stack only
  status              Show docker compose status
  logs                Tail infra logs
  logs:observability  Tail observability logs
  logs:all            Tail all logs

Services:
  Infra:          postgres, minio, temporal, temporal-ui, qdrant, redis
  Observability:  prometheus, grafana, jaeger, node-exporter
  Agents:         document-generator-agent, project-document-generator-agent
  Apps:           temporal-worker, web

Access URLs (when running):
  Application:       http://localhost:3001
  API Docs:          http://localhost:3001/api/docs
  Metrics:           http://localhost:3001/api/metrics
  Prometheus:        http://localhost:9090
  Grafana:           http://localhost:3100 (admin/admin)
  Jaeger:            http://localhost:16686
  Temporal UI:       http://localhost:8233
  MinIO Console:     http://localhost:9003 (minioadmin/minioadmin)

Notes:
- .env.compose.example provides safe container-network defaults (service hostnames instead of localhost)
- .env.compose is optional, gitignored, and overrides the example for local secrets or machine-specific values
- Avoid port collisions with local pnpm dev on 3000/8124/8125 when using Compose
- Use 'up:all' to start everything including monitoring stack
USAGE
}

need_compose

case "${1:-help}" in
  up) up_infra ;;
  up:observability) up_observability ;;
  up:agents) up_agents ;;
  up:apps) up_apps ;;
  up:all) up_all ;;
  down) down_all ;;
  down:infra) down_infra ;;
  down:observability) down_observability ;;
  status) status ;;
  logs) logs_infra ;;
  logs:observability) logs_observability ;;
  logs:all) logs_all ;;
  *) usage ;;
esac
