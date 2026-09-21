"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	EmptyState,
	EmptyStateDescription,
	EmptyStateTitle,
} from "@ui/components/empty-state";
import { cn } from "@ui/lib";
import {
	CheckCheckIcon,
	PencilLineIcon,
	UsersRoundIcon,
	XIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo } from "react";
import {
	type TodoBulkResolveFailure,
	useTodoBulkResolve,
} from "../lib/todo-bulk-resolve";
import { formatTodoDate, type TodoListItem } from "../lib/todo-list-model";
import { TodoListSkeleton } from "./TodoListSkeleton";

const T = "todos.list";

/** One page of the hidden rows. Fifty is the read's own default. */
const PAGE_SIZE = 50;

/**
 * A row's reason, by outcome.
 *
 * A total map rather than a `${outcome}` template: the outcomes are a closed
 * set on the server, and writing them out is what makes a new one a TypeScript
 * error here instead of a row rendering a missing translation key.
 */
const FAILURE_KEY: Record<TodoBulkResolveFailure, string> = {
	not_found: "notFound",
	forbidden: "forbidden",
	vanished: "vanished",
};

/**
 * What the age cutoff removed, and the one act that clears it (Fizzy #2340).
 *
 * ITS OWN READ. `view: "ageHidden"` returns exactly the rows the default
 * view's cutoff took out, under the same visibility rules and the same
 * cursor/limit paging. It is a SEPARATE query from the page's list read, so
 * opening this box cannot disturb what is on screen above it, and closing it
 * costs nothing. The query is mounted with this component, so a reader who
 * never opens the box never pays for the call.
 *
 * SELECT, THEN RESOLVE — NOT PER-ROW ACTIONS. These rows are here because they
 * are old: the reason a person opens this box is to clear a backlog, not to
 * reassign or snooze one line. So the row is deliberately NOT `TodoRow`.
 * `TodoRow`'s checkbox COMPLETES immediately, and a list whose rows carry both
 * a "complete now" box and a "select for the batch" box is a trap in a view
 * whose whole purpose is the batch.
 *
 * PARTIAL FAILURE IS SHOWN ON THE ROWS. `todos.bulkResolve` commits what it can
 * and answers per row; rows that completed leave, and rows that did not stay
 * ticked and carry their own reason. The bar above the list holds the two
 * counts until it is dismissed. See `useTodoBulkResolve` for why a toast is
 * not enough.
 */

