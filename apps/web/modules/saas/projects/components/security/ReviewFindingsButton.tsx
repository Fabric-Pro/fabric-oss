"use client";

/**
 * "Review findings" control (G7) — starts an on-demand AI false-positive review
 * of the current open findings, polls until it settles, then opens the
 * proposals dialog. The review only PROPOSES (dismiss / severity-change /
 * uncertain); applying a subset is an explicit user action.
 *
 * Lifecycle:
 *   1. Click → `scan.review.start` (server dedupes against an in-flight review).
 *   2. Poll `scan.review.latest` while PENDING / RUNNING (same cadence as the
 *      scan poll), button shows "Reviewing…".
 *   3. On COMPLETED → toast + open {@link ReviewProposalsDialog}.
 *   4. Apply selected → `scan.review.apply` → invalidate findings.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Loader2Icon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { isScanActive, type ScanStatus } from "./lib";
import {
	type FindingTitleLookup,
	type ReviewDecision,
	ReviewProposalsDialog,
} from "./ReviewProposalsDialog";

/**
 * Informational tooltip copy for the "Review findings" trigger — calm/advisory
 * per the AI copy-tone standard (the review only proposes; the user decides).
 */
const REVIEW_TOOLTIP_COPY =
	"Runs an AI second-opinion over your open findings and flags likely false positives or wrong severities for you to review. Nothing is applied automatically.";

