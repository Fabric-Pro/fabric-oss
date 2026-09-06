"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Progress } from "@ui/components/progress";
import { cn } from "@ui/lib";
import {
	AlertCircle,
	CheckCircle2,
	Clock,
	Loader2,
	RefreshCw,
	Sparkles,
	X,
} from "lucide-react";

import { isDocumentGenerationStale } from "../lib/document-generation-timestamp";

const GENERATION_STEPS = [
	{ step: 1, name: "Job Queued" },
	{ step: 2, name: "Context Retrieval" },
	{ step: 3, name: "AI Drafting" },
	{ step: 4, name: "Finalizing" },
] as const;

const TOTAL_STEPS = GENERATION_STEPS.length;

interface DocumentGenerationProgressProps {
	/** Document generation status from server */
	status: string;
	/** Current progress percentage (0 - 100) */
	progress: number;
	/** Document title */
	title?: string;
	/** Server-provided error message if status is FAILED */
	error?: string | null;
	/** When generation was initiated, used for queue detection and staleness */
	generationStartedAt?: Date | string | null;
	/** When document was last updated, used as fallback for staleness */
	updatedAt?: Date | string | null;
	/** Callback to retry generation on failure or timeout */
	onRetry?: () => void;
	/** Callback to dismiss the progress overlay */
	onDismiss?: () => void;
	/** Whether retry mutation is in-flight */
	isRetrying?: boolean;
	/** Whether this is a regeneration of an existing document */
	isRegenerating?: boolean;
	/** Optional container class name */
	className?: string;
}

interface GenerationStage {
	label: string;
	step: number;
	totalSteps: number;
	description: string;
	isQueued: boolean;
}

export function getGenerationStage(
	progress: number,
	status: string,
): GenerationStage {
	if (status === "COMPLETE" || progress >= 100) {
		return {
			label: "Generation Complete",
			step: 4,
			totalSteps: TOTAL_STEPS,
			description: "Document ready for editing.",
			isQueued: false,
		};
	}

	// Queued in worker queue: progress is 0 until the worker begins execution
	// and reports its first milestone (15% project context / 30% direct context).
	if (progress <= 0) {
		return {
			label: "Queued in Job Queue",
			step: 1,
			totalSteps: TOTAL_STEPS,
			description:
				"Job submitted to worker queue. Waiting for an available generation worker...",
			isQueued: true,
		};
	}

	// Aligned with workflow milestones in document-generation-child.ts:
	// 15: project context retrieved, 25: episodic memory, 30: slack/direct context
	if (progress < 35) {
		return {
			label: "Retrieving Context",
			step: 2,
			totalSteps: TOTAL_STEPS,
			description:
				"Gathering project context, memory, and workspace background...",
			isQueued: false,
		};
	}

	// 35: agent invoked, drafting in progress
	if (progress < 80) {
		return {
			label: "Drafting Content",
			step: 3,
			totalSteps: TOTAL_STEPS,
			description:
				"AI agent is analyzing context and drafting document sections...",
			isQueued: false,
		};
	}

	// 80: document produced by agent, saving and validating
	return {
		label: "Finalizing Document",
		step: 4,
		totalSteps: TOTAL_STEPS,
		description:
			"Validating structure, formatting markdown, and saving document...",
		isQueued: false,
	};
}

