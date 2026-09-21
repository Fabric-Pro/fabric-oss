"use client";

/**
 * Feature-proposal state on the To Do page: the keys, the refresh, and the one
 * link out to the inbox (Fizzy #2340).
 *
 * WHY THE KEYS LIVE HERE AND ARE DERIVED. Three query-key shapes coexist in
 * this app — hand-written tuples (`["todos", "proposals", …]`), oRPC's
 * generated `[path, { input, type }]` pairs, and the older `queryKey()` helper
 * form. A filter written in the wrong one of the three matches NOTHING, and
 * `invalidateQueries` reports no error: the panel simply never refreshes, and
 * the bug reads as a stale server rather than as a typo. `todos-api.ts` records
 * the same lesson for the list read; this is its half for the proposals group.
 *
 * THE ONE KEY HERE IS SCOPED TO A ROW, and that is deliberate:
 *
 *  - The pending-proposals indicator has no key export yet, because nothing on
 *    this page changes a proposal's review status — approving happens in the
 *    inbox this links out to. Whatever first needs to refresh it must derive
 *    its filter from `orpc.todos.proposals.pendingMeetings.key()` rather than
 *    spell one out.
 *  - `todoLinkedWorkItemsQueryKey(todoId)` carries `{ input: { todoId } }`.
 *    TanStack's partial match is a recursive SUBSET comparison, so it matches
 *    the row's real query whatever else its input carried (`organizationId` as
 *    a string, `null`, or omitted) while leaving every OTHER row's panel alone.
 *    Rejecting a link on one row must not refetch a hundred sibling panels.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

/**
 * How a link addresses the Feature Proposals inbox.
 *
 * The inbox is a drawer on the project's Roadmap with no route of its own, so
 * `?inbox=proposals` is the only way to point at it; `StoriesRoadmap` consumes
 * the param once and strips it. Written out here rather than imported from the
 * roadmap's own route helpers because that module exports no builder for this
 * destination — only the Contexts tab's hand-rolled string, which this matches.
 */
const PROPOSAL_INBOX_QUERY = "tab=stories&inbox=proposals";

/** `/app/<slug>/projects/<id>?tab=stories&inbox=proposals`. */
export function buildProposalInboxHref(params: {
	basePath: string;
	projectId: string;
}): string {
	return `${params.basePath}/projects/${encodeURIComponent(params.projectId)}?${PROPOSAL_INBOX_QUERY}`;
}

export const todoLinkedWorkItemsQueryKey = (todoId: string) =>
	orpc.todos.proposals.linkedWorkItems.key({ input: { todoId } });

/**
 * Refresh one row's work items — never every row's.
 *
 * The only place a link write says "this row's panel is now wrong". It exists
 * so no caller ever writes a filter of its own, and it is awaited by its
 * caller so the refetched answer has landed before the row's controls come
 * back to life.
 */
export const invalidateTodoLinkedWorkItems = (
	queryClient: QueryClient,
	todoId: string,
) =>
	queryClient.invalidateQueries({
		queryKey: todoLinkedWorkItemsQueryKey(todoId),
	});

/** One meeting with something waiting in its Feature Proposals inbox. */
export interface PendingProposalMeeting {
	/** The Graph transcript id — never the transcript row cuid. */
	transcriptRef: string;
	/** Where the inbox lives, so the header can link straight into it. */
	projectId: string;
	pendingCount: number;
}

/**
 * The read's own ceiling on `transcriptRefs`. Asking for more is a 400, so the
 * page asks about the first hundred meetings rather than losing the indicator
 * for all of them on an unusually broad page.
 */
const MAX_TRANSCRIPT_REFS = 100;

/**
 * Keyed on the (meeting, project) PAIR, exactly as the read answers.
 *
 * Two projects can monitor the same meeting and their inboxes are separate
 * queues reviewed by different people, so a map keyed on the transcript ref
 * alone would show one project's count on the other project's heading.
 */
export const pendingMeetingKey = (transcriptRef: string, projectId: string) =>
	`${transcriptRef}::${projectId}`;

const NO_MEETINGS: PendingProposalMeeting[] = [];

/**
 * Which of the meetings on screen have proposals awaiting review.
 *
 * ONE QUERY FOR THE WHOLE PAGE, asked by the list body rather than by each
 * heading: the answer is about a SET of meetings, and a query per group would
 * be one request per meeting on a page built to span every project.
 *
 * NOT BEHIND THE LINKING FLAG. `MEETING_ACTION_ITEM_LINKING` gates links
 * between an action item and a work item; this counts proposals in a review
 * queue that has always existed. Turning the linking rollout off must not take
 * the inbox's indicator with it.
 */
export function usePendingProposalMeetings(params: {
	organizationId: string | null;
	/** The `meetingTranscriptRef` of every meeting group currently rendered. */
	transcriptRefs: readonly string[];
}): Map<string, PendingProposalMeeting> {
	const { organizationId, transcriptRefs } = params;

	const refs = useMemo(
		() => [...new Set(transcriptRefs)].slice(0, MAX_TRANSCRIPT_REFS),
		[transcriptRefs],
	);

	const { data } = useQuery(
		orpc.todos.proposals.pendingMeetings.queryOptions({
			input: { organizationId, transcriptRefs: refs },
			// The read demands at least one ref, so a page of purely manual
			// to-dos asks nothing rather than sending a request it knows is a
			// validation error.
			enabled: refs.length > 0,
		}),
	);

	return useMemo(() => {
		const byMeeting = new Map<string, PendingProposalMeeting>();
		for (const meeting of data?.meetings ?? NO_MEETINGS) {
			byMeeting.set(
				pendingMeetingKey(meeting.transcriptRef, meeting.projectId),
				meeting,
			);
		}
		return byMeeting;
	}, [data]);
}
