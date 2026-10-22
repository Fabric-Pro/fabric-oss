/** Tool names for reads of the run's attached workspace documents. */
export const WORKSPACE_TOOL_NAMES = {
	query: "workspace_rag_query",
	summarize: "workspace_rag_summarize",
} as const;

const workspaceToolNames = new Set<string>(Object.values(WORKSPACE_TOOL_NAMES));

/** An omitted workspace list preserves discovery for callers without run context. */
export function isWorkspaceToolHidden(
	toolName: string,
	workspaceIds: string[] | undefined,
): boolean {
	return workspaceIds?.length === 0 && workspaceToolNames.has(toolName);
}
