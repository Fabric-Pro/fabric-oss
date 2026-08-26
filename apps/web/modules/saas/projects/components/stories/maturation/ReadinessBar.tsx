"use client";

import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { Loader2Icon, SparklesIcon } from "lucide-react";

export interface FeatureReadinessSignals {
	/** True if Clean Spec / Description is present and non-empty */
	hasFullSpec: boolean;
	/** True if Acceptance Criteria section is present and non-empty */
	hasAcceptanceCriteria: boolean;
	/** Count of PM/BA blocking gaps (0 means no blocking gaps) */
	blockingGapCount: number;
	/** True if the spec has been recently updated / refreshed (within 15 days) */
	isSpecRecentlyUpdated?: boolean;
	/** True if Functional Requirements (FRs) are defined (for FEATUREs) */
	hasFunctionalRequirements: boolean;
	/** Number of resolved question threads */
	resolvedQuestionsCount: number;
	/** Number of open question threads */
	openQuestionsCount: number;
	/** Kind of work item: "FEATURE" or "BUG" */
	storyKind?: "FEATURE" | "BUG";
	/** True if Expected Result section/keywords are present (for BUGs) */
	hasExpectedResult?: boolean;
	/** True if Actual Result section/keywords are present (for BUGs) */
	hasActualResult?: boolean;
	/** True if needsMoreInfo triage flag is set */
	needsMoreInfo?: boolean;
}

export interface AiReadinessData {
	aiReadinessScore: number;
	tierLabel: string;
	rationale: string;
	strengths: string[];
	gaps: string[];
}

/**
 * Calculates feature or bug readiness percentage using a 50/50 Additive Model (Max 100%).
 * - Baseline Structural Assets (Capped at 50% max):
 *   - For FEATURE:
 *     - Full Spec Present: +10%
 *     - Acceptance Criteria Present: +10%
 *     - Functional Requirements Present: +10%
 *     - Zero Blocking Gaps: +10%
 *     - Spec Recently Updated (15 days): +10%
 *   - For BUG:
 *     - Bug Overview/Description Present: +10%
 *     - Fix Acceptance Criteria Present: +10%
 *     - Expected Result Present: +5%
 *     - Actual Result Present: +5%
 *     - Zero Blocking Gaps / NeedsMoreInfo Cleared: +10%
 *     - Ticket Recently Updated (15 days): +10%
 * - Open Questions Progress (50% Chunk):
 *   - Scaled linearly: (resolved / total) * 50%
 *   - If 0 questions needed: awards full +50% automatically ONLY when baseline spec content is present (empty features score 20%).
 */
export function calculateFeatureReadiness(
	signals: FeatureReadinessSignals,
): number {
	const isBug = signals.storyKind === "BUG";

	const specScore = signals.hasFullSpec ? 10 : 0;
	const acScore = signals.hasAcceptanceCriteria ? 10 : 0;
	const noGapsScore =
		signals.blockingGapCount === 0 && (!isBug || !signals.needsMoreInfo)
			? 10
			: 0;
	const recencyScore = signals.isSpecRecentlyUpdated ? 10 : 0;

	// For BUG: Expected Result (+5%) + Actual Result (+5%)
	// For FEATURE: Functional Requirements (+10%)
	const requirementScore = isBug
		? (signals.hasExpectedResult ? 5 : 0) +
			(signals.hasActualResult ? 5 : 0)
		: signals.hasFunctionalRequirements
			? 10
			: 0;

	const baselineScore = Math.min(
		50,
		specScore + acScore + noGapsScore + recencyScore + requirementScore,
	);

	const hasAnySpecContent =
		signals.hasFullSpec ||
		signals.hasAcceptanceCriteria ||
		(isBug
			? Boolean(signals.hasExpectedResult || signals.hasActualResult)
			: signals.hasFunctionalRequirements);

	const totalQuestions =
		signals.openQuestionsCount + signals.resolvedQuestionsCount;
	let questionsScore = 0;

	if (totalQuestions > 0) {
		const ratio = signals.resolvedQuestionsCount / totalQuestions;
		questionsScore = Math.round(ratio * 50);
	} else if (hasAnySpecContent) {
		questionsScore = 50;
	}

	return Math.min(100, Math.max(0, baselineScore + questionsScore));
}

/**
 * Returns Option A 5-tier status color class based on readiness percentage.
 * Uses semantic CSS variable tokens per project design system:
 * - 0% - 24%: Red (bg-destructive)
 * - 25% - 49%: Orange (bg-highlight/75)
 * - 50% - 74%: Yellow/Highlight (bg-highlight)
 * - 75% - 99%: Light Green (bg-success/80)
 * - 100%: Full Theme Green (bg-success)
 */
export function getReadinessTierColor(percentage: number): string {
	if (percentage >= 100) {
		return "bg-success";
	}
	if (percentage >= 75) {
		return "bg-success/80";
	}
	if (percentage >= 50) {
		return "bg-highlight";
	}
	if (percentage >= 25) {
		return "bg-highlight/75";
	}
	return "bg-destructive";
}

