"use client";

/**
 * The Atlas "System map" canvas — the multi-repository view.
 *
 * Each connected repository renders as a labelled GROUP CONTAINER (React Flow
 * parent node) holding its own module/capability nodes; cross-repository edges
 * (shared library, dependency, API call, shared domain) are drawn between the
 * specific nodes (or whole repos) involved, visually distinct from intra-repo
 * edges. Layout runs dagre PER repo, then packs the sized containers into a row,
 * so each repo's internal structure stays readable while the cross-repo wiring
 * sits between them.
 *
 * Reuses the single-repo `AtlasGraphNode` for real nodes (same card,
 * category colours, tokens) so the System map feels like the same product. The
 * canvas mirrors the solo graph's behaviours: node-neighbourhood highlighting on
 * select (dim everything outside the selected node + its neighbours), custom
 * zoom/fit controls, a tokenised MiniMap, a static brand glow, and draggable
 * containers/cards whose new positions are persisted via `onLayoutChange`.
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
	Handle,
	MiniMap,
	type Node,
	type NodeChange,
	type NodeMouseHandler,
	type NodeTypes,
	Position,
	ReactFlow,
	ReactFlowProvider,
	useNodesState,
	useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
	GraphMode,
	SystemGraphEdge as SGEdge,
	SystemGraphNode as SGNode,
	SystemCrossEdgeKind,
	SystemGraph,
	AtlasNodeKind,
} from "@repo/atlas/types";
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
	type CSSProperties,
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	type ConnectionNodeOption,
	type ConnectionRow,
	type EdgeEndpoints,
	SYSTEM_EDGE_KINDS,
} from "./atlas-edges";
import {
	type ConnectionEditTarget,
	AtlasConnectionEditDialog,
} from "./AtlasConnectionEditDialog";
import {
	type ConnectionsCreateInput,
	AtlasConnectionsList,
} from "./AtlasConnectionsList";
import { AtlasGraphNode, type AtlasNodeData } from "./AtlasGraphNode";
import { AtlasStagedEditsBar } from "./AtlasStagedEditsBar";
import {
	endpointSignature,
	type StagedGraphEdits,
} from "./use-staged-graph-edits";
import { resolveNodeCategory } from "./atlas-categories";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 72;
const GROUP_HEADER = 46;
const GROUP_PAD = 22;
const GROUP_GAP = 96;

/** Short human label per cross-repo edge kind (also the legend order). */
const CROSS_EDGE_KINDS: SystemCrossEdgeKind[] = [
	"CALLS_API",
	"DEPENDS_ON",
	"SHARES_LIBRARY",
	"RELATES_TO",
];

/**
 * Per-kind cross-edge colour token. Each cross-repo relationship reads in its own
 * design-token hue (never a hardcoded hex) so the System map's relationship
 * vocabulary is legible at a glance and themes correctly in light + dark.
 */
const CROSS_EDGE_COLOR: Record<SystemCrossEdgeKind, string> = {
	CALLS_API: "var(--primary)",
	DEPENDS_ON: "var(--highlight)",
	SHARES_LIBRARY: "var(--secondary)",
	RELATES_TO: "var(--muted-foreground)",
};

/** Neutral MiniMap colour for the synthetic repo-group containers. */
const GROUP_MINIMAP_COLOR = "var(--muted-foreground)";

/** A repo-group container node: a bordered, warm-neutral card with a header. */
const SystemRepoGroupNode = memo(function SystemRepoGroupNode({
	data,
}: {
	data: { label: string };
}) {
	return (
		<div className="relative size-full rounded-2xl border border-border/70 bg-muted/40">
			{/* Hidden handles so repo-level cross-repo edges can attach to the group. */}
			<Handle
				type="target"
				position={Position.Top}
				className="!opacity-0"
				isConnectable={false}
			/>
			<Handle
				type="source"
				position={Position.Bottom}
				className="!opacity-0"
				isConnectable={false}
			/>
			<div className="absolute inset-x-0 top-0 flex items-center gap-2 rounded-t-2xl border-border/60 border-b bg-card/70 px-3 py-2">
				<span
					aria-hidden="true"
					className="size-2 rounded-full bg-primary"
				/>
				<span className="truncate font-medium text-foreground text-sm">
					{data.label}
				</span>
			</div>
		</div>
	);
});

const nodeTypes: NodeTypes = {
	atlas: AtlasGraphNode,
	systemRepoGroup: SystemRepoGroupNode,
};

interface BuiltFlow {
	nodes: Node[];
	edges: Edge[];
}

/** A staged create rendered as a provisional cross-repo edge on the System map. */
interface SystemPendingCreate {
	id: string;
	sourceNodeId: string;
	targetNodeId: string;
}

