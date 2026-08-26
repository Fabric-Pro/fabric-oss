/**
 * Component tests for <PriorityRankedList> — the roadmap's Priority layout.
 *
 * Covers:
 *  AC-1/2   ranked order rendered, empty state per kind
 *  AC-3/4   Features / Bugs switcher filters the list
 *  AC-5/6/7 blockers, decisions and links surface in the expandable row
 *  AC-8/9   manual reorder persists; reset control appears only when pinned
 *  AC-10    the newest change's note shows inline on the collapsed row
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The global next-intl mock echoes the KEY, which would turn every assertion in
// this file into a test of key names rather than of what a user reads. Resolve
// the real `projects.stories.priority` strings instead, with the same ICU plural
// selection next-intl applies, so the assertions below stay on user-visible copy.
vi.mock("next-intl", async () => {
	const en = (
		await import(
			"../../../../../../../../packages/i18n/translations/en.json"
		)
	).default as Record<string, unknown>;
	const priority = (en as any).projects.stories.priority as Record<
		string,
		string
	>;
	const format = (pattern: string, count: number) => {
		const branch = count === 1 ? "one" : "other";
		const m = pattern.match(
			new RegExp(`${branch}\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}`),
		);
		return (m ? m[1] : pattern).replace(/#/g, String(count));
	};
	const t = (key: string, values?: Record<string, string | number>) => {
		let out = priority[key] ?? key;
		if (typeof values?.count === "number") {
			out = format(out, values.count);
		}
		// Plain `{name}` placeholders — next-intl substitutes these whether or
		// not the message also has a plural branch.
		for (const [name, value] of Object.entries(values ?? {})) {
			out = out.split(`{${name}}`).join(String(value));
		}
		return out;
	};
	t.raw = (key: string) => priority[key] ?? key;
	return {
		useTranslations: () => t,
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => ({}),
		NextIntlClientProvider: ({ children }: { children: ReactNode }) =>
			children,
	};
});

const { mocks } = vi.hoisted(() => ({
	mocks: {
		openDecisions: vi.fn(),
		priorityHistory: vi.fn(),
		reorderPriority: vi.fn(),
		resetPriorityOrder: vi.fn(),
		setPriority: vi.fn(),
		reprioritize: vi.fn(),
		reprioritizeStory: vi.fn(),
		statuses: vi.fn(),
		project: vi.fn(),
		toastInfo: vi.fn(),
		toastError: vi.fn(),
		toastSuccess: vi.fn(),
		toastLoading: vi.fn(),
	},
}));

vi.mock("sonner", () => ({
	toast: {
		info: mocks.toastInfo,
		error: mocks.toastError,
		success: mocks.toastSuccess,
		loading: mocks.toastLoading,
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryOptions: (o: { input: unknown }) => ({
					queryKey: ["project", o.input],
					queryFn: () => mocks.project(),
				}),
			},
			stories: {
				list: {
					queryKey: (o: { input: unknown }) => ["stories", o.input],
				},
				statuses: {
					list: {
						queryOptions: (o: { input: unknown }) => ({
							queryKey: ["statuses", o.input],
							queryFn: () => mocks.statuses(),
						}),
					},
				},
				openDecisions: {
					queryOptions: (o: { input: { storyIds: string[] } }) => ({
						queryKey: ["decisions", o.input.storyIds],
						queryFn: () => mocks.openDecisions(o.input),
					}),
				},
				// Expanding a row mounts its priority history, so every
				// disclosure test below reaches this.
				priorityHistory: {
					key: () => ["priority-history"],
					queryOptions: (o: { input: { storyId: string } }) => ({
						queryKey: ["priority-history", o.input.storyId],
						queryFn: () => mocks.priorityHistory(o.input),
					}),
				},
			},
		},
	},
}));

vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				reorderPriority: (input: unknown) =>
					mocks.reorderPriority(input),
				resetPriorityOrder: (input: unknown) =>
					mocks.resetPriorityOrder(input),
				setPriority: (input: unknown) => mocks.setPriority(input),
				reprioritize: (input: unknown) => mocks.reprioritize(input),
				reprioritizeStory: (input: unknown) =>
					mocks.reprioritizeStory(input),
			},
		},
	},
}));

import type { UserStory } from "../../../lib/stories/types";
import { PriorityRankedList } from "../priority/PriorityRankedList";

const NOW = new Date("2026-07-20T12:00:00Z");

function story(overrides: Partial<UserStory> & { id: string }): UserStory {
	return {
		identifier: `F-${overrides.id}`,
		title: `Story ${overrides.id}`,
		statusId: "status-open",
		kind: "FEATURE",
		priority: "P2_MEDIUM",
		order: 0,
		roadmapOrder: 0,
		priorityOrder: null,
		tags: [],
		tasks: [],
		createdById: "u-1",
		createdAt: NOW,
		updatedAt: NOW,
		pmAutoSyncEnabled: false,
		source: "manual",
		version: 1,
		draftingStage: "ACTIVE_ANALYSIS",
		blocked: false,
		...overrides,
	} as UserStory;
}

function renderList(
	stories: UserStory[],
	hasActiveFilters = false,
	// The unfiltered "entire roadmap" set the scope dialog offers. Defaults to
	// the filtered set — most tests aren't exercising the filtered-vs-entire
	// choice, so the two coincide.
	allStories: UserStory[] = stories,
) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const view = render(
		<PriorityRankedList
			projectId="p-1"
			organizationId={null}
			basePath="/app/acme"
			stories={stories}
			allStories={allStories}
			hasActiveFilters={hasActiveFilters}
		/>,
		{
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={queryClient}>
					{children}
				</QueryClientProvider>
			),
		},
	);

	return {
		...view,
		/** Re-render with a new story set against the SAME query cache, so
		 * cache-hit behaviour is observable. */
		rerenderWith: (next: UserStory[]) =>
			view.rerender(
				<PriorityRankedList
					projectId="p-1"
					organizationId={null}
					basePath="/app/acme"
					stories={next}
					allStories={next}
					hasActiveFilters={hasActiveFilters}
				/>,
			),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.statuses.mockResolvedValue({
		statuses: [
			{ id: "status-open", name: "In Progress", isFinal: false },
			{ id: "status-done", name: "Done", isFinal: true },
		],
	});
	mocks.project.mockResolvedValue({ project: { userRole: "owner" } });
	mocks.openDecisions.mockResolvedValue({ counts: {}, questions: {} });
	mocks.reorderPriority.mockResolvedValue({ success: true });
	mocks.resetPriorityOrder.mockResolvedValue({ cleared: 3 });
	mocks.priorityHistory.mockResolvedValue({
		items: [],
		nextCursor: null,
		initialPriority: null,
		totalCount: 0,
	});
	mocks.setPriority.mockResolvedValue({
		changed: true,
		priority: "P0_CRITICAL",
		priorityChangedAt: new Date("2026-07-21T00:00:00Z"),
	});
	mocks.reprioritize.mockResolvedValue({
		changed: [],
		considered: 0,
		truncated: false,
	});
	mocks.reprioritizeStory.mockResolvedValue({
		changed: false,
		fromPriority: null,
		toPriority: null,
		rationale: null,
		considered: 1,
	});
});

