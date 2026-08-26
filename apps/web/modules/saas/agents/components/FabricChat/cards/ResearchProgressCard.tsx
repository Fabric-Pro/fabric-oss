/**
 * ResearchProgressCard
 *
 * Displays live deep research progress as a visual timeline.
 * Maps DeepResearcherProgress phases to user-friendly labels
 * and shows sub-agent progress, iteration counts, and clarification prompts.
 */

"use client";

import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
import { cn } from "@ui/lib";
import {
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	ExternalLink,
	HelpCircle,
	Loader2,
	RefreshCw,
	Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SubAgentResult } from "../../../hooks/useWorkflowTemplateStream";

/** Phase info for display */
interface PhaseDisplay {
	label: string;
	icon: React.ReactNode;
	color: string;
}

const PHASE_MAP: Record<string, PhaseDisplay> = {
	initializing: {
		label: "Starting research...",
		icon: <Loader2 className="h-4 w-4 animate-spin" />,
		color: "text-muted-foreground",
	},
	analyzing_complexity: {
		label: "Understanding your question...",
		icon: <Loader2 className="h-4 w-4 animate-spin" />,
		color: "text-blue-600",
	},
	awaiting_clarification: {
		label: "Need your input",
		icon: <HelpCircle className="h-4 w-4" />,
		color: "text-amber-600",
	},
	decomposing: {
		label: "Planning research approach...",
		icon: <Loader2 className="h-4 w-4 animate-spin" />,
		color: "text-violet-600",
	},
	executing_subagents: {
		label: "Researching",
		icon: <Loader2 className="h-4 w-4 animate-spin" />,
		color: "text-blue-600",
	},
	aggregating: {
		label: "Synthesizing findings...",
		icon: <Loader2 className="h-4 w-4 animate-spin" />,
		color: "text-emerald-600",
	},
	evaluating: {
		label: "Checking completeness...",
		icon: <Loader2 className="h-4 w-4 animate-spin" />,
		color: "text-emerald-600",
	},
	iterating: {
		label: "Refining research...",
		icon: <Loader2 className="h-4 w-4 animate-spin" />,
		color: "text-orange-600",
	},
	completed: {
		label: "Research complete",
		icon: <CheckCircle2 className="h-4 w-4" />,
		color: "text-emerald-600",
	},
	failed: {
		label: "Research failed",
		icon: <Loader2 className="h-4 w-4" />,
		color: "text-destructive",
	},
	cancelled: {
		label: "Research cancelled",
		icon: <Loader2 className="h-4 w-4" />,
		color: "text-muted-foreground",
	},
};

interface ResearchProgressData {
	phase: string;
	message?: string;
	complexity?: string;
	currentIteration: number;
	maxIterations: number;
	subAgentsTotal: number;
	subAgentsCompleted: number;
	subAgentsFailed: number;
	goalAchieved: boolean;
	clarificationPrompt?: string;
	subTaskTitles?: string[];
}

interface ResearchProgressCardProps {
	progress: ResearchProgressData;
	subAgentResults?: SubAgentResult[];
	onClarificationResponse?: (response: string) => void;
	className?: string;
}

