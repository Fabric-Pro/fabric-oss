"use client";

import { useEffectiveOrganizationId } from "@saas/organizations/hooks";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ListTodoIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	assigneeOptionKey,
	assigneeOptions,
	dedupeTodos,
	projectOptions,
	rememberOptions,
	type TodoAssigneeOption,
	type TodoListData,
	type TodoProjectOption,
	type TodoScope,
	todoServerFilters,
} from "../lib/todo-list-model";
import { invalidateTodoList } from "../lib/todos-api";
import { TodoListBody } from "./TodoListBody";
import { TodoListSkeleton } from "./TodoListSkeleton";

/**
 * The consolidated To Do page (Fizzy #2340).
 *
 * It owns the page's heading and the three states a reader can be in before
 * there is anything to read: loading, unavailable, and nothing to do. The list
 * body — filters, rows, the Unassigned bucket and the age-hidden affordance —
 * lives in `TodoListBody` and mounts below; keeping it out of here is what let
 * the two land without fighting over one file.
 *
 * IT OWNS THE READ, AND THEREFORE EVERY ARGUMENT TO IT. `todos.list` is paged
 * and takes three narrowing inputs — `view`, `projectId` and one assignee id —
 * so the scope pills and both comboboxes render in the body but their STATE
 * lives here. That is not symmetry for its own sake:
 *
 *  - SCOPE cannot be a filter over one response at all. The default view drops
 *    snoozed rows in SQL before ranking anything and keeps only the two most
 *    recently completed, so a pill that narrowed the loaded page could only
 *    ever show an empty Snoozed tab — and nothing could be un-snoozed again.
 *  - PROJECT and ASSIGNEE could be, and were, and that was the defect: the read
 *    returns fifty rows, so narrowing them in the browser meant "filter by
 *    Apollo" showed nothing whenever Apollo's work started at row fifty-one,
 *    under a control that says it is filtering the workspace. Promoting them to
 *    the read makes the filter mean what it says. It costs nothing structural —
 *    the keyset pages the same way under a `WHERE`, and the option sets are
 *    accumulated here (`rememberOptions`) so a live filter cannot collapse the
 *    combobox to the one value already chosen.
 *
 * PAGING IS A KEYSET, AND THE CURSOR CAN GO STALE. Each page carries
 * `hasMore`/`nextCursor`, and a read that cannot place the cursor it was sent
 * answers `cursorStale` rather than serving the first page again. Appending
 * that would render the same rows twice, so it resets instead — the same
 * arrangement `TodoAgeHiddenView` uses, and the reason both flatten through
 * `dedupeTodos`.
 */
/** Which server view answers each scope pill. */
const TODO_SCOPE_VIEW = {
	open: "default",
	completed: "completed",
	snoozed: "snoozed",
} as const satisfies Record<TodoScope, "default" | "completed" | "snoozed">;

/** One page of the list. Fifty is the read's own default. */
const PAGE_SIZE = 50;

interface TodoListPageProps {
	/**
	 * Organization whose to-dos to show.
	 * - `string`: that organization
	 * - `undefined`: the current organization context
	 */
	organizationId?: string | null;
}

