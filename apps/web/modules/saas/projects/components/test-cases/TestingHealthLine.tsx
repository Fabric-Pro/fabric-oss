"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import {
	computeTestingHealth,
	type TestCaseSummary,
} from "./test-case-summary";

type Props = {
	summary: TestCaseSummary;
	/**
	 * True when a STATE filter is active. The summary is deliberately
	 * state-independent so the state counts don't collapse onto the tab you're
	 * standing on — but that also means these figures span every state while the
	 * table below shows one, and unlabelled that reads as a miscount.
	 */
	stateFiltered?: boolean;
	/**
	 * The project's coverage target (Settings ▸ Testing ▸ Confidence & coverage),
	 * or undefined when coverage measurement is switched off there.
	 */
	coverageTarget?: number;
	className?: string;
	/** Onboarding anchor, set by the page that places this. */
	"data-onboarding-target"?: string;
};

/**
 * Project testing health, as one scannable row beside the page title.
 *
 * This replaces five equally-weighted stat cards. Those cards cost a full band
 * of vertical space above the table and gave the reader no ranking: "total",
 * "state mix", "automation", "CI coverage" and "passing" all looked equally
 * important, so none of them read as the answer. The three numbers that
 * actually decide whether a suite is healthy — how big it is, how much of it
 * passes, how much of it runs itself — sit inline with the title instead, and
 * the rest is a keystroke away in the table's own filters.
 *
 * Every figure comes from the server-computed summary, so it describes the
 * whole filtered set rather than the page on screen.
 */
export function TestingHealthLine({
	summary,
	stateFiltered = false,
	coverageTarget,
	className,
	"data-onboarding-target": onboardingTarget,
}: Props) {
	const t = useTranslations("projects.testCases");
	const health = computeTestingHealth(summary, coverageTarget);

	return (
		<div
			data-onboarding-target={onboardingTarget}
			className={cn(
				"flex flex-wrap items-center gap-x-4 gap-y-2 border-border/70 text-sm sm:border-l sm:pl-4",
				className,
			)}
		>
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="inline-flex items-baseline gap-1.5 text-muted-foreground">
						<b className="font-semibold text-foreground tabular-nums">
							{health.total}
						</b>
						{t("health.cases")}
					</span>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs">
					{t(
						stateFiltered
							? "health.casesAllStatesHint"
							: "health.casesHint",
					)}
				</TooltipContent>
			</Tooltip>

			{health.executed > 0 && (
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="inline-flex items-center gap-2 text-muted-foreground">
							<span
								role="img"
								aria-label={t("health.mixAria", {
									passed: health.passed,
									failed: health.failed,
									blocked: health.blocked,
								})}
								className="flex h-1.5 w-16 overflow-hidden rounded-full bg-muted"
							>
								<span
									className="bg-secondary"
									style={{ width: `${health.passShare}%` }}
								/>
								<span
									className="bg-destructive"
									style={{ width: `${health.failShare}%` }}
								/>
								<span
									className="bg-highlight"
									style={{ width: `${health.blockedShare}%` }}
								/>
							</span>
							<b className="font-semibold text-foreground tabular-nums">
								{health.passRate}%
							</b>
							{t("health.passing")}
						</span>
					</TooltipTrigger>
					<TooltipContent className="max-w-xs">
						{t("health.passingHint", {
							executed: health.executed,
							total: health.total,
						})}
					</TooltipContent>
				</Tooltip>
			)}

			<Tooltip>
				<TooltipTrigger asChild>
					<span className="inline-flex items-baseline gap-1.5 text-muted-foreground">
						<b
							className={cn(
								"font-semibold tabular-nums",
								health.belowTarget
									? "text-highlight"
									: "text-foreground",
							)}
						>
							{health.automatedPct}%
						</b>
						{t("health.automated")}
						{coverageTarget !== undefined && (
							<span className="opacity-70">
								{t("health.ofTarget", { pct: coverageTarget })}
							</span>
						)}
					</span>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs">
					{t("health.automatedHint", {
						automated: health.automated,
						total: health.total,
						ci: health.ciCoveredPct,
					})}
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
