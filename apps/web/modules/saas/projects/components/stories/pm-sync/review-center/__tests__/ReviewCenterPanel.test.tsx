import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

// The "View all in Sync History" footer deep-links via the URL, so the panel
// needs the app router + current location.
const routerReplace = vi.fn();

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: routerReplace }),
	usePathname: () => "/app/projects/project_1",
	useSearchParams: () => new URLSearchParams("tab=stories"),
}));

// The two server-state hooks are mocked so each test drives counts and items
// independently. `useInvalidateReviewCenter` returns a no-op.
const useReviewCenterCount = vi.fn();
const useReviewCenterItems = vi.fn();

vi.mock("../use-review-center", () => ({
	useReviewCenterCount: (...args: unknown[]) => useReviewCenterCount(...args),
	useReviewCenterItems: (...args: unknown[]) => useReviewCenterItems(...args),
	useInvalidateReviewCenter: () => vi.fn(),
}));

// The panel self-fetches PM capabilities for the Sync Drift placeholder; the
// row action path also reaches into orpcClient. Drive `configured` per test.
const pmCapabilities = vi.fn();

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		basePath: "/app",
	}),
}));

const retryPmSync = vi.fn();
const retryPmSyncBatch = vi.fn();
const dismissPmSyncFailureBatch = vi.fn();
const reviewStateChange = vi.fn();
const bulkReview = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				pmCapabilities: (...args: unknown[]) => pmCapabilities(...args),
				retryPmSync: (...args: unknown[]) => retryPmSync(...args),
				retryPmSyncBatch: (...args: unknown[]) =>
					retryPmSyncBatch(...args),
				dismissPmSyncFailureBatch: (...args: unknown[]) =>
					dismissPmSyncFailureBatch(...args),
			},
			pmStateChanges: {
				review: (...args: unknown[]) => reviewStateChange(...args),
				bulkReview: (...args: unknown[]) => bulkReview(...args),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// The bulk toolbar + FLAG_MISSING rows use `<DestructiveTooltip>`, which reads
// `copy={t.raw(key)}` expecting a `{ label, warning }` object — the global
// next-intl mock (vitest.setup.ts) has no `.raw`. Override locally so `t.raw`
// returns a valid destructive-copy shape and `t(key)` echoes the key.
vi.mock("next-intl", () => {
	// Echo the key, but resolve the two interpolated keys used by the selection
	// checkboxes to human strings so tests can query by accessible name.
	function makeT() {
		const t = (key: string, values?: Record<string, unknown>) => {
			if (key === "reviewSelectRow") {
				return `Select ${values?.identifier} for bulk actions.`;
			}
			if (key === "reviewSelectAll") {
				return "Select all loaded items in this tab for bulk actions.";
			}
			if (key === "reviewTabConflicts") {
				return "Items edited in both Fabric and your PM tool — choose which version to keep.";
			}
			if (key === "reviewTabFailures") {
				return "Syncs that didn't go through — retry once the cause is fixed.";
			}
			if (key === "reviewTabSyncDrift") {
				return "Changes made in your PM tool that aren't in Fabric yet — review each one.";
			}
			return key;
		};
		(t as unknown as { raw: (k: string) => unknown }).raw = (
			k: string,
		) => ({
			label: `${k}.label`,
			warning: `Warning: ${k}.warning`,
		});
		return t;
	}
	return {
		useTranslations: () => makeT(),
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => ({}),
		NextIntlClientProvider: ({ children }: { children: unknown }) =>
			children,
	};
});

if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
	(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
}
if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

import { ReviewCenterPanel } from "../ReviewCenterPanel";

type Counts = {
	conflictsCount: number;
	failuresCount: number;
	pullDriftCount: number;
};

function setCounts(counts: Counts | null, isLoading = false) {
	useReviewCenterCount.mockReturnValue({
		data: counts
			? {
					...counts,
					total:
						counts.conflictsCount +
						counts.failuresCount +
						counts.pullDriftCount,
				}
			: undefined,
		isLoading,
	});
}

function setItems(
	data: {
		conflicts: ReturnType<typeof conflictItem>[];
		failures: ReturnType<typeof failureItem>[];
		pullDrift: ReturnType<typeof pullDriftItem>[];
	} | null,
	isLoading = false,
) {
	useReviewCenterItems.mockReturnValue({
		data: data ?? undefined,
		isLoading,
	});
}

function conflictItem(id: string, identifier = "F-039") {
	return {
		id,
		type: "conflict" as const,
		entityType: "FEATURE" as const,
		entityId: id,
		identifier,
		title: "Checkout flow refactor",
		pmTool: "azure-devops",
		summary: "Local and remote versions diverged",
		fabricDescription: "Fabric-side description",
		fabricUpdatedAt: "2026-05-21T08:00:00.000Z",
		fabricAuthor: "Ada Lovelace",
		fabricSource: "MANUAL" as const,
		proposedAction: null,
		itemType: "story" as const,
	};
}

function failureItem(id: string, identifier = "US-002") {
	return {
		id,
		type: "failure" as const,
		entityType: "STORY" as const,
		entityId: id,
		identifier,
		title: "Login retry",
		pmTool: "azure-devops",
		summary: "PM endpoint rejected the update",
		fabricDescription: "",
		fabricUpdatedAt: "2026-05-20T12:00:00.000Z",
		fabricAuthor: null,
		fabricSource: "PM_PULL" as const,
		proposedAction: null,
		itemType: "story" as const,
	};
}

function pullDriftItem(id: string, identifier = "US-003") {
	return {
		id,
		type: "pull-drift" as const,
		entityType: "STORY" as const,
		entityId: id,
		identifier,
		title: "Payment hook",
		pmTool: "azure-devops",
		summary: "Active → Closed",
		fabricDescription: "",
		fabricUpdatedAt: null,
		fabricAuthor: null,
		fabricSource: null,
		proposedAction: "HIDE" as const,
		itemType: "story" as const,
	};
}

function flagMissingItem(id: string, identifier = "US-010") {
	return {
		...pullDriftItem(id, identifier),
		proposedAction: "FLAG_MISSING" as const,
		summary: "Ticket was deleted upstream",
	};
}

const emptyItems = { conflicts: [], failures: [], pullDrift: [] };

function renderPanel(
	options: {
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
		configured?: boolean;
	} = {},
) {
	const { open = true, onOpenChange = () => {}, configured = true } = options;
	pmCapabilities.mockResolvedValue({ configured });
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<ReviewCenterPanel
				projectId="project_1"
				organizationId={null}
				open={open}
				onOpenChange={onOpenChange}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	useReviewCenterCount.mockReset();
	useReviewCenterItems.mockReset();
	pmCapabilities.mockReset();
	retryPmSync.mockReset();
	retryPmSyncBatch.mockReset();
	dismissPmSyncFailureBatch.mockReset();
	reviewStateChange.mockReset();
	bulkReview.mockReset();
	localStorage.clear();
	sessionStorage.clear();
	// Sensible defaults; individual tests override.
	setCounts({ conflictsCount: 0, failuresCount: 0, pullDriftCount: 0 });
	setItems(emptyItems);
});

