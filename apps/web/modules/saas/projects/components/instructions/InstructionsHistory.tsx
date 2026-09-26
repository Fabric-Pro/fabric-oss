"use client";

import type { InstructionRejection } from "@repo/database";
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
import { InstructionsCompareDialog } from "./InstructionsCompareDialog";

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
 * The deferred-scan states (Fizzy #2737) in which History may not publish a
 * version that went out before its secret scan: the server refuses these
 * with `deferred_scan_unresolved`, so the row explains instead of offering a
 * button that can only fail. Rolling back AWAY from such a version is a
 * different row's button, and is unaffected.
 */
const SCAN_UNRESOLVED_STATUSES = new Set([
	"PENDING",
	"ISSUES_FOUND",
	"INCOMPLETE",
]);

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
	onChanged: () => void;
}) {
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
	const publishAllowed = canPublish ?? canMutate;

	const publish = useMutation(
		orpc.projects.instructions.publish.mutationOptions({
			onSuccess: () => onChanged(),
			onError: (error) => toast.error(error.message),
		}),
	);
	const remove = useMutation(
		orpc.projects.instructions.delete.mutationOptions({
			onSuccess: () => onChanged(),
			onError: (error) => toast.error(error.message),
		}),
	);
	const download = useMutation(
		orpc.projects.instructions.createDownloadUrl.mutationOptions({
			onSuccess: (data) => window.open(data.url, "_blank", "noopener"),
			onError: (error) => toast.error(error.message),
		}),
	);

	function statusBadge(snapshot: HistorySnapshot, isPublished: boolean) {
		if (isPublished) {
			return { label: t("publishedPill"), variant: "success" as const };
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
						<DialogTitle>{t("title")}</DialogTitle>
						<DialogDescription>
							{t("description")}
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
							// Everything else that decides the publish button,
							// so the scan's own refusal is said only where the
							// button would otherwise have been offered.
							const publishable =
								s.status === "READY" &&
								!isPublished &&
								!awaitingProposalDecision &&
								!pullRequestSuggestion &&
								publishAllowed &&
								(!repositoryBacked ||
									s.source === "REPOSITORY") &&
								!publishedUnknown;
							const scanBlocksPublish =
								SCAN_UNRESOLVED_STATUSES.has(
									s.deferredScanStatus ?? "",
								);
							// ISSUES_FOUND's findings, and an INCOMPLETE
							// scan's when it found something before a file
							// defeated its last attempt.
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
									<div className="flex items-center justify-between gap-3">
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
										<div className="flex shrink-0 gap-2">
											{publishable &&
											!scanBlocksPublish ? (
												<Button
													size="sm"
													variant="outline"
													disabled={publish.isPending}
													onClick={() => {
														if (
															window.confirm(
																t(
																	isRollback(
																		s.version,
																		publishedVersion,
																	)
																		? "rollbackConfirm"
																		: "publishConfirm",
																	{
																		version:
																			s.version,
																	},
																),
															)
														) {
															publish.mutate({
																projectId,
																snapshotId:
																	s.id,
															});
														}
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
											{/* Not while its scan is still running: the
											    scan reads this version's rows, and
											    deleting them mid-scan only turns a
											    verdict into "could not finish". */}
											{!isPublished &&
											!awaitingProposalDecision &&
											canMutate &&
											DELETABLE_STATUSES.has(s.status) &&
											s.deferredScanStatus !==
												"PENDING" ? (
												<Button
													size="sm"
													variant="ghost"
													className="text-destructive"
													disabled={remove.isPending}
													onClick={() => {
														if (
															window.confirm(
																t(
																	"deleteConfirm",
																	{
																		version:
																			s.version,
																	},
																),
															)
														) {
															remove.mutate({
																projectId,
																snapshotId:
																	s.id,
															});
														}
													}}
												>
													{t("deleteAction")}
												</Button>
											) : null}
										</div>
									</div>
									{publishable && scanBlocksPublish ? (
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
										<p className="text-muted-foreground text-xs">
											{t("scanIncompleteFindingsNote")}
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
		</>
	);
}
