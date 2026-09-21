/**
 * Reaching what age hid, and clearing it (Fizzy #2340).
 *
 * The promises pinned here are the ones that fail while the screen still looks
 * correct — and every one of them is about a BATCH, which is exactly when a
 * person cannot check the result row by row:
 *
 *   1. The hidden rows are a read of their OWN (`view: "ageHidden"`), issued
 *      only when the box is opened. Folding them into the page's list read
 *      would make opening an explanation change what is on screen above it.
 *   2. A row that resolved leaves the selection AND the view. This view is
 *      derived from the default view's set, which keeps the most recently
 *      completed rows, so a row just cleared can legitimately come back in the
 *      next response — rendered again, unticked, it reads as a write that never
 *      happened.
 *   3. A row that did NOT resolve stays ticked and says why, in its own words
 *      per outcome. One "some failed" toast leaves the person holding a
 *      selection they cannot safely re-run and no way to see which rows still
 *      need them.
 *   4. The bar carries both counts and survives until it is dismissed, because
 *      the rows it is about are still on screen being read.
 *   5. A batch refreshes BOTH reads through the derived key. Three query-key
 *      shapes coexist in this app and `invalidateQueries` reports nothing when
 *      a filter matches none of them, so the last describe asserts the refetch
 *      AND that the plausible hand-built key would not have produced it.
 *   6. EVERY ROW IS RENDERED ONCE. This view pages a set it is emptying, so two
 *      fetches can overlap; and when the read cannot place the cursor at all it
 *      says `cursorStale` instead of answering with the first page. Appending
 *      either one blindly gives duplicate React keys and a selection that
 *      counts the same to-do twice — a corrupted batch, not a cosmetic glitch.
 *
 * THE HARNESS IS THE REAL LOOP: the page's own read renders the body, the
 * hidden view issues its own paged read beside it, and `bulkResolve` edits the
 * fixture both read from — so an invalidation really refetches and the rows
 * really move.
 *
 * `next-intl` is mocked locally rather than relying on the global echo: the
 * global mock DROPS interpolation values, which would make the two counts in
 * the summary and the selected count unassertable.
 */

import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fixture, mockListTodos, mockBulkResolve, mockToastError } = vi.hoisted(
	() => ({
		/** Stands in for the database the reads and the batch share. */
		fixture: {
			default: {
				items: [] as Record<string, unknown>[],
				ageHiddenCount: 0,
				ageThresholdDays: 30,
				unassignedExpandedProjectIds: [] as string[],
			},
			hidden: [] as Record<string, unknown>[],
			/** Outcome to answer with, by to-do id. Absent means completed. */
			outcomes: {} as Record<string, string>,
		},
		mockListTodos: vi.fn(),
		mockBulkResolve: vi.fn(),
		mockToastError: vi.fn(),
	}),
);

