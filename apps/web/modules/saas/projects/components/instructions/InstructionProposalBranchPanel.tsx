"use client";

import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef } from "react";
import { toast } from "sonner";
import { isBranchChangedRefusal } from "../../lib/instructions-action-error";
import { instructionsFreshness } from "../../lib/instructions-query-freshness";
import {
	branchCardLine,
	branchPanelPollInterval,
	nextTransitionSince,
	offersBranchRefresh,
	offersClose,
	offersRetryOpening,
	offersStartOver,
	offersStopTracking,
	type ProposalBranchLite,
} from "./lib/instructions-proposal-branch";
import {
	branchesSignature,
	invalidateProposalViews,
	useRefreshSettleWindow,
} from "./lib/instructions-proposal-views";

const TONE_CLASS = {
	progress: "text-foreground",
	success: "text-success",
	neutral: "text-muted-foreground",
	error: "text-destructive",
} as const;

/**
 * A pull request's address as the provider reported it, only when it is an
 * https URL: the value came from a provider's response, and a link must never
 * run script (mirrors `safePullRequestUrl` in `InstructionProposals.tsx`).
 */
function safeUrl(url: string | null | undefined): string | null {
	return url && /^https:\/\//i.test(url) ? url : null;
}

type BranchPanelEntry = {
	branch: ProposalBranchLite;
	liveChanges: number;
};

function isRefreshAnswer(
	value: unknown,
): value is { refreshed: boolean; pending: boolean } {
	return (
		typeof value === "object" &&
		value !== null &&
		"refreshed" in value &&
		"pending" in value &&
		typeof value.refreshed === "boolean" &&
		typeof value.pending === "boolean"
	);
}

/** `proposals.myBranch`'s answer, and the shape `data` takes in read-only mode. */
export type MyProposalBranch = {
	branch: ProposalBranchLite | null;
	liveChanges: number;
	files: unknown[];
	branches: BranchPanelEntry[];
};

/**
 * A member's proposal branch(es), shown above the proposal list (Fizzy #2738
 * spec §10 "Tab"): the accepting branch, plus any retired, closing,
 * classifying or BLOCKED one — exactly the set `proposals.myBranch` returns
 * in `branches`, so this component renders that array without refiltering
 * it.
 *
 * Omitting `userId` reads and manages the CALLER's own branch, with its own
 * `myBranch` query and full owner commands. Passing `userId` (spec §10:
 * "Reviewers see every member's branches read-only, with owner-or-reviewer
 * visibility as `authorizedProposal`") renders that OTHER member's branch
 * READ-ONLY, from `data`/`isLoading`/`isError` the caller passes in, rather
 * than querying `myBranch({userId})` itself: `InstructionProposals.tsx`'s
 * reviewer aggregate read (`proposals.branches`) already builds every shown
 * owner's exact same view for its page, so a second, per-panel query here
 * would be one wasted read per member on screen (round-3 review finding).
 * `data`/`isLoading`/`isError` are only meaningful together with `userId`;
 * the caller's own instance always ignores them.
 *
 * Read-only mode hides the OWNER-only commands: Close, Retry opening and
 * Start over (`ownedBranch` server-side). Stop tracking (spec Decision 19)
 * stays offered even read-only: it is authorized for the owner OR a reviewer
 * (`readableBranch`), unlike the other three — its mutation still runs here,
 * and success calls `onChanged` for the caller to refresh the aggregate,
 * since this instance has no query of its own to refetch. Copy never says
 * "your" about someone else's branch in read-only mode.
 */
