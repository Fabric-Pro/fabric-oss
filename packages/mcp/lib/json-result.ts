export function jsonResult(data: unknown): {
	content: Array<{ type: "text"; text: string }>;
} {
	return {
		content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
	};
}