/**
 * oRPC's own key shapes, written out rather than stubbed: `key()` is the
 * path-only prefix, `queryOptions()` hangs `{ input, type: "query" }` below it
 * and `infiniteOptions()` hangs `{ input: input(initialPageParam), type:
 * "infinite" }`. The invalidation assertions at the bottom are only meaningful
 * against the real partial match.
 */
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
					queryFn: () => mockListTodos(options.input),
				}),
				infiniteOptions: (options: {
					input: (pageParam: string | undefined) => unknown;
					initialPageParam: string | undefined;
					getNextPageParam: (
						lastPage: {
							hasMore: boolean;
							nextCursor: string | null;
						},
						allPages: unknown[],
					) => unknown;
				}) => ({
					queryKey: [
						["todos", "list"],
						{
							input: options.input(options.initialPageParam),
							type: "infinite",
						},
					],
					queryFn: ({
						pageParam,
					}: {
						pageParam: string | undefined;
					}) => mockListTodos(options.input(pageParam)),
					initialPageParam: options.initialPageParam,
					getNextPageParam: options.getNextPageParam,
				}),
			},
			bulkResolve: { call: mockBulkResolve },
			complete: { call: vi.fn() },
			snooze: { call: vi.fn() },
			unsnooze: { call: vi.fn() },
			assign: { call: vi.fn() },
			// #2340: the list body asks this once for the meetings on screen, and
			// each meeting-sourced row asks the second one when its work-item panel
			// is opened. Answered empty here — both have their own suite
			// (`TodoProposals.test.tsx`); this file only has to keep rendering.
			proposals: {
				pendingMeetings: {
					key: () => [["todos", "proposals", "pendingMeetings"], {}],
					queryOptions: (options: {
						input: unknown;
						enabled?: boolean;
					}) => ({
						queryKey: [
							["todos", "proposals", "pendingMeetings"],
							{ input: options.input, type: "query" },
						],
						queryFn: async () => ({ meetings: [] }),
						enabled: options.enabled,
					}),
				},
				linkedWorkItems: {
					key: () => [["todos", "proposals", "linkedWorkItems"], {}],
					queryOptions: (options: {
						input: unknown;
						enabled?: boolean;
					}) => ({
						queryKey: [
							["todos", "proposals", "linkedWorkItems"],
							{ input: options.input, type: "query" },
						],
						queryFn: async () => ({
							todoId: "",
							transcriptRef: null,
							projectId: null,
							linkingEnabled: false,
							resolvedVia: null,
							isOrphaned: false,
							items: [],
						}),
						enabled: options.enabled,
					}),
				},
				manageLink: { call: vi.fn() },
			},
			contacts: {
				list: {
					key: () => [["todos", "contacts", "list"], {}],
					queryOptions: (options: { input: unknown }) => ({
						queryKey: [
							["todos", "contacts", "list"],
							{ input: options.input, type: "query" },
						],
						queryFn: async () => ({ items: [] }),
					}),
				},
				create: { call: vi.fn() },
			},
		},
		organizations: {
			searchMembers: {
				key: () => [["organizations", "searchMembers"], {}],
				queryOptions: (options: { input: unknown }) => ({
					queryKey: [
						["organizations", "searchMembers"],
						{ input: options.input, type: "query" },
					],
					queryFn: async () => ({ members: [] }),
				}),
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks", () => ({
	useBasePath: () => "/app/acme",
	useEffectiveOrganizationId: (propOrgId: string | null | undefined) =>
		propOrgId !== undefined ? propOrgId : "org-from-context",
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: vi.fn(),
		error: mockToastError,
		info: vi.fn(),
		loading: vi.fn(),
	}),
}));

// Echo the interpolation values so the counts are visible in the copy.
vi.mock("next-intl", () => {
	const useTranslations = () => {
		const t = (key: string, values?: Record<string, unknown>) =>
			values ? `${key} ${JSON.stringify(values)}` : key;
		t.raw = (key: string) => key;
		return t;
	};
	return {
		useTranslations,
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (date: Date) => date.toISOString().slice(0, 10),
			number: (value: number) => String(value),
			relativeTime: (date: Date) => date.toISOString(),
		}),
		useMessages: () => ({}),
		NextIntlClientProvider: ({ children }: { children: ReactNode }) =>
			children,
	};
});

// Radix's popover and cmdk need layout and pointer capture jsdom does not
// implement; the repo's pattern is to flatten them so what they contain stays
// reachable. Nothing under test here lives inside them.
vi.mock("@ui/components/popover", () => {
	const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
	const Content = ({
		children,
		...rest
	}: { children?: ReactNode } & Record<string, unknown>) => (
		<div {...rest}>{children}</div>
	);
	return { Popover: Pass, PopoverTrigger: Pass, PopoverContent: Content };
});

vi.mock("@ui/components/command", () => {
	const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
	return {
		Command: Pass,
		CommandList: Pass,
		CommandEmpty: Pass,
		CommandGroup: Pass,
		CommandSeparator: () => null,
		CommandInput: ({
			value,
			onValueChange,
			...rest
		}: {
			value?: string;
			onValueChange?: (value: string) => void;
		} & Record<string, unknown>) => (
			<input
				{...rest}
				value={value}
				onChange={(event) => onValueChange?.(event.target.value)}
			/>
		),
		CommandItem: ({
			children,
			onSelect,
			...rest
		}: { children?: ReactNode; onSelect?: () => void } & Record<
			string,
			unknown
		>) => (
			<button type="button" {...rest} onClick={() => onSelect?.()}>
				{children}
			</button>
		),
	};
});

