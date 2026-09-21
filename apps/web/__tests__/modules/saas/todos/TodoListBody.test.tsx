/**
 * The consolidated To Do list body (Fizzy #2340).
 *
 * What is pinned here is what the list PROMISES a reader, because every one of
 * these is silently wrong in a way that looks fine on screen:
 *
 *   1. A row says where it came from, when, and who owes it — including
 *      "nobody". An unowned commitment that renders like an owned one is the
 *      failure this page exists to end.
 *   2. A contact is visibly not a member. The same dashed mark and "no
 *      account" badge the contact register uses, or the page quietly tells the
 *      reader that a client's PM has a Fabric account.
 *   3. An orphan admits it. Its wording came from a snapshot and whoever it
 *      names is a suggestion; presenting that as a fact invents an obligation.
 *   4. The Unassigned bucket opens for exactly the projects THE SERVER named.
 *      Re-deriving "is this viewer a product owner" in the browser is how the
 *      two answers drift apart.
 *   5. The age-hidden line exists whenever something is hidden. Without it, a
 *      list that stops at ten rows is indistinguishable from a silent delete.
 *
 * `next-intl` is mocked locally rather than relying on the global echo: the
 * global mock DROPS interpolation values, which would make "shows its wake
 * date" and "reports how many are hidden" unassertable.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@saas/organizations/hooks", () => ({
	useBasePath: () => "/app/acme",
	useEffectiveOrganizationId: (propOrgId: string | null | undefined) =>
		propOrgId !== undefined ? propOrgId : "org-from-context",
}));

// Echo the interpolation values so a date, a name and a count are visible in
// the rendered copy.
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

// Radix's popover and cmdk both need layout and pointer capture jsdom does not
// implement; the repo's pattern is to flatten them to pass-throughs so the
// OPTIONS stay reachable. The combobox filters its own options
// (`shouldFilter={false}`), so nothing under test is mocked away here.
vi.mock("@ui/components/popover", () => {
	const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
	// The content keeps its props: the popover's own test id is how each of the
	// two comboboxes' option lists is told apart once both are flattened open.
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

import {
	TodoListBody,
	type TodoFilterBar,
	type TodoListPaging,
} from "@saas/todos/components/TodoListBody";
import type {
	TodoListData,
	TodoListItem,
	TodoScope,
} from "@saas/todos/lib/todo-list-model";

const T = "todos.list";

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
		assignedManually: false,
		snoozedUntil: null,
		sourceDate: "2026-09-10T09:00:00.000Z",
		completedAt: null,
		isCompleted: false,
		isOrphaned: false,
		...overrides,
	};
}

const ADA = { id: "user-ada", name: "Ada Member", image: null };

/**
 * The body writes as well as reads: its row actions hold their optimistic
 * values, their in-flight guard and the just-completed set in the query cache,
 * so it needs a client even in a test that only looks at what is rendered.
 * What those writes DO is pinned in `TodoRowActions.test.tsx`; here the client
 * is scaffolding.
 */
function renderBody(
	data: Partial<TodoListData> = {},
	/**
	 * What the PAGE supplies in production: the filter bar's state (because
	 * project and assignee are arguments to the read) and what the read has
	 * left to give. Omitted, the body falls back to narrowing what it was
	 * handed — which is all a caller with one fixed response can honestly do,
	 * and what the cases above exercise.
	 */
	owner: { filters?: TodoFilterBar; paging?: TodoListPaging } = {},
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	// The page owns `scope` in production because it chooses which server view
	// to read. These tests click the pills, so the harness stands in for that
	// owner and holds the state the page would hold.
	function ScopedBody() {
		const [scope, setScope] = useState<TodoScope>("open");
		return (
			<TodoListBody
				data={{
					items: [],
					ageHiddenCount: 0,
					ageThresholdDays: 30,
					unassignedExpandedProjectIds: [],
					...data,
				}}
				organizationId="org-from-context"
				scope={scope}
				onScopeChange={setScope}
				filters={owner.filters}
				paging={owner.paging}
			/>
		);
	}
	return render(
		<QueryClientProvider client={client}>
			<ScopedBody />
		</QueryClientProvider>,
	);
}

