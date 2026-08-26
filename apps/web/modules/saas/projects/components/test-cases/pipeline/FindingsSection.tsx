"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import {
	BugIcon,
	Loader2Icon,
	SparklesIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { timeAgo } from "./pipeline-run";

type Finding = {
	id: string;
	fingerprint: string;
	testName: string;
	classname: string | null;
	failureMessage: string | null;
	status: string;
	occurrences: number;
	firstSeenAt: string | Date;
	lastSeenAt: string | Date;
	testCaseId: string | null;
	promotedStoryId: string | null;
	suspectedCause: string | null;
	suspectedKind: string | null;
	analysedAt: string | Date | null;
	analysisModel: string | null;
	/**
	 * What changed between the run this test last passed in and the run it
	 * failed in, ranked by how plausibly each file relates to THIS test (spec
	 * §7.2). Already narrowed server-side, so it is either a whole diff or null —
	 * there is no half-populated case to defend against here.
	 *
	 * Null covers every "we cannot see the change" outcome: no commit range, no
	 * connected repo, an expired token, a compare that returned nothing
	 * relevant. They are one absence on purpose — in all of them the reader must
	 * not be shown files as if they were suspects.
	 */
	analysisDiff: {
		commitRange: { baseSha: string; headSha: string };
		changedFiles: Array<{ path: string; reason: string }>;
		truncated: boolean;
	} | null;
};

/** Enough of a sha to recognise, which is all a reader does with one. */
const SHA_DISPLAY_LENGTH = 7;

/**
 * The changed files the analysis was shown, beneath the cause it proposed.
 *
 * This is the difference between "the model thinks it is a product bug" and a
 * claim a reader can check. The ranking is already done and already argued for —
 * each file carries the reason it scored — so the job here is only to keep the
 * order and not to imply more certainty than a ranked guess deserves.
 *
 * Renders nothing at all when there is no diff. An empty "no files changed"
 * block would be a claim about the repository, and the null case mostly means
 * Fabric could not look.
 */
function CorrelatedFiles({ diff }: { diff: Finding["analysisDiff"] }) {
	const t = useTranslations(
		"projects.stories.maturation.qa.pipelineRuns.findings",
	);
	if (!diff) {
		return null;
	}
	return (
		<div className="mt-2 border-border/60 border-t pt-1.5">
			<div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
				<span className="font-medium text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
					{t("analysis.changedSince")}
				</span>
				<span className="font-mono text-[10px] text-muted-foreground">
					{diff.commitRange.baseSha.slice(0, SHA_DISPLAY_LENGTH)}…
					{diff.commitRange.headSha.slice(0, SHA_DISPLAY_LENGTH)}
				</span>
			</div>
			<ul className="mt-1 space-y-1">
				{diff.changedFiles.map((file) => (
					<li key={file.path}>
						<p className="break-all font-mono text-[11px] text-foreground/90">
							{file.path}
						</p>
						<p className="text-[10px] text-muted-foreground">
							{file.reason}
						</p>
					</li>
				))}
			</ul>
			{diff.truncated && (
				<p className="mt-1 text-[10px] text-muted-foreground">
					{t("analysis.diffTruncated")}
				</p>
			)}
		</div>
	);
}

/** Every kind this UI can name. Anything else narrows to UNKNOWN, never a throw. */
function narrowKind(raw: string): keyof typeof KIND_TONE {
	return raw in KIND_TONE ? (raw as keyof typeof KIND_TONE) : "UNKNOWN";
}

/**
 * Tone per failure kind. PRODUCT_BUG is the only one that earns the destructive
 * colour: it is the one that says "this is ours". TEST_DEFECT and ENVIRONMENT are
 * work, not alarm, and UNKNOWN must look like an absence of judgement rather than
 * a verdict — a coloured badge would lend it authority the model does not have.
 */
const KIND_TONE: Record<string, string> = {
	PRODUCT_BUG: "border-destructive/40 bg-destructive/10 text-destructive",
	TEST_DEFECT: "border-highlight/40 bg-highlight/10 text-highlight",
	ENVIRONMENT: "border-border bg-muted text-muted-foreground",
	FLAKY: "border-highlight/40 bg-highlight/10 text-highlight",
	UNKNOWN: "border-border bg-muted text-muted-foreground",
};

