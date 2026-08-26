#!/bin/bash

# Verify Prompt Enhancer Agent Configuration
# This script checks that all components are properly configured

set -e

echo "🔍 Verifying Prompt Enhancer Agent Configuration..."
echo ""

# Check 1: Environment variable
echo "1️⃣  Checking environment variable..."
if grep -q "PROMPT_ENHANCER_URL" .env.local; then
    PROMPT_ENHANCER_URL=$(grep "PROMPT_ENHANCER_URL" .env.local | cut -d'=' -f2 | tr -d '"')
    echo "   ✅ PROMPT_ENHANCER_URL is set to: $PROMPT_ENHANCER_URL"
else
    echo "   ❌ PROMPT_ENHANCER_URL is NOT set in .env.local"
    echo "   💡 Add this line to .env.local:"
    echo "      PROMPT_ENHANCER_URL=\"http://localhost:8134\""
    exit 1
fi
echo ""

# Check 2: Agent server file exists
echo "2️⃣  Checking agent server file..."
if [ -f "agents/langchain/prompt-enhancer/unified-server.ts" ]; then
    echo "   ✅ unified-server.ts exists"
else
    echo "   ❌ unified-server.ts NOT found"
    exit 1
fi
echo ""

# Check 3: Try Agent page exists
echo "3️⃣  Checking Try Agent page..."
if [ -f "apps/web/app/(saas)/app/agents/[agentId]/enhance/page.tsx" ]; then
    echo "   ✅ Try Agent page exists at /app/agents/[agentId]/enhance"
else
    echo "   ❌ Try Agent page NOT found"
    exit 1
fi
echo ""

# Check 4: PromptContentEnhancer component exists
echo "4️⃣  Checking PromptContentEnhancer component..."
if [ -f "apps/web/modules/saas/prompts/components/PromptContentEnhancer.tsx" ]; then
    echo "   ✅ PromptContentEnhancer component exists"
else
    echo "   ❌ PromptContentEnhancer component NOT found"
    exit 1
fi
echo ""

# Check 5: Diff highlighting CSS exists
echo "5️⃣  Checking diff highlighting CSS..."
if [ -f "apps/web/modules/saas/prompts/components/PromptContentEnhancer.css" ]; then
    echo "   ✅ Diff highlighting CSS exists"
    
    # Check for streaming-diff-active class
    if grep -q "streaming-diff-active" "apps/web/modules/saas/prompts/components/PromptContentEnhancer.css"; then
        echo "   ✅ streaming-diff-active class found"
    else
        echo "   ⚠️  streaming-diff-active class NOT found in CSS"
    fi
else
    echo "   ❌ PromptContentEnhancer.css NOT found"
    exit 1
fi
echo ""

# Check 6: Agent is registered in CopilotKit
echo "6️⃣  Checking CopilotKit registration..."
if grep -q "prompt_enhancer" "apps/web/app/api/copilotkit/route.ts"; then
    echo "   ✅ prompt_enhancer is registered in CopilotKit"
    
    # Check for predictive states
    if grep -q "streamingContent" "apps/web/app/api/copilotkit/route.ts"; then
        echo "   ✅ Predictive states configured (streamingContent, focusAnchor)"
    else
        echo "   ⚠️  Predictive states may not be configured"
    fi
else
    echo "   ❌ prompt_enhancer NOT registered in CopilotKit"
    exit 1
fi
echo ""

# Check 7: Agent is seeded in database
echo "7️⃣  Checking database seed configuration..."
if grep -q "prompt_enhancer" "packages/database/prisma/seed-system-agents.ts"; then
    echo "   ✅ prompt_enhancer is in seed-system-agents.ts"
    
    # Check for capabilities
    if grep -A 5 "agentId: \"prompt_enhancer\"" "packages/database/prisma/seed-system-agents.ts" | grep -q "requiresEditor: true"; then
        echo "   ✅ requiresEditor capability is set"
    fi
    
    if grep -A 5 "agentId: \"prompt_enhancer\"" "packages/database/prisma/seed-system-agents.ts" | grep -q "editorType: \"prompt\""; then
        echo "   ✅ editorType is set to 'prompt'"
    fi
else
    echo "   ❌ prompt_enhancer NOT found in seed-system-agents.ts"
    exit 1
fi
echo ""

# Check 8: Test agent connectivity (if running)
echo "8️⃣  Testing agent connectivity..."
if command -v curl &> /dev/null; then
    if curl -s -f "http://localhost:8134/health" > /dev/null 2>&1; then
        echo "   ✅ Agent is running and responding at http://localhost:8134"
        
        # Check A2A endpoint
        if curl -s -f "http://localhost:8134/.well-known/agent.json" > /dev/null 2>&1; then
            echo "   ✅ A2A endpoint is accessible"
        else
            echo "   ⚠️  A2A endpoint not accessible (agent may not be fully started)"
        fi
    else
        echo "   ⚠️  Agent is NOT running at http://localhost:8134"
        echo "   💡 Start the agent with: cd agents/langchain/prompt-enhancer && pnpm dev"
        echo "   💡 Or use Aspire: ./aspire.sh restart"
    fi
else
    echo "   ⚠️  curl not available, skipping connectivity test"
fi
echo ""

echo "✅ All configuration checks passed!"
echo ""
echo "📝 Next steps:"
echo "   1. If the agent is not running, start it:"
echo "      cd agents/langchain/prompt-enhancer && pnpm dev"
echo "   2. Or restart all services with Aspire:"
echo "      ./aspire.sh restart"
echo "   3. Navigate to: http://localhost:3001/app/agents/prompt_enhancer"
echo "   4. Click 'Try Agent' button"
echo "   5. Test the prompt enhancement with diff highlighting"
echo ""

