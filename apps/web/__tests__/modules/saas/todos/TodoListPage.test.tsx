/**
 * The To Do page shell (Fizzy #2340) — the states a reader can be in, and the
 * read that feeds them.
 *
 * Most of the list body is built separately and has its own suites; what this
 * file pins is what the PAGE is responsible for, which is everything about the
 * request:
 *
 *   1. `todos.list` answers NOT_FOUND when the rollout flag is off for the
 *      organization, and a gate reporting "absent" must not be rendered as a
 *      failure. The sidebar entry is absent then too, so nobody should arrive —
 *      a hand-typed URL still must not be told the product is broken.
 *   2. THE LIST PAGES. The read returns fifty rows with `hasMore`; a page that
 *      renders the first fifty and stops looks finished, and the reader has no
 *      way to tell a fifty-row workspace from a five-hundred-row one.
 *   3. EVERY ROW ONCE. The keyset pages a live list, so two fetches can overlap
 *      and serve the same row twice; and when the read cannot place the cursor
 *      at all it says `cursorStale` instead of answering with the first page.
 *      Appending either one gives duplicate React keys and a row that renders
 *      twice with two sets of actions.
 *   4. THE FILTERS ARE ARGUMENTS TO THE READ. Project and assignee travel to
 *      the server, so "filter by Borealis" means the workspace's Borealis work
 *      and not "the Borealis rows that happen to be in the loaded page".
 *
 * `next-intl` is mocked globally in vitest.setup.ts (every `t(key)` echoes the
 * key), so the assertions below are on translation keys, not on final copy.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListTodos, mockCatchUp } = vi.hoisted(() => ({
	mockListTodos: vi.fn(),
	mockCatchUp: vi.fn(),
}));

/**
 * The imperative client, separate from the query one: the catch-up is fired,
 * not read, so it never becomes a query and never appears in the cache.
 */
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { todos: { catchUp: (input: unknown) => mockCatchUp(input) } },
}));

/**
 * oRPC's own key shapes, written out rather than stubbed: `queryOptions()`
 * hangs `{ input, type: "query" }` below the path and `infiniteOptions()` hangs
 * `{ input: input(initialPageParam), type: "infinite" }`. The page relies on
 * that key carrying every argument to the read — a scope or filter change is a
 * DIFFERENT key, which is what makes it a fresh page-1 list rather than an
 * append — so the mock has to reproduce it rather than return a constant.
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
			// #2340: the list body asks this for the meetings it renders, and a
			// meeting-sourced row asks the second one once its work-item panel is
			// opened. Answered empty — this file is about the page's own states.
			proposals: {
				pendingMeetings: {
					queryOptions: (opts: {
						input: unknown;
						enabled?: boolean;
					}) => ({
						queryKey: [
							"todos",
							"proposals",
							"pendingMeetings",
							opts.input,
						],
						queryFn: async () => ({ meetings: [] }),
						enabled: opts.enabled,
					}),
				},
				linkedWorkItems: {
					queryOptions: (opts: {
						input: unknown;
						enabled?: boolean;
					}) => ({
						queryKey: [
							"todos",
							"proposals",
							"linkedWorkItems",
							opts.input,
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
						enabled: opts.enabled,
					}),
				},
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks", () => ({
	// The page always passes an explicit id (its server component resolved
	// one); the context fallback is exercised by the hook's own tests.
	useEffectiveOrganizationId: (propOrgId: string | null | undefined) =>
		propOrgId !== undefined ? propOrgId : "org-from-context",
	// Read by the list body for the meeting deep link's root.
	useBasePath: () => "/app/acme",
}));

// Radix's popover and cmdk both need layout and pointer capture jsdom does not
// implement; the repo's pattern is to flatten them to pass-throughs so the
// OPTIONS stay reachable. The combobox filters its own options
// (`shouldFilter={false}`), so nothing under test is mocked away here.
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
		CommandInput: ({
			value,
			onValueChange,
			placeholder,
			...rest
		}: {
			value?: string;
			onValueChange?: (value: string) => void;
			placeholder?: string;
		}) => (
			<input
				{...rest}
				value={value}
				placeholder={placeholder}
				onChange={(event) => onValueChange?.(event.target.value)}
			/>
		),
		CommandItem: ({
			children,
			onSelect,
		}: {
			children?: ReactNode;
			onSelect?: () => void;
		}) => (
			<button type="button" onClick={() => onSelect?.()}>
				{children}
			</button>
		),
	};
});

import { TodoListPage } from "../../../../modules/saas/todos/components/TodoListPage";

function renderShell() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(<TodoListPage organizationId="org-A" />, { wrapper });
}

const ADA = { id: "user-ada", name: "Ada Member", image: null };

/**
 * One row, ASSIGNED by default: an unassigned row renders inside a collapsible
 * bucket that may be shut, and these cases count rows.
 */
