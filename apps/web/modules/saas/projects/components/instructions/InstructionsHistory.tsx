"use client";

import type { InstructionRejection } from "@repo/database";
import { useDiscardUpload } from "@saas/projects/hooks/use-discard-upload";
import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import { publishedChanged } from "@saas/projects/lib/instructions-action-error";
import { isStalledUpload } from "@saas/projects/lib/instructions-discardable-upload";
import { countPendingPublishes } from "@saas/projects/lib/instructions-pending-publishes";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { SCAN_FAILED_REASON } from "./InstructionFindingsTable";
import { InstructionsCompareDialog } from "./InstructionsCompareDialog";
import { PublishFlaggedVersionDialog } from "./PublishFlaggedVersionDialog";

const RECEIVING_STATUSES = new Set(["RECEIVING", "VALIDATING"]);

/**
 * Delete is offered only for a snapshot whose workflow has finished.
 *
 * Deleting a RECEIVING/VALIDATING row mid-run removes the row the next
 * activity reads, so `loadVerifiedSnapshot`
 * (`packages/temporal/src/activities/project-instructions.ts`) finds nothing
 * and raises a non-retryable `INSTRUCTION_SNAPSHOT_TENANT_MISMATCH` — a
 * tenancy-shaped failure for what was really a self-inflicted, avoidable
 * click. The published snapshot is excluded separately: the server refuses
 * that one with its own CONFLICT.
 */
const DELETABLE_STATUSES = new Set(["READY", "REJECTED", "FAILED"]);

/**
 * The scan state (Fizzy #2737) in which History's ordinary publish is
 * refused UNCONDITIONALLY — no acknowledgement skips it (Fizzy #2760 review:
 * the query reads this decision under the project lock only, deliberately
 * not the snapshot's, because also locking the snapshot row would deadlock
 * against the scan's own outcome write; a PENDING target is what keeps that
 * read safe, since waiting out the rest of a short-lived scan is the answer
 * either way). The row offers no publish/rollback button at all, and
 * explains why instead.
 */
const SCAN_PENDING_STATUS = "PENDING";

/**
 * The scan verdicts (Fizzy #2737) that terminate with the version FLAGGED —
 * found possible secrets, or could not finish checking every file. History's
 * ordinary publish of such a row is refused with `deferred_scan_unresolved`
 * unless the caller acknowledges publishing it anyway; the row's button
 * opens `PublishFlaggedVersionDialog` instead of the plain confirmation
 * used everywhere else (Fizzy #2760). Neither verdict is ever revisited by a
 * later scan, so the acknowledgement is always answering the version's real,
 * final state. Rolling back AWAY from such a version is a different row's
 * button, and is unaffected.
 */
const SCAN_FLAGGED_STATUSES = new Set(["ISSUES_FOUND", "INCOMPLETE"]);

// `capRejections` (packages/temporal/src/activities/project-instructions.ts)
// caps a gate's rejection list at 100 and appends this sentinel row instead
// of an unbounded array — recognizable by `reason`, never a real file.
const TRUNCATED_REASON = "truncated";

/**
 * Whether publishing this version would take the project BACK to an earlier
 * one, which is the only thing that distinguishes the button's two labels.
 *
 * Strictly lower, and only against a version that is actually published:
 * nothing published means no direction to go back in, and the equal case is
 * the published row itself, which offers no publish button at all.
 */
function isRollback(version: number, publishedVersion: number | null) {
	return publishedVersion !== null && version < publishedVersion;
}

