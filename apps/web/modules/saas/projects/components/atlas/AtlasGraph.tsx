"use client";

/**
 * The Atlas graph canvas (React Flow + dagre).
 *
 * - dagre computes a deterministic top-down layered layout from nodes+edges, so
 *   the same analysis always renders identically (no physics jitter).
 * - If a node has a persisted `layout {x,y}` from `saveLayout`, that takes
 *   precedence over dagre — shared positions are used for everyone (AC#6).
 * - Nodes are draggable; on drag end a debounced `saveLayout` call persists the
 *   changed positions for the active mode (AC#6).
 * - A "Reset layout" affordance clears dragged positions and falls back to
 *   dagre (AC#6).
 * - Nodes are coloured by kind/language via design tokens.
 * - A search box highlights matching nodes and dims the rest.
 * - Zoom / fit / minimap controls are provided; every icon-only control has an
 *   aria-label.
 * - Because a pannable canvas is hard to operate with a keyboard, an
 *   always-available "node list" disclosure lets keyboard / screen-reader users
 *   jump to (select) any node. Entrance fade is gated behind `motion-safe:`.
 */
import {
	Background,
	BackgroundVariant,
	type Connection,
	Controls,
	type Edge,
	type EdgeMouseHandler,
	getNodesBounds,
	getViewportForBounds,
	MiniMap,
	type Node,
	type NodeChange,
	type NodeMouseHandler,
	type NodeTypes,
	ReactFlow,
	ReactFlowProvider,
	useNodesInitialized,
	useNodesState,
	useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
	GraphEdge,
	GraphMode,
	GraphNode,
	AtlasEdgeKind,
	AtlasNodeKind,
} from "@repo/atlas/types";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import dagre from "dagre";
import {
	ArrowUpRightIcon,
	ChevronRightIcon,
	CornerDownRightIcon,
	DownloadIcon,
	FileImageIcon,
	FileTextIcon,
	LayersIcon,
	LayoutGridIcon,
	MaximizeIcon,
	MinusIcon,
	PlusIcon,
	SearchIcon,
	WaypointsIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { resolveNodeCategory } from "./atlas-categories";
import {
	type ConnectionNodeOption,
	type ConnectionRow,
	type EdgeEndpoints,
	SOLO_EDGE_KINDS,
	edgeKindColorVar,
	soloEdgeKindKey,
} from "./atlas-edges";
import {
	type ConnectionEditTarget,
	AtlasConnectionEditDialog,
} from "./AtlasConnectionEditDialog";
import {
	type ConnectionsCreateInput,
	AtlasConnectionsList,
} from "./AtlasConnectionsList";
import { type LegendConnection, AtlasGraphLegend } from "./AtlasGraphLegend";
import { AtlasGraphNode, type AtlasNodeData } from "./AtlasGraphNode";
import { AtlasStagedEditsBar } from "./AtlasStagedEditsBar";
import {
	endpointSignature,
	type StagedGraphEdits,
} from "./use-staged-graph-edits";
import { fuzzyScore } from "./atlas-utils";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 72;

// Order in which the node list summarises per-kind counts (business value
// first, then technical structure). Kinds with a zero count are skipped.
const KIND_ORDER: AtlasNodeKind[] = [
	"DOMAIN",
	"CAPABILITY",
	"DIRECTORY",
	"MODULE",
	"FILE",
];

// Maps the edge enum to the camelCase i18n keys under `…atlas.node.edgeKind`.
// The literal value union (not `string`) keeps next-intl's typed key check happy.
const EDGE_KIND_KEY: Record<
	AtlasEdgeKind,
	"contains" | "imports" | "dependsOn" | "covers" | "relatesTo"
> = {
	CONTAINS: "contains",
	IMPORTS: "imports",
	DEPENDS_ON: "dependsOn",
	COVERS: "covers",
	RELATES_TO: "relatesTo",
};

/** The edge endpoints + display labels handed to the host when an edge is selected. */
export interface SelectedSoloEdge {
	endpoints: EdgeEndpoints;
	kind: string;
	sourceLabel: string;
	targetLabel: string;
	description: string | null;
	isManual: boolean;
	isUserDescription: boolean;
	deleted: boolean;
}

interface AtlasGraphProps {
	nodes: GraphNode[];
	edges: GraphEdge[];
	selectedKey: string | null;
	onSelectNode: (key: string) => void;
	/** Selecting an edge (canvas click or connections-list row) opens the edge panel. */
	onSelectEdge: (edge: SelectedSoloEdge) => void;
	/** Endpoint key of the currently-selected edge's source (highlights its row + canvas). */
	selectedEdgeKey: string | null;
	projectId: string;
	mode: GraphMode;
	repositoryIntegrationId: string | null;
	/** Lifted "include soft-deleted edges" state (drives the parent's refetch). */
	includeDeleted: boolean;
	onIncludeDeletedChange: (next: boolean) => void;
	/**
	 * Staged structural edits (position moves, connection creates/deletes) for the
	 * active context. Owned by the host so the edge panel (which lives there) can
	 * stage deletes too; discarded by the host when the lens/repo context changes.
	 */
	staged: StagedGraphEdits;
	/** Persist all staged edits (host wires up the mutations). */
	onSaveStaged: () => void;
	/** True while a staged save is in flight. */
	isSavingStaged: boolean;
}

const nodeTypes: NodeTypes = { atlas: AtlasGraphNode };

/** Run dagre over the analysis nodes/edges and return React Flow node positions. */
function layoutGraph(
	nodes: GraphNode[],
	edges: GraphEdge[],
): Map<string, { x: number; y: number }> {
	const g = new dagre.graphlib.Graph();
	g.setGraph({
		rankdir: "TB",
		nodesep: 40,
		ranksep: 80,
		marginx: 24,
		marginy: 24,
	});
	g.setDefaultEdgeLabel(() => ({}));

	for (const node of nodes) {
		g.setNode(node.key, { width: NODE_WIDTH, height: NODE_HEIGHT });
	}
	for (const edge of edges) {
		if (
			nodes.some((n) => n.key === edge.source) &&
			nodes.some((n) => n.key === edge.target)
		) {
			g.setEdge(edge.source, edge.target);
		}
	}

	dagre.layout(g);

	const positions = new Map<string, { x: number; y: number }>();
	for (const node of nodes) {
		const laidOut = g.node(node.key);
		if (laidOut) {
			positions.set(node.key, {
				x: laidOut.x - NODE_WIDTH / 2,
				y: laidOut.y - NODE_HEIGHT / 2,
			});
		} else if (node.layout) {
			positions.set(node.key, node.layout);
		} else {
			positions.set(node.key, { x: 0, y: 0 });
		}
	}
	return positions;
}

/** Merge dagre positions with any persisted `layout` overrides from the server. */
function resolvePositions(
	nodes: GraphNode[],
	dagrePositions: Map<string, { x: number; y: number }>,
	resetKey: number,
): Map<string, { x: number; y: number }> {
	const result = new Map<string, { x: number; y: number }>();
	for (const node of nodes) {
		// When resetKey > 0 the user clicked "Reset layout" — ignore saved positions.
		if (resetKey === 0 && node.layout) {
			result.set(node.key, node.layout);
		} else {
			result.set(
				node.key,
				dagrePositions.get(node.key) ?? { x: 0, y: 0 },
			);
		}
	}
	return result;
}

function GraphCanvas({
	nodes,
	edges,
	selectedKey,
	onSelectNode,
	onSelectEdge,
	selectedEdgeKey,
	projectId,
	mode,
	repositoryIntegrationId,
	includeDeleted,
	onIncludeDeletedChange,
	staged,
	onSaveStaged,
	isSavingStaged,
}: AtlasGraphProps) {
	const t = useTranslations("projects.atlas.graph");
	// Edge-relationship labels live under the sibling `node` namespace; reuse
	// them for the node list's reference sub-items instead of duplicating keys.
	const tNode = useTranslations("projects.atlas.node");
	const tConn = useTranslations("projects.atlas.connections");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const { fitView, zoomIn, zoomOut, getNodes } = useReactFlow();
	const nodesInitialized = useNodesInitialized();
	const [query, setQuery] = useState("");
	const [showList, setShowList] = useState(false);
	// Node list ⇄ Connections list toggle inside the disclosure.
	const [listTab, setListTab] = useState<"nodes" | "connections">("nodes");
	// The node currently under the cursor — drives the neighbourhood edge/node
	// highlight when nothing is pinned by a click (selection always wins).
	const [hoveredKey, setHoveredKey] = useState<string | null>(null);
	// Node-list reference drill-down: rows whose references are pinned open by a
	// click. (Hover shows a peek tooltip; click expands the navigable sub-list.)
	const [pinnedRefs, setPinnedRefs] = useState<Set<string>>(
		() => new Set<string>(),
	);
	const [resetKey, setResetKey] = useState(0);
	// The staged-create id currently being edited (kind + description) in the
	// connection editor dialog — opened on draw and on clicking a provisional edge.
	const [editingCreateId, setEditingCreateId] = useState<string | null>(null);
	const listId = useId();
	const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Wrapper around the React Flow canvas — used to locate the `.react-flow`
	// element for image export.
	const wrapperRef = useRef<HTMLDivElement>(null);
	const [isExporting, setIsExporting] = useState(false);

	const dagrePositions = useMemo(
		() => layoutGraph(nodes, edges),
		[nodes, edges],
	);

	const serverPositions = useMemo(
		() => resolvePositions(nodes, dagrePositions, resetKey),
		[nodes, dagrePositions, resetKey],
	);

	// Overlay any STAGED (not-yet-saved) position moves on top of the resolved
	// server/dagre positions, so a dragged-but-unsaved node renders where the user
	// left it. Cleared when the staged edits are discarded or saved.
	const positions = useMemo(() => {
		if (staged.positions.size === 0) {
			return serverPositions;
		}
		const merged = new Map(serverPositions);
		for (const [id, pos] of staged.positions) {
			merged.set(id, pos);
		}
		return merged;
	}, [serverPositions, staged.positions]);

	const normalizedQuery = useMemo(() => query.trim().toLowerCase(), [query]);
	// Fuzzy match (label + file path) → score per node, so the search tolerates
	// typos / partial words and we can rank results by relevance.
	const matchScores = useMemo(() => {
		if (!normalizedQuery) {
			return null;
		}
		const scores = new Map<string, number>();
		for (const node of nodes) {
			const labelScore = fuzzyScore(normalizedQuery, node.label);
			const pathScore = node.filePath
				? fuzzyScore(normalizedQuery, node.filePath)
				: null;
			if (labelScore === null && pathScore === null) {
				continue;
			}
			// Label matches outrank path-only matches at equal raw score.
			const best = Math.max(
				labelScore !== null ? labelScore + 2 : Number.NEGATIVE_INFINITY,
				pathScore ?? Number.NEGATIVE_INFINITY,
			);
			scores.set(node.key, best);
		}
		return scores;
	}, [nodes, normalizedQuery]);

	const matchedKeys = useMemo(
		() => (matchScores ? new Set(matchScores.keys()) : null),
		[matchScores],
	);

	// Node-list ordering: while searching, show only matches, best-ranked first;
	// otherwise the full graph order.
	const displayedNodes = useMemo(() => {
		if (!matchScores) {
			return nodes;
		}
		return nodes
			.filter((node) => matchScores.has(node.key))
			.sort(
				(a, b) =>
					(matchScores.get(b.key) ?? 0) -
					(matchScores.get(a.key) ?? 0),
			);
	}, [nodes, matchScores]);

	// Lookup by key — used to resolve reference targets to their label/kind.
	const nodeByKey = useMemo(() => {
		const map = new Map<string, GraphNode>();
		for (const node of nodes) {
			map.set(node.key, node);
		}
		return map;
	}, [nodes]);

	// Outgoing edges per node (the nodes this one references / contains), so the
	// node list can offer a drill-down to the leaves.
	const outgoingByKey = useMemo(() => {
		const map = new Map<string, GraphEdge[]>();
		for (const edge of edges) {
			const list = map.get(edge.source);
			if (list) {
				list.push(edge);
			} else {
				map.set(edge.source, [edge]);
			}
		}
		return map;
	}, [edges]);

	// Per-kind totals for the node-list summary header (zero counts dropped).
	const kindCounts = useMemo(() => {
		const counts = new Map<AtlasNodeKind, number>();
		for (const node of nodes) {
			counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
		}
		return KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => ({
			kind,
			count: counts.get(kind) ?? 0,
		}));
	}, [nodes]);

	// Undirected adjacency + per-node connection count (in + out edges). The
	// adjacency drives the hover/selection neighbourhood highlight; the count
	// feeds each node card's "· N links" meta line.
	const { neighbors, connectionCountByKey } = useMemo(() => {
		const adjacency = new Map<string, Set<string>>();
		const counts = new Map<string, number>();
		for (const node of nodes) {
			adjacency.set(node.key, new Set<string>());
		}
		for (const edge of edges) {
			adjacency.get(edge.source)?.add(edge.target);
			adjacency.get(edge.target)?.add(edge.source);
			counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
			counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
		}
		return { neighbors: adjacency, connectionCountByKey: counts };
	}, [nodes, edges]);

	// A click-pinned selection always wins over a transient hover, so the
	// neighbourhood highlight stays stable while the user reads a node's detail.
	const activeKey = selectedKey ?? hoveredKey;
	const activeSet = useMemo(() => {
		if (!activeKey) {
			return null;
		}
		return new Set<string>([
			activeKey,
			...(neighbors.get(activeKey) ?? []),
		]);
	}, [activeKey, neighbors]);

	const flowNodes = useMemo<Node<AtlasNodeData>[]>(
		() =>
			nodes.map((node) => {
				const matched = matchedKeys?.has(node.key) ?? false;
				return {
					id: node.key,
					type: "atlas",
					position: positions.get(node.key) ?? { x: 0, y: 0 },
					data: {
						label: node.label,
						kind: node.kind,
						language: node.language,
						filePath: node.filePath,
						description: node.description,
						category: node.category,
						metrics: node.metrics,
						connectionCount:
							connectionCountByKey.get(node.key) ?? 0,
						selected: node.key === selectedKey,
						// Fade nodes outside the active neighbourhood, or outside
						// the search matches when a query is active.
						dimmed:
							(matchedKeys !== null && !matched) ||
							(activeSet !== null && !activeSet.has(node.key)),
						matched,
					},
					selected: node.key === selectedKey,
				};
			}),
		[
			nodes,
			positions,
			selectedKey,
			matchedKeys,
			activeSet,
			connectionCountByKey,
		],
	);

	// React Flow owns the live node state: drag positions AND the measured
	// dimensions from its ResizeObserver. Seed it with the computed nodes, then
	// sync prop-driven changes in — preserving each node's measured size (so the
	// MiniMap can actually draw the nodes) and live drag position, only
	// re-applying layout when the dagre / server / reset layout truly changes.
	const [rfNodes, setRfNodes, onNodesChangeInternal] =
		useNodesState<Node<AtlasNodeData>>(flowNodes);
	const layoutSyncRef = useRef({ positions, resetKey });
	useEffect(() => {
		const layoutChanged =
			layoutSyncRef.current.positions !== positions ||
			layoutSyncRef.current.resetKey !== resetKey;
		layoutSyncRef.current = { positions, resetKey };
		setRfNodes((prev) => {
			const prevById = new Map(prev.map((n) => [n.id, n]));
			return flowNodes.map((node) => {
				const existing = prevById.get(node.id);
				if (!existing) {
					return node;
				}
				return {
					...node,
					position: layoutChanged ? node.position : existing.position,
					measured: existing.measured,
					width: existing.width,
					height: existing.height,
				};
			});
		});
	}, [flowNodes, positions, resetKey, setRfNodes]);

	// Endpoint signature for a solo edge (both endpoints share the host repo), used
	// to match against staged deletes — must mirror `endpointSignature` so the
	// edge panel's delete (keyed the same way) hides the right edge here.
	const soloSignature = useCallback(
		(source: string, target: string) =>
			endpointSignature({
				sourceRepositoryIntegrationId: repositoryIntegrationId,
				sourceKey: source,
				targetRepositoryIntegrationId: repositoryIntegrationId,
				targetKey: target,
			}),
		[repositoryIntegrationId],
	);

	// React Flow edge id → the underlying GraphEdge, so an edge click maps back to
	// the source/target/kind we need to open the edge panel.
	const edgeById = useMemo(() => {
		const map = new Map<string, GraphEdge>();
		edges.forEach((edge, index) => {
			map.set(`${edge.source}__${edge.target}__${index}`, edge);
		});
		return map;
	}, [edges]);

	const flowEdges = useMemo<Edge[]>(() => {
		const result: Edge[] = [];
		edges.forEach((edge, index) => {
			// Hide an edge the user has staged for deletion (not yet persisted).
			if (staged.deletes.has(soloSignature(edge.source, edge.target))) {
				return;
			}
			result.push(buildServerEdge(edge, index));
		});
		// Append PROVISIONAL edges for staged creates — dashed + muted, with a
		// distinct id so a click can drop them from the staged creates.
		for (const create of staged.creates) {
			const sourceActive = activeSet?.has(create.sourceNodeId) ?? false;
			const targetActive = activeSet?.has(create.targetNodeId) ?? false;
			const highlighted = sourceActive && targetActive;
			const dimmed = activeSet !== null && !highlighted;
			result.push({
				id: `pending__${create.id}`,
				source: create.sourceNodeId,
				target: create.targetNodeId,
				animated: false,
				selectable: true,
				focusable: true,
				interactionWidth: 14,
				data: { pendingCreateId: create.id },
				style: {
					stroke: "var(--primary)",
					strokeWidth: 2,
					strokeDasharray: "6 4",
					opacity: dimmed ? 0.4 : 0.85,
					transition: "stroke 150ms, opacity 150ms",
					cursor: "pointer",
				},
			});
		}
		return result;

		function buildServerEdge(edge: GraphEdge, index: number): Edge {
			// Highlight an edge only when BOTH endpoints sit in the active
			// neighbourhood; dim every other edge while a neighbourhood (or a
			// search) is active, otherwise fall back to the subtle resting look.
			const sourceActive = activeSet?.has(edge.source) ?? false;
			const targetActive = activeSet?.has(edge.target) ?? false;
			const highlighted = sourceActive && targetActive;
			const matchesSearch =
				matchedKeys === null ||
				matchedKeys.has(edge.source) ||
				matchedKeys.has(edge.target);
			const dimmed =
				(activeSet !== null && !highlighted) || !matchesSearch;
			const baseWidth = edge.weight && edge.weight > 1 ? 2 : 1;
			// An edge carrying a user description / manual flag / soft-delete is a
			// user-managed CONNECTION — make it clickable to open the edge panel.
			const isEdited =
				edge.isManual ||
				edge.isUserDescription ||
				!!edge.description ||
				edge.deleted;
			const isSelected =
				selectedEdgeKey !== null &&
				selectedEdgeKey === `${edge.source}__${edge.target}`;
			return {
				id: `${edge.source}__${edge.target}__${index}`,
				source: edge.source,
				target: edge.target,
				animated: false,
				// Edges are clickable to open the connection panel; a wider hit
				// area + pointer cursor only when interactive so the canvas can
				// still pan where edges don't carry a connection affordance.
				selectable: true,
				focusable: true,
				interactionWidth: 14,
				style: {
					// At rest, colour the edge by its relationship KIND (the legend
					// keys these), so the solo graph reads like the System map. A
					// selection / neighbourhood highlight still wins with `--primary`;
					// an edited (user-managed) connection reads as a tint of its own
					// kind hue toward the resting border so it stays distinguishable.
					stroke: isSelected
						? "var(--primary)"
						: highlighted
							? "var(--primary)"
							: isEdited
								? `color-mix(in srgb, ${edgeKindColorVar(edge.kind)} 65%, var(--border))`
								: edgeKindColorVar(edge.kind),
					strokeWidth: isSelected ? 2.5 : highlighted ? 2 : baseWidth,
					strokeDasharray: edge.deleted ? "5 4" : undefined,
					opacity: edge.deleted
						? 0.4
						: isSelected || highlighted
							? 0.95
							: dimmed
								? 0.06
								: 1,
					transition: "stroke 150ms, opacity 150ms",
					cursor: "pointer",
				},
			};
		}
	}, [
		edges,
		activeSet,
		matchedKeys,
		selectedEdgeKey,
		staged.deletes,
		staged.creates,
		soloSignature,
	]);

	// The distinct connection KINDS visible on the current graph, in canonical
	// `SOLO_EDGE_KINDS` order, each with its per-kind colour token + localised
	// label. Feeds the legend's "Connections" key so it never lists a kind the
	// canvas isn't drawing. Staged deletes are excluded to mirror `flowEdges`.
	const legendConnections = useMemo<LegendConnection[]>(() => {
		const present = new Set<string>();
		for (const edge of edges) {
			if (staged.deletes.has(soloSignature(edge.source, edge.target))) {
				continue;
			}
			present.add(edge.kind);
		}
		for (const create of staged.creates) {
			present.add(create.kind);
		}
		return SOLO_EDGE_KINDS.filter((kind) => present.has(kind)).map(
			(kind) => {
				const key = soloEdgeKindKey(kind);
				return {
					kind,
					label: key ? tNode(`edgeKind.${key}`) : kind,
					colorVar: edgeKindColorVar(kind),
				};
			},
		);
	}, [edges, staged.deletes, staged.creates, soloSignature, tNode]);

	// Hover wiring for the neighbourhood highlight. Selection (a click) pins the
	// active node, so a hover only matters when nothing is selected.
	const handleNodeMouseEnter = useCallback<NodeMouseHandler>(
		(_event, node) => setHoveredKey(node.id),
		[],
	);
	const handleNodeMouseLeave = useCallback<NodeMouseHandler>(
		() => setHoveredKey(null),
		[],
	);

	const handleNodeClick = useCallback<NodeMouseHandler>(
		(_event, node) => {
			onSelectNode(node.id);
		},
		[onSelectNode],
	);

	// Localised label for a solo edge kind — reuses the node namespace's edgeKind
	// keys (falling back to the raw value for any unknown kind).
	const kindLabel = useCallback(
		(kind: string) => {
			switch (kind) {
				case "CONTAINS":
					return tNode("edgeKind.contains");
				case "IMPORTS":
					return tNode("edgeKind.imports");
				case "DEPENDS_ON":
					return tNode("edgeKind.dependsOn");
				case "COVERS":
					return tNode("edgeKind.covers");
				case "RELATES_TO":
					return tNode("edgeKind.relatesTo");
				default:
					return kind;
			}
		},
		[tNode],
	);

	// Build the `SelectedSoloEdge` payload for a GraphEdge — both endpoints share
	// the host's repositoryIntegrationId (a solo edge never crosses repos).
	const toSelectedEdge = useCallback(
		(edge: GraphEdge) => ({
			endpoints: {
				sourceRepositoryIntegrationId: repositoryIntegrationId,
				sourceKey: edge.source,
				targetRepositoryIntegrationId: repositoryIntegrationId,
				targetKey: edge.target,
			} satisfies EdgeEndpoints,
			kind: edge.kind,
			sourceLabel: nodeByKey.get(edge.source)?.label ?? edge.source,
			targetLabel: nodeByKey.get(edge.target)?.label ?? edge.target,
			description: edge.description ?? null,
			isManual: edge.isManual ?? false,
			isUserDescription: edge.isUserDescription ?? false,
			deleted: edge.deleted ?? false,
		}),
		[repositoryIntegrationId, nodeByKey],
	);

	const handleEdgeClick = useCallback<EdgeMouseHandler>(
		(_event, edge) => {
			// Clicking a PROVISIONAL (staged-create) edge opens its editor so the
			// user can pick the relationship kind + description (not remove it).
			const pendingCreateId = (
				edge.data as { pendingCreateId?: string } | undefined
			)?.pendingCreateId;
			if (pendingCreateId) {
				setEditingCreateId(pendingCreateId);
				return;
			}
			const graphEdge = edgeById.get(edge.id);
			if (graphEdge) {
				onSelectEdge(toSelectedEdge(graphEdge));
			}
		},
		[edgeById, onSelectEdge, toSelectedEdge],
	);

	// Normalised connection rows + pickable nodes for the Connections list. The
	// staged overlay is applied here too: pending-deleted edges are hidden, and
	// pending-created edges appear as provisional rows (so the list mirrors the
	// canvas).
	const connectionRows = useMemo<ConnectionRow[]>(() => {
		const rows: ConnectionRow[] = [];
		edges.forEach((edge, index) => {
			if (staged.deletes.has(soloSignature(edge.source, edge.target))) {
				return;
			}
			rows.push({
				id: `${edge.source}__${edge.target}__${index}`,
				kind: edge.kind,
				sourceLabel: nodeByKey.get(edge.source)?.label ?? edge.source,
				targetLabel: nodeByKey.get(edge.target)?.label ?? edge.target,
				description: edge.description ?? null,
				isManual: edge.isManual ?? false,
				isUserDescription: edge.isUserDescription ?? false,
				deleted: edge.deleted ?? false,
				endpoints: {
					sourceRepositoryIntegrationId: repositoryIntegrationId,
					sourceKey: edge.source,
					targetRepositoryIntegrationId: repositoryIntegrationId,
					targetKey: edge.target,
				},
			});
		});
		for (const create of staged.creates) {
			rows.push({
				id: `pending__${create.id}`,
				kind: create.kind,
				sourceLabel:
					nodeByKey.get(create.endpoints.sourceKey)?.label ??
					create.endpoints.sourceKey,
				targetLabel:
					nodeByKey.get(create.endpoints.targetKey)?.label ??
					create.endpoints.targetKey,
				description: create.description ?? null,
				isManual: true,
				isUserDescription: false,
				deleted: false,
				endpoints: create.endpoints,
			});
		}
		return rows;
	}, [
		edges,
		nodeByKey,
		repositoryIntegrationId,
		staged.deletes,
		staged.creates,
		soloSignature,
	]);

	const connectionNodeOptions = useMemo<ConnectionNodeOption[]>(
		() =>
			nodes.map((node) => ({
				key: node.key,
				label: node.label,
				repositoryIntegrationId,
			})),
		[nodes, repositoryIntegrationId],
	);

	// Restore wiring for the Connections list. Restore operates on already-persisted
	// soft-deleted server state, so it stays IMMEDIATE (not staged) — re-adding a
	// previously-removed connection is a direct server mutation. Connection CREATEs,
	// by contrast, are staged (see `handleCreateConnection` / `handleConnect`).
	const restoreEdgeMutation = useMutation(
		orpc.atlas.restoreEdge.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.graph.key(),
				});
				toast.success(tConn("restoreSuccess"));
			},
			onError: (error) => {
				toast.error(tConn("restoreError"), {
					description:
						error instanceof Error ? error.message : String(error),
				});
			},
		}),
	);

	// "+ New connection" (list form) STAGES a create instead of persisting it —
	// the user reviews it on the canvas (provisional dashed edge) and Saves.
	const handleCreateConnection = useCallback(
		(input: ConnectionsCreateInput) => {
			const endpoints: EdgeEndpoints = {
				sourceRepositoryIntegrationId: repositoryIntegrationId,
				sourceKey: input.source.key,
				targetRepositoryIntegrationId: repositoryIntegrationId,
				targetKey: input.target.key,
			};
			staged.stageCreate({
				id: endpointSignature(endpoints),
				endpoints,
				kind: input.kind,
				description: input.description || undefined,
				sourceNodeId: input.source.key,
				targetNodeId: input.target.key,
			});
		},
		[staged, repositoryIntegrationId],
	);

	const handleRestoreConnection = useCallback(
		(row: ConnectionRow) => {
			if (!row.endpoints) {
				return;
			}
			restoreEdgeMutation.mutate({
				projectId,
				mode,
				sourceRepositoryIntegrationId:
					row.endpoints.sourceRepositoryIntegrationId,
				sourceKey: row.endpoints.sourceKey,
				targetRepositoryIntegrationId:
					row.endpoints.targetRepositoryIntegrationId,
				targetKey: row.endpoints.targetKey,
				organizationId: organizationId ?? null,
			});
		},
		[restoreEdgeMutation, projectId, mode, organizationId],
	);

	// Draw a connection on the canvas (drag from one card to another): RF node ids
	// are the node keys. STAGE the create (provisional dashed edge) rather than
	// persisting it, then immediately open the editor so the user picks the
	// relationship kind + description. Defaults to RELATES_TO until they change it;
	// the user Saves the whole draft to commit.
	const handleConnect = useCallback(
		(connection: Connection) => {
			const { source, target } = connection;
			if (!source || !target || source === target) {
				return;
			}
			const endpoints: EdgeEndpoints = {
				sourceRepositoryIntegrationId: repositoryIntegrationId,
				sourceKey: source,
				targetRepositoryIntegrationId: repositoryIntegrationId,
				targetKey: target,
			};
			const id = endpointSignature(endpoints);
			staged.stageCreate({
				id,
				endpoints,
				kind: "RELATES_TO",
				sourceNodeId: source,
				targetNodeId: target,
			});
			setEditingCreateId(id);
		},
		[staged, repositoryIntegrationId],
	);

	const handleSelectConnectionRow = useCallback(
		(row: ConnectionRow) => {
			// A provisional (staged-create) row isn't persisted — clicking it opens
			// its editor (kind + description) rather than the server-backed panel.
			if (row.id.startsWith("pending__")) {
				setEditingCreateId(row.id.slice("pending__".length));
				return;
			}
			const graphEdge = edgeById.get(row.id);
			if (graphEdge) {
				onSelectEdge(toSelectedEdge(graphEdge));
			}
		},
		[edgeById, onSelectEdge, toSelectedEdge],
	);

	// The pending create currently open in the connection editor (resolves its
	// endpoint labels), or null when the editor is closed. Falls back to closed if
	// the create was discarded out from under it (e.g. on a Save/Discard).
	const editTarget = useMemo<ConnectionEditTarget | null>(() => {
		if (!editingCreateId) {
			return null;
		}
		const create = staged.creates.find((c) => c.id === editingCreateId);
		if (!create) {
			return null;
		}
		return {
			id: create.id,
			sourceLabel:
				nodeByKey.get(create.endpoints.sourceKey)?.label ??
				create.endpoints.sourceKey,
			targetLabel:
				nodeByKey.get(create.endpoints.targetKey)?.label ??
				create.endpoints.targetKey,
			kind: create.kind,
			description: create.description ?? "",
		};
	}, [editingCreateId, staged.creates, nodeByKey]);

	const handleEditorSave = useCallback(
		(id: string, kind: string, description: string) => {
			staged.updateCreate(id, { kind, description });
			setEditingCreateId(null);
		},
		[staged],
	);
	const handleEditorRemove = useCallback(
		(id: string) => {
			staged.removeCreate(id);
			setEditingCreateId(null);
		},
		[staged],
	);
	const handleEditorCancel = useCallback(() => setEditingCreateId(null), []);

	// Select a node and frame it — shared by the node list rows and their
	// reference sub-items (so users can hop from a node to the leaves it touches).
	const focusNode = useCallback(
		(key: string) => {
			onSelectNode(key);
			fitView({ nodes: [{ id: key }], duration: 300, padding: 0.4 });
		},
		[onSelectNode, fitView],
	);

	// Pin/unpin a row's reference sub-list open (hover gives a transient preview;
	// a click keeps it open so the sub-items stay clickable after the mouse moves).
	const togglePinnedRef = useCallback((key: string) => {
		setPinnedRefs((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}, []);

	// Export the rendered graph as a PNG image or a PDF, framed to fit every
	// node. Uses `html-to-image` (dynamically imported) — it rasterises the SVG
	// edges that html2canvas drops; jspdf is loaded only for the PDF path. The
	// capture target is the React Flow viewport (nodes + edges only, no chrome).
	const exportImage = useCallback(
		async (format: "png" | "pdf") => {
			const rfEl =
				wrapperRef.current?.querySelector<HTMLElement>(".react-flow");
			const viewportEl = wrapperRef.current?.querySelector<HTMLElement>(
				".react-flow__viewport",
			);
			const allNodes = getNodes();
			if (!rfEl || !viewportEl || allNodes.length === 0) {
				return;
			}
			setIsExporting(true);
			// Edge style overrides to undo after the capture (live graph unchanged).
			const restoreEdges: Array<() => void> = [];
			try {
				const { toPng } = await import("html-to-image");
				// The `.react-flow` element itself is transparent, so walk up to
				// the nearest opaque ancestor (graph card / page) for a
				// theme-correct background — otherwise html2canvas flattens the
				// transparent backdrop to black.
				let background = "";
				for (
					let bgEl: HTMLElement | null = rfEl;
					bgEl;
					bgEl = bgEl.parentElement
				) {
					const candidate = getComputedStyle(bgEl).backgroundColor;
					if (
						candidate &&
						candidate !== "rgba(0, 0, 0, 0)" &&
						candidate !== "transparent"
					) {
						background = candidate;
						break;
					}
				}
				if (!background) {
					background = "#ffffff";
				}
				// Edges use the subtle `--border` token — too faint to read in an
				// exported still. Darken them for the capture only, then restore.
				const isDarkTheme =
					document.documentElement.classList.contains("dark");
				const exportStroke = isDarkTheme
					? "rgba(255, 255, 255, 0.55)"
					: "rgba(15, 23, 42, 0.45)";
				for (const path of viewportEl.querySelectorAll<SVGPathElement>(
					".react-flow__edge-path",
				)) {
					const prevStroke = path.style.stroke;
					const prevWidth = path.style.strokeWidth;
					path.style.stroke = exportStroke;
					path.style.strokeWidth = "2";
					restoreEdges.push(() => {
						path.style.stroke = prevStroke;
						path.style.strokeWidth = prevWidth;
					});
				}
				// Frame every node into a fixed-size image at full resolution.
				const bounds = getNodesBounds(allNodes);
				const width = Math.round(
					Math.min(2800, Math.max(1200, bounds.width + 240)),
				);
				const height = Math.round(
					Math.min(2800, Math.max(800, bounds.height + 240)),
				);
				const viewport = getViewportForBounds(
					bounds,
					width,
					height,
					0.2,
					2,
					0.12,
				);
				const dataUrl = await toPng(viewportEl, {
					backgroundColor: background,
					width,
					height,
					pixelRatio: 2,
					style: {
						width: `${width}px`,
						height: `${height}px`,
						transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
					},
				});
				const base = `atlas-graph-${mode.toLowerCase()}`;
				if (format === "png") {
					const anchor = document.createElement("a");
					anchor.href = dataUrl;
					anchor.download = `${base}.png`;
					document.body.appendChild(anchor);
					anchor.click();
					anchor.remove();
				} else {
					const { jsPDF } = await import("jspdf");
					const orientation =
						width >= height ? "landscape" : "portrait";
					const pdf = new jsPDF({
						orientation,
						unit: "px",
						format: [width, height],
						compress: true,
					});
					// `compress` + FAST image compression keep the PDF small —
					// without it jsPDF embeds the image raw (tens of MB).
					pdf.addImage(
						dataUrl,
						"PNG",
						0,
						0,
						width,
						height,
						undefined,
						"FAST",
					);
					pdf.save(`${base}.pdf`);
				}
				toast.success(t("exportImageDone"));
			} catch {
				toast.error(t("exportImageError"));
			} finally {
				for (const restore of restoreEdges) {
					restore();
				}
				setIsExporting(false);
			}
		},
		[getNodes, mode, t],
	);

	/**
	 * Apply React Flow changes (live drag + measured dimensions), then STAGE the
	 * final dragged position on drag-stop. React Flow owns the smooth live drag;
	 * only the committed (drag-finished) position is written into the staged set —
	 * no per-frame state thrash, and nothing auto-persists (the user Saves).
	 */
	const handleNodesChange = useCallback(
		(changes: NodeChange<Node<AtlasNodeData>>[]) => {
			// Keep React Flow's state in sync — applies drag positions AND the
			// dimension changes the MiniMap relies on to render the nodes.
			onNodesChangeInternal(changes);

			const finished = changes.filter(
				(
					c,
				): c is NodeChange<Node<AtlasNodeData>> & {
					type: "position";
					id: string;
					position?: { x: number; y: number };
					dragging?: boolean;
				} =>
					c.type === "position" &&
					c.dragging === false &&
					c.position !== undefined,
			);
			if (finished.length === 0) {
				return;
			}
			staged.stagePositions(
				finished
					.filter((c) => c.position)
					.map((c) => ({
						id: c.id,
						position: c.position as { x: number; y: number },
					})),
			);
		},
		[onNodesChangeInternal, staged],
	);

	// Cleanup the reset-fit timer on unmount.
	useEffect(() => {
		return () => {
			if (resetTimerRef.current) {
				clearTimeout(resetTimerRef.current);
			}
		};
	}, []);

	// When a search produces matches, gently frame them.
	useEffect(() => {
		if (matchedKeys && matchedKeys.size > 0) {
			const ids = [...matchedKeys].map((id) => ({ id }));
			fitView({ nodes: ids, duration: 300, padding: 0.3 });
		}
	}, [matchedKeys, fitView]);

	// Pan to a newly-selected node.
	useEffect(() => {
		if (selectedKey) {
			fitView({
				nodes: [{ id: selectedKey }],
				duration: 300,
				padding: 0.4,
			});
		}
	}, [selectedKey, fitView]);

	// Re-frame the whole graph when the dataset changes (mode / repo switch or a
	// fresh analysis), once React Flow has measured the new nodes — so the graph
	// always opens centred instead of off-screen. The signature guard stops it
	// from fighting the user's own panning of an already-loaded graph.
	const fitSignature = `${flowNodes.length}:${flowNodes[0]?.id ?? ""}:${
		flowNodes.at(-1)?.id ?? ""
	}`;
	const lastFitRef = useRef<string>("");
	useEffect(() => {
		if (!nodesInitialized || flowNodes.length === 0) {
			return;
		}
		if (lastFitRef.current === fitSignature) {
			return;
		}
		lastFitRef.current = fitSignature;
		fitView({ duration: 300, padding: 0.2 });
	}, [nodesInitialized, fitSignature, flowNodes.length, fitView]);

	const minimapNodeColor = useCallback(
		(node: Node<AtlasNodeData>) => resolveNodeCategory(node.data).colorVar,
		[],
	);

	// "Reset layout" re-runs the automatic dagre arrangement, but STAGES the new
	// positions rather than persisting them — the Save bar appears so the user can
	// Save (share the reset) or Discard (revert to the previous saved layout).
	const handleReset = useCallback(() => {
		setResetKey((k) => k + 1);
		// Stage every freshly-computed dagre position so the whole re-layout shows
		// up as pending changes.
		const dagrePositionList = [...dagrePositions.entries()].map(
			([id, pos]) => ({ id, position: { x: pos.x, y: pos.y } }),
		);
		staged.stagePositions(dagrePositionList);
		resetTimerRef.current = setTimeout(
			() => fitView({ duration: 300, padding: 0.1 }),
			50,
		);
	}, [dagrePositions, staged, fitView]);

	// When the staged edits are cleared (Save or Discard), undo any "Reset layout"
	// override so the graph reverts to the saved server positions — a Discard after
	// a Reset-layout must restore the previous saved layout, not keep dagre.
	useEffect(() => {
		if (!staged.isDirty && resetKey !== 0) {
			setResetKey(0);
		}
	}, [staged.isDirty, resetKey]);

	return (
		<div
			ref={wrapperRef}
			className="motion-safe:animate-in motion-safe:fade-in flex h-full w-full flex-col"
		>
			{/* Toolbar — search + node-list disclosure, docked ABOVE the map. */}
			<div className="flex items-center gap-2.5 border-b border-border/60 px-3 py-2.5">
				<div className="relative w-full max-w-[300px]">
					<SearchIcon
						aria-hidden="true"
						className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("searchPlaceholder")}
						aria-label={t("searchAria")}
						className="h-9 bg-card pl-8 pr-8"
					/>
					{query && (
						<button
							type="button"
							onClick={() => setQuery("")}
							aria-label={t("searchClear")}
							className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<XIcon aria-hidden="true" className="size-3.5" />
						</button>
					)}
				</div>
				{normalizedQuery && (
					<span className="shrink-0 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground tabular-nums">
						{t("matchCount", { count: matchedKeys?.size ?? 0 })}
					</span>
				)}

				{/* Keyboard / SR fallback: list of nodes / connections to select
				    without panning. The disclosure opens a panel below the button,
				    over the canvas, with a [Nodes | Connections] segmented toggle. */}
				<div className="relative ml-auto shrink-0">
					<Button
						type="button"
						variant="outline"
						size="sm"
						aria-expanded={showList}
						aria-controls={listId}
						onClick={() => setShowList((value) => !value)}
						className="gap-1.5"
					>
						<LayersIcon aria-hidden="true" className="size-4" />
						{t("list")}
					</Button>
					{showList && (
						<section
							id={listId}
							aria-label={
								listTab === "nodes"
									? t("nodeListLabel")
									: tConn("regionLabel")
							}
							className="absolute right-0 top-full z-30 mt-2 max-h-[60vh] w-[19rem] max-w-[85vw] overflow-y-auto rounded-xl border border-border/60 bg-background shadow-md"
						>
							{/* Nodes ⇄ Connections segmented toggle. */}
							<div className="sticky top-0 z-20 flex items-center gap-1 border-b border-border/60 bg-background/95 p-1.5 backdrop-blur-sm">
								<div className="inline-flex w-full items-center gap-1 rounded-lg bg-muted/60 p-0.5">
									{(["nodes", "connections"] as const).map(
										(tab) => (
											<button
												key={tab}
												type="button"
												aria-pressed={listTab === tab}
												onClick={() => setListTab(tab)}
												className={cn(
													"flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
													listTab === tab
														? "bg-card text-foreground shadow-sm"
														: "text-muted-foreground hover:text-foreground",
												)}
											>
												{tab === "nodes" ? (
													<LayersIcon
														aria-hidden="true"
														className="size-3.5"
													/>
												) : (
													<WaypointsIcon
														aria-hidden="true"
														className="size-3.5"
													/>
												)}
												{tab === "nodes"
													? t("nodeList")
													: tConn("tab")}
											</button>
										),
									)}
								</div>
							</div>

							{listTab === "connections" ? (
								<AtlasConnectionsList
									query={query}
									connections={connectionRows}
									nodes={connectionNodeOptions}
									kindOptions={SOLO_EDGE_KINDS}
									kindLabel={kindLabel}
									includeDeleted={includeDeleted}
									onIncludeDeletedChange={
										onIncludeDeletedChange
									}
									onSelectConnection={
										handleSelectConnectionRow
									}
									onRestoreConnection={
										handleRestoreConnection
									}
									onCreateConnection={handleCreateConnection}
									isMutating={restoreEdgeMutation.isPending}
								/>
							) : (
								<>
									{/* Summary header: total + per-kind counts. */}
									<div className="sticky top-[44px] z-10 border-b border-border/60 bg-background/95 px-3 py-2 backdrop-blur-sm">
										<p className="text-sm font-medium text-foreground">
											{t("nodeCount", {
												count: nodes.length,
											})}
										</p>
										{kindCounts.length > 0 && (
											<div className="mt-1.5 flex flex-wrap gap-1">
												{kindCounts.map(
													({ kind, count }) => (
														<span
															key={kind}
															className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
														>
															{t(
																`kindPlural.${kind}`,
																{ count },
															)}
														</span>
													),
												)}
											</div>
										)}
									</div>
									<ul className="flex flex-col p-1">
										{displayedNodes.length === 0 && (
											<li className="px-3 py-3 text-sm text-muted-foreground">
												{t("empty")}
											</li>
										)}
										{displayedNodes.map((node) => {
											const refs =
												outgoingByKey.get(node.key) ??
												[];
											const hasRefs = refs.length > 0;
											const expanded = pinnedRefs.has(
												node.key,
											);
											const refsId = `${listId}-refs-${node.key}`;
											return (
												<li key={node.key}>
													<div className="flex items-stretch gap-1">
														<button
															type="button"
															onClick={() =>
																focusNode(
																	node.key,
																)
															}
															className={cn(
																"flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
																node.key ===
																	selectedKey &&
																	"bg-accent",
															)}
														>
															<span className="w-full truncate font-medium text-foreground">
																{node.label}
															</span>
															{node.filePath && (
																<span className="w-full truncate text-[11px] text-muted-foreground">
																	{
																		node.filePath
																	}
																</span>
															)}
														</button>
														{hasRefs && (
															<Tooltip>
																<TooltipTrigger
																	asChild
																>
																	<button
																		type="button"
																		aria-expanded={
																			expanded
																		}
																		aria-controls={
																			refsId
																		}
																		aria-label={t(
																			"referencesAria",
																			{
																				label: node.label,
																			},
																		)}
																		onClick={() =>
																			togglePinnedRef(
																				node.key,
																			)
																		}
																		className={cn(
																			"flex shrink-0 items-center gap-0.5 rounded-lg px-1.5 text-[11px] tabular-nums transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
																			expanded
																				? "text-foreground"
																				: "text-muted-foreground hover:text-foreground",
																		)}
																	>
																		<ArrowUpRightIcon
																			aria-hidden="true"
																			className="size-3.5"
																		/>
																		{
																			refs.length
																		}
																		<ChevronRightIcon
																			aria-hidden="true"
																			className={cn(
																				"size-3 transition-transform",
																				expanded &&
																					"rotate-90",
																			)}
																		/>
																	</button>
																</TooltipTrigger>
																{/* Hover peek of the referenced nodes (portalled, so
													    it isn't clipped by the list's scroll area); click
													    the icon to expand them inline and navigate. */}
																<TooltipContent
																	side="right"
																	className="max-w-xs"
																>
																	<p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] opacity-70">
																		{t(
																			"referencesTitle",
																		)}
																	</p>
																	<ul className="space-y-0.5">
																		{refs
																			.slice(
																				0,
																				12,
																			)
																			.map(
																				(
																					edge,
																					index,
																				) => (
																					<li
																						key={`${edge.target}-${index}`}
																						className="text-xs"
																					>
																						{nodeByKey.get(
																							edge.target,
																						)
																							?.label ??
																							edge.target}
																						<span className="ml-1 opacity-60">
																							·{" "}
																							{tNode(
																								`edgeKind.${EDGE_KIND_KEY[edge.kind]}`,
																							)}
																						</span>
																					</li>
																				),
																			)}
																		{refs.length >
																			12 && (
																			<li className="text-xs opacity-60">
																				+
																				{refs.length -
																					12}
																			</li>
																		)}
																	</ul>
																</TooltipContent>
															</Tooltip>
														)}
													</div>
													{hasRefs && expanded && (
														<ul
															id={refsId}
															className="mb-1 ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-border/60 pl-2"
														>
															{refs.map(
																(
																	edge,
																	index,
																) => {
																	const target =
																		nodeByKey.get(
																			edge.target,
																		);
																	return (
																		<li
																			key={`${edge.target}-${index}`}
																		>
																			<button
																				type="button"
																				onClick={() =>
																					focusNode(
																						edge.target,
																					)
																				}
																				className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
																			>
																				<CornerDownRightIcon
																					aria-hidden="true"
																					className="size-3 shrink-0 text-muted-foreground"
																				/>
																				<span className="min-w-0 flex-1 truncate text-foreground">
																					{target?.label ??
																						edge.target}
																				</span>
																				<span className="shrink-0 rounded bg-muted px-1 py-0 text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
																					{tNode(
																						`edgeKind.${EDGE_KIND_KEY[edge.kind]}`,
																					)}
																				</span>
																			</button>
																		</li>
																	);
																},
															)}
														</ul>
													)}
												</li>
											);
										})}
									</ul>
								</>
							)}
						</section>
					)}
				</div>
			</div>

			{/* Canvas region — fills the remaining height below the toolbar. */}
			<div className="relative min-h-0 flex-1 bg-background">
				{/* Static brand glow — orients the eye, never animates (no ambient
				    blob). Tokenised so it reads in both light and dark themes. */}
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 z-0"
					style={{
						background:
							"radial-gradient(1000px 520px at 15% -10%, color-mix(in srgb, var(--primary) 8%, transparent), transparent 60%)",
					}}
				/>
				{/* On-map colour key (carries its own absolute positioning). */}
				<AtlasGraphLegend
					nodes={nodes}
					connections={legendConnections}
				/>

				<ReactFlow
					nodes={rfNodes}
					edges={flowEdges}
					nodeTypes={nodeTypes}
					onNodeClick={handleNodeClick}
					onEdgeClick={handleEdgeClick}
					onNodeMouseEnter={handleNodeMouseEnter}
					onNodeMouseLeave={handleNodeMouseLeave}
					onNodesChange={handleNodesChange}
					onConnect={handleConnect}
					minZoom={0.1}
					maxZoom={2}
					proOptions={{ hideAttribution: true }}
					// `relative z-[1]` lifts the (transparent) canvas above the
					// brand-glow layer so the glow tints the empty backdrop while
					// nodes, edges, and dots still paint on top of it.
					className="relative z-[1] !bg-transparent"
				>
					<Background
						variant={BackgroundVariant.Dots}
						gap={26}
						size={1}
						color="color-mix(in srgb, var(--muted-foreground) 28%, transparent)"
					/>
					<Controls
						showInteractive={false}
						showZoom={false}
						showFitView={false}
						className="!shadow-none"
					>
						<Button
							type="button"
							variant="outline"
							size="icon-sm"
							aria-label={t("zoomIn")}
							onClick={() => zoomIn({ duration: 200 })}
						>
							<PlusIcon aria-hidden="true" className="size-4" />
						</Button>
						<Button
							type="button"
							variant="outline"
							size="icon-sm"
							aria-label={t("zoomOut")}
							onClick={() => zoomOut({ duration: 200 })}
						>
							<MinusIcon aria-hidden="true" className="size-4" />
						</Button>
						<Button
							type="button"
							variant="outline"
							size="icon-sm"
							aria-label={t("fitView")}
							onClick={() =>
								fitView({ duration: 200, padding: 0.2 })
							}
						>
							<MaximizeIcon
								aria-hidden="true"
								className="size-4"
							/>
						</Button>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="icon-sm"
									aria-label={t("resetLayout")}
									onClick={handleReset}
								>
									<LayoutGridIcon
										aria-hidden="true"
										className="size-4"
									/>
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{t("resetLayoutTooltip")}
							</TooltipContent>
						</Tooltip>
						<DropdownMenu>
							<Tooltip>
								<TooltipTrigger asChild>
									<DropdownMenuTrigger asChild>
										<Button
											type="button"
											variant="outline"
											size="icon-sm"
											aria-label={t("exportImage")}
											disabled={isExporting}
										>
											<DownloadIcon
												aria-hidden="true"
												className={cn(
													"size-4",
													isExporting &&
														"motion-safe:animate-pulse",
												)}
											/>
										</Button>
									</DropdownMenuTrigger>
								</TooltipTrigger>
								<TooltipContent>
									{t("exportImage")}
								</TooltipContent>
							</Tooltip>
							<DropdownMenuContent side="right" align="end">
								<DropdownMenuItem
									onClick={() => exportImage("png")}
									className="gap-2"
								>
									<FileImageIcon
										aria-hidden="true"
										className="size-4"
									/>
									{t("exportPng")}
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={() => exportImage("pdf")}
									className="gap-2"
								>
									<FileTextIcon
										aria-hidden="true"
										className="size-4"
									/>
									{t("exportPdf")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</Controls>
					<MiniMap
						pannable
						zoomable
						nodeColor={minimapNodeColor}
						nodeStrokeColor="var(--border)"
						nodeStrokeWidth={2}
						maskColor="color-mix(in srgb, var(--background) 60%, transparent)"
						style={{ backgroundColor: "var(--card)" }}
						className="rounded-xl border border-border/40"
					/>
				</ReactFlow>

				{/* Floating Save / Discard bar — only while structural edits are
				    staged (drag, connect, delete, reset-layout). */}
				{staged.isDirty && (
					<AtlasStagedEditsBar
						count={staged.count}
						onSave={onSaveStaged}
						onDiscard={staged.discard}
						isSaving={isSavingStaged}
					/>
				)}
			</div>

			{/* Editor for a freshly-drawn / clicked provisional connection — pick the
			    relationship kind + description before saving the draft. */}
			<AtlasConnectionEditDialog
				target={editTarget}
				kindOptions={SOLO_EDGE_KINDS}
				kindLabel={kindLabel}
				onSave={handleEditorSave}
				onRemove={handleEditorRemove}
				onCancel={handleEditorCancel}
			/>
		</div>
	);
}

export function AtlasGraph(props: AtlasGraphProps) {
	return (
		<ReactFlowProvider>
			<GraphCanvas {...props} />
		</ReactFlowProvider>
	);
}
