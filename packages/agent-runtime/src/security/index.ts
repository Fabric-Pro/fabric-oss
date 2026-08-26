/**
 * Security Module
 *
 * Provides secure inter-agent communication with:
 * - Service token authentication
 * - Signed tenant context (HMAC-SHA256)
 * - Replay attack prevention (timestamp validation)
 * - Hono middleware for easy integration
 *
 * Usage in agents:
 *
 * ```typescript
 * import { Hono } from "hono";
 * import { serviceAuth, agentErrorHandler, requestContext } from "@repo/agent-runtime";
 *
 * const app = new Hono();
 *
 * // Apply security middleware (skips /health and /.well-known/agent.json)
 * app.use("*", requestContext({ agentId: "my-agent" }));
 * app.use("*", serviceAuth());
 * app.onError(agentErrorHandler());
 *
 * // Tenant context is available in handlers
 * app.post("/a2a/send", async (c) => {
 *   const tenant = c.get("tenant");
 *   console.log(`Request from user: ${tenant.userId}`);
 *   // ...
 * });
 * ```
 *
 * Environment variables:
 * - AGENT_SERVICE_SECRET: Shared secret for service authentication (min 32 chars)
 */

// Application helper
export {
	type ApplySecurityOptions,
	applySecurity,
	validateSecurityConfig,
} from "./apply-security";

// Header utilities
export {
	createSecurityHeaders,
	extractRequestId,
	extractServiceToken,
	extractSignedContextFromHeaders,
	extractSourceAgent,
	SECURITY_HEADERS,
} from "./headers";

// Middleware
export { type ServiceAuthOptions, serviceAuth } from "./middleware";
// Signing utilities
export {
	getServiceSecret,
	SignatureVerificationError,
	type SignedTenantContext,
	type SigningOptions,
	signTenantContext,
	verifyTenantContext,
} from "./signing";
// Framework-agnostic request verifier (for Next.js route handlers etc.)
export {
	type VerifySignedTenantRequestResult,
	verifySignedTenantRequest,
} from "./verify-request";
