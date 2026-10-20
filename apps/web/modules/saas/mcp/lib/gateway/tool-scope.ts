/**
 * Which granted scopes satisfy the scope a tool requires.
 *
 * Kept apart from the tool table so the connected-server path in the endpoint
 * can ask the same question without importing every platform handler.
 */

import type { GatewayCredential } from "./types";

export type ToolScope = { scope: string; kind: "read" | "write" };

/**
 * The most Fabric's own agent runtime may reach through the gateway: the
 * workflow, frame and selected project/instruction reads its chat engines
 * expose. The named service allowlist in project-binding also gates listing
 * and execution: mcp:read does not grant the other portal reads or a connected
 * server proxy. Every call still requires a valid acting grant.
 */
export const SERVICE_CREDENTIAL_SCOPES: readonly string[] = [
	"workflows:read",
	"workflows:write",
	"workflows:run",
	"frames:read",
	"frames:write",
	"projects:read",
	"instructions:read",
	"mcp:read",
];

/**
 * The most a service session may hold beyond the base set, whatever its grant
 * names, and only when the grant also names the one project they are for. It
 * is every scope the portal tools need and nothing beyond: never `mcp:write`
 * (which is what requesting or revoking delegated authority and calling a
 * connected server's changes need) and never a wildcard. `mcp:read` is there
 * for `fabric_list_connected_servers` and satisfies any read, so what holds a
 * session to its tools is the named list in `./project-binding`, not the scope.
 */
export const SERVICE_GRANT_MAX_SCOPES: readonly string[] = [
	"orgs:read",
	"chats:read",
	"mcp:read",
	"projects:read",
	"projects:write",
	"features:read",
	"features:write",
	"instructions:read",
	"instructions:write",
	"workspaces:read",
];

/**
 * The scopes a service session holds: the base set, plus the grant's scopes
 * that are within the ceiling, and the latter only for a grant that names a
 * project. A grant with scopes and no project, or with scopes outside the
 * ceiling, is held to what is within it, and a chat grant (neither) to the base
 * set exactly.
 */
export function serviceSessionScopes(grant: {
	scopes?: readonly string[];
	projectId?: string;
}): string[] {
	const extra =
		grant.projectId && grant.scopes
			? grant.scopes.filter((scope) =>
					SERVICE_GRANT_MAX_SCOPES.includes(scope),
				)
			: [];
	return [...new Set([...SERVICE_CREDENTIAL_SCOPES, ...extra])];
}

/** What a scope refusal calls the caller, so the message names what it holds. */
export function credentialSubject(credential: GatewayCredential): string {
	switch (credential) {
		case "oauth":
			return "signed-in agent";
		case "service":
			return "agent runtime";
		case "organization-key":
		case "personal-key":
		case "session":
			return "API key";
		default: {
			const unreachable: never = credential;
			return unreachable;
		}
	}
}

/** Scope families that hold the person's own data rather than the organization's. */
const PERSONAL_SCOPE_PREFIXES = ["chats:"];

/**
 * An OAuth sign-in is consented to in terms of "this organization's projects
 * and context". A person's own AI chats are not that, so no umbrella reaches
 * them through an OAuth credential; only the exact scope would, and the
 * authorization server issues none.
 */
function reachesPersonalData(required: ToolScope): boolean {
	return PERSONAL_SCOPE_PREFIXES.some((prefix) =>
		required.scope.startsWith(prefix),
	);
}

export function scopeSatisfied(
	granted: string[],
	required: ToolScope,
	credential: GatewayCredential,
): boolean {
	if (credential === "oauth" && reachesPersonalData(required)) {
		return granted.includes(required.scope);
	}
	if (granted.includes("*") || granted.includes(required.scope)) {
		return true;
	}
	if (granted.includes("mcp:write")) {
		return true;
	}
	return required.kind === "read" && granted.includes("mcp:read");
}
