"use client";

import {
	addEdge,
	Background,
	BackgroundVariant,
	type Connection,
	Controls,
	type Edge,
	MiniMap,
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
import { FullscreenToggle } from "@saas/shared/components/FullscreenToggle";
import { ThemeToggle } from "@saas/shared/components/ThemeToggle";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { ScrollArea } from "@ui/components/scroll-area";
import { SearchInput } from "@ui/components/search-input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ArrowLeftIcon,
	BellIcon,
	ChevronDownIcon,
	CircleDotIcon,
	CompassIcon,
	DownloadIcon,
	FileTextIcon,
	GitBranchIcon,
	GlobeIcon,
	HistoryIcon,
	ImageIcon,
	MailIcon,
	MessageSquareIcon,
	PencilIcon,
	PlayIcon,
	PlugIcon,
	PlusIcon,
	RedoIcon,
	RocketIcon,
	SaveIcon,
	SearchIcon,
	SendIcon,
	SparklesIcon,
	TicketPlusIcon,
	UndoIcon,
	VideoIcon,
	WrenchIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { nodeDefinitions } from "../lib/node-definitions";
// Import plugins to auto-register them
import "../lib/plugins";
import { getIntegrationByNodeType } from "../lib/plugins/registry";
import type {
	WorkflowEdge,
	WorkflowNode,
	WorkflowNodeData,
	WorkflowNodeType,
} from "../lib/types";
import { NodeConfigEditor } from "./NodeConfigEditor";
import { AddNode } from "./nodes/AddNode";
import { EmptyActionNode } from "./nodes/EmptyActionNode";
import { WorkflowNodeComponent } from "./nodes/WorkflowNode";
import { PublishDialog } from "./PublishDialog";
import {
	type GeneratedWorkflowResponse,
	TextToWorkflow,
} from "./TextToWorkflow";
import { VersionHistoryPanel } from "./VersionHistoryPanel";

interface WorkflowBuilderProps {
	initialNodes?: WorkflowNode[];
	initialEdges?: WorkflowEdge[];
	onSave?: (nodes: WorkflowNode[], edges: WorkflowEdge[]) => void;
	onRun?: (nodes: WorkflowNode[], edges: WorkflowEdge[]) => void;
	onToggleRunHistory?: () => void;
	showRunHistory?: boolean;
	isLoading?: boolean;
	workflowName?: string;
	workflowId?: string;
	onNameChange?: (name: string) => void;
	organizationId?: string | null;
	// Publishing props
	workflowStatus?: "DRAFT" | "PUBLISHED" | "ACTIVE" | "PAUSED" | "ARCHIVED";
	workflowVersion?: number;
	publishedVersion?: number | null;
	onPublished?: () => void;
}

// Icon mapping for node types
const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
	Play: PlayIcon,
	Sparkles: SparklesIcon,
	Image: ImageIcon,
	Video: VideoIcon,
	Globe: GlobeIcon,
	Search: SearchIcon,
	Send: SendIcon,
	GitBranch: GitBranchIcon,
	TicketPlus: TicketPlusIcon,
	Mail: MailIcon,
	MessageSquare: MessageSquareIcon,
	Wrench: WrenchIcon,
	Bell: BellIcon,
	CircleDot: CircleDotIcon,
	FileText: FileTextIcon,
	Compass: CompassIcon,
};

// Helper function to get icon component
// First checks for a plugin-provided icon, then falls back to Lucide icons
const getNodeIcon = (iconName: string, nodeType?: string) => {
	// If we have a node type, check if the plugin has a custom icon
	if (nodeType) {
		const plugin = getIntegrationByNodeType(nodeType);
		if (plugin?.icon && typeof plugin.icon === "function") {
			return plugin.icon;
		}
	}
	// Fall back to Lucide icon by name
	return iconMap[iconName] || PlayIcon;
};

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

