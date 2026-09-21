import { orpc } from "@shared/lib/orpc-query-utils";
import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";

/**
 * The one base key the consolidated To Do list read hangs off (Fizzy #2340).
 *
 * WHY THIS IS A FUNCTION AND NOT A LITERAL. Three query-key shapes coexist in
 * this app: hand-written tuples (`["todos", "list", input]`), oRPC's generated
 * `[path, { input, type }]` pairs, and the older `queryKey()` helper form. A
 * filter written in the wrong one of those three matches NOTHING, and
 * `invalidateQueries` reports no error — the list simply never refreshes, and
 * the bug reads as a stale server instead of a typo. The contact register
 * learned this first; see `@saas/organizations/lib/contacts-api`.
 *
 * So the key is DERIVED from the same procedure object the page reads through
 * rather than spelled out. `key()` returns the path-only prefix
 * (`[["todos","list"], {}]`), which partially matches every
 * `queryOptions({ input })` key hanging below it, whatever filters, cursor or
 * organization that input carried. That breadth is deliberate: a to-do write
 * only ever happens in the list being looked at, and refreshing one extra
 * cached page is free next to missing the one on screen.
 *
 * Row actions (complete, snooze, assign) land in a later unit and invalidate
 * through here — which is the whole reason this exists before they do.
 */
export const todoListQueryKey = () => orpc.todos.list.key();

/**
 * Refresh every cached page of the list.
 *
 * The one place a to-do write says "the list is now wrong". It exists so no
 * caller ever writes a filter of its own: `invalidateQueries` with a filter
 * that matches nothing succeeds silently, so a hand-built key is a bug with no
 * error attached to it. Awaited by its callers, so the refetch has landed
 * before an optimistic value is released and the row cannot flicker back
 * through its old value on the way to its new one.
 */
export const invalidateTodoList = (queryClient: QueryClient) =>
	queryClient.invalidateQueries({ queryKey: todoListQueryKey() });

/**
 * The to-dos completed in THIS session, kept in the query cache (Fizzy #2340).
 *
 * WHY THE CACHE AND NOT COMPONENT STATE. A completed row stays in the open view
 * so the person can see what they ticked and take it back. Held in the list
 * body's own state, that promise would last exactly as long as the component:
 * opening a meeting digest from a row and coming back unmounts the page, and
 * every row they had just finished would be gone. The QueryClient outlives the
 * route, so the set does too, and it dies with the tab — which is correct,
 * because the durable version of the promise is the server's (the default read
 * carries the two most recently completed rows).
 *
 * DELIBERATELY NOT UNDER THE LIST'S KEY. `todoListQueryKey()` is the prefix
 * every write invalidates; a set stored below it would be wiped by the very
 * refetch that brings back the completed rows it is there to keep visible.
 */
export const justCompletedTodosQueryKey = () =>
	["todos", "just-completed"] as const;

const NO_JUST_COMPLETED: readonly string[] = [];

/**
 * The ids, re-rendering their reader when they change.
 *
 * It is a query rather than a ref so React Query's own subscription does the
 * notifying — the alternative is a second store beside the cache that has to
 * be kept in step with it. Nothing is ever fetched: `queryFn` hands back what
 * the cache already holds, which makes an accidental refetch a no-op instead
 * of the silent erasure that returning `[]` would be.
 */
export function useJustCompletedTodoIds(): readonly string[] {
	const queryClient = useQueryClient();
	const { data } = useQuery({
		queryKey: justCompletedTodosQueryKey(),
		queryFn: () =>
			queryClient.getQueryData<readonly string[]>(
				justCompletedTodosQueryKey(),
			) ?? NO_JUST_COMPLETED,
		initialData: NO_JUST_COMPLETED,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
	});
	return data;
}

/** Remember a row as just-completed so the view keeps showing it. */
export function rememberJustCompletedTodo(
	queryClient: QueryClient,
	todoId: string,
) {
	queryClient.setQueryData<readonly string[]>(
		justCompletedTodosQueryKey(),
		(current) =>
			current?.includes(todoId) ? current : [...(current ?? []), todoId],
	);
}

/**
 * Forget one — because it was reopened, or because completing it failed.
 *
 * Both callers matter: a reopened row has no business being pinned into the
 * open view by a completion that no longer exists, and a failed completion
 * that stayed remembered would pin a row the server never completed.
 */
export function forgetJustCompletedTodo(
	queryClient: QueryClient,
	todoId: string,
) {
	queryClient.setQueryData<readonly string[]>(
		justCompletedTodosQueryKey(),
		(current) =>
			current?.includes(todoId)
				? current.filter((id) => id !== todoId)
				: (current ?? NO_JUST_COMPLETED),
	);
}
