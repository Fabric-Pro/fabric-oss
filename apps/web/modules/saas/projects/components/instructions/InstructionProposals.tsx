"use client";

import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import { diffLines } from "diff";
import {
	ChevronDownIcon,
	ChevronRightIcon,
	ExternalLinkIcon,
	RefreshCwIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	canRetryOpening,
	offersPullRequestRefresh,
	offersReconnect,
	type ProposalPullRequest,
	proposalListPollInterval,
	pullRequestCardLine,
	REFRESH_COOLDOWN_MS,
	refreshHoldSeconds,
	refreshRetryAfterSeconds,
} from "../../lib/instructions-proposal-pull-request";
import { repositoryProviderSupportsReconnect } from "../../lib/repo-reconnect-capability";
import { navigateToProjectSettingsTab } from "../settings-tab-navigation";
import { countDiffLines, toDiffRows } from "./lib/instruction-diff";

/**
 * A REPOSITORY proposal is MERGED or CLOSED once its pull request settles
 * (Fizzy #2563 spec §4.2); a FABRIC one is APPROVED or REJECTED by a reviewer.
 */
type ProposalStatus = "PENDING" | "APPROVED" | "REJECTED" | "MERGED" | "CLOSED";
type ValidationStatus =
	| "RECEIVING"
	| "VALIDATING"
	| "READY"
	| "REJECTED"
	| "FAILED";

type ProposalRow = {
	id: string;
	version: number;
	baseVersion: number | null;
	status: ValidationStatus;
	proposalStatus: ProposalStatus;
	createdAt: string | Date;
	readyAt: string | Date | null;
	proposer: { id: string; name: string | null };
	reviewer: { id: string; name: string | null } | null;
	reviewedAt: string | Date | null;
	isStale: boolean;
	canCancel: boolean;
	/** Where an accepted proposal goes (spec §12); absent reads as FABRIC. */
	destination?: "FABRIC" | "REPOSITORY" | null;
	note?: { title?: string; body?: string } | null;
	/** Null for a FABRIC proposal. */
	pullRequest?: ProposalPullRequest | null;
};

type ProposalChange = {
	path: string;
	op: "add" | "edit" | "delete";
	before: string | null;
	after: string | null;
	binary: boolean;
	beforeOmitted: OmissionReason;
	afterOmitted: OmissionReason;
	beforeSize: number | null;
	afterSize: number | null;
};

type OmissionReason = "BINARY" | "FILE_TOO_LARGE" | "RESPONSE_LIMIT" | null;

type ProposalDetail = ProposalRow & { changes: ProposalChange[] | null };
type ProposalFilePage = {
	path: string;
	side: "before" | "after";
	body: string;
	offset: number;
	nextOffset: number | null;
	truncated: boolean;
};

const VALIDATING = new Set<ValidationStatus>(["RECEIVING", "VALIDATING"]);
const PAGE_SIZE = 25;

/**
 * The refusals the pull-request procedures name in `data.reason` (phase C),
 * each with its own copy. Anything else falls back to the server's message.
 */
const PULL_REQUEST_REFUSALS = new Set([
	"REPOSITORY_PROPOSAL",
	"PULL_REQUEST_NOT_RETRYABLE",
	"PULL_REQUEST_CHANGED",
	"PULL_REQUEST_BUSY",
	"PULL_REQUEST_START_FAILED",
]);
/** A refused Refresh (TOO_MANY_REQUESTS): its copy names the server's wait. */
const REFRESH_WAIT_REFUSALS = new Set([
	"PULL_REQUEST_REFRESH_COOLDOWN",
	"PULL_REQUEST_PROVIDER_RATE_LIMITED",
]);

function errorCode(error: unknown): unknown {
	return error && typeof error === "object" && "code" in error
		? (error as { code?: unknown }).code
		: undefined;
}

function refusalReason(error: unknown): string | undefined {
	if (error && typeof error === "object" && "data" in error) {
		const reason = (error as { data?: { reason?: unknown } }).data?.reason;
		return typeof reason === "string" ? reason : undefined;
	}
	return undefined;
}

/**
 * A pull request's address as the provider reported it, only when it is an
 * https URL: the value came from a provider's response, and a link must never
 * run script.
 */