// Inner component that uses useReactFlow hook
function WorkflowBuilderInner({
	initialNodes = [],
	initialEdges = [],
	onSave,
	onRun,
	onToggleRunHistory,
	showRunHistory = true,
	isLoading = false,
	workflowName = "Untitled Workflow",
	workflowId = "",
	onNameChange,
	organizationId,
	workflowStatus = "DRAFT",
	workflowVersion = 1,
	publishedVersion,
	onPublished,
}: WorkflowBuilderProps) {
	const tTooltips = useTranslations("tooltips.common");
	// Get React Flow instance for proper coordinate conversion
	const reactFlowInstance = useReactFlow();
	const workflowsPath = useContextPath("workflows");
	const [showPropertiesPanel, setShowPropertiesPanel] = useState(true);
	const [showMiniMap, setShowMiniMap] = useState(false);
	const [activeTab, setActiveTab] = useState<
		"properties" | "actions" | "integrations"
	>("properties");
	const [searchQuery, setSearchQuery] = useState("");
	const integrationsSettingsPath = useContextPath(
		"settings/integrations/actions",
	);
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [showPublishDialog, setShowPublishDialog] = useState(false);
	const [showVersionHistory, setShowVersionHistory] = useState(false);
	const [isEditingName, setIsEditingName] = useState(false);
	const [editedName, setEditedName] = useState(workflowName);
	const [showAIInput, setShowAIInput] = useState(false);
	const [panelWidth, setPanelWidth] = useState(320); // Default panel width
	const isResizing = useRef(false);

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

	// Initialize with placeholder if empty, otherwise with initial nodes
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
		return initialNodes as unknown as Node[];
	};

	const [nodes, setNodes, onNodesChange] = useNodesState(getStartingNodes());
	const [edges, setEdges, onEdgesChange] = useEdgesState(
		initialEdges as unknown as Edge[],
	);

	// Update nodes when initialNodes change
	useEffect(() => {
		if (initialNodes.length > 0) {
			setNodes(initialNodes as unknown as Node[]);
		}
	}, [initialNodes, setNodes]);

	// Update edited name when workflow name changes
	useEffect(() => {
		setEditedName(workflowName);
	}, [workflowName]);

	// Save to history when nodes or edges change (for undo/redo)
	// Uses debouncing to avoid creating too many history entries during rapid changes
	useEffect(() => {
		if (isUpdatingFromHistory.current) {
			isUpdatingFromHistory.current = false;
			return;
		}

		// Only save if we have real nodes (not just placeholders)
		const hasRealNodes = nodes.some(
			(n) => n.type !== "add" && n.type !== "empty-action",
		);
		if (!hasRealNodes) {
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

	// Export workflow as JSON
	const handleExportJSON = useCallback(() => {
		const realNodes = nodes
			.filter((n) => n.type !== "add" && n.type !== "empty-action")
			.map((node) => ({
				id: node.id,
				type: node.type,
				position: node.position,
				data: node.data,
			}));

		const cleanEdges = edges.map((edge) => ({
			id: edge.id,
			source: edge.source,
			target: edge.target,
			sourceHandle: edge.sourceHandle,
			targetHandle: edge.targetHandle,
		}));

		const workflowCode = {
			name: workflowName,
			nodes: realNodes,
			edges: cleanEdges,
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

	// Export workflow as TypeScript code (for saved workflows)
	const handleExportCode = useCallback(() => {
		// For saved workflows, we could use the API to generate TypeScript code
		// For now, export as JSON with a note about TypeScript generation
		handleExportJSON();
	}, [handleExportJSON]);

	// Handle name save
	const handleNameSave = useCallback(() => {
		if (editedName.trim() && editedName !== workflowName) {
			onNameChange?.(editedName.trim());
		}
		setIsEditingName(false);
	}, [editedName, workflowName, onNameChange]);

	// Handle name cancel
	const handleNameCancel = useCallback(() => {
		setEditedName(workflowName);
		setIsEditingName(false);
	}, [workflowName]);

	// Handler for "Add a Step" button - adds empty action node
	const handleAddFirstStep = useCallback(() => {
		const newNode: Node = {
			id: `empty-action-${crypto.randomUUID()}`,
			type: "empty-action",
			position: { x: 250, y: 100 },
			data: {
				label: "Action",
				onClick: () => {
					setSelectedNodeId(`empty-action-${crypto.randomUUID()}`);
					setShowPropertiesPanel(true);
					setActiveTab("actions");
				},
			},
		};
		setNodes([newNode]);
		// Auto-select and open actions panel
		setSelectedNodeId(newNode.id);
		setShowPropertiesPanel(true);
		setActiveTab("actions");
	}, [setNodes]);

	// Handler for adding a new node from the properties panel
	const handleAddNode = useCallback(
		(nodeType: string, nodeData: Record<string, unknown>) => {
			// If there's a selected empty-action node, replace it
			const selectedNode = nodes.find((n) => n.id === selectedNodeId);

			if (selectedNode && selectedNode.type === "empty-action") {
				// Replace the empty action node with the actual node
				const newId = `${nodeType}-${crypto.randomUUID()}`;
				setNodes((nds) =>
					nds.map((node) =>
						node.id === selectedNodeId
							? {
									...node,
									id: newId,
									type: nodeType as WorkflowNodeType,
									data: {
										...nodeData,
									},
								}
							: node,
					),
				);
				// Update selected node ID and switch to properties tab
				setSelectedNodeId(newId);
				setActiveTab("properties");
			} else {
				// Add new node at a position relative to existing nodes
				const lastNode = nodes.reduce(
					(prev, curr) => {
						if (
							curr.type === "add" ||
							curr.type === "empty-action"
						) {
							return prev;
						}
						return curr.position.x > prev.position.x ? curr : prev;
					},
					{ position: { x: 0, y: 100 } },
				);

				const newId = `${nodeType}-${crypto.randomUUID()}`;
				const newNode: Node = {
					id: newId,
					type: nodeType as WorkflowNodeType,
					position: {
						x: lastNode.position.x + 250,
						y: lastNode.position.y,
					},
					data: {
						...nodeData,
					},
				};

				// Filter out placeholder and add new node
				setNodes((nds) => {
					const realNodes = nds.filter((n) => n.type !== "add");
					return [...realNodes, newNode];
				});

				// Select the new node and switch to properties
				setSelectedNodeId(newId);
				setActiveTab("properties");
			}
		},
		[nodes, selectedNodeId, setNodes],
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

	const handleSave = useCallback(() => {
		// Filter out placeholder and empty-action nodes before saving
		const realNodes = nodes
			.filter((n) => n.type !== "add" && n.type !== "empty-action")
			.map((node) => ({
				id: node.id,
				type: node.type,
				position: node.position,
				data: node.data,
			}));

		// Clean edges to only include essential properties
		const cleanEdges = edges.map((edge) => ({
			id: edge.id,
			source: edge.source,
			target: edge.target,
			sourceHandle: edge.sourceHandle,
			targetHandle: edge.targetHandle,
		}));

		// Deep clone to strip out non-serializable properties (functions, DOM elements, React fibers, etc.)
		const serializedNodes = JSON.parse(JSON.stringify(realNodes));
		const serializedEdges = JSON.parse(JSON.stringify(cleanEdges));

		onSave?.(
			serializedNodes as unknown as WorkflowNode[],
			serializedEdges as unknown as WorkflowEdge[],
		);
	}, [nodes, edges, onSave]);

	const handleRun = useCallback(() => {
		// Filter out placeholder and empty-action nodes before running
		const realNodes = nodes
			.filter((n) => n.type !== "add" && n.type !== "empty-action")
			.map((node) => ({
				id: node.id,
				type: node.type,
				position: node.position,
				data: node.data,
			}));

		// Clean edges to only include essential properties
		const cleanEdges = edges.map((edge) => ({
			id: edge.id,
			source: edge.source,
			target: edge.target,
			sourceHandle: edge.sourceHandle,
			targetHandle: edge.targetHandle,
		}));

		// Deep clone to strip out non-serializable properties (functions, DOM elements, React fibers, etc.)
		// This removes onClick handlers and other React-specific properties that cause circular reference errors
		const serializedNodes = JSON.parse(JSON.stringify(realNodes));
		const serializedEdges = JSON.parse(JSON.stringify(cleanEdges));

		onRun?.(
			serializedNodes as unknown as WorkflowNode[],
			serializedEdges as unknown as WorkflowEdge[],
		);
	}, [nodes, edges, onRun]);

	// Panel resize handlers
	const handleResizeStart = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			isResizing.current = true;

			const startX = e.clientX;
			const startWidth = panelWidth;

			const handleMouseMove = (moveEvent: MouseEvent) => {
				if (!isResizing.current) {
					return;
				}
				const delta = startX - moveEvent.clientX;
				const newWidth = Math.min(
					600,
					Math.max(280, startWidth + delta),
				);
				setPanelWidth(newWidth);
			};

			const handleMouseUp = () => {
				isResizing.current = false;
				document.removeEventListener("mousemove", handleMouseMove);
				document.removeEventListener("mouseup", handleMouseUp);
			};

			document.addEventListener("mousemove", handleMouseMove);
			document.addEventListener("mouseup", handleMouseUp);
		},
		[panelWidth],
	);

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
						setNodes(newNodes as unknown as Node[]);
						setEdges((newEdges || []) as unknown as Edge[]);
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

				case "append":
					// Add new nodes while keeping existing ones
					setNodes((nds) => {
						// Remove placeholder nodes
						const realNodes = nds.filter(
							(n) =>
								n.type !== "add" && n.type !== "empty-action",
						);
						// Append new nodes
						return [
							...realNodes,
							...((newNodes || []) as unknown as Node[]),
						];
					});

					// Add new edges to existing edges
					if (newEdges && newEdges.length > 0) {
						setEdges((eds) => [
							...eds,
							...(newEdges as unknown as Edge[]),
						]);
					}

					// Select first new node if any
					if (newNodes && newNodes.length > 0) {
						setSelectedNodeId(newNodes[0].id);
					}
					break;

				default:
					console.warn("[WorkflowBuilder] Unknown action:", action);
			}

			// Show properties panel after any change
			setShowPropertiesPanel(true);
			setActiveTab("properties");
		},
		[setNodes, setEdges],
	);

	// Check if we have real nodes (not just placeholder or empty-action)
	const hasRealNodes = nodes.some(
		(n) => n.type !== "add" && n.type !== "empty-action",
	);

	// Filter node definitions based on search
	const filteredNodes = useMemo(() => {
		if (!searchQuery) {
			return nodeDefinitions;
		}
		const query = searchQuery.toLowerCase();
		return nodeDefinitions.filter(
			(node) =>
				node.label.toLowerCase().includes(query) ||
				node.description.toLowerCase().includes(query) ||
				node.category.toLowerCase().includes(query),
		);
	}, [searchQuery]);

	// Group the palette by category, preserving nodeDefinitions' order so
	// system nodes stay at the top.
	const filteredCategories = useMemo(() => {
		const groups: { category: string; nodes: typeof filteredNodes }[] = [];
		for (const node of filteredNodes) {
			const existing = groups.find((g) => g.category === node.category);
			if (existing) {
				existing.nodes.push(node);
			} else {
				groups.push({ category: node.category, nodes: [node] });
			}
		}
		return groups;
	}, [filteredNodes]);

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

	// Update nodes with handlers
	const nodesWithHandlers = useMemo(() => {
		return nodes.map((node) => {
			if (node.type === "add") {
				return {
					...node,
					data: {
						...node.data,
						onClick: handleAddFirstStep,
					},
				};
			}
			if (node.type === "empty-action") {
				return {
					...node,
					data: {
						...node.data,
						onClick: () => {
							setSelectedNodeId(node.id);
							setShowPropertiesPanel(true);
							setActiveTab("actions");
						},
					},
				};
			}
			// Add delete handler to all other nodes
			return {
				...node,
				data: {
					...node.data,
					onDelete: () => handleDeleteNode(node.id),
				},
			};
		});
	}, [nodes, handleAddFirstStep, handleDeleteNode]);

	return (
		<div className="h-full w-full flex flex-col overflow-hidden">
			{/* Top Toolbar */}
			<div className="h-14 border-b bg-background flex items-center justify-between px-4">
				<div className="flex items-center gap-4">
					<Link
						href={workflowsPath}
						className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
					>
						<ArrowLeftIcon className="h-4 w-4" />
					</Link>
					{isEditingName ? (
						<div className="flex items-center gap-2">
							<Input
								value={editedName}
								onChange={(e) => setEditedName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										handleNameSave();
									} else if (e.key === "Escape") {
										handleNameCancel();
									}
								}}
								className="h-8 w-64"
								autoFocus
								onBlur={handleNameSave}
							/>
						</div>
					) : (
						<span className="group flex items-center gap-2">
							<span className="text-lg font-semibold">
								{workflowName}
							</span>
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										onClick={() => setIsEditingName(true)}
										className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity cursor-pointer text-muted-foreground"
										aria-label="Rename workflow"
									>
										<PencilIcon className="size-4" />
									</button>
								</TooltipTrigger>
								<TooltipContent>
									{tTooltips("clickToRename", {
										subject: "workflow",
									})}
								</TooltipContent>
							</Tooltip>
						</span>
					)}
					<div className="flex items-center gap-1">
						<Button
							variant="outline"
							size="icon"
							onClick={() => {
								// Add empty action node
								const lastNode = nodes.reduce(
									(prev, curr) => {
										if (
											curr.type === "add" ||
											curr.type === "empty-action"
										) {
											return prev;
										}
										return curr.position.x > prev.position.x
											? curr
											: prev;
									},
									{ position: { x: 0, y: 100 } },
								);

								const newNode: Node = {
									id: `empty-action-${crypto.randomUUID()}`,
									type: "empty-action",
									position: {
										x: lastNode.position.x + 250,
										y: lastNode.position.y,
									},
									data: {
										label: "Action",
									},
								};

								setNodes((nds) => {
									const realNodes = nds.filter(
										(n) => n.type !== "add",
									);
									return [...realNodes, newNode];
								});

								// Select the new node and open actions panel
								setSelectedNodeId(newNode.id);
								setShowPropertiesPanel(true);
								setActiveTab("actions");
							}}
							title="Add action"
						>
							<PlusIcon className="h-4 w-4" />
						</Button>
						<Button
							variant="outline"
							size="icon"
							onClick={handleUndo}
							disabled={historyIndex <= 0}
							title="Undo"
						>
							<UndoIcon className="h-4 w-4" />
						</Button>
						<Button
							variant="outline"
							size="icon"
							onClick={handleRedo}
							disabled={historyIndex >= history.length - 1}
							title="Redo"
						>
							<RedoIcon className="h-4 w-4" />
						</Button>
						<Button
							variant="outline"
							size="icon"
							onClick={handleExportCode}
							disabled={!hasRealNodes}
							title="Export workflow as code"
						>
							<DownloadIcon className="h-4 w-4" />
						</Button>
					</div>
				</div>
				<div className="flex items-center gap-2">
					{onToggleRunHistory && (
						<Button
							variant={showRunHistory ? "outline" : "secondary"}
							size="sm"
							onClick={onToggleRunHistory}
							title={
								showRunHistory
									? "Hide run history"
									: "Show run history"
							}
						>
							<HistoryIcon className="h-4 w-4 mr-2" />
							{showRunHistory ? "Hide Runs" : "Show Runs"}
						</Button>
					)}
					<Button
						variant="outline"
						size="sm"
						onClick={handleSave}
						disabled={isLoading || !hasRealNodes}
						data-testid="workflow-save"
					>
						<SaveIcon className="h-4 w-4 mr-2" />
						Save
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setShowVersionHistory(true)}
						disabled={!workflowId}
						title="View version history"
					>
						<HistoryIcon className="h-4 w-4 mr-2" />v
						{workflowVersion}
					</Button>
					<Button
						variant={
							workflowStatus === "PUBLISHED" ||
							workflowStatus === "ACTIVE"
								? "secondary"
								: "default"
						}
						size="sm"
						onClick={() => setShowPublishDialog(true)}
						disabled={isLoading || !hasRealNodes || !workflowId}
					>
						<RocketIcon className="h-4 w-4 mr-2" />
						{workflowStatus === "PUBLISHED" ||
						workflowStatus === "ACTIVE"
							? "Published"
							: "Publish"}
					</Button>
					<Button
						variant="default"
						size="sm"
						onClick={handleRun}
						disabled={isLoading || !hasRealNodes}
						data-testid="workflow-run"
					>
						<PlayIcon className="h-4 w-4 mr-2" />
						Run
					</Button>
					<div className="flex items-center gap-1 pl-2 border-l border-border">
						<ThemeToggle variant="inline" />
						<FullscreenToggle variant="inline" />
					</div>
				</div>
			</div>

			<div className="flex-1 flex overflow-hidden">
				{/* Canvas */}
				<div className="flex-1 h-full flex flex-col relative overflow-hidden">
					<div
						className="flex-1 w-full h-full"
						data-testid="workflow-canvas"
					>
						<ReactFlow
							nodes={nodesWithHandlers}
							edges={edges}
							onNodesChange={onNodesChange}
							onEdgesChange={onEdgesChange}
							onConnect={onConnect}
							onDragOver={onDragOver}
							onDrop={onDrop}
							nodeTypes={nodeTypes}
							onNodeClick={(_, node) => {
								setSelectedNodeId(node.id);
								setShowPropertiesPanel(true);
								// If clicking empty-action node, show Actions tab
								// Otherwise show Properties tab
								if (node.type === "empty-action") {
									setActiveTab("actions");
								} else {
									setActiveTab("properties");
								}
							}}
							onPaneClick={() => setSelectedNodeId(null)}
							fitView
							snapToGrid
							snapGrid={[15, 15]}
							defaultEdgeOptions={{
								animated: true,
								style: { strokeWidth: 2 },
							}}
							style={{ width: "100%", height: "100%" }}
						>
							<Background
								variant={BackgroundVariant.Dots}
								gap={15}
								size={1}
							/>
							<Controls showInteractive={false}>
								<Button
									variant="outline"
									size="icon"
									onClick={() => setShowMiniMap(!showMiniMap)}
									title="Toggle minimap"
									className="h-8 w-8 rounded-md border border-border bg-background text-foreground hover:bg-muted"
								>
									{showMiniMap ? "📍" : "🗺️"}
								</Button>
							</Controls>
							{showMiniMap && (
								<MiniMap
									nodeStrokeWidth={3}
									zoomable
									pannable
									className="bg-background border rounded-lg shadow-lg"
									style={{ zIndex: 40 }}
								/>
							)}
						</ReactFlow>
					</div>

					{/* AI Input at Bottom - Collapsible */}
					<div className="absolute bottom-0 left-0 right-0 z-10 flex justify-center">
						{showAIInput ? (
							<div className="w-full max-w-3xl bg-background border-t p-4">
								<div className="flex items-center justify-between mb-3">
									<Label className="text-sm font-medium">
										{hasRealNodes
											? "Describe changes to your workflow"
											: "Describe your workflow"}
									</Label>
									<Button
										variant="ghost"
										size="icon"
										className="h-6 w-6"
										onClick={() => setShowAIInput(false)}
									>
										<ChevronDownIcon className="h-4 w-4" />
									</Button>
								</div>
								<TextToWorkflow
									inline
									organizationId={organizationId}
									currentNodes={nodes.map((n) => ({
										id: n.id,
										type: n.type || "unknown",
										position: n.position,
										data: n.data as Record<string, unknown>,
									}))}
									currentEdges={edges.map((e) => ({
										id: e.id,
										source: e.source,
										target: e.target,
										sourceHandle: e.sourceHandle,
										targetHandle: e.targetHandle,
									}))}
									onWorkflowGenerated={
										handleWorkflowGenerated
									}
								/>
							</div>
						) : (
							<button
								type="button"
								onClick={() => setShowAIInput(true)}
								className="w-full max-w-md bg-background border-t px-4 py-2 flex items-center gap-2 hover:bg-muted/50 transition-all cursor-pointer"
							>
								<SparklesIcon className="h-4 w-4 text-muted-foreground" />
								<span className="text-sm text-muted-foreground">
									Ask AI...
								</span>
								<kbd className="ml-auto pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
									<span className="text-xs">⌘</span>K
								</kbd>
							</button>
						)}
					</div>
				</div>

				{/* Right Properties Panel - Resizable */}
				{showPropertiesPanel && (
					<div
						className="border-l bg-background flex flex-col overflow-hidden relative"
						style={{
							width: `${panelWidth}px`,
							minWidth: "280px",
							maxWidth: "600px",
						}}
					>
						{/* Resize handle */}
						{/* biome-ignore lint/a11y/noStaticElementInteractions: drag-resize handle; uses onMouseDown for resizing, not a clickable action */}
						<div
							className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-primary/50 transition-colors z-10"
							onMouseDown={handleResizeStart}
						/>
						<Tabs
							value={activeTab}
							onValueChange={(value) =>
								setActiveTab(
									value as
										| "properties"
										| "actions"
										| "integrations",
								)
							}
							className="flex-1 flex flex-col overflow-hidden"
						>
							<TabsList className="w-full justify-start rounded-none border-b h-auto p-0">
								<TabsTrigger
									value="properties"
									className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-primary"
								>
									Properties
								</TabsTrigger>
								<TabsTrigger
									value="actions"
									className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-primary"
									data-testid="workflow-actions-tab"
								>
									Actions
								</TabsTrigger>
								<TabsTrigger
									value="integrations"
									className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-primary"
								>
									<PlugIcon className="h-3 w-3 mr-1" />
									Integrations
								</TabsTrigger>
							</TabsList>

							<TabsContent
								value="properties"
								className="flex-1 mt-0 flex flex-col overflow-hidden"
							>
								<ScrollArea className="flex-1 min-h-0">
									<div className="p-4">
										{selectedNode ? (
											<NodeConfigEditor
												node={selectedNode}
												onUpdate={handleUpdateNode}
												onDelete={handleDeleteNode}
											/>
										) : (
											<div className="space-y-4">
												<div>
													<p className="text-sm font-medium">
														Workflow Name
													</p>
													<p className="text-sm text-muted-foreground">
														{workflowName}
													</p>
												</div>
												<div>
													<p className="text-sm font-medium">
														Workflow ID
													</p>
													<p className="text-xs text-muted-foreground font-mono">
														{workflowId ||
															"Not saved"}
													</p>
												</div>
												<div className="pt-2 border-t">
													<p className="text-sm text-muted-foreground">
														Select a node to edit
														its properties
													</p>
												</div>
											</div>
										)}
									</div>
								</ScrollArea>
							</TabsContent>

							<TabsContent
								value="actions"
								className="flex-1 mt-0 flex flex-col overflow-hidden"
							>
								<div className="p-4 border-b shrink-0">
									<h3 className="font-semibold mb-2">
										Search Actions
									</h3>
									<div className="relative">
										<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
										<SearchInput
											placeholder="Search actions..."
											value={searchQuery}
											onChange={(e) =>
												setSearchQuery(e.target.value)
											}
											className="pl-9"
										/>
									</div>
								</div>
								<ScrollArea className="flex-1 min-h-0">
									<div className="p-3 space-y-4">
										{/* Grouped by category. The palette went
										    from 18 entries to ~40 when it started
										    reading the plugin registry, which is
										    too many for one flat grid. */}
										{filteredCategories.map((group) => (
											<div key={group.category}>
												<p className="px-1 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
													{group.category}
												</p>
												<div className="grid grid-cols-2 gap-2">
													{group.nodes.map((node) => {
														const Icon =
															getNodeIcon(
																node.icon,
																node.type,
															);
														return (
															<button
																type="button"
																key={node.type}
																title={
																	node.description
																}
																data-testid={`workflow-action-${node.type}`}
																onClick={() =>
																	handleAddNode(
																		node.type,
																		node.defaultData,
																	)
																}
																className={cn(
																	"flex flex-col items-center gap-2 p-3 rounded-lg border",
																	"hover:bg-muted/50 hover:border-primary/50 cursor-pointer",
																	"transition-all text-center group",
																)}
															>
																<div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/20 transition-colors">
																	<Icon className="h-6 w-6 text-primary" />
																</div>
																<div className="flex-1 min-w-0 w-full">
																	<p className="text-xs font-medium truncate">
																		{
																			node.label
																		}
																	</p>
																</div>
															</button>
														);
													})}
												</div>
											</div>
										))}
										{filteredNodes.length === 0 && (
											<div className="text-center py-8 text-sm text-muted-foreground">
												No actions found
											</div>
										)}
									</div>
								</ScrollArea>
							</TabsContent>

							<TabsContent
								value="integrations"
								className="flex-1 mt-0 flex flex-col overflow-hidden"
							>
								<div className="p-4">
									<Card>
										<CardHeader>
											<CardTitle>
												Integration Providers
											</CardTitle>
											<CardDescription>
												Connect the systems Fabric can
												call at runtime, then manage
												credentials and available
												actions in the integrations
												settings flow.
											</CardDescription>
										</CardHeader>
										<CardContent className="flex items-center justify-between gap-4">
											<p className="text-sm text-muted-foreground">
												The old inline popup flow has
												been removed. Manage credentials
												and providers from the
												page-based integrations
												experience instead.
											</p>
											<Button asChild>
												<Link
													href={
														integrationsSettingsPath
													}
												>
													Open Integrations
												</Link>
											</Button>
										</CardContent>
									</Card>
								</div>
							</TabsContent>
						</Tabs>
					</div>
				)}
			</div>

			{/* Publish Dialog */}
			{workflowId && (
				<PublishDialog
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
			<WorkflowBuilderInner {...props} />
		</ReactFlowProvider>
	);
}
