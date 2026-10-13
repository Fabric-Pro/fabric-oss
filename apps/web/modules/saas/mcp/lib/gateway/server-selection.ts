/**
 * Fabric MCP Gateway - Server Selection
 *
 * A client of the organization-wide gateway may name, on the `servers` query
 * parameter of the URL it connects to, which of the gateway's servers and tools
 * it wants to see. Each comma-separated entry is either a whole server — `name`
 * or `name:*` — or one of its tools, `name:tool`. The server is `fabric` for the
 * platform tools, or a connected server by the prefix its tools carry (`github`
 * for `github__list_repos`). The tool is the name the server itself gives it:
 * what follows `<prefix>__` for a connected server, and the full platform name
 * (`fabric_list_projects`) for `fabric`. The selection is read once, when the
 * session is created, and kept on the session; see
 * `GatewaySession.serverSelection`.
 *
 * It narrows what one client is offered and may call. It is not access
 * control: it grants nothing, and every permission, scope and runtime-authority
 * check still applies to whatever it leaves in.
 *
 * `selectionAllowsTool` is the one predicate every listing and execution site
 * asks, so they cannot disagree about which tools a selection keeps.
 */

import type { GatewaySession, ServerSelection } from "./types";

/** The name that selects the platform tools (`fabric_*`). */
export const PLATFORM_SERVER_NAME = "fabric";

/**
 * Whether the gateway routes `toolName` as a platform tool: a `fabric_` name
 * with no `__`. Every connected server's tool is `<prefix>__<tool>`, and a
 * connection's prefix can itself start with `fabric_` (a connection named
 * "Fabric Docs" gets `fabric_docs`), so the `__` is what tells them apart. No
 * platform tool name contains `__`; `platform-tool-names.test.ts` enforces it.
 * The routing, the selection and discovery all ask this one predicate.
 */
export function isPlatformToolName(toolName: string): boolean {
	return (
		toolName.startsWith(`${PLATFORM_SERVER_NAME}_`) &&
		!toolName.includes("__")
	);
}

/** The query parameter a client names its selection on. */
export const SERVER_SELECTION_PARAM = "servers";

/** The tool part that means every tool of a server (`name:*`). */
const ALL_TOOLS = "*";

export type ParsedServerSelection =
	/** No parameter: every server, as before the parameter existed. */
	| { kind: "all" }
	/** One entry per server named, merged and without duplicates. */
	| { kind: "entries"; entries: ServerSelection }
	| { kind: "invalid"; message: string };

const SYNTAX_EXAMPLE = `"${SERVER_SELECTION_PARAM}=${PLATFORM_SERVER_NAME},github:list_repos"`;

/**
 * Parse the `servers` parameter's syntax. Whether each server and tool exists
 * is a separate question, answered against the caller's connections when the
 * session is created (`validateServerSelection` in `./tool-aggregator`).
 *
 * An entry is split on its first `:` — an MCP tool name cannot contain `:` or
 * `,`. The server part is trimmed and lowercased, as prefixes are; the tool
 * part is trimmed and keeps its case, because tool names are case-sensitive.
 * Several entries for one server are merged: tools union, and a whole-server
 * entry absorbs them. Every repetition of the parameter is read, so
 * `?servers=a&servers=b` means the same as `?servers=a,b`.
 */
export function parseServerSelection(
	params: URLSearchParams,
): ParsedServerSelection {
	const values = params.getAll(SERVER_SELECTION_PARAM);
	if (values.length === 0) {
		return { kind: "all" };
	}
	const servers: string[] = [];
	const tools = new Map<string, Set<string> | typeof ALL_TOOLS>();
	for (const entry of values.flatMap((value) => value.split(","))) {
		const separator = entry.indexOf(":");
		const server = (separator === -1 ? entry : entry.slice(0, separator))
			.trim()
			.toLowerCase();
		const tool =
			separator === -1 ? ALL_TOOLS : entry.slice(separator + 1).trim();
		if (server === "") {
			return {
				kind: "invalid",
				message: `The "${SERVER_SELECTION_PARAM}" parameter has an entry with no server name. Name each server once, or one of its tools as server:tool, separated by commas, for example ${SYNTAX_EXAMPLE}, or leave the parameter out to see every server.`,
			};
		}
		if (tool === "") {
			return {
				kind: "invalid",
				message: `The "${SERVER_SELECTION_PARAM}" entry "${entry.trim()}" has no tool name after ":". Write ${server} or ${server}:* for every tool of the server, or ${server}:<tool> for one tool.`,
			};
		}
		if (!tools.has(server)) {
			servers.push(server);
			tools.set(server, new Set());
		}
		const current = tools.get(server);
		if (tool === ALL_TOOLS) {
			tools.set(server, ALL_TOOLS);
		} else if (current !== ALL_TOOLS) {
			current?.add(tool);
		}
	}
	return {
		kind: "entries",
		entries: servers.map((server) => {
			const named = tools.get(server);
			return {
				server,
				tools:
					named === ALL_TOOLS || named === undefined
						? ALL_TOOLS
						: [...named],
			};
		}),
	};
}

