/**
 * What a To Do row can DO (Fizzy #2340).
 *
 * Every promise pinned here is one that fails SILENTLY when it breaks — the
 * screen still looks right, and the damage shows up as work nobody did:
 *
 *   1. Completing leaves the row on screen. A row that vanishes under the
 *      cursor gives nobody a chance to see the right one was ticked, and the
 *      next row slides under the second click of a double-click.
 *   2. A failed write rolls back and SAYS SO. A box that quietly un-ticks
 *      itself reads as a click that missed, so it gets clicked again.
 *   3. One request per row. The completion write is not idempotent in the
 *      sense that matters here: two in flight race each other to decide the
 *      final state.
 *   4. A write refreshes the list. Three query-key shapes coexist in this app
 *      and `invalidateQueries` reports NOTHING when a filter matches none of
 *      them, so the last describe below asserts the refetch AND that the
 *      plausible hand-built key would not have produced it.
 *   5. An unassignable row is a dead end. When the matcher found nobody, the
 *      confirm chip has nothing to offer, and without a way to add the person
 *      the transcript named the row can never be handed to anyone.
 *
 * THE HARNESS IS THE REAL LOOP. The list is rendered from the query it reads
 * in production, and the mutation mocks edit the fixture that query returns —
 * so a write, its invalidation and the refetched response all really happen.
 * That matters most for the completed rows: keeping them visible is only hard
 * ACROSS the refetch that reports them as completed.
 *
 * `next-intl` is mocked locally rather than relying on the global echo: the
 * global mock drops interpolation values, which would make the chosen snooze
 * date and the seeded contact name unassertable.
 */

import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	fixture,
	mockListTodos,
	mockComplete,
	mockSnooze,
	mockUnsnooze,
	mockAssign,
	mockCreateContact,
	mockSearchMembers,
	mockListContacts,
	mockToastError,
	mockToastSuccess,
} = vi.hoisted(() => ({
	/** Stands in for the database the read and the writes share. */
	fixture: {
		current: {
			items: [] as Record<string, unknown>[],
			ageHiddenCount: 0,
			ageThresholdDays: 30,
			unassignedExpandedProjectIds: [] as string[],
		},
	},
	mockListTodos: vi.fn(),
	mockComplete: vi.fn(),
	mockSnooze: vi.fn(),
	mockUnsnooze: vi.fn(),
	mockAssign: vi.fn(),
	mockCreateContact: vi.fn(),
	mockSearchMembers: vi.fn(),
	mockListContacts: vi.fn(),
	mockToastError: vi.fn(),
	mockToastSuccess: vi.fn(),
}));

// oRPC's own key shapes: `key()` is the path-only prefix and `queryOptions()`
// hangs `{ input, type }` below it. Written out here so the invalidation
// assertions below are about the real partial match, not about a stub that
// would match anything.
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
			},
			complete: { call: mockComplete },
			snooze: { call: mockSnooze },
			unsnooze: { call: mockUnsnooze },
			assign: { call: mockAssign },
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
						queryFn: () => mockListContacts(options.input),
					}),
				},
				create: { call: mockCreateContact },
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
		success: mockToastSuccess,
		error: mockToastError,
		info: vi.fn(),
		loading: vi.fn(),
	}),
}));

// Echo interpolation values so a date and a name are visible in the copy.
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

// Radix menus, dialogs, popovers and cmdk all need layout and pointer capture
// jsdom does not implement. The repo's pattern is to flatten them to
// pass-throughs so what they CONTAIN stays reachable; `Dialog` keeps its
// `open` so "the dialog is closed" remains a real assertion.
vi.mock("@ui/components/dropdown-menu", () => {
	const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
	const Item = ({
		children,
		onClick,
		onSelect,
		...rest
	}: {
		children?: ReactNode;
		onClick?: () => void;
		onSelect?: () => void;
	} & Record<string, unknown>) => (
		<button
			type="button"
			{...rest}
			onClick={() => {
				onClick?.();
				onSelect?.();
			}}
		>
			{children}
		</button>
	);
	return {
		DropdownMenu: Pass,
		DropdownMenuTrigger: Pass,
		DropdownMenuContent: Pass,
		DropdownMenuGroup: Pass,
		DropdownMenuLabel: Pass,
		DropdownMenuSeparator: () => null,
		DropdownMenuItem: Item,
		DropdownMenuCheckboxItem: Item,
		DropdownMenuRadioGroup: Pass,
		DropdownMenuRadioItem: Item,
		DropdownMenuSub: Pass,
		DropdownMenuSubContent: Pass,
		DropdownMenuSubTrigger: Pass,
	};
});