describe("TodoListBody rows", () => {
	it("shows a manual row's own title, its source and its source date", () => {
		renderBody({
			items: [
				item({
					id: "todo-1",
					title: "Send the contract back",
					assigneeUserId: ADA.id,
					assigneeUser: ADA,
					assignedManually: true,
				}),
			],
		});

		const row = screen.getByTestId("todo-row");
		expect(within(row).getByText("Send the contract back")).toBeVisible();
		expect(within(row).getByText(`${T}.source.manual`)).toBeVisible();
		expect(
			within(row).getByTestId("todo-row-source-date"),
		).toHaveTextContent("2026-09-10");
	});

	it("groups a meeting-sourced row under its meeting and links to the digest", () => {
		renderBody({
			items: [
				item({
					id: "todo-2",
					source: "MEETING_DIGEST",
					title: "Confirm the launch date",
					projectId: "proj-1",
					projectName: "Apollo",
					assigneeUserId: ADA.id,
					assigneeUser: ADA,
					assignedManually: true,
					meetingTranscriptRef: "graph-transcript-1",
					meetingItemKey: "item-key-1",
					meetingTitle: "Weekly sync",
				}),
			],
		});

		const group = screen.getByTestId("todo-meeting-group");
		const meetingLink = within(group).getByTestId(
			"todo-meeting-group-link",
		);
		expect(meetingLink).toHaveTextContent("Weekly sync");
		expect(meetingLink).toHaveAttribute(
			"href",
			expect.stringContaining("/app/acme/projects/proj-1"),
		);
		expect(meetingLink.getAttribute("href")).toContain(
			"meeting=graph-transcript-1",
		);

		// The row's own link highlights THIS action item, not just the meeting.
		expect(
			screen.getByTestId("todo-row-digest-link").getAttribute("href"),
		).toContain("actionItem=item-key-1");
	});

	it("keeps two meetings apart even before the read names them", () => {
		// Until `todos.list` projects the transcript ref, the meeting's date is
		// the grouping key — every row of one meeting carries it.
		renderBody({
			items: [
				item({
					id: "todo-a",
					source: "MEETING_DIGEST",
					title: "Chase the invoice",
					projectId: "proj-1",
					projectName: "Apollo",
					sourceDate: "2026-09-10T09:00:00.000Z",
					assigneeUserId: ADA.id,
					assigneeUser: ADA,
				}),
				item({
					id: "todo-b",
					source: "MEETING_DIGEST",
					title: "Book the review",
					projectId: "proj-1",
					projectName: "Apollo",
					sourceDate: "2026-09-11T09:00:00.000Z",
					assigneeUserId: ADA.id,
					assigneeUser: ADA,
				}),
			],
		});

		expect(screen.getAllByTestId("todo-meeting-group")).toHaveLength(2);
		// The slot a later unit's "proposals pending" indicator hangs off.
		expect(screen.getAllByTestId("todo-meeting-group-slot")).toHaveLength(
			2,
		);
	});

	it("marks a contact assignee as having no account", () => {
		renderBody({
			items: [
				item({
					id: "todo-3",
					assigneeContactId: "contact-1",
					assigneeContact: { id: "contact-1", name: "Bo Client" },
					assignedManually: true,
				}),
			],
		});

		const assignee = screen.getByTestId("todo-assignee");
		expect(within(assignee).getByText("Bo Client")).toBeVisible();
		expect(
			within(assignee).getByText(
				"organizations.settings.members.contacts.noAccountBadge",
			),
		).toBeVisible();
		// The same dashed, account-less mark the contact register leads with.
		expect(
			within(assignee).getByTestId("contact-no-account-mark"),
		).toBeInTheDocument();
	});

	it("says so when nobody owns the row", () => {
		renderBody({
			items: [
				item({
					id: "todo-4",
					projectId: "proj-1",
					projectName: "Apollo",
				}),
			],
			unassignedExpandedProjectIds: ["proj-1"],
		});

		expect(
			screen.getByText(`${T}.assignee.unassigned`),
		).toBeInTheDocument();
	});

	it("reads an orphan from its snapshot and calls its assignee a suggestion", () => {
		renderBody({
			items: [
				item({
					id: "todo-5",
					source: "MEETING_DIGEST",
					// What the server handed over: the live wording is gone, so
					// `title` IS the stored snapshot.
					title: "Snapshot: agree the rollout order",
					projectId: "proj-1",
					projectName: "Apollo",
					isOrphaned: true,
					assigneeUserId: ADA.id,
					assigneeUser: ADA,
					suggestedUserId: ADA.id,
					assignedManually: false,
				}),
			],
		});

		const row = screen.getByTestId("todo-row");
		expect(
			within(row).getByText("Snapshot: agree the rollout order"),
		).toBeVisible();
		expect(within(row).getByTestId("todo-row-orphaned")).toHaveTextContent(
			`${T}.orphaned.description`,
		);
		expect(
			within(row).getByTestId("todo-assignee-suggested"),
		).toBeVisible();
	});

	it("does not call a hand-made assignment a suggestion", () => {
		// The negative control for the case above: badging a decision as a
		// suggestion invites someone to overrule a person who already chose.
		renderBody({
			items: [
				item({
					id: "todo-6",
					assigneeUserId: ADA.id,
					assigneeUser: ADA,
					suggestedUserId: "user-other",
					assignedManually: true,
				}),
			],
		});

		expect(screen.queryByTestId("todo-assignee-suggested")).toBeNull();
	});
});

