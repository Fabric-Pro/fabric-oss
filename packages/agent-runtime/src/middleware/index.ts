/**
 * Agent Runtime Middleware
 *
 * Export all middleware for multi-tenant agent runtime.
 */

// Error handling
export {
	AgentError,
	agentErrorHandler,
	throwAgentError,
} from "./error-handler";

// Request context middleware
export {
	buildResponseMetadata,
	getAgentId,
	getRequestDuration,
	getRequestId,
	type RequestContextOptions,
	requestContext,
} from "./request-context";
// Tenant authentication middleware
export {
	getOptionalTenant,
	getTenant,
	optionalTenantAuth,
	tenantAuth,
} from "./tenant-middleware";