describe("ranked order", () => {
	it("lists higher-priority work first", async () => {
		renderList([
			story({ id: "low", priority: "P3_LOW", title: "Low item" }),
			story({ id: "crit", priority: "P0_CRITICAL", title: "Crit item" }),
		]);

		await waitFor(() => expect(screen.getByText("Crit item")).toBeTruthy());

		const titles = screen
			.getAllByRole("listitem")
			.map((li) => li.textContent ?? "");
		expect(titles[0]).toContain("Crit item");
		expect(titles[1]).toContain("Low item");
	});

	it("sinks work in a final status to the bottom and marks it complete", async () => {
		renderList([
			story({
				id: "done",
				priority: "P0_CRITICAL",
				title: "Done item",
				statusId: "status-done",
			}),
			story({ id: "open", priority: "P3_LOW", title: "Open item" }),
		]);

		// Completion is only known once the statuses query resolves, so wait for
		// the struck-through title rather than the mere presence of the row —
		// asserting earlier would test the pre-status ordering.
		await waitFor(() =>
			expect(screen.getByText("Done item").className).toContain(
				"line-through",
			),
		);

		const titles = screen
			.getAllByRole("listitem")
			.map((li) => li.textContent ?? "");
		expect(titles[0]).toContain("Open item");
		expect(titles[1]).toContain("Done item");

		// Completion is conveyed by the struck-through title and muted row, not
		// by a badge — a saturated chip on finished work pulls the eye away from
		// the top of a ranked list, which is the opposite of what it's for.
		expect(screen.queryByText("Complete")).toBeNull();
	});
});

