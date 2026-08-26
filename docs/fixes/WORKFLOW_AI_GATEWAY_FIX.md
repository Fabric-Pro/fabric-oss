# Workflow Builder AI Gateway Fix

## Issue
Workflow executions were failing with the error:
```
"Vercel AI Gateway access failed. If you want to use AI SDK providers directly, use the providers, e.g. @ai-sdk/openai, or register a different global default provider."
```

## Root Cause
The workflow builder node definitions store AI model names **with provider prefixes** (e.g., `"anthropic/claude-sonnet-4.0"`, `"openai/gpt-4o-mini"`), but the `getModel()` function in `packages/ai/index.ts` was **adding the provider prefix again**, resulting in invalid model names like:
- `"anthropic/anthropic/claude-sonnet-4.0"` (double prefix)
- `"openai/openai/gpt-4o-mini"` (double prefix)

This caused the Vercel AI Gateway to reject the requests.

## Solution
Updated the `getModel()` function to:
1. **Check if the model name already has a provider prefix** (contains `/`)
2. **Only add the prefix if it's missing**
3. **Extract the model name without prefix** when using direct providers

### Changes Made

#### 1. `packages/ai/index.ts`
- Added `formatModelName()` helper function to intelligently add provider prefix only when needed
- Added `extractModelName()` helper function to remove provider prefix for direct provider usage
- Updated `getModel()` to use these helpers for both custom API keys and global gateway
- Fixed non-null assertion in `getGatewayProvider()` for better error handling

#### 2. `packages/temporal/src/activities/workflow-builder-execution.ts`
- Added more detailed logging in `executeAiGenerateTextNode()` to help diagnose future issues
- Improved error messages to include more context

## How It Works Now

### Model Name Formats Supported
The `getModel()` function now supports both formats:
- **With prefix**: `"anthropic/claude-sonnet-4.0"`, `"openai/gpt-4o-mini"`, `"deepseek/deepseek-reasoner"`
- **Without prefix**: `"claude-sonnet-4.0"`, `"gpt-4o-mini"`, `"deepseek-reasoner"`

### Execution Flow
1. User creates workflow with AI node (model stored as `"anthropic/claude-sonnet-4.0"`)
2. User clicks "Run" → Temporal workflow starts
3. Workflow activity fetches user/org AI Gateway API key from database
4. Activity calls `getModel("anthropic/claude-sonnet-4.0", { apiKey, userId, organizationId })`
5. `getModel()` detects the prefix is already present and passes it directly to gateway
6. Gateway successfully routes request to Anthropic with correct model name

## Testing
To verify the fix:
1. Configure AI Gateway API key in Settings
2. Create a workflow with an AI Generate Text node
3. Select any model from the dropdown (e.g., "Claude Sonnet 4.0")
4. Click "Run"
5. Workflow should execute successfully and generate text

## Related Files
- `packages/ai/index.ts` - AI model provider configuration
- `packages/temporal/src/activities/workflow-builder-execution.ts` - Workflow node execution
- `apps/web/modules/saas/workflows/lib/node-definitions.ts` - Node definitions with model options

## Future Improvements
- Consider standardizing on one format (with or without prefix) across the codebase
- Add validation to ensure model names are in the correct format
- Add unit tests for `getModel()` with various model name formats

