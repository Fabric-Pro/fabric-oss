/**
 * What a coding tool's own configuration says about a project's Fabric MCP
 * server, read from its files and without running the tool.
 *
 * Two callers need it. `doctor` only reports, and runs nothing. `init` has to
 * know what is registered before it writes, and it must not ask the tool: Claude
 * Code's `mcp get` and `mcp list` health-check the servers they name, and in a
 * checkout one of them can be a project-scope `fabric` from the repository's own
 * `.mcp.json`, started before anyone has been asked to trust it. So both read
 * Claude Code's `.claude.json` (the checkout's local scope and the user scope)
 * and the checkout's `.mcp.json` as data, and Codex's `config.toml`.
 *
 * Every server's name and, when it has one, its address are taken from them;
 * nothing else in either file is kept or shown. A file that cannot be read, or that is written in a form
 * this reader does not understand, is an answer of its own and never an error:
 * the caller that is about to write refuses to, and the one that reports says so.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { InstructionsHookTool } from "./hook.js";

/**
 * The name Claude Code's server was given before every tool's server carried
 * the project's own name. One at this project's gateway under it still counts
 * as registered, and one at another Fabric gateway is this deployment's own to
 * replace.
 */
export const LEGACY_SERVER_NAME = "fabric";

export type RegistrationState =
	/** A server at the project's gateway URL is registered. */
	| "registered"
	/** Registered only under the older name `fabric`, which still works. */
	| "legacy"
	/** A server of that name is registered, at another URL. */
	| "elsewhere"
	| "missing"
	/** The tool's file exists and could not be used. */
	| "unreadable";

/** One coding tool's registration of the project's Fabric MCP server, as its configuration shows it. */
export interface AgentMcpFact {
	tool: InstructionsHookTool;
	/** The name `init` registers the server under. */
	name: string;
	state: RegistrationState;
	/** The line that registers it by hand, or `null` when the address cannot be written into one. */
	registerLine: string | null;
	/**
	 * The names, as they may be shown, of the servers the tool will use that
	 * point at this project's gateway: one is normal, several are duplicates.
	 */
	projectServers: string[];
	/** The names of the servers the tool will use that are the organization-wide gateway's. */
	orgWide: string[];
	/** A server of the name `init` uses is there, is not Fabric's, and is left alone. */
	foreignSameName: boolean;
}

export type ClaudeScope = "local" | "user" | "project";

/** A Claude Code server, in one scope. */
export interface ClaudeServer {
	name: string;
	scope: ClaudeScope;
	/** `null` for a server that has no URL, such as one that runs a command. */
	url: string | null;
}

/** A Codex server, by the name it is registered under. */
export interface CodexServer {
	name: string;
	url: string | null;
}

/** What reading a tool's files found. */
export type ServersRead<Server> =
	| { state: "read"; servers: Server[] }
	/** The file exists and could not be used. */
	| { state: "unreadable" }
	/** There is no home folder to look in, so there is nowhere to read from. */
	| { state: "unlocated" };

/** Far beyond any real tool configuration; a larger file is not one. */
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;

type Text =
	| { kind: "text"; text: string }
	| { kind: "absent" }
	| { kind: "unusable" };

async function readText(file: string): Promise<Text> {
	try {
		const info = await stat(file);
		if (!info.isFile() || info.size > MAX_CONFIG_BYTES) {
			return { kind: "unusable" };
		}
		return { kind: "text", text: await readFile(file, "utf8") };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { kind: "absent" }
			: { kind: "unusable" };
	}
}

function field(value: unknown, key: string): unknown {
	return typeof value === "object" &&
		value !== null &&
		Object.hasOwn(value, key)
		? Reflect.get(value, key)
		: undefined;
}

/** A folder as Claude Code keys its projects: forward slashes, no trailing one. */
function projectKey(folder: string, platform: NodeJS.Platform): string {
	const slashed = folder.replace(/\\/g, "/").replace(/\/+$/, "");
	return platform === "win32" ? slashed.toLowerCase() : slashed;
}

/** Every server in an `mcpServers` object: its name and its URL if it has one. */
function serversIn(
	servers: unknown,
): Array<{ name: string; url: string | null }> {
	if (typeof servers !== "object" || servers === null) {
		return [];
	}
	return Object.entries(servers).flatMap(([name, server]) => {
		if (typeof server !== "object" || server === null) {
			return [];
		}
		const url = field(server, "url");
		return [{ name, url: typeof url === "string" ? url : null }];
	});
}