describe("bug / feature switcher", () => {
	it("shows only features by default and only bugs once switched", async () => {
		renderList([
			story({ id: "f1", kind: "FEATURE", title: "A feature" }),
			story({ id: "b1", kind: "BUG", title: "A bug" }),
		]);

		await waitFor(() => expect(screen.getByText("A feature")).toBeTruthy());
		expect(screen.queryByText("A bug")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /Bugs \(1\)/ }));

		await waitFor(() => expect(screen.getByText("A bug")).toBeTruthy());
		expect(screen.queryByText("A feature")).toBeNull();
	});

	it("offers the other kind when the selected one is empty", async () => {
		renderList([story({ id: "f1", kind: "FEATURE", title: "A feature" })]);

		fireEvent.click(screen.getByRole("button", { name: /Bugs \(0\)/ }));

		await waitFor(() =>
			expect(screen.getByText(/No bugs to rank/)).toBeTruthy(),
		);
		fireEvent.click(
			screen.getByRole("button", { name: /View features \(1\)/ }),
		);
		await waitFor(() => expect(screen.getByText("A feature")).toBeTruthy());
	});
});

describe("row detail", () => {
	it("surfaces the blocked reason and links only once expanded", async () => {
		renderList([
			story({
				id: "b",
				title: "Blocked item",
				blocked: true,
				blockedReason: "Waiting on vendor SSO",
				externalUrl: "https://jira.example/BUG-1",
			}),
		]);

		await waitFor(() => expect(screen.getByText("Blocked")).toBeTruthy());

		const toggle = screen.getByRole("button", { name: /Details for/ });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");

		// The panel is rendered but `hidden` while collapsed, so `aria-controls`
		// resolves to a real element instead of dangling — the collapsed state is
		// the default for every row, so a dangling reference would be the norm.
		const panelId = toggle.getAttribute("aria-controls");
		const panel = document.getElementById(panelId as string);
		expect(panel).not.toBeNull();
		expect(panel?.hasAttribute("hidden")).toBe(true);

		fireEvent.click(toggle);

		await waitFor(() =>
			expect(
				document
					.getElementById(panelId as string)
					?.hasAttribute("hidden"),
			).toBe(false),
		);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText(/Waiting on vendor SSO/)).toBeTruthy();

		const external = screen.getByRole("link", {
			name: /Open linked ticket/,
		});
		expect(external.getAttribute("href")).toBe(
			"https://jira.example/BUG-1",
		);
		// The title is already the link to the work item; a second "Open work
		// item" link inside the panel was pure duplication.
		expect(
			screen.queryByRole("link", { name: "Open work item" }),
		).toBeNull();
		expect(
			screen
				.getByRole("link", { name: "Blocked item" })
				.getAttribute("href"),
		).toBe("/app/acme/projects/p-1/stories/b");
	});

	it("shows the open-question count returned for the row", async () => {
		mocks.openDecisions.mockResolvedValue({
			counts: { d1: 2 },
			questions: {},
		});
		renderList([story({ id: "d1", title: "Undecided" })]);

		await waitFor(() =>
			expect(screen.getByText(/2 open questions/)).toBeTruthy(),
		);
	});

	it("shows the newest change's note inline without expanding the row", async () => {
		// The denormalised note (priorityChangeReason) answers "why is this a
		// P0?" at a glance — so it must render on the collapsed row, before the
		// disclosure is touched.
		renderList([
			story({
				id: "r",
				title: "Raised item",
				priority: "P0_CRITICAL",
				priorityChangeReason: "Customer escalation, blocking launch.",
			}),
		]);

		await waitFor(() =>
			expect(
				screen.getByText("Customer escalation, blocking launch."),
			).toBeTruthy(),
		);
		// It is on the collapsed row, so the disclosure is still closed.
		expect(
			screen
				.getByRole("button", { name: /Details for/ })
				.getAttribute("aria-expanded"),
		).toBe("false");
	});

	it("omits the note line when the newest change carried none", async () => {
		renderList([story({ id: "n", title: "Quiet item" })]);

		await waitFor(() =>
			expect(screen.getByText("Quiet item")).toBeTruthy(),
		);
		expect(
			screen.queryByText("Latest priority note:", { exact: false }),
		).toBeNull();
	});
});

