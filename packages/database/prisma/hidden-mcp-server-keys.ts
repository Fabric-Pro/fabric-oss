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

/**
 * Retired system servers that can never start (Fizzy #3531).
 *
 * Their commands name npm packages that were never published: the reference
 * Fetch, Time and SQLite servers are Python packages, so `npx` asks the
 * registry, gets a 404 and exits, every time a connection to one is used.
 * Retiring them (#3108) stopped new connections; this stops the ones that
 * already existed from being started at all.
 *
 * Raycast, Notion, Vercel, Turso and Asana were retired with the same kind of
 * command (`npx -y @raycast/mcp-server`, `@modelcontextprotocol/server-notion`,
 * `@vercel/mcp`, `@turso/mcp-server`, `@asana/mcp-server`), and the npm
 * registry answers 404 for each of those names. Retired servers whose package
 * is still published, such as puppeteer, keep starting.
 *
 * Browserbase was first seeded as `@browserbase/mcp-server` (404) and later as
 * `@browserbasehq/mcp@3.0.0`, which is published but reads both
 * BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID; a STDIO connection carries
 * one key, so neither command can start.
 *
 * Google Maps (`@modelcontextprotocol/server-google-maps`) exits at startup
 * unless GOOGLE_MAPS_API_KEY is set, and its key is passed as API_KEY, so it
 * cannot start whatever the connection holds (Fizzy #3457).
 */
export const UNRUNNABLE_SYSTEM_MCP_SERVER_KEYS = [
	"fetch",
	"time",
	"sqlite",
	"raycast",
	"notion",
	"vercel",
	"turso",
	"asana",
	"browserbase",
	"google-maps",
] as const;

/**
 * Retired system servers that start only when the connection supplies their
 * command-line arguments (Fizzy #3457). Their commands were seeded bare and the
 * MCP Settings form collects arguments for Azure DevOps alone, so a connection
 * without them exits at startup on every call:
 *
 * - `@modelcontextprotocol/server-postgres` reads the database URL from argv
 *   only ("Please provide a database URL as a command-line argument"), seen
 *   exiting in production in October 2026;
 * - `mcp-obsidian` needs the vault directory (`Usage: mcp-obsidian
 *   <vault-directory>`);
 * - `@upstash/mcp-server` needs an email and an API key (`run <email> <key>`
 *   or its own variables, neither of which the API_KEY it is given provides).
 *
 * A connection created through the API with those arguments keeps starting.
 */
export const ARGUMENT_REQUIRED_SYSTEM_MCP_SERVER_KEYS = [
	"postgres",
	"obsidian",
	"upstash",
] as const;

const UNRUNNABLE_KEY_SET: ReadonlySet<string> = new Set(
	UNRUNNABLE_SYSTEM_MCP_SERVER_KEYS,
);
const ARGUMENT_REQUIRED_KEY_SET: ReadonlySet<string> = new Set(
	ARGUMENT_REQUIRED_SYSTEM_MCP_SERVER_KEYS,
);

/**
 * A system server whose command cannot start, so no connection to it may.
 * `commandArgs` are the connection's own arguments; a server that needs them
 * is unrunnable only when there are none.
 */
export function isUnrunnableSystemMcpServer(
	server:
		| { key?: string | null; isSystemProvided?: boolean | null }
		| null
		| undefined,
	commandArgs?: readonly string[] | null,
): boolean {
	if (!server?.isSystemProvided || !server.key) {
		return false;
	}
	if (UNRUNNABLE_KEY_SET.has(server.key)) {
		return true;
	}
	return (
		ARGUMENT_REQUIRED_KEY_SET.has(server.key) &&
		!commandArgs?.some((arg) => arg.trim() !== "")
	);
}
