/**
 * @repo/mcp - MCP Client Factory Package
 *
 * Provides MCP client factories that use official MCP SDK transports.
 * This is the single source of truth for MCP client creation across the codebase.
 *
 * Two client types are available:
 *
 * 1. **Standard Client** (`createMcpClient`):
 *    - Uses @ai-sdk/mcp for simplified AI SDK integration
 *    - Best for tool discovery and execution
 *    - Does NOT support sampling (cannot provide LLM access to servers)
 *
 * 2. **Sampling Client** (`createSamplingMcpClient`):
 *    - Uses @modelcontextprotocol/sdk directly
 *    - Supports the full MCP protocol including sampling
 *    - Can provide LLM access to MCP servers that request it
 *    - Use this when servers need to make AI completions
 *
 * @see https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools
 * @see https://spec.modelcontextprotocol.io/specification/basic/transports/
 * @see https://modelcontextprotocol.io/specification/2025-06-18/client/sampling
 */

// Standard MCP client (AI SDK wrapper - no sampling support)
export {
	type ApiKeyMethod,
	// Auth header building utilities
	buildAuthHeaders,
	type CreateMcpClientForConfigOptions,
	type CreateMcpClientOptions,
	clearMcpClientCache,
	closeMcpClient,
	createMcpClient,
	createMcpClientForConfig,
	// Cached client for performance (reuses connections across steps)
	getCachedMcpClientForConfig,
	getMcpClientCacheStats,
	invalidateMcpClientCache,
	McpClientError,
	type McpClientType,
	// OAuth authorization required error (for handling in UI)
	OAuthAuthorizationRequiredError,
} from "./lib/client";
// OAuth Client Provider for AI SDK v6 (automatic token management)
export {
	type CreateOAuthProviderOptions,
	cleanupOAuthFlowState,
	createOAuthClientProvider,
	hasValidOAuthTokens,
} from "./lib/oauth-provider";
// Read-only mode write-gate + the single external-dispatch funnel (Fizzy #2007)
export {
	type CallMcpToolOptions,
	callMcpTool,
	guardToolWriteForReadOnly,
} from "./lib/read-only-gate";

// Sampling-enabled MCP client (full MCP protocol support)
export {
	createSamplingHandler,
	createSamplingMcpClient,
	type SamplingApprovalRequest,
	type SamplingClientOptions,
	type SamplingConfig,
	type SamplingHandler,
	type SamplingMcpClient,
	selectModelFromPreferences,
} from "./lib/sampling";