describe("manual order", () => {
	it("offers the reset control only when something is pinned", async () => {
		const { unmount } = renderList([story({ id: "a" })]);
		await waitFor(() => expect(screen.getByText("Story a")).toBeTruthy());
		expect(
			screen.queryByRole("button", { name: /Restore suggested order/ }),
		).toBeNull();
		unmount();

		renderList([story({ id: "a", priorityOrder: 1 })]);
		await waitFor(() =>
			expect(
				screen.getByRole("button", {
					name: /Restore suggested order/,
				}),
			).toBeTruthy(),
		);
	});

	it("clears the pins for the active kind only", async () => {
		renderList([
			story({ id: "a", priorityOrder: 1 }),
			story({ id: "b", kind: "BUG", priorityOrder: 1 }),
		]);

		fireEvent.click(
			await screen.findByRole("button", {
				name: /Restore suggested order/,
			}),
		);

		await waitFor(() =>
			expect(mocks.resetPriorityOrder).toHaveBeenCalledWith(
				expect.objectContaining({ projectId: "p-1", kind: "FEATURE" }),
			),
		);
	});
});

describe("permission and filter gating", () => {
	it("hides the reorder handle and reset control from read-only members", async () => {
		mocks.project.mockResolvedValue({ project: { userRole: "viewer" } });

		renderList([story({ id: "a", priorityOrder: 1 })]);

		await waitFor(() => expect(screen.getByText("Story a")).toBeTruthy());
		// A grab handle that always snaps back with a FORBIDDEN toast is a
		// broken affordance, not a safeguard — the server still enforces it.
		expect(screen.queryByRole("button", { name: /^Reorder/ })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /Restore suggested order/ }),
		).toBeNull();
	});

	it("shows the reorder handle to editors, with its position", async () => {
		mocks.project.mockResolvedValue({ project: { userRole: "editor" } });

		renderList([story({ id: "a" }), story({ id: "b" })]);

		await waitFor(() =>
			expect(
				screen.getAllByRole("button", { name: /^Reorder/ }).length,
			).toBe(2),
		);
		expect(
			screen.getByRole("button", { name: /position 1 of 2/ }),
		).toBeTruthy();
	});

	it("removes the handles and says why when roadmap filters are active", async () => {
		renderList([story({ id: "a" }), story({ id: "b" })], true);

		// The notice depends on the project role having loaded, so wait for it
		// rather than for the rows.
		await waitFor(() =>
			expect(
				screen.getByText(/Clear the roadmap filters to reorder/),
			).toBeTruthy(),
		);
		expect(screen.queryByRole("button", { name: /^Reorder/ })).toBeNull();
	});
});

