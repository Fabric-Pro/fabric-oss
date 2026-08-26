#!/bin/bash

# Start Services Script for Document Generation
# This script starts all required services for the document generation feature

set -e

echo "🚀 Starting Document Generation Services..."
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to check if a service is running
check_service() {
    local url=$1
    local name=$2
    
    if curl -s "$url" > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} $name is running"
        return 0
    else
        echo -e "${RED}✗${NC} $name is NOT running"
        return 1
    fi
}

# Function to check if a port is in use
check_port() {
    local port=$1
    local name=$2
    
    if lsof -i ":$port" > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} $name is running on port $port"
        return 0
    else
        echo -e "${RED}✗${NC} $name is NOT running on port $port"
        return 1
    fi
}

echo "📋 Checking existing services..."
echo ""

# Check Temporal Server
check_service "http://localhost:8233" "Temporal Server" || {
    echo -e "${YELLOW}⚠${NC}  Temporal Server is not running"
    echo "   Start it with: docker-compose up -d temporal"
    echo ""
}

# Check Qdrant
check_service "http://localhost:6333/health" "Qdrant" || {
    echo -e "${YELLOW}⚠${NC}  Qdrant is not running"
    echo "   Start it with: docker-compose up -d qdrant"
    echo ""
}

# Check PostgreSQL
check_port 5432 "PostgreSQL" || {
    echo -e "${YELLOW}⚠${NC}  PostgreSQL is not running"
    echo "   Start it with: docker-compose up -d postgres"
    echo ""
}

# Check LangGraph Generic Document Generator (port 8124)
check_service "http://localhost:8124/ok" "LangGraph Generic Document Generator" || {
    echo -e "${YELLOW}⚠${NC}  LangGraph Generic Document Generator is not running"
    echo "   Note: This is optional, only needed for /app/agents/document-generator demo"
    echo "   Start it with: cd agents/langchain/document-generator && ./start-langgraph.sh"
    echo ""
}

# Check LangGraph Project Document Generator (port 8125) - REQUIRED
check_service "http://localhost:8125/ok" "LangGraph Project Document Generator" || {
    echo -e "${YELLOW}⚠${NC}  LangGraph Project Document Generator is not running"
    echo "   ⚠️  This is REQUIRED for project document generation!"
    echo "   Start it with: cd agents/langchain/project-document-generator && ./start-langgraph.sh"
    echo ""
}

# Check Next.js Dev Server
check_port 3000 "Next.js Dev Server" || {
    echo -e "${YELLOW}⚠${NC}  Next.js Dev Server is not running"
    echo "   Start it with: pnpm dev"
    echo ""
}

# Check Temporal Worker
if ps aux | grep -E "tsx.*worker\.ts" | grep -v grep > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Temporal Worker is running"
else
    echo -e "${RED}✗${NC} Temporal Worker is NOT running"
    echo -e "${YELLOW}⚠${NC}  This is CRITICAL - workflows cannot execute without a worker!"
    echo ""
    echo "🔧 Starting Temporal Worker..."
    echo ""
    
    # Start the worker in a new terminal or background
    if command -v gnome-terminal &> /dev/null; then
        gnome-terminal -- bash -c "cd $(pwd) && pnpm --filter @repo/temporal dev; exec bash"
        echo -e "${GREEN}✓${NC} Temporal Worker started in new terminal"
    elif command -v xterm &> /dev/null; then
        xterm -e "cd $(pwd) && pnpm --filter @repo/temporal dev" &
        echo -e "${GREEN}✓${NC} Temporal Worker started in new terminal"
    else
        echo -e "${YELLOW}⚠${NC}  Could not auto-start worker (no terminal emulator found)"
        echo "   Please run manually in a new terminal:"
        echo "   pnpm --filter @repo/temporal dev"
    fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📊 Service Status Summary:"
echo ""
echo "Required Services:"
echo "  • Temporal Server (http://localhost:8233)"
echo "  • Temporal Worker (pnpm --filter @repo/temporal dev) - CRITICAL!"
echo "  • Qdrant (http://localhost:6333)"
echo "  • PostgreSQL (port 5432)"
echo "  • LangGraph Project Document Generator (http://localhost:8125) - REQUIRED!"
echo "  • Next.js Dev Server (http://localhost:3001)"
echo ""
echo "Optional Services:"
echo "  • LangGraph Generic Document Generator (http://localhost:8124) - For demo only"
echo ""
echo "Note: Context embedding is done directly by Temporal worker (no separate agent)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Ask if user wants to restart Next.js dev server
echo -e "${YELLOW}?${NC} Do you want to restart the Next.js dev server? (y/n)"
read -r response

if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    echo ""
    echo "🔄 Restarting Next.js dev server..."
    echo ""
    
    # Kill existing Next.js processes
    pkill -f "next dev" || true
    pkill -f "pnpm dev" || true
    
    # Wait a moment
    sleep 2
    
    # Clear cache
    echo "🧹 Clearing Next.js cache..."
    rm -rf apps/web/.next
    rm -rf apps/web/.turbo
    
    echo ""
    echo -e "${GREEN}✓${NC} Cache cleared"
    echo ""
    echo "Please run: pnpm dev"
    echo ""
else
    echo ""
    echo "Skipping Next.js restart"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "✅ Service check complete!"
echo ""
echo "Next steps:"
echo "1. Make sure all services are running (see status above)"
echo "2. If Temporal Worker is not running, start it:"
echo "   pnpm --filter @repo/temporal dev"
echo "3. If Next.js dev server needs restart, run:"
echo "   pnpm dev"
echo "4. Navigate to: http://localhost:3001/app/projects/new"
echo "5. Complete the wizard and test document generation"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

