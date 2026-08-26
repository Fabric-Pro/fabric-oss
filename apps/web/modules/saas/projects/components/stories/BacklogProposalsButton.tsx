"use client";

/**
 * BacklogProposalsButton
 *
 * Roadmap toolbar control that opens the reviewer's Rejected proposals across
 * every source. Rendered as a quiet icon-only button with a
 * tooltip (no visible count) so it stays unobtrusive. It appears only when the
 * reviewer has at least one rejected proposal; clicking opens the proposals
 * inbox focused on the Rejected proposals list.
 *
 * This is the reviewer's way back to a deferred proposal FROM the roadmap — it
 * is deliberately independent of the pending-proposals pill, which disappears
 * once the active queue empties. A reviewer who moved everything to Rejected
 * (pending count 0) can still reach those proposals here.
 *
 * Design: quiet, neutral (muted) archive icon — a rejected proposal is
 * deferred, not urgent, so it must NOT compete with the amber "Review N proposals"
 * needs-attention pill. No visible count and no ambient/looping motion — the
 * icon + tooltip is the whole affordance.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { ArchiveIcon } from "lucide-react";

type Props = {
	projectId: string;
	organizationId: string | null;
	onOpenBacklog: () => void;
};

export function BacklogProposalsButton({
	projectId,
	organizationId,
	onOpenBacklog,
}: Props) {
	const { data } = useQuery({
		// Key mirrors the invalidation in PendingBacklogProposalsInbox so
		// moving a proposal into or out of Rejected updates this button live.
		queryKey: [
			"projects.backlog.proposals.backlogCount",
			projectId,
			organizationId,
		],
		queryFn: async () => {
			const result =
				await orpcClient.projects.backlog.proposals.backlogCount({
					projectId,
					organizationId,
				});
			return result as { count: number };
		},
		refetchInterval: 30_000,
		refetchOnWindowFocus: true,
	});

	const count = data?.count ?? 0;

	if (count === 0) {
		return null;
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					onClick={onOpenBacklog}
					className="text-muted-foreground hover:text-foreground"
					aria-label="View rejected proposals"
				>
					<ArchiveIcon className="size-4" />
				</Button>
			</TooltipTrigger>
			<TooltipContent>
				Rejected proposals — recover or permanently delete dismissed
				proposals
			</TooltipContent>
		</Tooltip>
	);
}
