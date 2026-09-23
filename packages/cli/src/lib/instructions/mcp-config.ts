/**
 * A bounded, read-only reader for a checkout's `.mcp.json`.
 *
 * The Claude Code project format: `{ "mcpServers": { "<name>": entry } }`,
 * where an entry is a local process (`command`, `args`, `env`) or a remote
 * server (`url`, `type`, `headers`). `fabric instructions doctor` wants to
 * know, per server, whether the thing it names can be reached — and nothing
 * else. So this keeps the server's key, its `command` or its `url`, and drops
 * every other field on the floor: `env` and `headers` are where credentials
 * live, and a value that is never held cannot be printed by mistake.
 *
 * Every failure reason is content-free. A parse error says "not valid JSON",
 * never the parser's message (which quotes the input), and never the path the
 * guarded reader refused.
 */
import { sanitizeDisplayText } from "./checks.js";
import { readFileSafely } from "./safe-write.js";

export const MCP_CONFIG_FILE = ".mcp.json";
const MCP_CONFIG_MAX_BYTES = 262_144;
const MCP_CONFIG_MAX_SERVERS = 50;

/** How much of a server key is shown. Keys are repository content. */
const MAX_SERVER_NAME_CHARS = 64;

export type McpServerEntry =
	| { name: string; kind: "command"; command: string }
	| { name: string; kind: "url"; url: string }
	| { name: string; kind: "invalid"; reason: string };

export type McpConfigRead =
	| { state: "absent" }
	| { state: "invalid"; reason: string }
	| { state: "ok"; servers: McpServerEntry[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the text of a `.mcp.json`. Pure; `readMcpConfig` supplies the bounded bytes. */
function parseMcpConfig(text: string): McpConfigRead {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { state: "invalid", reason: "not valid JSON" };
	}
	if (!isRecord(parsed)) {
		return { state: "invalid", reason: "top level is not an object" };
	}
	if (parsed.mcpServers === undefined) {
		return { state: "ok", servers: [] };
	}
	if (!isRecord(parsed.mcpServers)) {
		return { state: "invalid", reason: "mcpServers is not an object" };
	}
	const keys = Object.keys(parsed.mcpServers);
	if (keys.length > MCP_CONFIG_MAX_SERVERS) {
		return {
			state: "invalid",
			reason: `mcpServers has more than ${MCP_CONFIG_MAX_SERVERS} entries`,
		};
	}
	const servers: McpServerEntry[] = keys.map((key) => {
		const name = sanitizeDisplayText(key, MAX_SERVER_NAME_CHARS);
		const entry = (parsed.mcpServers as Record<string, unknown>)[key];
		if (!isRecord(entry)) {
			return { name, kind: "invalid", reason: "entry is not an object" };
		}
		if (entry.command !== undefined) {
			if (
				typeof entry.command !== "string" ||
				entry.command.length === 0
			) {
				return {
					name,
					kind: "invalid",
					reason: "command is not a non-empty string",
				};
			}
			return { name, kind: "command", command: entry.command };
		}
		if (entry.url !== undefined) {
			if (typeof entry.url !== "string" || entry.url.length === 0) {
				return {
					name,
					kind: "invalid",
					reason: "url is not a non-empty string",
				};
			}
			return { name, kind: "url", url: entry.url };
		}
		return {
			name,
			kind: "invalid",
			reason: "entry has neither a command nor a url",
		};
	});
	return { state: "ok", servers };
}

/**
 * Read `<root>/.mcp.json` through the guarded reader: bounded, refusing a
 * symlinked component, and refusing anything but a regular file.
 */
export async function readMcpConfig(root: string): Promise<McpConfigRead> {
	let read: Awaited<ReturnType<typeof readFileSafely>>;
	try {
		read = await readFileSafely(root, MCP_CONFIG_FILE, {
			maxBytes: MCP_CONFIG_MAX_BYTES,
		});
	} catch (error) {
		return {
			state: "invalid",
			reason: isTooLarge(error)
				? `file is larger than ${MCP_CONFIG_MAX_BYTES} bytes`
				: "file could not be read safely (a symlink, or not a regular file)",
		};
	}
	if (read === null) {
		return { state: "absent" };
	}
	return parseMcpConfig(new TextDecoder().decode(read.bytes));
}

/**
 * `readFileSafely`'s size refusal, told apart from its other refusals so the
 * report can say which limit was hit. Matched on the guard's own wording;
 * the oversize cases in `doctor-command.test.ts` fail if that wording moves.
 */
export function isTooLarge(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes("too large to read safely")
	);
}