export function TodoListPage({ organizationId: propOrgId }: TodoListPageProps) {
	const t = useTranslations();
	const organizationId = useEffectiveOrganizationId(propOrgId);
	const queryClient = useQueryClient();

	const [scope, setScope] = useState<TodoScope>("open");
	const [project, setProject] = useState<TodoProjectOption | null>(null);
	const [assignee, setAssignee] = useState<TodoAssigneeOption | null>(null);

	/**
	 * The options both comboboxes offer, accumulated across every page and
	 * scope this mount has seen.
	 *
	 * A ref because it is a memory, not a rendered value: adding an option
	 * nobody selected must not re-render the page, and re-adding one that is
	 * already there is a no-op, so a double-invoked render cannot corrupt it.
	 */
	const seenOptions = useRef({
		projects: new Map<string, TodoProjectOption>(),
		assignees: new Map<string, TodoAssigneeOption>(),
	});
	const [filteredOrganizationId, setFilteredOrganizationId] =
		useState(organizationId);
	if (filteredOrganizationId !== organizationId) {
		// The workspace changed under a mounted page. The selections and the
		// remembered options name rows of the workspace we have left, and a
		// `projectId` from it would narrow this read to nothing while the chip
		// above the list still named a project — so both go with it.
		setFilteredOrganizationId(organizationId);
		setProject(null);
		setAssignee(null);
		seenOptions.current.projects.clear();
		seenOptions.current.assignees.clear();
	}

	const listOptions = orpc.todos.list.infiniteOptions({
		input: (cursor: string | undefined) => ({
			organizationId,
			view: TODO_SCOPE_VIEW[scope],
			limit: PAGE_SIZE,
			...todoServerFilters(project, assignee),
			...(cursor ? { cursor } : {}),
		}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) =>
			lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
	});
	/**
	 * Every argument to the read is in this query's KEY, which is what makes
	 * switching scope or filter a fresh page-1 read rather than an append: a
	 * different key is a different cached list, with its own first page and its
	 * own cursor. Nothing here has to reset anything by hand.
	 */
	const query = useInfiniteQuery(listOptions);
	const pages = query.data?.pages;

	/**
	 * The read could not place the cursor we sent, so start the list again.
	 *
	 * This is the answer to a page that no longer exists: the row the cursor
	 * named has been deleted, or has left what this viewer may see. Everything
	 * loaded under that cursor is a fragment of an ordering that has moved, and
	 * the only correct thing to show is the list as it is NOW — so the query is
	 * reset to its first page rather than appended to. No loop is possible:
	 * page one carries no cursor and so can never come back stale.
	 */
	const cursorStale = (pages ?? []).some((page) => page.cursorStale === true);
	// Held rather than inlined so the reset names THIS query by the key oRPC
	// generated for it — a hand-built key matches none of the three shapes in
	// this app, and `resetQueries` reports nothing when it matches nothing.
	const listQueryKey = listOptions.queryKey;
	useEffect(() => {
		if (!cursorStale) {
			return;
		}
		void queryClient.resetQueries({ queryKey: listQueryKey });
	}, [cursorStale, listQueryKey, queryClient]);

	/**
	 * Catch up the meetings the matcher never ran for (Fizzy #2340).
	 *
	 * Turning `TODO_LIST` on does not populate anything by itself: extraction
	 * short-circuits on a transcript it has already analysed, so nothing
	 * re-starts the owner matcher for a meeting that predates the rollout. The
	 * same gap swallows a matcher start that failed at extraction time — a
	 * Temporal blip there is logged and dropped, on the understanding that
	 * something else picks the meeting up. THIS IS THAT SOMETHING ELSE. Without
	 * it an organization enabling the feature opens a permanently empty page
	 * and is told nothing.
	 *
	 * FIRE AND FORGET, and never fatal. `todos.catchUp` starts workflows; it
	 * does not wait for them, and it is capped per call and ordered newest
	 * meeting first, so a long history drains over several opens rather than
	 * fanning out in one. A failure here must not reach the reader: the page is
	 * fully usable without it, and the rows it would produce are not the ones
	 * they came for. Clearing the ref on failure is what lets a revisit retry.
	 *
	 * ONE CALL PER ORGANIZATION PER MOUNT, guarded by a ref rather than by
	 * state, so a re-render between the request and its answer cannot fire a
	 * second one. Duplicate starts are collapsed server-side too; the ref is
	 * about not asking, not about correctness.
	 *
	 * IT DOES NOT REFETCH ON A SCHEDULE. The rows appear as each run finishes,
	 * which is after this answer, so the one invalidation below catches only
	 * the runs that were already in flight. The rest arrive on the next
	 * ordinary refetch — a navigation, a window focus, or any write on the
	 * page. Polling every open for work that usually is not there would cost
	 * every reader for the benefit of the first one.
	 */
	const caughtUpForRef = useRef<string | null>(null);
	const listLoaded = query.isSuccess;
	useEffect(() => {
		// AFTER the first page has landed, not beside it. Two reasons, and the
		// second is the one that bites: the reader's own list must not queue
		// behind a backfill they did not ask for, and an invalidation issued
		// while the first read is still in flight does nothing at all — React
		// Query marks a fetching query stale and lets the answer already on its
		// way stand, so the rows this call produced would wait for an unrelated
		// refetch. The sibling trigger in `MeetingDetailSheet` gates the same
		// way, on `insightsReady`, for the same kind of reason.
		if (
			!organizationId ||
			!listLoaded ||
			caughtUpForRef.current === organizationId
		) {
			return;
		}
		caughtUpForRef.current = organizationId;
		orpcClient.todos
			.catchUp({ organizationId })
			.then((result) => {
				if (result.started > 0) {
					void invalidateTodoList(queryClient);
				}
			})
			.catch(() => {
				caughtUpForRef.current = null;
			});
	}, [organizationId, listLoaded, queryClient]);

	const items = useMemo(
		() => dedupeTodos((pages ?? []).flatMap((page) => page.items)),
		[pages],
	);

	const { projects, assignees } = useMemo(
		() => ({
			projects: rememberOptions(
				seenOptions.current.projects,
				projectOptions(items),
				(option) => option.id,
			),
			assignees: rememberOptions(
				seenOptions.current.assignees,
				assigneeOptions(items),
				assigneeOptionKey,
			),
		}),
		[items],
	);

	/**
	 * The page's per-list facts, read from the NEWEST page.
	 *
	 * `ageHiddenCount` is measured over the whole set on every request, so the
	 * last answer is the least stale one; the viewer's expanded-bucket list is
	 * the same in all of them. Before paging, this count described a set the
	 * page could not reach — it is honest now because the rest of the list is
	 * reachable.
	 */
	const newest = pages?.[pages.length - 1];
	const data: TodoListData | null = newest
		? {
				items,
				ageHiddenCount: newest.ageHiddenCount,
				ageThresholdDays: newest.ageThresholdDays,
				unassignedExpandedProjectIds:
					newest.unassignedExpandedProjectIds,
			}
		: null;

	// `todos.list` answers NOT_FOUND when the TODO_LIST flag is off for this
	// organization — the gate treats the capability as absent, not broken. The
	// sidebar entry is absent then too, so nobody should arrive here; a
	// hand-typed URL still must not be told the product is on fire.
	const gatedOff =
		(query.error as { code?: string } | null)?.code === "NOT_FOUND";

	return (
		<div className="space-y-6">
			<div className="space-y-1">
				<h1 className="flex items-center gap-2 font-semibold text-2xl">
					<ListTodoIcon className="size-5 text-primary" aria-hidden />
					{t("todos.title")}
				</h1>
				<p className="text-muted-foreground text-sm">
					{t("todos.subtitle")}
				</p>
			</div>

			{query.isPending ? (
				// `<output>` rather than a div with role="status": it carries
				// that role implicitly, so the live region announces the wait
				// without a hand-written ARIA attribute to keep in step. The
				// announcement stays for screen readers while sighted readers
				// get the shape of the list that is coming — this is a
				// project manager's landing surface and the read crosses every
				// project they can reach, so the wait is long enough to look at.
				<output className="block space-y-2">
					<span className="sr-only">{t("todos.loading")}</span>
					<TodoListSkeleton />
				</output>
			) : query.isError ? (
				<p className="py-12 text-center text-muted-foreground text-sm">
					{gatedOff ? t("todos.unavailable") : t("todos.loadFailed")}
				</p>
			) : scope === "open" &&
				!project &&
				!assignee &&
				items.length === 0 ? (
				// Only the OPEN scope may replace the list wholesale, and only
				// while nothing is filtered. An empty Completed or Snoozed tab
				// must keep the pills on screen, or the reader is stranded in a
				// view with no way back to their work — and an empty FILTERED
				// list must keep the comboboxes and their chips, or the only
				// control that could bring the list back has just been taken
				// off the page. "Nothing to do" is a statement about the
				// workspace; a filter that matches nothing is not that.
				<div className="space-y-1 py-12 text-center">
					<p className="font-medium text-sm">
						{t("todos.empty.title")}
					</p>
					<p className="text-muted-foreground text-sm">
						{t("todos.empty.description")}
					</p>
				</div>
			) : data ? (
				<TodoListBody
					data={data}
					organizationId={organizationId}
					scope={scope}
					onScopeChange={setScope}
					filters={{
						project,
						assignee,
						projects,
						assignees,
						onProjectChange: setProject,
						onAssigneeChange: setAssignee,
					}}
					paging={{
						hasMore: query.hasNextPage,
						isLoadingMore: query.isFetchingNextPage,
						onLoadMore: () => {
							void query.fetchNextPage();
						},
					}}
				/>
			) : null}
		</div>
	);
}