import { TodoListBody } from "@saas/todos/components/TodoListBody";
import { partitionBulkResolve } from "@saas/todos/lib/todo-bulk-resolve";
import type {
	TodoListData,
	TodoListItem,
} from "@saas/todos/lib/todo-list-model";
import { todoListQueryKey } from "@saas/todos/lib/todos-api";
import { orpc } from "@shared/lib/orpc-query-utils";

const T = "todos.list";
const ADA = { id: "user-ada", name: "Ada Member", image: null };

/**
 * The fake server's page size, deliberately smaller than the 50 the view asks
 * for: "load more follows the cursor" is only assertable when the first page
 * ends before the rows do.
 */
const SERVER_PAGE = 2;

function item(overrides: Partial<TodoListItem> & { id: string }): TodoListItem {
	return {
		source: "MANUAL",
		title: "Write the migration note",
		projectId: null,
		projectName: null,
		assigneeUserId: ADA.id,
		assigneeUser: ADA,
		assigneeContactId: null,
		assigneeContact: null,
		suggestedUserId: null,
		suggestedContactId: null,
		suggestionCandidates: null,
		assignedManually: true,
		snoozedUntil: null,
		sourceDate: "2026-09-10T09:00:00.000Z",
		completedAt: null,
		isCompleted: false,
		lastKnownCompletedAt: null,
		isOrphaned: false,
		...overrides,
	};
}

function seed({
	live = [] as TodoListItem[],
	hidden = [] as TodoListItem[],
	outcomes = {} as Record<string, string>,
}) {
	fixture.default = {
		items: live as unknown as Record<string, unknown>[],
		// What the cutoff removed — the page's cue to offer the way in, and the
		// number the line reports.
		ageHiddenCount: hidden.length,
		ageThresholdDays: 30,
		unassignedExpandedProjectIds: [],
	};
	fixture.hidden = hidden as unknown as Record<string, unknown>[];
	fixture.outcomes = outcomes;
}

/** The page's own read, feeding the body it renders. */
function ListHarness() {
	const { data } = useQuery(
		orpc.todos.list.queryOptions({
			input: { organizationId: "org-from-context" },
		}),
	);
	// `scope` is controlled by the page in production; these harnesses only
	// ever look at the default scope, so they pin it rather than re-implement
	// the page's state.
	return data ? (
		<TodoListBody
			data={data as TodoListData}
			organizationId="org-from-context"
			scope="open"
			onScopeChange={() => {}}
		/>
	) : null;
}

function makeClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
			mutations: { retry: false },
		},
	});
}

async function renderList(client: QueryClient = makeClient()) {
	render(
		<QueryClientProvider client={client}>
			<ListHarness />
		</QueryClientProvider>,
	);
	await screen.findByTestId("todo-scope-pills");
	return { client };
}

/** Open the age-hidden box and wait for its own read to land. */
async function openHidden(user: ReturnType<typeof userEvent.setup>) {
	await user.click(await screen.findByTestId("todo-age-hidden-line"));
	return await screen.findByTestId("todo-age-hidden-list");
}

const hiddenCalls = () =>
	mockListTodos.mock.calls.filter(
		([input]) => (input as { view?: string })?.view === "ageHidden",
	);

const defaultCalls = () =>
	mockListTodos.mock.calls.filter(
		([input]) => (input as { view?: string })?.view !== "ageHidden",
	);

function hiddenRows() {
	return screen.queryAllByTestId("todo-age-hidden-row");
}

function hiddenRow(todoId: string) {
	const row = hiddenRows().find((node) => node.dataset.todoId === todoId);
	if (!row) {
		throw new Error(`no hidden row for ${todoId}`);
	}
	return row;
}

