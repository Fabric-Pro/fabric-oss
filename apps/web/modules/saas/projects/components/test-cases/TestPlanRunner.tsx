"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { cn } from "@ui/lib";
import {
	CheckIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	Loader2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	MARKABLE_RESULTS,
	RESULT_I18N_KEY,
	RESULT_TONE,
	type RecordableResult,
	type TestResult,
	TONE_CLASSES,
} from "./constants";
import { PassRateBar, PassRateValue } from "./PassRateBar";
import { planPassRateView, rollupFromCounts } from "./plan-pass-rate";
import { TestCaseResultPill } from "./TestCaseResultPill";

/**
 * The keyboard shortcut that marks each result — a run is repetitive, so hands
 * stay on the keys.
 *
 * Partial on purpose: `MARKABLE_RESULTS` stays the single source of WHICH
 * results a user can mark, and this only decorates them. A result added there
 * without a shortcut here still gets its button, just no key hint.
 */
const RESULT_SHORTCUT: Partial<Record<RecordableResult, string>> = {
	PASSED: "p",
	FAILED: "f",
	BLOCKED: "b",
};

/** A plan's case, in plan order — exactly what the plan detail already holds. */
type RunnableCase = {
	testCaseId: string;
	identifier: string;
	title: string;
};

type Props = {
	projectId: string;
	organizationId: string | null;
	planId: string;
	planName: string;
	/** The plan's cases, in plan order. */
	cases: RunnableCase[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

/**
 * Step a tester through a plan's cases, marking each Passed / Failed / Blocked.
 *
 * Results are recorded through the ordinary `recordResult` procedure with this
 * plan's `testPlanId`, so a run's marks are attributed to the plan exactly like
 * any other plan-scoped result — the runner introduces no second write path and
 * no state of its own on the server. What it adds is only sequencing: which case
 * is on screen, and what the tester has marked so far this sitting.
 */
export function TestPlanRunner({
	projectId,
	organizationId,
	planId,
	planName,
	cases,
	open,
	onOpenChange,
}: Props) {
	const t = useTranslations("projects.testCases");
	const queryClient = useQueryClient();

	const [index, setIndex] = useState(0);
	/** What this sitting has marked, per case id — drives progress + the summary. */
	const [marks, setMarks] = useState<Record<string, RecordableResult>>({});
	const [finished, setFinished] = useState(false);

	// A run is a sitting, not a document: each open starts clean rather than
	// resuming a stale position from cases that may since have left the plan.
	useEffect(() => {
		if (open) {
			setIndex(0);
			setMarks({});
			setFinished(false);
		}
	}, [open]);

	const current = cases[index];
	const total = cases.length;
	const markedCount = Object.keys(marks).length;

	// The case's steps live on the detail read, not on the plan's case links, so
	// the runner fetches the case it is showing. One query per case as the tester
	// advances (cached by react-query), never a batch of every case up front.
	const { data: caseData, isLoading: caseLoading } = useQuery({
		...orpc.projects.testCases.get.queryOptions({
			input: {
				projectId,
				organizationId,
				testCaseId: current?.testCaseId ?? "",
			},
		}),
		enabled: open && Boolean(current),
	});
	const steps = caseData?.testCase?.steps ?? [];

	/**
	 * A recorded result changes every number derived from it, so each write
	 * invalidates its readers: the plans list (whose cards carry the
	 * `resultRollup` the pass rate comes from), this plan's detail, and the cases
	 * list (each case's `currentResult`).
	 *
	 * This runs per WRITE rather than once at the end deliberately. Invalidating
	 * on "finished" would fire while the last mark's request was still in flight
	 * and cache the pre-mark rate — the one number a tester checks the moment the
	 * run ends. Only the mounted queries refetch; the rest are merely marked
	 * stale, so the cost of doing it per mark is a single small read.
	 */
	const invalidatePassRate = () => {
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.plans.list.key(),
		});
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.plans.get.key(),
		});
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.list.key(),
		});
	};

	const recordMutation = useMutation(
		orpc.projects.testCases.recordResult.mutationOptions({
			onError: (e) =>
				toast.error(t("toasts.resultFailed", { error: e.message })),
		}),
	);

	const advance = () => {
		if (index + 1 >= total) {
			setFinished(true);
			return;
		}
		setIndex((prev) => prev + 1);
	};

	const mark = (result: RecordableResult) => {
		if (!current) {
			return;
		}
		const caseId = current.testCaseId;
		recordMutation.mutate(
			{
				projectId,
				organizationId,
				testCaseId: caseId,
				result,
				// Attributes the result to this plan — the whole point of running a
				// plan rather than marking cases one by one.
				testPlanId: planId,
			},
			{
				onSuccess: () => {
					setMarks((prev) => ({ ...prev, [caseId]: result }));
					invalidatePassRate();
				},
			},
		);
		// Advance immediately: the tester's attention is already on the next case,
		// and a failed write surfaces as a toast + an unmarked case in the summary
		// rather than blocking the run behind a spinner.
		advance();
	};

	const summaryView = useMemo(() => {
		const counts: Record<TestResult, number> = {
			NOT_RUN: 0,
			PASSED: 0,
			FAILED: 0,
			BLOCKED: 0,
			// Always zero here: this is a human walking a plan by hand, and a
			// person cannot mark SKIPPED (see MARKABLE_RESULTS). Present so the
			// record stays exhaustive for the shared rollup.
			SKIPPED: 0,
		};
		for (const c of cases) {
			counts[marks[c.testCaseId] ?? "NOT_RUN"] += 1;
		}
		return planPassRateView(rollupFromCounts(counts, total));
	}, [cases, marks, total]);

	// Keyboard-first: p/f/b mark, arrows navigate. Scoped to the dialog and
	// ignored while a text field has focus, so the shortcuts can never eat typing.
	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (finished || event.metaKey || event.ctrlKey || event.altKey) {
			return;
		}
		const target = event.target;
		if (
			target instanceof HTMLElement &&
			(target.isContentEditable ||
				["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
		) {
			return;
		}
		const key = event.key.toLowerCase();
		const shortcut = MARKABLE_RESULTS.find(
			(result) => RESULT_SHORTCUT[result] === key,
		);
		if (shortcut) {
			event.preventDefault();
			mark(shortcut);
			return;
		}
		if (event.key === "ArrowRight") {
			event.preventDefault();
			advance();
		}
		if (event.key === "ArrowLeft" && index > 0) {
			event.preventDefault();
			setIndex((prev) => prev - 1);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/* Radix requires a Description on every dialog; without one it logs an
			    a11y warning and the dialog has no accessible description. */}
			<DialogContent onKeyDown={handleKeyDown} className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{t("run.title", { plan: planName })}
					</DialogTitle>
					<DialogDescription>
						{finished
							? t("run.finishedDescription")
							: t("run.description")}
					</DialogDescription>
				</DialogHeader>

				{finished || !current ? (
					<RunSummary view={summaryView} markedCount={markedCount} />
				) : (
					<div className="space-y-4">
						<div className="space-y-1.5">
							<div className="flex items-center justify-between gap-2">
								<span className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
									{t("run.progress", {
										current: index + 1,
										total,
									})}
								</span>
								{marks[current.testCaseId] && (
									<TestCaseResultPill
										result={marks[current.testCaseId]}
										label={t(
											RESULT_I18N_KEY[
												marks[current.testCaseId]
											],
										)}
									/>
								)}
							</div>
							{/* Bounded progress, announced as a real progressbar. */}
							<div
								role="progressbar"
								aria-valuemin={0}
								aria-valuemax={total}
								aria-valuenow={markedCount}
								aria-label={t("run.progressAria", {
									marked: markedCount,
									total,
								})}
								className="h-1.5 overflow-hidden rounded-full bg-muted"
							>
								<div
									className="h-full bg-primary transition-[width]"
									style={{
										width: `${total > 0 ? (markedCount / total) * 100 : 0}%`,
									}}
								/>
							</div>
						</div>

						<div>
							<div className="flex items-baseline gap-2">
								<span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
									{current.identifier}
								</span>
								<h3 className="min-w-0 break-words font-medium text-sm">
									{current.title}
								</h3>
							</div>
						</div>

						<div
							// The step list is the thing a tester reads while working;
							// it scrolls on its own so the mark controls never leave
							// the viewport on a long case.
							className="max-h-[40vh] overflow-y-auto rounded-lg border"
						>
							{caseLoading ? (
								<div className="flex items-center justify-center py-10 text-muted-foreground">
									<Loader2Icon className="size-4 motion-safe:animate-spin" />
								</div>
							) : steps.length === 0 ? (
								<p className="px-3 py-6 text-center text-muted-foreground text-sm">
									{t("run.noSteps")}
								</p>
							) : (
								<ol className="divide-y">
									{steps.map((step, stepIndex) => (
										<li
											key={step.id}
											className="grid grid-cols-[1.5rem_1fr_1fr] gap-3 px-3 py-2 text-sm"
										>
											<span className="font-mono text-muted-foreground text-xs tabular-nums">
												{stepIndex + 1}
											</span>
											<span className="min-w-0 break-words">
												{step.action}
											</span>
											<span className="min-w-0 break-words text-muted-foreground">
												{step.expected}
											</span>
										</li>
									))}
								</ol>
							)}
						</div>

						<div className="flex flex-wrap items-center gap-2">
							{MARKABLE_RESULTS.map((result) => {
								const tone = TONE_CLASSES[RESULT_TONE[result]];
								const shortcut = RESULT_SHORTCUT[result];
								return (
									<Button
										key={result}
										type="button"
										variant="outline"
										onClick={() => mark(result)}
										// Names the button by its RESULT, so the
										// visible key hint below doesn't end up
										// read out as part of it ("Passed p").
										aria-label={t(RESULT_I18N_KEY[result])}
										className="gap-2"
									>
										{/* The dot reinforces the result; the label
										    carries it. Never colour alone. */}
										<span
											aria-hidden="true"
											className={cn(
												"size-2 rounded-full",
												tone.dot,
											)}
										/>
										{t(RESULT_I18N_KEY[result])}
										{shortcut && (
											<kbd className="rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground uppercase">
												{shortcut}
											</kbd>
										)}
									</Button>
								);
							})}
							<Button
								type="button"
								variant="ghost"
								onClick={advance}
								className="ml-auto text-muted-foreground"
							>
								{t("run.skip")}
								<ChevronRightIcon
									className="ml-1 size-4"
									aria-hidden="true"
								/>
							</Button>
						</div>
					</div>
				)}

				<DialogFooter className="sm:justify-between">
					{finished ? (
						<Button
							type="button"
							onClick={() => onOpenChange(false)}
						>
							{t("actions.done")}
						</Button>
					) : (
						<>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={index === 0}
								onClick={() => setIndex((prev) => prev - 1)}
							>
								<ChevronLeftIcon
									className="mr-1 size-4"
									aria-hidden="true"
								/>
								{t("run.previous")}
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setFinished(true)}
							>
								<CheckIcon
									className="mr-1 size-4"
									aria-hidden="true"
								/>
								{t("run.finish")}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** What the sitting achieved: the same pass-rate presentation every other surface uses. */
function RunSummary({
	view,
	markedCount,
}: {
	view: ReturnType<typeof planPassRateView>;
	markedCount: number;
}) {
	const t = useTranslations("projects.testCases");
	return (
		<div className="space-y-3 py-2">
			<p className="text-muted-foreground text-sm">
				{t("run.summary", { marked: markedCount, total: view.total })}
			</p>
			<div className="flex items-center gap-3">
				<PassRateBar view={view} className="flex-1" />
				<PassRateValue view={view} />
			</div>
		</div>
	);
}
