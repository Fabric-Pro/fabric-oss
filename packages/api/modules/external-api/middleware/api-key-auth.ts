/**
 * API Key Authentication Middleware
 *
 * Validates both personal (fab_*) and organization (org_*) API keys,
 * resolves tenant context, checks scopes, and injects ExternalApiContext.
 */

import { createHash } from "node:crypto";
import {
	canExecuteOrganizationAgents,
	canRunOrganizationWorkflows,
	verifyOrganizationApiKey,
} from "@repo/database";
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
 * Scopes that need a second, live check against the owner's organization role.
 *
 * A scope is escalation-prone when the permission behind it sits ABOVE the role
 * of the person who minted the key. There is no longer a floor to measure that
 * against: `ORG_API_KEYS_CREATE` sits in the VIEWER set, so every role may mint
 * a key (Fizzy #2457, moving what Fizzy #2380 had put at member-and-up). Read
 * "above the minting floor" anywhere near this file as stale.
 *
 * Two things keep the surface safe in its place, and neither is a role floor:
 *
 *   - `READ_ONLY_ORG_API_KEY_SCOPES` in
 *     `organizations/procedures/api-keys/create.ts` is a positive allow-list. A
 *     viewer may put only the scopes ON that list onto a key, so the scopes
 *     that sit above the viewer role — `agents:execute` among them — cannot be
 *     minted by somebody who does not already hold them. It is a
 *     creation-time clamp against the role held at creation time.
 *   - `verifyOrganizationApiKey` re-reads the creator's membership on EVERY
 *     request and returns null when it is gone, so an offboarded creator's key
 *     stops working at their next call rather than when a human notices.
 *
 * What neither covers is a demotion that keeps the membership row: a member who
 * mints `agents:execute` and is demoted to viewer still holds a key carrying a
 * scope their role no longer backs. That is exactly the gap this map closes,
 * and `agents:execute` is the one entry that qualifies on this surface —
 * `AGENT_EXECUTE` is member-and-up, so the scope outlives the access.
 *
 * `agents:read` and `agents:stream` are deliberately absent. Their permissions
 * sit in the viewer set, which every role holds, so a gate there could refuse
 * nobody. Nor is the org-wide reach of those reads an escalation: the in-app
 * agents list filters on the organization alone, with no creator filter, so a
 * key sees exactly what its owner sees in the browser.
 */
const OWNER_PERMISSION_GATES: Record<
	string,
	(userId: string, organizationId: string) => Promise<boolean>
> = {
	"agents:execute": canExecuteOrganizationAgents,
	// The in-app start requires WORKSPACE_UPDATE, which the viewer role does
	// not hold. A key minted by a member kept triggering workflows — runs
	// that execute externally mutating nodes — after its owner was demoted,
	// and a `*` key minted before the demotion did the same.
	"workflows:run": canRunOrganizationWorkflows,
};

/**
 * Does the key's owner still hold the organization permission behind `scope`?
 *
 * Runs after — never instead of — the scope check, and unconditionally once
 * that passes: `hasScope` answers true for a `*` key, so a gate that only fired
 * on the exact scope name would wave every wildcard key through.
 */
async function ownerStillHoldsScope(
	ctx: ExternalApiContext,
	scope: string,
): Promise<boolean> {
	const gate = OWNER_PERMISSION_GATES[scope];
	if (!gate) {
		return true;
	}

	// A personal key names no organization, so there is no role to consult.
	// It resolves to the fail-closed null tenant on every procedure here and
	// so reaches no organization's agents at all; refusing it would invent a
	// boundary rather than enforce one.
	if (!ctx.organizationId) {
		return true;
	}

	return gate(ctx.userId, ctx.organizationId);
}

/**
 * 403 for a key whose scope is present but whose owner no longer holds the
 * access behind it. Distinct from the missing-scope refusal on purpose: the
 * credential is exactly as it was minted, the person's role changed, and
 * re-minting the key would not help.
 */
function ownerPermissionRefusal(c: Context, scope: string) {
	return c.json(
		{
			error: `The key's owner no longer holds the access required for ${scope} in this organization`,
		},
		403,
	);
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

		if (
			requiredScope &&
			!(await ownerStillHoldsScope(ctx, requiredScope))
		) {
			return ownerPermissionRefusal(c, requiredScope);
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

		if (!(await ownerStillHoldsScope(ctx, scope))) {
			return ownerPermissionRefusal(c, scope);
		}

		await next();
	};
}