function row(
	id: string,
	title: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		source: "MANUAL",
		title,
		projectId: null,
		projectName: null,
		assigneeUserId: ADA.id,
		assigneeUser: ADA,
		assigneeContactId: null,
		assigneeContact: null,
		suggestedUserId: null,
		suggestedContactId: null,
		assignedManually: true,
		snoozedUntil: null,
		sourceDate: "2026-09-10T09:00:00.000Z",
		completedAt: null,
		isCompleted: false,
		isOrphaned: false,
		...overrides,
	};
}

/** One response, with the paging fields the page reads. */
function page(
	items: ReturnType<typeof row>[],
	overrides: Record<string, unknown> = {},
) {
	return {
		items,
		hasMore: false,
		nextCursor: null,
		cursorStale: false,
		ageHiddenCount: 0,
		ageThresholdDays: 30,
		unassignedExpandedProjectIds: [],
		...overrides,
	};
}

const listInputs = () =>
	mockListTodos.mock.calls.map(([input]) => input as Record<string, unknown>);

const rows = () => screen.queryAllByTestId("todo-row");

const QUIET_CATCH_UP = {
	candidates: 0,
	started: 0,
	failed: 0,
	hasMore: false,
} as const;

beforeEach(() => {
	vi.clearAllMocks();
	// A default answer, not a queued one: `clearAllMocks` empties the call log
	// but leaves implementations in place, so a per-test `mockResolvedValueOnce`
	// would outlive its test and shift the next one's queue.
	mockCatchUp.mockResolvedValue(QUIET_CATCH_UP);
});

describe("TodoListPage catch-up", () => {
	// Turning the flag on populates nothing by itself: extraction does not
	// re-run for a meeting it has already analysed, so nothing re-starts the
	// owner matcher for anything older than the rollout. Opening the page is
	// what picks those up, and without this call the page is permanently empty
	// for exactly the organizations that have the most history.
	it("starts the catch-up once, for the organization it is showing", async () => {
		mockListTodos.mockResolvedValue(page([]));

		const { rerender } = renderShell();

		await waitFor(() => {
			expect(mockCatchUp).toHaveBeenCalledWith({
				organizationId: "org-A",
			});
		});

		rerender(<TodoListPage organizationId="org-A" />);
		await screen.findByText("todos.empty.title");
		// The ref guard, not the server's duplicate collapsing: a re-render
		// between the request and its answer must not ask a second time.
		expect(mockCatchUp).toHaveBeenCalledTimes(1);
	});

	it("re-reads the list when runs were already in flight", async () => {
		mockListTodos.mockResolvedValue(page([]));
		mockCatchUp.mockResolvedValue({ ...QUIET_CATCH_UP, started: 2 });

		renderShell();

		// Rows written by a run that finished before this answer are already
		// there and the cached list predates them. The rest arrive on an
		// ordinary later refetch — this page does not poll.
		await waitFor(() => {
			expect(mockListTodos.mock.calls.length).toBeGreaterThan(1);
		});
	});

	it("leaves the page usable when the catch-up cannot start", async () => {
		mockListTodos.mockResolvedValue(page([row("todo-1", "Send the deck")]));
		mockCatchUp.mockRejectedValue(new Error("temporal down"));

		renderShell();

		// The reader came for the list, not for the backfill. A failure here is
		// not theirs to see, and the rows that did load still render.
		expect(await screen.findByText("Send the deck")).toBeVisible();
		expect(screen.queryByText("todos.loadFailed")).toBeNull();
	});
});