afterEach(() => cleanup());

describe("ReviewCenterPanel — tabs", () => {
	it("renders exactly three tabs in order Conflicts → Failures → Sync Drift, each with its TRUE count (SC1.1/SC1.2)", async () => {
		setCounts({ conflictsCount: 8, failuresCount: 32, pullDriftCount: 3 });
		setItems({
			conflicts: [conflictItem("c1")],
			failures: [failureItem("f1")],
			pullDrift: [pullDriftItem("p1")],
		});
		renderPanel();

		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(3);
		expect(tabs[0]).toHaveTextContent(/Conflicts\s*8/);
		expect(tabs[1]).toHaveTextContent(/Failures\s*32/);
		expect(tabs[2]).toHaveTextContent(/Sync Drift\s*3/);
		// The renamed label is the only drift wording — no "Pull Drift" remains.
		expect(tabs[2]).not.toHaveTextContent(/Pull Drift/);
	});

	it("labels use the count query, not the capped list length (SC1.3)", () => {
		// failuresCount = 32 while only 2 failure rows are in the capped list.
		setCounts({ conflictsCount: 0, failuresCount: 32, pullDriftCount: 0 });
		setItems({
			conflicts: [],
			failures: [failureItem("f1"), failureItem("f2", "US-099")],
			pullDrift: [],
		});
		renderPanel();

		const failuresTab = screen.getAllByRole("tab")[1];
		expect(failuresTab).toHaveTextContent(/Failures\s*32/);
		expect(failuresTab).not.toHaveTextContent(/Failures\s*2\b/);
	});

	it("defaults to the first non-empty tab at open (FR2): {0,5,0} → Failures", () => {
		setCounts({ conflictsCount: 0, failuresCount: 5, pullDriftCount: 0 });
		setItems({
			conflicts: [],
			failures: [failureItem("f1")],
			pullDrift: [],
		});
		renderPanel();

		const failuresTab = screen.getAllByRole("tab")[1];
		expect(failuresTab).toHaveAttribute("data-state", "active");
	});

	it("defaults to Conflicts when all categories are empty: {0,0,0} → Conflicts", () => {
		setCounts({ conflictsCount: 0, failuresCount: 0, pullDriftCount: 0 });
		setItems(emptyItems);
		renderPanel();

		const conflictsTab = screen.getAllByRole("tab")[0];
		expect(conflictsTab).toHaveAttribute("data-state", "active");
	});

	it("does NOT auto-switch when the active tab empties mid-session (SC6.3 / D4)", async () => {
		// Open on Failures (first non-empty), then resolve drops failures to 0.
		setCounts({ conflictsCount: 0, failuresCount: 5, pullDriftCount: 2 });
		setItems({
			conflicts: [],
			failures: [failureItem("f1")],
			pullDrift: [pullDriftItem("p1")],
		});
		const { rerender } = renderPanel();

		expect(screen.getAllByRole("tab")[1]).toHaveAttribute(
			"data-state",
			"active",
		);

		// A resolve empties Failures (and would otherwise make Sync Drift the
		// first non-empty). The active tab must STAY on Failures.
		setCounts({ conflictsCount: 0, failuresCount: 0, pullDriftCount: 2 });
		setItems({
			conflicts: [],
			failures: [],
			pullDrift: [pullDriftItem("p1")],
		});
		rerender(
			<QueryClientProvider client={new QueryClient()}>
				<ReviewCenterPanel
					projectId="project_1"
					organizationId={null}
					open
					onOpenChange={() => {}}
				/>
			</QueryClientProvider>,
		);

		const failuresTab = screen.getAllByRole("tab")[1];
		expect(failuresTab).toHaveAttribute("data-state", "active");
		// Shows the Failures empty state, NOT pull-drift items.
		expect(screen.getByText("NO FAILURES")).toBeInTheDocument();
	});

	it("re-runs first-non-empty on reopen (ref reset on close)", () => {
		setCounts({ conflictsCount: 5, failuresCount: 0, pullDriftCount: 0 });
		setItems({
			conflicts: [conflictItem("c1")],
			failures: [],
			pullDrift: [],
		});
		const client = new QueryClient();
		const renderWith = (open: boolean) => (
			<QueryClientProvider client={client}>
				<ReviewCenterPanel
					projectId="project_1"
					organizationId={null}
					open={open}
					onOpenChange={() => {}}
				/>
			</QueryClientProvider>
		);
		pmCapabilities.mockResolvedValue({ configured: true });
		const { rerender } = render(renderWith(true));

		// First open → Conflicts is the first non-empty.
		expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
			"data-state",
			"active",
		);

		// Close (ref reset), then reopen with a DIFFERENT first non-empty.
		rerender(renderWith(false));
		setCounts({ conflictsCount: 0, failuresCount: 4, pullDriftCount: 0 });
		setItems({
			conflicts: [],
			failures: [failureItem("f1")],
			pullDrift: [],
		});
		rerender(renderWith(true));

		// The reset lets first-non-empty re-run → Failures this time.
		expect(screen.getAllByRole("tab")[1]).toHaveAttribute(
			"data-state",
			"active",
		);
	});

	it("renders each category's per-tab empty state when it has 0 items (SC5.1)", async () => {
		setCounts({ conflictsCount: 0, failuresCount: 0, pullDriftCount: 0 });
		setItems(emptyItems);
		const user = userEvent.setup();
		renderPanel({ configured: true });

		// Conflicts (default) empty state.
		expect(screen.getByText("NO CONFLICTS")).toBeInTheDocument();

		await user.click(screen.getAllByRole("tab")[1]);
		expect(screen.getByText("NO FAILURES")).toBeInTheDocument();

		await user.click(screen.getAllByRole("tab")[2]);
		expect(screen.getByText("NO SYNC DRIFT")).toBeInTheDocument();
	});

	it("shows the 'connect a PM tool' placeholder on Sync Drift when not configured (SC5.2)", async () => {
		setCounts({ conflictsCount: 0, failuresCount: 0, pullDriftCount: 0 });
		setItems(emptyItems);
		const user = userEvent.setup();
		renderPanel({ configured: false });

		await user.click(screen.getAllByRole("tab")[2]);
		expect(
			await screen.findByText(
				"Sync drift appears here once a PM tool is connected.",
			),
		).toBeInTheDocument();
	});

	it("shows the standard 'no items' Sync Drift empty state when configured but no drift (SC5.2)", async () => {
		setCounts({ conflictsCount: 0, failuresCount: 0, pullDriftCount: 0 });
		setItems(emptyItems);
		const user = userEvent.setup();
		const { findByText } = renderPanel({ configured: true });
		// Let the pmCapabilities query resolve to configured=true.
		await findByText("Conflicts");

		await user.click(screen.getAllByRole("tab")[2]);
		expect(screen.getByText("NO SYNC DRIFT")).toBeInTheDocument();
		expect(
			screen.queryByText(
				"Sync drift appears here once a PM tool is connected.",
			),
		).not.toBeInTheDocument();
	});

	it("shows '—' labels while counts load and a skeleton while items load (FR6)", () => {
		setCounts(null, true); // counts loading
		setItems(null, true); // items loading
		const { baseElement } = renderPanel();

		const tabs = screen.getAllByRole("tab");
		expect(tabs[0]).toHaveTextContent("—");
		expect(tabs[1]).toHaveTextContent("—");
		expect(tabs[2]).toHaveTextContent("—");
		// Shared skeleton in the active tab content. The Sheet is portalled to
		// document.body, so query the whole base element.
		expect(
			baseElement.querySelectorAll(".animate-pulse").length,
		).toBeGreaterThan(0);
	});

	it("switching tabs swaps the list to that category's items (SC4.2)", async () => {
		setCounts({ conflictsCount: 1, failuresCount: 1, pullDriftCount: 0 });
		setItems({
			conflicts: [conflictItem("c1", "F-039")],
			failures: [failureItem("f1", "US-002")],
			pullDrift: [],
		});
		const user = userEvent.setup();
		renderPanel();

		// Default = Conflicts → shows the conflict row.
		expect(screen.getByText(/F-039/)).toBeInTheDocument();

		await user.click(screen.getAllByRole("tab")[1]);
		expect(screen.getByText(/US-002/)).toBeInTheDocument();
	});

	it("'View all in Sync History' closes the panel and deep-links to the roadmap sync log", async () => {
		setCounts({ conflictsCount: 1, failuresCount: 0, pullDriftCount: 0 });
		setItems({
			conflicts: [conflictItem("c1")],
			failures: [],
			pullDrift: [],
		});
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		renderPanel({ onOpenChange });

		await user.click(
			screen.getByRole("button", { name: /View all in Sync History/ }),
		);

		expect(onOpenChange).toHaveBeenCalledWith(false);
		// Adds `history=sync` while preserving the params already on the URL —
		// `StoriesRoadmap` consumes it and opens the modal's Sync History tab.
		expect(routerReplace).toHaveBeenCalledWith(
			"/app/projects/project_1?tab=stories&history=sync",
			{ scroll: false },
		);
	});

	it("has no serious or critical axe violations", async () => {
		setCounts({ conflictsCount: 1, failuresCount: 1, pullDriftCount: 1 });
		setItems({
			conflicts: [conflictItem("c1")],
			failures: [failureItem("f1")],
			pullDrift: [pullDriftItem("p1")],
		});
		const { baseElement } = renderPanel();
		await waitFor(() =>
			expect(screen.getByRole("dialog")).toBeInTheDocument(),
		);

		// `region` is a page-level landmark rule. A Radix tooltip renders its
		// content into a body portal (outside any landmark), so an open tab
		// tooltip trips `region` here even though the live app wraps this panel
		// in the Sheet dialog landmark. Scope it out for this component-isolation
		// snapshot; all other serious/critical rules still apply.
		const results = await axe(baseElement, {
			rules: { region: { enabled: false } },
		});
		expect(results).toHaveNoViolations();
	});
});

