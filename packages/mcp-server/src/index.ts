/**
 * @fabricorg/mcp-server
 *
 * Server-side primitives for Fabric's hosted MCP server.
 *
 * The Fabric MCP server is served remotely over Streamable HTTP at
 * `https://fabric.pro/mcp` (implementation: `apps/web/app/mcp/route.ts`).
 * MCP clients (Claude Desktop, Cursor, etc.) connect to that URL directly
 * with an API key — there is no local stdio bridge to install.
 *
 * This package now exposes only the reusable building blocks that the hosted
 * route consumes: durable session storage, access-control guards, rate
 * limiting, and shared type schemas. The former stdio client
 * (`FabricApiClient`, `createFabricMcpServer`, the `fabric-mcp` CLI, and the
 * REST tool wrappers) has been removed — it targeted RPC-style endpoints
 * (`/api/mcp/*`, `/api/browser-automation/*`) that were never implemented.
 * The real REST surface is `/api/v1/*`; the MCP tool surface lives on the
 * hosted `/mcp` route.
 *
 * Features:
 * - Multi-tenant isolation (user/organization scoping)
 * - Durable, resumable MCP sessions (Upstash-backed)
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 */

// Access control
export {
	type AccessContext,
	type AccessMode,
	ApprovalHandler,
	type ApprovalRequest,
	createPendingApprovalResponse,
	createResourceGuard,
	getApprovalHandler,
	type PendingApprovalResponse,
	ResourceAccessDeniedError,
	type ResourceFilter,
	ResourceGuard,
	type ToolAnnotations,
} from "./access-control";
// Rate limiting
export {
	getRateLimiter,
	McpRateLimiter,
	RateLimitError,
	type RateLimitResult,
} from "./rate-limit";

// Session management
export {
	getSessionStore,
	type McpSession,
	type SessionCreateInput,
	type SessionStore,
	UpstashSessionStore,
} from "./session";

// Type schemas
export {
	BrowserActionSchema,
	ContentExtractorSchema,
	ExecuteTemplateInputSchema,
	ExtractWebContentInputSchema,
	HybridModeSchema,
	ListTemplatesInputSchema,
	RunBrowserTaskInputSchema,
	RunHybridTaskInputSchema,
} from "./types";