describe("TodoListPage shell", () => {
	it("reads the list for the organization it was given", async () => {
		mockListTodos.mockResolvedValue(page([]));

		renderShell();

		// The view and the page size travel with the read. The view because the
		// page picks which of the server's scopes to ask for; the limit because
		// this is page one of a cursor-paged list rather than "everything" —
		// both are stated rather than implied, so a change to either default is
		// a change to this assertion.
		expect(mockListTodos).toHaveBeenCalledWith({
			organizationId: "org-A",
			view: "default",
			limit: 50,
		});
		expect(await screen.findByText("todos.empty.title")).toBeVisible();
	});

	it("says it is loading while the read is in flight", () => {
		// Never settles — the pending state is the whole point.
		mockListTodos.mockReturnValue(new Promise(() => {}));

		renderShell();

		expect(screen.getByRole("status")).toHaveTextContent("todos.loading");
		expect(screen.queryByText("todos.empty.title")).toBeNull();
	});

	it("waits in the shape of the list rather than on a bare spinner", () => {
		// This is a project manager's landing surface and the one read crosses
		// every project they can reach, so the wait is long enough to be looked
		// at: outlined rows hold the layout a spinner would reflow.
		mockListTodos.mockReturnValue(new Promise(() => {}));

		renderShell();

		expect(screen.getByTestId("todo-list-skeleton")).toBeVisible();
	});

	it("offers an empty state rather than a bare heading", async () => {
		mockListTodos.mockResolvedValue(page([]));

		renderShell();

		expect(await screen.findByText("todos.empty.title")).toBeVisible();
		expect(screen.getByText("todos.empty.description")).toBeVisible();
		// The heading stays put: the page is still the page when it is empty.
		expect(
			screen.getByRole("heading", { name: "todos.title" }),
		).toBeVisible();
	});

	it("treats the rollout gate's NOT_FOUND as absent, not as an error", async () => {
		mockListTodos.mockRejectedValue(
			Object.assign(new Error("The To Do list is not available"), {
				code: "NOT_FOUND",
			}),
		);

		renderShell();

		expect(await screen.findByText("todos.unavailable")).toBeVisible();
		expect(screen.queryByText("todos.loadFailed")).toBeNull();
	});

	it("mounts the list body once the read returns rows", async () => {
		// The shell's seam: everything below it is `TodoListBody`'s own suite.
		mockListTodos.mockResolvedValue(
			page([row("todo-1", "Send the contract back")]),
		);

		renderShell();

		expect(await screen.findByText("Send the contract back")).toBeVisible();
		expect(screen.queryByText("todos.empty.title")).toBeNull();
	});

	it("still reports a real failure as a failure", async () => {
		// The negative control for the case above: swallowing every error into
		// "not turned on yet" would make an outage look like a rollout.
		mockListTodos.mockRejectedValue(
			Object.assign(new Error("boom"), { code: "INTERNAL_SERVER_ERROR" }),
		);

		renderShell();

		expect(await screen.findByText("todos.loadFailed")).toBeVisible();
		expect(screen.queryByText("todos.unavailable")).toBeNull();
	});
});

describe("TodoListPage paging", () => {
	it("offers the rest of the list and appends it when asked", async () => {
		const user = userEvent.setup();
		mockListTodos.mockImplementation(async (input: { cursor?: string }) =>
			input.cursor
				? page([row("todo-2", "Second page row")])
				: page([row("todo-1", "First page row")], {
						hasMore: true,
						nextCursor: "todo-1",
					}),
		);

		renderShell();

		expect(await screen.findByText("First page row")).toBeVisible();
		// Fifty rows and a full stop is the defect this replaces: the reader
		// could not tell a finished list from a truncated one.
		expect(screen.queryByText("Second page row")).toBeNull();

		await user.click(screen.getByTestId("todo-load-more"));

		expect(await screen.findByText("Second page row")).toBeVisible();
		// APPENDED, not replaced: the second page joins the first.
		expect(screen.getByText("First page row")).toBeVisible();
		expect(listInputs().at(-1)).toMatchObject({ cursor: "todo-1" });
		// And the affordance goes when the read says there is nothing left.
		expect(screen.queryByTestId("todo-load-more")).toBeNull();
	});

	it("renders a row once when the next page repeats one already loaded", async () => {
		const user = userEvent.setup();
		// A live keyset can serve the same row twice — the cursor row's sort
		// key moved between the two fetches, so the second page resumes from
		// its new place and overlaps the first.
		mockListTodos.mockImplementation(async (input: { cursor?: string }) =>
			input.cursor
				? page([
						row("todo-2", "Shared row"),
						row("todo-3", "Third row"),
					])
				: page(
						[
							row("todo-1", "First row"),
							row("todo-2", "Shared row"),
						],
						{ hasMore: true, nextCursor: "todo-2" },
					),
		);

		renderShell();

		await screen.findByText("First row");
		await user.click(screen.getByTestId("todo-load-more"));

		expect(await screen.findByText("Third row")).toBeVisible();
		// Three distinct to-dos were served across four rows of response.
		expect(screen.getAllByText("Shared row")).toHaveLength(1);
		expect(rows()).toHaveLength(3);
	});

	it("starts the list again when the read cannot place the cursor", async () => {
		const user = userEvent.setup();
		let firstPages = 0;
		mockListTodos.mockImplementation(async (input: { cursor?: string }) => {
			if (input.cursor) {
				// The row the cursor named is gone: deleted, or no longer
				// visible to this viewer. There is no page after it.
				return page([], { cursorStale: true });
			}
			firstPages += 1;
			return firstPages === 1
				? page(
						[
							row("todo-1", "Still here"),
							row("todo-2", "Gone now"),
						],
						{
							hasMore: true,
							nextCursor: "todo-2",
						},
					)
				: page([row("todo-1", "Still here")]);
		});

		renderShell();

		await screen.findByText("Gone now");
		await user.click(screen.getByTestId("todo-load-more"));

		// The list restarts from page one rather than appending an answer that
		// is a fragment of an ordering that has moved.
		await waitFor(() => expect(screen.queryByText("Gone now")).toBeNull());
		expect(screen.getByText("Still here")).toBeVisible();
		expect(rows()).toHaveLength(1);
		expect(firstPages).toBeGreaterThan(1);
	});

	it("starts a fresh read when the scope changes rather than appending", async () => {
		const user = userEvent.setup();
		mockListTodos.mockImplementation(async (input: { view?: string }) =>
			input.view === "completed"
				? page([
						row("todo-done", "Already handled", {
							isCompleted: true,
							completedAt: "2026-09-12T09:00:00.000Z",
						}),
					])
				: page([row("todo-open", "Still to do")], {
						hasMore: true,
						nextCursor: "todo-open",
					}),
		);

		renderShell();
		await screen.findByText("Still to do");

		await user.click(screen.getByText("todos.list.scope.completed"));

		expect(await screen.findByText("Already handled")).toBeVisible();
		// The open scope's rows are not carried into the archive: the scope is
		// part of the read's key, so this is a different list, from page one.
		expect(screen.queryByText("Still to do")).toBeNull();
		expect(rows()).toHaveLength(1);
		expect(listInputs().at(-1)).toMatchObject({ view: "completed" });
		expect(listInputs().at(-1)).not.toHaveProperty("cursor");
	});
});