describe("open questions in the row", () => {
	it("lists the questions themselves, not just a count, and links to the decision log", async () => {
		mocks.openDecisions.mockResolvedValue({
			counts: { d1: 2 },
			questions: {
				d1: [
					{
						id: "q1",
						summary: "Which auth provider backs SSO?",
						content: null,
					},
					{
						id: "q2",
						summary: null,
						content: "Do we need per-row presets?",
					},
				],
			},
		});

		renderList([story({ id: "d1", title: "Undecided" })]);

		await waitFor(() =>
			expect(screen.getByText(/2 open questions/)).toBeTruthy(),
		);

		fireEvent.click(screen.getByRole("button", { name: /Details for/ }));

		await waitFor(() =>
			expect(
				screen.getByText("Which auth provider backs SSO?"),
			).toBeTruthy(),
		);
		// Agent-authored roots fill only `content`, so the row must fall back to
		// it — otherwise those questions render blank.
		expect(screen.getByText("Do we need per-row presets?")).toBeTruthy();

		const link = screen.getByRole("link", {
			name: /Answer in the decision log/,
		});
		expect(link.getAttribute("href")).toBe(
			"/app/acme/projects/p-1/stories/d1?storyTab=decisionLog",
		);
	});

	it("says how many questions are not shown, so the list doesn't read as complete", async () => {
		mocks.openDecisions.mockResolvedValue({
			counts: { d1: 7 },
			questions: {
				d1: [
					{ id: "q1", summary: "First", content: null },
					{ id: "q2", summary: "Second", content: null },
					{ id: "q3", summary: "Third", content: null },
				],
			},
		});

		renderList([story({ id: "d1" })]);

		await waitFor(() =>
			expect(screen.getByText(/7 open questions/)).toBeTruthy(),
		);
		fireEvent.click(screen.getByRole("button", { name: /Details for/ }));

		await waitFor(() =>
			expect(
				screen.getByRole("link", { name: /4 more questions/ }),
			).toBeTruthy(),
		);
	});
});

describe("proposal provenance", () => {
	it("links to the originating proposal when one was recorded", async () => {
		renderList([
			story({
				id: "p",
				source: "approved_proposal",
				createdFromProposalId: "prop_9",
			}),
		]);

		await waitFor(() => expect(screen.getByText("Story p")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /Details for/ }));

		await waitFor(() =>
			expect(
				screen.getByRole("link", {
					name: /Created from an approved proposal/,
				}),
			).toBeTruthy(),
		);
		expect(
			screen
				.getByRole("link", {
					name: /Created from an approved proposal/,
				})
				.getAttribute("href"),
		).toBe("/app/acme/projects/p-1?tab=stories&proposal=prop_9");
	});

	it("keeps the provenance as plain text when no proposal id was recorded", async () => {
		// Items created before the id was stored can't be backfilled — a dead
		// link would be worse than prose.
		renderList([
			story({
				id: "p",
				source: "approved_proposal",
				createdFromProposalId: null,
				externalUrl: "https://jira.example/X-1",
			}),
		]);

		await waitFor(() => expect(screen.getByText("Story p")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /Details for/ }));

		await waitFor(() =>
			expect(
				screen.getByText("Created from an approved proposal."),
			).toBeTruthy(),
		);
		expect(
			screen.queryByRole("link", {
				name: /Created from an approved proposal/,
			}),
		).toBeNull();
	});
});