/**
 * Returns human-readable status tier label for tooltips and accessibility.
 */
function getReadinessTierLabel(percentage: number): string {
	if (percentage >= 100) {
		return "Fully Ready";
	}
	if (percentage >= 75) {
		return "Nearly Ready";
	}
	if (percentage >= 50) {
		return "In Progress";
	}
	if (percentage >= 25) {
		return "Early Maturation";
	}
	return "Not Ready";
}

interface ReadinessBarProps {
	signals: FeatureReadinessSignals;
	className?: string;
	isAiMode?: boolean;
	isAiEvaluating?: boolean;
	aiResult?: AiReadinessData | null;
	onToggleAiMode?: (enabled: boolean) => void;
}

/**
 * Display-only readiness bar indicator component rendered on the Feature Summary tab header.
 * Controlled component supporting Dual-Mode (Rule-Based SPEC Readiness vs AI-Assessed Readiness).
 */
export function ReadinessBar({
	signals,
	className,
	isAiMode = false,
	isAiEvaluating = false,
	aiResult = null,
	onToggleAiMode,
}: ReadinessBarProps) {
	const activeAiMode = isAiMode;

	const handleToggleAi = () => {
		onToggleAiMode?.(!activeAiMode);
	};

	// Calculate rule-based percentage or AI score
	const rulePercentage = calculateFeatureReadiness(signals);
	const percentage = activeAiMode
		? (aiResult?.aiReadinessScore ?? rulePercentage)
		: rulePercentage;

	const barColorClass = getReadinessTierColor(percentage);
	const tierLabel = activeAiMode
		? (aiResult?.tierLabel ?? getReadinessTierLabel(percentage))
		: getReadinessTierLabel(percentage);

	const totalQuestions =
		signals.openQuestionsCount + signals.resolvedQuestionsCount;

	const labelText = activeAiMode ? "AI Readiness" : "Spec Readiness";
	const isBug = signals.storyKind === "BUG";

	return (
		<div className={cn("flex items-center gap-2", className)}>
			{/* Progress Bar & Value Tooltip */}
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						className="flex items-center gap-2 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded border-0 bg-transparent p-0 text-left font-normal"
					>
						<span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
							{labelText}
						</span>

						{/* Progress Track */}
						<div className="relative h-2 w-28 overflow-hidden rounded-full bg-muted/60">
							<div
								className={cn(
									"h-full transition-[width] duration-500 ease-out rounded-full",
									barColorClass,
								)}
								style={{ width: `${percentage}%` }}
								role="progressbar"
								aria-valuenow={percentage}
								aria-valuemin={0}
								aria-valuemax={100}
								aria-label={`${labelText}: ${percentage}%`}
							/>
						</div>

						{/* Numeric Badge & Spinner */}
						<div className="flex items-center gap-1 min-w-[36px]">
							{isAiEvaluating ? (
								<Loader2Icon className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
							) : (
								<span className="text-xs font-bold tabular-nums text-foreground">
									{percentage}%
								</span>
							)}
						</div>
					</button>
				</TooltipTrigger>
				<TooltipContent
					surface="popover"
					side="bottom"
					align="end"
					className="w-[420px] max-w-[90vw] max-h-[380px] overflow-y-auto p-3 text-xs"
				>
					{activeAiMode && aiResult ? (
						<div className="space-y-2">
							<div className="flex items-center justify-between gap-2 border-b border-border/40 pb-1.5 font-semibold text-foreground">
								<span>
									AI Readiness: {aiResult.aiReadinessScore}%
								</span>
								<span className="text-[11px] font-medium text-muted-foreground">
									• {aiResult.tierLabel}
								</span>
							</div>

							<p className="text-muted-foreground leading-relaxed">
								{aiResult.rationale}
							</p>

							{aiResult.strengths.length > 0 && (
								<div className="space-y-1 pt-1">
									<div className="font-semibold text-success">
										Strengths:
									</div>
									<ul className="space-y-0.5 text-muted-foreground">
										{aiResult.strengths.map(
											(strength, i) => (
												<li
													key={`strength-${i}-${strength}`}
													className="flex items-start gap-1.5 text-success"
												>
													<span className="select-none font-bold">
														•
													</span>
													<span>{strength}</span>
												</li>
											),
										)}
									</ul>
								</div>
							)}

							{aiResult.gaps.length > 0 && (
								<div className="space-y-1 pt-1">
									<div className="font-semibold text-highlight">
										Gaps:
									</div>
									<ul className="space-y-0.5 text-muted-foreground">
										{aiResult.gaps.map((gap, i) => (
											<li
												key={`gap-${i}-${gap}`}
												className="flex items-start gap-1.5 text-highlight"
											>
												<span className="select-none font-bold">
													•
												</span>
												<span>{gap}</span>
											</li>
										))}
									</ul>
								</div>
							)}
						</div>
					) : (
						<div className="space-y-1.5">
							<div className="font-semibold text-foreground">
								Spec Readiness: {percentage}% • {tierLabel}
							</div>

							<ul className="space-y-1 text-muted-foreground">
								<li
									className={cn(
										"flex items-center gap-1.5",
										signals.hasFullSpec &&
											"text-foreground font-medium",
									)}
								>
									<span>
										{signals.hasFullSpec ? "✓" : "◦"}
									</span>
									<span>
										{isBug
											? "Bug Overview/Description present (+10%)"
											: "Full Spec description present (+10%)"}
									</span>
								</li>

								<li
									className={cn(
										"flex items-center gap-1.5",
										signals.hasAcceptanceCriteria &&
											"text-foreground font-medium",
									)}
								>
									<span>
										{signals.hasAcceptanceCriteria
											? "✓"
											: "◦"}
									</span>
									<span>
										{isBug
											? "Fix Acceptance Criteria present (+10%)"
											: "Acceptance Criteria present (+10%)"}
									</span>
								</li>

								{isBug ? (
									<>
										<li
											className={cn(
												"flex items-center gap-1.5",
												signals.hasExpectedResult &&
													"text-foreground font-medium",
											)}
										>
											<span>
												{signals.hasExpectedResult
													? "✓"
													: "◦"}
											</span>
											<span>
												Expected Result present (+5%)
											</span>
										</li>
										<li
											className={cn(
												"flex items-center gap-1.5",
												signals.hasActualResult &&
													"text-foreground font-medium",
											)}
										>
											<span>
												{signals.hasActualResult
													? "✓"
													: "◦"}
											</span>
											<span>
												Actual Result present (+5%)
											</span>
										</li>
									</>
								) : (
									<li
										className={cn(
											"flex items-center gap-1.5",
											signals.hasFunctionalRequirements &&
												"text-foreground font-medium",
										)}
									>
										<span>
											{signals.hasFunctionalRequirements
												? "✓"
												: "◦"}
										</span>
										<span>
											Functional Requirements present
											(+10%)
										</span>
									</li>
								)}

								<li
									className={cn(
										"flex items-center gap-1.5",
										signals.blockingGapCount === 0 &&
											(!isBug ||
												!signals.needsMoreInfo) &&
											"text-foreground font-medium",
									)}
								>
									<span>
										{signals.blockingGapCount === 0 &&
										(!isBug || !signals.needsMoreInfo)
											? "✓"
											: "◦"}
									</span>
									<span>
										{isBug
											? "Zero Blocking Gaps / NeedsMoreInfo Cleared (+10%)"
											: "No PM/BA blocking gaps (+10%)"}
									</span>
								</li>

								<li
									className={cn(
										"flex items-center gap-1.5",
										signals.isSpecRecentlyUpdated &&
											"text-foreground font-medium",
									)}
								>
									<span>
										{signals.isSpecRecentlyUpdated
											? "✓"
											: "◦"}
									</span>
									<span>
										{isBug
											? "Ticket updated within 15 days (+10%)"
											: "Spec updated within 15 days (+10%)"}
									</span>
								</li>

								<li
									className={cn(
										"flex items-center gap-1.5",
										totalQuestions === 0 ||
											signals.openQuestionsCount === 0
											? "text-foreground font-medium"
											: "text-muted-foreground",
									)}
								>
									<span>
										{totalQuestions === 0 ||
										signals.openQuestionsCount === 0
											? "✓"
											: "◦"}
									</span>
									<span>
										{totalQuestions === 0
											? "All open questions resolved"
											: `${signals.resolvedQuestionsCount} of ${totalQuestions} questions resolved`}
									</span>
								</li>
							</ul>
						</div>
					)}
				</TooltipContent>
			</Tooltip>

			{/* AI Mode Toggle Switch */}
			<Tooltip>
				<TooltipTrigger asChild>
					<div className="flex items-center gap-1.5 rounded-full border border-border/50 bg-background/50 px-2 py-0.5 shadow-2xs">
						<SparklesIcon
							className={cn(
								"h-3 w-3 transition-colors",
								activeAiMode
									? "text-highlight"
									: "text-muted-foreground/60",
							)}
						/>
						<span
							className={cn(
								"text-[10px] font-medium transition-colors select-none",
								activeAiMode
									? "text-foreground font-semibold"
									: "text-muted-foreground",
							)}
						>
							AI Mode
						</span>
						<Switch
							checked={activeAiMode}
							onCheckedChange={(checked) => {
								if (checked !== activeAiMode) {
									handleToggleAi();
								}
							}}
							aria-label="Toggle AI Readiness Assessment"
							className="scale-75"
						/>
					</div>
				</TooltipTrigger>
				<TooltipContent
					surface="popover"
					side="bottom"
					align="center"
					className="max-w-xs p-2.5 text-xs"
				>
					<div className="font-semibold text-foreground">
						Switch to AI Readiness
					</div>
					<div className="mt-1 text-muted-foreground">
						Analyzes feature clarity, requirement completeness, and
						open questions to calculate the readiness score.
					</div>
					<div className="mt-1.5 font-medium text-highlight">
						Uses AI tokens / API credits.
					</div>
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
