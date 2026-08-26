/**
 * API Key Authentication Middleware
 *
 * Validates both personal (fab_*) and organization (org_*) API keys,
 * resolves tenant context, checks scopes, and injects ExternalApiContext.
 */

import { createHash } from "node:crypto";
import { verifyOrganizationApiKey } from "@repo/database";
import type { Context, Next } from "hono";
import { verifyUserApiKey } from "../../users/procedures/api-keys/verify";
import type { ExternalApiContext, ExternalApiVariables } from "../types";

/**
 * Check if an API key's scopes include the required scope.
 * Supports wildcard (*) scope for full access.
 */
function hasScope(scopes: string[], requiredScope: string): boolean {
	return scopes.includes(requiredScope) || scopes.includes("*");
}

/**
 * Middleware factory that validates API keys and injects ExternalApiContext.
 *
 * @param requiredScope - Optional scope to check (e.g., "agents:execute")
 */
export function requireApiKey(requiredScope?: string) {
	return async (
		c: Context<{ Variables: ExternalApiVariables }>,
		next: Next,
	) => {
		const authHeader = c.req.header("Authorization");
		if (!authHeader?.startsWith("Bearer ")) {
			return c.json(
				{
					error: "Missing or invalid Authorization header. Use: Bearer <api_key>",
				},
				401,
			);
		}

		const apiKey = authHeader.slice(7);
		const isUserKey = apiKey.startsWith("fab_");
		const isOrgKey = apiKey.startsWith("org_");

		if (!isUserKey && !isOrgKey) {
			return c.json(
				{
					error: "Invalid API key format. Keys must start with fab_ or org_",
				},
				401,
			);
		}

		let ctx: ExternalApiContext;

		if (isUserKey) {
			const result = await verifyUserApiKey(apiKey);
			if (
				!result.valid ||
				!result.keyId ||
				!result.userId ||
				!result.scopes
			) {
				return c.json(
					{ error: result.error || "Invalid API key" },
					401,
				);
			}

			if (requiredScope && !hasScope(result.scopes, requiredScope)) {
				return c.json(
					{ error: `Missing required scope: ${requiredScope}` },
					403,
				);
			}

			// Extract prefix from the key for logging (e.g. "fab_abc12...")
			const keyPrefix = `fab_${apiKey.split("_")[1]?.slice(0, 8) ?? "unknown"}`;

			ctx = {
				keyType: "personal",
				keyId: result.keyId,
				keyPrefix,
				userId: result.userId,
				organizationId: undefined,
				scopes: result.scopes,
			};
		} else {
			// org_ key — hash and verify
			const keyHash = createHash("sha256").update(apiKey).digest("hex");
			const result = await verifyOrganizationApiKey(keyHash);

			if (!result) {
				return c.json(
					{ error: "Invalid or expired organization API key" },
					401,
				);
			}

			if (requiredScope && !hasScope(result.scopes, requiredScope)) {
				return c.json(
					{ error: `Missing required scope: ${requiredScope}` },
					403,
				);
			}

			// Extract prefix from the key for logging (e.g. "org_abc12...")
			const keyPrefix = `org_${apiKey.split("_")[1]?.slice(0, 8) ?? "unknown"}`;

			ctx = {
				keyType: "organization",
				keyId: result.id,
				keyPrefix,
				userId: result.createdByUserId,
				organizationId: result.organizationId,
				scopes: result.scopes,
			};
		}

		c.set("externalApiContext", ctx);
		await next();
	};
}

/**
 * Middleware that checks a specific scope on the already-authenticated context.
 * Use this on individual routes after requireApiKey() has run.
 */
export function requireScope(scope: string) {
	return async (
		c: Context<{ Variables: ExternalApiVariables }>,
		next: Next,
	) => {
		const ctx = c.get("externalApiContext");
		if (!ctx) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		if (!hasScope(ctx.scopes, scope)) {
			return c.json({ error: `Missing required scope: ${scope}` }, 403);
		}

		await next();
	};
}
