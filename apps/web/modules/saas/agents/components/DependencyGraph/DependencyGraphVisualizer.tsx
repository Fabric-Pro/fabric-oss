"use client";

import { Badge } from "@ui/components/badge";
import { ScrollArea } from "@ui/components/scroll-area";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertTriangle,
	ArrowRight,
	ChevronDown,
	ChevronRight,
	Circle,
	Layers,
	Zap,
} from "lucide-react";
import { useMemo, useState } from "react";

/**
 * Types for dependency visualization (CUGA-inspired)
 */
interface DependencyNode {
	id: string;
	label: string;
	level: number;
	type: string;
	riskScore?: number;
	estimate?: number;
}

interface DependencyEdge {
	from: string;
	to: string;
	type: "blocks" | "depends";
}

interface DependencyGraph {
	nodes: DependencyNode[];
	edges: DependencyEdge[];
	criticalPath: string[];
	totalCriticalPathDuration: number;
}

interface DependencyGraphVisualizerProps {
	graph: DependencyGraph;
	className?: string;
	onNodeClick?: (nodeId: string) => void;
	highlightedNode?: string;
}

/**
 * Color mapping for task types
 */
const TYPE_COLORS: Record<string, string> = {
	Frontend: "bg-blue-500",
	Backend: "bg-green-500",
	Database: "bg-purple-500",
	DevOps: "bg-orange-500",
	Testing: "bg-cyan-500",
	Documentation: "bg-gray-500",
};

/**
 * Get risk level from score
 */
function getRiskLevel(score?: number): { level: string; color: string } {
	if (!score || score < 30) {
		return { level: "Low", color: "text-success" };
	}
	if (score < 50) {
		return { level: "Medium", color: "text-yellow-500" };
	}
	if (score < 70) {
		return { level: "High", color: "text-orange-500" };
	}
	return { level: "Critical", color: "text-destructive" };
}

/**
 * Dependency Graph Visualizer Component
 *
 * Displays a CUGA-inspired dependency graph with:
 * - Level-based layout (tasks organized by dependency depth)
 * - Critical path highlighting
 * - Risk score indicators
 * - Task type color coding
 * - Interactive node selection
 */
