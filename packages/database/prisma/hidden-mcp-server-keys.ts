/**
 * System MCP servers hidden from catalogues and new configuration.
 * Existing configurations and runtime tool resolution remain active.
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