function safePullRequestUrl(url: string | null): string | null {
	return url && /^https:\/\//i.test(url) ? url : null;
}

const TONE_CLASS = {
	progress: "text-foreground",
	success: "text-success",
	neutral: "text-muted-foreground",
	error: "text-destructive",
} as const;

/**
 * What a REPOSITORY card says about its pull request, with the actions its
 * state allows (spec §12). Rendered beside the card's select button, never
 * inside it: a link and buttons cannot nest in a button. The status lines
 * are `aria-live`, because they change on a poll with no interaction of the
 * viewer's own; the actions sit outside that region, so a held Refresh
 * counting down is not announced every second.
 */
function PullRequestStatus({
	pr,
	snapshotStatus,
	canTryAgain,
	busy,
	refreshPending,
	refreshWaitSeconds,
	reconnectLabel,
	onRefresh,
	onRetry,
	onTryAgain,
	onReconnect,
}: {
	pr: ProposalPullRequest;
	snapshotStatus: string;
	/** The proposer may re-run checks that could not finish. */
	canTryAgain: boolean;
	busy: boolean;
	refreshPending: boolean;
	/** Whole seconds until Refresh may be pressed again; 0 when it may. */
	refreshWaitSeconds: number;
	reconnectLabel: "reconnect" | "openRepositorySettings";
	onRefresh: () => void;
	onRetry: () => void;
	onTryAgain: () => void;
	onReconnect: () => void;
}) {
	const t = useTranslations(
		"projects.codingInstructions.proposalReview.pullRequest",
	);
	const line = pullRequestCardLine(pr, snapshotStatus);
	const url = safePullRequestUrl(pr.url);
	const tryAgain = canTryAgain && line.key === "states.validationFailed";
	return (
		<div className="ml-1 flex flex-col gap-1 border-border border-l-2 pl-3 text-sm">
			<div aria-live="polite" className="flex flex-col gap-1">
				<p className={cn("font-medium", TONE_CLASS[line.tone])}>
					{t(line.key, line.values)}
				</p>
				{line.failureKey ? (
					<p className="text-muted-foreground">
						{t(line.failureKey)}
					</p>
				) : null}
				{line.failureAt && pr.state === "BLOCKED" ? (
					<p className="text-muted-foreground text-xs">
						{t("failureAt", {
							time: formatRelativeTime(line.failureAt),
						})}
					</p>
				) : null}
				{line.checkedAt ? (
					<p className="text-muted-foreground text-xs">
						{t("checkedAt", {
							time: formatRelativeTime(line.checkedAt),
						})}
					</p>
				) : null}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				{url ? (
					<Button
						asChild
						size="sm"
						variant="link"
						className="h-auto px-0"
					>
						<a href={url} target="_blank" rel="noopener noreferrer">
							{t("viewPullRequest")}
							<ExternalLinkIcon
								className="size-3.5"
								aria-hidden="true"
							/>
						</a>
					</Button>
				) : null}
				{tryAgain ? (
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={onTryAgain}
					>
						{t("tryAgain")}
					</Button>
				) : null}
				{canRetryOpening(pr) ? (
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={onRetry}
					>
						{t("retryOpening")}
					</Button>
				) : null}
				{offersReconnect(pr) ? (
					<Button size="sm" variant="outline" onClick={onReconnect}>
						{t(reconnectLabel)}
					</Button>
				) : null}
				{offersPullRequestRefresh(pr) ? (
					<Button
						size="sm"
						variant="ghost"
						disabled={
							busy || refreshPending || refreshWaitSeconds > 0
						}
						onClick={onRefresh}
					>
						<RefreshCwIcon
							className="size-3.5"
							aria-hidden="true"
						/>
						{refreshWaitSeconds > 0
							? t("refreshIn", { seconds: refreshWaitSeconds })
							: t("refresh")}
					</Button>
				) : null}
			</div>
		</div>
	);
}

/**
 * How many changed files a proposal may have before its sections start
 * collapsed. Small proposals are the common case and are what someone opens
 * the dialog to read; a large one becomes a table of contents instead of a
 * wall nobody scrolls to the decision buttons through.
 */
const AUTO_EXPAND_CHANGE_LIMIT = 5;

