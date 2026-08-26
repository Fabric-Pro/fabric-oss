"use client";

/**
 * "Group into tickets" control — starts an on-demand run of the security/
 * accessibility finding-grouping pipeline: every OPEN finding from the latest
 * completed scan is grouped by theme (`category` + `ruleSource`), drafted into
 * a proposed ticket, and surfaced for review.
 *
 * The run PROPOSES tickets and ends at AWAITING_REVIEW — nothing is written
 * until the user accepts in {@link GroupingResultsDialog}. This button:
 *   1. Click → `scan.grouping.start` (server dedupes against an in-flight run).
 *   2. Poll `scan.grouping.latest` while the run is working (PENDING / RUNNING /
 *      APPLYING), button shows "Grouping…".
 *   3. On AWAITING_REVIEW → open the review dialog. On FAILED → error toast.
 *
 * Project-wide over ALL current open findings (gated on `openFindingCount`, no
 * manual selection) — unrelated to `ScanFindingsList`'s checkbox bulk actions.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Loader2Icon, TicketIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { GroupingResultsDialog } from "./GroupingResultsDialog";
import { type GroupingRunStatus, isGroupingRunning } from "./lib";

const GROUPING_TOOLTIP_COPY =
	"Groups your open Security and Accessibility findings by theme into backlog tickets — one ticket per theme. You review and choose which to create before anything is written; nothing is duplicated on a rerun.";

export function GroupIntoTicketsButton({
	projectId,
	organizationId,
	openFindingCount,
}: {
	projectId: string;
	organizationId: string | null;
	/** Open-finding count — gates the button (nothing to group at 0). */
	openFindingCount: number;
}) {
	const [dialogOpen, setDialogOpen] = useState(false);
	const [awaitingResult, setAwaitingResult] = useState(false);
	const announcedRef = useRef<string | null>(null);
	// The id of whatever run was already the latest when the user clicked, so the
	// settle-effect can tell it apart from the run this click starts.
	const baselineRunIdRef = useRef<string | null>(null);

	const latestGroupingQuery = useQuery(
		orpc.projects.scan.grouping.latest.queryOptions({
			input: { projectId, organizationId },
			refetchInterval: (query) => {
				const status = query.state.data?.grouping?.status as
					| GroupingRunStatus
					| undefined;
				return isGroupingRunning(status) ? 3000 : false;
			},
		}),
	);

	const grouping = latestGroupingQuery.data?.grouping ?? null;
	const status = grouping?.status as GroupingRunStatus | undefined;
	const groupingRunning = isGroupingRunning(status);
	const awaitingReview = status === "AWAITING_REVIEW";

	const startMutation = useMutation(
		orpc.projects.scan.grouping.start.mutationOptions({
			onSuccess: () => {
				setAwaitingResult(true);
				toast.info("Preparing tickets to review…", {
					description: "We'll open the review when they're ready.",
				});
				latestGroupingQuery.refetch();
			},
			onError: (error) => {
				toast.error(`Couldn't start grouping: ${error.message}`);
			},
		}),
	);

	const cancelMutation = useMutation(
		orpc.projects.scan.grouping.cancel.mutationOptions({
			onSuccess: () => {
				setAwaitingResult(false);
				if (grouping) {
					announcedRef.current = `${grouping.id}:FAILED`;
				}
				toast.success("Grouping cancelled");
				latestGroupingQuery.refetch();
			},
			onError: (error) => {
				toast.error(`Couldn't cancel grouping: ${error.message}`);
			},
		}),
	);

	// Open the review dialog once when a run the user started reaches review.
	useEffect(() => {
		if (!grouping || !awaitingResult) {
			return;
		}
		const settledStatus = grouping.status;
		if (
			settledStatus !== "AWAITING_REVIEW" &&
			settledStatus !== "FAILED" &&
			settledStatus !== "COMPLETED"
		) {
			return;
		}
		if (grouping.id === baselineRunIdRef.current) {
			return;
		}
		const key = `${grouping.id}:${settledStatus}`;
		if (announcedRef.current === key) {
			return;
		}
		announcedRef.current = key;
		setAwaitingResult(false);
		if (settledStatus === "FAILED") {
			toast.error("Grouping couldn't finish", {
				description:
					grouping.error ?? "Please try grouping findings again.",
			});
			return;
		}
		setDialogOpen(true);
	}, [grouping, awaitingResult]);

	const handleCancel = () => {
		if (!grouping) {
			return;
		}
		cancelMutation.mutate({
			projectId,
			organizationId,
			groupingId: grouping.id,
		});
	};

	const busy = groupingRunning || startMutation.isPending || awaitingResult;
	const noOpenFindings = openFindingCount === 0;
	// A run awaiting review blocks starting a new one (server would CONFLICT) —
	// steer the user to the review instead.
	const disabled = busy || noOpenFindings || awaitingReview;

	const button = (
		<Button
			variant="outline"
			onClick={() => {
				baselineRunIdRef.current = grouping?.id ?? null;
				startMutation.mutate({ projectId, organizationId });
			}}
			disabled={disabled}
			className="gap-2"
			aria-label="Group open findings into thematic tickets"
		>
			{busy ? (
				<Loader2Icon
					aria-hidden="true"
					className="size-4 motion-safe:animate-spin"
				/>
			) : (
				<TicketIcon aria-hidden="true" className="size-4" />
			)}
			{busy ? "Grouping…" : "Group into tickets"}
		</Button>
	);

	const tooltipCopy = awaitingReview
		? "You have tickets waiting for review — open the review to create or dismiss them first."
		: noOpenFindings
			? "No open findings to group into tickets."
			: GROUPING_TOOLTIP_COPY;

	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="inline-flex">{button}</span>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs">
					{tooltipCopy}
				</TooltipContent>
			</Tooltip>

			{groupingRunning ? (
				<Button
					variant="ghost"
					size="sm"
					onClick={handleCancel}
					disabled={cancelMutation.isPending}
					className="gap-1.5 text-muted-foreground"
					aria-label="Cancel the running grouping"
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

			{/* Reopen the review for a run still awaiting a decision. */}
			{!busy && awaitingReview ? (
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setDialogOpen(true)}
					className="text-primary"
				>
					Review tickets
				</Button>
			) : null}

			{/* Reopen the last completed run's results. */}
			{!busy && status === "COMPLETED" ? (
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setDialogOpen(true)}
					className="text-muted-foreground"
				>
					View last run
				</Button>
			) : null}

			<GroupingResultsDialog
				grouping={grouping}
				isOpen={dialogOpen}
				onClose={() => setDialogOpen(false)}
				projectId={projectId}
				organizationId={organizationId}
			/>
		</>
	);
}
