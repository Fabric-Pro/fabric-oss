/**
 * Request Context Middleware
 *
 * Provides request-level context including unique request ID,
 * timing information, and correlation data for observability.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { v4 as uuidv4 } from "uuid";

// Extend Hono's context types
declare module "hono" {
	interface ContextVariableMap {
		requestId: string;
		requestStartTime: number;
		agentId: string;
	}
}

/**
 * Request context options
 */
export interface RequestContextOptions {
	/** Agent ID to set in context */
	agentId: string;
	/** Header name for request ID (default: X-Request-ID) */
	requestIdHeader?: string;
	/** Whether to generate request ID if not provided (default: true) */
	generateRequestId?: boolean;
}

/**
 * Request context middleware
 *
 * Extracts or generates request ID and sets up request-level context
 * for logging and observability.
 */
export function requestContext(
	options: RequestContextOptions,
): MiddlewareHandler {
	const {
		agentId,
		requestIdHeader = "X-Request-ID",
		generateRequestId = true,
	} = options;

	return async (c: Context, next: Next) => {
		// Get or generate request ID
		let requestId = c.req.header(requestIdHeader);
		if (!requestId && generateRequestId) {
			requestId = uuidv4();
		}

		// Set context variables
		c.set("requestId", requestId || "unknown");
		c.set("requestStartTime", Date.now());
		c.set("agentId", agentId);

		// Set response header for correlation
		if (requestId) {
			c.header(requestIdHeader, requestId);
		}

		await next();
	};
}

/**
 * Get the duration since request start in milliseconds
 */
export function getRequestDuration(c: Context): number {
	const startTime = c.get("requestStartTime");
	if (!startTime) {
		return 0;
	}
	return Date.now() - startTime;
}

/**
 * Get request ID from context
 */
export function getRequestId(c: Context): string {
	return c.get("requestId") || "unknown";
}

/**
 * Get agent ID from context
 */
export function getAgentId(c: Context): string {
	return c.get("agentId") || "unknown";
}

/**
 * Build standard response metadata
 */
export function buildResponseMetadata(
	c: Context,
	additional?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		requestId: getRequestId(c),
		agentId: getAgentId(c),
		durationMs: getRequestDuration(c),
		...additional,
	};
}
