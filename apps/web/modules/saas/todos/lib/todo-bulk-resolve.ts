"use client";

/**
 * Clearing a selection of to-dos in one act, and reporting what did not clear
 * (Fizzy #2340).
 *
 * `todos.bulkResolve` commits what it can and answers PER ROW, because the
 * list is a live view: a meeting re-processed between render and submit
 * replaces its action items wholesale, so ids the page is holding can simply
 * stop existing. That contract only pays for itself if the client keeps it. So
 * three rules live here, together, where they cannot drift apart:
 *
 *  1. A ROW THAT COMPLETED LEAVES. It drops out of the selection and out of
 *     the view. Locally, and not only by waiting for the refetch: the
 *     `ageHidden` view is built over the default view's set, which keeps the
 *     most recently completed rows, so a row this batch just completed can
 *     legitimately come BACK in the next response. Rendering it again, unticked
 *     and unexplained, would read as a write that did not happen.
 *  2. A ROW THAT DID NOT COMPLETE STAYS SELECTED, AND SAYS WHY. One reason per
 *     outcome, on the row. A single "some failed" toast leaves the person with
 *     a selection they cannot safely re-run and no way to see which rows still
 *     need them — which is the whole failure this per-row contract exists to
 *     avoid. Two of the three failures (`not_found`, `vanished`) describe a row
 *     that is GONE, so the refetch this batch triggers would take the row and
 *     its explanation away together and leave only a number in the bar. That is
 *     why the failed rows are snapshotted here and kept on screen until the
 *     next batch replaces them.
 *  3. THE SUMMARY IS THE SERVER'S OWN TALLY, and it stays until dismissed. It
 *     comes out of the same response as the per-row reasons, so the bar and the
 *     rows can never disagree; and it is a bar rather than a toast because a
 *     toast about a partially applied batch is gone before the person has
 *     finished reading which rows it was about.
 *
 * A toast is still right for TOTAL failure — nothing was written, there are no
 * per-row answers to show, and the selection is untouched and re-runnable.
 *
 * Every batch refreshes the list through `invalidateTodoList`, whose filter is
 * DERIVED from the read's own key. A hand-built `["todos","list"]` matches none
 * of the three key shapes in this app and `invalidateQueries` reports no error,
 * so that bug reads as a stale server rather than as a typo. The one
 * invalidation covers both reads that just became wrong: the hidden view this
 * acts on, and the default list whose `ageHiddenCount` has dropped.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { TodoListItem } from "./todo-list-model";
import { invalidateTodoList } from "./todos-api";

const T = "todos.list";

/**
 * What one row's write did — a CLOSED set, restated from the procedure.
 *
 * Restated rather than imported for the same reason `todo-list-model` restates
 * the row DTO: this module is the client's reading of the contract. It is kept
 * honest by `TodoBulkResolveResponse` below, which the procedure's inferred
 * response must be assignable to — add an outcome on the server and this file
 * stops compiling rather than quietly rendering a row with no reason on it.
 */
type TodoBulkResolveOutcome =
	| "completed"
	| "not_found"
	| "forbidden"
	| "vanished";

/** The outcomes that leave a row on screen, needing a person. */
export type TodoBulkResolveFailure = Exclude<
	TodoBulkResolveOutcome,
	"completed"
>;

export interface TodoBulkResolveRowResult {
	todoId: string;
	outcome: TodoBulkResolveOutcome;
}

/** The structural subset of `todos.bulkResolve`'s response this page reads. */
interface TodoBulkResolveResponse {
	results: readonly TodoBulkResolveRowResult[];
	counts: {
		requested: number;
		completed: number;
		notFound: number;
		forbidden: number;
		vanished: number;
	};
}

/** What the bar says: two numbers that add up to the batch. */
interface TodoBulkResolveSummary {
	completed: number;
	failed: number;
}

export interface TodoBulkResolvePartition {
	completedIds: string[];
	failures: Record<string, TodoBulkResolveFailure>;
}

/**
 * Split one response into "gone" and "still needs you".
 *
 * Pure, and exported, because it is the piece that decides what the person
 * sees after a partial batch — the one thing here worth pinning in a test
 * without a component around it.
 */
export function partitionBulkResolve(
	results: readonly TodoBulkResolveRowResult[],
): TodoBulkResolvePartition {
	const completedIds: string[] = [];
	const failures: Record<string, TodoBulkResolveFailure> = {};
	for (const result of results) {
		if (result.outcome === "completed") {
			completedIds.push(result.todoId);
			continue;
		}
		failures[result.todoId] = result.outcome;
	}
	return { completedIds, failures };
}

export interface UseTodoBulkResolveResult {
	/** Rows the person has ticked, including ones a batch could not resolve. */
	selectedIds: ReadonlySet<string>;
	/** Rows this session resolved: out of the selection, out of the view. */
	resolvedIds: ReadonlySet<string>;
	/** Why a still-selected row did not clear, by to-do id. */
	failures: Readonly<Record<string, TodoBulkResolveFailure>>;
	/**
	 * Those rows as the batch saw them, so one the read has since dropped is
	 * still on screen carrying its reason.
	 */
	failedRows: readonly TodoListItem[];
	/** The last batch's counts, until the person dismisses them. */
	summary: TodoBulkResolveSummary | null;
	dismissSummary: () => void;
	toggle: (todoId: string) => void;
	/** Select every loaded row, or — when they all already are — none. */
	toggleAll: (todoIds: readonly string[]) => void;
	isResolving: boolean;
	/**
	 * Resolve the current selection out of the rows on screen. A no-op while a
	 * batch is in flight. The rows are passed in so a failure can be shown
	 * after the read stops returning it.
	 */
	resolve: (rows: readonly TodoListItem[]) => void;
}