export function ReviewFindingsButton({
	projectId,
	organizationId,
	getFindingTitle,
	openFindingCount,
}: {
	projectId: string;
	organizationId: string | null;
	getFindingTitle: FindingTitleLookup;
	/** Open-finding count — gates the button (nothing to review at 0). */
	openFindingCount: number;
}) {
	const queryClient = useQueryClient();
	const [dialogOpen, setDialogOpen] = useState(false);
	// Set true when the user starts a review; keeps the poll active and
	// announces the result once. Cleared when the review settles.
	const [awaitingResult, setAwaitingResult] = useState(false);
	const announcedRef = useRef<string | null>(null);
	// The id of whatever review was already the latest when the user clicked
	// "Review findings". A prior COMPLETED/FAILED review sits in the poll cache
	// before the freshly-started one replaces it; without this baseline the
	// settle-effect would fire for that *previous* review on the render where
	// `awaitingResult` flips true but `review` is still stale — opening the
	// proposals dialog on last review's suggestions (which the user could then
	// apply) and clearing `awaitingResult` so the review they actually started
	// is never announced.
	const baselineReviewIdRef = useRef<string | null>(null);

	const latestReviewQuery = useQuery(
		orpc.projects.scan.review.latest.queryOptions({
			input: { projectId, organizationId },
			refetchInterval: (query) => {
				const status = query.state.data?.review?.status as
					| ScanStatus
					| undefined;
				return isScanActive(status) ? 3000 : false;
			},
		}),
	);

	const review = latestReviewQuery.data?.review ?? null;
	const reviewRunning = isScanActive(review?.status);

	const startMutation = useMutation(
		orpc.projects.scan.review.start.mutationOptions({
			onSuccess: () => {
				setAwaitingResult(true);
				toast.info("Reviewing findings", {
					description:
						"We'll surface suggestions for your review when it's ready.",
				});
				latestReviewQuery.refetch();
			},
			onError: (error) => {
				toast.error(`Couldn't start the review: ${error.message}`);
			},
		}),
	);

	const applyMutation = useMutation(
		orpc.projects.scan.review.apply.mutationOptions({
			onSuccess: (result) => {
				const applied = result.applied ?? 0;
				toast.success(
					applied === 0
						? "No changes applied"
						: `Applied ${applied} change${applied === 1 ? "" : "s"}`,
				);
				queryClient.invalidateQueries({
					queryKey: orpc.projects.scan.findings.list.key(),
				});
				setDialogOpen(false);
			},
			onError: (error) => {
				toast.error(`Couldn't apply changes: ${error.message}`);
			},
		}),
	);

	// Cancel a running review (G7) — stops waiting on the worker's own timeout.
	// On success: stop awaiting the result, refetch the latest review (it flips
	// terminal), and refresh findings (nothing was applied, but keep views fresh).
	const cancelMutation = useMutation(
		orpc.projects.scan.review.cancel.mutationOptions({
			onSuccess: () => {
				setAwaitingResult(false);
				// Don't pop the (now-stale) result toast for a review we cancelled.
				if (review) {
					announcedRef.current = `${review.id}:FAILED`;
				}
				toast.success("Review cancelled");
				latestReviewQuery.refetch();
				queryClient.invalidateQueries({
					queryKey: orpc.projects.scan.findings.list.key(),
				});
			},
			onError: (error) => {
				toast.error(`Couldn't cancel the review: ${error.message}`);
			},
		}),
	);

	// Announce + open the dialog once when a review the user kicked off settles.
	useEffect(() => {
		if (!review || !awaitingResult) {
			return;
		}
		if (review.status !== "COMPLETED" && review.status !== "FAILED") {
			return;
		}
		// Ignore the review that was already the latest when the user clicked —
		// only announce the review THIS click started (a new run always has a new
		// id). Guards the stale-prior-review flash (and stale apply) on a fresh
		// mount.
		if (review.id === baselineReviewIdRef.current) {
			return;
		}
		const key = `${review.id}:${review.status}`;
		if (announcedRef.current === key) {
			return;
		}
		announcedRef.current = key;
		setAwaitingResult(false);
		if (review.status === "FAILED") {
			toast.error("Review couldn't finish", {
				description:
					(review.error as string | null) ??
					"Please try the review again.",
			});
			return;
		}
		const suggestions = (review.proposals ?? []).filter(
			(p) => p.suggestedStatus || p.suggestedSeverity,
		).length;
		toast.success(
			suggestions === 0
				? "Review complete — no changes suggested"
				: `Review complete — ${suggestions} suggestion${
						suggestions === 1 ? "" : "s"
					} ready`,
		);
		setDialogOpen(true);
	}, [review, awaitingResult]);

	const handleApply = (decisions: ReviewDecision[]) => {
		if (!review) {
			return;
		}
		applyMutation.mutate({
			projectId,
			organizationId,
			reviewId: review.id,
			decisions,
		});
	};

	const handleCancel = () => {
		if (!review) {
			return;
		}
		cancelMutation.mutate({
			projectId,
			organizationId,
			reviewId: review.id,
		});
	};

	const busy = reviewRunning || startMutation.isPending || awaitingResult;
	const noOpenFindings = openFindingCount === 0;
	const disabled = busy || noOpenFindings;

	const button = (
		<Button
			variant="outline"
			onClick={() => {
				// Snapshot the currently-latest review id BEFORE starting, so the
				// settle-effect can tell the previous review apart from the one
				// this click creates.
				baselineReviewIdRef.current = review?.id ?? null;
				startMutation.mutate({ projectId, organizationId });
			}}
			disabled={disabled}
			className="gap-2"
			aria-label="Review open findings for false positives"
		>
			{busy ? (
				<Loader2Icon
					aria-hidden="true"
					className="size-4 motion-safe:animate-spin"
				/>
			) : (
				<SparklesIcon aria-hidden="true" className="size-4" />
			)}
			{busy ? "Reviewing…" : "Review findings"}
		</Button>
	);

	return (
		<>
			{/* Informational tooltip on the trigger. When there are no open
			    findings the button is disabled, so the tooltip explains why (and
			    how to re-enable); otherwise it describes what the review does. The
			    span keeps the tooltip reachable while the button is disabled. */}
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="inline-flex">{button}</span>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs">
					{noOpenFindings
						? "No open findings to review. Run a scan or reopen a finding first."
						: REVIEW_TOOLTIP_COPY}
				</TooltipContent>
			</Tooltip>

			{/* Cancel a running review without waiting on the worker's timeout. */}
			{reviewRunning ? (
				<Button
					variant="ghost"
					size="sm"
					onClick={handleCancel}
					disabled={cancelMutation.isPending}
					className="gap-1.5 text-muted-foreground"
					aria-label="Cancel the running review"
				>
					{cancelMutation.isPending ? (
						<Loader2Icon
							aria-hidden="true"
							className="size-4 motion-safe:animate-spin"
						/>
					) : (
						<XIcon aria-hidden="true" className="size-4" />
					)}
					Cancel
				</Button>
			) : null}

			{/* Let the user reopen the last completed review's suggestions
			    without re-running it. */}
			{!busy &&
			review?.status === "COMPLETED" &&
			(review.proposals?.length ?? 0) > 0 ? (
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setDialogOpen(true)}
					className="text-muted-foreground"
				>
					View last review
				</Button>
			) : null}

			<ReviewProposalsDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				review={review}
				getFindingTitle={getFindingTitle}
				isApplying={applyMutation.isPending}
				onApply={handleApply}
			/>
		</>
	);
}
