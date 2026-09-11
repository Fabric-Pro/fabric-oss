export interface ToolDropInfo {
	name: string;
	reason: string;
}

/**
 * Best-effort extraction of a tool's JSON schema for inspection.
 *
 * Handles both AI SDK tool shapes:
 *   - `tool()` → `toolDef.parameters.jsonSchema`
 *   - `dynamicTool()` → `toolDef.inputSchema.jsonSchema`
 *
 * See also: `extractToolJsonSchema` in
 * `packages/temporal/src/activities/orchestrator/execution/execute-mcp-tool.ts`
 * which performs the same unwrap but returns null for schemas without
 * `properties`, making it incompatible for $ref scanning and size calculation.
 */
function getToolSchema(toolDef: unknown): unknown {
	if (!toolDef || typeof toolDef !== "object") {
		return undefined;
	}
	const t = toolDef as Record<string, unknown>;
	const schema = (t.inputSchema ?? t.parameters) as unknown;
	if (schema && typeof schema === "object") {
		// `jsonSchema()` wrappers expose the raw schema on `.jsonSchema`.
		const wrapped = (schema as Record<string, unknown>).jsonSchema;
		return wrapped ?? schema;
	}
	return schema;
}

function approxSchemaBytes(toolDef: unknown): number {
	try {
		return JSON.stringify(getToolSchema(toolDef) ?? {}).length;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/**
 * Structural walk over a parsed schema value to detect any `$ref` key.
 * Unlike a substring match on the serialized string, this will not
 * false-positive on string values or descriptions that contain the literal
 * text `"$ref"`.
 */
function schemaContainsRef(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.some(schemaContainsRef);
	}
	if (value && typeof value === "object") {
		if (Object.hasOwn(value as object, "$ref")) {
			return true;
		}
		return Object.values(value as Record<string, unknown>).some(
			schemaContainsRef,
		);
	}
	return false;
}

/**
 * The tool-name grammar the model providers enforce on every tool definition.
 *
 * Anthropic rejects the WHOLE request — `tools.<n>.custom.name: String should
 * match pattern '^[a-zA-Z0-9_-]{1,128}$'` — when a single name breaks it. One
 * malformed name therefore costs every tool in the turn, not just its own.
 */
export const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

const MCP_TOOL_NAME_MAX_LENGTH = 128;
const ALLOWED_CHARACTERS_ONLY = /^[a-zA-Z0-9_-]+$/;

/**
 * 32-bit FNV-1a as base36. Deterministic and dependency-free — `node:crypto`
 * would be a needless import in a module reachable from the workflow bundle.
 */
function shortHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36).padStart(7, "0").slice(0, 7);
}

/**
 * Builds the model-facing name for an MCP tool: the server's name, lowercased,
 * prefixed onto the tool's own name.
 *
 * A server name is free text the user typed, so it routinely carries
 * characters the grammar forbids — parentheses in `Slack (Official)`, an
 * apostrophe in a possessive. The previous form replaced whitespace and
 * nothing else, so `slack_(official)_…` went to the provider as-is, Anthropic
 * refused the request, and direct chat's graceful degradation (#1644) retried
 * the turn with no tools at all. The user was then told the surface has no
 * tools connected — a confident false claim standing in for a hard 400
 * (Fizzy #2473).
 *
 * A name that is already valid comes back byte-identical: repairing never
 * renames a tool that worked.
 *
 * `taken` carries the names already used by this tool set, and must live
 * OUTSIDE the per-server loop. `tools` and `toolToServerMap` are keyed by this
 * string, so two servers that repair to the same prefix (`Slack (Official)` and
 * `Slack Official`) would otherwise overwrite each other's entries and dispatch
 * one server's calls to the other — a worse failure than the rejection this
 * fixes.
 */
export function buildMcpToolName(
	serverName: string,
	toolName: string,
	taken?: Set<string>,
): string {
	const legacy = `${serverName.toLowerCase().replace(/\s+/g, "_")}_${toolName}`;
	let name = ALLOWED_CHARACTERS_ONLY.test(legacy)
		? legacy
		: legacy
				.replace(/[^a-zA-Z0-9_-]+/g, "_")
				.replace(/_+/g, "_")
				.replace(/^_+|_+$/g, "");
	if (!name) {
		name = "mcp_tool";
	}
	if (name.length > MCP_TOOL_NAME_MAX_LENGTH) {
		// Slicing alone can converge two long names onto the same 128
		// characters — the collision case above wearing a different hat. The
		// hash is taken over the full name, so distinct inputs stay distinct.
		const hash = shortHash(name);
		name = `${name.slice(0, MCP_TOOL_NAME_MAX_LENGTH - hash.length - 1)}_${hash}`;
	}
	if (!taken) {
		return name;
	}
	let candidate = name;
	let attempt = 2;
	while (taken.has(candidate)) {
		const suffix = `_${attempt}`;
		candidate = `${name.slice(
			0,
			MCP_TOOL_NAME_MAX_LENGTH - suffix.length,
		)}${suffix}`;
		attempt++;
	}
	taken.add(candidate);
	return candidate;
}

/**
 * Drops MCP tools whose schemas the model provider would reject:
 * a name outside the provider's grammar, non-serializable schemas, and schemas
 * containing `$ref`.
 *
 * The name check is the fail-safe behind `buildMcpToolName`: whatever produced
 * the name, one that cannot be sent costs a single tool here instead of the
 * entire request (Fizzy #2473).
 *
 * Returns the kept tools, the list of dropped tools with reasons, and a
 * `sizes` map of kept-tool name → serialized byte length of the schema
 * (reusable by `capToolSet` to avoid double-serialization).
 */
