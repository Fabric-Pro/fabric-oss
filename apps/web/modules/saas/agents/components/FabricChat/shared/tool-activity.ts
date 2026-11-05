/** A completed transport can still contain an MCP/provider tool failure. */
export function effectiveToolStatus<T extends string>(tool: {
	status: T;
	result?: unknown;
	error?: unknown;
}): T | "error" {
	if (tool.status === "pending" || tool.status === "running") {
		return tool.status;
	}
	let result = tool.result;
	if (typeof result === "string") {
		try {
			result = JSON.parse(result);
		} catch {
			// Ordinary text is a successful result, not a protocol envelope.
		}
	}
	const envelope =
		result && typeof result === "object"
			? (result as Record<string, unknown>)
			: null;
	return tool.error ||
		envelope?.isError === true ||
		envelope?.success === false
		? "error"
		: tool.status;
}
