import { orpc } from "@shared/lib/orpc-query-utils";
import type { QueryClient } from "@tanstack/react-query";

/**
 * A provider refresh answers before the backend has finished folding the
 * result in (it settles a few seconds later), so a single read right after
 * the answer can still show the old state. These follow-up reads catch the
 * settled state without leaving a poll running.
 */
const PROPOSAL_REFRESH_FOLLOW_UP_MS = [3_000, 8_000, 15_000] as const;

/**
 * Every read the proposals dialog renders from: the suggestion list and its
 * detail, the member's own branch, and the reviewer aggregate of branches.
 * They describe one piece of delivery state, so they are always re-read
 * together.
 */
export function invalidateProposalViews(
	queryClient: QueryClient,
): Promise<void> {
	const { proposals } = orpc.projects.instructions;
	return Promise.all(
		[
			proposals.list.key(),
			proposals.get.key(),
			proposals.myBranch.key(),
			proposals.branches.key(),
		].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
	).then(() => undefined);
}

export function invalidateProposalViewsAfterRefresh(
	queryClient: QueryClient,
): Promise<void> {
	for (const delay of PROPOSAL_REFRESH_FOLLOW_UP_MS) {
		setTimeout(() => {
			void invalidateProposalViews(queryClient);
		}, delay);
	}
	return invalidateProposalViews(queryClient);
}