describe("ReviewCenterPanel — tab tooltips", () => {
	it("exposes a descriptive informational tooltip on each of the three tab triggers", async () => {
		setCounts({ conflictsCount: 1, failuresCount: 1, pullDriftCount: 1 });
		setItems({
			conflicts: [conflictItem("c1")],
			failures: [failureItem("f1")],
			pullDrift: [pullDriftItem("p1")],
		});
		renderPanel();

		const tabs = screen.getAllByRole("tab");

		// Keyboard focus opens a Radix tooltip immediately (no hover delay), which
		// links the description to the tab via aria-describedby. Assert the tab's
		// accessible description rather than a raw text node — Radix renders the
		// content plus a screen-reader copy, so text-matching is ambiguous.
		tabs[0].focus();
		await waitFor(() =>
			expect(tabs[0]).toHaveAccessibleDescription(
				"Items edited in both Fabric and your PM tool — choose which version to keep.",
			),
		);

		tabs[1].focus();
		await waitFor(() =>
			expect(tabs[1]).toHaveAccessibleDescription(
				"Syncs that didn't go through — retry once the cause is fixed.",
			),
		);

		tabs[2].focus();
		await waitFor(() =>
			expect(tabs[2]).toHaveAccessibleDescription(
				"Changes made in your PM tool that aren't in Fabric yet — review each one.",
			),
		);
	});
});