export type HistorySnapshot = {
	id: string;
	version: number;
	status: string;
	source: string;
	fileCount: number;
	createdAt: string | Date;
	rejection?: InstructionRejection[] | null;
	user?: { name: string | null } | null;
	/**
	 * The version this one was edited FROM, set when it came from editing,
	 * adding or deleting a file rather than from a folder upload. That is the
	 * question someone reading a history of near-identical versions is
	 * actually asking.
	 *
	 * The stored VERSION NUMBER rather than a lookup through
	 * `baseSnapshotId`: that column is `SetNull` and the base may have been
	 * deleted or pruned out of the kept window, which used to drop the line
	 * from exactly the rows whose provenance is hardest to guess.
	 */
	baseVersion?: number | null;
	/**
	 * Pending and rejected proposals must go through proposal review, not
	 * History. MERGED and CLOSED belong to a suggestion that became a pull
	 * request (Fizzy #2563): it stays in its proposer's History and is never
	 * published from here.
	 */
	proposalStatus?:
		| "PENDING"
		| "APPROVED"
		| "REJECTED"
		| "MERGED"
		| "CLOSED"
		| null;
	/**
	 * Publish first, scan afterwards (Fizzy #2737): the member's opt-in, the
	 * scan's state (null for every ordinary version), and its findings in the
	 * same shape as `rejection`.
	 */
	publishBeforeScan?: boolean;
	deferredScanStatus?:
		| "PENDING"
		| "PASSED"
		| "ISSUES_FOUND"
		| "INCOMPLETE"
		| null;
	deferredScanFindings?: InstructionRejection[] | null;
	/** Whether this version meant to publish itself when its checks passed. */
	publishOnReady?: boolean;
};

/**
 * Every upload kept for the project, newest first. Publish/Download act on
 * the same `publish`/`createDownloadUrl` procedures the header buttons use;
 * a CONFLICT from either (for delete, this snapshot being the published one)
 * surfaces via the server's own message rather than a generic failure string.
 *
 * Publishing an OLDER version is a rollback, not a conflict: the server used
 * to refuse it with "a newer version is already published" — a race guard
 * written against automatic publish-on-ready, catching the one act it was
 * never meant to catch. The button says so, because "Publish this version" on
 * a row below the published one hides what it does; the rows above it stay in
 * History and can be published again.
 *
 * `publishedVersion` comes from the parent's published row rather than being
 * looked up in `snapshots` by `publishedId`. A lookup has a failure mode with
 * no honest answer: when the pointer query has errored there is no published
 * id to match, and "not found in the list" then reads as "nothing is
 * published" — every row would be labelled a forward publish, including the
 * ones that are rollbacks. `publishedUnknown` says that state out loud and
 * withholds the buttons instead of guessing the direction.
 */
