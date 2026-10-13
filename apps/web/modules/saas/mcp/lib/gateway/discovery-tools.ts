/**
 * Fabric MCP Gateway - Discovery Mode
 *
 * Some MCP clients cannot take the gateway's full tool list: they cap the
 * number of tools, or the tokens of their definitions. A client that connects
 * with `?mode=discovery` is offered three meta-tools instead:
 *
 * - `search_tools` finds tools by keywords in their names and descriptions;
 * - `get_tool_schema` returns one tool's full definition;
 * - `call_tool` runs a tool by name, through the same dispatch as a direct
 *   `tools/call` (`dispatchToolCall` in `../gateway-endpoint`).
 *
 * The mode is presentation only. Search and schema read the session's own tool
 * list (`getAggregatedTools`, which applies the server selection and a
 * project's allow-list) narrowed to what the credential's scopes permit
 * (`credentialAllowsTool` in `./tool-eligibility`), and every call is checked
 * as a direct call is. The mode is read once, when the session is created, and
 * kept on it (`GatewaySession.toolListMode`), like the server selection.
 *
 * Everything here is pure: the caller passes the session's tool list in, so
 * these functions see exactly the list `tools/list` and the dispatch use.
 */

import { PLATFORM_SERVER_NAME } from "./server-selection";
import {
	credentialAllowsTool,
	isPlatformToolName,
	toolRequiresAuthority,
} from "./tool-eligibility";
import type {
	GatewaySession,
	GatewayToolDefinition,
	ToolCallResult,
	ToolListMode,
} from "./types";

/** The query parameter a client chooses discovery mode on. */
export const TOOL_LIST_MODE_PARAM = "mode";

/** The one value `TOOL_LIST_MODE_PARAM` accepts. */
export const DISCOVERY_MODE = "discovery";

export const SEARCH_TOOLS_NAME = "search_tools";
export const GET_TOOL_SCHEMA_NAME = "get_tool_schema";
export const CALL_TOOL_NAME = "call_tool";

const DISCOVERY_TOOL_NAMES: ReadonlySet<string> = new Set([
	SEARCH_TOOLS_NAME,
	GET_TOOL_SCHEMA_NAME,
	CALL_TOOL_NAME,
]);

/** How many matches `search_tools` returns without a `limit`, and at most. */
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;

/** The longest one-line summary `search_tools` returns for a tool. */
const SUMMARY_MAX_LENGTH = 160;

export type ParsedToolListMode =
	| { kind: "mode"; mode: ToolListMode }
	| { kind: "invalid"; message: string };

/**
 * The tool-list mode a request's URL asks for: `full` without the parameter,
 * `discovery` for `mode=discovery`. Any other value, or the parameter given
 * more than once with different values, is invalid. Case and surrounding
 * spaces are ignored.
 */
export function parseToolListMode(params: URLSearchParams): ParsedToolListMode {
	const values = params.getAll(TOOL_LIST_MODE_PARAM);
	if (values.length === 0) {
		return { kind: "mode", mode: "full" };
	}
	if (
		values.every((value) => value.trim().toLowerCase() === DISCOVERY_MODE)
	) {
		return { kind: "mode", mode: "discovery" };
	}
	return {
		kind: "invalid",
		message: `The "${TOOL_LIST_MODE_PARAM}" parameter accepts one value, "${DISCOVERY_MODE}". Leave the parameter out for the full tool list.`,
	};
}

/** Whether `toolName` is one of the three meta-tools of discovery mode. */
export function isDiscoveryToolName(toolName: string): boolean {
	return DISCOVERY_TOOL_NAMES.has(toolName);
}