/**
 * One changed file's before/after as a unified diff.
 *
 * A missing side is empty text FOR THE DIFF — an `add` has no before and
 * reads as all `+`, a `delete` has no after and reads as all `−` — but the
 * two are not the same thing when deciding what to say instead of a diff. A
 * side that is `null` is absent; a side that is `""` is a real, empty file.
 * Collapsing them made an added or deleted EMPTY file claim its text "did not
 * change", which is the opposite of what happened to it. So the null check
 * comes first, and only two PRESENT equal sides are an unchanged body.
 *
 * Both bodies are already in hand — `buildProposalChanges` sends them inline
 * — so nothing is fetched here.
 */
function ProposalChangeDiff({
	before,
	after,
}: {
	before: string | null;
	after: string | null;
}) {
	const t = useTranslations("projects.codingInstructions.proposalReview");
	const rows = useMemo(
		() => toDiffRows(diffLines(before ?? "", after ?? "")),
		[before, after],
	);
	// One side absent: the file was added or deleted outright.
	const oneSided = before === null || after === null;
	if (oneSided && (before ?? "") === "" && (after ?? "") === "") {
		return (
			<p className="text-muted-foreground text-sm">{t("emptyFile")}</p>
		);
	}
	if (!oneSided && before === after) {
		return (
			<p className="text-muted-foreground text-sm">
				{t("noTextualChanges")}
			</p>
		);
	}
	return (
		<pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs">
			{rows.map((row, index) => (
				<span
					key={`${index}-${row.text.length}`}
					className={cn(
						row.added &&
							"bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
						row.removed &&
							"bg-red-500/15 text-red-800 dark:text-red-300",
					)}
				>
					{row.text}
				</span>
			))}
		</pre>
	);
}

function validationLabel(
	status: ValidationStatus,
	t: (key: string) => string,
): string {
	if (status === "RECEIVING" || status === "VALIDATING") {
		return t("checking");
	}
	if (status === "REJECTED") {
		return t("validationRejected");
	}
	if (status === "FAILED") {
		return t("validationFailed");
	}
	return t("ready");
}

function proposalLabel(
	status: ProposalStatus,
	t: (key: string) => string,
): string {
	if (status === "APPROVED") {
		return t("approved");
	}
	if (status === "REJECTED") {
		return t("rejected");
	}
	if (status === "MERGED") {
		return t("merged");
	}
	if (status === "CLOSED") {
		return t("closed");
	}
	return t("pending");
}

/**
 * Proposal metadata for readers and validated, immutable diffs for reviewers.
 * The server limits a reader's list to their own rows, withholds file bytes
 * until the scan has completed, and alone decides whether the published base
 * is still current.
 *
 * A REPOSITORY proposal (Fizzy #2563 spec §12) is a suggestion that opens a
 * pull request: its card shows the pull request's state, polls while it is
 * pending, and offers Refresh, Retry opening, Reconnect and Withdraw as that
 * state allows. It is decided in the repository, so it never offers Approve
 * or Reject.
 */
