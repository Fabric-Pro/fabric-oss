/** Resolve the explicit graph fixture; database snapshot authority is tested separately. */
export async function providedWorkflowGraph(input: {
	override?: { nodes: unknown[]; edges: unknown[] };
}) {
	if (!input.override) {
		throw new Error(
			"This workflow fixture requires an explicit graph override",
		);
	}
	return { ...input.override, projectId: null, variables: null };
}
