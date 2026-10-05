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
	/**
	 * Set for an OAuth token that reaches one project: that project. Such a
	 * credential is bound to the project and to the organization hosting it.
	 * `requireApiKey` lets it reach only the routes of `projectBoundRouteAllowed`,
	 * and those ask {@link credentialMayReachProject} again before they read or
	 * write anything of a project.
	 */
	boundProjectId?: string;
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
 * Whether this credential may act on `projectId`. Only an OAuth token bound to
 * one project says no, and then for every project but its own. Callers answer
 * `false` as they answer a project that does not exist, never as a refusal that
 * says the project is there.
 */
export function credentialMayReachProject(
	ctx: Pick<ExternalApiContext, "boundProjectId">,
	projectId: string,
): boolean {
	return ctx.boundProjectId === undefined || ctx.boundProjectId === projectId;
}

/**
 * Hono variable declarations for type-safe context access.
 */
export type ExternalApiVariables = {
	externalApiContext: ExternalApiContext;
	executionId?: string;
	deploymentId?: string;
};
