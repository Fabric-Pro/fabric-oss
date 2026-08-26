"use client";
import "@copilotkit/react-ui/styles.css";
import "../document-generator/style.css";
import "@saas/projects/components/DocumentEditor.css";

import { CopilotKit, useCoAgent, useCopilotChat } from "@copilotkit/react-core";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { AgentErrorBoundary } from "@saas/agents/components/AgentErrorBoundary";
import { DependencyGraphVisualizer } from "@saas/agents/components/DependencyGraph";
import { HITLDialog } from "@saas/agents/components/HITLDialog";
import { useHumanInLoop } from "@saas/agents/hooks/useHumanInLoop";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import {
	AI_SIDEBAR_CONTENT_SHIFT_CLASS,
	useAiSidebarExpanded,
} from "@saas/shared/components/copilot/ai-sidebar-layout";
import { CopilotAssistantMessageForTaskPlanner } from "@saas/shared/components/copilot/CopilotAssistantMessage";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { useFullscreen } from "@saas/shared/contexts/FullscreenContext";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import {
	AlertTriangle,
	GitBranch,
	ListTree,
	Loader2,
	PlayCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface DecomposedTask {
	id: string;
	parentId?: string;
	title: string;
	description: string;
	type: string;
	estimate: number;
	complexity: "low" | "medium" | "high";
	riskScore: number;
	riskFactors?: string[];
	parallelizable?: boolean;
}

interface RiskFactor {
	id: string;
	category: string;
	description: string;
	severity: "low" | "medium" | "high" | "critical";
}

interface RiskAnalysis {
	overallScore: number;
	factors: RiskFactor[];
	recommendations: string[];
}

interface ExecutionPlan {
	phases: Array<{
		id: string;
		name: string;
		tasks: string[];
		duration: number;
	}>;
	totalDuration: number;
	parallelDuration: number;
	parallelizationFactor: number;
	recommendedTeamSize: number;
}

interface DependencyNode {
	id: string;
	label: string;
	type: string;
	riskLevel?: "low" | "medium" | "high" | "critical";
}

interface DependencyEdge {
	source: string;
	target: string;
	type: "dependency" | "blocks" | "parallel";
}

interface DependencyGraph {
	nodes: DependencyNode[];
	edges: DependencyEdge[];
}

interface TaskPlannerState {
	document: string;
	decomposedTasks?: DecomposedTask[];
	riskAnalysis?: RiskAnalysis;
	executionPlan?: ExecutionPlan;
	dependencyGraph?: DependencyGraph;
	/**
	 * Per-turn reasoning trace populated by generate-document.ts (final
	 * node only per Q3 spec). Declared here AND seeded in `useCoAgent`'s
	 * `initialState` so STATE_SNAPSHOT events survive CopilotKit's key
	 * filter.
	 */
	reasoningByTurn?: Record<
		number,
		{
			text: string;
			durationMs: number;
			startedAt: number;
			completedAt: number;
		}
	>;
}

export default function TaskPlannerPage() {
	const { organizationId, organizationSlug, basePath } =
		useOrganizationContext();
	const { setIsFullscreen } = useFullscreen();
	const onError = useCopilotErrorHandler();
	const runtimeUrl = organizationId
		? `/api/copilotkit?organizationId=${organizationId}`
		: "/api/copilotkit";

	useEffect(() => {
		setIsFullscreen(true);
		return () => setIsFullscreen(false);
	}, [setIsFullscreen]);

	// Track whether the CopilotKit chat sidebar is expanded so the page chrome
	// (breadcrumb + editor) shifts its right edge to make room for the docked
	// panel — without it the editor renders under the panel at every width
	// >=640px. Seeded `true` because the sidebar below mounts with `defaultOpen`.
	const isAiSidebarExpanded = useAiSidebarExpanded(true);

	const breadcrumbItems = [
		...(organizationSlug
			? [
					{
						label: "Organization",
						href: basePath,
					},
				]
			: []),
		{ label: "Agents", href: `${basePath}/agents` },
		{ label: "Task Planner" },
	];

	return (
		<div
			className={`fixed inset-y-0 right-0 left-0 bg-background md:left-[72px] transition-[right] duration-300 ${
				isAiSidebarExpanded ? AI_SIDEBAR_CONTENT_SHIFT_CLASS : ""
			}`}
		>
			<div className="flex items-center justify-between px-6 py-2.5 border-b bg-background">
				<PageBreadcrumbs items={breadcrumbItems} />
			</div>
			<div className="h-[calc(100vh-53px)]">
				<AgentErrorBoundary>
					<CopilotKit
						runtimeUrl={runtimeUrl}
						showDevConsole={false}
						agent="task_planner"
						onError={onError}
					>
						<TaskPlannerEditor />
					</CopilotKit>
				</AgentErrorBoundary>
			</div>
		</div>
	);
}

function TaskPlannerEditor() {
	const { isLoading } = useCopilotChat();
	const [activeTab, setActiveTab] = useState("tasks");
	const { pendingRequest, hasActiveRequest, respond, dismiss } =
		useHumanInLoop();

	const { state: agentState } = useCoAgent<TaskPlannerState>({
		name: "task_planner",
		initialState: {
			document: "",
			decomposedTasks: [],
			// Declare reasoningByTurn in initialState so CopilotKit's
			// useCoAgent doesn't filter it out of STATE_SNAPSHOT updates.
			// Same rationale as DocumentEditor.tsx:1286.
			reasoningByTurn: {},
		},
	});

	const tasks = agentState?.decomposedTasks || [];
	const riskAnalysis = agentState?.riskAnalysis;
	const executionPlan = agentState?.executionPlan;
	const dependencyGraph = agentState?.dependencyGraph;

	return (
		<>
			<HITLDialog
				request={pendingRequest}
				open={hasActiveRequest}
				onRespond={respond}
				onDismiss={dismiss}
			/>
			<CopilotSidebar
				AssistantMessage={CopilotAssistantMessageForTaskPlanner}
				defaultOpen={true}
				clickOutsideToClose={false}
				labels={{
					title: "Task Planner AI",
					initial:
						"Describe a feature and I will break it down with risk analysis.",
				}}
				suggestions={[
					{
						title: "Plan auth",
						message: "Break down user authentication with OAuth",
					},
					{
						title: "Plan API",
						message: "Plan tasks for a REST API endpoint",
					},
				]}
			>
				<TaskPlannerContent
					tasks={tasks}
					riskAnalysis={riskAnalysis}
					executionPlan={executionPlan}
					dependencyGraph={dependencyGraph}
					isLoading={isLoading}
					activeTab={activeTab}
					setActiveTab={setActiveTab}
				/>
			</CopilotSidebar>
		</>
	);
}

interface TaskPlannerContentProps {
	tasks: DecomposedTask[];
	riskAnalysis?: RiskAnalysis;
	executionPlan?: ExecutionPlan;
	dependencyGraph?: DependencyGraph;
	isLoading: boolean;
	activeTab: string;
	setActiveTab: (tab: string) => void;
}

function TaskPlannerContent({
	tasks,
	riskAnalysis,
	executionPlan,
	dependencyGraph,
	isLoading,
	activeTab,
	setActiveTab,
}: TaskPlannerContentProps) {
	// Convert tasks to dependency graph format if no explicit graph is provided
	const graphData = useMemo(() => {
		if (dependencyGraph && dependencyGraph.nodes.length > 0) {
			return dependencyGraph;
		}
		// Build a simple graph from tasks
		if (tasks.length === 0) {
			return null;
		}
		const nodes: DependencyNode[] = tasks.map((task) => ({
			id: task.id,
			label: task.title,
			type: task.type,
			riskLevel:
				task.riskScore > 0.7
					? "high"
					: task.riskScore > 0.4
						? "medium"
						: "low",
		}));
		// Create edges for subtasks
		const edges: DependencyEdge[] = tasks.flatMap((task) =>
			task.parentId
				? [
						{
							source: task.parentId,
							target: task.id,
							type: "dependency" as const,
						},
					]
				: [],
		);
		return { nodes, edges };
	}, [tasks, dependencyGraph]);

	return (
		<div className="flex flex-col h-screen">
			<div className="flex items-center justify-between px-6 py-3 border-b bg-background gap-4">
				<div className="flex items-center gap-3">
					<h2 className="text-lg font-semibold">Task Planner</h2>
					<Badge variant="secondary">CUGA Enhanced</Badge>
				</div>
				{isLoading && (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						<span>Planning tasks...</span>
					</div>
				)}
			</div>

			<Tabs
				value={activeTab}
				onValueChange={setActiveTab}
				className="flex-1 flex flex-col"
			>
				<div className="px-6 pt-4">
					<TabsList>
						<TabsTrigger value="tasks" className="gap-2">
							<ListTree className="h-4 w-4" /> Tasks (
							{tasks.length})
						</TabsTrigger>
						<TabsTrigger value="dependencies" className="gap-2">
							<GitBranch className="h-4 w-4" /> Dependencies
						</TabsTrigger>
						<TabsTrigger value="risks" className="gap-2">
							<AlertTriangle className="h-4 w-4" /> Risk Analysis
						</TabsTrigger>
						<TabsTrigger value="execution" className="gap-2">
							<PlayCircle className="h-4 w-4" /> Execution Plan
						</TabsTrigger>
					</TabsList>
				</div>

				<TabsContent value="tasks" className="flex-1 overflow-auto p-6">
					{tasks.length === 0 ? (
						<EmptyState
							icon={ListTree}
							message="No tasks yet. Describe a feature to get started."
						/>
					) : (
						<div className="space-y-4">
							{tasks.map((task) => (
								<TaskCard key={task.id} task={task} />
							))}
						</div>
					)}
				</TabsContent>

				<TabsContent
					value="dependencies"
					className="flex-1 overflow-hidden p-6"
				>
					{graphData && graphData.nodes.length > 0 ? (
						<div className="h-full">
							<DependencyGraphVisualizer
								graph={{
									nodes: graphData.nodes.map(
										(node, index) => ({
											id: node.id,
											label: node.label,
											type: node.type,
											level: index, // Use index as level since we don't have explicit levels
											riskScore:
												node.riskLevel === "critical"
													? 80
													: node.riskLevel === "high"
														? 60
														: node.riskLevel ===
																"medium"
															? 40
															: 20,
										}),
									),
									edges: graphData.edges.map((edge) => ({
										from: edge.source,
										to: edge.target,
										type: "depends" as const,
									})),
									criticalPath: [],
									totalCriticalPathDuration: 0,
								}}
								onNodeClick={(nodeId) => {
									// Find the task and highlight it
									const task = tasks.find(
										(t) => t.id === nodeId,
									);
									if (task) {
										setActiveTab("tasks");
										// Could also scroll to the task card here
									}
								}}
								className="h-full"
							/>
						</div>
					) : (
						<EmptyState
							icon={GitBranch}
							message="Dependency graph will appear after task decomposition."
						/>
					)}
				</TabsContent>

				<TabsContent value="risks" className="flex-1 overflow-auto p-6">
					{riskAnalysis ? (
						<RiskAnalysisView analysis={riskAnalysis} />
					) : (
						<EmptyState
							icon={AlertTriangle}
							message="Risk analysis will appear after task decomposition."
						/>
					)}
				</TabsContent>

				<TabsContent
					value="execution"
					className="flex-1 overflow-auto p-6"
				>
					{executionPlan ? (
						<ExecutionPlanView plan={executionPlan} />
					) : (
						<EmptyState
							icon={PlayCircle}
							message="Execution plan will be generated with tasks."
						/>
					)}
				</TabsContent>
			</Tabs>
		</div>
	);
}

function EmptyState({
	icon: Icon,
	message,
}: {
	icon: React.ElementType;
	message: string;
}) {
	return (
		<div className="text-center text-muted-foreground py-12">
			<Icon className="h-12 w-12 mx-auto mb-4 opacity-50" />
			<p>{message}</p>
		</div>
	);
}

function TaskCard({ task }: { task: DecomposedTask }) {
	return (
		<Card>
			<CardHeader className="pb-2">
				<div className="flex items-start justify-between">
					<div>
						<CardTitle className="text-base">
							{task.title}
						</CardTitle>
						<p className="text-sm text-muted-foreground mt-1">
							{task.description}
						</p>
					</div>
					<div className="flex gap-2">
						<Badge variant="outline">{task.type}</Badge>
						<Badge
							variant={
								task.complexity === "high"
									? "destructive"
									: "secondary"
							}
						>
							{task.complexity}
						</Badge>
					</div>
				</div>
			</CardHeader>
			<CardContent>
				<div className="flex items-center gap-4 text-sm">
					<span>Time: {task.estimate}h</span>
					<span
						className={
							task.riskScore > 0.7
								? "text-destructive flex items-center gap-1"
								: "flex items-center gap-1"
						}
					>
						<AlertTriangle className="h-3 w-3" /> Risk:{" "}
						{Math.round(task.riskScore * 100)}%
					</span>
					{task.parallelizable && (
						<Badge variant="outline">Parallelizable</Badge>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

function RiskAnalysisView({ analysis }: { analysis: RiskAnalysis }) {
	const scoreColor =
		analysis.overallScore > 0.7
			? "text-destructive"
			: analysis.overallScore > 0.4
				? "text-yellow-500"
				: "text-green-500";
	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center justify-between">
						Overall Risk Score
						<span className={`text-3xl ${scoreColor}`}>
							{Math.round(analysis.overallScore * 100)}%
						</span>
					</CardTitle>
				</CardHeader>
			</Card>
			<div>
				<h3 className="font-semibold mb-3">Risk Factors</h3>
				<div className="space-y-2">
					{analysis.factors.map((factor) => (
						<Card key={factor.id}>
							<CardContent className="py-3">
								<div className="flex items-center justify-between">
									<div>
										<Badge variant="outline">
											{factor.category}
										</Badge>
										<p className="text-sm mt-1">
											{factor.description}
										</p>
									</div>
									<Badge
										variant={
											factor.severity === "critical" ||
											factor.severity === "high"
												? "destructive"
												: "secondary"
										}
									>
										{factor.severity}
									</Badge>
								</div>
							</CardContent>
						</Card>
					))}
				</div>
			</div>
			{analysis.recommendations.length > 0 && (
				<div>
					<h3 className="font-semibold mb-3">Recommendations</h3>
					<ul className="list-disc list-inside space-y-1 text-sm">
						{analysis.recommendations.map((rec, i) => (
							<li key={i}>{rec}</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

function ExecutionPlanView({ plan }: { plan: ExecutionPlan }) {
	return (
		<div className="space-y-6">
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
				<StatCard
					label="Total Duration"
					value={`${plan.totalDuration}h`}
				/>
				<StatCard
					label="Parallel Duration"
					value={`${plan.parallelDuration}h`}
				/>
				<StatCard
					label="Time Savings"
					value={`${Math.round(plan.parallelizationFactor * 100)}%`}
					valueClass="text-green-500"
				/>
				<StatCard
					label="Team Size"
					value={String(plan.recommendedTeamSize)}
				/>
			</div>
			<div>
				<h3 className="font-semibold mb-3">Execution Phases</h3>
				<div className="space-y-3">
					{plan.phases.map((phase, index) => (
						<Card key={phase.id}>
							<CardContent className="py-4">
								<div className="flex items-center justify-between mb-2">
									<div className="flex items-center gap-2">
										<Badge variant="outline">
											Phase {index + 1}
										</Badge>
										<span className="font-medium">
											{phase.name}
										</span>
									</div>
									<span className="text-sm text-muted-foreground">
										{phase.duration}h
									</span>
								</div>
								<p className="text-sm text-muted-foreground">
									{phase.tasks.length} tasks
								</p>
							</CardContent>
						</Card>
					))}
				</div>
			</div>
		</div>
	);
}

function StatCard({
	label,
	value,
	valueClass,
}: {
	label: string;
	value: string;
	valueClass?: string;
}) {
	return (
		<Card>
			<CardContent className="pt-4">
				<p className="text-sm text-muted-foreground">{label}</p>
				<p className={`text-2xl font-bold ${valueClass || ""}`}>
					{value}
				</p>
			</CardContent>
		</Card>
	);
}
