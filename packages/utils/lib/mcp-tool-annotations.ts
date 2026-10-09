/**
 * MCP tool annotations: the boolean hints a server declares about a tool
 * (MCP specification, `ToolAnnotations`). The gateway's authority gate grants
 * READ to a delegated credential only on the server's own `readOnlyHint`, so
 * every place that discovers or caches connected tools keeps them through this
 * one reader.
 */
export interface McpToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

const MCP_TOOL_ANNOTATION_KEYS = [
	"readOnlyHint",
	"destructiveHint",
	"idempotentHint",
	"openWorldHint",
] as const;

/**
 * The boolean hints a connected server declared for a tool, from whatever shape
 * the MCP client or the stored cache holds. Anything else is dropped, so a tool
 * that declares nothing is unannotated, which the authority gate reads as "not
 * known to be read-only".
 */
export function readMcpToolAnnotations(
	value: unknown,
): McpToolAnnotations | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const annotations: McpToolAnnotations = {};
	for (const key of MCP_TOOL_ANNOTATION_KEYS) {
		const hint = Reflect.get(value, key);
		if (typeof hint === "boolean") {
			annotations[key] = hint;
		}
	}
	return Object.keys(annotations).length > 0 ? annotations : undefined;
}
