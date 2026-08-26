/**
 * Workflow Validation
 *
 * Validates workflow structure before execution.
 * Checks for common issues like empty workflows, disconnected nodes, and cycles.
 */

interface WorkflowNode {
	id: string;
	type: string;
	data: Record<string, unknown>;
	position?: { x: number; y: number };
}

interface WorkflowEdge {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string;
	targetHandle?: string;
}

interface ValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

/**
 * Upper bound on nodes in a single workflow.
 *
 * Execution walks the graph node by node with each activity allowed up to ten
 * minutes, so an unbounded graph is an unbounded run. Rejecting at save and
 * publish means the author finds out while editing rather than half way
 * through a run. Deliberately generous — this is a runaway guard, not a
 * product limit. The largest workflow in the wild is far below it.
 */
export const MAX_WORKFLOW_NODES = 200;

/** Warn well before the ceiling so hitting it is never a surprise. */
const NODE_COUNT_WARNING_THRESHOLD = Math.floor(MAX_WORKFLOW_NODES * 0.75);

/**
 * Validate workflow structure before execution
 */
export function validateWorkflowBeforeExecution(
	nodes: unknown[],
	edges: unknown[],
): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	// Safely cast nodes and edges
	const typedNodes = nodes as WorkflowNode[];
	const typedEdges = edges as WorkflowEdge[];

	// Filter out placeholder nodes
	const realNodes = typedNodes.filter(
		(n) => n.type !== "add" && n.type !== "empty-action",
	);

	// Check for empty workflow
	if (realNodes.length === 0) {
		errors.push("Workflow has no nodes. Add at least one action.");
		return { valid: false, errors, warnings };
	}

	// Runaway guard — see MAX_WORKFLOW_NODES.
	if (realNodes.length > MAX_WORKFLOW_NODES) {
		errors.push(
			`Workflow has ${realNodes.length} nodes, above the limit of ${MAX_WORKFLOW_NODES}. Split it into smaller workflows.`,
		);
		return { valid: false, errors, warnings };
	}

	if (realNodes.length > NODE_COUNT_WARNING_THRESHOLD) {
		warnings.push(
			`Workflow has ${realNodes.length} nodes, approaching the limit of ${MAX_WORKFLOW_NODES}.`,
		);
	}

	// Build node map for quick lookup
	const nodeMap = new Map(realNodes.map((n) => [n.id, n]));

	// Validate edges reference existing nodes
	for (const edge of typedEdges) {
		if (!nodeMap.has(edge.source)) {
			errors.push(
				`Edge references non-existent source node "${edge.source}"`,
			);
		}
		if (!nodeMap.has(edge.target)) {
			errors.push(
				`Edge references non-existent target node "${edge.target}"`,
			);
		}
	}

	if (errors.length > 0) {
		return { valid: false, errors, warnings };
	}

	// Check for cycles using DFS
	const hasCycle = detectCycles(realNodes, typedEdges);
	if (hasCycle) {
		errors.push("Workflow contains a cycle. Cycles are not allowed.");
	}

	// Check for disconnected nodes (nodes with no edges)
	if (typedEdges.length > 0 && realNodes.length > 1) {
		const connectedNodes = new Set<string>();
		for (const edge of typedEdges) {
			connectedNodes.add(edge.source);
			connectedNodes.add(edge.target);
		}

		for (const node of realNodes) {
			if (!connectedNodes.has(node.id)) {
				const label = (node.data?.label as string) || node.id;
				warnings.push(
					`Node "${label}" is not connected to the workflow.`,
				);
			}
		}
	}

	// Check for condition nodes with missing edges
	const conditionNodes = realNodes.filter((n) => n.type === "condition");
	for (const conditionNode of conditionNodes) {
		const trueEdge = typedEdges.find(
			(e) => e.source === conditionNode.id && e.sourceHandle === "true",
		);
		const falseEdge = typedEdges.find(
			(e) => e.source === conditionNode.id && e.sourceHandle === "false",
		);

		const label = (conditionNode.data?.label as string) || conditionNode.id;

		if (!trueEdge && !falseEdge) {
			warnings.push(`Condition node "${label}" has no outgoing edges.`);
		} else if (!trueEdge) {
			warnings.push(`Condition node "${label}" has no "true" branch.`);
		} else if (!falseEdge) {
			warnings.push(`Condition node "${label}" has no "false" branch.`);
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

/**
 * Detect cycles in the workflow graph using DFS
 */
function detectCycles(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
	const nodeIds = new Set(nodes.map((n) => n.id));
	const adjacencyList = new Map<string, string[]>();

	// Build adjacency list
	for (const nodeId of nodeIds) {
		adjacencyList.set(nodeId, []);
	}
	for (const edge of edges) {
		const neighbors = adjacencyList.get(edge.source);
		if (neighbors) {
			neighbors.push(edge.target);
		}
	}

	const visited = new Set<string>();
	const recursionStack = new Set<string>();

	function dfs(nodeId: string): boolean {
		visited.add(nodeId);
		recursionStack.add(nodeId);

		const neighbors = adjacencyList.get(nodeId) || [];
		for (const neighbor of neighbors) {
			if (!visited.has(neighbor)) {
				if (dfs(neighbor)) {
					return true; // Cycle found
				}
			} else if (recursionStack.has(neighbor)) {
				return true; // Back edge found = cycle
			}
		}

		recursionStack.delete(nodeId);
		return false;
	}

	// Check for cycles starting from each unvisited node
	for (const nodeId of nodeIds) {
		if (!visited.has(nodeId)) {
			if (dfs(nodeId)) {
				return true;
			}
		}
	}

	return false;
}
