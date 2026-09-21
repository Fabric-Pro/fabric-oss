/**
 * The To Do list's base query key (Fizzy #2340).
 *
 * This exists because the failure it prevents is silent. Three query-key
 * shapes coexist in this app, `invalidateQueries` throws nothing when a filter
 * matches none of them, and the symptom — a list that never refreshes after a
 * write — reads as a stale server rather than as a typo. Row actions land in a
 * later unit and invalidate through this key, so the match is pinned here,
 * against oRPC's real key shapes, before anything depends on it.
 */

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

// The shapes are oRPC's own: `key()` returns the path-only prefix and
// `queryOptions()` hangs `{ input, type }` below it.
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		todos: {
			list: {
				key: () => [["todos", "list"], {}],
				queryOptions: (options: { input: unknown }) => ({
					queryKey: [
						["todos", "list"],
						{ input: options.input, type: "query" },
					],
					queryFn: async () => ({ items: [] }),
				}),
			},
		},
	},
}));

import {
	forgetJustCompletedTodo,
	justCompletedTodosQueryKey,
	rememberJustCompletedTodo,
	todoListQueryKey,
} from "@saas/todos/lib/todos-api";
import { orpc } from "@shared/lib/orpc-query-utils";

function primeList(client: QueryClient, organizationId: string) {
	const { queryKey } = orpc.todos.list.queryOptions({
		input: { organizationId },
	});
	client.setQueryData(queryKey, { items: [] });
	return queryKey;
}

describe("todoListQueryKey", () => {
	it("matches every cached page of the list, whatever input it carried", () => {
		const client = new QueryClient();
		const first = primeList(client, "org-1");
		const second = primeList(client, "org-2");

		client.invalidateQueries({ queryKey: todoListQueryKey() });

		expect(client.getQueryState(first)?.isInvalidated).toBe(true);
		expect(client.getQueryState(second)?.isInvalidated).toBe(true);
	});

	it("is not what a hand-written key would have been", () => {
		// The negative control, and the whole reason the key is derived: this
		// filter is the obvious guess, it matches nothing, and it reports no
		// error while doing so.
		const client = new QueryClient();
		const cached = primeList(client, "org-1");

		client.invalidateQueries({ queryKey: ["todos", "list"] });

		expect(client.getQueryState(cached)?.isInvalidated).toBe(false);
	});
});

/**
 * The set of rows completed in this session, which keeps them on screen.
 *
 * It lives in the query cache so it survives a route change, and that is
 * exactly what makes its KEY load-bearing: stored anywhere below the list's
 * own prefix, the refetch that every write triggers would wipe the set that
 * refetch is the reason for.
 */
describe("just-completed to-dos", () => {
	it("remembers and forgets one, idempotently", () => {
		const client = new QueryClient();

		rememberJustCompletedTodo(client, "todo-1");
		rememberJustCompletedTodo(client, "todo-1");
		rememberJustCompletedTodo(client, "todo-2");
		expect(client.getQueryData(justCompletedTodosQueryKey())).toEqual([
			"todo-1",
			"todo-2",
		]);

		// Forgetting is what a reopen and a FAILED completion both do: a row
		// the server never completed must not stay pinned into the open view.
		forgetJustCompletedTodo(client, "todo-1");
		forgetJustCompletedTodo(client, "todo-1");
		expect(client.getQueryData(justCompletedTodosQueryKey())).toEqual([
			"todo-2",
		]);
	});

	it("is not swept away by the invalidation every write performs", () => {
		const client = new QueryClient();
		const cached = primeList(client, "org-1");
		rememberJustCompletedTodo(client, "todo-1");

		client.invalidateQueries({ queryKey: todoListQueryKey() });

		expect(client.getQueryState(cached)?.isInvalidated).toBe(true);
		expect(
			client.getQueryState(justCompletedTodosQueryKey())?.isInvalidated,
		).toBe(false);
		expect(client.getQueryData(justCompletedTodosQueryKey())).toEqual([
			"todo-1",
		]);
	});
});
