"use client";

import type { JobListItem } from "@saas/jobs/hooks/use-jobs";
import { formatDistanceToNow } from "date-fns";
import { CheckIcon } from "lucide-react";

/**
 * What the last finished scan of one connection row actually found.
 *
 * Exists because a scan that finds nothing was indistinguishable from a scan
 * that never ran. "Monitor now" starts a workflow and returns, the running
 * indicator disappears the moment it ends, and the only number on the row
 * counts analyzed threads — so a run that examined three messages and had
 * nothing to propose still displayed a zero, and a run that examined nothing at
 * all displayed the same zero. Both read as broken. Saying "no new messages"
 * out loud is the whole fix.
 *
 * Renders nothing until a scan has finished, so a freshly linked row keeps the
 * layout it has always had.
 */
export function LastScanSummary({ job }: { job?: JobListItem }) {
	if (!job || job.status === "RUNNING") {
		return null;
	}

	if (job.status === "FAILED") {
		// The row already carries a red failure box with the real reason; a
		// second, vaguer copy of it here would only compete with that.
		return null;
	}

	const scanned = job.counts?.messagesScanned ?? 0;
	const proposals = job.counts?.proposalsCreated ?? 0;

	const plural = (n: number, word: string) =>
		`${n} ${word}${n === 1 ? "" : "s"}`;

	const summary =
		scanned === 0
			? "no new messages"
			: `${plural(scanned, "new message")} · ${plural(proposals, "proposal")}`;

	const when = job.completedAt
		? formatDistanceToNow(new Date(job.completedAt), { addSuffix: true })
		: null;

	return (
		<span className="flex items-center gap-1">
			<CheckIcon className="size-3" aria-hidden="true" />
			<span className="tabular-nums">
				Last scan{when ? ` ${when}` : ""}: {summary}
			</span>
		</span>
	);
}