/** The server names in `entries` that are neither `fabric` nor one of `prefixes`. */
export function unknownServerNames(
	entries: ServerSelection,
	prefixes: readonly string[],
): string[] {
	return entries
		.map((entry) => entry.server)
		.filter(
			(name) => name !== PLATFORM_SERVER_NAME && !prefixes.includes(name),
		);
}

/** The message refusing a selection that names servers the caller does not have. */
export function unknownServerNamesMessage(
	unknown: readonly string[],
	prefixes: readonly string[],
): string {
	const valid = [PLATFORM_SERVER_NAME, ...prefixes].join(", ");
	return `Unknown server name${unknown.length === 1 ? "" : "s"} in the "${SERVER_SELECTION_PARAM}" parameter: ${unknown.join(", ")}. Valid names for this connection: ${valid}.`;
}

/** Above this many, an unknown-tool message counts a server's tools instead of listing them. */
const TOOL_LIST_LIMIT = 25;

/** The message refusing tools a server does not have. */
export function unknownToolNamesMessage(
	server: string,
	unknown: readonly string[],
	valid: readonly string[],
): string {
	const named = unknown.map((tool) => `${server}:${tool}`).join(", ");
	const available =
		valid.length <= TOOL_LIST_LIMIT
			? `Its tools are: ${valid.join(", ")}.`
			: `It has ${valid.length} tools: connect with "${SERVER_SELECTION_PARAM}=${server}" and call tools/list to see them${server === PLATFORM_SERVER_NAME ? "" : ` (the tool name is the part after "${server}__")`}.`;
	return `Unknown tool name${unknown.length === 1 ? "" : "s"} in the "${SERVER_SELECTION_PARAM}" parameter: ${named}. Tool names are case-sensitive. ${available}`;
}

/**
 * The server and the server's own tool name a gateway tool name stands for,
 * classified exactly as the gateway's tools/call routing and
 * `executeConnectedServerTool` classify it: a platform tool
 * (`isPlatformToolName`) under its full name, and otherwise the text before the first `__` is the
 * connected server's prefix and the rest is its tool. Null for a name of
 * neither form, which nothing would run.
 */
function classifyToolName(
	toolName: string,
): { server: string; tool: string } | null {
	if (isPlatformToolName(toolName)) {
		return { server: PLATFORM_SERVER_NAME, tool: toolName };
	}
	const separatorIndex = toolName.indexOf("__");
	if (separatorIndex === -1) {
		return null;
	}
	return {
		server: toolName.slice(0, separatorIndex),
		tool: toolName.slice(separatorIndex + 2),
	};
}

/**
 * Whether the session's selection lets its client see and call `toolName`, by
 * its gateway name (`fabric_list_projects`, `github__list_repos`). The one
 * predicate the tool list, the tools/call routing and both executors ask.
 *
 * True without a selection, and for a name of neither form, which is left to
 * the caller's own "unknown tool" answer since nothing would run it.
 */
export function selectionAllowsTool(
	session: Pick<GatewaySession, "serverSelection">,
	toolName: string,
): boolean {
	const selection = session.serverSelection ?? null;
	if (selection === null) {
		return true;
	}
	const classified = classifyToolName(toolName);
	if (classified === null) {
		return true;
	}
	const entry = selection.find((e) => e.server === classified.server);
	if (entry === undefined) {
		return false;
	}
	return entry.tools === ALL_TOOLS || entry.tools.includes(classified.tool);
}

/**
 * Whether the session's selection names the connected server with `prefix` at
 * all, wholly or by some of its tools. Narrows the `servers` a caller resolves
 * prefixes against; which of the server's tools are kept is
 * `selectionAllowsTool`'s answer.
 */
export function selectionIncludesServer(
	session: Pick<GatewaySession, "serverSelection">,
	prefix: string,
): boolean {
	const selection = session.serverSelection ?? null;
	return selection === null || selection.some((e) => e.server === prefix);
}

/** The refusal for a tool `selectionAllowsTool` said no to. */
export function selectionRefusalMessage(toolName: string): string {
	return `${toolName} is not available on this connection: its "${SERVER_SELECTION_PARAM}" selection does not include it.`;
}

/** The selection as it would be written in the parameter, for messages. */
export function formatServerSelection(selection: ServerSelection): string {
	return selection
		.flatMap((entry) =>
			entry.tools === ALL_TOOLS
				? [entry.server]
				: entry.tools.map((tool) => `${entry.server}:${tool}`),
		)
		.join(",");
}
