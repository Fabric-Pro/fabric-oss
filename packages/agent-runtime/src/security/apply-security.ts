/**
 * Security Application Helper
 *
 * Provides a convenient function to apply all security middleware to a Hono app.
 * This is the recommended way to secure agents in the Fabric platform.
 */

import type { Hono } from "hono";
import { type ServiceAuthOptions, serviceAuth } from "./middleware";

/**
 * Options for applying security to an agent
 */
export interface ApplySecurityOptions extends ServiceAuthOptions {
	/**
	 * Whether to enable CORS (default: true for development)
	 * In production, private networking typically handles this
	 */
	enableCors?: boolean;

	/**
	 * Allowed origins for CORS (default: ["http://localhost:*"])
	 */
	corsOrigins?: string[];

	/**
	 * Whether to log security events (default: true)
	 */
	logSecurityEvents?: boolean;
}

/**
 * Apply security middleware to a Hono app
 *
 * This function applies:
 * 1. Service token authentication
 * 2. Signed tenant context verification
 * 3. Optional CORS headers
 * 4. Security event logging
 *
 * Usage:
 * ```typescript
 * import { Hono } from "hono";
 * import { applySecurity } from "@repo/agent-runtime";
 *
 * const app = new Hono();
 * applySecurity(app, {
 *   skipPaths: ["/health", "/.well-known/agent.json", "/custom-public-path"],
 * });
 *
 * // Your routes here - tenant context available via c.get("tenant")
 * app.post("/a2a/send", async (c) => {
 *   const tenant = c.get("tenant");
 *   // ...
 * });
 * ```
 *
 * @param app - The Hono application
 * @param options - Security configuration options
 */
export function applySecurity<T extends Hono>(
	app: T,
	options: ApplySecurityOptions = {},
): T {
	const {
		enableCors = process.env.NODE_ENV !== "production",
		logSecurityEvents = true,
		...serviceAuthOptions
	} = options;

	// Apply CORS in development
	if (enableCors) {
		app.use("*", async (c, next) => {
			// Simple CORS for development
			c.res.headers.set("Access-Control-Allow-Origin", "*");
			c.res.headers.set(
				"Access-Control-Allow-Methods",
				"GET, POST, OPTIONS",
			);
			c.res.headers.set(
				"Access-Control-Allow-Headers",
				"Content-Type, Authorization, X-API-Key, X-Service-Token, X-Tenant-Payload, X-Tenant-Signature, X-Tenant-Timestamp, X-Request-ID, X-Source-Agent",
			);

			if (c.req.method === "OPTIONS") {
				return new Response(null, { status: 204 });
			}

			return next();
		});
	}

	// Apply security logging
	if (logSecurityEvents) {
		app.use("*", async (c, next) => {
			const start = Date.now();
			const path = new URL(c.req.url).pathname;

			await next();

			const tenant = c.get("tenant");
			const sourceAgent = c.get("sourceAgent");
			const requestId = c.get("requestId");

			// Log security-relevant requests (skip health checks)
			if (!path.includes("/health") && !path.includes("/.well-known")) {
				console.log(
					`[Security] ${c.req.method} ${path} - ` +
						`tenant=${tenant?.userId || "anonymous"} ` +
						`org=${tenant?.organizationId || "none"} ` +
						`source=${sourceAgent || "unknown"} ` +
						`requestId=${requestId || "none"} ` +
						`duration=${Date.now() - start}ms ` +
						`status=${c.res.status}`,
				);
			}
		});
	}

	// Apply service authentication (validates service token + tenant context)
	app.use("*", serviceAuth(serviceAuthOptions));

	return app;
}

/**
 * Check if security is properly configured
 *
 * Use this at agent startup to fail fast if security is misconfigured.
 */
export function validateSecurityConfig(): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		errors.push("AGENT_SERVICE_SECRET environment variable is not set");
	} else if (secret.length < 32) {
		errors.push("AGENT_SERVICE_SECRET must be at least 32 characters long");
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}
