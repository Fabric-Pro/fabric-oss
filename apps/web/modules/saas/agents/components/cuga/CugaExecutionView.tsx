"use client";

/**
 * CugaExecutionView
 *
 * Main execution view for CUGA agent that combines:
 * - Subtask tree
 * - Code execution panel
 * - Variables inspector
 * - Browser view
 * - HITL dialogs
 */

import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib";
import { Brain, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";

import { CugaBrowserView } from "./CugaBrowserView";
import { CugaCodePanel } from "./CugaCodePanel";
import { CugaHitlDialog } from "./CugaHitlDialog";
import { CugaSubtaskTree } from "./CugaSubtaskTree";
import { CugaVariablesInspector } from "./CugaVariablesInspector";
import type { CugaExecutionState, CugaHitlRequest } from "./types";

interface CugaExecutionViewProps {
	state: CugaExecutionState;
	onHitlRespond?: (
		requestId: string,
		response: CugaHitlRequest["response"],
	) => void;
	className?: string;
}

const STATUS_CONFIG = {
	idle: {
		icon: <Clock className="h-4 w-4" />,
		label: "Idle",
		color: "bg-muted",
	},
	planning: {
		icon: <Brain className="h-4 w-4 animate-pulse" />,
		label: "Planning",
		color: "bg-purple-100 text-purple-700",
	},
	executing: {
		icon: <Loader2 className="h-4 w-4 animate-spin" />,
		label: "Executing",
		color: "bg-blue-100 text-blue-700",
	},
	waiting_hitl: {
		icon: <Clock className="h-4 w-4" />,
		label: "Waiting for Input",
		color: "bg-yellow-100 text-yellow-700",
	},
	complete: {
		icon: <CheckCircle2 className="h-4 w-4" />,
		label: "Complete",
		color: "bg-green-100 text-green-700",
	},
	failed: {
		icon: <XCircle className="h-4 w-4" />,
		label: "Failed",
		color: "bg-red-100 text-red-700",
	},
};

export function CugaExecutionView({
	state,
	onHitlRespond,
	className,
}: CugaExecutionViewProps) {
	const statusConfig = STATUS_CONFIG[state.status];
	const pendingHitl = state.hitlRequests.find((r) => r.pending);
	const latestCodeExecution =
		state.codeExecutions[state.codeExecutions.length - 1];

	return (
		<div className={cn("space-y-4", className)}>
			{/* Status Header */}
			<div className="flex items-center justify-between">
				<Badge className={cn("text-sm", statusConfig.color)}>
					{statusConfig.icon}
					<span className="ml-1">{statusConfig.label}</span>
				</Badge>
				{state.thoughts && (
					<span className="text-xs text-muted-foreground italic max-w-md truncate">
						💭 {state.thoughts}
					</span>
				)}
			</div>

			{/* Main Content Grid */}
			<div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
				{/* Left Column: Subtask Tree + Browser View */}
				<div className="lg:col-span-2 space-y-4">
					{state.subtasks.length > 0 && (
						<CugaSubtaskTree
							subtasks={state.subtasks}
							currentSubtaskId={state.currentSubtaskId}
							thoughts={state.thoughts}
						/>
					)}

					{/* Browser View */}
					{state.browserState && (
						<CugaBrowserView
							browserState={state.browserState}
							browserAction={state.browserAction}
						/>
					)}

					{/* Code Execution Panel */}
					{latestCodeExecution && (
						<CugaCodePanel execution={latestCodeExecution} />
					)}

					{/* Final Answer */}
					{state.finalAnswer && (
						<div className="rounded-lg border bg-green-50 dark:bg-green-900/20 p-4">
							<h3 className="text-sm font-medium flex items-center gap-2 mb-2">
								<CheckCircle2 className="h-4 w-4 text-success" />
								Final Answer
							</h3>
							<p className="text-sm text-foreground whitespace-pre-wrap">
								{state.finalAnswer}
							</p>
						</div>
					)}

					{/* Error Display */}
					{state.error && (
						<div className="rounded-lg border bg-red-50 dark:bg-red-900/20 p-4">
							<h3 className="text-sm font-medium flex items-center gap-2 mb-2">
								<XCircle className="h-4 w-4 text-destructive" />
								Error
							</h3>
							<p className="text-sm text-red-700 dark:text-red-400">
								{state.error}
							</p>
						</div>
					)}
				</div>

				{/* Right Column: Variables Inspector */}
				<div className="space-y-4">
					<CugaVariablesInspector variables={state.variables} />
				</div>
			</div>

			{/* HITL Dialog */}
			{pendingHitl && onHitlRespond && (
				<CugaHitlDialog
					request={pendingHitl}
					onRespond={(response) =>
						onHitlRespond(pendingHitl.id, response)
					}
				/>
			)}
		</div>
	);
}
