"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import { Loader2Icon, MessageSquareIcon, SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

/**
 * Why a finding was dismissed.
 *
 * Only INCORRECT is a false positive. The other three are reasons a CORRECT
 * finding was not acted on, and folding them together is what left the feature
 * reporting a dismissal rate under the name of its false-positive target.
 */
const DISMISSAL_REASONS = [
	"INCORRECT",
	"WONT_FIX",
	"OUT_OF_SCOPE",
	"ALREADY_COVERED",
] as const;

type DismissalReason = (typeof DISMISSAL_REASONS)[number];

/** One stored finding, as the detail query returns it. */
type Finding = {
	id: string;
	lens: string;
	severity: string;
	title: string;
	detail: string;
	/** Null on findings stored before the lenses started supplying one. */
	recommendation: string | null;
	filePath: string | null;
	line: number | null;
	criterionRef: string | null;
	status: string;
	model: string | null;
};

/**
 * The QA lens's findings for one pull request (the QA review lens).
 *
 * Three states, and telling them apart is the point:
 *   - never reviewed → an invitation, and no claim about coverage;
 *   - reviewed, nothing found → said explicitly, WITH when, because an empty
 *     list that looks like "not run yet" is reassurance nobody earned;
 *   - reviewed, findings → the list, worst first.
 *
 * Findings are advisory. Accept and Dismiss record a judgement and file nothing.
 * Dismissing asks for a reason, and only "not correct" counts towards the lens's
 * false-positive rate — the other reasons record that a CORRECT finding was not
 * acted on. They are a stored state rather than a hide so that rate exists at
 * all.
 */