vi.mock("@ui/components/dialog", () => {
	const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
	return {
		Dialog: ({
			open,
			children,
		}: {
			open?: boolean;
			children?: ReactNode;
		}) => (open ? <>{children}</> : null),
		DialogTrigger: Pass,
		DialogClose: Pass,
		DialogContent: ({
			children,
			...rest
		}: { children?: ReactNode } & Record<string, unknown>) => (
			<div {...rest}>{children}</div>
		),
		DialogHeader: Pass,
		DialogFooter: Pass,
		DialogTitle: Pass,
		DialogDescription: Pass,
	};
});

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

// react-day-picker needs a calendar grid to click; the date itself is what the
// snooze contract is about, so the picker is reduced to "hand back one".
const CUSTOM_DATE = "2026-12-01T00:00:00.000Z";
vi.mock("@ui/components/calendar", () => ({
	Calendar: ({
		onSelect,
	}: {
		onSelect?: (date: Date | undefined) => void;
	}) => (
		<button
			type="button"
			data-testid="calendar-pick"
			onClick={() => onSelect?.(new Date(CUSTOM_DATE))}
		>
			pick a date
		</button>
	),
}));

import { TodoListBody } from "@saas/todos/components/TodoListBody";
import type {
	TodoListData,
	TodoListItem,
	TodoScope,
} from "@saas/todos/lib/todo-list-model";
import { todoListQueryKey } from "@saas/todos/lib/todos-api";
import { orpc } from "@shared/lib/orpc-query-utils";

const T = "todos.list";
const ADA = { id: "user-ada", name: "Ada Member", image: null };

function item(overrides: Partial<TodoListItem> & { id: string }): TodoListItem {
	return {
		source: "MANUAL",
		title: "Write the migration note",
		projectId: null,
		projectName: null,
		assigneeUserId: null,
		assigneeUser: null,
		assigneeContactId: null,
		assigneeContact: null,
		suggestedUserId: null,
		suggestedContactId: null,
		suggestionCandidates: null,
		assignedManually: false,
		snoozedUntil: null,
		sourceDate: "2026-09-10T09:00:00.000Z",
		completedAt: null,
		isCompleted: false,
		lastKnownCompletedAt: null,
		isOrphaned: false,
		...overrides,
	};
}

/** The rows the fake server holds, and the state the writes below edit. */
function seed(items: TodoListItem[], expandedProjectIds: string[] = []) {
	fixture.current = {
		items: items as unknown as Record<string, unknown>[],
		ageHiddenCount: 0,
		ageThresholdDays: 30,
		unassignedExpandedProjectIds: expandedProjectIds,
	};
}

function rowIn(container: HTMLElement = document.body) {
	return within(container).getByTestId("todo-row");
}

/**
 * The page's own read, rendering the body it feeds — so an invalidation really
 * refetches and the body really re-renders from the new response.
 *
 * ONE PAGE ON PURPOSE. The page reads `todos.list` as an infinite query and
 * hands the body the flattened pages plus a load-more control; none of that
 * changes what a row action does, and a paged fixture here would only put a
 * second cursor between a click and the assertion about it. Paging itself is
 * pinned in `TodoListPage.test.tsx`.
 */
const SCOPE_VIEW = {
	open: "default",
	completed: "completed",
	snoozed: "snoozed",
} as const;

