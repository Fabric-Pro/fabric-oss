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
	/** Whether this is a personal or organization API key */
	keyType: "personal" | "organization";
	/** Database ID of the API key record */
	keyId: string;
	/** Key prefix for logging (e.g., "fab_abc1" or "org_def2") */
	keyPrefix: string;
	/** User ID — for personal keys: key owner; for org keys: key creator */
	userId: string;
	/** Organization ID — only set for organization API keys */
	organizationId: string | undefined;
	/** Scopes granted to this API key */
	scopes: string[];
}

/**
 * Hono variable declarations for type-safe context access.
 */
export type ExternalApiVariables = {
	externalApiContext: ExternalApiContext;
	executionId?: string;
	deploymentId?: string;
};
