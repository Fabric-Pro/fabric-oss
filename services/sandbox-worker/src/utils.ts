/**
 * Utility functions for Fabric Sandbox Worker
 */

import type { ApiError, ApiResponse } from "./types";

/**
 * CORS headers with a fail-closed default (SOC 2 CC7.1). The sandbox worker is
 * called server-to-server (X-Agent-Key, no browser Origin), so omitting a
 * wildcard `Access-Control-Allow-Origin` in production doesn't affect real
 * traffic — it just stops advertising an open CORS surface. Set
 * `CORS_ALLOWED_ORIGINS` to allow a specific browser origin; dev defaults to
 * "*" for convenience.
 */
function corsHeaders(
	base: Record<string, string> = {},
): Record<string, string> {
	const configured = process.env.CORS_ALLOWED_ORIGINS?.split(",")[0]?.trim();
	const origin =
		configured ?? (process.env.NODE_ENV === "production" ? null : "*");
	const headers: Record<string, string> = { ...base };
	if (origin) {
		headers["Access-Control-Allow-Origin"] = origin;
		headers["Access-Control-Allow-Methods"] =
			"GET, POST, PUT, DELETE, OPTIONS";
		headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
	}
	return headers;
}

/**
 * Create a JSON response with proper headers
 */
function jsonResponse<T>(data: ApiResponse<T>, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: corsHeaders({ "Content-Type": "application/json" }),
	});
}

/**
 * Create a success response
 */
export function successResponse<T>(data: T): Response {
	return jsonResponse({ success: true, data });
}

/**
 * Create an error response
 */
export function errorResponse(
	code: string,
	message: string,
	status = 400,
	details?: unknown,
): Response {
	const error: ApiError = { code, message };
	if (details) {
		error.details = details;
	}
	return jsonResponse({ success: false, error }, status);
}

/**
 * Handle CORS preflight requests
 */
export function corsResponse(): Response {
	return new Response(null, {
		status: 204,
		headers: corsHeaders({ "Access-Control-Max-Age": "86400" }),
	});
}

/**
 * Generate a unique session ID
 */
export function generateSessionId(): string {
	return `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Common git add exclusions for build artifacts
 */
export const GIT_ADD_EXCLUSIONS = [
	// Python
	":!**/__pycache__/**",
	":!*.pyc",
	":!*.pyo",
	":!**/.pytest_cache/**",
	":!**/*.egg-info/**",
	":!**/.mypy_cache/**",
	":!**/.ruff_cache/**",
	// Node
	":!**/node_modules/**",
	":!**/.next/**",
	":!**/dist/**",
	":!**/build/**",
	// Secrets/env files
	":!**/.env",
	":!**/.env.*",
	":!**/.dev.vars",
].join(" ");