describe("always-open band editor + per-item AI sparkle", () => {
	it("shows the band editor as soon as a row expands — no link to click, no cancel", async () => {
		renderList([story({ id: "a" })]);

		const toggle = await screen.findByRole("button", {
			name: /Details for F-a/,
		});
		// Collapsed: the editor is not mounted at all (hundreds of rows).
		expect(screen.queryByText("Set priority")).not.toBeInTheDocument();

		fireEvent.click(toggle);

		expect(await screen.findByText("Set priority")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Save priority" }),
		).toBeInTheDocument();
		// Permanent fixture — nothing to cancel back to.
		expect(
			screen.queryByRole("button", { name: "Cancel" }),
		).not.toBeInTheDocument();
	});

	it("hides the editor (and sparkle) from read-only members", async () => {
		mocks.project.mockResolvedValue({ project: { userRole: "member" } });
		renderList([story({ id: "a" })]);

		fireEvent.click(
			await screen.findByRole("button", { name: /Details for F-a/ }),
		);

		await waitFor(() =>
			expect(screen.getByText("No changes yet")).toBeInTheDocument(),
		);
		expect(screen.queryByText("Set priority")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Re-assess priority/ }),
		).not.toBeInTheDocument();
	});

	it("re-assesses one item via the sparkle — always isolated, one click, never the list", async () => {
		const user = userEvent.setup();
		mocks.reprioritizeStory.mockResolvedValue({
			changed: true,
			fromPriority: "P2_MEDIUM",
			toPriority: "P1_HIGH",
			rationale: "Blocks committed work.",
			considered: 1,
		});
		renderList([story({ id: "a" })]);

		fireEvent.click(
			await screen.findByRole("button", { name: /Details for F-a/ }),
		);

		// One click — no mode menu. The sparkle IS the action.
		await user.click(
			await screen.findByRole("button", {
				name: "Re-assess priority for F-a with AI",
			}),
		);

		await waitFor(() =>
			expect(mocks.reprioritizeStory).toHaveBeenCalledWith(
				expect.objectContaining({
					storyId: "a",
					withListContext: false,
				}),
			),
		);
		// It never offers the whole-list mode — that lives on Re-prioritize.
		expect(
			screen.queryByRole("menuitem", { name: /Weigh against the list/ }),
		).not.toBeInTheDocument();
		// The run announces itself, and the applied move carries the model's why.
		expect(mocks.toastLoading).toHaveBeenCalled();
		await waitFor(() =>
			expect(mocks.toastSuccess).toHaveBeenCalledWith(
				expect.stringContaining("→"),
				expect.objectContaining({
					description: "Blocks committed work.",
				}),
			),
		);
		// Every call is isolated — no invocation ever sets withListContext.
		for (const call of mocks.reprioritizeStory.mock.calls) {
			expect(call[0].withListContext).toBe(false);
		}
	});

	it("says so — instead of staying silent — when the AI keeps the current band", async () => {
		const user = userEvent.setup();
		renderList([story({ id: "a" })]);

		fireEvent.click(
			await screen.findByRole("button", { name: /Details for F-a/ }),
		);
		await user.click(
			await screen.findByRole("button", {
				name: "Re-assess priority for F-a with AI",
			}),
		);

		await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalled());
		expect(mocks.toastSuccess).not.toHaveBeenCalled();
	});

	it("offers no sparkle on completed rows — the server refuses them", async () => {
		renderList([story({ id: "done", statusId: "status-done" })]);

		fireEvent.click(
			await screen.findByRole("button", { name: /Details for F-done/ }),
		);

		// The manual editor stays (re-banding a finished item by hand is
		// allowed), but there is no AI control to click.
		expect(await screen.findByText("Set priority")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Re-assess priority/ }),
		).not.toBeInTheDocument();
	});
});