/** What `tools/list` returns in discovery mode. */
export const DISCOVERY_TOOL_DEFINITIONS: GatewayToolDefinition[] = [
	{
		name: SEARCH_TOOLS_NAME,
		description:
			"Search the tools this connection can call by keywords in their names and descriptions. Returns each match's name, a one-line summary, its server, and whether it needs runtime authority.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						'Keywords, such as "list projects" or "linear issue".',
				},
				limit: {
					type: "integer",
					minimum: 1,
					maximum: MAX_SEARCH_LIMIT,
					description: `How many matches to return. Default ${DEFAULT_SEARCH_LIMIT}.`,
				},
			},
			required: ["query"],
		},
		annotations: { readOnlyHint: true },
	},
	{
		name: GET_TOOL_SCHEMA_NAME,
		description:
			"Get one tool's full definition: its description, input schema and annotations. Read it before calling a tool you have not used.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "The tool's name, as search_tools returns it.",
				},
			},
			required: ["name"],
		},
		annotations: { readOnlyHint: true },
	},
	{
		name: CALL_TOOL_NAME,
		description:
			"Run a tool by name with its arguments. The call is checked and run exactly as a direct call to the tool would be.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "The tool's name, as search_tools returns it.",
				},
				arguments: {
					type: "object",
					description:
						"The tool's own arguments, as get_tool_schema describes them.",
				},
			},
			required: ["name"],
		},
	},
];

function errorResult(error: string, hint?: string): ToolCallResult {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(hint ? { error, hint } : { error }),
			},
		],
		isError: true,
	};
}

function jsonResult(value: unknown): ToolCallResult {
	return {
		content: [{ type: "text", text: JSON.stringify(value) }],
		structuredContent: value,
	};
}

/**
 * The tools of `tools` this session's credential may call: the list search and
 * schema read from. `tools` is the session's aggregated list, already narrowed
 * to its server selection or its project's allow-list.
 */
function discoverableTools(
	session: Pick<GatewaySession, "credential" | "scopes">,
	tools: readonly GatewayToolDefinition[],
): GatewayToolDefinition[] {
	return tools.filter((tool) => credentialAllowsTool(session, tool));
}

/** The server a tool belongs to: `fabric`, or a connected server's prefix. */
function serverOf(toolName: string): string {
	if (isPlatformToolName(toolName)) {
		return PLATFORM_SERVER_NAME;
	}
	const separator = toolName.indexOf("__");
	return separator === -1 ? toolName : toolName.slice(0, separator);
}

/**
 * The first sentence of a description, on one line and at most
 * `SUMMARY_MAX_LENGTH` characters.
 */
export function summarize(description: string): string {
	const firstLine = description.trim().split(/\r?\n/)[0] ?? "";
	const sentence = /^(.+?[.!?])(?:\s|$)/.exec(firstLine)?.[1] ?? firstLine;
	return sentence.length > SUMMARY_MAX_LENGTH
		? `${sentence.slice(0, SUMMARY_MAX_LENGTH - 1).trimEnd()}…`
		: sentence;
}

/** The annotations a search match reports: the two a caller decides on. */
function hintsOf(tool: GatewayToolDefinition): {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
} {
	const hints: { readOnlyHint?: boolean; destructiveHint?: boolean } = {};
	if (tool.annotations?.readOnlyHint !== undefined) {
		hints.readOnlyHint = tool.annotations.readOnlyHint;
	}
	if (tool.annotations?.destructiveHint !== undefined) {
		hints.destructiveHint = tool.annotations.destructiveHint;
	}
	return hints;
}

function parseLimit(
	value: unknown,
): { ok: true; limit: number } | { ok: false } {
	if (value === undefined || value === null) {
		return { ok: true, limit: DEFAULT_SEARCH_LIMIT };
	}
	const parsed = typeof value === "string" ? Number(value) : value;
	if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
		return { ok: false };
	}
	return {
		ok: true,
		limit: Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(parsed))),
	};
}

/**
 * `search_tools`: the session's callable tools that match `query`, best first.
 *
 * The query is split on whitespace into lowercased terms, and a tool matches
 * when its name or description contains at least one of them. Matches are
 * ordered by how many terms they contain, then by how many of those are in
 * the name, then by their order in the tool list, so the same query on the
 * same list returns the same order. Only tools the credential may call are
 * searched, so a tool it may not call is neither returned nor counted.
 */
