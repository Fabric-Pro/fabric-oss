/**
 * Pure edits to the builder's node and edge state.
 *
 * The canvas lays a workflow out top to bottom: each step is a fixed-width
 * card, an edge runs from the bottom of one card to the top of the next, and
 * a new step goes below the one it follows. Keeping the arithmetic here,
 * apart from React Flow, is what lets it be tested without a canvas.
 */

import type { Edge, Node } from "@xyflow/react";
import type { WorkflowEdge, WorkflowNode } from "./types";

/** Width of a step card on the canvas, in flow units. */
const STEP_NODE_WIDTH = 300;
/** Vertical distance between the tops of two consecutive steps. */
export const STEP_SPACING_Y = 132;
/** Horizontal distance between sibling branches. */
const BRANCH_SPACING_X = STEP_NODE_WIDTH + 48;
/** A step card's height, close enough to tell when two would overlap. */
const STEP_NODE_HEIGHT = 64;

/** Canvas-only placeholders that are never saved or run. */
const PLACEHOLDER_NODE_TYPES = new Set(["add", "empty-action"]);

export function isStepNode(node: Pick<Node, "type">): boolean {
	return !PLACEHOLDER_NODE_TYPES.has(node.type ?? "");
}

/** Node types with more than one outgoing handle, so no default to wire. */
const BRANCHING_NODE_TYPES = new Set(["condition"]);

export interface GraphState {
	nodes: Node[];
	edges: Edge[];
}

function connectingEdge(
	source: string,
	target: string,
	sourceHandle?: string | null,
	targetHandle?: string | null,
): Edge {
	return {
		id: `e-${source}-${sourceHandle ?? "out"}-${target}`,
		source,
		target,
		sourceHandle: sourceHandle ?? null,
		targetHandle: targetHandle ?? null,
	};
}

/** `startId` and every node reachable from it along the edges. */
function downstreamOf(startId: string, edges: Edge[]): Set<string> {
	const reached = new Set<string>([startId]);
	const queue = [startId];
	while (queue.length > 0) {
		const current = queue.shift();
		for (const edge of edges) {
			if (edge.source === current && !reached.has(edge.target)) {
				reached.add(edge.target);
				queue.push(edge.target);
			}
		}
	}
	return reached;
}

/**
 * Put `newNode` between the two ends of an edge: the edge is replaced by
 * source → new → target (keeping the source's branch handle), the new step
 * takes the target's place, and the target with everything after it moves
 * down one row so nothing overlaps. Returns null for an unknown edge.
 */
export function insertStepOnEdge(
	state: GraphState,
	edgeId: string,
	newNode: Node,
): GraphState | null {
	const edge = state.edges.find((e) => e.id === edgeId);
	const target = edge
		? state.nodes.find((n) => n.id === edge.target)
		: undefined;
	if (!edge || !target) {
		return null;
	}

	const shifted = downstreamOf(target.id, state.edges);
	const nodes = state.nodes.map((node) =>
		shifted.has(node.id)
			? {
					...node,
					position: {
						x: node.position.x,
						y: node.position.y + STEP_SPACING_Y,
					},
				}
			: node,
	);

	return {
		nodes: [...nodes, { ...newNode, position: { ...target.position } }],
		edges: [
			...state.edges.filter((e) => e.id !== edgeId),
			connectingEdge(edge.source, newNode.id, edge.sourceHandle),
			connectingEdge(newNode.id, edge.target, null, edge.targetHandle),
		],
	};
}

/**
 * The step a new one follows: the lowest step nothing leads out of, or the
 * lowest step at all when every step has a successor.
 */
export function lastStep(state: GraphState): Node | undefined {
	const steps = state.nodes.filter(isStepNode);
	const leaves = steps.filter(
		(node) => !state.edges.some((edge) => edge.source === node.id),
	);
	const candidates = leaves.length > 0 ? leaves : steps;
	return candidates.reduce<Node | undefined>(
		(lowest, node) =>
			!lowest ||
			node.position.y > lowest.position.y ||
			(node.position.y === lowest.position.y &&
				node.position.x > lowest.position.x)
				? node
				: lowest,
		undefined,
	);
}

/**
 * Add `newNode` one row below the last step and wire the two together. A
 * branching step (a condition) has no single handle to continue from, so the
 * new step is placed but left for the user to connect. The empty-canvas
 * placeholder is dropped.
 */
export function appendStep(state: GraphState, newNode: Node): GraphState {
	const nodes = state.nodes.filter((n) => n.type !== "add");
	const previous = lastStep(state);
	if (!previous) {
		return {
			nodes: [...nodes, { ...newNode, position: { x: 0, y: 0 } }],
			edges: state.edges,
		};
	}

	const placed = {
		...newNode,
		position: {
			x: previous.position.x,
			y: previous.position.y + STEP_SPACING_Y,
		},
	};
	const wire = !BRANCHING_NODE_TYPES.has(previous.type ?? "");
	return {
		nodes: [...nodes, placed],
		edges: wire
			? [...state.edges, connectingEdge(previous.id, placed.id)]
			: state.edges,
	};
}

/**
 * Turn a placeholder step into the action picked for it. The node gets a new
 * id (its type is part of it), so the edges that led into and out of the
 * placeholder are moved onto the new id rather than left dangling.
 */
