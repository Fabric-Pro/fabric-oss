"use client";

/**
 * PhaseIndicator Component
 *
 * Displays the current execution phase with appropriate icon and label.
 */

import {
	BrainCircuit,
	CheckCircle2,
	Clock,
	HelpCircle,
	ListTree,
	Loader2,
	RefreshCw,
	Route,
	Search,
	XCircle,
	Zap,
} from "lucide-react";

interface PhaseInfo {
	label: string;
	icon: React.ReactNode;
}

const PHASE_INFO: Record<string, PhaseInfo> = {
	routing: {
		label: "Routing to agent...",
		icon: <Route className="h-3.5 w-3.5 text-blue-500" />,
	},
	planning: {
		label: "Creating task plan...",
		icon: <ListTree className="h-3.5 w-3.5 text-purple-500" />,
	},
	executing: {
		label: "Executing tasks...",
		icon: <Zap className="h-3.5 w-3.5 text-highlight" />,
	},
	executing_tool: {
		label: "Executing tool...",
		icon: <Zap className="h-3.5 w-3.5 text-highlight" />,
	},
	thinking: {
		label: "Thinking...",
		icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />,
	},
	iterating: {
		label: "Working...",
		icon: <Zap className="h-3.5 w-3.5 text-highlight" />,
	},
	synthesizing: {
		label: "Summarizing findings...",
		icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-success" />,
	},
	reflecting: {
		label: "Reflecting on output...",
		icon: <RefreshCw className="h-3.5 w-3.5 text-success" />,
	},
	awaiting_approval: {
		label: "Waiting for approval...",
		icon: <Clock className="h-3.5 w-3.5 text-orange-500" />,
	},
	// Deep Research phases
	analyzing_complexity: {
		label: "Understanding your question...",
		icon: <BrainCircuit className="h-3.5 w-3.5 text-blue-500" />,
	},
	awaiting_clarification: {
		label: "Need your input...",
		icon: <HelpCircle className="h-3.5 w-3.5 text-amber-500" />,
	},
	decomposing: {
		label: "Planning research approach...",
		icon: <ListTree className="h-3.5 w-3.5 text-purple-500" />,
	},
	executing_subagents: {
		label: "Researching...",
		icon: <Search className="h-3.5 w-3.5 text-blue-500" />,
	},
	aggregating: {
		label: "Synthesizing findings...",
		icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-success" />,
	},
	evaluating: {
		label: "Checking completeness...",
		icon: <CheckCircle2 className="h-3.5 w-3.5 text-success" />,
	},
	complete: {
		label: "Complete",
		icon: <CheckCircle2 className="h-3.5 w-3.5 text-success" />,
	},
	error: {
		label: "Connection error",
		icon: <XCircle className="h-3.5 w-3.5 text-destructive" />,
	},
};

const DEFAULT_PHASE_INFO: PhaseInfo = {
	label: "Processing...",
	icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
};

function getPhaseInfo(phase: string): PhaseInfo {
	return PHASE_INFO[phase] || DEFAULT_PHASE_INFO;
}

interface PhaseIndicatorProps {
	phase: string;
	showDots?: boolean;
	/** Custom message from workflow progress - overrides generic phase label */
	message?: string;
}

export function PhaseIndicator({
	phase,
	showDots = true,
	message,
}: PhaseIndicatorProps) {
	const phaseInfo = getPhaseInfo(phase);
	const isErrorPhase = phase === "error";
	const isCompletePhase = phase === "complete";
	// Use progress message if available, otherwise fall back to generic phase label
	const displayLabel = message || phaseInfo.label;

	return (
		<div className="flex items-center gap-3">
			{showDots && !isErrorPhase && !isCompletePhase && (
				<div className="flex items-center gap-1">
					<div className="w-2 h-2 rounded-full bg-blue-600 animate-bounce [animation-delay:0ms]" />
					<div className="w-2 h-2 rounded-full bg-blue-600 animate-bounce [animation-delay:150ms]" />
					<div className="w-2 h-2 rounded-full bg-blue-600 animate-bounce [animation-delay:300ms]" />
				</div>
			)}
			<span
				className={`text-sm font-medium flex items-center gap-2 ${
					isErrorPhase
						? "text-destructive"
						: "text-blue-700 dark:text-blue-300"
				}`}
			>
				{phaseInfo.icon}
				{displayLabel}
			</span>
		</div>
	);
}
