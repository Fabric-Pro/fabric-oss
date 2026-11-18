/**
 * System MCP servers hidden from catalogues and new configuration.
 * Existing configurations remain visible for management.
 */
import { RETIRED_SYSTEM_MCP_SERVER_KEYS } from "./curated-mcp-server-keys";

export const HIDDEN_SYSTEM_MCP_SERVER_KEYS = [
	...RETIRED_SYSTEM_MCP_SERVER_KEYS,
	"sequential-thinking",
	"memory",
	"todoist",
	"axiom",
	"neon",
	"airtable",
	"brave-search",
	"everything",
	"fabric",
] as const;

const HIDDEN_KEY_SET: ReadonlySet<string> = new Set(
	HIDDEN_SYSTEM_MCP_SERVER_KEYS,
);

export function isHiddenSystemMcpServerKey(
	key: string | null | undefined,
): boolean {
	return !!key && HIDDEN_KEY_SET.has(key);
}

export function withoutHiddenSystemMcpServers<
	T extends { key: string; isSystemProvided: boolean },
>(servers: T[]): T[] {
	return servers.filter(
		(s) => !(s.isSystemProvided && isHiddenSystemMcpServerKey(s.key)),
	);
}

/**
 * Retired system keys covered by the client's STDIO refusal. The wrapper
 * accepts pinned catalog commands, so retired commands are refused even if
 * their packages are still published. Callers apply this check to STDIO.
 */
export const UNRUNNABLE_SYSTEM_MCP_SERVER_KEYS = RETIRED_SYSTEM_MCP_SERVER_KEYS;

const UNRUNNABLE_KEY_SET: ReadonlySet<string> = new Set(
	UNRUNNABLE_SYSTEM_MCP_SERVER_KEYS,
);

export function isUnrunnableSystemMcpServer(
	server:
		| { key?: string | null; isSystemProvided?: boolean | null }
		| null
		| undefined,
): boolean {
	return !!(
		server?.isSystemProvided &&
		server.key &&
		UNRUNNABLE_KEY_SET.has(server.key)
	);
}
