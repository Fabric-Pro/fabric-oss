/**
 * Feature proposals and their work items, on the To Do page (Fizzy #2340).
 *
 * Every promise pinned here fails SILENTLY when it breaks — the page still
 * renders, and what is lost is the answer somebody came for:
 *
 *   1. THE PENDING INDICATOR IS PER MEETING. The Feature Proposals inbox is a
 *      queue per meeting and a person reviews it per meeting. Repeated on
 *      every row of one meeting, the same fact reads as eight things to do; so
 *      the count is asserted to appear ONCE on the group heading, whatever the
 *      meeting's row count.
 *   2. THE WORK ITEMS ARE NOT FETCHED EAGERLY. This page spans every project a
 *      person can reach. A read mounted with the row would be one request per
 *      row on first paint, for an answer that is empty for most of them.
 *   3. `linkingEnabled: false` IS A NORMAL STATE. The linking flag defaults
 *      OFF. With it off the links must render NOTHING — not an error, not an
 *      empty box that reads like a failed load — while the pending indicator,
 *      which is NOT behind that flag, stays exactly where it is.
 *   4. A REJECTION REFRESHES THE ROW. Three query-key shapes coexist in this
 *      app and `invalidateQueries` reports NOTHING when a filter matches none
 *      of them, so the last describe asserts the refetch AND that the
 *      plausible hand-built key would not have produced it.
 *
 * THE HARNESS IS THE REAL LOOP. The list is rendered from the query it reads
 * in production and the link writes edit the fixture those reads return, so a
 * write, its invalidation and the refetched answer all really happen. That is
 * the only way to tell "the chip went away" from "the component dropped it".
 *
 * `next-intl` is mocked locally rather than relying on the global echo: the
 * global mock DROPS interpolation values, which would make the pending count
 * and a work item's identifier unassertable.
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

const {
	fixture,
	mockListTodos,
	mockPendingMeetings,
	mockLinkedWorkItems,
	mockManageLink,
	mockComplete,
	mockSnooze,
	mockUnsnooze,
	mockAssign,
	mockCreateContact,
	mockSearchMembers,
	mockListContacts,
	mockToastError,
} = vi.hoisted(() => ({
	/** Stands in for the database every read and write below shares. */
	fixture: {
		current: {
			items: [] as Record<string, unknown>[],
			ageHiddenCount: 0,
			ageThresholdDays: 30,
			unassignedExpandedProjectIds: [] as string[],
		},
		/** What `proposals.pendingMeetings` answers, by (ref, project). */
		meetings: [] as {
			transcriptRef: string;
			projectId: string;
			pendingCount: number;
		}[],
		/** What `proposals.linkedWorkItems` answers, by to-do id. */
		workItems: {} as Record<string, Record<string, unknown>>,
	},
	mockListTodos: vi.fn(),
	mockPendingMeetings: vi.fn(),
	mockLinkedWorkItems: vi.fn(),
	mockManageLink: vi.fn(),
	mockComplete: vi.fn(),
	mockSnooze: vi.fn(),
	mockUnsnooze: vi.fn(),
	mockAssign: vi.fn(),
	mockCreateContact: vi.fn(),
	mockSearchMembers: vi.fn(),
	mockListContacts: vi.fn(),
	mockToastError: vi.fn(),
}));

/**
 * oRPC's own key shapes, written out rather than stubbed to something that
 * matches anything: `key()` is the path-only prefix, `key({ input })` adds the
 * input, and `queryOptions()` hangs `{ input, type }` below it. The
 * invalidation assertions at the end are about THAT partial match.
 */