export function validateMcpToolSet(tools: Record<string, unknown>): {
	tools: Record<string, unknown>;
	dropped: ToolDropInfo[];
	sizes: Record<string, number>;
} {
	const kept: Record<string, unknown> = {};
	const dropped: ToolDropInfo[] = [];
	const sizes: Record<string, number> = {};
	for (const [name, def] of Object.entries(tools)) {
		if (!MCP_TOOL_NAME_PATTERN.test(name)) {
			dropped.push({ name, reason: "invalid_tool_name" });
			continue;
		}
		const schema = getToolSchema(def);
		let serialized: string;
		try {
			serialized = JSON.stringify(schema ?? {});
		} catch {
			dropped.push({ name, reason: "schema_not_serializable" });
			continue;
		}
		if (schemaContainsRef(schema)) {
			dropped.push({ name, reason: "schema_contains_ref" });
			continue;
		}
		kept[name] = def;
		sizes[name] = serialized.length;
	}
	return { tools: kept, dropped, sizes };
}

export interface CapOptions {
	maxTools: number;
	maxTotalSchemaBytes: number;
	/** Tools matching this predicate are always retained (e.g. built-ins). */
	alwaysKeep?: (name: string) => boolean;
	/**
	 * Pre-computed byte lengths for tool schemas, keyed by tool name.
	 * When provided, avoids re-serializing schemas that were already serialized
	 * by `validateMcpToolSet`. Falls back to `approxSchemaBytes` for any tool
	 * not present in this map (e.g. pinned/built-in tools).
	 */
	precomputedBytes?: Record<string, number>;
	/**
	 * Groups tools that compete for the same budget — in practice the MCP
	 * server a tool came from. When provided, the budget is shared between
	 * groups round-robin instead of being spent in iteration order, so a
	 * server that sorts late still reaches the model.
	 *
	 * Without it, one server's tools can consume the whole budget and every
	 * later server contributes nothing, while the UI still reports it as
	 * connected (Fizzy #2040).
	 */
	groupOf?: (name: string) => string;
}

/**
 * Caps a tool set by count and approximate combined-schema size. Pinned tools
 * (per `alwaysKeep`) are retained unconditionally. Dropped tools are reported,
 * never silently removed.
 *
 * Without `groupOf` the remaining tools are added in iteration order until a
 * limit is reached. With it, each group contributes one tool per round, so the
 * budget is shared rather than claimed by whoever iterates first.
 */
export function capToolSet(
	tools: Record<string, unknown>,
	opts: CapOptions,
): { tools: Record<string, unknown>; dropped: ToolDropInfo[] } {
	const keepAlways = opts.alwaysKeep ?? (() => false);
	const entries = Object.entries(tools);
	const pinned = entries.filter(([n]) => keepAlways(n));
	const rest = entries.filter(([n]) => !keepAlways(n));

	const kept: Record<string, unknown> = {};
	const dropped: ToolDropInfo[] = [];
	let count = 0;
	let bytes = 0;

	const sizeOf = (name: string, def: unknown) =>
		opts.precomputedBytes?.[name] ?? approxSchemaBytes(def);

	for (const [name, def] of pinned) {
		kept[name] = def;
		count++;
		bytes += sizeOf(name, def);
	}

	const admit = (name: string, def: unknown) => {
		const size = sizeOf(name, def);
		if (count >= opts.maxTools || bytes + size > opts.maxTotalSchemaBytes) {
			dropped.push({ name, reason: "over_tool_budget" });
			return;
		}
		kept[name] = def;
		count++;
		bytes += size;
	};

	if (!opts.groupOf) {
		for (const [name, def] of rest) {
			admit(name, def);
		}
		return { tools: kept, dropped };
	}

	// Round-robin: one tool per group per round, preserving each group's own
	// order. Within a round the cheapest schema goes first — when the budget
	// dies mid-round that leaves the smallest tools standing, so the most
	// groups keep representation. Group order breaks size ties, which makes
	// the outcome deterministic given a stable caller-side sort.
	const groupOf = opts.groupOf;
	const queues = new Map<string, Array<[string, unknown]>>();
	for (const entry of rest) {
		const group = groupOf(entry[0]);
		const queue = queues.get(group);
		if (queue) {
			queue.push(entry);
		} else {
			queues.set(group, [entry]);
		}
	}

	const groupOrder = [...queues.keys()];
	let cursor = 0;
	while (true) {
		const round: Array<[string, unknown]> = [];
		for (const group of groupOrder) {
			const entry = queues.get(group)?.[cursor];
			if (entry) {
				round.push(entry);
			}
		}
		if (round.length === 0) {
			break;
		}
		round.sort((a, b) => sizeOf(a[0], a[1]) - sizeOf(b[0], b[1]));
		for (const [name, def] of round) {
			admit(name, def);
		}
		cursor++;
	}

	return { tools: kept, dropped };
}

/**
 * Describes, per MCP server, what a caller's tool set lost to validation or the
 * budget — so the prompt can say "these tools were left out" instead of letting
 * the model present a truncated list as its whole capability (Fizzy #2040).
 *
 * Returns one entry per affected server, in the order the drops were reported,
 * or an empty array when nothing was lost.
 */
export function summarizeOmittedTools(
	dropped: ToolDropInfo[],
	keptToolNames: string[],
	serverOf: (toolName: string) => string,
): string[] {
	const omittedByServer = new Map<string, number>();
	for (const drop of dropped) {
		const server = serverOf(drop.name);
		omittedByServer.set(server, (omittedByServer.get(server) ?? 0) + 1);
	}
	const survivingServers = new Set(keptToolNames.map(serverOf));
	return [...omittedByServer.entries()].map(([server, omitted]) =>
		survivingServers.has(server)
			? `${server} (${omitted} of its tools omitted)`
			: `${server} (all of its tools omitted)`,
	);
}