export function InstructionProposalBranchPanel({
	projectId,
	onChanged,
	onRefreshRequested,
	userId,
	ownerName,
	data: dataProp,
	isLoading: isLoadingProp,
	isError: isErrorProp,
}: {
	projectId: string;
	onChanged?: () => void;
	/** Called when a provider Refresh was asked for; a read-only panel's caller owns the poll that follows. */
	onRefreshRequested?: () => void;
	/** Another member's id, for a reviewer only; omitted reads the caller's own. */
	userId?: string;
	/** That member's display name, shown above their read-only branches. */
	ownerName?: string | null;
	/** The owner's already-fetched view, for read-only mode. Ignored when `userId` is omitted. */
	data?: MyProposalBranch;
	/** Whether that view is still loading. Ignored when `userId` is omitted. */
	isLoading?: boolean;
	/** Whether that view failed to load. Ignored when `userId` is omitted. */
	isError?: boolean;
}) {
	const readOnly = userId !== undefined;
	const actionError = useInstructionActionError();
	const { confirm } = useConfirmationAlert();
	const t = useTranslations(
		"projects.codingInstructions.proposalReview.branch",
	);
	// A branch's own failure reads its copy from the SHARED
	// `pullRequest.failures.*` namespace by code (spec §9: "Branch-level
	// failures reuse #2563's codes"), never from this panel's own namespace.
	const tPr = useTranslations(
		"projects.codingInstructions.proposalReview.pullRequest",
	);
	const queryClient = useQueryClient();
	// Disabled in read-only mode: the caller already fetched this exact view
	// through the reviewer aggregate read, so this query would never be more
	// than a discarded duplicate of it.
	const settle = useRefreshSettleWindow();
	const transitionSince = useRef<number | null>(null);
	const closeRetried = useRef(false);
	const query = useQuery({
		...orpc.projects.instructions.proposals.myBranch.queryOptions({
			input: { projectId },
		}),
		...instructionsFreshness.proposalView,
		enabled: !readOnly,
		refetchInterval: (q) => {
			const shown = (
				q.state.data as MyProposalBranch | undefined
			)?.branches.map((entry) => entry.branch);
			const now = Date.now();
			transitionSince.current = nextTransitionSince(
				transitionSince.current,
				shown,
				now,
			);
			return settle.pollInterval(
				branchPanelPollInterval(shown, transitionSince.current, now),
			);
		},
	});
	settle.observe(
		branchesSignature(
			(query.data as MyProposalBranch | undefined)?.branches.map(
				(entry) => entry.branch,
			) ?? [],
		),
	);

	const isLoading = readOnly ? Boolean(isLoadingProp) : query.isLoading;
	const isError = readOnly ? Boolean(isErrorProp) : query.isError;
	const data = readOnly
		? dataProp
		: (query.data as MyProposalBranch | undefined);

	const refresh = async () => {
		onChanged?.();
		if (readOnly) {
			// No query of our own: the caller's `onChanged` is what refetches
			// the reviewer aggregate this view came from.
			return;
		}
		await invalidateProposalViews(queryClient);
	};

	// The branch's own fencing attempt, as the last read showed it: a command
	// against a branch that moved since is refused as BRANCH_CHANGED, and the
	// refetch that follows shows the member the branch as it now is.
	function attemptFor(branchId: string): number {
		const entry = data?.branches.find((e) => e.branch.id === branchId);
		return entry?.branch.attempt ?? 0;
	}

	// Close is the one command confirmed against a card that may be seconds
	// old: the pull request opening moves OPENING -> OPEN and bumps the
	// attempt between the 10 s polls, so a fence taken from the cached view
	// is refused as BRANCH_CHANGED. The confirmation reads the branch again
	// and fences on that.
	async function freshAttemptFor(branchId: string): Promise<number> {
		const fresh = await query.refetch();
		const entry = (
			fresh.data as MyProposalBranch | undefined
		)?.branches.find((e) => e.branch.id === branchId);
		return entry?.branch.attempt ?? attemptFor(branchId);
	}

	function onCommandSuccess(
		result: { changed: boolean },
		successMessage: string,
	) {
		if (result.changed) {
			toast.success(successMessage);
		}
		refresh();
	}

	const close = useMutation(
		orpc.projects.instructions.proposals.closeBranch.mutationOptions({
			onSuccess: (result, variables) => {
				closeRetried.current = false;
				const closed = (
					query.data as MyProposalBranch | undefined
				)?.branches.find((e) => e.branch.id === variables.branchId);
				onCommandSuccess(
					result as { changed: boolean },
					t(
						closed?.branch.pullRequest
							? "closeSuccess"
							: "closeSuccessNoPr",
					),
				);
			},
			onError: async (error: Error, variables) => {
				// The branch moved between the confirmation and the command
				// (the pull request opened). The intent is unchanged, so resend
				// once against the branch as it now is, if it still takes Close.
				if (!closeRetried.current && isBranchChangedRefusal(error)) {
					closeRetried.current = true;
					const fresh = await query.refetch();
					const entry = (
						fresh.data as MyProposalBranch | undefined
					)?.branches.find((e) => e.branch.id === variables.branchId);
					if (entry && offersClose(entry.branch)) {
						close.mutate({
							...variables,
							expectedAttempt: entry.branch.attempt,
						});
						return;
					}
				}
				closeRetried.current = false;
				toast.error(actionError(error));
				refresh();
			},
		}),
	);
	const startOver = useMutation(
		orpc.projects.instructions.proposals.startOverBranch.mutationOptions({
			onSuccess: (result) =>
				onCommandSuccess(
					result as { changed: boolean },
					t("startOverSuccess"),
				),
			onError: (error: Error) => {
				toast.error(actionError(error));
				refresh();
			},
		}),
	);
	const retry = useMutation(
		orpc.projects.instructions.proposals.retryBranch.mutationOptions({
			onSuccess: (result) =>
				onCommandSuccess(
					result as { changed: boolean },
					t("retrySuccess"),
				),
			onError: (error: Error) => {
				toast.error(actionError(error));
				refresh();
			},
		}),
	);
	const stopTracking = useMutation(
		orpc.projects.instructions.proposals.stopTrackingBranch.mutationOptions(
			{
				onSuccess: (result) =>
					onCommandSuccess(
						result as { changed: boolean },
						t("stopTrackingSuccess"),
					),
				onError: (error: Error) => {
					toast.error(actionError(error));
					refresh();
				},
			},
		),
	);
	const refreshBranch = useMutation(
		orpc.projects.instructions.proposals.refreshBranch.mutationOptions({
			onSuccess: async (result) => {
				settle.startSettling();
				onRefreshRequested?.();
				await refresh();
				if (!isRefreshAnswer(result)) {
					toast.error(t("loadError"));
					return;
				}
				const answer = result;
				if (!answer.refreshed) {
					toast.info(t("refreshSettled"));
				} else if (answer.pending) {
					toast.info(t("refreshPending"));
				} else {
					toast.info(t("refreshSuccess"));
				}
			},
			onError: async (error: Error) => {
				settle.startSettling();
				onRefreshRequested?.();
				await refresh();
				toast.error(actionError(error));
			},
		}),
	);
	const busy =
		close.isPending ||
		startOver.isPending ||
		retry.isPending ||
		stopTracking.isPending ||
		refreshBranch.isPending;

	const branches = data?.branches ?? [];
	// A reviewer sees several members' panels at once, so a read-only one
	// names whose branch it is; the caller's own never needs to say so.
	const heading = readOnly ? (
		<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
			{t("other.heading", {
				member: ownerName ?? t("other.unknownMember"),
			})}
		</p>
	) : null;

	if (isLoading) {
		return (
			<div className="flex flex-col gap-1">
				{heading}
				<Skeleton className="h-16 w-full" />
			</div>
		);
	}
	if (isError) {
		return (
			<div className="flex flex-col gap-1">
				{heading}
				<p role="alert" className="text-destructive text-sm">
					{t(
						readOnly ? "other.loadError" : "loadError",
						readOnly
							? { member: ownerName ?? t("other.unknownMember") }
							: undefined,
					)}
				</p>
			</div>
		);
	}
	if (branches.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-col gap-3">
			{heading}
			{branches.map(({ branch, liveChanges }) => {
				const line = branchCardLine(branch, { readOnly });
				const url = safeUrl(branch.pullRequest?.url);
				return (
					<div
						key={branch.id}
						className="flex flex-col gap-2 rounded-lg border border-border p-3"
					>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<code className="text-muted-foreground text-xs">
								{t("refLabel", { ref: branch.ref })}
							</code>
							<span className="text-muted-foreground text-xs">
								{t("liveChanges", { count: liveChanges })}
							</span>
						</div>
						<div aria-live="polite" className="flex flex-col gap-1">
							<p
								className={cn(
									"font-medium text-sm",
									TONE_CLASS[line.tone],
								)}
							>
								{line.key.startsWith("states.") ||
								line.key.startsWith("otherStates.")
									? t(line.key)
									: tPr(line.key, line.failureValues)}
							</p>
							{branch.foreignCommits ? (
								<p className="text-muted-foreground text-sm">
									{t(
										readOnly
											? "other.foreignCommitsNotice"
											: "foreignCommitsNotice",
									)}
								</p>
							) : null}
							{branch.membership === "unverified" ? (
								<p className="text-muted-foreground text-sm">
									{t("unverifiedNotice")}
								</p>
							) : null}
							{branch.pullRequest?.lastCheckedAt ? (
								<p className="text-muted-foreground text-xs">
									{t("checkedAt", {
										time: formatRelativeTime(
											branch.pullRequest.lastCheckedAt,
										),
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
									<a
										href={url}
										target="_blank"
										rel="noopener noreferrer"
									>
										{t("viewPullRequest")}
										<ExternalLinkIcon
											className="size-3.5"
											aria-hidden="true"
										/>
									</a>
								</Button>
							) : null}
							{!readOnly && offersClose(branch) ? (
								<Button
									size="sm"
									variant="outline"
									disabled={busy}
									onClick={() =>
										confirm({
											title: t("close"),
											message: t("closeConfirm", {
												count: liveChanges,
											}),
											confirmLabel: t("close"),
											destructive: true,
											onConfirm: async () =>
												close.mutate({
													projectId,
													branchId: branch.id,
													expectedAttempt:
														await freshAttemptFor(
															branch.id,
														),
												}),
										})
									}
								>
									{t("close")}
								</Button>
							) : null}
							{!readOnly && offersRetryOpening(branch) ? (
								<Button
									size="sm"
									variant="outline"
									disabled={busy}
									onClick={() =>
										confirm({
											title: t("retryOpening"),
											message: t("retryConfirm"),
											confirmLabel: t("retryOpening"),
											destructive: true,
											onConfirm: () =>
												retry.mutate({
													projectId,
													branchId: branch.id,
													expectedAttempt: attemptFor(
														branch.id,
													),
												}),
										})
									}
								>
									{t("retryOpening")}
								</Button>
							) : null}
							{!readOnly && offersStartOver(branch) ? (
								<Button
									size="sm"
									variant="outline"
									disabled={busy}
									onClick={() =>
										confirm({
											title: t("startOver"),
											message: t("startOverConfirm", {
												count: liveChanges,
											}),
											confirmLabel: t("startOver"),
											destructive: true,
											onConfirm: () =>
												startOver.mutate({
													projectId,
													branchId: branch.id,
													expectedAttempt: attemptFor(
														branch.id,
													),
												}),
										})
									}
								>
									{t("startOver")}
								</Button>
							) : null}
							{/* Stop tracking (spec Decision 19) is by the
							    owner OR a reviewer, unlike Close/Retry
							    opening/Start over (`ownedBranch`), so it
							    stays offered here even read-only — the
							    server's own `readableBranch` check agrees. */}
							{offersStopTracking(branch) ? (
								<Button
									size="sm"
									variant="outline"
									disabled={busy}
									onClick={() =>
										confirm({
											title: t("stopTracking"),
											message: t("stopTrackingConfirm"),
											confirmLabel: t("stopTracking"),
											destructive: true,
											onConfirm: () =>
												stopTracking.mutate({
													projectId,
													branchId: branch.id,
													expectedAttempt: attemptFor(
														branch.id,
													),
												}),
										})
									}
								>
									{t("stopTracking")}
								</Button>
							) : null}
							{offersBranchRefresh(branch) ? (
								<Button
									size="sm"
									variant="ghost"
									disabled={
										busy || (!readOnly && query.isFetching)
									}
									onClick={() =>
										refreshBranch.mutate({
											projectId,
											branchId: branch.id,
											expectedAttempt: attemptFor(
												branch.id,
											),
										})
									}
								>
									<RefreshCwIcon
										className="size-3.5"
										aria-hidden="true"
									/>
									{t("refresh")}
								</Button>
							) : null}
						</div>
					</div>
				);
			})}
		</div>
	);
}