export interface ReadClaudeInput {
	/** The checkout's top folder, where Claude Code's local scope is the project. */
	cwd: string;
	home: string | null;
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
}

/**
 * Every server in Claude Code's local scope for the checkout, in its user
 * scope, and in the checkout's `.mcp.json` (project scope).
 */
export async function readClaudeServers(
	input: ReadClaudeInput,
): Promise<ServersRead<ClaudeServer>> {
	const directory = input.env.CLAUDE_CONFIG_DIR ?? input.home;
	if (directory === null || directory === undefined) {
		return { state: "unlocated" };
	}
	const servers: ClaudeServer[] = [];

	const config = await readText(path.join(directory, ".claude.json"));
	if (config.kind === "unusable") {
		return { state: "unreadable" };
	}
	if (config.kind === "text") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(config.text);
		} catch {
			return { state: "unreadable" };
		}
		const wanted = projectKey(input.cwd, input.platform);
		const projects = field(parsed, "projects");
		if (typeof projects === "object" && projects !== null) {
			for (const [key, project] of Object.entries(projects)) {
				if (projectKey(key, input.platform) === wanted) {
					for (const found of serversIn(
						field(project, "mcpServers"),
					)) {
						servers.push({ scope: "local", ...found });
					}
				}
			}
		}
		for (const found of serversIn(field(parsed, "mcpServers"))) {
			servers.push({ scope: "user", ...found });
		}
	}

	const shared = await readText(path.join(input.cwd, ".mcp.json"));
	if (shared.kind === "text") {
		try {
			for (const found of serversIn(
				field(JSON.parse(shared.text), "mcpServers"),
			)) {
				servers.push({ scope: "project", ...found });
			}
		} catch {
			// A file the team shares that does not parse is `mcp-servers`' to report.
		}
	}
	return { state: "read", servers };
}

const CODEX_SERVER_HEADER =
	/^\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/;
const CODEX_URL = /^url\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/;
/** A table inside a server's own (`[mcp_servers.name.env]`): its keys are not the server's. */
const CODEX_SERVER_SUBTABLE =
	/^\[mcp_servers\.(?:"[^"]+"|'[^']+'|[A-Za-z0-9_-]+)\./;
/**
 * Another way to write a server, which this reader would not see: `[mcp_servers]`
 * on its own, a table spelled with spaces, an array of tables, a dotted key
 * (`mcp_servers.name.url = ...`) or an inline table (`mcp_servers = { ... }`). A
 * name it missed would be replaced by `codex mcp add`, so a file that holds one
 * is not read at all.
 */
const CODEX_OTHER_HEADER = /^\[{1,2}\s*mcp_servers\b/;
const CODEX_OTHER_KEY = /^mcp_servers\b/;

export interface ReadCodexInput {
	home: string | null;
	env: Readonly<Record<string, string | undefined>>;
}

/** Every server in Codex's `config.toml`, by name, with its URL when it has one. */
export async function readCodexServers(
	input: ReadCodexInput,
): Promise<ServersRead<CodexServer>> {
	const directory =
		input.env.CODEX_HOME ??
		(input.home === null ? undefined : path.join(input.home, ".codex"));
	if (directory === undefined) {
		return { state: "unlocated" };
	}
	const config = await readText(path.join(directory, "config.toml"));
	if (config.kind === "absent") {
		return { state: "read", servers: [] };
	}
	if (config.kind === "unusable") {
		return { state: "unreadable" };
	}

	const servers = new Map<string, string | null>();
	let current: string | null = null;
	for (const raw of config.text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			const header = CODEX_SERVER_HEADER.exec(line);
			current = header?.[1] ?? header?.[2] ?? header?.[3] ?? null;
			if (current !== null) {
				if (!servers.has(current)) {
					servers.set(current, null);
				}
			} else if (
				CODEX_OTHER_HEADER.test(line) &&
				!CODEX_SERVER_SUBTABLE.test(line)
			) {
				return { state: "unreadable" };
			}
			continue;
		}
		if (CODEX_OTHER_KEY.test(line)) {
			return { state: "unreadable" };
		}
		const url = CODEX_URL.exec(line);
		if (current !== null && url !== null) {
			servers.set(current, url[1] ?? url[2] ?? "");
		}
	}
	return {
		state: "read",
		servers: [...servers].map(([name, url]) => ({ name, url })),
	};
}