async function selectHidden(
	user: ReturnType<typeof userEvent.setup>,
	todoId: string,
) {
	await user.click(
		within(hiddenRow(todoId)).getByTestId("todo-age-hidden-select"),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	seed({});

	mockListTodos.mockImplementation(
		async (input: { view?: string; cursor?: string }) => {
			if (input?.view !== "ageHidden") {
				return structuredClone(fixture.default);
			}
			// Cursor paging over the fixture, the same contract the read has:
			// the cursor names the LAST row of the page just served.
			const start = input.cursor
				? fixture.hidden.findIndex((row) => row.id === input.cursor) + 1
				: 0;
			const page = fixture.hidden.slice(start, start + SERVER_PAGE);
			const hasMore = start + SERVER_PAGE < fixture.hidden.length;
			return structuredClone({
				items: page,
				hasMore,
				nextCursor: hasMore
					? ((page[page.length - 1]?.id as string) ?? null)
					: null,
				ageHiddenCount: fixture.hidden.length,
				ageThresholdDays: 30,
				unassignedExpandedProjectIds: [],
			});
		},
	);

	mockBulkResolve.mockImplementation(
		async ({ todoIds }: { todoIds: string[] }) => {
			const results = todoIds.map((todoId) => ({
				todoId,
				outcome: fixture.outcomes[todoId] ?? "completed",
			}));
			// The fixture really loses the rows the server would have lost,
			// which is what makes the refetch below a real one — and what
			// makes the failure rows load-bearing: `not_found` and `vanished`
			// both mean the row is GONE, so the refetch this batch triggers
			// takes it out of the read while the person still has to be told
			// what happened to it. Only `forbidden` describes a row that is
			// still there.
			const completed = new Set(
				results
					.filter((result) => result.outcome === "completed")
					.map((result) => result.todoId),
			);
			const gone = new Set(
				results
					.filter((result) => result.outcome !== "forbidden")
					.map((result) => result.todoId),
			);
			fixture.hidden = fixture.hidden.filter(
				(row) => !gone.has(row.id as string),
			);
			fixture.default.ageHiddenCount = fixture.hidden.length;
			return {
				results,
				counts: {
					requested: results.length,
					completed: completed.size,
					notFound: results.filter((r) => r.outcome === "not_found")
						.length,
					forbidden: results.filter((r) => r.outcome === "forbidden")
						.length,
					vanished: results.filter((r) => r.outcome === "vanished")
						.length,
				},
			};
		},
	);
});

describe("reaching the hidden to-dos", () => {
	it("reads them only when the box is opened, and never through the page's list read", async () => {
		const user = userEvent.setup();
		seed({
			live: [item({ id: "live-1", title: "Still live" })],
			hidden: [item({ id: "old-1", title: "Older than the cutoff" })],
		});
		await renderList();

		// The page's read is the DEFAULT view: opening an explanation must not
		// be what fetches the rows it explains.
		expect(hiddenCalls()).toHaveLength(0);

		await openHidden(user);

		await waitFor(() => {
			expect(hiddenCalls()).toHaveLength(1);
		});
		expect(hiddenCalls()[0]?.[0]).toMatchObject({
			organizationId: "org-from-context",
			view: "ageHidden",
		});
	});

	it("lists exactly the rows the default view left out", async () => {
		const user = userEvent.setup();
		seed({
			live: [item({ id: "live-1", title: "Still live" })],
			hidden: [
				item({ id: "old-1", title: "Older than the cutoff" }),
				item({
					id: "old-2",
					title: "Older still",
					source: "MEETING_DIGEST",
					projectId: "proj-1",
					projectName: "Apollo",
				}),
			],
		});
		await renderList();

		// The default list shows the live row and NOT the hidden ones.
		expect(screen.getByText("Still live")).toBeVisible();
		expect(screen.queryByText("Older than the cutoff")).toBeNull();

		const view = await openHidden(user);

		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(2);
		});
		expect(within(view).getByText("Older than the cutoff")).toBeVisible();
		expect(within(view).getByText("Older still")).toBeVisible();
		// The live row is not repeated inside the box.
		expect(within(view).queryByText("Still live")).toBeNull();
		// A hidden row still says where it came from and when.
		expect(
			within(hiddenRow("old-2")).getByText(`${T}.source.meeting`),
		).toBeVisible();
		expect(
			within(hiddenRow("old-2")).getByTestId("todo-age-hidden-row-date"),
		).toHaveTextContent("2026-09-10");
	});

	it("holds the layout with row-shaped skeletons while they load", async () => {
		const user = userEvent.setup();
		seed({ hidden: [item({ id: "old-1" })] });

		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const answer = mockListTodos.getMockImplementation();
		mockListTodos.mockImplementation(async (input: { view?: string }) => {
			if (input?.view === "ageHidden") {
				await pending;
			}
			return answer?.(input);
		});

		await renderList();
		await user.click(await screen.findByTestId("todo-age-hidden-line"));

		const view = await screen.findByTestId("todo-age-hidden-list");
		expect(within(view).getByTestId("todo-list-skeleton")).toBeVisible();

		release?.();
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(1);
		});
	});

	it("says so when nothing is behind the cutoff any more", async () => {
		// Reachable in ordinary use: the count travelled with the page's read,
		// and someone else can clear the rows behind it before the box opens.
		const user = userEvent.setup();
		seed({ hidden: [item({ id: "old-1" })] });
		await renderList();
		fixture.hidden = [];

		const view = await openHidden(user);

		expect(
			await within(view).findByTestId("todo-age-hidden-empty"),
		).toBeVisible();
		expect(hiddenRows()).toHaveLength(0);
	});

	it("follows the cursor when asked for more", async () => {
		const user = userEvent.setup();
		seed({
			hidden: [
				item({ id: "old-1", title: "First" }),
				item({ id: "old-2", title: "Second" }),
				item({ id: "old-3", title: "Third" }),
			],
		});
		await renderList();
		await openHidden(user);

		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(SERVER_PAGE);
		});

		await user.click(screen.getByTestId("todo-age-hidden-load-more"));

		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(3);
		});
		// The second read carried the cursor the first page handed back, not a
		// re-request of page one.
		expect(hiddenCalls()[1]?.[0]).toMatchObject({ cursor: "old-2" });
		// Paging ends when the server says it does.
		expect(screen.queryByTestId("todo-age-hidden-load-more")).toBeNull();
	});
});

