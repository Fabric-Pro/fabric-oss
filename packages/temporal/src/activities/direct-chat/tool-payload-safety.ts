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
 * Drops MCP tools whose schemas the model provider would reject:
 * non-serializable schemas and schemas containing `$ref`.
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