export function TodoAgeHiddenView({
	organizationId,
}: {
	/** The tenant the rows came from, and the one every write names. */
	organizationId: string | null;
}) {
	const t = useTranslations();
	const formatter = useFormatter();

	const queryClient = useQueryClient();
	// Held rather than inlined so the reset below can name THIS query by the
	// key oRPC generated for it — a hand-built key matches none of the three
	// shapes in this app and `resetQueries` reports nothing when it matches
	// nothing. See `todoListQueryKey`.
	const listOptions = orpc.todos.list.infiniteOptions({
		input: (cursor: string | undefined) => ({
			organizationId,
			view: "ageHidden" as const,
			limit: PAGE_SIZE,
			...(cursor ? { cursor } : {}),
		}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) =>
			lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
	});
	const query = useInfiniteQuery(listOptions);

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
	const cursorStale = (query.data?.pages ?? []).some(
		(page) => page.cursorStale === true,
	);
	const listQueryKey = listOptions.queryKey;
	useEffect(() => {
		if (!cursorStale) {
			return;
		}
		void queryClient.resetQueries({ queryKey: listQueryKey });
	}, [cursorStale, listQueryKey, queryClient]);

	const {
		selectedIds,
		resolvedIds,
		failures,
		failedRows,
		summary,
		dismissSummary,
		toggle,
		toggleAll,
		isResolving,
		resolve,
	} = useTodoBulkResolve({ organizationId });

	/**
	 * What the box shows: the loaded pages, minus what this session resolved,
	 * plus any row the last batch could not resolve.
	 *
	 * The filter is not belt-and-braces: this view is derived from the default
	 * view's set, which keeps the most recently completed rows, so a row this
	 * person just cleared can legitimately come back in the next response.
	 * Showing it again, unticked, would read as a write that did not happen.
	 */
	const rows = useMemo(() => {
		const loaded = (query.data?.pages ?? []).flatMap(
			(page) => page.items as TodoListItem[],
		);
		/*
		 * ONE ROW PER ID, whatever the pages say. Two fetches of a live list
		 * can overlap — a cursor row whose sort key moved between them resumes
		 * from its new place — and an appended duplicate is not cosmetic here:
		 * it is a repeated React key, a select-all that counts the same to-do
		 * twice, and a batch that sends an id it has already sent. The first
		 * copy wins, so the order the reader has been looking at is the order
		 * that stays.
		 */
		const byId = new Map<string, TodoListItem>();
		for (const item of loaded) {
			if (resolvedIds.has(item.id) || byId.has(item.id)) {
				continue;
			}
			byId.set(item.id, item);
		}
		const kept = [...byId.values()];

		/*
		 * A row the last batch could not resolve leads, even when the read has
		 * stopped returning it. `not_found` and `vanished` both mean the row is
		 * GONE, so the refetch the batch itself triggered would erase the row
		 * and its reason together and leave the person with a count and no way
		 * to tell which of their selection it was about.
		 */
		const loadedIds = new Set(kept.map((item) => item.id));
		const pinned = failedRows.filter((item) => !loadedIds.has(item.id));
		return [...pinned, ...kept];
	}, [failedRows, query.data?.pages, resolvedIds]);

	/** Everything on screen — what "select all" means and nothing wider. */
	const selectableIds = useMemo(() => rows.map((item) => item.id), [rows]);
	const selectedCount = selectableIds.filter((id) =>
		selectedIds.has(id),
	).length;
	const allSelected =
		selectableIds.length > 0 && selectedCount === selectableIds.length;

	const formatDate = (value: string) => formatTodoDate(formatter, value);

	return (
		<div className="mt-3 space-y-3" data-testid="todo-age-hidden-list">
			{/*
			 * The receipt for the last batch. It stays until it is dismissed
			 * because it is the only place the two numbers appear together, and
			 * because the rows it is about are still on screen waiting to be
			 * read.
			 */}
			{summary ? (
				<Alert
					variant={summary.failed > 0 ? "warning" : "success"}
					data-testid="todo-age-hidden-summary"
				>
					<AlertDescription className="flex min-w-0 items-start gap-2">
						<span className="min-w-0 flex-1">
							{t(`${T}.ageHidden.summary.message`, {
								completed: summary.completed,
								failed: summary.failed,
							})}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="-mt-1 size-6 shrink-0"
							aria-label={t(`${T}.ageHidden.summary.dismiss`)}
							data-testid="todo-age-hidden-summary-dismiss"
							onClick={dismissSummary}
						>
							<XIcon aria-hidden="true" className="size-3.5" />
						</Button>
					</AlertDescription>
				</Alert>
			) : null}

			{query.isPending ? (
				// `<output>` carries role="status" implicitly, so the wait is
				// announced without a hand-written ARIA attribute to keep in
				// step, while sighted readers get the shape of the rows.
				<output className="block space-y-2">
					<span className="sr-only">
						{t(`${T}.ageHidden.loading`)}
					</span>
					<TodoListSkeleton rows={3} />
				</output>
			) : query.isError ? (
				<p
					data-testid="todo-age-hidden-error"
					className="py-4 text-center text-sm"
				>
					{t(`${T}.ageHidden.loadFailed`)}
				</p>
			) : rows.length === 0 ? (
				// The testid sits on a wrapper: `EmptyState` takes children and
				// a class name only, and widening its props to carry a test
				// hook would change a shared primitive for one caller.
				<div data-testid="todo-age-hidden-empty">
					<EmptyState className="p-6">
						<EmptyStateTitle>
							{t(`${T}.ageHidden.empty.title`)}
						</EmptyStateTitle>
						<EmptyStateDescription>
							{t(`${T}.ageHidden.empty.description`)}
						</EmptyStateDescription>
					</EmptyState>
				</div>
			) : (
				<>
					<div className="flex min-w-0 flex-wrap items-center gap-3">
						{/*
						 * A div rather than a `<label>`: the checkbox is a
						 * button under the hood, so a label would not forward a
						 * click to it and would only promise one. The control
						 * carries its own name, and the text beside it is the
						 * running count.
						 */}
						<div className="flex min-w-0 items-center gap-2 text-foreground text-sm">
							<Checkbox
								checked={allSelected}
								data-testid="todo-age-hidden-select-all"
								aria-label={t(`${T}.ageHidden.selectAll`)}
								onCheckedChange={() => toggleAll(selectableIds)}
							/>
							<span
								className="min-w-0 truncate"
								data-testid="todo-age-hidden-selected-count"
							>
								{t(`${T}.ageHidden.selected`, {
									count: selectedCount,
								})}
							</span>
						</div>

						<Button
							type="button"
							size="sm"
							className="ml-auto shrink-0"
							data-testid="todo-age-hidden-resolve"
							disabled={selectedIds.size === 0 || isResolving}
							onClick={() => resolve(rows)}
						>
							<CheckCheckIcon
								aria-hidden="true"
								className="size-3.5"
							/>
							{isResolving
								? t(`${T}.ageHidden.resolving`)
								: t(`${T}.ageHidden.resolve`, {
										count: selectedIds.size,
									})}
						</Button>
					</div>

					<ul className="space-y-2">
						{rows.map((item) => {
							const failure = failures[item.id];
							const selected = selectedIds.has(item.id);
							return (
								<li
									key={item.id}
									data-testid="todo-age-hidden-row"
									data-todo-id={item.id}
									className={cn(
										"flex items-start gap-3 rounded-lg border bg-card p-3",
										failure && "border-destructive/40",
									)}
								>
									<Checkbox
										className="mt-0.5 shrink-0"
										data-testid="todo-age-hidden-select"
										checked={selected}
										disabled={isResolving}
										aria-label={t(`${T}.ageHidden.select`, {
											title: item.title,
										})}
										onCheckedChange={() => toggle(item.id)}
									/>
									<div className="min-w-0 flex-1 space-y-1">
										<p
											className="truncate font-medium text-foreground text-sm"
											title={item.title}
										>
											{item.title}
										</p>
										<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
											<span className="inline-flex items-center gap-1">
												{item.source ===
												"MEETING_DIGEST" ? (
													<UsersRoundIcon
														aria-hidden="true"
														className="size-3.5"
													/>
												) : (
													<PencilLineIcon
														aria-hidden="true"
														className="size-3.5"
													/>
												)}
												{t(
													item.source ===
														"MEETING_DIGEST"
														? `${T}.source.meeting`
														: `${T}.source.manual`,
												)}
											</span>
											<span aria-hidden="true">·</span>
											<span data-testid="todo-age-hidden-row-date">
												{formatDate(item.sourceDate)}
											</span>
											{item.projectName ? (
												<>
													<span aria-hidden="true">
														·
													</span>
													<span className="min-w-0 max-w-40 truncate">
														{item.projectName}
													</span>
												</>
											) : null}
										</div>
										{/*
										 * The row's own answer from the last
										 * batch. A different sentence per
										 * outcome, because "could not be
										 * resolved" tells the person nothing
										 * about whether to retry, to ask
										 * someone, or to stop looking.
										 */}
										{failure ? (
											<p
												data-testid="todo-age-hidden-row-reason"
												data-outcome={failure}
												className="text-destructive text-xs"
											>
												{t(
													`${T}.ageHidden.outcome.${FAILURE_KEY[failure]}`,
												)}
											</p>
										) : null}
									</div>
								</li>
							);
						})}
					</ul>

					{query.hasNextPage ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							data-testid="todo-age-hidden-load-more"
							disabled={query.isFetchingNextPage}
							onClick={() => query.fetchNextPage()}
						>
							{query.isFetchingNextPage
								? t(`${T}.ageHidden.loadingMore`)
								: t(`${T}.ageHidden.loadMore`)}
						</Button>
					) : null}
				</>
			)}
		</div>
	);
}
