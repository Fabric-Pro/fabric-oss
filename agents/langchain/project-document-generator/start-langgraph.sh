#!/bin/bash

# Start LangGraph Project Document Generator Agent
# This script starts the agent using Docker Compose

echo "🚀 Starting Project Document Generator Agent..."
echo "📍 Port: 8125"
echo ""

# Check if .env file exists
if [ ! -f .env ]; then
    echo "⚠️  Warning: .env file not found"
    echo "Creating .env file from template..."
    echo ""
    cat > .env << 'EOF'
# Required: At least one LLM API key
OPENAI_API_KEY=
# or
ANTHROPIC_API_KEY=

# Optional: AI Gateway
AI_GATEWAY_API_KEY=

# Optional: LangSmith tracing
LANGSMITH_API_KEY=
EOF
    echo "✅ Created .env file. Please add your API keys and run this script again."
    exit 1
fi

# Start Docker Compose
docker-compose up -d

echo ""
echo "✅ Project Document Generator Agent started!"
echo ""
echo "📊 Check status:"
echo "   docker-compose ps"
echo ""
echo "📝 View logs:"
echo "   docker-compose logs -f"
echo ""
echo "🔍 Test endpoint:"
echo "   curl http://localhost:8125/ok"
echo ""
echo "📚 API docs:"
echo "   http://localhost:8125/docs"
echo ""
echo "🛑 Stop agent:"
echo "   ./stop-langgraph.sh"
echo ""

