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
}

/**
 * Caps a tool set by count and approximate combined-schema size. Pinned tools
 * (per `alwaysKeep`) are retained unconditionally; remaining tools are added in
 * order until a limit is reached. Dropped tools are reported, never silently
 * removed.
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

	for (const [name, def] of pinned) {
		kept[name] = def;
		count++;
		bytes += opts.precomputedBytes?.[name] ?? approxSchemaBytes(def);
	}

	for (const [name, def] of rest) {
		const size = opts.precomputedBytes?.[name] ?? approxSchemaBytes(def);
		if (count >= opts.maxTools || bytes + size > opts.maxTotalSchemaBytes) {
			dropped.push({ name, reason: "over_tool_budget" });
			continue;
		}
		kept[name] = def;
		count++;
		bytes += size;
	}

	return { tools: kept, dropped };
}
