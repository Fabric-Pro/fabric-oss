#!/bin/bash
# Stop LangGraph server

cd "$(dirname "$0")"

echo "🛑 Stopping LangGraph Document Generator Agent server..."
docker-compose down

echo ""
echo "✅ LangGraph server stopped!"

