/**
 * A readable message for anything a tool call can throw or return as its
 * failure: an `Error`, a string, a JSON-RPC error (`{ error: { code, message } }`),
 * an HTTP-client error (`{ data: { message } }`), or an MCP `isError` result
 * whose message sits in `content[].text`. `String(value)` on a plain object is
 * "[object Object]", which is what users saw in the chat's tool card; this never
 * returns that.
 */
export function describeError(error: unknown): string {
	return describe(error, 0) || "Unknown error";
}

const MAX_DEPTH = 4;

function describe(value: unknown, depth: number): string {
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value !== "object") {
		return String(value);
	}
	if (depth > MAX_DEPTH) {
		return "";
	}

	const record = value as Record<string, unknown>;
	if (typeof record.message === "string" && record.message) {
		return record.message;
	}
	if (record.error !== undefined && record.error !== value) {
		const nested = describe(record.error, depth + 1);
		if (nested) {
			return nested;
		}
	}
	const data = record.data as Record<string, unknown> | undefined;
	if (data && typeof data === "object" && typeof data.message === "string") {
		return data.message;
	}
	if (Array.isArray(record.content)) {
		const text = record.content
			.map((part) =>
				part &&
				typeof part === "object" &&
				typeof (part as { text?: unknown }).text === "string"
					? (part as { text: string }).text
					: "",
			)
			.filter(Boolean)
			.join("\n");
		if (text) {
			return text;
		}
	}
	if (value instanceof Error) {
		return value.name;
	}
	try {
		const json = JSON.stringify(value);
		return json && json !== "{}" ? json : "";
	} catch {
		return "";
	}
}
