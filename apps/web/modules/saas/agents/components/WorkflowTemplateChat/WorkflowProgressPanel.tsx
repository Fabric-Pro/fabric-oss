"use client";

/**
 * WorkflowProgressPanel Component
 *
 * Displays the progress of a workflow execution including:
 * - Current phase
 * - Iteration tracking
 * - Sub-agent progress grid
 */

import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Progress } from "@ui/components/progress";
import {
	Brain,
	CheckCircle2,
	GitBranch,
	Loader2,
	Puzzle,
	RefreshCw,
	Search,
	Target,
	XCircle,
} from "lucide-react";
import type {
	WorkflowPhase,
	WorkflowTemplateState,
} from "../../hooks/useWorkflowTemplateStream";
import { ResearchProgressCard } from "../FabricChat/cards/ResearchProgressCard";
import { SubAgentCard, SubAgentPlaceholder } from "./SubAgentCard";

interface WorkflowProgressPanelProps {
	state: WorkflowTemplateState;
	progressPercentage: number;
	onClarificationResponse?: (response: string) => void;
}

interface PhaseInfo {
	label: string;
	description: string;
	icon: React.ReactNode;
}

const PHASE_INFO: Record<WorkflowPhase, PhaseInfo> = {
	idle: {
		label: "Ready",
		description: "Waiting for query",
		icon: <Target className="h-4 w-4" />,
	},
	initializing: {
		label: "Initializing",
		description: "Setting up workflow",
		icon: <Loader2 className="h-4 w-4 animate-spin" />,
	},
	analyzing_complexity: {
		label: "Analyzing",
		description: "Determining query complexity",
		icon: <Brain className="h-4 w-4" />,
	},
	awaiting_clarification: {
		label: "Clarifying",
		description: "Waiting for your input",
		icon: <Target className="h-4 w-4" />,
	},
	decomposing: {
		label: "Decomposing",
		description: "Breaking into sub-tasks",
		icon: <GitBranch className="h-4 w-4" />,
	},
	executing_subagents: {
		label: "Researching",
		description: "Sub-agents investigating",
		icon: <Search className="h-4 w-4" />,
	},
	aggregating: {
		label: "Synthesizing",
		description: "Combining findings",
		icon: <Puzzle className="h-4 w-4" />,
	},
	evaluating: {
		label: "Evaluating",
		description: "Checking success criteria",
		icon: <Target className="h-4 w-4" />,
	},
	iterating: {
		label: "Iterating",
		description: "Refining results",
		icon: <RefreshCw className="h-4 w-4" />,
	},
	completed: {
		label: "Completed",
		description: "Research complete",
		icon: <CheckCircle2 className="h-4 w-4 text-success" />,
	},
	failed: {
		label: "Failed",
		description: "An error occurred",
		icon: <XCircle className="h-4 w-4 text-destructive" />,
	},
	cancelled: {
		label: "Cancelled",
		description: "Workflow was cancelled",
		icon: <XCircle className="h-4 w-4 text-yellow-500" />,
	},
};

function PhaseIndicator({
	phase,
	message,
}: {
	phase: WorkflowPhase;
	message?: string;
}) {
	const info = PHASE_INFO[phase];
	const isActive = !["idle", "completed", "failed", "cancelled"].includes(
		phase,
	);

	return (
		<div className="flex items-center gap-3">
			<div
				className={`flex items-center justify-center w-8 h-8 rounded-full ${
					isActive
						? "bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400"
						: phase === "completed"
							? "bg-green-100 dark:bg-green-900 text-success dark:text-green-400"
							: phase === "failed"
								? "bg-red-100 dark:bg-red-900 text-destructive"
								: "bg-muted text-muted-foreground"
				}`}
			>
				{info.icon}
			</div>
			<div>
				<div className="font-medium text-sm">{info.label}</div>
				<div className="text-xs text-muted-foreground">
					{message || info.description}
				</div>
			</div>
		</div>
	);
}

