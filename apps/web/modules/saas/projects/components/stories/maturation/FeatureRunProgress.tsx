"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { CircleSlashIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";

/**
 * The run this feature just started, while it is still running.
 *
 * The feature's QA tab could dispatch a run and then show nothing: a Fabric run
 * reaches the panel below only once it has finished and been ingested, so the
 * surface where somebody pressed the button had no progress, no counters and no
 * way to stop it. Pressing Run and watching nothing happen is indistinguishable
 * from pressing a broken button.
 *
 * Deliberately narrow. It follows the run started FROM HERE, by id, rather than
 * listing this feature's run history — the runs query is project-scoped with no
 * per-feature filter, and inventing one to show history is a bigger change than
 * the problem needs. History stays where it already is, on the project's Runs
 * segment; this closes the gap between pressing the button and the result
 * appearing.
 */

const IN_FLIGHT = new Set(["QUEUED", "RUNNING"]);

/** Matches the project panel: frequent enough not to look stuck, cheap enough to idle. */
const POLL_MS = 4000;

const TONE: Record<string, string> = {
	QUEUED: "text-muted-foreground",
	RUNNING: "text-highlight",
	PASSED: "text-secondary",
	FAILED: "text-destructive",
	BLOCKED: "text-highlight",
	NEEDS_REVIEW: "text-highlight",
	CANCELLED: "text-muted-foreground",
	REFUSED: "text-destructive",
};

export function FeatureRunProgress({
	projectId,
	runId,
	onDismiss,
}: {
	projectId: string;
	/** The run dispatched from this tab, or null when none has been started. */
	runId: string | null;
	/** Called once the reader has seen a finished run and closes it. */
	onDismiss: () => void;
}) {
	const queryClient = useQueryClient();

	const runQuery = useQuery({
		...orpc.projects.agenticRuns.get.queryOptions({
			input: { projectId, runId: runId ?? "" },
		}),
		enabled: runId !== null,
		// Stop polling the moment it reaches a terminal status — an idle tab on a
		// finished run should cost nothing.
		refetchInterval: (query) => {
			const status = (
				query.state.data as { run?: { status?: string } } | undefined
			)?.run?.status;
			return status && IN_FLIGHT.has(status) ? POLL_MS : false;
		},
	});

	const cancelMutation = useMutation(
		orpc.projects.agenticRuns.cancel.mutationOptions({
			onSuccess: () => {
				toast.success("Cancelling — steps already run are kept");
				queryClient.invalidateQueries({
					queryKey: orpc.projects.agenticRuns.get.key(),
				});
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	if (runId === null) {
		return null;
	}

	const run = runQuery.data?.run;
	if (!run) {
		return (
			<div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-xs">
				<Loader2Icon
					className="size-3.5 motion-safe:animate-spin"
					aria-hidden="true"
				/>
				Starting the run…
			</div>
		);
	}

	const inFlight = IN_FLIGHT.has(run.status);
	const counts = [
		run.passedCount != null ? `${run.passedCount} passed` : null,
		run.failedCount ? `${run.failedCount} failed` : null,
		run.blockedCount ? `${run.blockedCount} blocked` : null,
		run.needsReviewCount ? `${run.needsReviewCount} to review` : null,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<div
			className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs"
			// Announced rather than silent: the counters change while the reader
			// is looking elsewhere on the page.
			aria-live="polite"
		>
			{inFlight && (
				<Loader2Icon
					className="size-3.5 motion-safe:animate-spin text-highlight"
					aria-hidden="true"
				/>
			)}
			<span className={`font-medium ${TONE[run.status] ?? ""}`}>
				{run.status === "NEEDS_REVIEW" ? "NEEDS REVIEW" : run.status}
			</span>
			{counts && <span className="text-muted-foreground">{counts}</span>}
			{run.refusalReason && (
				<span className="text-destructive">{run.refusalReason}</span>
			)}
			<div className="ml-auto flex items-center gap-2">
				{inFlight ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={cancelMutation.isPending}
						onClick={() =>
							cancelMutation.mutate({ projectId, runId: run.id })
						}
						className="gap-1.5"
					>
						<CircleSlashIcon
							className="size-3.5"
							aria-hidden="true"
						/>
						Stop
					</Button>
				) : (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={onDismiss}
					>
						Dismiss
					</Button>
				)}
			</div>
		</div>
	);
}