describe("TodoListBody unassigned bucket", () => {
	const unassignedItems = [
		item({
			id: "todo-open-1",
			title: "Nobody owns this yet",
			projectId: "proj-open",
			projectName: "Apollo",
		}),
		item({
			id: "todo-shut-1",
			title: "Nor this one",
			projectId: "proj-shut",
			projectName: "Borealis",
		}),
	];

	it("opens only the projects the server named, and stays openable", async () => {
		const user = userEvent.setup();
		renderBody({
			items: unassignedItems,
			unassignedExpandedProjectIds: ["proj-open"],
		});

		const buckets = screen.getAllByTestId("todo-unassigned-bucket");
		const expanded = buckets.find(
			(bucket) => bucket.dataset.projectId === "proj-open",
		);
		const collapsed = buckets.find(
			(bucket) => bucket.dataset.projectId === "proj-shut",
		);

		expect(
			within(expanded as HTMLElement).getByText("Nobody owns this yet"),
		).toBeVisible();
		expect(
			within(collapsed as HTMLElement).queryByText("Nor this one"),
		).toBeNull();
		expect(
			within(collapsed as HTMLElement).getByRole("button"),
		).toHaveAttribute("aria-expanded", "false");

		// Collapsed is not hidden: anyone who can see the bucket may open it.
		await user.click(within(collapsed as HTMLElement).getByRole("button"));
		expect(
			within(collapsed as HTMLElement).getByText("Nor this one"),
		).toBeVisible();
	});
});