export function InstructionsHistory({
	projectId,
	open,
	onOpenChange,
	snapshots,
	publishedId,
	publishedVersion,
	publishedUnknown = false,
	canMutate = true,
	canPublish,
	repositoryBacked = false,
	syncRuns,
	syncRunPendingPublish = false,
	onChanged,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (o: boolean) => void;
	snapshots: HistorySnapshot[];
	publishedId: string | null;
	/** The published row's version, or null when nothing is published. */
	publishedVersion: number | null;
	/** True when the published pointer could not be read at all. */
	publishedUnknown?: boolean;
	/** Direct History mutations are unavailable for readers and repository-backed projects. */
	canMutate?: boolean;
	/**
	 * Publish and roll back; defaults to `canMutate`. On a repository-backed
	 * project the tab passes the reviewer permission instead: publishing
	 * needs INSTRUCTION_UPDATE (`publish-snapshot.ts:35`), and choosing which
	 * synced version is live is a review decision, not an edit (plan
	 * Decision 28). Delete stays behind `canMutate`.
	 */
	canPublish?: boolean;
	/**
	 * The repository is the project's source of truth (spec §4). Only a
	 * version it produced may then be published: the server refuses an
	 * uploaded one, so its row offers no Publish button.
	 */
	repositoryBacked?: boolean;
	/** The repository's "Sync runs" list, when the project syncs (§7.3). */
	syncRuns?: ReactNode;
	/**
	 * A repository sync run is open and has not staged its snapshot yet, so no
	 * row in `snapshots` stands for the publish it will make when it finishes.
	 */
	syncRunPendingPublish?: boolean;
	onChanged: () => void;
}) {
	const actionError = useInstructionActionError();
	const { confirm } = useConfirmationAlert();
	const t = useTranslations("projects.codingInstructions.history");
	// "See why" shows the same rejection rows as the banner, so it reads the
	// banner's own label maps rather than a second copy: a new scan rule then
	// needs one translation entry, not two that can drift apart.
	const tReason = useTranslations(
		"projects.codingInstructions.rejectedBanner",
	);
	const secretLabels = tReason.raw("secretLabels") as Record<string, string>;
	const reasonLabels = tReason.raw("reasonLabels") as Record<string, string>;
	const [expandedId, setExpandedId] = useState<string | null>(null);
	// The version whose comparison against the published one is open, if any.
	// Held here rather than inside each row so only ONE compare dialog is ever
	// mounted, and so closing it cannot leave a stale query mounted behind the
	// row it was opened from.
	const [compareId, setCompareId] = useState<string | null>(null);
	// The row whose flagged-scan publish/rollback is being confirmed, if any
	// (Fizzy #2760). Held here, like `compareId`, so only ONE such dialog is
	// ever mounted and its ticks are discarded — never carried to the next
	// row — simply by unmounting when it closes.
	const [flaggedPublish, setFlaggedPublish] = useState<{
		id: string;
		version: number;
		rollback: boolean;
		scanStatus: "ISSUES_FOUND" | "INCOMPLETE";
	} | null>(null);
	// Fabric's copy of a repository project follows its branch, so there is no
	// version to publish or roll back to: the pointer is never moved by hand.
	// (A confirmed repository project sees Commits instead of this list; this
	// is what the list offers while that is not yet known.)
	const publishAllowed = !repositoryBacked && (canPublish ?? canMutate);
	// Checks still running that will publish themselves when they finish: a
	// rollback made now is replaced by whichever of them finishes last.
	const pendingPublishes = countPendingPublishes({
		snapshots,
		syncRunPending: syncRunPendingPublish,
		now: Date.now(),
	});

	// Says which published version this page is showing, so the server can
	// refuse a choice made against a page that has since gone stale. Left out
	// when the pointer could not be read at all: those buttons are withheld.
	const publishInput = (snapshotId: string) => ({
		projectId,
		snapshotId,
		...(publishedUnknown
			? {}
			: { expectedPublishedSnapshotId: publishedId }),
	});

	/** What the confirmation says before a version is published or rolled back to. */
	function publishConfirmation(version: number, rollback: boolean) {
		if (!rollback) {
			return {
				title: t("publishConfirm", { version }),
				confirmLabel: t("publishConfirmAction"),
			};
		}
		return {
			title: t("rollbackConfirm", { version }),
			message:
				pendingPublishes > 0
					? `${t("rollbackConfirmBody")} ${t("rollbackPendingNote", { count: pendingPublishes })}`
					: t("rollbackConfirmBody"),
			confirmLabel: t("rollbackConfirmAction"),
		};
	}

	const publish = useMutation(
		orpc.projects.instructions.publish.mutationOptions({
			onSuccess: () => {
				onChanged();
				setFlaggedPublish(null);
			},
			onError: (error) => {
				const moved = publishedChanged(error);
				if (moved === null) {
					toast.error(actionError(error));
					return;
				}
				// Nothing was written. Reload what is published now and tell
				// the person which version it is, so the choice is made again
				// against what they can see.
				toast.error(
					moved.publishedVersion === null
						? t("publishedChangedUnknown")
						: t("publishedChanged", {
								version: moved.publishedVersion,
							}),
				);
				setFlaggedPublish(null);
				onChanged();
			},
		}),
	);
	const remove = useMutation(
		orpc.projects.instructions.delete.mutationOptions({
			onSuccess: () => onChanged(),
			onError: (error) => {
				toast.error(actionError(error));
				onChanged();
			},
		}),
	);
	// An upload that never finished is discarded, not deleted as a version:
	// it was never one, and what the confirmation says reflects that.
	const discardUpload = useDiscardUpload({ projectId, onChanged });
	const download = useMutation(
		orpc.projects.instructions.createDownloadUrl.mutationOptions({
			onSuccess: (data) => window.open(data.url, "_blank", "noopener"),
			onError: (error) => toast.error(actionError(error)),
		}),
	);

	function statusBadge(snapshot: HistorySnapshot, isPublished: boolean) {
		if (isPublished) {
			return { label: t("publishedPill"), variant: "success" as const };
		}
		// An upload that stayed RECEIVING for an hour is not being checked: the
		// browser never finished it, so no run was ever started for it.
		if (isStalledUpload(snapshot)) {
			return { label: t("stalledPill"), variant: "outline" as const };
		}
		if (RECEIVING_STATUSES.has(snapshot.status)) {
			return { label: t("checkingPill"), variant: "outline" as const };
		}
		if (snapshot.status === "REJECTED") {
			return {
				label: t("rejectedPill"),
				variant: "destructive" as const,
			};
		}
		if (snapshot.status === "FAILED") {
			return { label: t("failedPill"), variant: "destructive" as const };
		}
		return { label: t("readyPill"), variant: "secondary" as const };
	}

	/**
	 * A publish-first version's scan outcome (Fizzy #2737), shown next to its
	 * status badge; null for every ordinary version.
	 */
	function scanBadge(snapshot: HistorySnapshot) {
		switch (snapshot.deferredScanStatus ?? null) {
			case "PENDING":
				return {
					label: t("scanPendingPill"),
					variant: "outline" as const,
				};
			case "PASSED":
				return {
					label: t("scanPassedPill"),
					variant: "secondary" as const,
				};
			case "ISSUES_FOUND":
				return {
					label: t("scanIssuesPill"),
					variant: "destructive" as const,
				};
			case "INCOMPLETE":
				return {
					label: t("scanIncompletePill"),
					variant: "outline" as const,
				};
			default:
				return null;
		}
	}

	/** One line per rejection or finding, as the "See why" list has always shown them. */
	function reasonRows(rows: InstructionRejection[]) {
		const shown = rows.filter((r) => r.reason !== TRUNCATED_REASON);
		const truncatedRow = rows.find((r) => r.reason === TRUNCATED_REASON);
		return (
			<div className="flex flex-col gap-1 rounded-md border border-border bg-muted/30 p-2 text-xs">
				{shown.map((r, i) => (
					<div
						key={`${r.path}-${i}`}
						className="flex items-center justify-between gap-2"
					>
						<code>{r.path}</code>
						<span className="text-muted-foreground">
							{r.reason === "secret"
								? r.detail?.startsWith("filename:")
									? tReason("credentialFile")
									: (secretLabels[r.detail ?? ""] ?? r.detail)
								: (reasonLabels[r.reason] ?? r.reason)}
						</span>
					</div>
				))}
				{truncatedRow ? (
					<p className="text-muted-foreground">
						{tReason("truncatedSummary", {
							detail: truncatedRow.detail ?? "",
						})}
					</p>
				) : null}
			</div>
		);
	}

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						{/* A repository project's versions are the commits Fabric
						    took from the branch, not uploads, so the dialog says so. */}
						<DialogTitle>
							{t(repositoryBacked ? "titleRepository" : "title")}
						</DialogTitle>
						<DialogDescription>
							{t(
								repositoryBacked
									? "descriptionRepository"
									: "description",
							)}
						</DialogDescription>
					</DialogHeader>
					{publishedUnknown ? (
						// Said plainly rather than worked around: without the
						// pointer, no row can be labelled a publish or a rollback
						// honestly, so the dialog stays readable (versions,
						// statuses, downloads, "See why") and only the two actions
						// that depend on the direction are withheld.
						<p className="text-destructive text-xs" role="alert">
							{t("publishedUnknown")}
						</p>
					) : null}
					<div className="flex max-h-[420px] flex-col gap-2 overflow-auto">
						{snapshots.map((s) => {
							const isPublished = s.id === publishedId;
							const awaitingProposalDecision =
								s.proposalStatus === "PENDING" ||
								s.proposalStatus === "REJECTED";
							// The server refuses to publish a pull-request
							// suggestion in any status (spec §2.5): it
							// reaches agents by merging and syncing.
							const pullRequestSuggestion =
								s.proposalStatus === "MERGED" ||
								s.proposalStatus === "CLOSED";
							const badge = statusBadge(s, isPublished);
							const scan = scanBadge(s);
							// Everything else that decides whether a
							// publish/rollback action could apply to this row
							// at all, before the scan's own state narrows it
							// further below.
							const eligibleToPublish =
								s.status === "READY" &&
								!isPublished &&
								!awaitingProposalDecision &&
								!pullRequestSuggestion &&
								publishAllowed &&
								(!repositoryBacked ||
									s.source === "REPOSITORY") &&
								!publishedUnknown;
							// A scan still PENDING refuses unconditionally: no
							// button at all, explained instead.
							const scanPending =
								s.deferredScanStatus === SCAN_PENDING_STATUS;
							const publishable =
								eligibleToPublish && !scanPending;
							// A scan that finished FLAGGED opens the
							// acknowledgement dialog instead of a plain
							// confirm (Fizzy #2760).
							const scanFlagged = SCAN_FLAGGED_STATUSES.has(
								s.deferredScanStatus ?? "",
							);
							// ISSUES_FOUND's findings, and an INCOMPLETE
							// scan's: the files that defeated its last
							// attempt, and anything it found in the rest.
							const findings =
								s.deferredScanStatus === "ISSUES_FOUND" ||
								s.deferredScanStatus === "INCOMPLETE"
									? (s.deferredScanFindings ?? [])
									: [];
							return (
								<div
									key={s.id}
									className="flex flex-col gap-2 rounded-lg border border-border p-3"
								>
									<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
										<div className="flex flex-col gap-0.5">
											<div className="flex items-center gap-2">
												<span className="font-medium text-sm">
													{t("versionLabel", {
														version: s.version,
													})}
												</span>
												<Badge variant={badge.variant}>
													{badge.label}
												</Badge>
												{s.publishBeforeScan && scan ? (
													<>
														<Badge variant="outline">
															{t(
																"publishedBeforeScanPill",
															)}
														</Badge>
														<Badge
															variant={
																scan.variant
															}
														>
															{scan.label}
														</Badge>
													</>
												) : null}
											</div>
											<p className="text-muted-foreground text-xs">
												{s.user?.name ??
													t("anonymousUser")}
												{" · "}
												{formatRelativeTime(
													s.createdAt,
												)}
												{" · "}
												{t("filesStored", {
													count: s.fileCount,
												})}
												{typeof s.baseVersion ===
												"number"
													? ` · ${t("editedFrom", {
															version:
																s.baseVersion,
														})}`
													: ""}
											</p>
										</div>
										<div className="flex flex-wrap gap-2 sm:justify-end">
											{publishable ? (
												<Button
													size="sm"
													variant="outline"
													disabled={publish.isPending}
													onClick={() => {
														// A flagged version's
														// button opens the
														// acknowledgement
														// dialog instead of a
														// plain confirm — the
														// server refuses this
														// publish without it
														// (Fizzy #2760).
														if (scanFlagged) {
															setFlaggedPublish({
																id: s.id,
																version:
																	s.version,
																rollback:
																	isRollback(
																		s.version,
																		publishedVersion,
																	),
																scanStatus:
																	s.deferredScanStatus as
																		| "ISSUES_FOUND"
																		| "INCOMPLETE",
															});
															return;
														}
														confirm({
															...publishConfirmation(
																s.version,
																isRollback(
																	s.version,
																	publishedVersion,
																),
															),
															destructive: true,
															onConfirm: () =>
																publish.mutate(
																	publishInput(
																		s.id,
																	),
																),
														});
													}}
												>
													{t(
														isRollback(
															s.version,
															publishedVersion,
														)
															? "rollbackAction"
															: "publishAction",
													)}
												</Button>
											) : null}
											{s.status === "READY" &&
											!awaitingProposalDecision ? (
												<Button
													size="sm"
													variant="outline"
													disabled={
														download.isPending
													}
													onClick={() =>
														download.mutate({
															projectId,
															snapshotId: s.id,
														})
													}
												>
													{t("downloadAction")}
												</Button>
											) : null}
											{/* Same gates as Download — a
										    version whose bytes cannot be
										    read cannot be diffed either —
										    plus something to compare
										    against: the published row has
										    no comparison to offer against
										    itself. */}
											{s.status === "READY" &&
											!awaitingProposalDecision &&
											publishedId !== null &&
											!isPublished ? (
												<Button
													size="sm"
													variant="outline"
													onClick={() =>
														setCompareId(s.id)
													}
												>
													{t("compareAction")}
												</Button>
											) : null}
											{s.status === "REJECTED" ? (
												<Button
													size="sm"
													variant="ghost"
													onClick={() =>
														setExpandedId(
															expandedId === s.id
																? null
																: s.id,
														)
													}
												>
													{t("seeWhyAction")}
												</Button>
											) : null}
											{findings.length > 0 ? (
												<Button
													size="sm"
													variant="ghost"
													onClick={() =>
														setExpandedId(
															expandedId === s.id
																? null
																: s.id,
														)
													}
												>
													{t("seeFindingsAction")}
												</Button>
											) : null}
											{isStalledUpload(s) &&
											canMutate &&
											!repositoryBacked ? (
												<Button
													size="sm"
													variant="ghost"
													className="text-destructive"
													disabled={
														discardUpload.pending
													}
													onClick={() =>
														discardUpload.discard(
															s.id,
														)
													}
												>
													{t("discardAction")}
												</Button>
											) : null}
											{/* Not while its scan is still running: the
											    scan reads this version's rows, and
											    deleting them mid-scan only turns a
											    verdict into "could not finish". */}
											{!isPublished &&
											!awaitingProposalDecision &&
											canMutate &&
											!repositoryBacked &&
											DELETABLE_STATUSES.has(s.status) &&
											s.deferredScanStatus !==
												"PENDING" ? (
												<Button
													size="sm"
													variant="ghost"
													className="text-destructive"
													disabled={remove.isPending}
													onClick={() =>
														confirm({
															title: t(
																"deleteConfirm",
																{
																	version:
																		s.version,
																},
															),
															message:
																t(
																	"deleteConfirmBody",
																),
															confirmLabel: t(
																"deleteConfirmAction",
															),
															destructive: true,
															onConfirm: () =>
																remove.mutate({
																	projectId,
																	snapshotId:
																		s.id,
																}),
														})
													}
												>
													{t("deleteAction")}
												</Button>
											) : null}
										</div>
									</div>
									{eligibleToPublish && scanPending ? (
										<p className="text-muted-foreground text-xs">
											{t("publishBlockedByScan")}
										</p>
									) : null}
									{expandedId === s.id && s.rejection
										? reasonRows(s.rejection)
										: null}
									{expandedId === s.id && findings.length > 0
										? reasonRows(findings)
										: null}
									{expandedId === s.id &&
									findings.length > 0 &&
									s.deferredScanStatus === "INCOMPLETE" ? (
										// A scan that names the files it could
										// not read says so of THOSE rows; a
										// list without them cannot say which,
										// so it warns about every unlisted file.
										<p className="text-muted-foreground text-xs">
											{findings.some(
												(r) =>
													r.reason ===
													SCAN_FAILED_REASON,
											)
												? t("scanUnreadableNote")
												: t(
														"scanIncompleteFindingsNote",
													)}
										</p>
									) : null}
								</div>
							);
						})}
					</div>
					{syncRuns}
				</DialogContent>
			</Dialog>
			{compareId !== null && publishedId !== null ? (
				<InstructionsCompareDialog
					projectId={projectId}
					// Published → selected, i.e. what changes if this version
					// is published, not what it was derived from.
					fromSnapshotId={publishedId}
					toSnapshotId={compareId}
					publishedSide="from"
					open
					onOpenChange={(next) => {
						if (!next) {
							setCompareId(null);
						}
					}}
				/>
			) : null}
			{flaggedPublish !== null ? (
				<PublishFlaggedVersionDialog
					open
					onOpenChange={(next) => {
						if (!next) {
							setFlaggedPublish(null);
						}
					}}
					version={flaggedPublish.version}
					rollback={flaggedPublish.rollback}
					scanStatus={flaggedPublish.scanStatus}
					pendingPublishes={pendingPublishes}
					pending={publish.isPending}
					onConfirm={() =>
						publish.mutate({
							...publishInput(flaggedPublish.id),
							publishBeforeScan: true,
						})
					}
				/>
			) : null}
		</>
	);
}