export function replacePlaceholder(
	state: GraphState,
	placeholderId: string,
	replacement: Pick<Node, "id" | "type" | "data">,
): GraphState {
	return {
		nodes: state.nodes.map((node) =>
			node.id === placeholderId ? { ...node, ...replacement } : node,
		),
		edges: state.edges.map((edge) => {
			if (
				edge.source !== placeholderId &&
				edge.target !== placeholderId
			) {
				return edge;
			}
			const source =
				edge.source === placeholderId ? replacement.id : edge.source;
			const target =
				edge.target === placeholderId ? replacement.id : edge.target;
			return {
				...edge,
				...connectingEdge(
					source,
					target,
					edge.sourceHandle,
					edge.targetHandle,
				),
			};
		}),
	};
}

function byPosition(a: Node, b: Node) {
	return a.position.y - b.position.y || a.position.x - b.position.x;
}

/**
 * Steps in reading order: from each starting step (nothing leads into it),
 * breadth first along the edges, then anything unreachable by position.
 * This is the numbering the inspector's step list shows.
 */
export function orderSteps<T extends Node>(nodes: T[], edges: Edge[]): T[] {
	const steps = nodes.filter(isStepNode);
	const ids = new Set(steps.map((n) => n.id));
	const byId = new Map(steps.map((n) => [n.id, n]));
	const hasIncoming = new Set(
		edges
			.filter((e) => ids.has(e.source) && ids.has(e.target))
			.map((e) => e.target),
	);

	const ordered: T[] = [];
	const seen = new Set<string>();
	const queue = steps
		.filter((n) => !hasIncoming.has(n.id))
		.sort(byPosition)
		.map((n) => n.id);

	while (queue.length > 0) {
		const id = queue.shift();
		const node = id ? byId.get(id) : undefined;
		if (!node || seen.has(node.id)) {
			continue;
		}
		seen.add(node.id);
		ordered.push(node);
		const children = edges
			.filter((e) => e.source === node.id)
			.map((e) => byId.get(e.target))
			.filter((n): n is T => n !== undefined && !seen.has(n.id))
			.sort(byPosition);
		queue.push(...children.map((n) => n.id));
	}

	const rest = steps.filter((n) => !seen.has(n.id)).sort(byPosition);
	return [...ordered, ...rest];
}

/** Whether any two step cards would sit on top of each other. */
export function hasOverlappingSteps(nodes: Node[]): boolean {
	const steps = nodes.filter(isStepNode);
	return steps.some((a, i) =>
		steps
			.slice(i + 1)
			.some(
				(b) =>
					Math.abs(a.position.x - b.position.x) < STEP_NODE_WIDTH &&
					Math.abs(a.position.y - b.position.y) < STEP_NODE_HEIGHT,
			),
	);
}

/**
 * Arrange the steps top to bottom: one row per depth from the start, with
 * sibling branches side by side and centred. Placeholders keep their place.
 */
function layoutTopToBottom<T extends Node>(nodes: T[], edges: Edge[]): T[] {
	const ordered = orderSteps(nodes, edges);
	const depth = new Map<string, number>();
	for (const node of ordered) {
		const parents = edges
			.filter((e) => e.target === node.id && depth.has(e.source))
			.map((e) => depth.get(e.source) ?? 0);
		depth.set(node.id, parents.length > 0 ? Math.max(...parents) + 1 : 0);
	}

	const rows = new Map<number, string[]>();
	for (const node of ordered) {
		const row = depth.get(node.id) ?? 0;
		rows.set(row, [...(rows.get(row) ?? []), node.id]);
	}

	const positions = new Map<string, { x: number; y: number }>();
	for (const [row, ids] of rows) {
		ids.forEach((id, index) => {
			positions.set(id, {
				x:
					(index - (ids.length - 1) / 2) * BRANCH_SPACING_X -
					STEP_NODE_WIDTH / 2,
				y: row * STEP_SPACING_Y,
			});
		});
	}

	return nodes.map((node) => {
		const position = positions.get(node.id);
		return position ? { ...node, position } : node;
	});
}

/**
 * Lay a graph out top to bottom only when its cards would overlap — a
 * workflow placed for the old, narrower left-to-right cards. A graph the user
 * has arranged keeps its positions.
 */
export function withReadableLayout<T extends Node>(
	nodes: T[],
	edges: Edge[],
): T[] {
	return hasOverlappingSteps(nodes) ? layoutTopToBottom(nodes, edges) : nodes;
}

/**
 * The graph as it is saved, run and exported: steps only (no placeholders),
 * and only the fields the workflow stores. The JSON round trip strips the
 * handlers and React internals the canvas attaches to node data.
 */
export function serializeGraph(state: GraphState): {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
} {
	return JSON.parse(
		JSON.stringify({
			nodes: state.nodes
				.filter(isStepNode)
				.map(({ id, type, position, data }) => ({
					id,
					type,
					position,
					data,
				})),
			edges: state.edges.map(
				({ id, source, target, sourceHandle, targetHandle }) => ({
					id,
					source,
					target,
					sourceHandle,
					targetHandle,
				}),
			),
		}),
	);
}