describe("ReviewCenterPanel — bulk actions", () => {
	/** Switch to a tab by its position, then return after the swap. */
	async function gotoTab(
		user: ReturnType<typeof userEvent.setup>,
		idx: number,
	) {
		await user.click(screen.getAllByRole("tab")[idx]);
	}

	it("renders no selection checkboxes and no bulk toolbar on the Sync Drift tab", async () => {
		setCounts({ conflictsCount: 0, failuresCount: 0, pullDriftCount: 2 });
		setItems({
			conflicts: [],
			failures: [],
			pullDrift: [
				flagMissingItem("p1", "US-010"),
				pullDriftItem("p2", "US-020"),
			],
		});
		const user = userEvent.setup();
		renderPanel();
		await gotoTab(user, 2);

		// The rows render (single-item actions stay), but no bulk surface exists.
		expect(screen.getByText(/US-010/)).toBeInTheDocument();
		expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
		expect(
			screen.queryByRole("toolbar", { name: /bulk actions/i }),
		).not.toBeInTheDocument();
		// The single-item FLAG_MISSING triad is still available.
		expect(
			screen.getByRole("button", { name: /Unlink US-010/ }),
		).toBeInTheDocument();
	});

	it("shows Retry, Dismiss, and a Clear-selection control in the bulk toolbar on the Failures tab", async () => {
		setCounts({ conflictsCount: 0, failuresCount: 1, pullDriftCount: 0 });
		setItems({
			conflicts: [],
			failures: [failureItem("f1", "US-002")],
			pullDrift: [],
		});
		const user = userEvent.setup();
		renderPanel();
		await gotoTab(user, 1);

		await user.click(
			screen.getByRole("checkbox", { name: /Select US-002/ }),
		);

		const toolbar = await screen.findByRole("toolbar", {
			name: /bulk actions/i,
		});
		expect(
			within(toolbar).getByRole("button", { name: /^Retry$/ }),
		).toBeInTheDocument();
		// Bulk Dismiss clears the selected failures from the queue.
		expect(
			within(toolbar).getByRole("button", { name: /^Dismiss$/ }),
		).toBeInTheDocument();
		// The deselect control is now explicitly "Clear selection" (was the
		// ambiguous "Clear", mistaken for clearing the failures themselves).
		expect(
			within(toolbar).getByRole("button", {
				name: /^Clear selection$/,
			}),
		).toBeInTheDocument();
		// No PM-tool-specific recovery verbs in the bulk toolbar.
		expect(
			within(toolbar).queryByRole("button", { name: /^Unlink$/ }),
		).not.toBeInTheDocument();
		expect(
			within(toolbar).queryByRole("button", { name: /^Re-push$/ }),
		).not.toBeInTheDocument();
	});

	it("select-all selects every loaded eligible Failures row and is indeterminate for a partial selection", async () => {
		setCounts({ conflictsCount: 0, failuresCount: 3, pullDriftCount: 0 });
		setItems({
			conflicts: [],
			failures: [
				failureItem("f1", "US-002"),
				failureItem("f2", "US-003"),
				// pmTool null → disabled Retry → not selectable, ignored by select-all.
				{ ...failureItem("f3", "US-004"), pmTool: null },
			],
			pullDrift: [],
		});
		const user = userEvent.setup();
		renderPanel();
		await gotoTab(user, 1);

		// Partial selection → select-all reflects indeterminate.
		await user.click(
			screen.getByRole("checkbox", { name: /Select US-002/ }),
		);
		const selectAll = screen.getByRole("checkbox", {
			name: /Select all/i,
		});
		expect(selectAll).toHaveAttribute("aria-checked", "mixed");

		// Select-all checks every eligible (resolvable-tool) row.
		await user.click(selectAll);
		expect(
			screen.getByRole("checkbox", { name: /Select US-002/ }),
		).toBeChecked();
		expect(
			screen.getByRole("checkbox", { name: /Select US-003/ }),
		).toBeChecked();
		// The disabled-retry row never offered a checkbox.
		expect(
			screen.queryByRole("checkbox", { name: /Select US-004/ }),
		).not.toBeInTheDocument();
	});

	it("bulk Retry on Failures dispatches retryPmSyncBatch with each row's id + itemType, excluding disabled rows", async () => {
		retryPmSyncBatch.mockResolvedValue({ enqueuedCount: 1, results: [] });
		setCounts({ conflictsCount: 0, failuresCount: 2, pullDriftCount: 0 });
		setItems({
			conflicts: [],
			failures: [
				// entityId DISTINCT from the row id so the assertion proves the
				// payload keys on the story id (entityId), not the row id.
				{
					...failureItem("f1", "US-002"),
					entityId: "story_f1",
					itemType: "bug" as const,
				},
				// pmTool null → disabled Retry → not selectable, excluded.
				{ ...failureItem("f2", "US-003"), pmTool: null },
			],
			pullDrift: [],
		});
		const user = userEvent.setup();
		renderPanel();
		await gotoTab(user, 1);

		// The disabled-retry row offers no checkbox.
		expect(
			screen.queryByRole("checkbox", { name: /Select US-003/ }),
		).not.toBeInTheDocument();

		await user.click(
			screen.getByRole("checkbox", { name: /Select US-002/ }),
		);
		const toolbar = await screen.findByRole("toolbar", {
			name: /bulk actions/i,
		});
		await user.click(
			within(toolbar).getByRole("button", { name: /^Retry$/ }),
		);

		await waitFor(() =>
			expect(retryPmSyncBatch).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "project_1",
					items: [{ id: "story_f1", itemType: "bug" }],
				}),
			),
		);
		// No unlinkFirst on a plain retry.
		expect(retryPmSyncBatch.mock.calls[0][0]).not.toHaveProperty(
			"unlinkFirst",
			true,
		);
	});

	it("bulk Dismiss on Failures dispatches dismissPmSyncFailureBatch with each selected row's id + itemType", async () => {
		dismissPmSyncFailureBatch.mockResolvedValue({ dismissedCount: 1 });
		setCounts({ conflictsCount: 0, failuresCount: 2, pullDriftCount: 0 });
		setItems({
			conflicts: [],
			failures: [
				// entityId DISTINCT from the row id so the assertion proves the
				// payload keys on the story id (entityId), not the row id.
				{
					...failureItem("f1", "US-002"),
					entityId: "story_f1",
					itemType: "bug" as const,
				},
				// pmTool null → not selectable → excluded from the bulk payload.
				{ ...failureItem("f2", "US-003"), pmTool: null },
			],
			pullDrift: [],
		});
		const user = userEvent.setup();
		renderPanel();
		await gotoTab(user, 1);

		await user.click(
			screen.getByRole("checkbox", { name: /Select US-002/ }),
		);
		const toolbar = await screen.findByRole("toolbar", {
			name: /bulk actions/i,
		});
		await user.click(
			within(toolbar).getByRole("button", { name: /^Dismiss$/ }),
		);

		await waitFor(() =>
			expect(dismissPmSyncFailureBatch).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "project_1",
					items: [{ id: "story_f1", itemType: "bug" }],
				}),
			),
		);
	});
});
