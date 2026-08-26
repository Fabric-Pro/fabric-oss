import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_ROADMAP_FILTERS } from "../../../lib/roadmap-filters";
import { DEFAULT_ROADMAP_SORT } from "../../../lib/roadmap-sorts";

// The toolbar renders <ReviewCenterInbox />, which derives its projectId from
// the route, reads tenant context, and polls `reviewCenter.count`. Stub the
// count to 0 so the inbox renders nothing and these tests stay focused on the
// filter/sort UI.
vi.mock("next/navigation", () => ({
	useParams: () => ({ id: "project_1" }),
	useRouter: () => ({
		push: vi.fn(),
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	usePathname: () => "/",
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: null, basePath: "/app" }),
}));

// The toolbar also renders <PendingProposalsButton />, which polls the Teams
// channel monitor proposal count. Stub it to 0 so the button renders nothing in
// the sort/filter-focused suites; the consolidation suite overrides it.
const pendingProposalsCount = vi.fn().mockResolvedValue({ count: 0 });

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			reviewCenter: {
				count: vi.fn().mockResolvedValue({
					conflictsCount: 0,
					failuresCount: 0,
					pullDriftCount: 0,
					total: 0,
				}),
			},
			teamsChannelMonitor: {
				pendingProposals: {
					count: (...args: unknown[]) =>
						pendingProposalsCount(...args),
				},
			},
		},
	},
}));

// The toolbar reads the Custom Tags option list via
// `orpc.projects.stories.tags.list.queryOptions(...)` (the query stays
// `enabled: false` while the feature flag is off, so the queryFn never runs —
// but the queryOptions() call itself is unconditional). The real `orpc` proxy
// has no `projects.stories.tags` branch, so that call throws "Cannot read
// properties of undefined (reading 'tags')". Wrap the real proxy so that ONLY
// the missing `projects.stories.tags.list.*` path is stubbed; every other path
// (e.g. `projects.reviewCenter.count`, which the Review Center inbox renders in
// this subtree and which delegates to the mocked `orpcClient`) falls through to
// the genuine query-utils proxy untouched.
const stories_tags_list_stub = {
	queryOptions: () => ({
		queryKey: ["tags", "list"],
		queryFn: async () => ({ tags: [] }),
	}),
	queryKey: () => ["tags", "list"],
};

vi.mock("@shared/lib/orpc-query-utils", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@shared/lib/orpc-query-utils")>();
	const realOrpc = actual.orpc;

	// Recursively proxy down `projects` → `stories`, substituting only the
	// `tags` node; all other property reads delegate to the real proxy.
	const storiesProxy = new Proxy(realOrpc.projects.stories, {
		get(target, prop, receiver) {
			if (prop === "tags") {
				return { list: stories_tags_list_stub };
			}
			return Reflect.get(target, prop, receiver);
		},
	});
	const projectsProxy = new Proxy(realOrpc.projects, {
		get(target, prop, receiver) {
			if (prop === "stories") {
				return storiesProxy;
			}
			return Reflect.get(target, prop, receiver);
		},
	});
	const orpcProxy = new Proxy(realOrpc, {
		get(target, prop, receiver) {
			if (prop === "projects") {
				return projectsProxy;
			}
			return Reflect.get(target, prop, receiver);
		},
	});

	return { ...actual, orpc: orpcProxy };
});

import { RoadmapFilterToolbar } from "../RoadmapFilterToolbar";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
	if (!Element.prototype.scrollIntoView) {
		Element.prototype.scrollIntoView = () => {};
	}
});

beforeEach(() => {
	// The panel's open/closed state persists in localStorage; clear it so each
	// test starts from the default (expanded).
	try {
		localStorage.clear();
	} catch {}
	pendingProposalsCount.mockResolvedValue({ count: 0 });
});

