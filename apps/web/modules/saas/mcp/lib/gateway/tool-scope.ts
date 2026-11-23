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
	"workspaces:read",
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
 * The most a service session whose grant names a project may hold, whatever
 * the grant names. It is every scope the portal tools and the runtime's
 * workflow and frame tools need and nothing beyond: never `mcp:write` (which
 * is what requesting or revoking delegated authority and calling a connected
 * server's changes need), never `chats:read` (a meeting is not given the
 * inviter's chats) and never a wildcard. `mcp:read` is in the base set and
 * satisfies any read, so what holds a session to its tools is the named list
 * in `./project-binding`, not the scope.
 */
export const SERVICE_GRANT_MAX_SCOPES: readonly string[] = [
	"orgs:read",
	"mcp:read",
	"projects:read",
	"projects:write",
	"features:read",
	"features:write",
	"instructions:read",
	"instructions:write",
	"workspaces:read",
	"workflows:write",
	"workflows:run",
	"frames:write",
];

/**
 * The scopes a service session holds. A chat grant, which names no project,
 * holds the base set exactly. A grant that names a project holds the base
 * set's reads plus the grant's own scopes within the ceiling, so a grant that
 * names only reads (a meeting's live turn) can change nothing, workflows and
 * frames included. Scopes on a grant without a project add nothing.
 */
export function serviceSessionScopes(grant: {
	scopes?: readonly string[];
	projectId?: string;
}): string[] {
	if (!grant.projectId) {
		return [...SERVICE_CREDENTIAL_SCOPES];
	}
	const reads = SERVICE_CREDENTIAL_SCOPES.filter((scope) =>
		scope.endsWith(":read"),
	);
	const granted = (grant.scopes ?? []).filter((scope) =>
		SERVICE_GRANT_MAX_SCOPES.includes(scope),
	);
	return [...new Set([...reads, ...granted])];
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
	granted: readonly string[],
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
	// Allow OAuth agents holding mcp:read to request/revoke runtime authority
	// and reach connected-server write tools (which remain gated by enforceAuthority
	// requiring explicit human approval in the Fabric UI).
	if (
		credential === "oauth" &&
		required.scope === "mcp:write" &&
		granted.includes("mcp:read")
	) {
		return true;
	}
	return required.kind === "read" && granted.includes("mcp:read");
}