describe("paging a list that is being emptied", () => {
	it("renders one row per id when a second page repeats the first", async () => {
		// The overlap is reachable without any server bug: a cursor row whose
		// sort key MOVES between fetches (someone snoozes it) makes the next
		// page resume from its new place, and rows already served come back.
		// The server half of this fix cannot see that; this is why the client
		// deduplicates as it flattens.
		const user = userEvent.setup();
		const page = [
			item({ id: "old-1", title: "First" }),
			item({ id: "old-2", title: "Second" }),
		];
		seed({ hidden: page });
		mockListTodos.mockImplementation(async (input: { view?: string }) => {
			if (input?.view !== "ageHidden") {
				return structuredClone(fixture.default);
			}
			// Both pages are the same two rows, and the read still says there
			// is more — exactly the shape a cursor the server could not place
			// used to produce.
			return structuredClone({
				items: page,
				hasMore: true,
				nextCursor: "old-2",
				cursorStale: false,
				ageHiddenCount: page.length,
				ageThresholdDays: 30,
				unassignedExpandedProjectIds: [],
			});
		});
		await renderList();
		await openHidden(user);
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(2);
		});

		await user.click(screen.getByTestId("todo-age-hidden-load-more"));
		await waitFor(() => {
			expect(hiddenCalls().length).toBeGreaterThan(1);
		});

		const ids = hiddenRows().map((node) => node.dataset.todoId);
		expect(ids).toEqual(["old-1", "old-2"]);
		expect(new Set(ids).size).toBe(ids.length);
		// And the selection counts each to-do once: a duplicated row would send
		// its id twice in the batch and report a count nobody can reconcile.
		await user.click(screen.getByTestId("todo-age-hidden-select-all"));
		expect(screen.getByTestId("todo-age-hidden-resolve")).toHaveTextContent(
			'{"count":2}',
		);
	});

	it("starts again from the first page when the read reports the cursor as stale", async () => {
		// `cursorStale` means the row the cursor named is gone, so there is no
		// page after it and everything loaded under it belongs to an ordering
		// that has moved. The only correct thing to show is the list as it is
		// now, which is why the query is reset rather than appended to.
		const user = userEvent.setup();
		seed({
			hidden: [
				item({ id: "old-1" }),
				item({ id: "old-2" }),
				item({ id: "old-3" }),
			],
		});
		const answer = mockListTodos.getMockImplementation();
		mockListTodos.mockImplementation(
			async (input: { view?: string; cursor?: string }) => {
				if (input?.view === "ageHidden" && input.cursor) {
					return {
						items: [],
						hasMore: false,
						nextCursor: null,
						cursorStale: true,
						ageHiddenCount: fixture.hidden.length,
						ageThresholdDays: 30,
						unassignedExpandedProjectIds: [],
					};
				}
				return answer?.(input);
			},
		);
		await renderList();
		await openHidden(user);
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(SERVER_PAGE);
		});

		await user.click(screen.getByTestId("todo-age-hidden-load-more"));

		// The cursored read, then a read with NO cursor: the list started over.
		await waitFor(() => {
			expect(hiddenCalls().length).toBeGreaterThan(2);
		});
		expect(
			(hiddenCalls().at(-1)?.[0] as { cursor?: string })?.cursor,
		).toBeUndefined();

		const ids = hiddenRows().map((node) => node.dataset.todoId);
		expect(ids).toEqual(["old-1", "old-2"]);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("selecting the hidden to-dos", () => {
	it("selects and clears the whole loaded page at once", async () => {
		const user = userEvent.setup();
		seed({
			hidden: [
				item({ id: "old-1" }),
				item({ id: "old-2" }),
				item({ id: "old-3" }),
			],
		});
		await renderList();
		await openHidden(user);
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(SERVER_PAGE);
		});

		await user.click(screen.getByTestId("todo-age-hidden-select-all"));

		// "The loaded page" is what select-all means: the third row has not
		// been fetched, so it is not silently swept into the batch.
		expect(screen.getByTestId("todo-age-hidden-resolve")).toHaveTextContent(
			'{"count":2}',
		);
		for (const row of hiddenRows()) {
			expect(
				within(row).getByTestId("todo-age-hidden-select"),
			).toBeChecked();
		}

		await user.click(screen.getByTestId("todo-age-hidden-load-more"));
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(3);
		});

		// Select-all again now covers what is loaded NOW.
		await user.click(screen.getByTestId("todo-age-hidden-select-all"));
		expect(screen.getByTestId("todo-age-hidden-resolve")).toHaveTextContent(
			'{"count":3}',
		);

		await user.click(screen.getByTestId("todo-age-hidden-select-all"));
		for (const row of hiddenRows()) {
			expect(
				within(row).getByTestId("todo-age-hidden-select"),
			).not.toBeChecked();
		}
		expect(screen.getByTestId("todo-age-hidden-resolve")).toBeDisabled();
	});
});

