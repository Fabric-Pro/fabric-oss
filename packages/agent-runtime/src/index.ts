/**
 * @repo/agent-runtime
 *
 * Multi-tenant runtime utilities for Fabric AI agents.
 *
 * This package provides:
 * - Multi-tenant context management (TenantContext)
 * - Dynamic model configuration resolution
 * - API key authentication
 * - Hono middleware for agent servers
 * - Standardized request/response types
 *
 * Usage in agents:
 *
 * ```typescript
 * import {
 *   tenantAuth,
 *   requestContext,
 *   agentErrorHandler,
 *   getTenant,
 * } from "@repo/agent-runtime";
 *
 * const app = new Hono();
 *
 * // Apply middleware
 * app.use("*", requestContext({ agentId: "my-agent" }));
 * app.use("*", tenantAuth(["ai:models:resolve"]));
 * app.onError(agentErrorHandler());
 *
 * // Use in handler
 * app.post("/run", async (c) => {
 *   const tenant = getTenant(c);
 *   return c.json({
 *     userId: tenant.userId,
 *     organizationId: tenant.organizationId,
 *   });
 * });
 * ```
 *
 * NOTE: LangChain model creation for agents lives in `@repo/agent-core`
 * (`createProviderModel` / `getAgentModelAsync`), not here.
 */

// Re-export middleware
export {
	AgentError,
	// Error handling
	agentErrorHandler,
	buildResponseMetadata,
	getAgentId,
	getOptionalTenant,
	getRequestDuration,
	getRequestId,
	getTenant,
	optionalTenantAuth,
	type RequestContextOptions,
	// Request context
	requestContext,
	// Tenant auth
	tenantAuth,
	throwAgentError,
} from "./middleware";
// Re-export model resolver
export {
	clearConfigCache,
	hasAnyScope,
	hasScope,
	// API key resolution
	resolveApiKeyToTenant,
	// Model config resolution
	resolveModelConfig,
} from "./model-resolver";
// Re-export runtime client (for calling Runtime API)
export {
	createRuntimeClient,
	getRuntimeClient,
	RuntimeClient,
	type RuntimeClientConfig,
} from "./runtime-client";

// Re-export security module
export {
	type ApplySecurityOptions,
	// Application helper
	applySecurity,
	createSecurityHeaders,
	extractRequestId,
	extractServiceToken,
	extractSignedContextFromHeaders,
	extractSourceAgent,
	getServiceSecret,
	// Header utilities
	SECURITY_HEADERS,
	type ServiceAuthOptions,
	SignatureVerificationError,
	type SignedTenantContext,
	type SigningOptions,
	// Middleware
	serviceAuth,
	// Signing utilities
	signTenantContext,
	type VerifySignedTenantRequestResult,
	validateSecurityConfig,
	// Framework-agnostic request verifier (for Next.js route handlers etc.)
	verifySignedTenantRequest,
	verifyTenantContext,
} from "./security";
// Re-export all types
export type {
	A2ARequest,
	AGUIEvent,
	AgentErrorResponse,
	AgentRequestContext,
	// Request/response types
	BaseAgentRequest,
	BaseAgentResponse,
	ModelResolutionInput,
	ModelResolutionResult,
	StreamingAgentResponse,
	// Tenant context types
	TenantContext,
	TenantModelConfig,
} from "./types";