export function PrReviewFindings({
	projectId,
	reviewId,
	findings,
	analysedAt,
	analysisModel,
	architectureAnalysedAt,
	hasDiff,
	canEdit,
}: {
	projectId: string;
	reviewId: string;
	findings: Finding[];
	/** Null means the lens has never run — not "ran and found nothing". */
	analysedAt: Date | string | null;
	analysisModel: string | null;
	/** Same rule for the architecture lens, which has no model to attribute. */
	architectureAnalysedAt: Date | string | null;
	hasDiff: boolean;
	canEdit: boolean;
}) {
	const t = useTranslations("projects.testCases.prReview.review");
	const queryClient = useQueryClient();

	const invalidate = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.pullRequestReviews.get.queryKey({
				input: { projectId, id: reviewId },
			}),
		});

	const analyse = useMutation({
		...orpc.projects.pullRequestReviews.analyseQa.mutationOptions(),
		onSuccess: (result) => {
			if (!result.configured) {
				toast.error(t("noProvider"));
				return;
			}
			if (result.dropped > 0) {
				// Surfaced rather than logged only: it is the reader's signal that the
				// lens produced claims about files it never saw.
				toast.warning(t("dropped", { count: result.dropped }));
			}
			invalidate();
		},
		onError: (error) => toast.error(error.message),
	});

	const judge = useMutation({
		...orpc.projects.pullRequestReviews.judgeFinding.mutationOptions(),
		onSuccess: (finding) => {
			toast.success(
				t("judged", {
					status: t(finding.status.toLowerCase()) as string,
				}),
			);
			invalidate();
		},
		onError: (error) => toast.error(error.message),
	});

	const architecture = useMutation({
		...orpc.projects.pullRequestReviews.analyseArchitecture.mutationOptions(),
		onSuccess: (result) => {
			if (!result.indexed) {
				toast.error(t("notIndexed"));
				return;
			}
			if (result.cyclesInRepo > result.cyclesTouched) {
				// The ratio is the useful part: many cycles in the repo and few here
				// says the change is fine and the repository is not.
				toast.info(
					t("cyclesContext", {
						touched: result.cyclesTouched,
						total: result.cyclesInRepo,
					}),
				);
			}
			invalidate();
		},
		onError: (error) => toast.error(error.message),
	});

	const postComment = useMutation({
		...orpc.projects.pullRequestReviews.postComment.mutationOptions(),
		onSuccess: (result) =>
			toast.success(
				result.updated ? t("commentUpdated") : t("commentPosted"),
			),
		onError: (error) => toast.error(error.message),
	});

	const qaFindings = findings.filter((f) => f.lens === "QA");
	const archFindings = findings.filter((f) => f.lens === "ARCHITECTURE");
	const reviewed = analysedAt != null;
	const archReviewed = architectureAnalysedAt != null;

	return (
		<>
			<LensSection
				heading={t("heading")}
				action={
					canEdit ? (
						<LensButton
							pending={analyse.isPending}
							label={t("runAction")}
							pendingLabel={t("running")}
							disabled={!hasDiff}
							onClick={() =>
								analyse.mutate({ projectId, id: reviewId })
							}
						/>
					) : null
				}
				empty={
					!hasDiff
						? t("noDiff")
						: !reviewed
							? t("notAnalysed")
							: qaFindings.length === 0
								? t("noFindings", {
										when: formatDistanceToNow(
											new Date(analysedAt),
											{
												addSuffix: true,
											},
										),
									})
								: null
				}
				findings={qaFindings}
				canEdit={canEdit}
				onJudge={(id, status, dismissalReason) =>
					judge.mutate({ projectId, id, status, dismissalReason })
				}
				footer={
					// Provenance beside a guess: these are model observations sitting
					// next to a real diff, and a reader deserves to know whose.
					analysisModel && qaFindings.length > 0
						? t("model", { model: analysisModel })
						: null
				}
				severityLabel={(s) => t(`severity.${s}` as never)}
				statusLabel={(s) => t(s.toLowerCase() as never)}
				acceptLabel={t("accept")}
				dismissLabel={t("dismiss")}
				dismissalReasonLabel={(reason) =>
					t(`dismissalReason.${reason}` as never)
				}
				recommendationLabel={t("recommendation")}
				reopenLabel={t("reopen")}
			/>

			<LensSection
				heading={t("architectureHeading")}
				action={
					canEdit ? (
						<LensButton
							pending={architecture.isPending}
							label={t("runArchitecture")}
							pendingLabel={t("running")}
							disabled={!hasDiff}
							onClick={() =>
								architecture.mutate({ projectId, id: reviewId })
							}
						/>
					) : null
				}
				empty={
					!hasDiff
						? t("noDiff")
						: !archReviewed
							? t("architectureNotAnalysed")
							: archFindings.length === 0
								? t("architectureClean", {
										when: formatDistanceToNow(
											new Date(architectureAnalysedAt),
											{ addSuffix: true },
										),
									})
								: null
				}
				findings={archFindings}
				canEdit={canEdit}
				onJudge={(id, status, dismissalReason) =>
					judge.mutate({ projectId, id, status, dismissalReason })
				}
				// No model footer: this lens computes from the import graph, so there
				// is no provenance to state beyond "Fabric worked it out".
				footer={null}
				severityLabel={(s) => t(`severity.${s}` as never)}
				statusLabel={(s) => t(s.toLowerCase() as never)}
				acceptLabel={t("accept")}
				dismissLabel={t("dismiss")}
				dismissalReasonLabel={(reason) =>
					t(`dismissalReason.${reason}` as never)
				}
				recommendationLabel={t("recommendation")}
				reopenLabel={t("reopen")}
			/>

			{/* One button for the whole review rather than one per lens: the comment
			    it writes carries both, and a reader on the pull request wants one
			    comment, not two racing to edit each other. Only offered once a lens
			    has actually run — posting "no open findings" from a review nobody
			    reviewed is the reassurance-nobody-earned failure in someone else's
			    repository. */}
			{canEdit && (reviewed || archReviewed) ? (
				<div className="flex flex-wrap items-center gap-3 px-1">
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={postComment.isPending}
						onClick={() =>
							postComment.mutate({
								projectId,
								id: reviewId,
								reviewUrl: window.location.href,
							})
						}
					>
						{postComment.isPending ? (
							<Loader2Icon
								className="mr-2 size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						) : (
							<MessageSquareIcon
								className="mr-2 size-4"
								aria-hidden="true"
							/>
						)}
						{t("postComment")}
					</Button>
					<p className="text-muted-foreground text-xs">
						{t("postCommentHint")}
					</p>
				</div>
			) : null}
		</>
	);
}

/** The run button, identical for both lenses apart from its copy. */
function LensButton({
	pending,
	label,
	pendingLabel,
	disabled,
	onClick,
}: {
	pending: boolean;
	label: string;
	pendingLabel: string;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			disabled={disabled || pending}
			onClick={onClick}
		>
			{pending ? (
				<Loader2Icon
					className="mr-2 size-4 motion-safe:animate-spin"
					aria-hidden="true"
				/>
			) : (
				<SparklesIcon className="mr-2 size-4" aria-hidden="true" />
			)}
			{pending ? pendingLabel : label}
		</Button>
	);
}

/**
 * One lens's block: heading, run control, and either its findings or the single
 * sentence explaining why there are none.
 *
 * Shared by both lenses rather than duplicated, so the three-state distinction
 * (not run / ran-and-clean / findings) cannot drift between them — which is
 * exactly what would happen to a copy-pasted second copy first.
 */