function ListHarness() {
	// The page holds `scope` because the scope picks which SERVER VIEW to read,
	// and the harness has to hold it the same way. Filtering one default-view
	// response instead would make the Snoozed pill assertable in a test and
	// empty in production, which is exactly the gap this arrangement closes.
	const [scope, setScope] = useState<TodoScope>("open");
	const { data } = useQuery(
		orpc.todos.list.queryOptions({
			input: {
				organizationId: "org-from-context",
				view: SCOPE_VIEW[scope],
			},
		}),
	);
	return data ? (
		<TodoListBody
			data={data as TodoListData}
			organizationId="org-from-context"
			scope={scope}
			onScopeChange={setScope}
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
	const view = render(
		<QueryClientProvider client={client}>
			<ListHarness />
		</QueryClientProvider>,
	);
	await screen.findByTestId("todo-scope-pills");
	return { client, view };
}

beforeEach(() => {
	vi.clearAllMocks();
	seed([]);

	// A view-aware fake server, because the view is the whole contract: the
	// default view drops snoozed rows in SQL and keeps only the most recent
	// completed ones, and `snoozed`/`completed` are the only way back to them.
	// Returning every seeded row for every view would let a broken client pass.
	mockListTodos.mockImplementation(async (input: { view?: string }) => {
		const snapshot = structuredClone(fixture.current);
		const now = Date.now();
		const isSnoozed = (row: Record<string, unknown>) =>
			typeof row.snoozedUntil === "string" &&
			Date.parse(row.snoozedUntil) > now;
		const view = input?.view ?? "default";
		if (view === "snoozed") {
			snapshot.items = snapshot.items.filter(isSnoozed);
		} else if (view === "completed") {
			snapshot.items = snapshot.items.filter((row) => row.isCompleted);
		} else {
			snapshot.items = snapshot.items.filter((row) => !isSnoozed(row));
		}
		return snapshot;
	});

	// The writes edit the same fixture the read returns: that is what makes the
	// refetch a real one rather than a re-render of the same object.
	mockComplete.mockImplementation(
		async ({
			todoId,
			completed,
		}: {
			todoId: string;
			completed: boolean;
		}) => {
			const row = fixture.current.items.find(
				(candidate) => candidate.id === todoId,
			);
			if (row) {
				row.isCompleted = completed;
				row.completedAt = completed ? "2026-09-18T12:00:00.000Z" : null;
			}
			return {
				todoId,
				completed,
				completedAt: completed ? "2026-09-18T12:00:00.000Z" : null,
				completionTarget: "action_item",
				actionItemId: "action-item-1",
			};
		},
	);

	mockSnooze.mockImplementation(
		async ({
			todoId,
			snoozedUntil,
		}: {
			todoId: string;
			snoozedUntil: string;
		}) => {
			const row = fixture.current.items.find(
				(candidate) => candidate.id === todoId,
			);
			if (row) {
				row.snoozedUntil = snoozedUntil;
			}
			return { todoId, snoozedUntil };
		},
	);

	mockUnsnooze.mockImplementation(async ({ todoId }: { todoId: string }) => {
		const row = fixture.current.items.find(
			(candidate) => candidate.id === todoId,
		);
		const wasSnoozed = Boolean(row?.snoozedUntil);
		if (row) {
			row.snoozedUntil = null;
		}
		return { todoId, snoozedUntil: null, wasSnoozed };
	});

	mockAssign.mockImplementation(
		async ({
			todoId,
			assigneeUserId,
			assigneeContactId,
		}: {
			todoId: string;
			assigneeUserId: string | null;
			assigneeContactId: string | null;
		}) => {
			const row = fixture.current.items.find(
				(candidate) => candidate.id === todoId,
			);
			if (row) {
				row.assigneeUserId = assigneeUserId;
				row.assigneeUser = assigneeUserId
					? { id: assigneeUserId, name: "Ada Member", image: null }
					: null;
				row.assigneeContactId = assigneeContactId;
				row.assigneeContact = assigneeContactId
					? { id: assigneeContactId, name: "Cleo Client" }
					: null;
				row.assignedManually = true;
				row.suggestedUserId = null;
				row.suggestedContactId = null;
				row.suggestionCandidates = null;
			}
			return {
				todoId,
				assigneeUserId,
				assigneeContactId,
				assigneeKind: assigneeUserId
					? "member"
					: assigneeContactId
						? "contact"
						: "none",
				assignedManually: true,
			};
		},
	);

	mockSearchMembers.mockResolvedValue({
		members: [
			{
				id: ADA.id,
				name: ADA.name,
				email: "ada@example.com",
				avatarUrl: null,
				role: "member",
			},
		],
	});
	mockListContacts.mockResolvedValue({
		contacts: [],
		total: 0,
		hasMore: false,
		nextOffset: null,
	});
});

describe("completing a to-do", () => {
	it("marks the row and leaves it where it was", async () => {
		const user = userEvent.setup();
		seed([
			item({
				id: "todo-1",
				title: "Send the contract back",
				assigneeUserId: ADA.id,
				assigneeUser: ADA,
				assignedManually: true,
			}),
		]);
		await renderList();

		await user.click(await screen.findByTestId("todo-row-complete"));

		expect(mockComplete).toHaveBeenCalledWith({
			organizationId: "org-from-context",
			todoId: "todo-1",
			completed: true,
		});

		// Still on screen AFTER the refetch that reports it completed — which
		// is the only moment the promise is hard to keep, because the open view
		// has every reason to drop a completed row.
		await waitFor(() => {
			expect(mockListTodos.mock.calls.length).toBeGreaterThan(1);
		});
		expect(screen.getByTestId("todo-row")).toBeVisible();
		await waitFor(() => {
			expect(screen.getByTestId("todo-row-complete")).toBeChecked();
		});
	});

	it("rolls back and says so when the write fails", async () => {
		const user = userEvent.setup();
		mockComplete.mockRejectedValue(new Error("nope"));
		seed([
			item({ id: "todo-1", assigneeUserId: ADA.id, assigneeUser: ADA }),
		]);
		await renderList();

		await user.click(await screen.findByTestId("todo-row-complete"));

		await waitFor(() => {
			expect(mockToastError).toHaveBeenCalledWith(
				`${T}.actions.errors.complete`,
			);
		});
		// The optimistic tick is released, the row is back to what the server
		// still says, and nothing about it was silently kept.
		await waitFor(() => {
			expect(screen.getByTestId("todo-row-complete")).not.toBeChecked();
		});
		expect(screen.getByTestId("todo-row")).toBeVisible();
	});

	it("fires one request for a double-click", async () => {
		let settle: (() => void) | null = null;
		mockComplete.mockImplementation(
			() =>
				new Promise((resolve) => {
					settle = () => resolve({ todoId: "todo-1" });
				}),
		);
		seed([
			item({ id: "todo-1", assigneeUserId: ADA.id, assigneeUser: ADA }),
		]);
		await renderList();

		const box = await screen.findByTestId("todo-row-complete");
		// Raw events rather than `userEvent`, which awaits between clicks: the
		// guard this asserts exists for the pair that arrives before React has
		// re-rendered the disabled state.
		fireEvent.click(box);
		fireEvent.click(box);

		await waitFor(() => {
			expect(mockComplete).toHaveBeenCalled();
		});
		expect(mockComplete).toHaveBeenCalledTimes(1);
		settle?.();
	});

	it("completes an orphaned row, whose completion lives on the row itself", async () => {
		const user = userEvent.setup();
		seed([
			item({
				id: "todo-orphan",
				source: "MEETING_DIGEST",
				title: "Chase the signed SOW",
				projectId: "proj-1",
				projectName: "Apollo",
				assigneeUserId: ADA.id,
				assigneeUser: ADA,
				isOrphaned: true,
			}),
		]);
		await renderList();

		expect(await screen.findByTestId("todo-row-orphaned")).toBeVisible();
		await user.click(screen.getByTestId("todo-row-complete"));

		expect(mockComplete).toHaveBeenCalledWith({
			organizationId: "org-from-context",
			todoId: "todo-orphan",
			completed: true,
		});
		await waitFor(() => {
			expect(mockToastError).not.toHaveBeenCalled();
		});
	});

	it("says a row was completed before its wording changed", async () => {
		seed([
			item({
				id: "todo-was-done",
				source: "MEETING_DIGEST",
				title: "Book the retro",
				assigneeUserId: ADA.id,
				assigneeUser: ADA,
				isOrphaned: true,
				isCompleted: false,
				lastKnownCompletedAt: "2026-08-02T09:00:00.000Z",
			}),
		]);
		await renderList();

		const note = await screen.findByTestId("todo-row-previously-completed");
		expect(note).toHaveTextContent(`${T}.previouslyCompleted`);
		expect(note).toHaveTextContent("2026-08-02");
	});
});

describe("completed rows staying put", () => {
	it("survives leaving the page and coming back", async () => {
		const user = userEvent.setup();
		seed([
			item({
				id: "todo-1",
				title: "Send the contract back",
				assigneeUserId: ADA.id,
				assigneeUser: ADA,
				assignedManually: true,
			}),
		]);
		const { client, view } = await renderList();

		await user.click(await screen.findByTestId("todo-row-complete"));
		await waitFor(() => {
			expect(fixture.current.items[0]?.isCompleted).toBe(true);
		});

		// Walking into a meeting digest and back: the page unmounts, the
		// QueryClient does not.
		view.unmount();
		await renderList(client);

		expect(await screen.findByTestId("todo-row")).toBeVisible();
		expect(screen.getByText("Send the contract back")).toBeVisible();
	});

	it("does not survive a full reload, where the server's own rule takes over", async () => {
		const user = userEvent.setup();
		seed([
			item({
				id: "todo-1",
				title: "Send the contract back",
				assigneeUserId: ADA.id,
				assigneeUser: ADA,
				assignedManually: true,
			}),
		]);
		const { view } = await renderList();

		await user.click(await screen.findByTestId("todo-row-complete"));
		await waitFor(() => {
			expect(fixture.current.items[0]?.isCompleted).toBe(true);
		});

		view.unmount();
		// A fresh QueryClient is what a reload produces. The completed row is
		// then the server's business: the default read carries the two most
		// recently completed, and the open view stops pinning this one.
		await renderList(makeClient());

		await waitFor(() => {
			expect(screen.queryByTestId("todo-row")).toBeNull();
		});
	});
});

describe("snoozing", () => {
	it("takes the row out of the open view and shows the date it wakes", async () => {
		const user = userEvent.setup();
		seed([
			item({
				id: "todo-1",
				title: "Send the contract back",
				assigneeUserId: ADA.id,
				assigneeUser: ADA,
				assignedManually: true,
			}),
		]);
		await renderList();

		await user.click(await screen.findByTestId("todo-menu-snooze-week"));

		const call = mockSnooze.mock.calls[0]?.[0];
		expect(call.todoId).toBe("todo-1");
		expect(call.organizationId).toBe("org-from-context");
		const days =
			(Date.parse(call.snoozedUntil) - Date.now()) /
			(24 * 60 * 60 * 1000);
		expect(days).toBeGreaterThan(6.5);
		expect(days).toBeLessThan(7.5);

		await waitFor(() => {
			expect(screen.queryByTestId("todo-row")).toBeNull();
		});

		// It has not been deleted, and the Snoozed view says exactly when it is
		// coming back.
		await user.click(
			screen.getByRole("button", { name: `${T}.scope.snoozed` }),
		);
		const row = await screen.findByTestId("todo-row");
		expect(
			within(row).getByTestId("todo-row-snoozed-until"),
		).toHaveTextContent(call.snoozedUntil.slice(0, 10));
	});

	it("takes a date from the calendar", async () => {
		const user = userEvent.setup();
		seed([
			item({
				id: "todo-1",
				assigneeUserId: ADA.id,
				assigneeUser: ADA,
				assignedManually: true,
			}),
		]);
		await renderList();

		await user.click(await screen.findByTestId("todo-menu-snooze-custom"));
		await user.click(await screen.findByTestId("calendar-pick"));
		await user.click(screen.getByTestId("todo-snooze-confirm"));

		expect(mockSnooze).toHaveBeenCalledWith({
			organizationId: "org-from-context",
			todoId: "todo-1",
			snoozedUntil: CUSTOM_DATE,
		});
		// The dialog owns one row at a time and closes behind the choice.
		await waitFor(() => {
			expect(screen.queryByTestId("todo-snooze-dialog")).toBeNull();
		});
	});

	it("brings a snoozed row back", async () => {
		const user = userEvent.setup();
		const wakeAt = new Date(
			Date.now() + 5 * 24 * 60 * 60 * 1000,
		).toISOString();
		seed([
			item({
				id: "todo-1",
				title: "Send the contract back",
				assigneeUserId: ADA.id,
				assigneeUser: ADA,
				assignedManually: true,
				snoozedUntil: wakeAt,
			}),
		]);
		await renderList();

		// It starts out of the open view, exactly as the read intends.
		expect(screen.queryByTestId("todo-row")).toBeNull();
		await user.click(
			await screen.findByRole("button", { name: `${T}.scope.snoozed` }),
		);
		await user.click(await screen.findByTestId("todo-menu-unsnooze"));

		expect(mockUnsnooze).toHaveBeenCalledWith({
			organizationId: "org-from-context",
			todoId: "todo-1",
		});

		await user.click(
			screen.getByRole("button", { name: `${T}.scope.open` }),
		);
		expect(await screen.findByTestId("todo-row")).toBeVisible();
	});
});

describe("assigning", () => {
	it("confirms one of the matcher's candidates and clears the unassigned bucket", async () => {
		const user = userEvent.setup();
		seed(
			[
				item({
					id: "todo-1",
					source: "MEETING_DIGEST",
					title: "Confirm the launch date",
					projectId: "proj-1",
					projectName: "Apollo",
					suggestionCandidates: [
						{ kind: "user", id: ADA.id, name: ADA.name },
					],
				}),
			],
			["proj-1"],
		);
		await renderList();

		const bucket = await screen.findByTestId("todo-unassigned-bucket");
		expect(within(bucket).getByTestId("todo-row")).toBeVisible();
		const chip = within(bucket).getByTestId("todo-suggestion-confirm");
		expect(chip).toHaveTextContent(ADA.name);

		await user.click(chip);

		expect(mockAssign).toHaveBeenCalledWith({
			organizationId: "org-from-context",
			todoId: "todo-1",
			assigneeUserId: ADA.id,
			assigneeContactId: null,
		});

		// It leaves the pile of work nobody owns, and stops asking a question
		// that has been answered.
		await waitFor(() => {
			expect(screen.queryByTestId("todo-unassigned-bucket")).toBeNull();
		});
		expect(screen.queryByTestId("todo-suggestion-confirm")).toBeNull();
		expect(rowIn()).toHaveTextContent(ADA.name);
	});

	it("offers one confirm control per candidate rather than picking for the reader", async () => {
		seed(
			[
				item({
					id: "todo-1",
					source: "MEETING_DIGEST",
					projectId: "proj-1",
					projectName: "Apollo",
					suggestionCandidates: [
						{ kind: "user", id: ADA.id, name: ADA.name },
						{
							kind: "contact",
							id: "contact-1",
							name: "Ada Client",
						},
						// Malformed entries are dropped, not rendered as chips
						// labelled `undefined`.
						{ kind: "user", id: "", name: "" },
						"nonsense",
					],
				}),
			],
			["proj-1"],
		);
		await renderList();

		const chips = await screen.findAllByTestId("todo-suggestion-confirm");
		expect(chips).toHaveLength(2);
	});

	it("assigns from the picker on a row the matcher had no guess for", async () => {
		const user = userEvent.setup();
		seed(
			[
				item({
					id: "todo-1",
					source: "MEETING_DIGEST",
					title: "Chase the signed SOW",
					projectId: "proj-1",
					projectName: "Apollo",
					suggestionCandidates: [],
				}),
			],
			["proj-1"],
		);
		await renderList();

		// No candidate, so no confirm chip exists to do this job.
		expect(screen.queryByTestId("todo-suggestion-confirm")).toBeNull();

		await user.click(await screen.findByTestId("todo-menu-assign"));
		await user.click(await screen.findByTestId("todo-assignee-member"));

		expect(mockAssign).toHaveBeenCalledWith({
			organizationId: "org-from-context",
			todoId: "todo-1",
			assigneeUserId: ADA.id,
			assigneeContactId: null,
		});
		await waitFor(() => {
			expect(screen.queryByTestId("todo-assignee-dialog")).toBeNull();
		});
	});

	it("unassigns from the picker", async () => {
		const user = userEvent.setup();
		seed([
			item({
				id: "todo-1",
				assigneeUserId: ADA.id,
				assigneeUser: ADA,
				assignedManually: true,
			}),
		]);
		await renderList();

		await user.click(await screen.findByTestId("todo-menu-assign"));
		await user.click(await screen.findByTestId("todo-assignee-unassign"));

		expect(mockAssign).toHaveBeenCalledWith({
			organizationId: "org-from-context",
			todoId: "todo-1",
			assigneeUserId: null,
			assigneeContactId: null,
		});
	});
});

describe("filling the register at the moment of need", () => {
	const meetingRow = () =>
		item({
			id: "todo-1",
			source: "MEETING_DIGEST",
			title: "Send the revised quote",
			projectId: "proj-1",
			projectName: "Apollo",
			suggestionCandidates: [],
			tentativeOwnerName: "Cleo Client",
		});

	it("creates the contact the transcript named and assigns it in one action", async () => {
		const user = userEvent.setup();
		mockCreateContact.mockResolvedValue({
			status: "created",
			contact: {
				id: "contact-new",
				organizationId: "org-from-context",
				name: "Cleo Client",
				email: null,
				company: null,
				createdAt: "2026-09-18T12:00:00.000Z",
				updatedAt: "2026-09-18T12:00:00.000Z",
			},
			duplicates: [],
		});
		seed([meetingRow()], ["proj-1"]);
		await renderList();

		await user.click(
			await screen.findByTestId("todo-suggestion-create-contact"),
		);

		// Seeded with the name that was said out loud, so the register fills
		// itself rather than sending the reader to settings.
		const nameField = await screen.findByLabelText(`${T}.newContact.name`);
		expect(nameField).toHaveValue("Cleo Client");

		await user.click(screen.getByTestId("todo-new-contact-submit"));

		await waitFor(() => {
			expect(mockCreateContact).toHaveBeenCalledWith({
				organizationId: "org-from-context",
				name: "Cleo Client",
				email: undefined,
				company: undefined,
				confirmDuplicate: undefined,
			});
		});
		await waitFor(() => {
			expect(mockAssign).toHaveBeenCalledWith({
				organizationId: "org-from-context",
				todoId: "todo-1",
				assigneeUserId: null,
				assigneeContactId: "contact-new",
			});
		});
		await waitFor(() => {
			expect(rowIn()).toHaveTextContent("Cleo Client");
		});
	});

	it("asks before adding a second person with the same name, and keeps what was typed", async () => {
		const user = userEvent.setup();
		mockCreateContact.mockResolvedValueOnce({
			status: "duplicate",
			contact: null,
			duplicates: [
				{
					id: "contact-existing",
					organizationId: "org-from-context",
					name: "Cleo Client",
					email: "cleo@example.com",
					company: null,
					createdAt: "2026-05-01T12:00:00.000Z",
					updatedAt: "2026-05-01T12:00:00.000Z",
				},
			],
		});
		mockCreateContact.mockResolvedValueOnce({
			status: "created",
			contact: {
				id: "contact-second",
				organizationId: "org-from-context",
				name: "Cleo Client",
				email: null,
				company: null,
				createdAt: "2026-09-18T12:00:00.000Z",
				updatedAt: "2026-09-18T12:00:00.000Z",
			},
			duplicates: [],
		});
		seed([meetingRow()], ["proj-1"]);
		await renderList();

		await user.click(
			await screen.findByTestId("todo-suggestion-create-contact"),
		);
		await user.click(await screen.findByTestId("todo-new-contact-submit"));

		// Nothing was written and nothing was assigned: the refusal is a
		// question, and `contact` was null on that branch.
		expect(
			await screen.findByTestId("todo-new-contact-duplicate"),
		).toBeVisible();
		expect(mockAssign).not.toHaveBeenCalled();

		await user.click(
			screen.getByTestId("todo-new-contact-confirm-duplicate"),
		);

		await waitFor(() => {
			expect(mockCreateContact).toHaveBeenLastCalledWith({
				organizationId: "org-from-context",
				name: "Cleo Client",
				email: undefined,
				company: undefined,
				confirmDuplicate: true,
			});
		});
		await waitFor(() => {
			expect(mockAssign).toHaveBeenCalledWith({
				organizationId: "org-from-context",
				todoId: "todo-1",
				assigneeUserId: null,
				assigneeContactId: "contact-second",
			});
		});
	});

	it("can hand the row to the person who is already in the register", async () => {
		const user = userEvent.setup();
		mockCreateContact.mockResolvedValue({
			status: "duplicate",
			contact: null,
			duplicates: [
				{
					id: "contact-existing",
					organizationId: "org-from-context",
					name: "Cleo Client",
					email: "cleo@example.com",
					company: null,
					createdAt: "2026-05-01T12:00:00.000Z",
					updatedAt: "2026-05-01T12:00:00.000Z",
				},
			],
		});
		seed([meetingRow()], ["proj-1"]);
		await renderList();

		await user.click(
			await screen.findByTestId("todo-suggestion-create-contact"),
		);
		await user.click(await screen.findByTestId("todo-new-contact-submit"));
		await user.click(
			await screen.findByTestId("todo-new-contact-use-existing"),
		);

		expect(mockAssign).toHaveBeenCalledWith({
			organizationId: "org-from-context",
			todoId: "todo-1",
			assigneeUserId: null,
			assigneeContactId: "contact-existing",
		});
		expect(mockCreateContact).toHaveBeenCalledTimes(1);
	});

	it("keeps the draft when the create fails", async () => {
		const user = userEvent.setup();
		mockCreateContact.mockRejectedValue(new Error("nope"));
		seed([meetingRow()], ["proj-1"]);
		await renderList();

		await user.click(
			await screen.findByTestId("todo-suggestion-create-contact"),
		);
		const company = await screen.findByLabelText(`${T}.newContact.company`);
		await user.type(company, "Northwind");
		await user.click(screen.getByTestId("todo-new-contact-submit"));

		await waitFor(() => {
			expect(mockToastError).toHaveBeenCalledWith(
				`${T}.newContact.error`,
			);
		});
		// A failed save must not make someone retype what they had typed.
		expect(screen.getByLabelText(`${T}.newContact.company`)).toHaveValue(
			"Northwind",
		);
		expect(screen.getByLabelText(`${T}.newContact.name`)).toHaveValue(
			"Cleo Client",
		);
	});
});

describe("refreshing the list after a write", () => {
	it("refetches through the derived key", async () => {
		const user = userEvent.setup();
		seed([
			item({ id: "todo-1", assigneeUserId: ADA.id, assigneeUser: ADA }),
		]);
		await renderList();

		await waitFor(() => {
			expect(mockListTodos).toHaveBeenCalledTimes(1);
		});

		await user.click(await screen.findByTestId("todo-row-complete"));

		await waitFor(() => {
			expect(mockListTodos).toHaveBeenCalledTimes(2);
		});
	});

	it("would not have refetched through the hand-built key", async () => {
		// The negative control, and the whole reason the key is derived: this
		// filter is the obvious guess, it matches none of the three key shapes
		// in this app, and `invalidateQueries` reports no error while matching
		// nothing. Swap `todoListQueryKey()` for it in the mutations and the
		// assertion above stops holding — with no failure anywhere else.
		const { client } = await renderList();
		await waitFor(() => {
			expect(mockListTodos).toHaveBeenCalledTimes(1);
		});

		await client.invalidateQueries({ queryKey: ["todos", "list"] });
		expect(mockListTodos).toHaveBeenCalledTimes(1);

		await client.invalidateQueries({ queryKey: todoListQueryKey() });
		await waitFor(() => {
			expect(mockListTodos).toHaveBeenCalledTimes(2);
		});
	});
});