describe("TodoListBody age-hidden line", () => {
	it("stays absent when age hid nothing", () => {
		renderBody({
			items: [
				item({
					id: "todo-7",
					assigneeUserId: ADA.id,
					assigneeUser: ADA,
				}),
			],
			ageHiddenCount: 0,
		});

		expect(screen.queryByTestId("todo-age-hidden-line")).toBeNull();
	});

	it("reports what age hid and opens the hidden view", async () => {
		const user = userEvent.setup();
		renderBody({
			items: [
				item({
					id: "todo-8",
					assigneeUserId: ADA.id,
					assigneeUser: ADA,
				}),
			],
			ageHiddenCount: 30,
			ageThresholdDays: 45,
		});

		const line = screen.getByTestId("todo-age-hidden-line");
		expect(line).toHaveTextContent(`${T}.ageHidden.line`);
		// The count and the threshold both reach the copy; "some are hidden"
		// without a number is what makes a reader assume it is one or two.
		expect(line).toHaveTextContent("30");
		expect(line).toHaveTextContent("45");
		expect(line).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByTestId("todo-age-hidden-view")).toBeNull();

		await user.click(line);

		expect(screen.getByTestId("todo-age-hidden-view")).toBeVisible();
		expect(line).toHaveAttribute("aria-expanded", "true");
	});
});

describe("TodoListBody filters", () => {
	const ada = { id: "user-ada", name: "Ada Member", image: null };
	const items = [
		item({
			id: "apollo-ada",
			title: "Apollo and Ada",
			projectId: "proj-1",
			projectName: "Apollo",
			assigneeUserId: ada.id,
			assigneeUser: ada,
			assignedManually: true,
		}),
		item({
			id: "apollo-bo",
			title: "Apollo and Bo",
			projectId: "proj-1",
			projectName: "Apollo",
			assigneeContactId: "contact-1",
			assigneeContact: { id: "contact-1", name: "Bo Client" },
			assignedManually: true,
		}),
		item({
			id: "borealis-ada",
			title: "Borealis and Ada",
			projectId: "proj-2",
			projectName: "Borealis",
			assigneeUserId: ada.id,
			assigneeUser: ada,
			assignedManually: true,
		}),
	];

	it("keeps the view scope as pills and the unbounded sets as comboboxes", () => {
		renderBody({ items });

		const pills = screen.getByTestId("todo-scope-pills");
		expect(within(pills).getAllByRole("button")).toHaveLength(3);
		expect(within(pills).getByText(`${T}.scope.open`)).toBeVisible();

		// A pill row over every project and every contact is what pushes the
		// list below the fold, so these two are comboboxes instead.
		expect(screen.getByTestId("todo-project-filter-trigger")).toBeVisible();
		expect(
			screen.getByTestId("todo-assignee-filter-trigger"),
		).toBeVisible();
	});

	it("renders project and assignee selections as removable chips that combine", async () => {
		const user = userEvent.setup();
		renderBody({ items });

		await user.click(
			within(screen.getByTestId("todo-project-filter-popover")).getByText(
				"Apollo",
			),
		);
		expect(screen.getAllByTestId("todo-row")).toHaveLength(2);

		await user.click(
			within(
				screen.getByTestId("todo-assignee-filter-popover"),
			).getByText("Ada Member"),
		);

		// Both chips are up, and the two filters AND together.
		expect(screen.getByTestId("todo-project-chip")).toHaveTextContent(
			"Apollo",
		);
		expect(screen.getByTestId("todo-assignee-chip")).toHaveTextContent(
			"Ada Member",
		);
		const rows = screen.getAllByTestId("todo-row");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toHaveTextContent("Apollo and Ada");

		// Removing one chip widens the list back out rather than clearing both.
		await user.click(
			within(screen.getByTestId("todo-assignee-chip")).getByRole(
				"button",
			),
		);
		expect(screen.queryByTestId("todo-assignee-chip")).toBeNull();
		expect(screen.getByTestId("todo-project-chip")).toBeVisible();
		expect(screen.getAllByTestId("todo-row")).toHaveLength(2);
	});

	it("searches an unbounded option set instead of listing all of it", async () => {
		const user = userEvent.setup();
		renderBody({ items });

		const popover = screen.getByTestId("todo-project-filter-popover");
		expect(within(popover).getByText("Apollo")).toBeVisible();

		await user.type(
			screen.getByTestId("todo-project-filter-search"),
			"borea",
		);

		expect(within(popover).queryByText("Apollo")).toBeNull();
		expect(within(popover).getByText("Borealis")).toBeVisible();
	});

	it("says the filters emptied the view rather than showing nothing", async () => {
		const user = userEvent.setup();
		renderBody({ items: [items[0]] });

		await user.click(
			within(
				screen.getByTestId("todo-assignee-filter-popover"),
			).getByText("Ada Member"),
		);
		// Ada owns the only row, so switching scope is what empties the view.
		await user.click(screen.getByText(`${T}.scope.completed`));

		expect(screen.queryByTestId("todo-row")).toBeNull();
		expect(screen.getByText(`${T}.noMatches.title`)).toBeVisible();
	});

	it("shows snoozed rows with their wake date under the Snoozed pill", async () => {
		const user = userEvent.setup();
		const wakeAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		renderBody({
			items: [
				item({
					id: "todo-open",
					title: "Still awake",
					assigneeUserId: ada.id,
					assigneeUser: ada,
				}),
				item({
					id: "todo-asleep",
					title: "Asleep until next week",
					snoozedUntil: wakeAt.toISOString(),
					assigneeUserId: ada.id,
					assigneeUser: ada,
				}),
			],
		});

		// Open is the default view and a sleeping row does not belong in it.
		expect(screen.getAllByTestId("todo-row")).toHaveLength(1);
		expect(screen.getByText("Still awake")).toBeVisible();

		await user.click(screen.getByText(`${T}.scope.snoozed`));

		const rows = screen.getAllByTestId("todo-row");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toHaveTextContent("Asleep until next week");
		// The wake date is the point: "snoozed" without a date is indefinite.
		expect(
			within(rows[0]).getByTestId("todo-row-snoozed-until"),
		).toHaveTextContent(wakeAt.toISOString().slice(0, 10));
	});

	it("shows completed rows only under the Completed pill", async () => {
		const user = userEvent.setup();
		renderBody({
			items: [
				item({
					id: "todo-done",
					title: "Already handled",
					isCompleted: true,
					completedAt: "2026-09-12T09:00:00.000Z",
					assigneeUserId: ada.id,
					assigneeUser: ada,
				}),
			],
		});

		expect(screen.queryByTestId("todo-row")).toBeNull();

		await user.click(screen.getByText(`${T}.scope.completed`));

		expect(screen.getByTestId("todo-row")).toHaveTextContent(
			"Already handled",
		);
	});
});

