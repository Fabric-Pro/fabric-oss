"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";

/**
 * Whether a work item may be offered the per-item AI re-assess affordance —
 * the client-side mirror of `reprioritizeStory`'s eligibility rule: hidden
 * (CLOSED) and DECLINED stages are out, and so are items sitting in a final
 * status. The server refuses all three regardless; this only decides whether
 * to SHOW the control, so a click can never end in a "not re-prioritized"
 * error for a state the UI could see coming.
 *
 * Completion lives on the project's status list, which the roadmap surfaces
 * have already fetched — there the query here dedupes into that cache; on the
 * detail page it is one small query of its own. Never per-row requests: every
 * consumer shares one query key. While the list is still
 * loading, the answer is optimistic (stage-only): a brief affordance on a
 * completed item beats hiding the control from everyone on first paint, and
 * the server guard stays the hard rule.
 */
export function useAiReassessEligibility({
	projectId,
	organizationId,
	draftingStage,
	statusId,
}: {
	projectId: string;
	organizationId: string | null;
	draftingStage: string | null | undefined;
	statusId: string | null | undefined;
}): boolean {
	// `select` narrows the tracked data to this row's boolean, so a statuses
	// change only notifies rows whose eligibility actually flipped — without it,
	// one workflow edit re-renders every subscribed row on a large board.
	const { data: isComplete } = useQuery({
		...orpc.projects.stories.statuses.list.queryOptions({
			input: { projectId, organizationId },
		}),
		staleTime: 60 * 1000,
		select: (data: { statuses?: { id: string; isFinal: boolean }[] }) =>
			data.statuses?.some(
				(status) => status.isFinal && status.id === statusId,
			) ?? false,
	});

	if (draftingStage === "CLOSED" || draftingStage === "DECLINED") {
		return false;
	}
	return !(isComplete ?? false);
}
