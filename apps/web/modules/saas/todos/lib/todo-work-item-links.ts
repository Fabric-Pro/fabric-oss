"use client";

/**
 * One to-do's work items, and the two ways a person can answer for them
 * (Fizzy #2340).
 *
 * THE READ IS LAZY ON PURPOSE. `enabled` is the row's own disclosure state, so
 * nothing is asked until somebody opens the panel. The To Do page is built to
 * span every project a person can reach, so a read mounted with the row would
 * be one request per row on first paint — for an answer that is empty for most
 * of them.
 *
 * THE WRITE IS THE DIGEST'S WRITE. `todos.proposals.manageLink` delegates to
 * the same two writers the meeting digest uses, and rejecting leaves the same
 * DISMISSED tombstone. That is what keeps the two surfaces from disagreeing,
 * and it is why this hook refreshes the panel from the SERVER rather than
 * editing the list it is holding: the answer after a rejection is not always
 * "the row is gone". A work item an approved proposal produced still exists
 * once its link is tombstoned, and the read still returns it — unlinked. Only
 * the server knows which of the two happened.
 *
 * ONE CALL PER WORK ITEM AT A TIME, guarded by a ref checked in the same
 * synchronous turn as the click, for the reason `todo-row-actions.ts` records:
 * `disabled` driven from state is not enough, because two clicks inside one
 * React batch both read the pre-render value.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { invalidateTodoLinkedWorkItems } from "./todo-proposals-api";
import { useInFlightGuard } from "./use-in-flight-guard";

const T = "todos.list";

/** A feature or bug this to-do's meeting item produced or points at. */
export interface TodoWorkItem {
	storyId: string;
	identifier: string;
	title: string;
	kind: "FEATURE" | "BUG";
	statusName: string | null;
	isDone: boolean;
	/**
	 * The link row backing this work item, or null.
	 *
	 * Null is not an anomaly. A proposal approved while the linking flag was
	 * off created the work item and wrote no link, and a link the person has
	 * just rejected is tombstoned rather than deleted — both leave a real work
	 * item with no live tie. Accepting is what writes one.
	 */
	linkId: string | null;
	origin: "AUTO" | "MANUAL" | "CREATED" | null;
	confidence: number | null;
	/** True when an approved proposal filed from this to-do produced it. */
	fromProposal: boolean;
}

/** What the read answers, whether or not anything is linked. */
interface TodoLinkedWorkItems {
	todoId: string;
	transcriptRef: string | null;
	projectId: string | null;
	/** False when `MEETING_ACTION_ITEM_LINKING` is off — a normal state. */
	linkingEnabled: boolean;
	resolvedVia: "itemKey" | "actionItemId" | null;
	/** The binding no longer resolves to a live item, so links cannot change. */
	isOrphaned: boolean;
	items: TodoWorkItem[];
}

export interface UseTodoWorkItemLinksResult {
	data: TodoLinkedWorkItems | null;
	isPending: boolean;
	isError: boolean;
	/** A link write is in flight for this work item. */
	isBusy: (storyId: string) => boolean;
	accept: (storyId: string) => void;
	reject: (storyId: string) => void;
}

export function useTodoWorkItemLinks(params: {
	organizationId: string | null;
	todoId: string;
	/** The row's disclosure state — nothing is read while this is false. */
	enabled: boolean;
}): UseTodoWorkItemLinksResult {
	const { organizationId, todoId, enabled } = params;
	const t = useTranslations();
	const queryClient = useQueryClient();

	const query = useQuery(
		orpc.todos.proposals.linkedWorkItems.queryOptions({
			input: { organizationId, todoId },
			enabled,
		}),
	);

	const { busyIds: busyStoryIds, claim, release } = useInFlightGuard();

	const mutation = useMutation({
		mutationFn: (variables: {
			storyId: string;
			action: "accept" | "reject";
		}) =>
			orpc.todos.proposals.manageLink.call({
				organizationId,
				todoId,
				storyId: variables.storyId,
				action: variables.action,
			}),
		onSuccess: async () => {
			// AWAITED, so the refetched answer has landed before the controls
			// come back: the panel must never show the old tie for a beat
			// after the person removed it. Derived from the read's own key —
			// see `todo-proposals-api.ts` for what a hand-built one costs.
			await invalidateTodoLinkedWorkItems(queryClient, todoId);
		},
		onError: (_error, variables) => {
			// Nothing was written and the chip stays exactly where it was, so
			// without this the click reads as a no-op and gets repeated.
			toast.error(
				t(
					variables.action === "accept"
						? `${T}.proposals.links.errors.accept`
						: `${T}.proposals.links.errors.reject`,
				),
			);
		},
		onSettled: (_data, _error, variables) => release(variables.storyId),
	});

	const accept = useCallback(
		(storyId: string) => {
			if (!claim(storyId)) {
				return;
			}
			mutation.mutate({ storyId, action: "accept" });
		},
		[claim, mutation],
	);

	const reject = useCallback(
		(storyId: string) => {
			if (!claim(storyId)) {
				return;
			}
			mutation.mutate({ storyId, action: "reject" });
		},
		[claim, mutation],
	);

	return useMemo(
		() => ({
			data: (query.data as TodoLinkedWorkItems | undefined) ?? null,
			// `isPending` is true for an idle disabled query too, which would
			// render a skeleton under a panel nobody opened; the row only
			// waits once it has actually asked.
			isPending: enabled && query.isPending,
			isError: query.isError,
			isBusy: (storyId: string) => busyStoryIds.includes(storyId),
			accept,
			reject,
		}),
		[
			accept,
			busyStoryIds,
			enabled,
			query.data,
			query.isError,
			query.isPending,
			reject,
		],
	);
}
