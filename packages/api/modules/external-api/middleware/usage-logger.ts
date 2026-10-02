/**
 * External API Usage Logging Middleware
 *
 * Logs every external API request for analytics (fire-and-forget).
 */

import { logExternalApiUsage } from "@repo/database";
import type { Context, Next } from "hono";
import type { ExternalApiContext, ExternalApiVariables } from "../types";

function usageKeyType(
	keyType: ExternalApiContext["keyType"],
): "USER" | "ORGANIZATION" | "OAUTH" {
	switch (keyType) {
		case "personal":
			return "USER";
		case "organization":
			return "ORGANIZATION";
		case "oauth":
			return "OAUTH";
		default: {
			const unreachable: never = keyType;
			return unreachable;
		}
	}
}

/**
 * Middleware that logs usage after the handler completes.
 * Runs fire-and-forget to avoid blocking responses.
 */
export function usageLogger() {
	return async (
		c: Context<{ Variables: ExternalApiVariables }>,
		next: Next,
	) => {
		const start = Date.now();
		await next();
		const latencyMs = Date.now() - start;

		const ctx = c.get("externalApiContext");
		if (!ctx) {
			return;
		}

		// Use the matched route pattern (e.g. "/agents/:instanceId") for low-cardinality analytics.
		// Falls back to the method + path if no route pattern is available.
		const endpoint = c.req.routePath || `${c.req.method} ${c.req.path}`;

		logExternalApiUsage({
			apiKeyType: usageKeyType(ctx.keyType),
			apiKeyId: ctx.keyId,
			apiKeyPrefix: ctx.keyPrefix,
			instanceId: c.req.param("instanceId") || undefined,
			deploymentId: c.get("deploymentId") ?? undefined,
			userId: ctx.userId,
			organizationId: ctx.organizationId,
			executionId: c.get("executionId") || undefined,
			endpoint,
			method: c.req.method,
			statusCode: c.res.status,
			latencyMs,
			clientIp: c.req.header("x-forwarded-for")?.split(",")[0]?.trim(),
			userAgent: c.req.header("user-agent"),
		}).catch(() => {
			// Swallow errors — usage logging should never break the API
		});
	};
}
