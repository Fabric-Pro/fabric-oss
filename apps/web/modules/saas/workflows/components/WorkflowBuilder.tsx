"use client";

import {
	addEdge,
	Background,
	BackgroundVariant,
	type Connection,
	type Edge,
	type EdgeTypes,
	type Node,
	type NodeTypes,
	ReactFlow,
	ReactFlowProvider,
	useEdgesState,
	useNodesState,
	useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "../styles/reactflow-overrides.css";
import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { useSearchParams } from "next/navigation";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	appendStep,
	type GraphState,
	insertStepOnEdge,
	isStepNode,
	orderSteps,
	replacePlaceholder,
	serializeGraph,
	withReadableLayout,
} from "../lib/graph-edits";
import { triggerTypeLabel } from "../lib/node-appearance";
import { nodeDefinitions } from "../lib/node-definitions";
import { workflowOutputOptions } from "../lib/output-options";
// Import plugins to auto-register them
import "../lib/plugins";
import type { ViewedRun } from "../lib/run-steps";
import type {
	WorkflowEdge,
	WorkflowNode,
	WorkflowNodeData,
	WorkflowNodeType,
} from "../lib/types";
import type { WorkflowStatus } from "../lib/workflow-status-display";
import { AddStepPalette } from "./editor/AddStepPalette";
import { AskAiBar } from "./editor/AskAiBar";
import {
	AddStepAnchor,
	CanvasControls,
	FIT_VIEW_OPTIONS,
} from "./editor/CanvasControls";
import { WorkflowCanvasProvider } from "./editor/canvas-context";
import { EditorHeader } from "./editor/EditorHeader";
import { InsertableEdge } from "./editor/InsertableEdge";
import { InspectorPanel, type InspectorTab } from "./editor/InspectorPanel";
import type { NameSaveStatus } from "./editor/NameSaveFeedback";
import { StepInspector } from "./editor/StepInspector";
import { type LastRun, WorkflowOverview } from "./editor/WorkflowOverview";
import { AddNode } from "./nodes/AddNode";
import { EmptyActionNode } from "./nodes/EmptyActionNode";
import { WorkflowNodeComponent } from "./nodes/WorkflowNode";
import { PublishDialog } from "./PublishDialog";
import type { GeneratedWorkflowResponse } from "./TextToWorkflow";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import { WorkflowScheduleDialog } from "./WorkflowScheduleDialog";

interface WorkflowBuilderProps {
	initialNodes?: WorkflowNode[];
	initialEdges?: WorkflowEdge[];
	onSave?: (
		nodes: WorkflowNode[],
		edges: WorkflowEdge[],
	) => void | Promise<void>;
	onRun?: (
		nodes: WorkflowNode[],
		edges: WorkflowEdge[],
	) => void | Promise<void>;
	onDirtyChange?: (dirty: boolean) => void;
	isLoading?: boolean;
	workflowName?: string;
	workflowId?: string;
	onNameChange?: (name: string) => void | Promise<void>;
	nameSaveStatus?: NameSaveStatus;
	nameRetryValue?: string;
	organizationId?: string | null;
	// Publishing props
	workflowStatus?: WorkflowStatus;
	workflowVersion?: number;
	publishedVersion?: number | null;
	onPublished?: () => void;
	/** The runs panel, laid out to the left of the canvas. */
	runsPanel?: ReactNode;
	/** Chrome floating over the canvas: the reopen-runs button, the run pill. */
	canvasOverlay?: ReactNode;
	/** The run being viewed: the canvas and inspector show its step results. */
	viewedRun?: ViewedRun | null;
	lastRun?: LastRun | null;
}

/**
 * Custom node types, built from the palette rather than listed by hand.
 *
 * This was a hardcoded map of 18 entries — a fourth registry to keep in sync,
 * and one that failed quietly: React Flow silently falls back to its default
 * node for an unregistered type, so a node the palette offered but this map
 * omitted rendered as an unstyled box.
 */
const nodeTypes: NodeTypes = {
	add: AddNode,
	"empty-action": EmptyActionNode,
	...Object.fromEntries(
		nodeDefinitions.map((node) => [node.type, WorkflowNodeComponent]),
	),
};

