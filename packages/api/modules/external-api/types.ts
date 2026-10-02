/**
 * External API Types
 *
 * Shared type definitions for the external API gateway.
 */

/**
 * Context injected by the API key authentication middleware.
 * Available on all external API routes via `c.get("externalApiContext")`.
 */
export interface ExternalApiContext {
	/**
	 * Which credential proved the request: a personal key, an organization key,
	 * or an OAuth access token from a coding agent that signed in.
	 */
	keyType: "personal" | "organization" | "oauth";
	/**
	 * Database ID of the API key record; for an OAuth token, of the agent's
	 * `OauthClient` row, which outlives every token rotation.
	 */
	keyId: string;
	/** Key prefix for logging (e.g., "fab_abc1" or "org_def2") */
	keyPrefix: string;
	/** User ID — for personal keys: key owner; for org keys: key creator */
	userId: string;
	/** Organization ID — set for organization API keys and OAuth tokens */
	organizationId: string | undefined;
	/** Scopes granted to this API key */
	scopes: string[];
}

/**
 * Keys whose tenant is fixed when they are issued: an organization key's at
 * creation, an OAuth token's at consent. A request may not move them to another
 * organization, so every "which organization is this" decision asks this rather
 * than comparing against one key type.
 */
export function isOrganizationBoundKey(
	ctx: Pick<ExternalApiContext, "keyType">,
): boolean {
	return ctx.keyType === "organization" || ctx.keyType === "oauth";
}

/**
 * Hono variable declarations for type-safe context access.
 */
export type ExternalApiVariables = {
	externalApiContext: ExternalApiContext;
	executionId?: string;
	deploymentId?: string;
};