describe("TodoListBody load more", () => {
	const ada = { id: "user-ada", name: "Ada Member", image: null };
	const loaded = [
		item({
			id: "todo-1",
			title: "The first fifty",
			assigneeUserId: ada.id,
			assigneeUser: ada,
			assignedManually: true,
		}),
	];

	const paging = (overrides: Partial<TodoListPaging> = {}) => ({
		hasMore: true,
		isLoadingMore: false,
		onLoadMore: vi.fn(),
		...overrides,
	});

	it("claims nothing about the rest of the list when nobody is paging", () => {
		// A caller with one fixed response cannot know whether more exists, so
		// the body must not invent an affordance that would do nothing.
		renderBody({ items: loaded });

		expect(screen.queryByTestId("todo-load-more")).toBeNull();
	});

	it("stays absent when the read says there is nothing left", () => {
		renderBody({ items: loaded }, { paging: paging({ hasMore: false }) });

		expect(screen.queryByTestId("todo-load-more")).toBeNull();
	});

	it("asks for the next page, and carries the wait on the control itself", async () => {
		const user = userEvent.setup();
		const onLoadMore = vi.fn();
		const { rerender } = renderBody(
			{ items: loaded },
			{ paging: paging({ onLoadMore }) },
		);

		const button = screen.getByTestId("todo-load-more");
		await user.click(button);
		expect(onLoadMore).toHaveBeenCalledTimes(1);

		// While the page is coming, the control that is working says so and
		// cannot be pressed again — one more page per press.
		rerender(
			<QueryClientProvider client={new QueryClient()}>
				<TodoListBody
					data={{
						items: loaded,
						ageHiddenCount: 0,
						ageThresholdDays: 30,
						unassignedExpandedProjectIds: [],
					}}
					organizationId="org-from-context"
					scope="open"
					onScopeChange={() => {}}
					paging={paging({ isLoadingMore: true, onLoadMore })}
				/>
			</QueryClientProvider>,
		);

		const busy = screen.getByTestId("todo-load-more");
		expect(busy).toBeDisabled();
		// The list's own key, not the hidden view's: the two buttons read alike
		// today but answer different questions, and one shared key would make a
		// rewording of either silently reword the other.
		expect(busy).toHaveTextContent(`${T}.loadingMore`);
	});

	it("offers the rest of the list even when nothing loaded is on screen", async () => {
		// A row asleep until next week is not in the open view, so this page
		// renders none of what it holds. Hiding the way forward here would
		// strand the reader on an empty list that the server says continues.
		const wakeAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		renderBody(
			{
				items: [
					item({
						id: "todo-asleep",
						title: "Asleep until next week",
						snoozedUntil: wakeAt.toISOString(),
						assigneeUserId: ada.id,
						assigneeUser: ada,
					}),
				],
			},
			{ paging: paging() },
		);

		expect(screen.getByText(`${T}.noMatches.title`)).toBeVisible();
		expect(screen.getByTestId("todo-load-more")).toBeVisible();
	});
});