const edgeTypes: EdgeTypes = { insertable: InsertableEdge };
// Applied to every edge without a type, which is every saved edge.
const DEFAULT_EDGE_OPTIONS = { type: "insertable" };

// Stable defaults: the effect that reloads the graph depends on these.
const NO_NODES: WorkflowNode[] = [];
const NO_EDGES: WorkflowEdge[] = [];

/** A step whose action is still to be picked from "Add step". */
function newPlaceholderStep(): Node {
	return {
		id: `empty-action-${crypto.randomUUID()}`,
		type: "empty-action",
		position: { x: 0, y: 0 },
		data: { label: "Action" },
	};
}

// Inner component that uses useReactFlow hook
function WorkflowBuilderInner({
	initialNodes = NO_NODES,
	initialEdges = NO_EDGES,
	onSave,
	onRun,
	onDirtyChange,
	isLoading = false,
	workflowName = "Untitled Workflow",
	workflowId = "",
	onNameChange,
	nameSaveStatus = "idle",
	nameRetryValue,
	organizationId,
	workflowStatus = "DRAFT",
	workflowVersion = 1,
	publishedVersion,
	onPublished,
	runsPanel,
	canvasOverlay,
	viewedRun = null,
	lastRun,
}: WorkflowBuilderProps) {
	// Get React Flow instance for proper coordinate conversion
	const reactFlowInstance = useReactFlow();
	const workflowsPath = useContextPath("workflows");
	const integrationsSettingsPath = useContextPath(
		"settings/integrations/actions",
	);
	const [inspectorTab, setInspectorTab] = useState<InspectorTab>("workflow");
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [showPublishDialog, setShowPublishDialog] = useState(false);
	const [showScheduleDialog, setShowScheduleDialog] = useState(false);
	const [showVersionHistory, setShowVersionHistory] = useState(false);
	const searchParams = useSearchParams();
	const [showAIInput, setShowAIInput] = useState(
		searchParams.get("assistant") === "1",
	);

	// Undo/Redo state with debouncing
	const [history, setHistory] = useState<
		Array<{ nodes: Node[]; edges: Edge[] }>
	>([]);
	const [historyIndex, setHistoryIndex] = useState(-1);
	const isUpdatingFromHistory = useRef(false);
	const historyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const pendingStateRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(
		null,
	);

	// Initialize with placeholder if empty, otherwise with initial nodes. A
	// graph placed for the old, narrower cards is laid out top to bottom.
	const getStartingNodes = (): Node[] => {
		if (initialNodes.length === 0) {
			return [
				{
					id: "add-node-placeholder",
					type: "add",
					position: { x: 0, y: 0 },
					data: { label: "", type: "add" },
					draggable: false,
					selectable: false,
				},
			];
		}
		return withReadableLayout<Node>(initialNodes, initialEdges);
	};

	const [nodes, setNodes, onNodesChange] = useNodesState(getStartingNodes());
	const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialEdges);

	const signature = JSON.stringify(serializeGraph({ nodes, edges }));
	const [savedSignature, setSavedSignature] = useState(() =>
		JSON.stringify(
			serializeGraph({ nodes: getStartingNodes(), edges: initialEdges }),
		),
	);
	const incomingSignature = JSON.stringify({
		nodes: initialNodes,
		edges: initialEdges,
	});
	const lastIncoming = useRef(incomingSignature);
	const dirty = signature !== savedSignature;
	const [isCommitting, setIsCommitting] = useState(false);
	const commitInFlight = useRef(false);
	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);
	useEffect(() => {
		if (!dirty) {
			return;
		}
		const onBeforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [dirty]);
	// Refetches must never replace edits. Identity changes remount the entire builder.
	useEffect(() => {
		if (incomingSignature === lastIncoming.current) {
			return;
		}
		lastIncoming.current = incomingSignature;
		if (dirty || isCommitting) {
			return;
		}
		const nextNodes = getStartingNodes();
		setNodes(nextNodes);
		setEdges(initialEdges);
		setSavedSignature(
			JSON.stringify(
				serializeGraph({ nodes: nextNodes, edges: initialEdges }),
			),
		);
		setSelectedNodeId(null);
		setHistory([]);
		setHistoryIndex(-1);
	}, [
		incomingSignature,
		dirty,
		isCommitting,
		initialNodes,
		initialEdges,
		setNodes,
		setEdges,
	]);

	// Save to history when nodes or edges change (for undo/redo)
	// Uses debouncing to avoid creating too many history entries during rapid changes
	useEffect(() => {
		if (isUpdatingFromHistory.current) {
			isUpdatingFromHistory.current = false;
			return;
		}

		// Only save if we have real nodes (not just placeholders)
		if (!nodes.some(isStepNode)) {
			return;
		}

		const newState = { nodes: [...nodes], edges: [...edges] };

		// Check if state actually changed
		const lastState = history[historyIndex];
		if (
			lastState &&
			JSON.stringify(lastState.nodes) ===
				JSON.stringify(newState.nodes) &&
			JSON.stringify(lastState.edges) === JSON.stringify(newState.edges)
		) {
			return;
		}

		// Store pending state for debounced commit
		pendingStateRef.current = newState;

		// Clear existing timeout
		if (historyTimeoutRef.current) {
			clearTimeout(historyTimeoutRef.current);
		}

		// Debounce history updates by 300ms to batch rapid changes
		historyTimeoutRef.current = setTimeout(() => {
			const stateToCommit = pendingStateRef.current;
			if (!stateToCommit) {
				return;
			}

			// Remove any future history if we're not at the end
			setHistory((prevHistory) => {
				const newHistory = prevHistory.slice(0, historyIndex + 1);
				newHistory.push(stateToCommit);

				// Limit history to 50 states
				if (newHistory.length > 50) {
					newHistory.shift();
				} else {
					setHistoryIndex((prev) => prev + 1);
				}

				return newHistory;
			});

			pendingStateRef.current = null;
		}, 300);

		// Cleanup timeout on unmount
		return () => {
			if (historyTimeoutRef.current) {
				clearTimeout(historyTimeoutRef.current);
			}
		};
	}, [nodes, edges, historyIndex]);

	// Undo function
	const handleUndo = useCallback(() => {
		if (historyIndex > 0) {
			isUpdatingFromHistory.current = true;
			const prevState = history[historyIndex - 1];
			setNodes(prevState.nodes);
			setEdges(prevState.edges);
			setHistoryIndex(historyIndex - 1);
		}
	}, [historyIndex, history, setNodes, setEdges]);

	// Redo function
	const handleRedo = useCallback(() => {
		if (historyIndex < history.length - 1) {
			isUpdatingFromHistory.current = true;
			const nextState = history[historyIndex + 1];
			setNodes(nextState.nodes);
			setEdges(nextState.edges);
			setHistoryIndex(historyIndex + 1);
		}
	}, [historyIndex, history, setNodes, setEdges]);

	const applyGraph = useCallback(
		(next: GraphState) => {
			setNodes(next.nodes);
			setEdges(next.edges);
		},
		[setNodes, setEdges],
	);

	// Selecting a placeholder opens "Add step", where its action is picked;
	// any other step opens its settings.
	const selectStep = useCallback((nodeId: string | null, type?: string) => {
		setSelectedNodeId(nodeId);
		setInspectorTab(type === "empty-action" ? "add" : "workflow");
	}, []);

	// Export workflow as JSON
	const handleExportJSON = useCallback(() => {
		const workflowCode = {
			name: workflowName,
			...serializeGraph({ nodes, edges }),
		};

		const codeString = JSON.stringify(workflowCode, null, 2);
		const blob = new Blob([codeString], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${workflowName.replace(/\s+/g, "-").toLowerCase()}.json`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);

		toast.success("Workflow exported as JSON!");
	}, [nodes, edges, workflowName]);

	// Handler for "Add a Step" on an empty canvas - adds an empty action node
	const handleAddFirstStep = useCallback(() => {
		const placeholder = newPlaceholderStep();
		setNodes([placeholder]);
		selectStep(placeholder.id, "empty-action");
	}, [setNodes, selectStep]);

	// The "+" on an edge: an empty step between its two ends.
	const handleInsertOnEdge = useCallback(
		(edgeId: string) => {
			const placeholder = newPlaceholderStep();
			const next = insertStepOnEdge(
				{ nodes, edges },
				edgeId,
				placeholder,
			);
			if (next) {
				applyGraph(next);
				selectStep(placeholder.id, "empty-action");
			}
		},
		[nodes, edges, applyGraph, selectStep],
	);

	// The "Add step" button under the last step.
	const handleAppendStep = useCallback(() => {
		const placeholder = newPlaceholderStep();
		applyGraph(appendStep({ nodes, edges }, placeholder));
		selectStep(placeholder.id, "empty-action");
	}, [nodes, edges, applyGraph, selectStep]);

	// Picking an action fills the selected empty step, keeping its
	// connections; with none selected it is added after the last step.
	const handleAddNode = useCallback(
		(nodeType: string, nodeData: Partial<WorkflowNodeData>) => {
			const newId = `${nodeType}-${crypto.randomUUID()}`;
			const selectedNode = nodes.find((n) => n.id === selectedNodeId);
			const replacement = {
				id: newId,
				type: nodeType,
				data: { ...nodeData },
			};

			applyGraph(
				selectedNode?.type === "empty-action"
					? replacePlaceholder(
							{ nodes, edges },
							selectedNode.id,
							replacement,
						)
					: appendStep(
							{ nodes, edges },
							{ ...replacement, position: { x: 0, y: 0 } },
						),
			);
			selectStep(newId, nodeType);
		},
		[nodes, edges, selectedNodeId, applyGraph, selectStep],
	);

	const onConnect = useCallback(
		(params: Connection) => setEdges((eds) => addEdge(params, eds)),
		[setEdges],
	);

	const onDragOver = useCallback((event: React.DragEvent) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
	}, []);

	const onDrop = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();

			const type = event.dataTransfer.getData("application/reactflow");
			const nodeData = event.dataTransfer.getData("application/nodedata");

			if (!type) {
				return;
			}

			// Use React Flow's screenToFlowPosition for accurate placement
			// This properly accounts for zoom, pan, and viewport offset
			const position = reactFlowInstance.screenToFlowPosition({
				x: event.clientX,
				y: event.clientY,
			});

			const newNode: Node = {
				id: `${type}-${crypto.randomUUID()}`,
				type: type as WorkflowNodeType,
				position,
				data: nodeData ? JSON.parse(nodeData) : { label: type },
			};

			// Filter out placeholder and add new node
			setNodes((nds) => {
				const realNodes = nds.filter((n) => n.type !== "add");
				return [...realNodes, newNode];
			});
		},
		[setNodes, reactFlowInstance],
	);

	const commitGraph = useCallback(
		async (
			action: "save" | "run" | "publish" | "versions" | "schedule",
		) => {
			if (commitInFlight.current || isLoading) {
				return;
			}
			commitInFlight.current = true;
			setIsCommitting(true);
			const graph = serializeGraph({ nodes, edges });
			try {
				if (action === "run") {
					await onRun?.(graph.nodes, graph.edges);
				} else {
					await onSave?.(graph.nodes, graph.edges);
				}
				setSavedSignature(JSON.stringify(graph));
				if (action === "publish") {
					setShowPublishDialog(true);
				}
				if (action === "schedule") {
					setShowScheduleDialog(true);
				}
				if (action === "versions") {
					setShowVersionHistory(true);
				}
			} catch {
				// The command owner reports the error. Keep edits dirty and do not open publishing.
			} finally {
				commitInFlight.current = false;
				setIsCommitting(false);
			}
		},
		[nodes, edges, onSave, onRun, isLoading],
	);
	const handleSave = useCallback(() => {
		void commitGraph("save");
	}, [commitGraph]);
	const handleRun = useCallback(() => {
		void commitGraph("run");
	}, [commitGraph]);

	// Handler for updating node data
	const handleUpdateNode = useCallback(
		(nodeId: string, data: Partial<WorkflowNodeData>) => {
			setNodes((nds) =>
				nds.map((node) =>
					node.id === nodeId
						? { ...node, data: { ...node.data, ...data } }
						: node,
				),
			);
		},
		[setNodes],
	);

	// Handler for deleting a node
	const handleDeleteNode = useCallback(
		(nodeId: string) => {
			setNodes((nds) => nds.filter((node) => node.id !== nodeId));
			setEdges((eds) =>
				eds.filter(
					(edge) => edge.source !== nodeId && edge.target !== nodeId,
				),
			);
			if (selectedNodeId === nodeId) {
				setSelectedNodeId(null);
			}
		},
		[setNodes, setEdges, selectedNodeId],
	);

	// Handler for AI-generated workflows - supports create, update, and append actions
	const handleWorkflowGenerated = useCallback(
		(response: GeneratedWorkflowResponse) => {
			const {
				action,
				nodes: newNodes,
				edges: newEdges,
				updates,
				removals,
			} = response;

			switch (action) {
				case "replace":
					// Replace entire workflow with new nodes/edges
					if (newNodes && newNodes.length > 0) {
						const replacedEdges = newEdges ?? [];
						setNodes(
							withReadableLayout<Node>(newNodes, replacedEdges),
						);
						setEdges(replacedEdges);
						setSelectedNodeId(newNodes[0].id);
					}
					break;

				case "update":
					// Update existing nodes in place and/or remove nodes
					setNodes((nds) => {
						let updatedNodes = [...nds];

						// Apply node removals
						if (removals && removals.length > 0) {
							updatedNodes = updatedNodes.filter(
								(n) => !removals.includes(n.id),
							);
						}

						// Apply node updates (preserving IDs)
						if (updates && updates.length > 0) {
							updatedNodes = updatedNodes.map((node) => {
								const update = updates.find(
									(u) => u.nodeId === node.id,
								);
								if (update) {
									return {
										...node,
										data: {
											...node.data,
											...(update.newLabel && {
												label: update.newLabel,
											}),
											...(update.newConfig && {
												config: {
													...(node.data.config || {}),
													...update.newConfig,
												},
											}),
										},
									};
								}
								return node;
							});
						}

						return updatedNodes;
					});

					// Remove edges connected to removed nodes
					if (removals && removals.length > 0) {
						setEdges((eds) =>
							eds.filter(
								(e) =>
									!removals.includes(e.source) &&
									!removals.includes(e.target),
							),
						);
					}
					break;

				case "append": {
					// Add new nodes while keeping existing ones (placeholders
					// dropped), then lay out only if the result overlaps.
					const appendedEdges = [...edges, ...(newEdges ?? [])];
					setNodes(
						withReadableLayout<Node>(
							[...nodes.filter(isStepNode), ...(newNodes ?? [])],
							appendedEdges,
						),
					);
					setEdges(appendedEdges);

					// Select first new node if any
					if (newNodes && newNodes.length > 0) {
						setSelectedNodeId(newNodes[0].id);
					}
					break;
				}

				default:
					console.warn("[WorkflowBuilder] Unknown action:", action);
			}

			// Show the result in the inspector after any change
			setInspectorTab("workflow");
		},
		[nodes, edges, setNodes, setEdges],
	);

	// Check if we have real nodes (not just placeholder or empty-action)
	const hasRealNodes = nodes.some(isStepNode);

	const linearIntegrationEnabled = useFeatureFlag("LINEAR_INTEGRATION");

	const availableNodeDefinitions = useMemo(() => {
		if (linearIntegrationEnabled) {
			return nodeDefinitions;
		}
		return nodeDefinitions.filter(
			(node) => !node.type.startsWith("linear-"),
		);
	}, [linearIntegrationEnabled]);

	// Keyboard shortcuts for common actions
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// AI input toggle (⌘K or Ctrl+K)
			if ((e.metaKey || e.ctrlKey) && e.key === "k") {
				e.preventDefault();
				setShowAIInput((prev) => !prev);
				return;
			}

			// Undo (⌘Z or Ctrl+Z)
			if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
				e.preventDefault();
				handleUndo();
				return;
			}

			// Redo (⌘⇧Z or Ctrl+Shift+Z)
			if ((e.metaKey || e.ctrlKey) && e.key === "z" && e.shiftKey) {
				e.preventDefault();
				handleRedo();
				return;
			}

			// Save (⌘S or Ctrl+S)
			if ((e.metaKey || e.ctrlKey) && e.key === "s") {
				e.preventDefault();
				handleSave();
				return;
			}

			// Delete selected node (Delete or Backspace, when not editing)
			if (
				(e.key === "Delete" || e.key === "Backspace") &&
				selectedNodeId
			) {
				const activeElement = document.activeElement;
				const isEditing =
					activeElement?.tagName === "INPUT" ||
					activeElement?.tagName === "TEXTAREA";
				if (!isEditing) {
					e.preventDefault();
					handleDeleteNode(selectedNodeId);
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [handleUndo, handleRedo, handleSave, selectedNodeId, handleDeleteNode]);

	// Get selected node for properties
	const selectedNode = useMemo(() => {
		if (!selectedNodeId) {
			return null;
		}
		return (
			(nodes.find((n) => n.id === selectedNodeId) as
				| WorkflowNode
				| undefined) || null
		);
	}, [selectedNodeId, nodes]);

	const orderedSteps = useMemo(
		() => orderSteps(nodes, edges),
		[nodes, edges],
	);
	const triggerNode = nodes.find((n) => n.type === "trigger");

	// Placeholders open the palette when clicked or activated by keyboard.
	const nodesWithHandlers = useMemo(() => {
		return nodes.map((node) => {
			if (node.type === "add") {
				return {
					...node,
					data: {
						...node.data,
						onClick: handleAddFirstStep,
						onAskAi: () => setShowAIInput(true),
					},
				};
			}
			if (node.type === "empty-action") {
				return {
					...node,
					data: {
						...node.data,
						onClick: () => selectStep(node.id, "empty-action"),
					},
				};
			}
			return node;
		});
	}, [nodes, handleAddFirstStep, selectStep]);

	const canvasContext = useMemo(
		() => ({
			onInsertOnEdge: handleInsertOnEdge,
			steps: viewedRun?.steps ?? null,
		}),
		[handleInsertOnEdge, viewedRun],
	);

	const inspectorContent =
		inspectorTab === "add" ? (
			<AddStepPalette
				nodes={availableNodeDefinitions}
				onAdd={handleAddNode}
				integrationsPath={integrationsSettingsPath}
			/>
		) : selectedNode ? (
			<StepInspector
				resultCheckContext={
					workflowId && organizationId
						? { workflowId, organizationId }
						: undefined
				}
				availableVariables={
					selectedNode
						? workflowOutputOptions(
								selectedNode.id,
								nodes as WorkflowNode[],
								edges,
							)
						: []
				}
				node={selectedNode}
				onBack={() => setSelectedNodeId(null)}
				onUpdate={handleUpdateNode}
				onDelete={handleDeleteNode}
				viewedRun={viewedRun}
			/>
		) : (
			<WorkflowOverview
				onConfigureSchedule={
					workflowId && organizationId && onSave
						? () => void commitGraph("schedule")
						: undefined
				}
				workflowId={workflowId}
				workflowName={workflowName}
				onRename={onNameChange}
				nameSaveStatus={nameSaveStatus}
				nameRetryValue={nameRetryValue}
				status={workflowStatus}
				version={workflowVersion}
				publishedVersion={publishedVersion}
				triggerLabel={
					triggerNode ? triggerTypeLabel(triggerNode.data) : "None"
				}
				lastRun={lastRun}
				steps={orderedSteps}
				onSelectStep={(nodeId) =>
					selectStep(nodeId, nodes.find((n) => n.id === nodeId)?.type)
				}
			/>
		);

	return (
		<div className="flex h-full min-w-0 w-full flex-col overflow-hidden lg:flex-row">
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<EditorHeader
					workflowsPath={workflowsPath}
					workflowName={workflowName}
					onRename={onNameChange}
					nameSaveStatus={nameSaveStatus}
					status={workflowStatus}
					version={workflowVersion}
					publishedVersion={publishedVersion}
					canUndo={historyIndex > 0}
					canRedo={historyIndex < history.length - 1}
					onUndo={handleUndo}
					onRedo={handleRedo}
					onOpenVersions={
						workflowId
							? () => {
									void commitGraph("versions");
								}
							: undefined
					}
					onExport={handleExportJSON}
					onSave={handleSave}
					onPublish={
						workflowId
							? () => {
									void commitGraph("publish");
								}
							: undefined
					}
					onRun={handleRun}
					hasSteps={hasRealNodes}
					isBusy={isLoading || isCommitting}
					isDirty={dirty}
					onBeforeLeave={() =>
						!dirty ||
						window.confirm("Discard unsaved workflow changes?")
					}
				/>

				<div className="relative flex min-h-0 flex-1 overflow-hidden">
					{runsPanel && (
						<div className="absolute inset-y-0 left-0 z-30 flex xl:static xl:z-auto">
							{runsPanel}
						</div>
					)}

					<div className="workflow-canvas relative min-w-0 flex-1 overflow-hidden">
						<div
							className="h-full w-full"
							data-testid="workflow-canvas"
						>
							<WorkflowCanvasProvider value={canvasContext}>
								<ReactFlow
									nodes={nodesWithHandlers}
									edges={edges}
									onNodesChange={onNodesChange}
									onEdgesChange={onEdgesChange}
									onConnect={onConnect}
									onDragOver={onDragOver}
									onDrop={onDrop}
									nodeTypes={nodeTypes}
									edgeTypes={edgeTypes}
									defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
									onNodeClick={(_, node) =>
										selectStep(node.id, node.type)
									}
									onPaneClick={() => setSelectedNodeId(null)}
									fitView
									fitViewOptions={FIT_VIEW_OPTIONS}
									snapToGrid
									snapGrid={[15, 15]}
									style={{ width: "100%", height: "100%" }}
								>
									<Background
										variant={BackgroundVariant.Dots}
										gap={16}
										size={1}
										color="var(--input)"
										bgColor="var(--background)"
									/>
									<CanvasControls />
									<AddStepAnchor
										onAddStep={handleAppendStep}
									/>
								</ReactFlow>
							</WorkflowCanvasProvider>
						</div>

						{canvasOverlay}

						<AskAiBar
							open={showAIInput}
							onOpenChange={setShowAIInput}
							hasSteps={hasRealNodes}
							organizationId={organizationId}
							currentNodes={nodes.map((n) => ({
								id: n.id,
								type: n.type || "unknown",
								position: n.position,
								data: n.data,
							}))}
							currentEdges={edges.map((e) => ({
								id: e.id,
								source: e.source,
								target: e.target,
								sourceHandle: e.sourceHandle,
								targetHandle: e.targetHandle,
							}))}
							onWorkflowGenerated={handleWorkflowGenerated}
						/>
					</div>
				</div>
			</div>

			<InspectorPanel
				tab={inspectorTab}
				onTabChange={setInspectorTab}
				stepSelected={selectedNode !== null}
			>
				{inspectorContent}
			</InspectorPanel>
			{showScheduleDialog && workflowId && organizationId && (
				<WorkflowScheduleDialog
					open={showScheduleDialog}
					onOpenChange={setShowScheduleDialog}
					workflowId={workflowId}
					organizationId={organizationId}
					onConfigured={onPublished}
				/>
			)}
			{/* Publish Dialog */}
			{workflowId && (
				<PublishDialog
					organizationId={organizationId}
					open={showPublishDialog}
					onOpenChange={setShowPublishDialog}
					workflowId={workflowId}
					workflowName={workflowName}
					currentVersion={workflowVersion}
					status={workflowStatus}
					onPublished={onPublished}
				/>
			)}

			{/* Version History Panel */}
			{workflowId && (
				<VersionHistoryPanel
					organizationId={organizationId}
					onRestored={onPublished}
					open={showVersionHistory}
					onOpenChange={setShowVersionHistory}
					workflowId={workflowId}
					currentVersion={workflowVersion}
					publishedVersion={publishedVersion}
				/>
			)}
		</div>
	);
}

// Exported component wrapped with ReactFlowProvider for proper hook usage
export function WorkflowBuilder(props: WorkflowBuilderProps) {
	return (
		<ReactFlowProvider>
			<WorkflowBuilderInner
				key={`${props.organizationId}:${props.workflowId}`}
				{...props}
			/>
		</ReactFlowProvider>
	);
}
