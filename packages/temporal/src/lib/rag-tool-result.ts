/** The exact result recorded by the tool loop, including its empty-match text. */
export function ragToolResultText(
	owner: "project" | "workspace",
	query: string,
	result: { context: string; chunkCount: number },
): string {
	return result.context && result.chunkCount > 0
		? result.context
		: `No relevant content found in ${owner === "project" ? "project contexts" : "workspace documents"} for query: "${query}".`;
}
