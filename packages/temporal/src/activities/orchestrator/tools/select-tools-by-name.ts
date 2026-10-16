import type { FabricAiTool } from "./fabric-ai-tools";

/**
 * The Fabric tools a search query names exactly, in the order named, e.g.
 * `search_tools({ query: "fabric_create_frame fabric_get_frame" })`.
 *
 * A skill or a prompt that already knows which tools it needs loads them by
 * name instead of hoping a ranked search puts them in the top results: a
 * descriptive query such as "create workspace page frame" ranked the frame
 * tools out of the results and left the agent without them.
 */
export function selectFabricToolsByName(
	query: string,
	tools: readonly FabricAiTool[],
): FabricAiTool[] {
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const selected = new Map<string, FabricAiTool>();
	for (const token of query.split(/[^A-Za-z0-9_-]+/)) {
		const tool = byName.get(token);
		if (tool) {
			selected.set(token, tool);
		}
	}
	return [...selected.values()];
}
