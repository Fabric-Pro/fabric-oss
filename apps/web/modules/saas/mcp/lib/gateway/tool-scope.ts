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
 * workflow and frame tools its chat engines expose. A session opened with the
 * service credential holds exactly these, so a leaked agent secret cannot be
 * turned into a way to read projects, documents or connected servers.
 */
export const SERVICE_CREDENTIAL_SCOPES: readonly string[] = [
	"workflows:read",
	"workflows:write",
	"workflows:run",
	"frames:read",
	"frames:write",
];

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