export function searchTools(
	session: Pick<GatewaySession, "credential" | "scopes">,
	tools: readonly GatewayToolDefinition[],
	args: Record<string, unknown>,
): ToolCallResult {
	const query = typeof args.query === "string" ? args.query.trim() : "";
	if (query === "") {
		return errorResult(
			`${SEARCH_TOOLS_NAME} needs search terms in "query", such as "list projects".`,
		);
	}
	const limit = parseLimit(args.limit);
	if (!limit.ok) {
		return errorResult(
			`"limit" must be a number from 1 to ${MAX_SEARCH_LIMIT}.`,
		);
	}

	const terms = [...new Set(query.toLowerCase().split(/\s+/))];
	const ranked = discoverableTools(session, tools)
		.map((tool, index) => {
			const name = tool.name.toLowerCase();
			const description = tool.description.toLowerCase();
			const inName = terms.filter((term) => name.includes(term)).length;
			const matched = terms.filter(
				(term) => name.includes(term) || description.includes(term),
			).length;
			return { tool, index, inName, matched };
		})
		.filter((entry) => entry.matched > 0)
		.sort(
			(a, b) =>
				b.matched - a.matched ||
				b.inName - a.inName ||
				a.index - b.index,
		);

	const matches = ranked.slice(0, limit.limit).map(({ tool }) => ({
		name: tool.name,
		summary: summarize(tool.description),
		server: serverOf(tool.name),
		annotations: hintsOf(tool),
		requiresAuthority: toolRequiresAuthority(session, tool),
	}));

	return jsonResult({
		total: ranked.length,
		tools: matches,
		...(ranked.length === 0
			? {
					hint: "No tool matched. Try other or fewer keywords.",
				}
			: ranked.length > matches.length
				? {
						hint: `${ranked.length - matches.length} more matched. Use more specific keywords, or a higher "limit" (up to ${MAX_SEARCH_LIMIT}).`,
					}
				: {}),
	});
}

/**
 * `get_tool_schema`: one tool's full definition, from the same list search
 * reads. A name that is not in it gets one answer, whatever the reason (no
 * such tool, outside the server selection or the project's tools, or beyond
 * the credential's scopes), so the answer does not reveal which.
 */
export function getToolSchema(
	session: Pick<GatewaySession, "credential" | "scopes">,
	tools: readonly GatewayToolDefinition[],
	args: Record<string, unknown>,
): ToolCallResult {
	const name = typeof args.name === "string" ? args.name.trim() : "";
	if (name === "") {
		return errorResult(
			`${GET_TOOL_SCHEMA_NAME} needs a tool name in "name".`,
			`Find tool names with ${SEARCH_TOOLS_NAME}.`,
		);
	}
	const tool = discoverableTools(session, tools).find(
		(candidate) => candidate.name === name,
	);
	if (!tool) {
		return errorResult(
			`No tool named "${name}" is available on this connection.`,
			`Find the tools you can call with ${SEARCH_TOOLS_NAME}.`,
		);
	}
	return jsonResult({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
		annotations: { ...tool.annotations },
		requiresAuthority: toolRequiresAuthority(session, tool),
	});
}

/**
 * The tool and arguments a `call_tool` call names, or the refusal for one that
 * cannot be dispatched: a missing name, a meta-tool's name (a call does not
 * recurse), or `arguments` that are not an object.
 */
export function parseCallToolArguments(
	args: Record<string, unknown>,
):
	| { ok: true; name: string; arguments: Record<string, unknown> }
	| { ok: false; result: ToolCallResult } {
	const name = args.name;
	if (typeof name !== "string" || name.trim() === "") {
		return {
			ok: false,
			result: errorResult(
				`${CALL_TOOL_NAME} needs the tool's name in "name".`,
				`Find tool names with ${SEARCH_TOOLS_NAME}.`,
			),
		};
	}
	if (isDiscoveryToolName(name)) {
		return {
			ok: false,
			result: errorResult(
				`${CALL_TOOL_NAME} runs this connection's tools, not ${name}. Call ${name} directly.`,
			),
		};
	}
	const inner = args.arguments;
	if (
		inner !== undefined &&
		(inner === null || typeof inner !== "object" || Array.isArray(inner))
	) {
		return {
			ok: false,
			result: errorResult(
				`"arguments" must be an object of the tool's own arguments.`,
				`Read them with ${GET_TOOL_SCHEMA_NAME}.`,
			),
		};
	}
	return {
		ok: true,
		name,
		arguments: (inner as Record<string, unknown> | undefined) ?? {},
	};
}