describe("TodoListBody filter bar ownership", () => {
	const ada = { id: "user-ada", name: "Ada Member", image: null };
	const apollo = { id: "proj-1", name: "Apollo" };
	const borealis = { id: "proj-2", name: "Borealis" };
	const items = [
		item({
			id: "apollo-1",
			title: "Apollo and Ada",
			projectId: apollo.id,
			projectName: apollo.name,
			assigneeUserId: ada.id,
			assigneeUser: ada,
			assignedManually: true,
		}),
	];

	const bar = (overrides: Partial<TodoFilterBar> = {}): TodoFilterBar => ({
		project: null,
		assignee: null,
		projects: [apollo],
		assignees: [],
		onProjectChange: vi.fn(),
		onAssigneeChange: vi.fn(),
		...overrides,
	});

	it("hands a selection to whoever owns the read instead of acting alone", async () => {
		const user = userEvent.setup();
		const onProjectChange = vi.fn();
		renderBody({ items }, { filters: bar({ onProjectChange }) });

		await user.click(
			within(screen.getByTestId("todo-project-filter-popover")).getByText(
				"Apollo",
			),
		);

		expect(onProjectChange).toHaveBeenCalledWith(apollo);
		// CONTROLLED, and the difference is the point: a selection changes
		// which rows the SERVER sends, so nothing here moves until the owner
		// has changed the read and the answer has come back. A body that
		// narrowed on its own would show a filtered list built from one page
		// while the chip above it named the workspace.
		expect(screen.queryByTestId("todo-project-chip")).toBeNull();
		expect(screen.getAllByTestId("todo-row")).toHaveLength(1);
	});

	it("offers the options its owner remembers, not only the ones on screen", () => {
		// While a filter is on, the response holds only matching rows. Options
		// re-derived from it would collapse to the value already selected, and
		// the only way to another project would be to clear the filter first.
		renderBody(
			{ items },
			{ filters: bar({ projects: [apollo, borealis] }) },
		);

		const popover = screen.getByTestId("todo-project-filter-popover");
		expect(within(popover).getByText("Borealis")).toBeVisible();
	});

	it("shows the owner's selection as the chip that clears it", async () => {
		const user = userEvent.setup();
		const onProjectChange = vi.fn();
		renderBody(
			{ items },
			{ filters: bar({ project: apollo, onProjectChange }) },
		);

		const chip = screen.getByTestId("todo-project-chip");
		expect(chip).toHaveTextContent("Apollo");

		await user.click(within(chip).getByRole("button"));
		expect(onProjectChange).toHaveBeenCalledWith(null);
	});
});
