/**
 * Request Correlation ID Middleware
 *
 * Provides request tracing across services by:
 * - Generating unique correlation IDs for each request
 * - Propagating existing IDs from upstream services
 * - Adding IDs to response headers for debugging
 * - Making IDs available in request context for logging
 *
 * Standard headers:
 * - X-Correlation-ID: Primary correlation header
 * - X-Request-ID: Alternative header (fallback)
 */

// Import shared primitives via subpath to avoid pulling node:async_hooks into client bundles
import {
	generateCorrelationId,
	getCorrelationIdFromContext,
	runWithCorrelationId,
} from "@repo/utils/correlation-id";
import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";

// Re-export for backward compatibility
export {
	generateCorrelationId,
	getCorrelationIdFromContext,
	runWithCorrelationId,
};

// Standard header names for correlation IDs
const CORRELATION_HEADERS = [
	"x-correlation-id",
	"x-request-id",
	"x-trace-id",
	"traceparent", // W3C Trace Context
] as const;

// Response header name
const RESPONSE_HEADER = "X-Correlation-ID";

/**
 * Extract correlation ID from request headers
 * Checks multiple common headers
 */
export function extractCorrelationId(headers: Headers): string | null {
	for (const headerName of CORRELATION_HEADERS) {
		const value = headers.get(headerName);
		if (value) {
			// For traceparent (W3C format), extract the trace-id portion
			// Format: version-trace_id-parent_id-flags
			if (headerName === "traceparent" && value.includes("-")) {
				const parts = value.split("-");
				if (parts.length >= 2) {
					return parts[1];
				}
			}
			return value;
		}
	}
	return null;
}

/**
 * Correlation ID middleware for Hono
 * Adds correlation ID to context and response headers
 */
export const correlationIdMiddleware = createMiddleware(
	async (c: Context, next: Next) => {
		// Try to extract existing correlation ID from request
		let correlationId = extractCorrelationId(c.req.raw.headers);

		// Generate new ID if not provided
		if (!correlationId) {
			correlationId = generateCorrelationId();
		}

		// Store in context for downstream use
		c.set("correlationId", correlationId);

		// Add to response headers
		c.header(RESPONSE_HEADER, correlationId);

		// Continue processing
		await next();
	},
);

/**
 * Context type augmentation for correlation ID
 */
declare module "hono" {
	interface ContextVariableMap {
		correlationId: string;
	}
}

/**
 * Create headers with correlation ID for outbound requests
 * Useful when calling external services
 */
export function getCorrelationHeaders(
	correlationId?: string,
): Record<string, string> {
	const id =
		correlationId ||
		getCorrelationIdFromContext() ||
		generateCorrelationId();
	return {
		"X-Correlation-ID": id,
	};
}

/**
 * Middleware that wraps handlers with async local storage context
 * This allows getting correlation ID anywhere in the call stack
 */
export const asyncCorrelationMiddleware = createMiddleware(
	async (c: Context, next: Next) => {
		const correlationId = c.get("correlationId") || generateCorrelationId();

		// Run the rest of the middleware chain with correlation context
		await runWithCorrelationId(correlationId, async () => {
			await next();
		});
	},
);
