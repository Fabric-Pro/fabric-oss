"use client";

/**
 * Rules health (specs/2026-10-21-ai-artifacts-hub §5.8): how much of every
 * coding session the project's rules take, how they are loaded (always on,
 * by path, on demand), what is duplicated or too long, and an AI review for
 * contradictions and merges, whose suggestions an editor can apply as reviewed
 * file edits (`ApplyRuleSuggestions`).
 *
 * One story throughout: the checks, the review and the suggested edits speak
 * in the shared finding categories (`@repo/instructions/rule-findings`) and
 * count files the same way, the badge and the budget meter read the same
 * computed state (`rulesHealthState`), and an applied commit shows here as
 * one result line once the edits dialog has closed.
 */

import type { RuleFinding } from "@repo/instructions/rule-findings";
import { summarizeRuleFindings } from "@repo/instructions/rule-findings";
import {
	RULE_FINDING_LABELS,
	rulesHealthState,
} from "@saas/projects/lib/rule-suggestions";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { ChevronDownIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import { useId, useState } from "react";
import { ApplyRuleSuggestions } from "./ApplyRuleSuggestions";
import { RuleReviewFindings, RuleReviewSummary } from "./RuleReview";
import {
	type AppliedRuleSuggestions,
	RuleSuggestionsResult,
} from "./RuleSuggestionsResult";

const TIER_LABELS: Record<string, string> = {
	"always-on": "always on",
	scoped: "by path",
	"on-demand": "on demand",
	"over-budget": "over budget",
};

const FINDING_LABELS: Record<string, string> = {
	duplicate: "Duplicate",
	"near-duplicate": "Near duplicate",
	"over-budget": "Over the always-on budget",
	long: "Long rule",
	"no-description": "No description",
	empty: "Empty rule",
};

/** The meter's colour for each budget state. */
const BUDGET_BAR_CLASS = {
	headroom: "bg-muted-foreground/60",
	close: "bg-amber-500",
	over: "bg-destructive",
} as const;

export function RulesHealthPanel({
	projectId,
	canEdit = false,
	readOnlyMode = false,
}: {
	projectId: string;
	/** Whether this viewer may change the instructions (INSTRUCTION_CREATE). */
	canEdit?: boolean;
	readOnlyMode?: boolean;
}) {
	const checksId = useId();
	const [open, setOpen] = useState(false);
	const [applied, setApplied] = useState<AppliedRuleSuggestions | null>(null);
	const health = useQuery({
		...orpc.projects.instructions.rulesHealth.queryOptions({
			input: { projectId },
		}),
		retry: false,
	});
	const review = useMutation(
		orpc.projects.instructions.reviewRules.mutationOptions(),
	);
	const data = health.data;
	if (!data || data.rules.length === 0) {
		return null;
	}
	const counts = data.rules.reduce<Record<string, number>>((acc, rule) => {
		acc[rule.tier] = (acc[rule.tier] ?? 0) + 1;
		return acc;
	}, {});
	const used = Math.min(
		100,
		Math.round((data.alwaysOnChars / data.budget) * 100),
	);
	const state = rulesHealthState(data);
	const flagged = state.summary.files.length;
	const reviewFindings = (review.data?.findings ?? null) as
		| RuleFinding[]
		| null;
	const reviewSummary = reviewFindings
		? summarizeRuleFindings(reviewFindings)
		: null;

	const showChecks = () => {
		setOpen(true);
		requestAnimationFrame(() => {
			const list = document.getElementById(checksId);
			list?.scrollIntoView?.({ block: "nearest" });
			list?.focus();
		});
	};

	return (
		<Card className="flex flex-col gap-2 p-4">
			<div className="flex w-full flex-wrap items-center justify-between gap-2">
				<button
					type="button"
					className="flex flex-1 flex-wrap items-center justify-between gap-2 text-left"
					aria-expanded={open}
					onClick={() => setOpen((v) => !v)}
				>
					<span className="flex items-center gap-2 font-medium text-sm">
						{open ? (
							<ChevronDownIcon
								className="size-4"
								aria-hidden="true"
							/>
						) : (
							<ChevronRightIcon
								className="size-4"
								aria-hidden="true"
							/>
						)}
						Rules health
					</span>
					<span className="text-muted-foreground text-xs">
						{data.rules.length} rules ·{" "}
						{Object.entries(counts)
							.map(
								([tier, n]) =>
									`${n} ${TIER_LABELS[tier] ?? tier}`,
							)
							.join(" · ")}
					</span>
				</button>
				{flagged > 0 ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								data-testid="rules-health-badge"
								className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
								onClick={showChecks}
							>
								<Badge status="warning">
									{flagged} to clean up
								</Badge>
							</button>
						</TooltipTrigger>
						<TooltipContent className="max-w-xs">
							<p>
								Files the checks flagged:{" "}
								{state.summary.counts
									.map(
										(entry) =>
											`${entry.files} ${RULE_FINDING_LABELS[entry.category]}`,
									)
									.join(", ")}
								. Clean-up covers duplicate, long, empty and
								undescribed rules. Select to see the files.
							</p>
						</TooltipContent>
					</Tooltip>
				) : (
					<Badge status="success" data-testid="rules-health-badge">
						clean
					</Badge>
				)}
			</div>
			<div className="flex items-center gap-2 text-xs">
				<span className="text-muted-foreground">Always-on budget</span>
				<div
					className="h-2 flex-1 overflow-hidden rounded bg-muted"
					role="meter"
					aria-label="Always-on rules budget"
					aria-valuemin={0}
					aria-valuemax={data.budget}
					aria-valuenow={data.alwaysOnChars}
				>
					<div
						data-testid="rules-budget-bar"
						data-state={state.budget}
						className={cn("h-full", BUDGET_BAR_CLASS[state.budget])}
						style={{ width: `${used}%` }}
					/>
				</div>
				<span className="tabular-nums">
					{data.alwaysOnChars.toLocaleString()} /{" "}
					{data.budget.toLocaleString()}
				</span>
			</div>
			{reviewSummary ? (
				<RuleReviewSummary summary={reviewSummary} />
			) : null}
			{applied ? (
				<RuleSuggestionsResult
					projectId={projectId}
					result={applied}
					onDismiss={() => setApplied(null)}
				/>
			) : null}
			{open ? (
				<div className="flex flex-col gap-3">
					<p className="text-muted-foreground text-xs">
						Rules with <code>paths:</code> load only for matching
						files; rules marked <code>load: on-demand</code> (and
						always-on rules past the budget) load when a task calls
						for them, through the plugin's fabric-rules skill.
					</p>
					{data.findings.length > 0 ? (
						<ul
							id={checksId}
							tabIndex={-1}
							aria-label="What the checks found"
							className="flex flex-col gap-2 focus-visible:outline-none"
						>
							{data.findings.map((finding, index) => (
								<li
									key={`${finding.kind}-${index}`}
									className="rounded-md border p-2 text-xs"
								>
									<p className="font-medium">
										{FINDING_LABELS[finding.kind] ??
											finding.kind}
									</p>
									<p className="text-muted-foreground">
										{finding.detail}
									</p>
									<p className="break-all">
										{finding.paths.map((p) => (
											<code key={p} className="mr-2">
												{p}
											</code>
										))}
									</p>
								</li>
							))}
						</ul>
					) : null}
					<div className="flex flex-col gap-2">
						<Button
							type="button"
							size="sm"
							variant="outline"
							className="self-start"
							disabled={review.isPending}
							onClick={() => {
								setApplied(null);
								review.mutate({ projectId });
							}}
						>
							{review.isPending ? (
								<Loader2Icon
									className="size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : null}
							Review with AI
						</Button>
						{review.error ? (
							<p
								role="alert"
								className="text-destructive text-xs"
							>
								{review.error.message}
							</p>
						) : null}
						{reviewFindings ? (
							<>
								<div className="rounded-md border p-3">
									<RuleReviewFindings
										findings={reviewFindings}
									/>
								</div>
								{reviewFindings.length > 0 ? (
									<ApplyRuleSuggestions
										projectId={projectId}
										findings={reviewFindings}
										canEdit={canEdit}
										readOnlyMode={readOnlyMode}
										onApplied={(result) => {
											// The review described the rules
											// before this change; the line
											// says what became of it instead.
											review.reset();
											setApplied(result);
										}}
									/>
								) : null}
							</>
						) : null}
					</div>
				</div>
			) : null}
		</Card>
	);
}