export function InstructionProposals({
	projectId,
	open,
	onOpenChange,
	onChanged,
	canReview = true,
	canDecide = canReview,
	repositoryBacked = false,
	repositoryProvider = null,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onChanged: () => void;
	/** List every proposal and read its diff (INSTRUCTION_UPDATE). */
	canReview?: boolean;
	/**
	 * Approve or reject a FABRIC proposal here. False on a repository-backed
	 * project, where even a FABRIC proposal can no longer publish.
	 */
	canDecide?: boolean;
	/** The project's instructions come from its repository: title the dialog for suggestions. */
	repositoryBacked?: boolean;
	/** The connected repository's provider, to say whether it can be reconnected in-app. */
	repositoryProvider?: string | null;
}) {
	const t = useTranslations("projects.codingInstructions.proposalReview");
	const tPr = useTranslations(
		"projects.codingInstructions.proposalReview.pullRequest",
	);
	const queryClient = useQueryClient();
	// Until when Refresh is held on each card (epoch ms). A press holds it
	// for REFRESH_COOLDOWN_MS, the server's own ration, as a convenience; a
	// refusal replaces that with the server's `retryAfter`, which is the
	// boundary. `now` ticks once a second while any hold runs, so the button
	// counts down and frees itself.
	const [refreshHeldUntil, setRefreshHeldUntil] = useState<
		Record<string, number>
	>({});
	const [now, setNow] = useState(() => Date.now());
	const refreshHoldRunning = Object.values(refreshHeldUntil).some(
		(until) => until > now,
	);
	useEffect(() => {
		if (!refreshHoldRunning) {
			return;
		}
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [refreshHoldRunning]);
	const holdRefresh = (snapshotId: string, milliseconds: number) => {
		const at = Date.now();
		setRefreshHeldUntil((current) => ({
			...current,
			[snapshotId]: at + milliseconds,
		}));
		setNow(at);
	};
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [cursor, setCursor] = useState<string | undefined>();
	const [cursorHistory, setCursorHistory] = useState<
		Array<string | undefined>
	>([]);
	const [filePageInput, setFilePageInput] = useState<{
		path: string;
		side: "before" | "after";
		offset: number;
	} | null>(null);
	// Only the sections somebody has clicked. The default is derived from the
	// proposal's size below, so this holds overrides rather than the whole
	// open/closed picture — which keeps a background refetch of the detail
	// from reopening a section that was just closed.
	const [changeToggles, setChangeToggles] = useState<Record<string, boolean>>(
		{},
	);
	const proposals = useQuery({
		...orpc.projects.instructions.proposals.list.queryOptions({
			input: { projectId, limit: PAGE_SIZE, cursor },
		}),
		enabled: open,
		// Every 3 s while a proposal is being validated; every 10 s while a
		// pull-request suggestion is pending or its merge sync is requested
		// (spec §12); off once everything shown is settled. The list carries
		// each row's full `pullRequest` block, so one read refreshes every
		// card at once.
		refetchInterval: (query) =>
			proposalListPollInterval(
				(query.state.data as { items?: ProposalRow[] } | undefined)
					?.items,
			),
	});
	const detail = useQuery({
		...orpc.projects.instructions.proposals.get.queryOptions({
			input: { projectId, snapshotId: selectedId ?? "" },
		}),
		enabled: open && canReview && selectedId !== null,
		refetchInterval: (query) => {
			const row = query.state.data as ProposalDetail | undefined;
			return row?.proposalStatus === "PENDING" &&
				VALIDATING.has(row.status)
				? 3_000
				: false;
		},
	});
	const filePage = useQuery({
		...orpc.projects.instructions.proposals.file.queryOptions({
			input: {
				projectId,
				snapshotId: selectedId ?? "",
				path: filePageInput?.path ?? "",
				side: filePageInput?.side ?? "after",
				offset: filePageInput?.offset ?? 0,
			},
		}),
		enabled:
			open && canReview && selectedId !== null && filePageInput !== null,
	});
	const clearSelection = () => {
		setSelectedId(null);
		setFilePageInput(null);
		setChangeToggles({});
	};
	const refreshState = () => {
		onChanged();
		void proposals.refetch();
		if (canReview && selectedId !== null) {
			void detail.refetch();
		}
		void queryClient.invalidateQueries({
			queryKey: orpc.projects.instructions.getPublished.queryOptions({
				input: { projectId },
			}).queryKey,
		});
	};
	const approve = useMutation(
		orpc.projects.instructions.proposals.approve.mutationOptions({
			onSuccess: () => {
				toast.success(t("approveSuccess"));
				refreshState();
			},
			onError: (error) => {
				toast.error(error.message);
				refreshState();
			},
		}),
	);
	const reject = useMutation(
		orpc.projects.instructions.proposals.reject.mutationOptions({
			onSuccess: () => {
				toast.success(t("rejectSuccess"));
				refreshState();
			},
			onError: (error) => {
				toast.error(error.message);
				refreshState();
			},
		}),
	);
	const cancel = useMutation(
		orpc.projects.instructions.proposals.cancel.mutationOptions({
			onSuccess: (result) => {
				const pullRequest = (
					result as { pullRequest?: string | null } | undefined
				)?.pullRequest;
				toast.success(
					t(
						pullRequest === "close_requested"
							? "withdrawClosing"
							: pullRequest === "canceled"
								? "withdrawSuccess"
								: "cancelSuccess",
					),
				);
				refreshState();
			},
			onError: (error) => {
				toast.error(error.message);
				refreshState();
			},
		}),
	);
	/**
	 * A refused pull-request action: its own copy, then a re-read, since the
	 * row may have moved. NOT_FOUND is a proposal this viewer cannot see (or
	 * one that is gone; phase C answers both alike), so it reads as absent
	 * and the re-read drops the card.
	 */
	const pullRequestRefused = (error: Error) => {
		const reason = refusalReason(error);
		const seconds = refreshRetryAfterSeconds(error);
		toast.error(
			errorCode(error) === "NOT_FOUND"
				? tPr("refusals.NOT_FOUND")
				: reason &&
						REFRESH_WAIT_REFUSALS.has(reason) &&
						seconds !== null
					? tPr(`refusals.${reason}`, { seconds })
					: reason && PULL_REQUEST_REFUSALS.has(reason)
						? tPr(`refusals.${reason}`)
						: error.message,
		);
		refreshState();
	};
	const refresh = useMutation(
		orpc.projects.instructions.proposals.refreshPullRequest.mutationOptions(
			{
				onSuccess: (result) => {
					const refreshed = (
						result as { refreshed?: boolean } | undefined
					)?.refreshed;
					toast.info(
						tPr(
							refreshed === false
								? "refreshSettled"
								: "refreshSuccess",
						),
					);
					refreshState();
				},
				onError: (error, variables) => {
					const seconds = refreshRetryAfterSeconds(error);
					if (seconds !== null) {
						holdRefresh(variables.snapshotId, seconds * 1_000);
					}
					pullRequestRefused(error);
				},
			},
		),
	);
	const retry = useMutation(
		orpc.projects.instructions.proposals.retryPullRequest.mutationOptions({
			onSuccess: () => {
				toast.success(tPr("retrySuccess"));
				refreshState();
			},
			onError: pullRequestRefused,
		}),
	);
	const tryAgain = useMutation(
		orpc.projects.instructions.finalize.mutationOptions({
			onSuccess: () => {
				toast.success(tPr("tryAgainSuccess"));
				refreshState();
			},
			onError: (error) => {
				toast.error(error.message);
				refreshState();
			},
		}),
	);
	const selected = detail.data as ProposalDetail | undefined;
	const deciding =
		approve.isPending ||
		reject.isPending ||
		cancel.isPending ||
		retry.isPending ||
		tryAgain.isPending;
	const reconnectLabel = repositoryProviderSupportsReconnect(
		repositoryProvider,
	)
		? "reconnect"
		: "openRepositorySettings";
	const page = proposals.data as
		| { items: ProposalRow[]; nextCursor: string | null }
		| undefined;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					clearSelection();
					setCursor(undefined);
					setCursorHistory([]);
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="max-w-4xl">
				<DialogHeader>
					<DialogTitle>
						{t(repositoryBacked ? "repositoryTitle" : "title")}
					</DialogTitle>
					<DialogDescription>
						{t(
							repositoryBacked
								? "repositoryDescription"
								: "description",
						)}
					</DialogDescription>
				</DialogHeader>
				{proposals.isLoading ? (
					<Skeleton className="h-24 w-full" />
				) : null}
				{proposals.isError ? (
					<p role="alert" className="text-destructive text-sm">
						{t("listError")}
					</p>
				) : null}
				{proposals.isSuccess && page?.items.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						{t("empty")}
					</p>
				) : null}
				{proposals.isSuccess ? (
					<div className="flex max-h-80 flex-col gap-3 overflow-auto">
						{page?.items.map((proposal) => {
							const repository =
								proposal.destination === "REPOSITORY";
							const pr = proposal.pullRequest ?? null;
							return (
								<div
									key={proposal.id}
									className="flex flex-col gap-2"
								>
									<div className="flex items-stretch gap-2">
										<Button
											variant={
												selectedId === proposal.id
													? "secondary"
													: "outline"
											}
											className="h-auto min-w-0 flex-1 justify-between whitespace-normal p-3 text-left"
											aria-label={t("proposalVersion", {
												version: proposal.version,
											})}
											disabled={!canReview}
											onClick={() => {
												setFilePageInput(null);
												setChangeToggles({});
												setSelectedId(proposal.id);
											}}
										>
											<span className="flex min-w-0 flex-col gap-1">
												<span>
													{t("proposalVersion", {
														version:
															proposal.version,
													})}
												</span>
												{proposal.note?.title ? (
													<span className="font-medium [overflow-wrap:anywhere]">
														{proposal.note.title}
													</span>
												) : null}
												<span className="text-muted-foreground text-xs">
													{t("submittedBy", {
														name:
															proposal.proposer
																.name ??
															t("anonymousUser"),
														time: formatRelativeTime(
															proposal.createdAt,
														),
													})}
												</span>
											</span>
											{/* A suggestion's state is its pull request's, shown
											    below; the review badges would contradict it. */}
											{repository ? null : (
												<span className="flex shrink-0 gap-1">
													<Badge variant="outline">
														{validationLabel(
															proposal.status,
															t,
														)}
													</Badge>
													<Badge
														variant={
															proposal.proposalStatus ===
															"PENDING"
																? "secondary"
																: proposal.proposalStatus ===
																		"APPROVED"
																	? "success"
																	: "destructive"
														}
													>
														{proposalLabel(
															proposal.proposalStatus,
															t,
														)}
													</Badge>
												</span>
											)}
										</Button>
										{proposal.canCancel ? (
											<Button
												variant="outline"
												disabled={deciding}
												onClick={() => {
													if (
														window.confirm(
															t(
																repository
																	? "withdrawConfirm"
																	: "cancelConfirm",
															),
														)
													) {
														cancel.mutate({
															projectId,
															snapshotId:
																proposal.id,
														});
													}
												}}
											>
												{t(
													repository
														? "withdraw"
														: "cancel",
												)}
											</Button>
										) : null}
									</div>
									{pr ? (
										<PullRequestStatus
											pr={pr}
											snapshotStatus={proposal.status}
											// `canCancel` is the server's proposer
											// check; on a FAILED pending proposal it
											// is exactly who may re-run the checks.
											canTryAgain={proposal.canCancel}
											busy={deciding}
											refreshPending={refresh.isPending}
											refreshWaitSeconds={refreshHoldSeconds(
												refreshHeldUntil[proposal.id],
												now,
											)}
											reconnectLabel={reconnectLabel}
											onRefresh={() => {
												holdRefresh(
													proposal.id,
													REFRESH_COOLDOWN_MS,
												);
												refresh.mutate({
													projectId,
													snapshotId: proposal.id,
												});
											}}
											onRetry={() => {
												if (
													window.confirm(
														tPr("retryConfirm"),
													)
												) {
													// The attempt the card
													// showed: a row that moved
													// since is refused and
													// re-read.
													retry.mutate({
														projectId,
														snapshotId: proposal.id,
														expectedAttempt:
															pr.attempt,
													});
												}
											}}
											onTryAgain={() =>
												tryAgain.mutate({
													projectId,
													snapshotId: proposal.id,
												})
											}
											onReconnect={() => {
												onOpenChange(false);
												navigateToProjectSettingsTab(
													projectId,
													"development",
												);
											}}
										/>
									) : null}
								</div>
							);
						})}
					</div>
				) : null}
				{proposals.isSuccess &&
				(cursorHistory.length > 0 || page?.nextCursor) ? (
					<div className="flex justify-end gap-2">
						<Button
							variant="outline"
							disabled={cursorHistory.length === 0}
							onClick={() => {
								clearSelection();
								const previous = [...cursorHistory];
								setCursor(previous.pop());
								setCursorHistory(previous);
							}}
						>
							{t("previousPage")}
						</Button>
						<Button
							variant="outline"
							disabled={!page?.nextCursor}
							onClick={() => {
								clearSelection();
								setCursorHistory((history) => [
									...history,
									cursor,
								]);
								setCursor(page?.nextCursor ?? undefined);
							}}
						>
							{t("nextPage")}
						</Button>
					</div>
				) : null}
				{selectedId !== null && detail.isLoading ? (
					<Skeleton className="h-48 w-full" />
				) : null}
				{selectedId !== null && detail.isError ? (
					<p role="alert" className="text-destructive text-sm">
						{t("detailError")}
					</p>
				) : null}
				{selected ? (
					<div className="flex max-h-[420px] flex-col gap-3 overflow-auto rounded-lg border border-border p-4">
						{selected.note?.title || selected.note?.body ? (
							<div className="flex flex-col gap-1">
								{selected.note.title ? (
									<h3 className="font-medium [overflow-wrap:anywhere]">
										{selected.note.title}
									</h3>
								) : null}
								{selected.note.body ? (
									<p className="whitespace-pre-wrap text-muted-foreground text-sm [overflow-wrap:anywhere]">
										{selected.note.body}
									</p>
								) : null}
							</div>
						) : null}
						{selected.destination === "REPOSITORY" ? (
							<p className="text-muted-foreground text-sm">
								{t("repositoryProposalBody")}
							</p>
						) : null}
						{selected.isStale ? (
							<p
								role="alert"
								className="text-destructive text-sm"
							>
								{t("stale")}
							</p>
						) : null}
						{VALIDATING.has(selected.status) ? (
							<p
								aria-live="polite"
								className="text-muted-foreground text-sm"
							>
								{t("checkingBody")}
							</p>
						) : null}
						{selected.status === "REJECTED" ? (
							<p
								role="alert"
								className="text-destructive text-sm"
							>
								{t("validationRejectedBody")}
							</p>
						) : null}
						{selected.status === "FAILED" ? (
							<p
								role="alert"
								className="text-destructive text-sm"
							>
								{t("validationFailedBody")}
							</p>
						) : null}
						{selected.status === "READY" && selected.changes ? (
							<div className="flex flex-col gap-3">
								{selected.changes.some(
									(change) =>
										change.beforeOmitted !== null ||
										change.afterOmitted !== null,
								) ? (
									<p
										role="alert"
										className="text-warning text-sm"
									>
										{t("diffIncomplete")}
									</p>
								) : null}
								{selected.changes.map((change) => {
									const expanded =
										changeToggles[change.path] ??
										(selected.changes?.length ?? 0) <=
											AUTO_EXPAND_CHANGE_LIMIT;
									// A unified diff needs BOTH sides. With one of them
									// omitted there is nothing to compare against, so the
									// section keeps today's notice and its paged link.
									const diffable =
										!change.binary &&
										change.beforeOmitted === null &&
										change.afterOmitted === null;
									const counts = diffable
										? countDiffLines(
												diffLines(
													change.before ?? "",
													change.after ?? "",
												),
											)
										: null;
									return (
										<section
											key={change.path}
											className="flex flex-col gap-2 rounded-md border border-border p-3"
										>
											<button
												type="button"
												aria-expanded={expanded}
												className="flex w-full min-w-0 items-center gap-2 text-left"
												onClick={() =>
													setChangeToggles(
														(current) => ({
															...current,
															[change.path]:
																!expanded,
														}),
													)
												}
											>
												{expanded ? (
													<ChevronDownIcon
														className="size-3.5 shrink-0"
														aria-hidden="true"
													/>
												) : (
													<ChevronRightIcon
														className="size-3.5 shrink-0"
														aria-hidden="true"
													/>
												)}
												<Badge variant="secondary">
													{t(change.op)}
												</Badge>
												<code className="min-w-0 truncate text-xs">
													{change.path}
												</code>
												{counts ? (
													<span className="ml-auto shrink-0 text-muted-foreground text-xs">
														{t(
															"lineCounts",
															counts,
														)}
													</span>
												) : null}
											</button>
											{!expanded ? null : change.binary ? (
												<p className="text-muted-foreground text-sm">
													{t("binary")}
												</p>
											) : diffable ? (
												<ProposalChangeDiff
													before={change.before}
													after={change.after}
												/>
											) : (
												<div className="grid gap-2 md:grid-cols-2">
													{change.before !== null ? (
														<div>
															<p className="mb-1 text-muted-foreground text-xs">
																{t("before")}
															</p>
															<pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs">
																{change.before}
															</pre>
														</div>
													) : null}
													{change.after !== null ? (
														<div>
															<p className="mb-1 text-muted-foreground text-xs">
																{t("after")}
															</p>
															<pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs">
																{change.after}
															</pre>
														</div>
													) : null}
													{change.beforeOmitted &&
													change.beforeOmitted !==
														"BINARY" ? (
														<div>
															<p className="mb-1 text-muted-foreground text-xs">
																{t("before")}
															</p>
															<p className="text-muted-foreground text-sm">
																{t(
																	change.beforeOmitted ===
																		"FILE_TOO_LARGE"
																		? "fileTooLarge"
																		: "responseLimit",
																)}
															</p>
															<Button
																variant="link"
																className="h-auto justify-start px-0"
																onClick={() =>
																	setFilePageInput(
																		{
																			path: change.path,
																			side: "before",
																			offset: 0,
																		},
																	)
																}
															>
																{t(
																	"viewFullSide",
																)}
															</Button>
														</div>
													) : null}
													{change.afterOmitted &&
													change.afterOmitted !==
														"BINARY" ? (
														<div>
															<p className="mb-1 text-muted-foreground text-xs">
																{t("after")}
															</p>
															<p className="text-muted-foreground text-sm">
																{t(
																	change.afterOmitted ===
																		"FILE_TOO_LARGE"
																		? "fileTooLarge"
																		: "responseLimit",
																)}
															</p>
															<Button
																variant="link"
																className="h-auto justify-start px-0"
																onClick={() =>
																	setFilePageInput(
																		{
																			path: change.path,
																			side: "after",
																			offset: 0,
																		},
																	)
																}
															>
																{t(
																	"viewFullSide",
																)}
															</Button>
														</div>
													) : null}
												</div>
											)}
										</section>
									);
								})}
								{filePageInput ? (
									<div className="rounded-md border border-border p-3">
										<p className="mb-2 text-muted-foreground text-xs">
											{t("fullSideTitle", {
												side: t(filePageInput.side),
												path: filePageInput.path,
											})}
										</p>
										{filePage.isLoading ? (
											<Skeleton className="h-24 w-full" />
										) : null}
										{filePage.isError ? (
											<p
												role="alert"
												className="text-destructive text-sm"
											>
												{t("filePageError")}
											</p>
										) : null}
										{filePage.data ? (
											<>
												<pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs">
													{
														(
															filePage.data as ProposalFilePage
														).body
													}
												</pre>
												<div className="mt-2 flex gap-2">
													<Button
														variant="outline"
														disabled={
															filePageInput.offset ===
															0
														}
														onClick={() =>
															setFilePageInput(
																(current) =>
																	current
																		? {
																				...current,
																				offset: Math.max(
																					0,
																					current.offset -
																						50_000,
																				),
																			}
																		: null,
															)
														}
													>
														{t("previousPage")}
													</Button>
													<Button
														variant="outline"
														disabled={
															(
																filePage.data as ProposalFilePage
															).nextOffset ===
															null
														}
														onClick={() => {
															const nextOffset = (
																filePage.data as ProposalFilePage
															).nextOffset;
															if (
																nextOffset !==
																null
															) {
																setFilePageInput(
																	(
																		current,
																	) =>
																		current
																			? {
																					...current,
																					offset: nextOffset,
																				}
																			: null,
																);
															}
														}}
													>
														{t("nextPage")}
													</Button>
												</div>
											</>
										) : null}
									</div>
								) : null}
							</div>
						) : null}
						{selected.destination !== "REPOSITORY" &&
						selected.proposalStatus === "APPROVED" ? (
							<p className="text-success text-sm">
								{t("approvedBody")}
							</p>
						) : null}
						{selected.destination !== "REPOSITORY" &&
						selected.proposalStatus === "REJECTED" ? (
							<p className="text-muted-foreground text-sm">
								{t("rejectedBody")}
							</p>
						) : null}
						{/* Approve and Reject stay FABRIC-only (spec §12): a
						    suggestion is decided on its pull request. */}
						{canDecide &&
						selected.destination !== "REPOSITORY" &&
						selected.proposalStatus === "PENDING" &&
						!VALIDATING.has(selected.status) ? (
							<div className="flex gap-2">
								{selected.status === "READY" &&
								!selected.isStale ? (
									<Button
										disabled={deciding}
										onClick={() =>
											approve.mutate({
												projectId,
												snapshotId: selected.id,
											})
										}
									>
										{t("approve")}
									</Button>
								) : null}
								<Button
									variant="outline"
									disabled={deciding}
									onClick={() => {
										if (
											window.confirm(t("rejectConfirm"))
										) {
											reject.mutate({
												projectId,
												snapshotId: selected.id,
											});
										}
									}}
								>
									{t("reject")}
								</Button>
							</div>
						) : null}
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