describe("resolving a selection", () => {
	it("completes the chosen rows and takes them out of the view", async () => {
		const user = userEvent.setup();
		seed({
			hidden: [
				item({ id: "old-1", title: "First" }),
				item({ id: "old-2", title: "Second" }),
			],
		});
		await renderList();
		await openHidden(user);
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(2);
		});

		await selectHidden(user, "old-1");
		await selectHidden(user, "old-2");
		await user.click(screen.getByTestId("todo-age-hidden-resolve"));

		await waitFor(() => {
			expect(mockBulkResolve).toHaveBeenCalledWith({
				organizationId: "org-from-context",
				todoIds: ["old-1", "old-2"],
			});
		});

		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(0);
		});
		// The box is now empty, so its controls go with the rows — there is no
		// selection left for the button to re-run — and the receipt stays.
		expect(screen.getByTestId("todo-age-hidden-empty")).toBeVisible();
		expect(screen.queryByTestId("todo-age-hidden-resolve")).toBeNull();
		expect(screen.getByTestId("todo-age-hidden-summary")).toHaveTextContent(
			'"completed":2',
		);
	});

	it("keeps a row it could not resolve ticked, with the reason for THAT row", async () => {
		const user = userEvent.setup();
		seed({
			hidden: [
				item({ id: "old-1", title: "First" }),
				item({ id: "old-2", title: "Second" }),
				item({ id: "old-3", title: "Third" }),
			],
			outcomes: { "old-2": "vanished", "old-3": "forbidden" },
		});
		await renderList();
		await openHidden(user);
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(SERVER_PAGE);
		});
		await user.click(screen.getByTestId("todo-age-hidden-load-more"));
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(3);
		});

		await user.click(screen.getByTestId("todo-age-hidden-select-all"));
		await user.click(screen.getByTestId("todo-age-hidden-resolve"));

		// The one that worked is gone; the two that did not are still here —
		// including the vanished row, which the refetch has stopped returning.
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(2);
		});
		expect(screen.queryByText("First")).toBeNull();
		await waitFor(() => {
			expect(
				(hiddenCalls().at(-1)?.[0] as { cursor?: string })?.cursor,
			).toBeUndefined();
		});
		expect(fixture.hidden.map((row) => row.id)).toEqual(["old-3"]);

		// A row the read has dropped leads the list: it is the one thing in
		// this box that still needs a person.
		expect(hiddenRows()[0]?.dataset.todoId).toBe("old-2");

		const vanished = hiddenRow("old-2");
		const forbidden = hiddenRow("old-3");

		// Still ticked: the selection is what the person re-runs, and dropping
		// it would hide which rows were left behind.
		expect(
			within(vanished).getByTestId("todo-age-hidden-select"),
		).toBeChecked();
		expect(
			within(forbidden).getByTestId("todo-age-hidden-select"),
		).toBeChecked();

		// A DIFFERENT reason per outcome: "could not be resolved" says nothing
		// about whether to retry, to ask someone, or to stop looking.
		const vanishedReason = within(vanished).getByTestId(
			"todo-age-hidden-row-reason",
		);
		const forbiddenReason = within(forbidden).getByTestId(
			"todo-age-hidden-row-reason",
		);
		expect(vanishedReason).toHaveAttribute("data-outcome", "vanished");
		expect(vanishedReason).toHaveTextContent(
			`${T}.ageHidden.outcome.vanished`,
		);
		expect(forbiddenReason).toHaveAttribute("data-outcome", "forbidden");
		expect(forbiddenReason).toHaveTextContent(
			`${T}.ageHidden.outcome.forbidden`,
		);
		expect(vanishedReason.textContent).not.toEqual(
			forbiddenReason.textContent,
		);
	});

	it("re-runs only what is still ticked, and keeps a dropped row through it", async () => {
		// The retry is the point of keeping the selection: the rows that
		// committed must not be sent again, and a row the read has dropped has
		// to survive the second batch too or its reason disappears halfway
		// through the person's attempt to deal with it.
		const user = userEvent.setup();
		seed({
			hidden: [item({ id: "old-1" }), item({ id: "old-2" })],
			outcomes: { "old-2": "vanished" },
		});
		await renderList();
		await openHidden(user);
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(2);
		});

		await user.click(screen.getByTestId("todo-age-hidden-select-all"));
		await user.click(screen.getByTestId("todo-age-hidden-resolve"));
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(1);
		});

		await user.click(screen.getByTestId("todo-age-hidden-resolve"));

		await waitFor(() => {
			expect(mockBulkResolve).toHaveBeenLastCalledWith({
				organizationId: "org-from-context",
				todoIds: ["old-2"],
			});
		});
		await waitFor(() => {
			expect(
				within(hiddenRow("old-2")).getByTestId(
					"todo-age-hidden-row-reason",
				),
			).toHaveAttribute("data-outcome", "vanished");
		});
		expect(
			within(hiddenRow("old-2")).getByTestId("todo-age-hidden-select"),
		).toBeChecked();
	});

	it("reports both counts in a bar that stays until it is dismissed", async () => {
		const user = userEvent.setup();
		seed({
			hidden: [item({ id: "old-1" }), item({ id: "old-2" })],
			outcomes: { "old-2": "not_found" },
		});
		await renderList();
		await openHidden(user);
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(2);
		});

		await user.click(screen.getByTestId("todo-age-hidden-select-all"));
		await user.click(screen.getByTestId("todo-age-hidden-resolve"));

		const summary = await screen.findByTestId("todo-age-hidden-summary");
		expect(summary).toHaveTextContent(`${T}.ageHidden.summary.message`);
		expect(summary).toHaveTextContent('"completed":1');
		expect(summary).toHaveTextContent('"failed":1');

		// It survives the refetch its own batch triggered, and every re-render
		// after it: a toast here would be gone before the rows were read.
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(1);
		});
		expect(screen.getByTestId("todo-age-hidden-summary")).toBeVisible();

		await user.click(screen.getByTestId("todo-age-hidden-summary-dismiss"));
		expect(screen.queryByTestId("todo-age-hidden-summary")).toBeNull();
		// Dismissing the receipt does not drop the row still needing a person.
		expect(
			within(hiddenRow("old-2")).getByTestId(
				"todo-age-hidden-row-reason",
			),
		).toHaveAttribute("data-outcome", "not_found");
	});

	it("re-reads the list when a batch fails, because the server may have committed part of it", async () => {
		// A failure here does NOT mean nothing was written. The server commits
		// row by row on purpose and wraps nothing in a transaction, so a timeout
		// or a dropped connection part-way leaves the earlier rows done. The
		// cached list is then wrong in the one direction that matters — it shows
		// completed rows as open — and a person who trusts it presses the button
		// again, re-completing those rows under a new actor and time and writing
		// a second audit row for each. So the list is refetched from the only
		// party that knows how far the batch got. The selection still stands: it
		// is what the retry re-runs, and the refetch is what removes from it the
		// rows that no longer need it.
		const user = userEvent.setup();
		seed({ hidden: [item({ id: "old-1" })] });
		mockBulkResolve.mockRejectedValue(new Error("offline"));
		await renderList();
		await openHidden(user);
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(1);
		});

		await selectHidden(user, "old-1");
		const readsBefore = mockListTodos.mock.calls.length;
		await user.click(screen.getByTestId("todo-age-hidden-resolve"));

		await waitFor(() => {
			expect(mockToastError).toHaveBeenCalledWith(`${T}.ageHidden.error`);
		});
		// The assertion this test exists for: the failure path invalidates.
		await waitFor(() => {
			expect(mockListTodos.mock.calls.length).toBeGreaterThan(
				readsBefore,
			);
		});
		expect(hiddenRows()).toHaveLength(1);
		expect(
			within(hiddenRow("old-1")).getByTestId("todo-age-hidden-select"),
		).toBeChecked();
		expect(screen.queryByTestId("todo-age-hidden-summary")).toBeNull();
	});
});