export function ResearchProgressCard({
	progress,
	subAgentResults,
	onClarificationResponse,
	className,
}: ResearchProgressCardProps) {
	const [clarificationInput, setClarificationInput] = useState("");
	const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
	const prevResultCountRef = useRef(0);
	const phaseInfo = PHASE_MAP[progress.phase] ?? PHASE_MAP.initializing;

	// Auto-expand the most recently completed sub-agent
	const completedResults =
		subAgentResults?.filter((r) => r.status === "completed") ?? [];
	useEffect(() => {
		if (completedResults.length > prevResultCountRef.current) {
			const newest = completedResults[completedResults.length - 1];
			if (newest) {
				setExpandedAgentId(newest.subTaskId);
			}
		}
		prevResultCountRef.current = completedResults.length;
	}, [completedResults.length]);
	const isActive =
		progress.phase !== "completed" &&
		progress.phase !== "failed" &&
		progress.phase !== "cancelled";

	const handleSubmitClarification = () => {
		if (clarificationInput.trim() && onClarificationResponse) {
			onClarificationResponse(clarificationInput.trim());
			setClarificationInput("");
		}
	};

	return (
		<Card className={cn("overflow-hidden", className)}>
			<CardContent className="p-4 space-y-3">
				{/* Header with phase */}
				<div className="flex items-center gap-2">
					<div className={cn("shrink-0", phaseInfo.color)}>
						{phaseInfo.icon}
					</div>
					<span
						className={cn("text-sm font-medium", phaseInfo.color)}
					>
						{phaseInfo.label}
					</span>
					{progress.complexity && (
						<span className="text-xs text-muted-foreground ml-auto rounded-full bg-muted px-2 py-0.5">
							{progress.complexity}
						</span>
					)}
				</div>

				{/* Custom message from workflow */}
				{progress.message &&
					progress.phase !== "awaiting_clarification" && (
						<p className="text-xs text-muted-foreground">
							{progress.message}
						</p>
					)}

				{/* Clarification prompt with input */}
				{progress.phase === "awaiting_clarification" &&
					progress.clarificationPrompt && (
						<div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 p-3 space-y-2">
							<p className="text-sm">
								{progress.clarificationPrompt}
							</p>
							{onClarificationResponse && (
								<div className="flex gap-2">
									<input
										type="text"
										value={clarificationInput}
										onChange={(e) =>
											setClarificationInput(
												e.target.value,
											)
										}
										placeholder="Type your response..."
										className="flex-1 rounded border bg-background px-2 py-1.5 text-sm"
										onKeyDown={(e) =>
											e.key === "Enter" &&
											handleSubmitClarification()
										}
									/>
									<Button
										size="sm"
										onClick={handleSubmitClarification}
										disabled={!clarificationInput.trim()}
									>
										Send
									</Button>
								</div>
							)}
						</div>
					)}

				{/* Sub-agent progress bar */}
				{progress.subAgentsTotal > 0 && (
					<div className="space-y-1.5">
						<div className="flex items-center justify-between text-xs text-muted-foreground">
							<span className="flex items-center gap-1">
								<Users className="h-3 w-3" />
								Sub-agents
							</span>
							<span>
								{progress.subAgentsCompleted}/
								{progress.subAgentsTotal}
								{progress.subAgentsFailed > 0 && (
									<span className="text-destructive ml-1">
										({progress.subAgentsFailed} failed)
									</span>
								)}
							</span>
						</div>
						<div className="h-1.5 rounded-full bg-muted overflow-hidden">
							<div
								className={cn(
									"h-full rounded-full transition-all duration-500",
									progress.goalAchieved
										? "bg-emerald-500"
										: "bg-primary",
								)}
								style={{
									width: `${progress.subAgentsTotal > 0 ? (progress.subAgentsCompleted / progress.subAgentsTotal) * 100 : 0}%`,
								}}
							/>
						</div>
					</div>
				)}

				{/* Sub-task titles (after decomposition) */}
				{progress.subTaskTitles &&
					progress.subTaskTitles.length > 0 && (
						<div className="space-y-1 pt-1">
							{progress.subTaskTitles.map((title, idx) => (
								<div
									key={idx}
									className="flex items-center gap-2 text-xs"
								>
									{idx < progress.subAgentsCompleted ? (
										<CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
									) : idx === progress.subAgentsCompleted &&
										isActive ? (
										<Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
									) : (
										<div className="h-3 w-3 rounded-full border border-muted-foreground/30 shrink-0" />
									)}
									<span
										className={cn(
											"truncate",
											idx < progress.subAgentsCompleted
												? "text-muted-foreground line-through"
												: "text-foreground",
										)}
									>
										{title}
									</span>
								</div>
							))}
						</div>
					)}

				{/* Live sub-agent findings — appear as each agent completes */}
				{completedResults.length > 0 && (
					<div className="space-y-2 pt-1 border-t">
						{completedResults.map((result) => {
							const isExpanded =
								expandedAgentId === result.subTaskId;
							const preview =
								result.findings.length > 240
									? `${result.findings.slice(0, 240)}...`
									: result.findings;
							const hasUrls = result.sources.some(
								(s) =>
									s.startsWith("http://") ||
									s.startsWith("https://"),
							);
							return (
								<div
									key={result.subTaskId}
									className="rounded-md border border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-950/20 overflow-hidden"
								>
									<button
										type="button"
										onClick={() =>
											setExpandedAgentId(
												isExpanded
													? null
													: result.subTaskId,
											)
										}
										className="w-full flex items-center justify-between px-3 py-2 text-left gap-2"
									>
										<div className="flex items-center gap-2 min-w-0">
											<CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
											<span className="text-xs font-medium truncate">
												{result.title}
											</span>
											<span className="text-xs text-muted-foreground shrink-0">
												{result.confidence}%
											</span>
										</div>
										{isExpanded ? (
											<ChevronUp className="h-3 w-3 text-muted-foreground shrink-0" />
										) : (
											<ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
										)}
									</button>
									{isExpanded && (
										<div className="px-3 pb-3 space-y-2">
											<p className="text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed">
												{isExpanded
													? result.findings
													: preview}
											</p>
											{hasUrls && (
												<div className="flex flex-wrap gap-1.5 pt-1">
													{result.sources
														.filter(
															(s) =>
																s.startsWith(
																	"http://",
																) ||
																s.startsWith(
																	"https://",
																),
														)
														.slice(0, 4)
														.map((url, i) => {
															try {
																const hostname =
																	new URL(url)
																		.hostname;
																return (
																	<a
																		key={i}
																		href={
																			url
																		}
																		target="_blank"
																		rel="noopener noreferrer"
																		className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/50 px-2 py-0.5 rounded hover:underline"
																	>
																		<ExternalLink className="h-2.5 w-2.5" />
																		{
																			hostname
																		}
																	</a>
																);
															} catch {
																return null;
															}
														})}
												</div>
											)}
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}

				{/* Iteration indicator */}
				{progress.currentIteration > 0 &&
					progress.maxIterations > 1 && (
						<div className="flex items-center gap-1.5 text-xs text-muted-foreground pt-1 border-t">
							<RefreshCw className="h-3 w-3" />
							<span>
								Iteration {progress.currentIteration}/
								{progress.maxIterations}
							</span>
						</div>
					)}
			</CardContent>
		</Card>
	);
}
