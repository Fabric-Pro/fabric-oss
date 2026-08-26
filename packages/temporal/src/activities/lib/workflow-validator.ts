/**
 * Workflow Validator
 *
 * Validates workflow structure before execution.
 * Checks for common issues like cycles, disconnected nodes, and missing trigger.
 */

interface WorkflowNode {
	id: string;
	type: string;
	data: Record<string, unknown>;
	position: { x: number; y: number };
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
 * Validate workflow structure before execution
 */
export function validateWorkflow(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	// Filter out placeholder nodes
	const realNodes = nodes.filter(
		(n) => n.type !== "add" && n.type !== "empty-action",
	);

	// Check for empty workflow
	if (realNodes.length === 0) {
		errors.push("Workflow has no nodes. Add at least one action.");
		return { valid: false, errors, warnings };
	}

	// Check for trigger node
	const triggerNodes = realNodes.filter((n) => n.type === "trigger");
	if (triggerNodes.length === 0) {
		// Not an error - workflows can start from any node
		warnings.push(
			"No trigger node found. Workflow will start from nodes with no incoming edges.",
		);
	} else if (triggerNodes.length > 1) {
		errors.push(
			"Workflow has multiple trigger nodes. Only one trigger is allowed.",
		);
	}

	// Build node map for quick lookup
	const nodeMap = new Map(realNodes.map((n) => [n.id, n]));

	// Validate edges reference existing nodes
	for (const edge of edges) {
		if (!nodeMap.has(edge.source)) {
			errors.push(
				`Edge "${edge.id}" references non-existent source node "${edge.source}"`,
			);
		}
		if (!nodeMap.has(edge.target)) {
			errors.push(
				`Edge "${edge.id}" references non-existent target node "${edge.target}"`,
			);
		}
	}

	if (errors.length > 0) {
		return { valid: false, errors, warnings };
	}

	// Check for cycles using DFS
	const hasCycle = detectCycles(realNodes, edges);
	if (hasCycle) {
		errors.push("Workflow contains a cycle. Cycles are not allowed.");
	}

	// Check for disconnected nodes (nodes with no edges)
	const connectedNodes = new Set<string>();
	for (const edge of edges) {
		connectedNodes.add(edge.source);
		connectedNodes.add(edge.target);
	}

	// If we have edges, check for disconnected nodes
	if (edges.length > 0 && realNodes.length > 1) {
		for (const node of realNodes) {
			if (!connectedNodes.has(node.id)) {
				warnings.push(
					`Node "${node.data.label || node.id}" is not connected to the workflow.`,
				);
			}
		}
	}

	// Check for condition nodes with missing edges
	const conditionNodes = realNodes.filter((n) => n.type === "condition");
	for (const conditionNode of conditionNodes) {
		const trueEdge = edges.find(
			(e) => e.source === conditionNode.id && e.sourceHandle === "true",
		);
		const falseEdge = edges.find(
			(e) => e.source === conditionNode.id && e.sourceHandle === "false",
		);

		if (!trueEdge && !falseEdge) {
			warnings.push(
				`Condition node "${conditionNode.data.label || conditionNode.id}" has no outgoing edges.`,
			);
		} else if (!trueEdge) {
			warnings.push(
				`Condition node "${conditionNode.data.label || conditionNode.id}" has no "true" branch.`,
			);
		} else if (!falseEdge) {
			warnings.push(
				`Condition node "${conditionNode.data.label || conditionNode.id}" has no "false" branch.`,
			);
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

/**
 * Get execution order for nodes (topological sort)
 */
export function getExecutionOrder(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
): string[] {
	const realNodes = nodes.filter(
		(n) => n.type !== "add" && n.type !== "empty-action",
	);

	const nodeIds = new Set(realNodes.map((n) => n.id));
	const inDegree = new Map<string, number>();
	const adjacencyList = new Map<string, string[]>();

	// Initialize
	for (const nodeId of nodeIds) {
		inDegree.set(nodeId, 0);
		adjacencyList.set(nodeId, []);
	}

	// Build graph
	for (const edge of edges) {
		if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
			adjacencyList.get(edge.source)?.push(edge.target);
			inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
		}
	}

	// Find starting nodes (in-degree = 0)
	const queue: string[] = [];
	for (const [nodeId, degree] of inDegree) {
		if (degree === 0) {
			queue.push(nodeId);
		}
	}

	// Topological sort
	const order: string[] = [];
	while (queue.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: queue.shift() is non-null since queue.length > 0 was checked
		const nodeId = queue.shift()!;
		order.push(nodeId);

		for (const neighbor of adjacencyList.get(nodeId) || []) {
			const newDegree = (inDegree.get(neighbor) || 0) - 1;
			inDegree.set(neighbor, newDegree);
			if (newDegree === 0) {
				queue.push(neighbor);
			}
		}
	}

	return order;
}