/** Rendered before "show more" — a triage list, not an archive. */
const PREVIEW = 8;

/**
 * Distinct CI failures, tracked across runs.
 *
 * The run list answers "what happened last night". This answers the question
 * that actually drives work: "what keeps breaking". The same assertion failing
 * for three weeks is ONE row here with `occurrences: 21`, where the run view
 * shows twenty-one unrelated-looking red runs.
 *
 * Promotion is a person's decision, never automatic — most findings are flakes
 * or known breakage, and filing a backlog item for each is how a backlog stops
 * being read.
 */
export function FindingsSection({
	projectId,
	className,
	storyId,
}: {
	projectId: string;
	className?: string;
	/**
	 * When set, list only the failures that belong to THIS feature. Without it
	 * the feature QA tab showed the project's whole failure list directly under
	 * a feature-scoped run list — so a feature nothing had tested still
	 * displayed a dozen red rows that were nothing to do with it.
	 */
	storyId?: string;
}) {
	const t = useTranslations(
		"projects.stories.maturation.qa.pipelineRuns.findings",
	);
	const queryClient = useQueryClient();
	const [showAll, setShowAll] = useState(false);
	// Which rows are being analysed. A SET, not one id: findings are independent
	// and a user who asks for two analyses has chosen to spend on two. Tracking a
	// single id forced the button state to be "is anything running", which
	// disabled all eight rows and read as the whole list being busy — the exact
	// behaviour the earlier version of this comment claimed to have avoided while
	// the code did it anyway.
	const [analysing, setAnalysing] = useState<ReadonlySet<string>>(
		() => new Set(),
	);

	const findingsQuery = useQuery(
		orpc.projects.pipelineResults.findings.queryOptions({
			input: {
				projectId,
				status: "OPEN",
				...(storyId ? { storyId } : {}),
			},
		}),
	);

	const promoteMutation = useMutation(
		orpc.projects.pipelineResults.promoteFinding.mutationOptions({
			onSuccess: (result) => {
				toast.success(
					result.alreadyPromoted
						? t("alreadyPromoted")
						: t("promoted"),
				);
				queryClient.invalidateQueries({
					queryKey: orpc.projects.pipelineResults.findings.key(),
				});
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	// Rows ticked for a merge. Findings written before a fingerprint change keep
	// their old hash forever, so one fault can sit here as several rows each
	// reading "Seen 1 time" — this is how a person repairs that. Deliberately not
	// a backfill: guessing which historical rows were the same fault destroys
	// evidence when it guesses wrong, and the reader of the list knows.
	const [selected, setSelected] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const toggleSelected = (id: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (!next.delete(id)) {
				next.add(id);
			}
			return next;
		});

	const dismissMutation = useMutation(
		orpc.projects.pipelineResults.dismissFinding.mutationOptions({
			onSuccess: (result) => {
				toast.success(
					result.alreadyDismissed
						? t("alreadyDismissed")
						: t("dismissed"),
				);
				queryClient.invalidateQueries({
					queryKey: orpc.projects.pipelineResults.findings.key(),
				});
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const mergeMutation = useMutation(
		orpc.projects.pipelineResults.mergeFindings.mutationOptions({
			onSuccess: (result) => {
				toast.success(t("merged", { count: result.mergedCount }));
				setSelected(new Set());
				queryClient.invalidateQueries({
					queryKey: orpc.projects.pipelineResults.findings.key(),
				});
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const analyseMutation = useMutation(
		orpc.projects.pipelineResults.analyseFinding.mutationOptions({
			onSuccess: (result) => {
				// Every non-answer comes back as data with a reason, so it can be
				// said out loud instead of failing silently or throwing a 500 into
				// the console.
				if (!result.analysed) {
					toast.error(t(`analysisFailed.${result.reason}`));
					return;
				}
				// Success is announced too, not just failure. Two reasons, both
				// found in review: a screen-reader user otherwise gets silence
				// from the moment they press the button; and the list is filtered
				// to OPEN, so a finding a later sync resolved is analysed
				// successfully and then simply VANISHES on refetch — an
				// unexplained disappearing row reads as a broken feature.
				toast.success(t("analysis.done"));
				queryClient.invalidateQueries({
					queryKey: orpc.projects.pipelineResults.findings.key(),
				});
			},
			onError: (error) => toast.error(error.message),
			onSettled: (_data, _error, variables) =>
				setAnalysing((prev) => {
					const next = new Set(prev);
					next.delete((variables as { findingId: string }).findingId);
					return next;
				}),
		}),
	);

	const findings = (findingsQuery.data ?? []) as Finding[];
	const shown = showAll ? findings : findings.slice(0, PREVIEW);

	// An empty findings list is good news, not an empty state to apologise for —
	// so it renders nothing at all rather than a box saying "no failures".
	if (!findingsQuery.isLoading && findings.length === 0) {
		return null;
	}

	return (
		<section
			aria-labelledby="qa-findings"
			className={cn("space-y-3", className)}
		>
			<div className="flex items-center justify-between gap-2">
				<h3
					id="qa-findings"
					className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.2em]"
				>
					{t("title")}
				</h3>
				{findings.length > 0 && (
					<span className="text-muted-foreground text-xs tabular-nums">
						{t("count", { count: findings.length })}
					</span>
				)}
			</div>

			{findingsQuery.isLoading ? (
				<div className="flex items-center gap-2 py-3 text-muted-foreground text-sm">
					<Loader2Icon
						className="size-4 motion-safe:animate-spin"
						aria-hidden="true"
					/>
					{t("loading")}
				</div>
			) : (
				<>
					<ul className="divide-y divide-border rounded-md border border-border">
						{shown.map((f) => (
							<li
								key={f.id}
								// Wraps. The two actions are `shrink-0`, so in a
								// non-wrapping row they were pushed straight off
								// the right edge on a phone — measured 61px past
								// a 375px viewport, with no scrollbar to reach
								// them, which made "Dismiss" unusable on mobile.
								className="flex flex-wrap items-start gap-3 px-3 py-2.5"
							>
								<input
									type="checkbox"
									className="mt-1 size-3.5 shrink-0 cursor-pointer accent-primary"
									checked={selected.has(f.id)}
									onChange={() => toggleSelected(f.id)}
									aria-label={t("selectForMerge", {
										name: f.testName,
									})}
								/>
								<TriangleAlertIcon
									className="mt-0.5 size-4 shrink-0 text-destructive"
									aria-hidden="true"
								/>
								<div className="min-w-0 flex-1">
									<p className="truncate font-medium text-sm">
										{f.testName}
									</p>
									{f.classname && (
										<p className="truncate text-muted-foreground text-xs">
											{f.classname}
										</p>
									)}
									<p className="mt-0.5 text-muted-foreground text-xs">
										{/* Recurrence is the whole point of this list —
										    it is what separates a flake seen once from
										    something rotting for three weeks. */}
										{t("seen", {
											count: f.occurrences,
											when: timeAgo(f.lastSeenAt) ?? "",
										})}
									</p>
									{f.failureMessage && (
										<pre className="mt-1.5 overflow-x-auto rounded bg-muted/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
											{f.failureMessage.slice(0, 300)}
										</pre>
									)}
									{/* The AI analysis. Labelled as a guess and
									    attributed to its model, because it sits
									    directly beneath the assertion CI actually
									    printed — the reader must be able to tell
									    which of the two is evidence. */}
									{f.analysedAt && f.suspectedCause && (
										<div className="mt-2 rounded-md border border-border border-dashed px-2 py-1.5">
											<div className="flex flex-wrap items-center gap-1.5">
												<span className="font-medium text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
													{t("analysis.label")}
												</span>
												{f.suspectedKind && (
													<span
														className={cn(
															"rounded border px-1.5 py-0.5 font-medium text-[10px]",
															KIND_TONE[
																narrowKind(
																	f.suspectedKind,
																)
															],
														)}
													>
														{t(
															`analysis.kind.${narrowKind(f.suspectedKind)}`,
														)}
													</span>
												)}
											</div>
											<p className="mt-1 text-foreground/90 text-xs">
												{f.suspectedCause}
											</p>
											<CorrelatedFiles
												diff={f.analysisDiff}
											/>
											{/* Not `text-muted-foreground`: the
											    honesty framing must not be the
											    quietest text in a block whose
											    loudest element is a coloured
											    verdict badge. */}
											<p className="mt-1 text-[10px] text-foreground/70">
												{f.analysisModel
													? t("analysis.byModel", {
															model: f.analysisModel,
														})
													: t("analysis.disclaimer")}
											</p>
										</div>
									)}
								</div>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									// `buttonVariants` styles only the native
									// `disabled:` pseudo-class (button.tsx), so an
									// aria-disabled button keeps a pointer cursor
									// and full opacity — it looks pressable while
									// it is not. Same classes SyncGateButton uses
									// for the same reason.
									className={cn(
										"shrink-0 gap-1.5",
										analysing.has(f.id) &&
											"cursor-not-allowed opacity-60",
									)}
									// aria-disabled, not `disabled`: setting the
									// native attribute on the element that was
									// just clicked drops focus to <body> in
									// Chromium and Firefox, stranding a keyboard
									// user at the moment they acted. The handler
									// guards the repeat click instead.
									aria-disabled={analysing.has(f.id)}
									aria-busy={analysing.has(f.id)}
									onClick={() => {
										if (analysing.has(f.id)) {
											return;
										}
										setAnalysing((prev) =>
											new Set(prev).add(f.id),
										);
										analyseMutation.mutate({
											projectId,
											findingId: f.id,
										});
									}}
								>
									{analysing.has(f.id) ? (
										<Loader2Icon
											className="size-3.5 motion-safe:animate-spin"
											aria-hidden="true"
										/>
									) : (
										<SparklesIcon
											className="size-3.5"
											aria-hidden="true"
										/>
									)}
									{analysing.has(f.id)
										? t("analysis.running")
										: f.analysedAt
											? t("analysis.reanalyse")
											: t("analysis.analyse")}
								</Button>
								<Button
									type="button"
									size="sm"
									variant="outline"
									className="shrink-0 gap-1.5"
									disabled={promoteMutation.isPending}
									onClick={() =>
										promoteMutation.mutate({
											projectId,
											findingId: f.id,
										})
									}
								>
									<BugIcon
										className="size-3.5"
										aria-hidden="true"
									/>
									{t("promote")}
								</Button>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									className="shrink-0"
									disabled={dismissMutation.isPending}
									onClick={() =>
										dismissMutation.mutate({
											projectId,
											findingId: f.id,
										})
									}
								>
									{t("dismiss")}
								</Button>
							</li>
						))}
					</ul>

					{/* Appears only with a selection, and states which row survives.
					    A merge that does not say what it keeps is one nobody will
					    risk pressing. */}
					{selected.size >= 2 && (
						<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2">
							<p className="text-muted-foreground text-xs">
								{t("mergeHint", { count: selected.size })}
							</p>
							<div className="flex items-center gap-2">
								<Button
									type="button"
									size="sm"
									variant="ghost"
									onClick={() => setSelected(new Set())}
								>
									{t("mergeCancel")}
								</Button>
								<Button
									type="button"
									size="sm"
									disabled={mergeMutation.isPending}
									onClick={() => {
										// The oldest row survives. Its firstSeenAt is
										// the true start of the fault, and keeping the
										// newest would make a long-standing problem
										// look like it appeared today.
										const chosen = shown
											.filter((f) => selected.has(f.id))
											.sort(
												(a, b) =>
													new Date(
														a.firstSeenAt,
													).getTime() -
													new Date(
														b.firstSeenAt,
													).getTime(),
											);
										const [primary, ...duplicates] = chosen;
										if (
											!primary ||
											duplicates.length === 0
										) {
											return;
										}
										mergeMutation.mutate({
											projectId,
											findingId: primary.id,
											duplicateIds: duplicates.map(
												(d) => d.id,
											),
										});
									}}
								>
									{t("mergeAction")}
								</Button>
							</div>
						</div>
					)}

					{findings.length > PREVIEW && !showAll && (
						<div className="flex justify-end">
							<Button
								type="button"
								variant="link"
								size="sm"
								onClick={() => setShowAll(true)}
								className="h-auto p-0 text-xs"
							>
								{t("showAll", { total: findings.length })}
							</Button>
						</div>
					)}
				</>
			)}
		</section>
	);
}
