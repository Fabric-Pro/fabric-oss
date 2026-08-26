/**
 * Security Middleware for Agents
 *
 * Hono middleware for validating inter-agent requests.
 * Provides service token validation and tenant context verification.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import type { TenantContext } from "../types";
import {
	extractRequestId,
	extractServiceToken,
	extractSignedContextFromHeaders,
	extractSourceAgent,
	SECURITY_HEADERS,
} from "./headers";
import { SignatureVerificationError, verifyTenantContext } from "./signing";

// Extend Hono's context types for security
// Note: requestId is already declared in request-context.ts as string
// We only add sourceAgent here
declare module "hono" {
	interface ContextVariableMap {
		tenant: TenantContext;
		sourceAgent: string | null;
	}
}

/**
 * Options for service authentication middleware
 */
export interface ServiceAuthOptions {
	/** Custom service token (defaults to AGENT_SERVICE_SECRET env var) */
	serviceToken?: string;
	/** Maximum age of signed context in milliseconds (default: 5 minutes) */
	maxContextAge?: number;
	/** Whether to require tenant context (default: true) */
	requireTenantContext?: boolean;
	/** Skip authentication for specific paths (e.g., health checks) */
	skipPaths?: string[];
}

/**
 * Service-to-service authentication middleware
 *
 * Validates:
 * 1. Service token matches expected value
 * 2. Tenant context signature is valid
 * 3. Tenant context is not expired
 *
 * Sets in context:
 * - `tenant`: Verified TenantContext
 * - `requestId`: Request ID for tracing
 * - `sourceAgent`: Source agent ID
 *
 * @param options - Configuration options
 */
export function serviceAuth(
	options: ServiceAuthOptions = {},
): MiddlewareHandler {
	const expectedToken =
		options.serviceToken || process.env.AGENT_SERVICE_SECRET;
	const requireTenantContext = options.requireTenantContext ?? true;
	const skipPaths = options.skipPaths || [
		"/health",
		"/.well-known/agent.json",
	];

	return async (c: Context, next: Next) => {
		// Skip authentication for CORS preflight — browsers send OPTIONS
		// before the real request and won't include auth headers
		if (c.req.method === "OPTIONS") {
			return next();
		}

		// Skip authentication for allowed paths
		const path = new URL(c.req.url).pathname;
		if (
			skipPaths.some(
				(skip) => path === skip || path.startsWith(`${skip}/`),
			)
		) {
			return next();
		}

		// Validate service token
		if (!expectedToken) {
			console.error("[Security] AGENT_SERVICE_SECRET not configured");
			return c.json(
				{
					error: "SERVER_ERROR",
					message: "Agent security not configured",
				},
				500,
			);
		}

		const providedToken = extractServiceToken(c.req.raw.headers);

		if (!providedToken) {
			return c.json(
				{
					error: "UNAUTHORIZED",
					message: `Missing ${SECURITY_HEADERS.SERVICE_TOKEN} header`,
				},
				401,
			);
		}

		// Timing-safe comparison for service token
		if (!timingSafeCompare(providedToken, expectedToken)) {
			return c.json(
				{
					error: "UNAUTHORIZED",
					message: "Invalid service token",
				},
				401,
			);
		}

		// Extract and verify tenant context
		const signedContext = extractSignedContextFromHeaders(
			c.req.raw.headers,
		);

		if (!signedContext) {
			if (requireTenantContext) {
				return c.json(
					{
						error: "BAD_REQUEST",
						message: "Missing tenant context headers",
					},
					400,
				);
			}
			// Continue without tenant context if not required
			const reqId = extractRequestId(c.req.raw.headers);
			if (reqId) {
				c.set("requestId", reqId);
			}
			c.set("sourceAgent", extractSourceAgent(c.req.raw.headers));
			return next();
		}

		try {
			const tenant = verifyTenantContext(signedContext, expectedToken, {
				maxAge: options.maxContextAge,
			});

			c.set("tenant", tenant);
			const requestIdFromHeader = extractRequestId(c.req.raw.headers);
			if (requestIdFromHeader) {
				c.set("requestId", requestIdFromHeader);
			}
			c.set("sourceAgent", extractSourceAgent(c.req.raw.headers));

			return next();
		} catch (error) {
			if (error instanceof SignatureVerificationError) {
				return c.json(
					{
						error: "UNAUTHORIZED",
						message: `Tenant context verification failed: ${error.message}`,
					},
					401,
				);
			}
			throw error;
		}
	};
}

/**
 * Timing-safe string comparison to prevent timing attacks
 */
function timingSafeCompare(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}
