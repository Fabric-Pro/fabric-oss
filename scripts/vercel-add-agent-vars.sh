#!/bin/bash
# =============================================================================
# Add Agent Environment Variables to Vercel
# =============================================================================
# Quick script to add the agent-related environment variables to Vercel
#
# Usage:
#   ./scripts/vercel-add-agent-vars.sh          # Add to preview (staging)
#   ./scripts/vercel-add-agent-vars.sh prod     # Add to production
# =============================================================================

set -e

TARGET="${1:-preview}"

echo "Adding agent environment variables to Vercel ($TARGET)..."
echo ""

# Agent URLs and security tokens — set these as environment variables before
# running this script (e.g. `export AI_TOKEN_SECRET=...`). Values are intentionally
# not hardcoded so this file is safe to commit.
required_vars=(
    DOCUMENT_GENERATOR_URL
    PROJECT_DOCUMENT_GENERATOR_URL
    TASK_PLANNER_URL
    STORY_BREAKDOWN_URL
    API_AGENT_URL
    PROMPT_ENHANCER_URL
    CUGA_AGENT_URL
    WEAVE_PLANNERS_URL
    WEAVE_READERS_URL
    WEAVE_SHUTTLE_URL
    AI_DOCUMENT_AGENT_URL
    DYNAMIC_AGENT_RUNTIME_URL
    AI_TOKEN_SECRET
    AGENT_API_KEY
    AGENT_SERVICE_SECRET
    FABRIC_API_URL
)
missing=()
for v in "${required_vars[@]}"; do
    if [ -z "${!v}" ]; then missing+=("$v"); fi
done
if [ ${#missing[@]} -gt 0 ]; then
    echo "Error: the following required env vars are not set:" >&2
    printf '  %s\n' "${missing[@]}" >&2
    exit 1
fi
declare -A AGENT_VARS=(
    ["DOCUMENT_GENERATOR_URL"]="$DOCUMENT_GENERATOR_URL"
    ["PROJECT_DOCUMENT_GENERATOR_URL"]="$PROJECT_DOCUMENT_GENERATOR_URL"
    ["TASK_PLANNER_URL"]="$TASK_PLANNER_URL"
    ["STORY_BREAKDOWN_URL"]="$STORY_BREAKDOWN_URL"
    ["API_AGENT_URL"]="$API_AGENT_URL"
    ["PROMPT_ENHANCER_URL"]="$PROMPT_ENHANCER_URL"
    ["CUGA_AGENT_URL"]="$CUGA_AGENT_URL"
    ["WEAVE_PLANNERS_URL"]="$WEAVE_PLANNERS_URL"
    ["WEAVE_READERS_URL"]="$WEAVE_READERS_URL"
    ["WEAVE_SHUTTLE_URL"]="$WEAVE_SHUTTLE_URL"
    ["AI_DOCUMENT_AGENT_URL"]="$AI_DOCUMENT_AGENT_URL"
    ["DYNAMIC_AGENT_RUNTIME_URL"]="$DYNAMIC_AGENT_RUNTIME_URL"
    ["AI_TOKEN_SECRET"]="$AI_TOKEN_SECRET"
    ["AGENT_API_KEY"]="$AGENT_API_KEY"
    ["AGENT_SERVICE_SECRET"]="$AGENT_SERVICE_SECRET"
    ["FABRIC_API_URL"]="$FABRIC_API_URL"
)

for VAR_NAME in "${!AGENT_VARS[@]}"; do
    VAR_VALUE="${AGENT_VARS[$VAR_NAME]}"
    echo -n "  Setting $VAR_NAME... "
    if echo "$VAR_VALUE" | vercel env add "$VAR_NAME" "$TARGET" --force 2>/dev/null; then
        echo "✓"
    else
        echo "✗ (may already exist)"
    fi
done

echo ""
echo "Done! You may need to redeploy for changes to take effect:"
echo "  vercel --prod    # for production"
echo "  vercel           # for preview"