/**
 * Lay out each repo with dagre, pack the containers in a row, build RF data.
 *
 * - `selectedId` marks the clicked node as `selected` (opens its panel).
 * - `activeId` (selection OR hover) drives the neighbourhood highlight: when a
 *   real node is active, `activeSet` = {active} ∪ its undirected neighbours
 *   (across BOTH intra- and cross-repo edges); nodes outside the set are dimmed,
 *   and an edge is highlighted only when both endpoints sit in the set.
 * - `savedPositions` overrides the computed dagre/packing position for any node
 *   (group container or card) the user has dragged before (incl. staged moves).
 * - `pendingDeletes` hides cross-repo edges staged for deletion; `pendingCreates`
 *   appends provisional (dashed, muted) cross-repo edges for staged creates.
 */
function buildFlow(
	sg: SystemGraph,
	selectedId: string | null,
	activeId: string | null,
	savedPositions: Record<string, { x: number; y: number }> | undefined,
	// A `.has(signature)` membership check — a Map<sig, endpoints> or a Set<sig>.
	pendingDeletes: { has: (key: string) => boolean },
	pendingCreates: SystemPendingCreate[],
	signatureOf: (edge: SGEdge) => string | null,
): BuiltFlow {
	const groups = sg.nodes.filter((n) => n.kind === "REPO_GROUP");
	const realByGroup = new Map<string, SGNode[]>();
	const groupByNodeId = new Map<string, string>();
	for (const n of sg.nodes) {
		if (n.kind === "REPO_GROUP" || !n.parentId) {
			continue;
		}
		groupByNodeId.set(n.id, n.parentId);
		const arr = realByGroup.get(n.parentId) ?? [];
		arr.push(n);
		realByGroup.set(n.parentId, arr);
	}

	// Intra-repo edges grouped by their (shared) container, for per-repo dagre.
	const intraByGroup = new Map<
		string,
		{ source: string; target: string }[]
	>();
	for (const e of sg.edges) {
		if (e.crossRepo) {
			continue;
		}
		const g = groupByNodeId.get(e.source);
		if (g && groupByNodeId.get(e.target) === g) {
			const arr = intraByGroup.get(g) ?? [];
			arr.push({ source: e.source, target: e.target });
			intraByGroup.set(g, arr);
		}
	}

	const degree = new Map<string, number>();
	// Undirected adjacency over namespaced node ids, built from BOTH intra- and
	// cross-repo edges — this is what the neighbourhood highlight walks (mirrors
	// the solo graph's `neighbors` adjacency).
	const adjacency = new Map<string, Set<string>>();
	const addNeighbor = (a: string, b: string) => {
		const set = adjacency.get(a) ?? new Set<string>();
		set.add(b);
		adjacency.set(a, set);
	};
	for (const e of sg.edges) {
		degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
		degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
		addNeighbor(e.source, e.target);
		addNeighbor(e.target, e.source);
	}

	// Resolve the active neighbourhood for the (real) active node — selection OR
	// hover. A REPO_GROUP (hover or selection) never dims (it isn't a real node).
	const activeReal =
		activeId && groupByNodeId.has(activeId) ? activeId : null;
	const activeSet = activeReal
		? new Set<string>([activeReal, ...(adjacency.get(activeReal) ?? [])])
		: null;

	const localPos = new Map<string, { x: number; y: number }>();
	const sizeByGroup = new Map<string, { w: number; h: number }>();
	for (const group of groups) {
		const children = realByGroup.get(group.id) ?? [];
		const g = new dagre.graphlib.Graph();
		g.setGraph({
			rankdir: "TB",
			nodesep: 28,
			ranksep: 56,
			marginx: 8,
			marginy: 8,
		});
		g.setDefaultEdgeLabel(() => ({}));
		for (const c of children) {
			g.setNode(c.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
		}
		const childSet = new Set(children.map((c) => c.id));
		for (const e of intraByGroup.get(group.id) ?? []) {
			if (childSet.has(e.source) && childSet.has(e.target)) {
				g.setEdge(e.source, e.target);
			}
		}
		if (children.length > 0) {
			dagre.layout(g);
		}
		let maxX = 0;
		let maxY = 0;
		for (const c of children) {
			const laid = g.node(c.id);
			const x = laid ? laid.x - NODE_WIDTH / 2 : 0;
			const y = laid ? laid.y - NODE_HEIGHT / 2 : 0;
			localPos.set(c.id, {
				x: x + GROUP_PAD,
				y: y + GROUP_HEADER + GROUP_PAD,
			});
			maxX = Math.max(maxX, x + NODE_WIDTH);
			maxY = Math.max(maxY, y + NODE_HEIGHT);
		}
		sizeByGroup.set(group.id, {
			w: Math.max(NODE_WIDTH + GROUP_PAD * 2, maxX + GROUP_PAD * 2),
			h: Math.max(140, maxY + GROUP_HEADER + GROUP_PAD * 2),
		});
	}

	const rfNodes: Node[] = [];
	let cursorX = 0;
	for (const group of groups) {
		const size = sizeByGroup.get(group.id) ?? { w: 320, h: 200 };
		// A saved position (from a prior drag) wins over the packed column slot.
		const groupPos = savedPositions?.[group.id] ?? { x: cursorX, y: 0 };
		rfNodes.push({
			id: group.id,
			type: "systemRepoGroup",
			position: groupPos,
			data: { label: group.label },
			style: { width: size.w, height: size.h },
			selectable: false,
			draggable: true,
		});
		for (const c of realByGroup.get(group.id) ?? []) {
			const computed = localPos.get(c.id) ?? {
				x: GROUP_PAD,
				y: GROUP_HEADER + GROUP_PAD,
			};
			// Saved card positions are stored in the same parent-relative space
			// dagre uses, so they slot straight back in under `extent: "parent"`.
			const cardPos = savedPositions?.[c.id] ?? computed;
			rfNodes.push({
				id: c.id,
				type: "atlas",
				parentId: group.id,
				extent: "parent",
				draggable: true,
				position: cardPos,
				data: {
					label: c.label,
					kind: c.kind as AtlasNodeKind,
					language: c.language,
					filePath: c.filePath,
					description: c.description,
					category: c.category,
					metrics: c.metrics,
					connectionCount: degree.get(c.id) ?? 0,
					selected: c.id === selectedId,
					// Fade nodes outside the active neighbourhood; at rest (no
					// selection) nothing dims.
					dimmed: activeSet !== null && !activeSet.has(c.id),
					matched: false,
				} satisfies AtlasNodeData,
				selected: c.id === selectedId,
			});
		}
		cursorX += size.w + GROUP_GAP;
	}

	const rfEdges: Edge[] = [];
	sg.edges.forEach((e, i) => {
		if (e.crossRepo) {
			// Hide a cross-repo edge staged for deletion (not yet persisted).
			const sig = signatureOf(e);
			if (sig && pendingDeletes.has(sig)) {
				return;
			}
			const kind = e.kind as SystemCrossEdgeKind;
			const color = CROSS_EDGE_COLOR[kind] ?? "var(--primary)";
			// Highlight when both endpoints are in the active neighbourhood; dim
			// every other cross-edge while a neighbourhood is active.
			const highlighted =
				(activeSet?.has(e.source) && activeSet.has(e.target)) ?? false;
			const dimmed = activeSet !== null && !highlighted;
			rfEdges.push({
				id: e.id || `x${i}`,
				source: e.source,
				target: e.target,
				animated: !e.deleted,
				selectable: true,
				focusable: true,
				interactionWidth: 16,
				zIndex: 6,
				data: { description: e.description, kind: e.kind },
				style: {
					stroke: color,
					strokeWidth: highlighted ? 3 : 2.5,
					// Soft-deleted connections read as a faint, dotted ghost so they
					// stay distinguishable when "Show deleted" includes them.
					strokeDasharray: e.deleted ? "2 5" : "6 4",
					opacity: e.deleted ? 0.3 : dimmed ? 0.12 : 1,
					transition: "opacity 150ms, stroke-width 150ms",
					cursor: "pointer",
				} as CSSProperties,
			});
			return;
		}
		// Intra-repo edges stay thin + solid + neutral; dim with the neighbourhood.
		const highlighted =
			(activeSet?.has(e.source) && activeSet.has(e.target)) ?? false;
		const dimmed = activeSet !== null && !highlighted;
		rfEdges.push({
			id: e.id || `e${i}`,
			source: e.source,
			target: e.target,
			selectable: false,
			focusable: false,
			style: {
				stroke: "var(--border)",
				strokeWidth: highlighted ? 1.5 : 1,
				opacity: dimmed ? 0.12 : 1,
				transition: "opacity 150ms, stroke-width 150ms",
			} as CSSProperties,
		});
	});

	// Append PROVISIONAL (staged-create) cross-repo edges — dashed + muted, with a
	// distinct id so a click can drop them from the staged creates.
	for (const create of pendingCreates) {
		const highlighted =
			(activeSet?.has(create.sourceNodeId) &&
				activeSet.has(create.targetNodeId)) ??
			false;
		const dimmed = activeSet !== null && !highlighted;
		rfEdges.push({
			id: `pending__${create.id}`,
			source: create.sourceNodeId,
			target: create.targetNodeId,
			animated: false,
			selectable: true,
			focusable: true,
			interactionWidth: 16,
			zIndex: 6,
			data: { pendingCreateId: create.id },
			style: {
				stroke: "var(--primary)",
				strokeWidth: 2.5,
				strokeDasharray: "6 4",
				opacity: dimmed ? 0.4 : 0.85,
				transition: "opacity 150ms, stroke-width 150ms",
				cursor: "pointer",
			} as CSSProperties,
		});
	}

	return { nodes: rfNodes, edges: rfEdges };
}

/** The selected cross-repo edge handed to the host so it can open the edge panel. */
export interface SelectedSystemEdge {
	/** Endpoint selector, or null for a non-editable repo-group endpoint edge. */
	endpoints: EdgeEndpoints | null;
	kind: string;
	sourceLabel: string;
	targetLabel: string;
	description: string | null;
	isManual: boolean;
	isUserDescription: boolean;
	deleted: boolean;
}

interface AtlasSystemMapProps {
	systemGraph: SystemGraph;
	selectedNodeId: string | null;
	onSelectNode: (node: SGNode | null) => void;
	/** Selecting a cross-repo edge (canvas click or list row) opens the edge panel. */
	onSelectEdge: (edge: SelectedSystemEdge) => void;
	/** Project id — threaded into the create/restore connection mutations. */
	projectId: string;
	/** The graph mode — part of the edge mutation selector. */
	mode: GraphMode;
	/** Org id (XOR tenant scope) for the connection mutations. */
	organizationId: string | null;
	/** Lifted "include soft-deleted edges" state (drives the parent's refetch). */
	includeDeleted: boolean;
	onIncludeDeletedChange: (next: boolean) => void;
	/**
	 * Persisted positions (from a prior saved layout) keyed by node id. When
	 * present for a group container or a card, the saved position overrides the
	 * computed dagre/packing layout.
	 */
	savedPositions?: Record<string, { x: number; y: number }>;
	/**
	 * Staged structural edits (position moves, connection creates/deletes) for the
	 * active System-map context. Owned by the host (the edge panel that stages
	 * deletes lives there); discarded by the host when the lens/repos change.
	 */
	staged: StagedGraphEdits;
	/** Persist all staged edits (host wires up the mutations). */
	onSaveStaged: () => void;
	/** True while a staged save is in flight. */
	isSavingStaged: boolean;
}

function SystemMapCanvas({
	systemGraph,
	selectedNodeId,
	onSelectNode,
	onSelectEdge,
	projectId,
	mode,
	organizationId,
	includeDeleted,
	onIncludeDeletedChange,
	savedPositions,
	staged,
	onSaveStaged,
	isSavingStaged,
}: AtlasSystemMapProps) {
	const t = useTranslations("projects.atlas.system");
	// Zoom / fit aria-labels reuse the solo graph's keys (same control vocabulary).
	const tGraph = useTranslations("projects.atlas.graph");
	const tConn = useTranslations("projects.atlas.connections");
	const queryClient = useQueryClient();
	const { fitView, zoomIn, zoomOut, getNodes } = useReactFlow();
	// Toolbar: search box + Nodes/Connections disclosure.
	const [query, setQuery] = useState("");
	const [showList, setShowList] = useState(false);
	const [listTab, setListTab] = useState<"nodes" | "connections">(
		"connections",
	);
	// Hovered node id — drives the neighbourhood highlight when nothing is pinned
	// by a click (selection always wins), mirroring the solo graph (Task 2).
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	// The staged-create id currently open in the connection editor (kind +
	// description) — opened on draw and on clicking a provisional cross-repo edge.
	const [editingCreateId, setEditingCreateId] = useState<string | null>(null);
	// Wrapper around the React Flow canvas — used to locate the `.react-flow`
	// element for image export.
	const wrapperRef = useRef<HTMLDivElement>(null);
	const [isExporting, setIsExporting] = useState(false);

	// Merge staged (not-yet-saved) position moves on top of the persisted layout
	// overrides, so dragged-but-unsaved nodes render where the user left them.
	const overlaidPositions = useMemo(() => {
		if (staged.positions.size === 0) {
			return savedPositions;
		}
		const merged: Record<string, { x: number; y: number }> = {
			...(savedPositions ?? {}),
		};
		for (const [id, pos] of staged.positions) {
			merged[id] = pos;
		}
		return merged;
	}, [savedPositions, staged.positions]);

	// A click-pinned selection always wins over a transient hover.
	const activeId = selectedNodeId ?? hoveredId;

	const nodeById = useMemo(
		() => new Map(systemGraph.nodes.map((n) => [n.id, n])),
		[systemGraph.nodes],
	);

	// Map a System-map edge's namespaced endpoint id back to its repo id + node
	// key. A repo-group endpoint (`repo::${analysisId}`, originalKey=null) is NOT
	// user-overridable by the backend, so the whole edge is treated read-only.
	const resolveSystemEndpoints = useCallback(
		(edge: SGEdge): EdgeEndpoints | null => {
			const src = nodeById.get(edge.source);
			const tgt = nodeById.get(edge.target);
			if (
				!src ||
				!tgt ||
				src.originalKey === null ||
				tgt.originalKey === null
			) {
				return null;
			}
			return {
				sourceRepositoryIntegrationId: src.repoId,
				sourceKey: src.originalKey,
				targetRepositoryIntegrationId: tgt.repoId,
				targetKey: tgt.originalKey,
			};
		},
		[nodeById],
	);

	// Endpoint signature for a cross-repo edge — matches `endpointSignature` so the
	// edge panel's staged delete (keyed the same way) hides the right edge here.
	// Null for edges with a non-overridable (repo-group) endpoint.
	const edgeSignature = useCallback(
		(edge: SGEdge): string | null => {
			const endpoints = resolveSystemEndpoints(edge);
			return endpoints ? endpointSignature(endpoints) : null;
		},
		[resolveSystemEndpoints],
	);

	const { nodes, edges } = useMemo(
		() =>
			buildFlow(
				systemGraph,
				selectedNodeId,
				activeId,
				overlaidPositions,
				staged.deletes,
				staged.creates.map((c) => ({
					id: c.id,
					sourceNodeId: c.sourceNodeId,
					targetNodeId: c.targetNodeId,
				})),
				edgeSignature,
			),
		[
			systemGraph,
			selectedNodeId,
			activeId,
			overlaidPositions,
			staged.deletes,
			staged.creates,
			edgeSignature,
		],
	);

	// Localised label for a cross-repo edge kind (falls back to the raw value).
	const kindLabel = useCallback(
		(kind: string): string => {
			if (
				kind === "CALLS_API" ||
				kind === "DEPENDS_ON" ||
				kind === "SHARES_LIBRARY" ||
				kind === "RELATES_TO"
			) {
				return t(`edgeKind.${kind}`);
			}
			return kind;
		},
		[t],
	);

	const toSelectedEdge = useCallback(
		(edge: SGEdge): SelectedSystemEdge => {
			const src = nodeById.get(edge.source);
			const tgt = nodeById.get(edge.target);
			return {
				endpoints: resolveSystemEndpoints(edge),
				kind: edge.kind,
				sourceLabel: src?.label ?? edge.source,
				targetLabel: tgt?.label ?? edge.target,
				description: edge.description,
				isManual: edge.isManual ?? false,
				isUserDescription: edge.isUserDescription ?? false,
				deleted: edge.deleted ?? false,
			};
		},
		[nodeById, resolveSystemEndpoints],
	);

	// React Flow owns the live node state (drag positions + measured dimensions
	// the MiniMap relies on). Seed it from `buildFlow`, then sync prop-driven
	// changes in while preserving each node's live drag position + measured size,
	// only re-applying layout when the built nodes actually change.
	const [rfNodes, setRfNodes, onNodesChangeInternal] = useNodesState(nodes);
	const builtRef = useRef(nodes);
	useEffect(() => {
		const built = nodes;
		const changed = builtRef.current !== built;
		builtRef.current = built;
		setRfNodes((prev) => {
			const prevById = new Map(prev.map((n) => [n.id, n]));
			return built.map((node) => {
				const existing = prevById.get(node.id);
				if (!existing) {
					return node;
				}
				return {
					...node,
					position: changed ? node.position : existing.position,
					measured: existing.measured,
					width: existing.width,
					height: existing.height,
				};
			});
		});
	}, [nodes, setRfNodes]);

	/**
	 * Apply RF changes (live drag + measured dims), then STAGE the final dragged
	 * position(s) on drag-stop. React Flow owns the smooth live drag; only the
	 * committed positions are written into the staged set — nothing auto-persists.
	 */
	const handleNodesChange = useCallback(
		(changes: NodeChange<Node>[]) => {
			onNodesChangeInternal(changes);

			const finished = changes.filter(
				(
					c,
				): c is NodeChange<Node> & {
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

	const handleNodeClick = useCallback<NodeMouseHandler>(
		(_event, node) => {
			const sg = nodeById.get(node.id);
			if (sg && sg.kind !== "REPO_GROUP") {
				onSelectNode(sg);
			}
		},
		[nodeById, onSelectNode],
	);

	// React Flow edge id → the underlying System edge, so a canvas edge click maps
	// back to the cross-repo edge we open the panel for. Only cross-repo edges are
	// clickable, so only they are indexed here.
	const systemEdgeById = useMemo(() => {
		const map = new Map<string, SGEdge>();
		systemGraph.edges.forEach((edge, i) => {
			if (edge.crossRepo) {
				map.set(edge.id || `x${i}`, edge);
			}
		});
		return map;
	}, [systemGraph.edges]);

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
			const sgEdge = systemEdgeById.get(edge.id);
			if (sgEdge) {
				onSelectEdge(toSelectedEdge(sgEdge));
			}
		},
		[systemEdgeById, onSelectEdge, toSelectedEdge],
	);

	// Resolve a (repoId, originalKey) endpoint back to its namespaced System-map
	// node id, so a "+ New connection" staged from the list can draw a provisional
	// edge between the right rendered nodes.
	const nodeIdByRepoKey = useMemo(() => {
		const map = new Map<string, string>();
		for (const n of systemGraph.nodes) {
			if (n.kind !== "REPO_GROUP" && n.originalKey !== null) {
				map.set(`${n.repoId ?? "_"}::${n.originalKey}`, n.id);
			}
		}
		return map;
	}, [systemGraph.nodes]);

	// Normalised connection rows (cross-repo edges) for the Connections list, with
	// the staged overlay applied: pending-deleted edges hidden, pending creates
	// appended as provisional rows.
	const connectionRows = useMemo<ConnectionRow[]>(() => {
		const rows: ConnectionRow[] = [];
		systemGraph.edges
			.filter((edge) => edge.crossRepo)
			.forEach((edge, i) => {
				const sig = edgeSignature(edge);
				if (sig && staged.deletes.has(sig)) {
					return;
				}
				const src = nodeById.get(edge.source);
				const tgt = nodeById.get(edge.target);
				rows.push({
					id: edge.id || `x${i}`,
					kind: edge.kind,
					sourceLabel: src?.label ?? edge.source,
					targetLabel: tgt?.label ?? edge.target,
					description: edge.description,
					isManual: edge.isManual ?? false,
					isUserDescription: edge.isUserDescription ?? false,
					deleted: edge.deleted ?? false,
					endpoints: resolveSystemEndpoints(edge),
				});
			});
		for (const create of staged.creates) {
			rows.push({
				id: `pending__${create.id}`,
				kind: create.kind,
				sourceLabel:
					nodeById.get(create.sourceNodeId)?.label ??
					create.endpoints.sourceKey,
				targetLabel:
					nodeById.get(create.targetNodeId)?.label ??
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
		systemGraph.edges,
		nodeById,
		resolveSystemEndpoints,
		edgeSignature,
		staged.deletes,
		staged.creates,
	]);

	// Pickable nodes for the create form: every REAL System-map node (not a repo
	// group), carrying its repo id + the underlying node key for the selector.
	const connectionNodeOptions = useMemo<ConnectionNodeOption[]>(
		() =>
			systemGraph.nodes
				.filter(
					(n) => n.kind !== "REPO_GROUP" && n.originalKey !== null,
				)
				.map((n) => ({
					key: n.originalKey as string,
					label: `${n.label} · ${n.repoName}`,
					repositoryIntegrationId: n.repoId,
				})),
		[systemGraph.nodes],
	);

	const restoreEdgeMutation = useMutation(
		orpc.atlas.restoreEdge.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.systemGraph.key(),
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

	// "+ New connection" (list form) STAGES a cross-repo create — the user reviews
	// the provisional dashed edge on the map, then Saves.
	const handleCreateConnection = useCallback(
		(input: ConnectionsCreateInput) => {
			const endpoints: EdgeEndpoints = {
				sourceRepositoryIntegrationId:
					input.source.repositoryIntegrationId,
				sourceKey: input.source.key,
				targetRepositoryIntegrationId:
					input.target.repositoryIntegrationId,
				targetKey: input.target.key,
			};
			const sourceNodeId = nodeIdByRepoKey.get(
				`${input.source.repositoryIntegrationId ?? "_"}::${input.source.key}`,
			);
			const targetNodeId = nodeIdByRepoKey.get(
				`${input.target.repositoryIntegrationId ?? "_"}::${input.target.key}`,
			);
			if (!sourceNodeId || !targetNodeId) {
				return;
			}
			staged.stageCreate({
				id: endpointSignature(endpoints),
				endpoints,
				kind: input.kind,
				description: input.description || undefined,
				sourceNodeId,
				targetNodeId,
			});
		},
		[staged, nodeIdByRepoKey],
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
				organizationId,
			});
		},
		[restoreEdgeMutation, projectId, mode, organizationId],
	);

	// Draw a connection on the canvas (drag from one card to another). Both
	// endpoints resolve to (repo id + node key); a cross-repo drag yields a manual
	// cross-repo connection. Repo-group containers (originalKey=null) are not
	// connectable. STAGED (provisional dashed edge), then the editor opens so the
	// user picks the relationship kind + description; defaults to RELATES_TO.
	const handleConnect = useCallback(
		(connection: Connection) => {
			const { source, target } = connection;
			if (!source || !target || source === target) {
				return;
			}
			const src = nodeById.get(source);
			const tgt = nodeById.get(target);
			if (
				!src ||
				!tgt ||
				src.originalKey === null ||
				tgt.originalKey === null
			) {
				return;
			}
			const endpoints: EdgeEndpoints = {
				sourceRepositoryIntegrationId: src.repoId,
				sourceKey: src.originalKey,
				targetRepositoryIntegrationId: tgt.repoId,
				targetKey: tgt.originalKey,
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
		[nodeById, staged],
	);

	const handleSelectConnectionRow = useCallback(
		(row: ConnectionRow) => {
			// A provisional (staged-create) row opens its editor on click (kind +
			// description) rather than the server-backed panel (not persisted yet).
			if (row.id.startsWith("pending__")) {
				setEditingCreateId(row.id.slice("pending__".length));
				return;
			}
			const sgEdge = systemEdgeById.get(row.id);
			if (sgEdge) {
				onSelectEdge(toSelectedEdge(sgEdge));
			}
		},
		[systemEdgeById, onSelectEdge, toSelectedEdge],
	);

	// The pending create currently open in the connection editor (resolves its
	// endpoint labels via the namespaced node ids), or null when closed.
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
				nodeById.get(create.sourceNodeId)?.label ??
				create.endpoints.sourceKey,
			targetLabel:
				nodeById.get(create.targetNodeId)?.label ??
				create.endpoints.targetKey,
			kind: create.kind,
			description: create.description ?? "",
		};
	}, [editingCreateId, staged.creates, nodeById]);

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

	// Hover wiring for the neighbourhood highlight (Task 2 — parity with solo).
	// A selection (click) pins the active node, so a hover only matters at rest.
	const handleNodeMouseEnter = useCallback<NodeMouseHandler>(
		(_event, node) => setHoveredId(node.id),
		[],
	);
	const handleNodeMouseLeave = useCallback<NodeMouseHandler>(
		() => setHoveredId(null),
		[],
	);

	// "Reset layout" re-runs the automatic per-repo dagre + packing layout, but
	// STAGES the freshly-computed positions (Task 3 + staged model) — the Save bar
	// appears so the user can Save (share the reset) or Discard (revert).
	const handleReset = useCallback(() => {
		// Compute the default layout from scratch (ignore saved/staged overrides).
		const fresh = buildFlow(
			systemGraph,
			selectedNodeId,
			activeId,
			undefined,
			new Set<string>(),
			[],
			edgeSignature,
		);
		const entries = fresh.nodes.map((n) => ({
			id: n.id,
			position: { x: n.position.x, y: n.position.y },
		}));
		staged.stagePositions(entries);
		setTimeout(() => fitView({ duration: 300, padding: 0.1 }), 50);
	}, [systemGraph, selectedNodeId, activeId, edgeSignature, staged, fitView]);

	// Export the rendered System map as a PNG image or a PDF, framed to fit every
	// node. Mirrors the solo graph's export: `html-to-image` rasterises the SVG
	// edges; jspdf is loaded only for the PDF path. Captures the RF viewport only.
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
			const restoreEdges: Array<() => void> = [];
			try {
				const { toPng } = await import("html-to-image");
				// Walk up to the nearest opaque ancestor for a theme-correct bg —
				// otherwise html2canvas flattens the transparent backdrop to black.
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
				// Darken the faint intra-repo edges for the capture only.
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
					// Only darken the neutral intra-repo edges — keep cross-repo hues.
					if (
						!prevStroke ||
						prevStroke === "" ||
						prevStroke.includes("border")
					) {
						path.style.stroke = exportStroke;
						path.style.strokeWidth = "2";
						restoreEdges.push(() => {
							path.style.stroke = prevStroke;
							path.style.strokeWidth = prevWidth;
						});
					}
				}
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
				const base = `atlas-system-map-${mode.toLowerCase()}`;
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
				toast.success(tGraph("exportImageDone"));
			} catch {
				toast.error(tGraph("exportImageError"));
			} finally {
				for (const restore of restoreEdges) {
					restore();
				}
				setIsExporting(false);
			}
		},
		[getNodes, mode, tGraph],
	);

	// MiniMap colour: atlas nodes carry their category token; the
	// synthetic repo-group containers read in a neutral token (mirrors solo).
	const minimapNodeColor = useCallback((node: Node) => {
		if (node.type === "atlas") {
			return resolveNodeCategory(node.data as AtlasNodeData).colorVar;
		}
		return GROUP_MINIMAP_COLOR;
	}, []);

	const crossEdgeKinds = useMemo(() => {
		const present = new Set(
			systemGraph.edges.filter((e) => e.crossRepo).map((e) => e.kind),
		);
		return CROSS_EDGE_KINDS.filter((k) => present.has(k));
	}, [systemGraph.edges]);

	const listId = `${projectId}-system-conn-list`;

	return (
		<div className="flex size-full flex-col">
			{/* Slim toolbar — search + Nodes/Connections disclosure, mirroring the
			    solo graph's toolbar so the System map gets the same connection
			    editing affordances. */}
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
						placeholder={tConn("searchPlaceholder")}
						aria-label={tConn("searchAria")}
						className="h-9 bg-card pl-8 pr-8"
					/>
					{query && (
						<button
							type="button"
							onClick={() => setQuery("")}
							aria-label={tGraph("searchClear")}
							className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<XIcon aria-hidden="true" className="size-3.5" />
						</button>
					)}
				</div>
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
						{tGraph("list")}
					</Button>
					{showList && (
						<section
							id={listId}
							aria-label={
								listTab === "nodes"
									? tGraph("nodeListLabel")
									: tConn("regionLabel")
							}
							className="absolute right-0 top-full z-30 mt-2 max-h-[60vh] w-[20rem] max-w-[85vw] overflow-y-auto rounded-xl border border-border/60 bg-background shadow-md"
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
													? tGraph("nodeList")
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
									kindOptions={SYSTEM_EDGE_KINDS}
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
								<ul className="flex flex-col p-1">
									{systemGraph.nodes.filter(
										(n) => n.kind !== "REPO_GROUP",
									).length === 0 && (
										<li className="px-3 py-3 text-sm text-muted-foreground">
											{tGraph("empty")}
										</li>
									)}
									{systemGraph.nodes
										.filter((n) => n.kind !== "REPO_GROUP")
										.map((n) => (
											<li key={n.id}>
												<button
													type="button"
													onClick={() =>
														onSelectNode(n)
													}
													className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
												>
													<span className="w-full truncate font-medium text-foreground">
														{n.label}
													</span>
													<span className="w-full truncate text-[11px] text-muted-foreground">
														{n.repoName}
													</span>
												</button>
											</li>
										))}
								</ul>
							)}
						</section>
					)}
				</div>
			</div>

			<div ref={wrapperRef} className="relative min-h-0 flex-1">
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
				<ReactFlow
					nodes={rfNodes}
					edges={edges}
					nodeTypes={nodeTypes}
					onNodeClick={handleNodeClick}
					onEdgeClick={handleEdgeClick}
					onNodeMouseEnter={handleNodeMouseEnter}
					onNodeMouseLeave={handleNodeMouseLeave}
					onNodesChange={handleNodesChange}
					onConnect={handleConnect}
					fitView
					minZoom={0.1}
					proOptions={{ hideAttribution: true }}
					// `relative z-[1]` lifts the (transparent) canvas above the brand
					// glow so the glow tints the empty backdrop while nodes/edges/dots
					// still paint on top of it.
					className="relative z-[1] !bg-transparent"
				>
					<Background
						variant={BackgroundVariant.Dots}
						gap={28}
						size={1}
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
							aria-label={tGraph("zoomIn")}
							onClick={() => zoomIn({ duration: 200 })}
						>
							<PlusIcon aria-hidden="true" className="size-4" />
						</Button>
						<Button
							type="button"
							variant="outline"
							size="icon-sm"
							aria-label={tGraph("zoomOut")}
							onClick={() => zoomOut({ duration: 200 })}
						>
							<MinusIcon aria-hidden="true" className="size-4" />
						</Button>
						<Button
							type="button"
							variant="outline"
							size="icon-sm"
							aria-label={tGraph("fitView")}
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
									aria-label={tGraph("resetLayout")}
									onClick={handleReset}
								>
									<LayoutGridIcon
										aria-hidden="true"
										className="size-4"
									/>
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{tGraph("resetLayoutTooltip")}
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
											aria-label={tGraph("exportImage")}
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
									{tGraph("exportImage")}
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
									{tGraph("exportPng")}
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={() => exportImage("pdf")}
									className="gap-2"
								>
									<FileTextIcon
										aria-hidden="true"
										className="size-4"
									/>
									{tGraph("exportPdf")}
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

				{/* Cross-repo edge legend (the new relationship vocabulary). Each swatch
			    shows its kind's actual colour as a short dashed line. */}
				{crossEdgeKinds.length > 0 && (
					<div className="absolute top-3 left-3 z-10 rounded-xl border border-border/60 bg-background/90 px-3 py-2 shadow-sm backdrop-blur-sm">
						<p className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
							{t("legendTitle")}
						</p>
						<ul className="flex flex-col gap-1">
							{crossEdgeKinds.map((kind) => (
								<li
									key={kind}
									className="flex items-center gap-2 text-[12px] text-foreground"
								>
									<span
										aria-hidden="true"
										className="h-0 w-5 shrink-0 border-t-2 border-dashed"
										style={{
											borderColor: CROSS_EDGE_COLOR[kind],
										}}
									/>
									{t(`edgeKind.${kind}`)}
								</li>
							))}
						</ul>
					</div>
				)}

				{/* Floating Save / Discard bar — only while structural edits are staged
			    (drag, connect, delete, reset-layout). */}
				{staged.isDirty && (
					<AtlasStagedEditsBar
						count={staged.count}
						onSave={onSaveStaged}
						onDiscard={staged.discard}
						isSaving={isSavingStaged}
					/>
				)}
			</div>

			{/* Editor for a freshly-drawn / clicked provisional cross-repo
			    connection — pick the relationship kind + description before saving. */}
			<AtlasConnectionEditDialog
				target={editTarget}
				kindOptions={SYSTEM_EDGE_KINDS}
				kindLabel={kindLabel}
				onSave={handleEditorSave}
				onRemove={handleEditorRemove}
				onCancel={handleEditorCancel}
			/>
		</div>
	);
}

export function AtlasSystemMap(props: AtlasSystemMapProps) {
	return (
		<ReactFlowProvider>
			<SystemMapCanvas {...props} />
		</ReactFlowProvider>
	);
}
