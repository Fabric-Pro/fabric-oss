"use client";

import { formatDistanceToNow } from "date-fns";
import { CheckCircle2Icon, ClockIcon, TriangleAlertIcon } from "lucide-react";
import {
	formatPmStatusSyncFetch,
	formatPmStatusSyncOutcomes,
	type PmStatusSyncRunView,
} from "../../lib/pm-status-sync-last-run";

const STATUS_SYNC_FAILURE_COPY: Record<
	"fetch-failed" | "source-not-found",
	string
> = {
	"fetch-failed": "the ticket fetch failed",
	"source-not-found":
		"the PM connection could not be resolved, so the project was skipped",
};

/**
 * "Last status sync" (spec AC13): the hourly status sync's last run for the
 * current session. A failure never reads as healthy and silence never reads as
 * fine, nor does a fetch whose outcome never arrived (`outcome-overdue`) — see
 * `derivePmStatusSyncRunView`. A stale outcome (recorded before the
 * current fetch) is already stripped out of `view.run` by that derivation, so
 * this component only ever renders counts from the current cycle.
 */
export function PmStatusSyncLastRunLine({
	view,
}: {
	view: PmStatusSyncRunView;
}) {
	if (view.kind === "waiting") {
		return (
			<p className="flex items-center gap-1.5 text-muted-foreground text-xs">
				<ClockIcon className="size-3.5" aria-hidden />
				Last status sync: not run yet — the first check runs within the
				hour.
			</p>
		);
	}

	if (view.kind === "unreadable") {
		return (
			<p className="flex items-center gap-1.5 text-highlight text-xs">
				<TriangleAlertIcon className="size-3.5" aria-hidden />
				Last status sync: unreadable — the stored summary could not be
				read.
			</p>
		);
	}

	const relative = formatDistanceToNow(view.at, { addSuffix: true });

	if (view.kind === "failed") {
		return (
			<div className="space-y-0.5 text-destructive text-xs">
				<p className="flex items-center gap-1.5">
					<TriangleAlertIcon className="size-3.5" aria-hidden />
					{`Last status sync failed ${relative}: ${STATUS_SYNC_FAILURE_COPY[view.reason]}.`}
				</p>
				<p className="text-muted-foreground">{view.error}</p>
			</div>
		);
	}

	if (view.kind === "outcome-overdue") {
		// Reconcile never recorded this fetch's outcome: the tickets were read
		// but not applied. Never shown as healthy (AC13).
		return (
			<div className="space-y-0.5 text-highlight text-xs">
				<p className="flex items-center gap-1.5">
					<TriangleAlertIcon className="size-3.5" aria-hidden />
					{`Status sync fetched tickets ${relative} but has not applied them yet.`}
				</p>
				{view.run.fetch ? (
					<p>{formatPmStatusSyncFetch(view.run.fetch)}</p>
				) : null}
			</div>
		);
	}

	const run = view.run;
	if (run === null) {
		return (
			<p className="flex items-center gap-1.5 text-highlight text-xs">
				<TriangleAlertIcon className="size-3.5" aria-hidden />
				{`Last status sync: none since it was turned on ${relative} — overdue`}
			</p>
		);
	}

	const overdue = view.kind === "stale";
	return (
		<div
			className={
				overdue
					? "space-y-0.5 text-highlight text-xs"
					: "space-y-0.5 text-muted-foreground text-xs"
			}
		>
			<p className="flex items-center gap-1.5">
				{overdue ? (
					<TriangleAlertIcon className="size-3.5" aria-hidden />
				) : (
					<CheckCircle2Icon
						className="size-3.5 text-success"
						aria-hidden
					/>
				)}
				{overdue
					? `Last status sync ${relative} — overdue`
					: `Last status sync ${relative}`}
			</p>
			{run.fetch ? <p>{formatPmStatusSyncFetch(run.fetch)}</p> : null}
			{run.outcome ? (
				<p>{formatPmStatusSyncOutcomes(run.outcome.counts)}</p>
			) : null}
		</div>
	);
}
