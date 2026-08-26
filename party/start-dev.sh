#!/bin/sh
# Start PartyKit dev server with port from environment variable
# This wrapper allows Aspire to control the port via PARTYKIT_PORT env var

PORT=${PARTYKIT_PORT:-1999}
echo "Starting PartyKit dev server on port $PORT..."
exec npx partykit dev --port "$PORT"