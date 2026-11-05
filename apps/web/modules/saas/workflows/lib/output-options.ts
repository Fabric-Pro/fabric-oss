import { getNodeDefinition } from "./node-definitions";
import { findActionById } from "./plugins/registry";
import type { WorkflowEdge, WorkflowNode } from "./types";
export interface OutputOption {
	label: string;
	value: string;
	description?: string;
	category?: string;
}
/** Only upstream nodes can supply a value. Stable ids survive display-name edits. */
export function workflowOutputOptions(
	nodeId: string,
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
): OutputOption[] {
	const ancestors = new Set<string>();
	const pending = [nodeId];
	while (pending.length) {
		const next = pending.pop();
		for (const e of edges) {
			if (
				e.target === next &&
				e.source !== nodeId &&
				!ancestors.has(e.source)
			) {
				ancestors.add(e.source);
				pending.push(e.source);
			}
		}
	}
	return nodes
		.filter((n) => ancestors.has(n.id) && /^[\w-]+$/.test(n.id))
		.flatMap((n) => {
			const fields =
				n.type === "trigger"
					? [{ field: "data", description: "Trigger input" }]
					: (findActionById(n.type ?? "")?.outputFields ??
						getNodeDefinition(n.type ?? "")?.outputFields ??
						[]);
			return fields.map((f) => ({
				label: f.field,
				value: `{{$${n.id}.${f.field}}}`,
				description: f.description,
				category: n.data.label || n.id,
			}));
		});
}