function renderToolbar(
	overrides: Partial<React.ComponentProps<typeof RoadmapFilterToolbar>> = {},
) {
	const onFiltersChange = vi.fn();
	const onClearAll = vi.fn();
	const onRemoveFilter = vi.fn();
	const onSortChange = vi.fn();
	const onResetSort = vi.fn();
	const onOpenProposalsInbox = vi.fn();
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const utils = render(
		<QueryClientProvider client={client}>
			<RoadmapFilterToolbar
				filters={EMPTY_ROADMAP_FILTERS}
				onFiltersChange={onFiltersChange}
				onClearAll={onClearAll}
				onRemoveFilter={onRemoveFilter}
				totalCount={5}
				filteredCount={5}
				hasActiveFilters={false}
				sort={DEFAULT_ROADMAP_SORT}
				onSortChange={onSortChange}
				isSortDefault={true}
				onResetSort={onResetSort}
				projectId="project_1"
				organizationId={null}
				onOpenProposalsInbox={onOpenProposalsInbox}
				{...overrides}
			/>
		</QueryClientProvider>,
	);
	return {
		...utils,
		onFiltersChange,
		onClearAll,
		onRemoveFilter,
		onSortChange,
		onResetSort,
		onOpenProposalsInbox,
	};
}

describe("RoadmapFilterToolbar — result count", () => {
	it("shows the total work-item count when no filters are active", () => {
		renderToolbar({ totalCount: 48, filteredCount: 48 });
		expect(screen.getByTestId("roadmap-filter-count")).toHaveTextContent(
			"48 work items",
		);
	});

	it("shows 'N of M shown' when filtering", () => {
		renderToolbar({
			filters: {
				...EMPTY_ROADMAP_FILTERS,
				kind: ["BUG"],
				stage: ["DONE"],
			},
			hasActiveFilters: true,
			totalCount: 48,
			filteredCount: 12,
		});
		expect(screen.getByTestId("roadmap-filter-count")).toHaveTextContent(
			"12 of 48 shown",
		);
	});

	it("renders hiddenMatchCount affordance when hiddenMatchCount > 0 and fires onShowHidden", async () => {
		const user = userEvent.setup();
		const onShowHidden = vi.fn();
		renderToolbar({
			hiddenMatchCount: 3,
			onShowHidden,
		});
		const btn = screen.getByRole("button", {
			name: /3 hidden also match/i,
		});
		expect(btn).toBeInTheDocument();
		await user.click(btn);
		expect(onShowHidden).toHaveBeenCalledTimes(1);
	});

	it("does not render hiddenMatchCount affordance when hiddenMatchCount is 0 or omitted", () => {
		renderToolbar({
			hiddenMatchCount: 0,
		});
		expect(
			screen.queryByText(/hidden also match/i),
		).not.toBeInTheDocument();
	});
});

describe("RoadmapFilterToolbar — primary facets (always inline)", () => {
	it("renders Type / Priority / Stage inline by default", () => {
		renderToolbar();
		expect(screen.getByText("Type")).toBeInTheDocument();
		expect(screen.getByText("Priority")).toBeInTheDocument();
		expect(screen.getByText("Stage")).toBeInTheDocument();
	});

	it("keeps the secondary facets hidden until 'More filters' is opened", () => {
		renderToolbar();
		expect(screen.queryByText("Source")).not.toBeInTheDocument();
		expect(screen.queryByText("Sync")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /more filters/i }),
		).toHaveAttribute("aria-expanded", "false");
	});

	it("selecting a Type option emits onFiltersChange", async () => {
		const user = userEvent.setup();
		const { onFiltersChange } = renderToolbar();
		await user.click(screen.getByRole("button", { name: "Type filter" }));
		await user.click(await screen.findByRole("option", { name: "Bug" }));
		expect(onFiltersChange).toHaveBeenCalledWith({ kind: ["BUG"] });
	});
});