describe("TodoListPage filters", () => {
	const APOLLO = { projectId: "proj-apollo", projectName: "Apollo" };
	const BOREALIS = { projectId: "proj-borealis", projectName: "Borealis" };

	/**
	 * A workspace whose Borealis work does NOT fit in the first page. The
	 * second Borealis row is the whole point of these cases: no amount of
	 * narrowing in the browser can produce a row the browser never received.
	 */
	function seedTwoProjects(
		filtered = [
			row("todo-b1", "Borealis first", BOREALIS),
			row("todo-b2", "Borealis fifty-first", BOREALIS),
		],
	) {
		mockListTodos.mockImplementation(
			async (input: { projectId?: string }) =>
				input.projectId === BOREALIS.projectId
					? page(filtered)
					: page(
							[
								row("todo-a1", "Apollo first", APOLLO),
								row("todo-b1", "Borealis first", BOREALIS),
							],
							{ hasMore: true, nextCursor: "todo-b1" },
						),
		);
	}

	const chooseProject = async (
		user: ReturnType<typeof userEvent.setup>,
		name: string,
	) =>
		user.click(
			within(screen.getByTestId("todo-project-filter-popover")).getByText(
				name,
			),
		);

	it("sends the project filter to the read instead of sieving the loaded page", async () => {
		const user = userEvent.setup();
		seedTwoProjects();

		renderShell();
		await screen.findByText("Apollo first");

		await chooseProject(user, "Borealis");

		expect(listInputs().at(-1)).toEqual({
			organizationId: "org-A",
			view: "default",
			limit: 50,
			projectId: "proj-borealis",
		});
		// The row that proves it: "Borealis fifty-first" was never in the page
		// the browser held, so it can only be here because the SERVER answered
		// the question the chip above the list claims to be asking.
		expect(await screen.findByText("Borealis fifty-first")).toBeVisible();
		expect(screen.getByText("Borealis first")).toBeVisible();
		expect(screen.queryByText("Apollo first")).toBeNull();
	});

	it("keeps offering the projects it has seen while a filter is on", async () => {
		const user = userEvent.setup();
		seedTwoProjects();

		renderShell();
		await screen.findByText("Apollo first");
		await chooseProject(user, "Borealis");
		await screen.findByText("Borealis fifty-first");

		// The filtered response holds no Apollo row at all. Options derived
		// from it alone would collapse to Borealis, and the only way back to
		// Apollo would be to clear the filter first.
		expect(
			within(screen.getByTestId("todo-project-filter-popover")).getByText(
				"Apollo",
			),
		).toBeVisible();
	});

	it("keeps the filter bar on screen when the filtered read comes back empty", async () => {
		const user = userEvent.setup();
		seedTwoProjects([]);

		renderShell();
		await screen.findByText("Apollo first");

		await chooseProject(user, "Borealis");

		expect(
			await screen.findByText("todos.list.noMatches.title"),
		).toBeVisible();
		// "Nothing to do" is a statement about the WORKSPACE, and this is not
		// that — and replacing the page with it would take away the chip that
		// is the only way back to the rest of the list.
		expect(screen.queryByText("todos.empty.title")).toBeNull();
		expect(screen.getByTestId("todo-project-chip")).toHaveTextContent(
			"Borealis",
		);
	});
});
