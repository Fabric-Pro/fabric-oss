/**
 * Error Handler Middleware
 *
 * Standardized error handling for agents with consistent error responses
 * and logging.
 */

import type { Context, ErrorHandler } from "hono";
import type { AgentErrorResponse } from "../types";
import { getAgentId, getRequestId } from "./request-context";

/**
 * Known error types that map to specific HTTP status codes
 */
const ERROR_STATUS_MAP: Record<string, number> = {
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	BAD_REQUEST: 400,
	RATE_LIMITED: 429,
	MODEL_ERROR: 502,
	INTERNAL_ERROR: 500,
};

/**
 * Agent error class for typed error handling
 */
export class AgentError extends Error {
	constructor(
		public readonly type: AgentErrorResponse["error"],
		message: string,
		public readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "AgentError";
	}
}

/**
 * Create an agent error response
 */
function createErrorResponse(
	c: Context,
	type: AgentErrorResponse["error"],
	message: string,
	details?: Record<string, unknown>,
): AgentErrorResponse {
	return {
		error: type,
		message,
		details,
		requestId: getRequestId(c),
	};
}

/**
 * Error handler for agents
 *
 * Converts errors to standardized AgentErrorResponse format.
 */
export function agentErrorHandler(): ErrorHandler {
	return (err, c) => {
		const requestId = getRequestId(c);
		const agentId = getAgentId(c);

		// Log the error
		console.error(
			`[${agentId}] Error processing request ${requestId}:`,
			err,
		);

		// Handle AgentError specifically
		if (err instanceof AgentError) {
			const status = ERROR_STATUS_MAP[err.type] || 500;
			return c.json(
				createErrorResponse(c, err.type, err.message, err.details),
				status as any,
			);
		}

		// Handle Zod validation errors
		if (err.name === "ZodError") {
			return c.json(
				createErrorResponse(c, "BAD_REQUEST", "Validation error", {
					issues: (err as any).issues,
				}),
				400,
			);
		}

		// Handle other known error types
		if (err.message?.includes("API key")) {
			return c.json(
				createErrorResponse(c, "UNAUTHORIZED", err.message),
				401,
			);
		}

		if (err.message?.includes("rate limit")) {
			return c.json(
				createErrorResponse(c, "RATE_LIMITED", "Rate limit exceeded"),
				429,
			);
		}

		// Default to internal error
		return c.json(
			createErrorResponse(
				c,
				"INTERNAL_ERROR",
				process.env.NODE_ENV === "production"
					? "An internal error occurred"
					: err.message,
			),
			500,
		);
	};
}

/**
 * Helper to throw a typed agent error
 */
export function throwAgentError(
	type: AgentErrorResponse["error"],
	message: string,
	details?: Record<string, unknown>,
): never {
	throw new AgentError(type, message, details);
}