export function DependencyGraphVisualizer({
	graph,
	className,
	onNodeClick,
	highlightedNode,
}: DependencyGraphVisualizerProps) {
	const [expandedLevels, setExpandedLevels] = useState<Set<number>>(
		new Set([0, 1, 2]),
	);

	// Group nodes by level
	const nodesByLevel = useMemo(() => {
		const levels = new Map<number, DependencyNode[]>();
		for (const node of graph.nodes) {
			const level = node.level ?? 0;
			if (!levels.has(level)) {
				levels.set(level, []);
			}
			levels.get(level)?.push(node);
		}
		return levels;
	}, [graph.nodes]);

	// Get edges for a node
	const getNodeEdges = (nodeId: string) => {
		return {
			dependencies: graph.edges
				.filter((e) => e.to === nodeId && e.type === "depends")
				.map((e) => e.from),
			blockedBy: graph.edges
				.filter((e) => e.to === nodeId && e.type === "blocks")
				.map((e) => e.from),
			blocks: graph.edges
				.filter((e) => e.from === nodeId)
				.map((e) => e.to),
		};
	};

	const toggleLevel = (level: number) => {
		const newExpanded = new Set(expandedLevels);
		if (newExpanded.has(level)) {
			newExpanded.delete(level);
		} else {
			newExpanded.add(level);
		}
		setExpandedLevels(newExpanded);
	};

	const isCriticalNode = (nodeId: string) =>
		graph.criticalPath.includes(nodeId);

	const sortedLevels = Array.from(nodesByLevel.entries()).sort(
		([a], [b]) => a - b,
	);

	if (graph.nodes.length === 0) {
		return (
			<div
				className={cn(
					"p-4 text-center text-muted-foreground",
					className,
				)}
			>
				<Layers className="h-8 w-8 mx-auto mb-2 opacity-50" />
				<p>No dependency graph available</p>
			</div>
		);
	}

	return (
		<div className={cn("rounded-lg border bg-card", className)}>
			{/* Header */}
			<div className="flex items-center justify-between p-3 border-b">
				<h3 className="text-sm font-medium flex items-center gap-2">
					<Layers className="h-4 w-4" />
					Dependency Graph
				</h3>
				<div className="flex items-center gap-4 text-xs text-muted-foreground">
					<span className="flex items-center gap-1">
						<Circle className="h-3 w-3 fill-amber-500 text-highlight" />
						Critical Path ({graph.criticalPath.length})
					</span>
					<span>{graph.totalCriticalPathDuration}h total</span>
				</div>
			</div>

			{/* Graph visualization */}
			<ScrollArea className="max-h-[400px]">
				<div className="p-3 space-y-2">
					{sortedLevels.map(([level, nodes]) => (
						<div key={level} className="space-y-1">
							{/* Level header */}
							<button
								type="button"
								onClick={() => toggleLevel(level)}
								className="flex items-center gap-2 w-full p-1 text-left text-sm font-medium text-muted-foreground hover:text-foreground"
							>
								{expandedLevels.has(level) ? (
									<ChevronDown className="h-4 w-4" />
								) : (
									<ChevronRight className="h-4 w-4" />
								)}
								<span>Level {level}</span>
								<Badge variant="outline" className="ml-2">
									{nodes.length}{" "}
									{nodes.length === 1 ? "task" : "tasks"}
								</Badge>
								{level === 0 && (
									<span className="text-xs text-success flex items-center gap-1">
										<Zap className="h-3 w-3" />
										Can start immediately
									</span>
								)}
							</button>

							{/* Level nodes */}
							{expandedLevels.has(level) && (
								<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 ml-6">
									{nodes.map((node) => {
										const edges = getNodeEdges(node.id);
										const risk = getRiskLevel(
											node.riskScore,
										);
										const isCritical = isCriticalNode(
											node.id,
										);
										const isHighlighted =
											highlightedNode === node.id;

										return (
											<TooltipProvider key={node.id}>
												<Tooltip>
													<TooltipTrigger asChild>
														<button
															type="button"
															onClick={() =>
																onNodeClick?.(
																	node.id,
																)
															}
															className={cn(
																"flex flex-col p-2 rounded-md border text-left transition-colors",
																"hover:bg-muted/50",
																isCritical &&
																	"border-amber-500 border-2",
																isHighlighted &&
																	"ring-2 ring-primary",
															)}
														>
															<div className="flex items-center gap-2">
																<div
																	className={cn(
																		"h-2 w-2 rounded-full",
																		TYPE_COLORS[
																			node
																				.type
																		] ||
																			"bg-gray-400",
																	)}
																/>
																<span className="text-xs font-mono text-muted-foreground">
																	{node.id}
																</span>
																{isCritical && (
																	<Badge
																		variant="outline"
																		className="text-highlight border-amber-500"
																	>
																		Critical
																	</Badge>
																)}
															</div>
															<p className="text-sm font-medium mt-1 line-clamp-1">
																{node.label}
															</p>
															<div className="flex items-center justify-between mt-1 text-xs text-muted-foreground">
																<span>
																	{node.type}
																</span>
																{node.estimate && (
																	<span>
																		{
																			node.estimate
																		}
																		h
																	</span>
																)}
																{node.riskScore !==
																	undefined && (
																	<span
																		className={cn(
																			"flex items-center gap-1",
																			risk.color,
																		)}
																	>
																		<AlertTriangle className="h-3 w-3" />
																		{
																			node.riskScore
																		}
																		%
																	</span>
																)}
															</div>
															{edges.blocks
																.length > 0 && (
																<div className="flex items-center gap-1 mt-1 text-xs text-orange-500">
																	<ArrowRight className="h-3 w-3" />
																	Blocks{" "}
																	{
																		edges
																			.blocks
																			.length
																	}{" "}
																	task(s)
																</div>
															)}
														</button>
													</TooltipTrigger>
													<TooltipContent
														side="right"
														className="max-w-xs"
													>
														<div className="space-y-2">
															<p className="font-medium">
																{node.label}
															</p>
															{edges.dependencies
																.length > 0 && (
																<div>
																	<span className="text-muted-foreground">
																		Depends
																		on:
																	</span>{" "}
																	{edges.dependencies.join(
																		", ",
																	)}
																</div>
															)}
															{edges.blockedBy
																.length > 0 && (
																<div>
																	<span className="text-muted-foreground">
																		Blocked
																		by:
																	</span>{" "}
																	{edges.blockedBy.join(
																		", ",
																	)}
																</div>
															)}
															{edges.blocks
																.length > 0 && (
																<div>
																	<span className="text-muted-foreground">
																		Blocks:
																	</span>{" "}
																	{edges.blocks.join(
																		", ",
																	)}
																</div>
															)}
														</div>
													</TooltipContent>
												</Tooltip>
											</TooltipProvider>
										);
									})}
								</div>
							)}
						</div>
					))}
				</div>
			</ScrollArea>

			{/* Critical path summary */}
			{graph.criticalPath.length > 0 && (
				<div className="border-t p-3">
					<h4 className="text-xs font-medium text-muted-foreground mb-2">
						Critical Path
					</h4>
					<div className="flex flex-wrap items-center gap-1">
						{graph.criticalPath.map((nodeId, index) => (
							<div
								key={nodeId}
								className="flex items-center gap-1"
							>
								<button
									type="button"
									onClick={() => onNodeClick?.(nodeId)}
									className="px-2 py-1 text-xs bg-amber-500/20 text-highlight/80 rounded hover:bg-amber-500/30"
								>
									{nodeId}
								</button>
								{index < graph.criticalPath.length - 1 && (
									<ArrowRight className="h-3 w-3 text-muted-foreground" />
								)}
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
