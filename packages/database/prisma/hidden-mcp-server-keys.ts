/**
 * System MCP servers hidden from catalogues and new configuration.
 * Existing configurations and runtime tool resolution remain active.
 */
export const HIDDEN_SYSTEM_MCP_SERVER_KEYS = [
	"sequential-thinking",
	"memory",
	"fetch",
	"time",
	"sqlite",
	"raycast",
	"e2b",
	"obsidian",
	"puppeteer",
	"todoist",
	"twilio",
	"turso",
	"axiom",
	"upstash",
	"neon",
	"resend",
	"browserbase",
	"google-maps",
	"airtable",
	"brave-search",
	"everything",
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