export function useTodoBulkResolve({
	organizationId,
}: {
	organizationId: string | null;
}): UseTodoBulkResolveResult {
	const t = useTranslations();
	const queryClient = useQueryClient();

	const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [resolvedIds, setResolvedIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [failures, setFailures] = useState<
		Record<string, TodoBulkResolveFailure>
	>({});
	/**
	 * The rows the last batch could not resolve, as they were when it ran.
	 *
	 * Kept because `not_found` and `vanished` mean the row is no longer in the
	 * read, so the refetch would erase the only place its reason is shown.
	 */
	const [failedRows, setFailedRows] = useState<readonly TodoListItem[]>([]);
	/** What the batch in flight was sent, by id, to snapshot its failures. */
	const batchRows = useRef<Map<string, TodoListItem>>(new Map());
	const [summary, setSummary] = useState<TodoBulkResolveSummary | null>(null);

	/**
	 * The synchronous half of the one-batch-at-a-time guard.
	 *
	 * `disabled` from state is not enough on its own: two clicks inside one
	 * React batch both read the pre-render value and both fire, and a second
	 * batch over the same selection would report `completed` rows as
	 * `not_found` the moment the first one lands.
	 */
	const inFlight = useRef(false);

	const mutation = useMutation({
		mutationFn: async (
			todoIds: readonly string[],
		): Promise<TodoBulkResolveResponse> =>
			orpc.todos.bulkResolve.call({
				organizationId,
				todoIds: [...todoIds],
			}),
		onSuccess: async (response) => {
			const { completedIds, failures: nextFailures } =
				partitionBulkResolve(response.results);

			const completed = new Set(completedIds);
			setResolvedIds((current) => new Set([...current, ...completed]));
			// What remains ticked is exactly what still needs a person, so the
			// button they press next re-runs only the rows that can move.
			setSelectedIds(
				(current) =>
					new Set([...current].filter((id) => !completed.has(id))),
			);
			setFailures(nextFailures);
			setFailedRows(
				Object.keys(nextFailures).flatMap((todoId) => {
					const row = batchRows.current.get(todoId);
					return row ? [row] : [];
				}),
			);
			setSummary({
				completed: response.counts.completed,
				failed:
					response.counts.notFound +
					response.counts.forbidden +
					response.counts.vanished,
			});

			// Awaited: the hidden view and the default list are both wrong the
			// moment this returns, and the person is about to read a bar that
			// claims both have moved.
			await invalidateTodoList(queryClient);
		},
		onError: async () => {
			// "Nothing was written" is NOT what a failure here means. The server
			// commits row by row on purpose and wraps nothing in a transaction, so
			// a timeout or a dropped connection part-way leaves the earlier rows
			// DONE. Telling the person otherwise and leaving the cached list
			// untouched invites them to press the button again, which re-completes
			// those rows under a new actor and time and writes a second audit row
			// for each. So the list is refreshed from the server -- which is the
			// only thing that knows how far the batch got -- and the message says
			// what actually happened.
			await invalidateTodoList(queryClient);
			toast.error(t(`${T}.ageHidden.error`));
		},
		onSettled: () => {
			inFlight.current = false;
		},
	});

	const toggle = useCallback((todoId: string) => {
		setSelectedIds((current) => {
			const next = new Set(current);
			if (!next.delete(todoId)) {
				next.add(todoId);
			}
			return next;
		});
	}, []);

	const toggleAll = useCallback((todoIds: readonly string[]) => {
		setSelectedIds((current) => {
			const allSelected =
				todoIds.length > 0 &&
				todoIds.every((todoId) => current.has(todoId));
			if (allSelected) {
				const next = new Set(current);
				for (const todoId of todoIds) {
					next.delete(todoId);
				}
				return next;
			}
			return new Set([...current, ...todoIds]);
		});
	}, []);

	const dismissSummary = useCallback(() => setSummary(null), []);

	const resolve = useCallback(
		(rows: readonly TodoListItem[]) => {
			if (inFlight.current) {
				return;
			}
			const todoIds = [...selectedIds];
			if (todoIds.length === 0) {
				return;
			}
			inFlight.current = true;
			batchRows.current = new Map(
				rows
					.filter((row) => selectedIds.has(row.id))
					.map((row) => [row.id, row]),
			);
			// The previous batch's reasons go with the batch that replaces
			// them; a reason left over from an attempt two clicks ago describes
			// a row the person has since re-run.
			setFailures({});
			setFailedRows([]);
			mutation.mutate(todoIds);
		},
		[mutation, selectedIds],
	);

	return useMemo(
		() => ({
			selectedIds,
			resolvedIds,
			failures,
			failedRows,
			summary,
			dismissSummary,
			toggle,
			toggleAll,
			isResolving: mutation.isPending,
			resolve,
		}),
		[
			dismissSummary,
			failedRows,
			failures,
			mutation.isPending,
			resolve,
			resolvedIds,
			selectedIds,
			summary,
			toggle,
			toggleAll,
		],
	);
}
