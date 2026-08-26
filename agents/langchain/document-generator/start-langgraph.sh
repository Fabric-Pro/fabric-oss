#!/bin/bash
# Start LangGraph server using docker-compose

cd "$(dirname "$0")"

echo "🚀 Starting LangGraph Document Generator Agent server..."
docker-compose up -d

echo ""
echo "✅ LangGraph server started!"
echo ""
echo "📍 API Server: http://localhost:8124"
echo "📖 API Docs: http://localhost:8124/docs"
echo ""
echo "To view logs: docker-compose logs -f"
echo "To stop: docker-compose down"