const operationKey = (
	path: string[],
	options?: { input?: Record<string, unknown> },
) => [path, options?.input !== undefined ? { input: options.input } : {}];

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		todos: {
			list: {
				key: () => operationKey(["todos", "list"]),
				queryOptions: (options: { input: unknown }) => ({
					queryKey: [
						["todos", "list"],
						{ input: options.input, type: "query" },
					],
					queryFn: () => mockListTodos(options.input),
				}),
			},
			complete: { call: mockComplete },
			snooze: { call: mockSnooze },
			unsnooze: { call: mockUnsnooze },
			assign: { call: mockAssign },
			proposals: {
				pendingMeetings: {
					key: (options?: { input?: Record<string, unknown> }) =>
						operationKey(
							["todos", "proposals", "pendingMeetings"],
							options,
						),
					queryOptions: (options: {
						input: unknown;
						enabled?: boolean;
					}) => ({
						queryKey: [
							["todos", "proposals", "pendingMeetings"],
							{ input: options.input, type: "query" },
						],
						queryFn: () => mockPendingMeetings(options.input),
						enabled: options.enabled,
					}),
				},
				linkedWorkItems: {
					key: (options?: { input?: Record<string, unknown> }) =>
						operationKey(
							["todos", "proposals", "linkedWorkItems"],
							options,
						),
					queryOptions: (options: {
						input: unknown;
						enabled?: boolean;
					}) => ({
						queryKey: [
							["todos", "proposals", "linkedWorkItems"],
							{ input: options.input, type: "query" },
						],
						queryFn: () => mockLinkedWorkItems(options.input),
						enabled: options.enabled,
					}),
				},
				manageLink: { call: mockManageLink },
			},
			contacts: {
				list: {
					key: () => operationKey(["todos", "contacts", "list"]),
					queryOptions: (options: { input: unknown }) => ({
						queryKey: [
							["todos", "contacts", "list"],
							{ input: options.input, type: "query" },
						],
						queryFn: () => mockListContacts(options.input),
					}),
				},
				create: { call: mockCreateContact },
			},
		},
		organizations: {
			searchMembers: {
				key: () => operationKey(["organizations", "searchMembers"]),
				queryOptions: (options: { input: unknown }) => ({
					queryKey: [
						["organizations", "searchMembers"],
						{ input: options.input, type: "query" },
					],
					queryFn: () => mockSearchMembers(options.input),
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

// Echo the interpolation values so a count and an identifier are visible.
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

import { TodoListBody } from "@saas/todos/components/TodoListBody";
import type {
	TodoListData,
	TodoListItem,
} from "@saas/todos/lib/todo-list-model";
import { todoLinkedWorkItemsQueryKey } from "@saas/todos/lib/todo-proposals-api";
import { orpc } from "@shared/lib/orpc-query-utils";

const T = "todos.list";

const ADA = { id: "user-ada", name: "Ada Owner", image: null };

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
		assignedManually: true,
		snoozedUntil: null,
		sourceDate: "2026-09-10T09:00:00.000Z",
		completedAt: null,
		isCompleted: false,
		isOrphaned: false,
		suggestionCandidates: [],
		...overrides,
	};
}

/** A row of the one meeting every test below groups on. */
function meetingRow(
	overrides: Partial<TodoListItem> & { id: string },
): TodoListItem {
	return item({
		source: "MEETING_DIGEST",
		title: "Ship the export",
		projectId: "proj-1",
		projectName: "Atlas",
		meetingTranscriptRef: "ref-1",
		meetingItemKey: "key-1",
		meetingTitle: "Weekly sync",
		...overrides,
	});
}

function workItem(overrides: Record<string, unknown> = {}) {
	return {
		storyId: "story-1",
		identifier: "ATL-12",
		title: "Export to CSV",
		kind: "FEATURE",
		statusName: "In progress",
		isDone: false,
		linkId: "link-1",
		origin: "CREATED",
		confidence: null,
		fromProposal: true,
		...overrides,
	};
}

/** What `linkedWorkItems` answers for one to-do. */
function linkedAnswer(todoId: string, overrides: Record<string, unknown> = {}) {
	return {
		todoId,
		transcriptRef: "ref-1",
		projectId: "proj-1",
		linkingEnabled: true,
		resolvedVia: "itemKey",
		isOrphaned: false,
		items: [workItem()],
		...overrides,
	};
}

function seed(params: {
	items: TodoListItem[];
	meetings?: {
		transcriptRef: string;
		projectId: string;
		pendingCount: number;
	}[];
	workItems?: Record<string, Record<string, unknown>>;
}) {
	fixture.current = {
		items: params.items as unknown as Record<string, unknown>[],
		ageHiddenCount: 0,
		ageThresholdDays: 30,
		unassignedExpandedProjectIds: [],
	};
	fixture.meetings = params.meetings ?? [];
	fixture.workItems = params.workItems ?? {};
}

/**
 * The page's own read, rendering the body it feeds — so an invalidation really
 * refetches and the panel really re-renders from the new answer.
 *
 * ONE PAGE ON PURPOSE. In production the page reads `todos.list` as an infinite
 * query and hands the body the flattened pages; the proposals indicator is
 * derived from the groups on screen whatever produced them, so a paged fixture
 * would add a cursor to every case here and prove nothing extra. Paging is
 * pinned in `TodoListPage.test.tsx`.
 */
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

/** Open one row's work-item panel and wait for the answer to land. */
async function openWorkItems(
	user: ReturnType<typeof userEvent.setup>,
	index = 0,
) {
	const toggles = await screen.findAllByTestId("todo-row-work-items-toggle");
	await user.click(toggles[index]);
	await waitFor(() => {
		expect(mockLinkedWorkItems).toHaveBeenCalled();
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	seed({ items: [] });

	mockListTodos.mockImplementation(async () =>
		structuredClone(fixture.current),
	);
	mockPendingMeetings.mockImplementation(async () => ({
		meetings: structuredClone(fixture.meetings),
	}));
	mockLinkedWorkItems.mockImplementation(
		async ({ todoId }: { todoId: string }) =>
			structuredClone(
				fixture.workItems[todoId] ?? {
					todoId,
					transcriptRef: null,
					projectId: null,
					linkingEnabled: true,
					resolvedVia: null,
					isOrphaned: false,
					items: [],
				},
			),
	);

	/**
	 * The write the digest shares. Rejecting removes the LINK, not the work
	 * item: a ticket an approved proposal produced still exists once its tie
	 * is tombstoned, and the read keeps returning it — unlinked. A link that
	 * came from nowhere else simply goes.
	 */
	mockManageLink.mockImplementation(
		async ({
			todoId,
			storyId,
			action,
		}: {
			todoId: string;
			storyId: string;
			action: "accept" | "reject";
		}) => {
			const entry = fixture.workItems[todoId] as
				| { items: Record<string, unknown>[] }
				| undefined;
			if (!entry) {
				throw new Error("no such to-do");
			}
			if (action === "reject") {
				entry.items = entry.items.flatMap((row) =>
					row.storyId !== storyId
						? [row]
						: row.fromProposal
							? [{ ...row, linkId: null, origin: null }]
							: [],
				);
			} else {
				entry.items = entry.items.map((row) =>
					row.storyId === storyId
						? {
								...row,
								linkId: `link-${storyId}`,
								origin: "MANUAL",
							}
						: row,
				);
			}
			return { todoId, storyId, action, changed: true };
		},
	);

	mockListContacts.mockResolvedValue({ items: [] });
	mockSearchMembers.mockResolvedValue({ members: [] });
});

describe("the per-meeting pending-proposals indicator", () => {
	it("shows once on the group heading, not once per row", async () => {
		seed({
			items: [
				meetingRow({ id: "todo-1" }),
				meetingRow({ id: "todo-2", title: "Draft the note" }),
			],
			meetings: [
				{
					transcriptRef: "ref-1",
					projectId: "proj-1",
					pendingCount: 3,
				},
			],
		});
		await renderList();

		const badges = await screen.findAllByTestId(
			"todo-meeting-proposals-pending",
		);
		// Two rows, one meeting, ONE badge — the whole reason the read is
		// asked per meeting rather than carried on the list.
		expect(badges).toHaveLength(1);
		expect(screen.getAllByTestId("todo-row")).toHaveLength(2);

		// It lives in the seam on the heading, not inside a row.
		const slot = screen.getByTestId("todo-meeting-group-slot");
		expect(within(slot).getByTestId("todo-meeting-proposals-pending")).toBe(
			badges[0],
		);
		expect(badges[0]).toHaveTextContent(
			`${T}.proposals.pending {"count":3}`,
		);
	});

	it("links into that project's Feature Proposals inbox", async () => {
		seed({
			items: [meetingRow({ id: "todo-1" })],
			meetings: [
				{
					transcriptRef: "ref-1",
					projectId: "proj-1",
					pendingCount: 1,
				},
			],
		});
		await renderList();

		expect(
			await screen.findByTestId("todo-meeting-proposals-pending"),
		).toHaveAttribute(
			"href",
			"/app/acme/projects/proj-1?tab=stories&inbox=proposals",
		);
	});

	it("asks only about the meetings on screen, once", async () => {
		seed({
			items: [
				meetingRow({ id: "todo-1" }),
				meetingRow({ id: "todo-2" }),
				item({ id: "todo-3" }),
			],
			meetings: [],
		});
		await renderList();

		await waitFor(() => {
			expect(mockPendingMeetings).toHaveBeenCalledTimes(1);
		});
		// Deduplicated: one meeting, two rows, one ref.
		expect(mockPendingMeetings).toHaveBeenCalledWith({
			organizationId: "org-from-context",
			transcriptRefs: ["ref-1"],
		});
	});

	it("shows nothing for a meeting with nothing waiting", async () => {
		seed({ items: [meetingRow({ id: "todo-1" })], meetings: [] });
		await renderList();

		await waitFor(() => {
			expect(mockPendingMeetings).toHaveBeenCalledTimes(1);
		});
		expect(
			screen.queryByTestId("todo-meeting-proposals-pending"),
		).not.toBeInTheDocument();
		// The seam stays — it is the heading's layout, not the badge.
		expect(
			screen.getByTestId("todo-meeting-group-slot"),
		).toBeEmptyDOMElement();
	});

	it("shows nothing — and asks nothing — for a page of manual to-dos", async () => {
		seed({
			items: [item({ id: "todo-1" })],
			meetings: [
				{
					transcriptRef: "ref-1",
					projectId: "proj-1",
					pendingCount: 2,
				},
			],
		});
		await renderList();

		await screen.findByTestId("todo-manual-group");
		expect(
			screen.queryByTestId("todo-meeting-proposals-pending"),
		).not.toBeInTheDocument();
		// The read demands at least one ref, so a page with no meeting must
		// not send a request it knows is a validation error.
		expect(mockPendingMeetings).not.toHaveBeenCalled();
		// A typed to-do has no meeting item, so it is offered no work items.
		expect(
			screen.queryByTestId("todo-row-work-items-toggle"),
		).not.toBeInTheDocument();
	});
});

describe("the work items a to-do produced", () => {
	it("is not fetched for every row on first paint", async () => {
		const user = userEvent.setup();
		seed({
			items: [
				meetingRow({ id: "todo-1" }),
				meetingRow({ id: "todo-2", title: "Draft the note" }),
				meetingRow({ id: "todo-3", title: "Book the room" }),
			],
			workItems: {
				"todo-1": linkedAnswer("todo-1"),
				"todo-2": linkedAnswer("todo-2"),
				"todo-3": linkedAnswer("todo-3"),
			},
		});
		await renderList();

		await screen.findAllByTestId("todo-row-work-items-toggle");
		// Three rows on screen and NOT ONE request: this page spans every
		// project, so a read mounted with the row is a read per row.
		expect(mockLinkedWorkItems).not.toHaveBeenCalled();

		await openWorkItems(user, 0);

		expect(mockLinkedWorkItems).toHaveBeenCalledTimes(1);
		expect(mockLinkedWorkItems).toHaveBeenCalledWith({
			organizationId: "org-from-context",
			todoId: "todo-1",
		});
	});

	it("renders an accepted proposal's work item as a link with its identifier", async () => {
		const user = userEvent.setup();
		seed({
			items: [meetingRow({ id: "todo-1" })],
			workItems: { "todo-1": linkedAnswer("todo-1") },
		});
		await renderList();
		await openWorkItems(user);

		const link = await screen.findByTestId("todo-work-item-link");
		expect(link).toHaveTextContent("ATL-12");
		expect(link).toHaveTextContent("Export to CSV");
		expect(link).toHaveAttribute(
			"href",
			"/app/acme/projects/proj-1/stories/story-1",
		);
		expect(screen.getByTestId("todo-work-item-status")).toHaveTextContent(
			"In progress",
		);
	});

	it("says so when the to-do produced nothing", async () => {
		const user = userEvent.setup();
		seed({
			items: [meetingRow({ id: "todo-1" })],
			workItems: { "todo-1": linkedAnswer("todo-1", { items: [] }) },
		});
		await renderList();
		await openWorkItems(user);

		expect(
			await screen.findByTestId("todo-work-items-empty"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("todo-work-items-error"),
		).not.toBeInTheDocument();
	});

	it("reports a failed read instead of looking empty", async () => {
		const user = userEvent.setup();
		seed({ items: [meetingRow({ id: "todo-1" })] });
		mockLinkedWorkItems.mockRejectedValue(new Error("nope"));
		await renderList();
		await openWorkItems(user);

		expect(
			await screen.findByTestId("todo-work-items-error"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("todo-work-items-empty"),
		).not.toBeInTheDocument();
	});

	it("shows an orphan's work items without offering to change them", async () => {
		const user = userEvent.setup();
		seed({
			items: [meetingRow({ id: "todo-1", isOrphaned: true })],
			workItems: {
				"todo-1": linkedAnswer("todo-1", { isOrphaned: true }),
			},
		});
		await renderList();
		await openWorkItems(user);

		// The ticket is real and stays visible; the write would refuse,
		// because a reworded item has no key a link can be addressed by.
		expect(await screen.findByTestId("todo-work-item")).toBeInTheDocument();
		expect(
			screen.getByTestId("todo-work-items-orphaned"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("todo-work-item-reject"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("todo-work-item-accept"),
		).not.toBeInTheDocument();
	});
});

describe("answering for a link", () => {
	it("rejects it, removes it, and refetches the row", async () => {
		const user = userEvent.setup();
		seed({
			items: [meetingRow({ id: "todo-1" })],
			workItems: {
				"todo-1": linkedAnswer("todo-1", {
					// A link that no proposal produced: rejecting it leaves
					// nothing behind, so the chip really goes.
					items: [workItem({ fromProposal: false, origin: "AUTO" })],
				}),
			},
		});
		await renderList();
		await openWorkItems(user);

		await user.click(await screen.findByTestId("todo-work-item-reject"));
		// Durable and shared with the digest, so it asks first.
		await user.click(
			await screen.findByTestId("todo-work-item-reject-confirm"),
		);

		await waitFor(() => {
			expect(mockManageLink).toHaveBeenCalledWith({
				organizationId: "org-from-context",
				todoId: "todo-1",
				storyId: "story-1",
				action: "reject",
			});
		});
		await waitFor(() => {
			expect(mockLinkedWorkItems).toHaveBeenCalledTimes(2);
		});
		await waitFor(() => {
			expect(
				screen.queryByTestId("todo-work-item"),
			).not.toBeInTheDocument();
		});
	});

	it("keeps a rejected proposal's work item, untied", async () => {
		const user = userEvent.setup();
		seed({
			items: [meetingRow({ id: "todo-1" })],
			workItems: { "todo-1": linkedAnswer("todo-1") },
		});
		await renderList();
		await openWorkItems(user);

		await user.click(await screen.findByTestId("todo-work-item-reject"));
		await user.click(
			await screen.findByTestId("todo-work-item-reject-confirm"),
		);

		// The ticket exists — an approved proposal made it — and only the tie
		// was tombstoned. Dropping it here would claim the work vanished.
		await waitFor(() => {
			expect(screen.getByTestId("todo-work-item")).toHaveAttribute(
				"data-linked",
				"false",
			);
		});
		expect(
			screen.getByTestId("todo-work-item-unlinked"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("todo-work-item-reject"),
		).not.toBeInTheDocument();
	});

	it("accepts an untied work item", async () => {
		const user = userEvent.setup();
		seed({
			items: [meetingRow({ id: "todo-1" })],
			workItems: {
				"todo-1": linkedAnswer("todo-1", {
					// The shape a proposal approved while the linking flag was
					// off leaves behind: a real ticket and no link row.
					items: [workItem({ linkId: null, origin: null })],
				}),
			},
		});
		await renderList();
		await openWorkItems(user);

		await user.click(await screen.findByTestId("todo-work-item-accept"));

		await waitFor(() => {
			expect(mockManageLink).toHaveBeenCalledWith({
				organizationId: "org-from-context",
				todoId: "todo-1",
				storyId: "story-1",
				action: "accept",
			});
		});
		await waitFor(() => {
			expect(screen.getByTestId("todo-work-item")).toHaveAttribute(
				"data-linked",
				"true",
			);
		});
	});

	it("says so when the write fails, and changes nothing", async () => {
		const user = userEvent.setup();
		seed({
			items: [meetingRow({ id: "todo-1" })],
			workItems: { "todo-1": linkedAnswer("todo-1") },
		});
		mockManageLink.mockRejectedValue(new Error("nope"));
		await renderList();
		await openWorkItems(user);

		await user.click(await screen.findByTestId("todo-work-item-reject"));
		await user.click(
			await screen.findByTestId("todo-work-item-reject-confirm"),
		);

		await waitFor(() => {
			expect(mockToastError).toHaveBeenCalledWith(
				`${T}.proposals.links.errors.reject`,
			);
		});
		// Nothing was written, so the chip is exactly where it was — a silent
		// no-op is what teaches people to click twice.
		expect(screen.getByTestId("todo-work-item")).toHaveAttribute(
			"data-linked",
			"true",
		);
	});
});

describe("with MEETING_ACTION_ITEM_LINKING off", () => {
	it("keeps the pending indicator and renders no links", async () => {
		const user = userEvent.setup();
		seed({
			items: [meetingRow({ id: "todo-1" })],
			meetings: [
				{
					transcriptRef: "ref-1",
					projectId: "proj-1",
					pendingCount: 2,
				},
			],
			workItems: {
				"todo-1": linkedAnswer("todo-1", {
					linkingEnabled: false,
					resolvedVia: null,
					items: [],
				}),
			},
		});
		await renderList();

		// The proposal inbox is NOT behind the linking flag, so turning the
		// linking rollout off must not take its indicator with it.
		expect(
			await screen.findByTestId("todo-meeting-proposals-pending"),
		).toBeInTheDocument();

		await openWorkItems(user);

		// Nothing: not an error, not an empty box that reads like a failure,
		// and not a toggle that opens onto nothing.
		await waitFor(() => {
			expect(
				screen.queryByTestId("todo-row-work-items-toggle"),
			).not.toBeInTheDocument();
		});
		expect(
			screen.queryByTestId("todo-row-work-items"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("todo-work-items-empty"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("todo-work-items-error"),
		).not.toBeInTheDocument();
	});
});

describe("refreshing one row's work items", () => {
	it("refetches through the derived key", async () => {
		const client = makeClient();
		const user = userEvent.setup();
		seed({
			items: [meetingRow({ id: "todo-1" })],
			workItems: { "todo-1": linkedAnswer("todo-1") },
		});
		await renderList(client);
		await openWorkItems(user);
		expect(mockLinkedWorkItems).toHaveBeenCalledTimes(1);

		await client.invalidateQueries({
			queryKey: todoLinkedWorkItemsQueryKey("todo-1"),
		});

		await waitFor(() => {
			expect(mockLinkedWorkItems).toHaveBeenCalledTimes(2);
		});
	});

	it("would not have refetched through the hand-built key", async () => {
		// The negative control, and the whole reason the key is derived: this
		// filter is the obvious guess, it matches none of the three key shapes
		// in this app, and `invalidateQueries` reports no error while matching
		// nothing. Swap it in and the rejection above stops refreshing the row
		// — with no failure anywhere else.
		const client = makeClient();
		const user = userEvent.setup();
		seed({
			items: [meetingRow({ id: "todo-1" })],
			workItems: { "todo-1": linkedAnswer("todo-1") },
		});
		await renderList(client);
		await openWorkItems(user);
		expect(mockLinkedWorkItems).toHaveBeenCalledTimes(1);

		await client.invalidateQueries({
			queryKey: ["todos", "proposals", "linkedWorkItems"],
		});
		expect(mockLinkedWorkItems).toHaveBeenCalledTimes(1);

		await client.invalidateQueries({
			queryKey: todoLinkedWorkItemsQueryKey("todo-1"),
		});
		await waitFor(() => {
			expect(mockLinkedWorkItems).toHaveBeenCalledTimes(2);
		});
	});

	it("leaves every other row's panel alone", async () => {
		const client = makeClient();
		const user = userEvent.setup();
		seed({
			items: [
				meetingRow({ id: "todo-1" }),
				meetingRow({ id: "todo-2", title: "Draft the note" }),
			],
			workItems: {
				"todo-1": linkedAnswer("todo-1"),
				"todo-2": linkedAnswer("todo-2"),
			},
		});
		await renderList(client);
		await openWorkItems(user, 0);
		await openWorkItems(user, 1);
		await waitFor(() => {
			expect(mockLinkedWorkItems).toHaveBeenCalledTimes(2);
		});

		await client.invalidateQueries({
			queryKey: todoLinkedWorkItemsQueryKey("todo-1"),
		});

		// Scoped on `{ input: { todoId } }`: answering for one row must not
		// refetch a hundred sibling panels.
		await waitFor(() => {
			expect(mockLinkedWorkItems).toHaveBeenCalledTimes(3);
		});
		expect(
			mockLinkedWorkItems.mock.calls.filter(
				([input]) => (input as { todoId: string }).todoId === "todo-2",
			),
		).toHaveLength(1);
	});
});