function ComplexityBadge({
	complexity,
}: {
	complexity: "simple" | "medium" | "complex" | null;
}) {
	if (!complexity) {
		return null;
	}

	const variants = {
		simple: {
			bg: "bg-green-100 dark:bg-green-900",
			text: "text-green-700 dark:text-green-300",
		},
		medium: {
			bg: "bg-yellow-100 dark:bg-yellow-900",
			text: "text-yellow-700 dark:text-yellow-300",
		},
		complex: {
			bg: "bg-purple-100 dark:bg-purple-900",
			text: "text-purple-700 dark:text-purple-300",
		},
	};

	const variant = variants[complexity];

	return (
		<Badge
			variant="outline"
			className={`${variant.bg} ${variant.text} border-0`}
		>
			{complexity.charAt(0).toUpperCase() + complexity.slice(1)} query
		</Badge>
	);
}

export function WorkflowProgressPanel({
	state,
	progressPercentage,
	onClarificationResponse,
}: WorkflowProgressPanelProps) {
	if (
		[
			"analyzing_complexity",
			"awaiting_clarification",
			"decomposing",
			"executing_subagents",
			"aggregating",
			"evaluating",
			"iterating",
		].includes(state.phase)
	) {
		return (
			<ResearchProgressCard
				progress={{
					phase: state.phase,
					message: state.message,
					complexity: state.complexity ?? undefined,
					currentIteration: state.iteration.current,
					maxIterations: state.iteration.max,
					subAgentsTotal: state.progress.subAgentsTotal,
					subAgentsCompleted: state.progress.subAgentsCompleted,
					subAgentsFailed: state.progress.subAgentsFailed,
					goalAchieved: Boolean(state.result?.goalAchieved),
					clarificationPrompt: state.progress.clarificationPrompt,
					subTaskTitles: state.progress.subTaskTitles,
				}}
				subAgentResults={state.subAgentResults}
				onClarificationResponse={onClarificationResponse}
			/>
		);
	}

	const { phase, message, complexity, progress, iteration, subAgentResults } =
		state;

	const isRunning = !["idle", "completed", "failed", "cancelled"].includes(
		phase,
	);
	const showSubAgents =
		progress.subAgentsTotal > 0 || subAgentResults.length > 0;

	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex items-center justify-between">
					<CardTitle className="text-base font-medium">
						Progress
					</CardTitle>
					<div className="flex items-center gap-2">
						<ComplexityBadge complexity={complexity} />
						{iteration.current > 0 && (
							<Badge variant="outline">
								Iteration {iteration.current}/{iteration.max}
							</Badge>
						)}
					</div>
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				{/* Phase indicator */}
				<PhaseIndicator phase={phase} message={message} />

				{/* Progress bar */}
				{isRunning && showSubAgents && (
					<div className="space-y-2">
						<div className="flex justify-between text-xs text-muted-foreground">
							<span>
								{progress.subAgentsCompleted} of{" "}
								{progress.subAgentsTotal} sub-agents complete
							</span>
							<span>{progressPercentage}%</span>
						</div>
						<Progress value={progressPercentage} className="h-2" />
						{progress.subAgentsFailed > 0 && (
							<div className="text-xs text-destructive">
								{progress.subAgentsFailed} failed
							</div>
						)}
					</div>
				)}

				{/* Sub-agent results */}
				{showSubAgents && (
					<div className="space-y-2">
						<h4 className="text-sm font-medium text-muted-foreground">
							Sub-Agents
						</h4>
						<div className="grid gap-2">
							{subAgentResults.map((result, index) => (
								<SubAgentCard
									key={result.subTaskId}
									result={result}
									index={index}
								/>
							))}
							{/* Placeholders for pending sub-agents */}
							{isRunning &&
								Array.from({
									length: Math.max(
										0,
										progress.subAgentsTotal -
											subAgentResults.length,
									),
								}).map((_, index) => (
									<SubAgentPlaceholder
										key={`placeholder-${index}`}
										index={subAgentResults.length + index}
									/>
								))}
						</div>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