describe("RoadmapFilterToolbar — More filters disclosure", () => {
	it("expands the secondary facets when 'More filters' is clicked", async () => {
		const user = userEvent.setup();
		renderToolbar();
		expect(screen.queryByText("Source")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /more filters/i }));
		expect(screen.getByText("Sync")).toBeInTheDocument();
		expect(screen.getByText("Source")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /more filters/i }),
		).toHaveAttribute("aria-expanded", "true");
	});

	it("badges the count of active hidden (secondary) filters", () => {
		renderToolbar({
			filters: {
				...EMPTY_ROADMAP_FILTERS,
				sync: ["synced"],
				source: ["jira"],
			},
			hasActiveFilters: true,
		});
		const trigger = screen.getByRole("button", { name: /more filters/i });
		expect(within(trigger).getByText("2")).toBeInTheDocument();
	});

	it("remembers the expanded state across remounts (localStorage)", async () => {
		const user = userEvent.setup();
		const { unmount } = renderToolbar();
		await user.click(screen.getByRole("button", { name: /more filters/i }));
		expect(screen.getByText("Source")).toBeInTheDocument();
		unmount();
		renderToolbar();
		// Fresh mount reads the stored "expanded" preference.
		expect(screen.getByText("Source")).toBeInTheDocument();
	});

	it("selecting a flag from the Flags dropdown inside More filters emits onFiltersChange", async () => {
		const user = userEvent.setup();
		const { onFiltersChange } = renderToolbar();
		await user.click(screen.getByRole("button", { name: /more filters/i }));
		await user.click(screen.getByRole("button", { name: "Flags filter" }));
		await user.click(
			await screen.findByRole("option", { name: "Missing description" }),
		);
		expect(onFiltersChange).toHaveBeenCalledWith({
			missingDesc: true,
			missingAc: false,
			duplicatesOnly: false,
			needsMoreInfo: false,
			blocked: false,
		});
	});

	it("renders 'Recently added' and 'Date Modified' (not 'Recently changed')", async () => {
		const user = userEvent.setup();
		renderToolbar();
		await user.click(screen.getByRole("button", { name: /more filters/i }));
		expect(screen.getByText("Recently approved")).toBeInTheDocument();
		expect(screen.getByText("Recently added")).toBeInTheDocument();
		expect(screen.getByText("Date Modified")).toBeInTheDocument();
		expect(screen.queryByText("Recently changed")).not.toBeInTheDocument();
	});

	it("selecting 'Recently added: 30d' emits onChange({ recentlyAdded: 30 })", async () => {
		const user = userEvent.setup();
		const { onFiltersChange } = renderToolbar();
		await user.click(screen.getByRole("button", { name: /more filters/i }));
		const group = screen.getByRole("radiogroup", {
			name: "Recently added",
		});
		await user.click(within(group).getByRole("radio", { name: "30d" }));
		expect(onFiltersChange).toHaveBeenCalledWith({ recentlyAdded: 30 });
	});
});

describe("RoadmapFilterToolbar — active chips + clear", () => {
	it("renders chips for active filters and removes on click", async () => {
		const user = userEvent.setup();
		const { onRemoveFilter } = renderToolbar({
			filters: { ...EMPTY_ROADMAP_FILTERS, missingDesc: true },
			hasActiveFilters: true,
		});
		await user.click(
			screen.getByRole("button", {
				name: "Remove missing-description filter",
			}),
		);
		expect(onRemoveFilter).toHaveBeenCalledWith("missingDesc");
	});

	it("clears all filters via the chip-row action", async () => {
		const user = userEvent.setup();
		const { onClearAll } = renderToolbar({
			filters: { ...EMPTY_ROADMAP_FILTERS, kind: ["BUG"] },
			hasActiveFilters: true,
		});
		await user.click(screen.getByRole("button", { name: /clear all/i }));
		expect(onClearAll).toHaveBeenCalledTimes(1);
	});
});

describe("RoadmapFilterToolbar — consolidated inbox entry points", () => {
	it("renders the moved Review proposals button in the inbox slot (next to the Review Center inbox)", async () => {
		// The Review Center inbox hides at total 0 (module-level mock); the
		// proposals button renders once its non-zero count resolves. This proves
		// the button now lives on the filter row's inbox slot, not the main
		// toolbar.
		pendingProposalsCount.mockResolvedValue({ count: 2 });

		renderToolbar();

		expect(
			await screen.findByRole("button", {
				name: /Review 2 pending proposals/,
			}),
		).toBeInTheDocument();
	});

	it("fires onOpenProposalsInbox when the moved Review proposals button is clicked", async () => {
		pendingProposalsCount.mockResolvedValue({ count: 1 });
		const user = userEvent.setup();
		const { onOpenProposalsInbox } = renderToolbar();

		const button = await screen.findByRole("button", {
			name: /Review 1 pending proposal/,
		});
		await user.click(button);
		expect(onOpenProposalsInbox).toHaveBeenCalledTimes(1);
	});
});

describe("RoadmapFilterToolbar — search input autofill guard", () => {
	// Regression guard: browsers were treating the roadmap search box as a
	// credential/email field and offering to prefill the user's saved account.
	// type="search" + autocomplete="off" tell the browser this is a plain search
	// field, not a login input. See docs/plans — roadmap search autofill fix.
	it("marks the search input as a non-credential search field", () => {
		renderToolbar();
		const search = screen.getByLabelText("Search roadmap items");
		expect(search).toHaveAttribute("type", "search");
		expect(search).toHaveAttribute("autocomplete", "off");
	});
});
