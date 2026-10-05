/**
 * What a signed-in coding agent may be granted, and where it may use it.
 *
 * This is the same ceiling the Connect dialog's "coding instructions" API key
 * carries: read, and propose changes that are held for review. Nothing here
 * publishes, writes MCP tools or acts as a wildcard — those stay behind an
 * organization API key an administrator minted on purpose, and an agent can
 * never be registered with them (`clientRegistrationAllowedScopes`).
 *
 * Pure constants, and no import that reaches a server: the consent page, the
 * gateway and the CLI all read them, and none should pull in the auth server to
 * do it.
 */

import {
	buildProjectResource,
	OAUTH_API_RESOURCE_PATH,
	OAUTH_GATEWAY_RESOURCE_PATH,
} from "@repo/utils/oauth-project-resource";

const OAUTH_SCOPE_MCP_READ = "mcp:read";
const OAUTH_SCOPE_INSTRUCTIONS_READ = "instructions:read";
const OAUTH_SCOPE_INSTRUCTIONS_WRITE = "instructions:write";
const OAUTH_SCOPE_OFFLINE_ACCESS = "offline_access";

export const OAUTH_SCOPES = [
	OAUTH_SCOPE_MCP_READ,
	OAUTH_SCOPE_INSTRUCTIONS_READ,
	OAUTH_SCOPE_INSTRUCTIONS_WRITE,
	OAUTH_SCOPE_OFFLINE_ACCESS,
] as const;

export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export function isOAuthScope(value: string): value is OAuthScope {
	return (OAUTH_SCOPES as readonly string[]).includes(value);
}

/** Path of the authorization server, relative to the app origin. */
export const OAUTH_ISSUER_PATH = "/api/auth";

/**
 * Set by the organization page once the person has chosen, to the
 * authorization's `code_challenge`, so the authorization server stops asking
 * for that one authorization (see `needsOrganizationChoice`).
 */
export const OAUTH_ORGANIZATION_CHOSEN_COOKIE =
	"fabric_oauth_organization_chosen";

/** Where the protected-resource metadata of the gateway is served (RFC 9728). */
const OAUTH_GATEWAY_METADATA_PATH = `/.well-known/oauth-protected-resource${OAUTH_GATEWAY_RESOURCE_PATH}`;

function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

/**
 * The resource identifiers the token endpoint accepts in `resource=`. The
 * gateway is accepted with and without a trailing slash because clients
 * canonicalize the URL they were given differently.
 */
export function oauthValidAudiences(appUrl: string): string[] {
	const origin = trimTrailingSlash(appUrl);
	return [
		`${origin}${OAUTH_GATEWAY_RESOURCE_PATH}`,
		`${origin}${OAUTH_GATEWAY_RESOURCE_PATH}/`,
		`${origin}${OAUTH_API_RESOURCE_PATH}`,
	];
}

export function oauthIssuer(appUrl: string): string {
	return `${trimTrailingSlash(appUrl)}${OAUTH_ISSUER_PATH}`;
}

export function oauthGatewayMetadataUrl(appUrl: string): string {
	return `${trimTrailingSlash(appUrl)}${OAUTH_GATEWAY_METADATA_PATH}`;
}

/**
 * Where the protected-resource metadata of one project's gateway URL is served:
 * the project resource's path appended to the well-known prefix, as RFC 9728
 * path insertion has it.
 */
export function oauthProjectGatewayMetadataUrl(
	appUrl: string,
	projectId: string,
): string {
	const resource = new URL(buildProjectResource(appUrl, "mcp", projectId));
	return `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
}

/**
 * The challenge on every unauthenticated gateway answer. `resource_metadata`
 * is how an MCP client discovers it may sign in instead of pasting a key.
 *
 * A project URL names its own metadata, so a client that is refused there asks
 * for the project as `resource` when it signs in again. `invalidToken` marks a
 * credential that was presented and does not fit this URL, which RFC 6750 has
 * a client treat as "sign in again" rather than "sign in".
 */
export function gatewayAuthenticateHeader(
	appUrl: string,
	options: { projectId?: string; invalidToken?: boolean } = {},
): string {
	const metadataUrl = options.projectId
		? oauthProjectGatewayMetadataUrl(appUrl, options.projectId)
		: oauthGatewayMetadataUrl(appUrl);
	const error = options.invalidToken ? `error="invalid_token", ` : "";
	return `Bearer ${error}resource_metadata="${metadataUrl}", scope="${OAUTH_SCOPES.join(" ")}"`;
}