describe("Re-prioritize — scope + cap", () => {
	const openReprio = async (user: ReturnType<typeof userEvent.setup>) => {
		// canEdit resolves from the async project query — await the button.
		await user.click(
			await screen.findByRole("button", { name: /^Re-prioritize$/ }),
		);
	};

	it("runs immediately with no dialog when there are no filters and the list is small", async () => {
		const user = userEvent.setup();
		renderList([story({ id: "a" }), story({ id: "b" })]);
		await openReprio(user);
		await waitFor(() =>
			expect(mocks.reprioritize).toHaveBeenCalledWith(
				expect.objectContaining({ storyIds: ["a", "b"] }),
			),
		);
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
	});

	it("asks filtered-vs-entire when filters are active, and sends the entire set when chosen", async () => {
		const user = userEvent.setup();
		const filtered = [story({ id: "a" })];
		const entire = [
			story({ id: "a" }),
			story({ id: "b" }),
			story({ id: "c" }),
		];
		renderList(filtered, true, entire);

		await openReprio(user);
		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByRole("button", { name: /Filtered only \(1\)/ }),
		).toBeInTheDocument();
		await user.click(
			within(dialog).getByRole("button", {
				name: /Entire roadmap \(3\)/,
			}),
		);
		await waitFor(() =>
			expect(mocks.reprioritize).toHaveBeenCalledWith(
				expect.objectContaining({ storyIds: ["a", "b", "c"] }),
			),
		);
	});

	it("sends only the filtered set when the user picks Filtered", async () => {
		const user = userEvent.setup();
		const filtered = [story({ id: "a" })];
		const entire = [story({ id: "a" }), story({ id: "b" })];
		renderList(filtered, true, entire);
		await openReprio(user);
		const dialog = await screen.findByRole("alertdialog");
		await user.click(
			within(dialog).getByRole("button", { name: /Filtered only \(1\)/ }),
		);
		await waitFor(() =>
			expect(mocks.reprioritize).toHaveBeenCalledWith(
				expect.objectContaining({ storyIds: ["a"] }),
			),
		);
	});

	it("confirms a large no-filter list before running, then sends the whole set (no ceiling caution below 500)", async () => {
		const user = userEvent.setup();
		const many = Array.from({ length: 101 }, (_, i) =>
			story({ id: `s${i}` }),
		);
		renderList(many);
		await openReprio(user);
		const dialog = await screen.findByRole("alertdialog");
		// A whole-list confirm, not a truncation warning: 101 ≤ 500, so the
		// ceiling caution must NOT appear — every item is ranked in one pass.
		expect(
			within(dialog).queryByText(/first 500 items/i),
		).not.toBeInTheDocument();
		await user.click(
			within(dialog).getByRole("button", {
				name: /Re-prioritize all 101/,
			}),
		);
		await waitFor(() =>
			expect(mocks.reprioritize).toHaveBeenCalledWith(
				expect.objectContaining({
					storyIds: many.map((s) => s.id),
				}),
			),
		);
	});

	it("shows the ceiling caution only above 500, and still sends the whole selected set", async () => {
		const user = userEvent.setup();
		// Drive the large set through the entire-roadmap scope, which is counted
		// (allStories) but not rendered — only the small filtered view renders,
		// so the test doesn't pay for 500+ heavy rows in jsdom.
		const filtered = [story({ id: "a" })];
		const entire = Array.from({ length: 501 }, (_, i) =>
			story({ id: `s${i}` }),
		);
		renderList(filtered, true, entire);
		await openReprio(user);
		const dialog = await screen.findByRole("alertdialog");
		// Amber ceiling caution — informational, not a block.
		expect(within(dialog).getByText(/over 500 items/i)).toBeInTheDocument();
		// Picking Entire still sends every id; the server ranks the first 500
		// and reports `truncated` so the run digest can say "run again".
		await user.click(
			within(dialog).getByRole("button", {
				name: /Entire roadmap \(501\)/,
			}),
		);
		await waitFor(() =>
			expect(mocks.reprioritize).toHaveBeenCalledWith(
				expect.objectContaining({
					storyIds: entire.map((s) => s.id),
				}),
			),
		);
	});
});