export function DocumentGenerationProgress({
	status,
	progress,
	title,
	error,
	generationStartedAt,
	updatedAt,
	onRetry,
	onDismiss,
	isRetrying = false,
	isRegenerating = false,
	className,
}: DocumentGenerationProgressProps) {
	const clampedProgress = Math.min(100, Math.max(0, progress));
	const isFailed = status === "FAILED";
	const isComplete = status === "COMPLETE" || clampedProgress >= 100;
	const stage = getGenerationStage(clampedProgress, status);

	// Detect if job has been generating for > 3 minutes (180s), falling back to updatedAt
	const isStale =
		!isComplete &&
		!isFailed &&
		isDocumentGenerationStale(generationStartedAt, updatedAt);

	return (
		<section
			className={cn(
				"block w-full max-w-xl mx-auto rounded-xl border border-border bg-card p-6 md:p-8 shadow-lg transition-all text-left",
				className,
			)}
			aria-label="Document generation progress"
		>
			{/* Header with Title, Preserved Reassurance Message, Badge & Optional Dismiss */}
			<div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
				<div className="flex items-start gap-3 min-w-0">
					<div className="p-2.5 rounded-lg bg-primary/10 text-primary shrink-0 mt-0.5">
						{isRegenerating ? (
							<RefreshCw className="h-5 w-5" />
						) : (
							<Sparkles className="h-5 w-5" />
						)}
					</div>
					<div className="min-w-0">
						<h3 className="font-semibold text-base md:text-lg truncate">
							{title ||
								(isRegenerating
									? "Regenerating Document"
									: "Generating Document")}
						</h3>
						<p className="text-sm text-muted-foreground mt-1">
							This will take a few minutes. Please wait while we
							generate your document...
						</p>
					</div>
				</div>

				{/* Queue / Processing Badge & Dismiss Button */}
				<div className="flex items-center gap-2 shrink-0">
					{isFailed ? (
						<Badge
							variant="destructive"
							className="gap-1.5 px-2.5 py-1 text-xs"
						>
							<AlertCircle className="h-3.5 w-3.5" />
							Failed
						</Badge>
					) : isComplete ? (
						<Badge
							variant="secondary"
							className="gap-1.5 px-2.5 py-1 text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
						>
							<CheckCircle2 className="h-3.5 w-3.5" />
							Complete
						</Badge>
					) : stage.isQueued ? (
						<Badge
							variant="secondary"
							className="gap-1.5 px-2.5 py-1 text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
						>
							<Clock className="h-3.5 w-3.5 animate-pulse" />
							Queued in Job Queue
						</Badge>
					) : (
						<Badge
							variant="secondary"
							className="gap-1.5 px-2.5 py-1 text-xs bg-primary/10 text-primary border border-primary/20"
						>
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
							In Progress ({clampedProgress}%)
						</Badge>
					)}

					{onDismiss && (
						<Button
							variant="ghost"
							size="icon"
							className="size-7 rounded-full text-muted-foreground hover:text-foreground"
							onClick={onDismiss}
							aria-label="Dismiss progress overlay"
						>
							<X className="size-4" />
						</Button>
					)}
				</div>
			</div>

			{/* Staleness escape hatch if taking longer than expected */}
			{isStale && (
				<div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 mb-6 text-center space-y-2">
					<p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
						Generation is taking longer than expected.
					</p>
					<div className="flex items-center justify-center gap-2">
						{onRetry && (
							<Button
								size="sm"
								variant="outline"
								onClick={onRetry}
								disabled={isRetrying}
								className="h-7 text-xs gap-1.5 border-amber-500/40"
							>
								{isRetrying ? (
									<Loader2 className="h-3.5 w-3.5 animate-spin" />
								) : (
									<RefreshCw className="h-3.5 w-3.5" />
								)}
								Retry Generation
							</Button>
						)}
						{onDismiss && (
							<Button
								size="sm"
								variant="ghost"
								onClick={onDismiss}
								className="h-7 text-xs text-muted-foreground"
							>
								Dismiss to Editor
							</Button>
						)}
					</div>
				</div>
			)}

			{/* Error State */}
			{isFailed ? (
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 mb-6 text-center space-y-3">
					<p className="text-sm text-destructive font-medium">
						{error ||
							"Document generation failed. No content could be produced."}
					</p>
					{onRetry && (
						<Button
							size="sm"
							variant="outline"
							onClick={onRetry}
							disabled={isRetrying}
							className="gap-2 border-destructive/40 hover:bg-destructive/10 text-destructive"
						>
							{isRetrying ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<RefreshCw className="h-4 w-4" />
							)}
							Retry Generation
						</Button>
					)}
				</div>
			) : (
				/* Progress Bar & Stage Indicator */
				<div className="space-y-4">
					<div>
						{/* Live region scoped strictly to status and percentage line */}
						<div
							className="flex justify-between items-center text-xs font-medium mb-1.5"
							aria-live="polite"
							aria-atomic="true"
						>
							<span className="text-foreground">
								Step {stage.step} of {stage.totalSteps}:{" "}
								{stage.label}
							</span>
							<span className="text-muted-foreground font-mono">
								{clampedProgress}%
							</span>
						</div>
						<Progress
							value={clampedProgress}
							className="h-2.5 w-full transition-all duration-500 ease-out"
						/>
					</div>

					<p className="text-xs text-muted-foreground min-h-[1.75rem]">
						{stage.description}
					</p>

					{/* 4-Step Lifecycle Timeline */}
					<div className="grid grid-cols-4 gap-2 pt-2 border-t border-border/60">
						{GENERATION_STEPS.map((s) => {
							const isPassed = stage.step > s.step || isComplete;
							const isCurrent =
								stage.step === s.step && !isComplete;
							return (
								<div
									key={s.step}
									className="flex flex-col items-center text-center gap-1"
								>
									<div
										className={cn(
											"size-6 rounded-full flex items-center justify-center text-[10px] font-semibold border transition-all",
											isPassed &&
												"bg-primary text-primary-foreground border-primary",
											isCurrent &&
												"border-primary text-primary bg-primary/10 ring-2 ring-primary/20",
											!isPassed &&
												!isCurrent &&
												"border-border text-muted-foreground bg-muted/40",
										)}
									>
										{isPassed ? (
											<CheckCircle2 className="h-3.5 w-3.5" />
										) : isCurrent && !stage.isQueued ? (
											<Loader2 className="h-3 w-3 animate-spin" />
										) : isCurrent && stage.isQueued ? (
											<Clock className="h-3 w-3" />
										) : (
											s.step
										)}
									</div>
									<span
										className={cn(
											"text-[10px] leading-tight line-clamp-1",
											isCurrent
												? "font-medium text-foreground"
												: "text-muted-foreground",
										)}
									>
										{s.name}
									</span>
								</div>
							);
						})}
					</div>
				</div>
			)}
		</section>
	);
}
