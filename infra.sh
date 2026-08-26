#!/usr/bin/env bash
# Thin wrapper to scripts/compose-infra.sh for convenience from repo root
# Usage examples:
#   bash ./infra.sh up        # start infra only
#   bash ./infra.sh up:all    # start infra + agents + apps

exec bash "$(dirname "$0")/scripts/compose-infra.sh" "$@"