function LensSection({
	heading,
	action,
	empty,
	findings,
	canEdit,
	onJudge,
	footer,
	severityLabel,
	statusLabel,
	acceptLabel,
	dismissLabel,
	dismissalReasonLabel,
	recommendationLabel,
	reopenLabel,
}: {
	heading: string;
	action: React.ReactNode;
	/** The sentence to show INSTEAD of a list, or null when there are findings. */
	empty: string | null;
	findings: Finding[];
	canEdit: boolean;
	onJudge: (
		id: string,
		status: "ACCEPTED" | "DISMISSED" | "OPEN",
		dismissalReason?: DismissalReason,
	) => void;
	footer: string | null;
	severityLabel: (severity: string) => string;
	statusLabel: (status: string) => string;
	acceptLabel: string;
	dismissLabel: string;
	dismissalReasonLabel: (reason: DismissalReason) => string;
	recommendationLabel: string;
	reopenLabel: string;
}) {
	return (
		<section className="border-b px-5 py-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="font-medium text-sm">{heading}</h3>
				{action}
			</div>

			{empty !== null ? (
				<p className="mt-2 text-muted-foreground text-sm">{empty}</p>
			) : (
				<>
					<ul className="mt-3 space-y-2">
						{findings.map((finding) => (
							<li
								key={finding.id}
								className={cn(
									"rounded-lg border p-3",
									finding.status === "DISMISSED" &&
										"opacity-60",
								)}
							>
								<div className="flex flex-wrap items-start gap-2">
									<span
										className={cn(
											"shrink-0 rounded-full border px-2 py-0.5 font-medium text-xs",
											finding.severity === "HIGH"
												? "border-destructive/40 bg-destructive/10 text-destructive"
												: finding.severity === "LOW"
													? "border-border bg-muted text-muted-foreground"
													: "border-highlight/40 bg-highlight/10 text-highlight",
										)}
									>
										{severityLabel(finding.severity)}
									</span>
									<p className="min-w-0 flex-1 font-medium text-sm">
										{finding.title}
									</p>
									{finding.status !== "OPEN" ? (
										<span className="shrink-0 text-muted-foreground text-xs">
											{statusLabel(finding.status)}
										</span>
									) : null}
								</div>
								{/* whitespace-pre-line: the architecture lens composes its
								    detail as paragraphs, and collapsing them turns a cycle
								    path into an unreadable run-on. */}
								<p className="mt-1.5 whitespace-pre-line text-muted-foreground text-sm leading-relaxed">
									{finding.detail}
								</p>
								{/* The fix, set apart from the diagnosis above it. A
								    reader triaging a list acts on this line and skims
								    the rest, so it gets its own label rather than a
								    final paragraph they have to find. Absent only on
								    findings stored before the column existed. */}
								{finding.recommendation ? (
									<p className="mt-2 border-primary/30 border-l-2 pl-3 text-sm leading-relaxed">
										<span className="font-medium">
											{recommendationLabel}
										</span>{" "}
										<span className="text-muted-foreground">
											{finding.recommendation}
										</span>
									</p>
								) : null}
								{finding.filePath || finding.criterionRef ? (
									<p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
										{finding.filePath ? (
											// path:line — greppable, and the shape a reader
											// expects from a compiler. The line is present only
											// when it was verified against the diff's hunks, so
											// its absence means "unverified", never "line 0".
											<span className="font-mono">
												{finding.line != null
													? `${finding.filePath}:${finding.line}`
													: finding.filePath}
											</span>
										) : null}
										{finding.criterionRef ? (
											<span>{finding.criterionRef}</span>
										) : null}
									</p>
								) : null}
								{canEdit ? (
									<div className="mt-2 flex gap-2">
										{finding.status === "OPEN" ? (
											<>
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() =>
														onJudge(
															finding.id,
															"ACCEPTED",
														)
													}
												>
													{acceptLabel}
												</Button>
												{/* Dismissing asks WHY, because the
												    feature is measured on a
												    false-positive rate and only
												    "not correct" is one. The other
												    three are reasons a CORRECT
												    finding was not acted on, and
												    counting them as the lens being
												    wrong is what made the published
												    figure mean nothing. */}
												<DropdownMenu>
													<DropdownMenuTrigger
														asChild
													>
														<Button
															type="button"
															variant="ghost"
															size="sm"
														>
															{dismissLabel}
														</Button>
													</DropdownMenuTrigger>
													<DropdownMenuContent align="start">
														{DISMISSAL_REASONS.map(
															(reason) => (
																<DropdownMenuItem
																	key={reason}
																	onSelect={() =>
																		onJudge(
																			finding.id,
																			"DISMISSED",
																			reason,
																		)
																	}
																>
																	{dismissalReasonLabel(
																		reason,
																	)}
																</DropdownMenuItem>
															),
														)}
													</DropdownMenuContent>
												</DropdownMenu>
											</>
										) : (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() =>
													onJudge(finding.id, "OPEN")
												}
											>
												{reopenLabel}
											</Button>
										)}
									</div>
								) : null}
							</li>
						))}
					</ul>
					{footer ? (
						<p className="mt-2 text-muted-foreground text-xs">
							{footer}
						</p>
					) : null}
				</>
			)}
		</section>
	);
}