describe("refreshing after a batch", () => {
	it("refetches the hidden view AND the default list through the derived key", async () => {
		// Both reads are wrong the moment the batch lands: the hidden view has
		// lost rows, and the default list's `ageHiddenCount` — the only reason
		// the line the reader opened exists at all — has dropped.
		const user = userEvent.setup();
		seed({
			live: [item({ id: "live-1", title: "Still live" })],
			hidden: [item({ id: "old-1" })],
		});
		await renderList();
		await openHidden(user);
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(1);
		});

		const defaultReadsBefore = defaultCalls().length;
		const hiddenReadsBefore = hiddenCalls().length;

		await selectHidden(user, "old-1");
		await user.click(screen.getByTestId("todo-age-hidden-resolve"));

		await waitFor(() => {
			expect(defaultCalls().length).toBeGreaterThan(defaultReadsBefore);
			expect(hiddenCalls().length).toBeGreaterThan(hiddenReadsBefore);
		});
	});

	it("would not have refetched through the hand-built key", async () => {
		// The negative control, and the whole reason the key is derived: this
		// filter is the obvious guess, it matches none of the three key shapes
		// in this app, and `invalidateQueries` reports no error while matching
		// nothing.
		const user = userEvent.setup();
		seed({ hidden: [item({ id: "old-1" })] });
		const { client } = await renderList();
		await openHidden(user);
		await waitFor(() => {
			expect(hiddenRows()).toHaveLength(1);
		});

		const defaultReads = defaultCalls().length;
		const hiddenReads = hiddenCalls().length;

		await client.invalidateQueries({ queryKey: ["todos", "list"] });
		expect(defaultCalls()).toHaveLength(defaultReads);
		expect(hiddenCalls()).toHaveLength(hiddenReads);

		await client.invalidateQueries({ queryKey: todoListQueryKey() });
		await waitFor(() => {
			expect(defaultCalls().length).toBeGreaterThan(defaultReads);
			expect(hiddenCalls().length).toBeGreaterThan(hiddenReads);
		});
	});
});

describe("partitionBulkResolve", () => {
	it("splits one response into what left and what still needs a person", () => {
		const { completedIds, failures } = partitionBulkResolve([
			{ todoId: "a", outcome: "completed" },
			{ todoId: "b", outcome: "vanished" },
			{ todoId: "c", outcome: "forbidden" },
			{ todoId: "d", outcome: "not_found" },
		]);

		expect(completedIds).toEqual(["a"]);
		expect(failures).toEqual({
			b: "vanished",
			c: "forbidden",
			d: "not_found",
		});
	});
});
