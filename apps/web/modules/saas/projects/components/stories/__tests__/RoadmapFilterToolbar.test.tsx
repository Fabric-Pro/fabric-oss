import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EMPTY_ROADMAP_FILTERS,
	type RoadmapFilters,
} from "../../../lib/roadmap-filters";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				tags: { list: vi.fn().mockResolvedValue({ tags: [] }) },
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

const locale = vi.hoisted(() => ({ value: "en" }));
beforeEach(() => {
	locale.value = "en";
	// The panel's open/closed state persists in localStorage; clear it so each
	// test starts from the default (collapsed).
	try {
		localStorage.clear();
	} catch {}
});

function renderToolbar(
	overrides: Partial<React.ComponentProps<typeof RoadmapFilterToolbar>> = {},
) {
	const onFiltersChange = vi.fn();
	const onClearAll = vi.fn();
	const onRemoveFilter = vi.fn();
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
				projectId="project_1"
				organizationId={null}
				{...overrides}
			/>
		</QueryClientProvider>,
	);
	return {
		...utils,
		onFiltersChange,
		onClearAll,
		onRemoveFilter,
		client,
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
			name: "Show 3 hidden",
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
			screen.queryByRole("button", { name: /Show .* hidden/ }),
		).not.toBeInTheDocument();
	});

	it("offers to reveal description-only matches when some were collapsed", async () => {
		const user = userEvent.setup();
		const onToggleBodyMatches = vi.fn();
		renderToolbar({
			bodyMatchCount: 9,
			bodyMatchesShown: false,
			onToggleBodyMatches,
		});
		const btn = screen.getByTestId("roadmap-body-match-toggle");
		expect(btn).toHaveTextContent("9 more match in description");
		expect(btn).toHaveAttribute("aria-expanded", "false");
		await user.click(btn);
		expect(onToggleBodyMatches).toHaveBeenCalledTimes(1);
	});

	it("offers to collapse them again once revealed", () => {
		renderToolbar({
			bodyMatchCount: 9,
			bodyMatchesShown: true,
			onToggleBodyMatches: vi.fn(),
		});
		const btn = screen.getByTestId("roadmap-body-match-toggle");
		expect(btn).toHaveTextContent("hide 9 description matches");
		expect(btn).toHaveAttribute("aria-expanded", "true");
	});

	it("stays silent when the search collapsed nothing", () => {
		renderToolbar({
			bodyMatchCount: 0,
			onToggleBodyMatches: vi.fn(),
		});
		expect(
			screen.queryByTestId("roadmap-body-match-toggle"),
		).not.toBeInTheDocument();
	});

	it("reports the narrowed count, not the pre-narrowing total", () => {
		renderToolbar({
			hasActiveFilters: true,
			totalCount: 47,
			filteredCount: 2,
			bodyMatchCount: 9,
			onToggleBodyMatches: vi.fn(),
		});
		expect(screen.getByTestId("roadmap-filter-count")).toHaveTextContent(
			"2 of 47 shown",
		);
	});
});

describe("RoadmapFilterToolbar — primary facets (always inline)", () => {
	it("renders Type / Priority / Stage inline by default", () => {
		renderToolbar();
		expect(
			screen.getByRole("button", { name: /^Type:/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^Priority:/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^Stage:/ }),
		).toBeInTheDocument();
	});

	it("keeps the secondary facets hidden until 'More filters' is opened", () => {
		renderToolbar();
		expect(
			screen.queryByRole("button", { name: /^Source:/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /^Sync:/ }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /more filters/i }),
		).toHaveAttribute("aria-expanded", "false");
	});

	it("selecting a Type option emits onFiltersChange", async () => {
		const user = userEvent.setup();
		const { onFiltersChange } = renderToolbar();
		await user.click(screen.getByRole("button", { name: /^Type:/ }));
		await user.click(await screen.findByRole("option", { name: "Bug" }));
		expect(onFiltersChange).toHaveBeenCalledWith({ kind: ["BUG"] });
	});
});

describe("RoadmapFilterToolbar — More filters disclosure", () => {
	it("expands the secondary facets when 'More filters' is clicked", async () => {
		const user = userEvent.setup();
		renderToolbar();
		expect(
			screen.queryByRole("button", { name: /^Source:/ }),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /more filters/i }));
		expect(
			screen.getByRole("button", { name: /^Sync:/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^Source:/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /fewer filters/i }),
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
		expect(
			screen.getByRole("button", { name: /^Source:/ }),
		).toBeInTheDocument();
		unmount();
		renderToolbar();
		// Fresh mount reads the stored "expanded" preference.
		expect(
			screen.getByRole("button", { name: /^Source:/ }),
		).toBeInTheDocument();
	});

	it("selecting a flag from the Flags dropdown inside More filters emits onFiltersChange", async () => {
		const user = userEvent.setup();
		const { onFiltersChange } = renderToolbar();
		await user.click(screen.getByRole("button", { name: /more filters/i }));
		await user.click(screen.getByRole("button", { name: /^Flags:/ }));
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

	it("renders 'Added' and 'Edited' (not 'Recently changed')", async () => {
		const user = userEvent.setup();
		renderToolbar();
		await user.click(screen.getByRole("button", { name: /more filters/i }));
		expect(
			screen.getByRole("button", { name: /Approved/ }),
		).toHaveTextContent("Approved: Any time");
		expect(screen.getByRole("button", { name: /Added/ })).toHaveTextContent(
			"Added: Any time",
		);
		expect(
			screen.getByRole("button", { name: /Edited/ }),
		).toHaveTextContent("Edited: Any time");
		expect(screen.queryByText("Recently changed")).not.toBeInTheDocument();
	});

	it("selecting 'Added: 30d' emits onChange({ recentlyAdded: 30 })", async () => {
		const user = userEvent.setup();
		const { onFiltersChange } = renderToolbar();
		await user.click(screen.getByRole("button", { name: /more filters/i }));
		await user.click(screen.getByRole("button", { name: /Added/ }));
		await user.click(screen.getByRole("option", { name: "Last 30 days" }));
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

describe("RoadmapFilterToolbar — search input autofill guard", () => {
	// Regression guard: browsers were treating the roadmap search box as a
	// credential/email field and offering to prefill the user's saved account.
	// type="search" + autocomplete="off" tell the browser this is a plain search
	// field, not a login input. See docs/plans — roadmap search autofill fix.
	it("marks the search input as a non-credential search field", () => {
		renderToolbar();
		const search = screen.getByLabelText("Search work items");
		expect(search).toHaveAccessibleName("Search work items");
		expect(search).toHaveAttribute("type", "search");
		expect(search).toHaveAttribute("autocomplete", "off");
	});
});

vi.mock("next-intl", async (importOriginal) => {
	const actual = await importOriginal<typeof import("next-intl")>();
	const { default: en } = await import("@repo/i18n/translations/en.json");
	const { default: de } = await import("@repo/i18n/translations/de.json");
	return {
		...actual,
		useLocale: () => locale.value,
		useTranslations: (namespace: string) =>
			actual.createTranslator({
				locale: locale.value,
				messages: locale.value === "de" ? de : en,
				namespace,
			}),
	};
});

it("shows facets and all date controls together with More filters, and hides both with Fewer filters", async () => {
	const user = userEvent.setup();
	renderToolbar();
	for (let attempt = 0; attempt < 2; attempt++) {
		await user.click(screen.getByRole("button", { name: /More filters/ }));
		expect(
			screen.getByRole("button", { name: /^Sync:/ }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Dates" }),
		).not.toBeInTheDocument();
		for (const name of [/Approved/, /Added/, /Edited/]) {
			expect(screen.getByRole("button", { name })).toHaveTextContent(
				"Any time",
			);
		}

		for (const name of [
			"Created: Any",
			"Last activity: Any",
			"Last synced: Any",
		]) {
			expect(screen.getByRole("button", { name })).toBeInTheDocument();
		}

		await user.click(screen.getByRole("button", { name: /Fewer filters/ }));
		expect(
			screen.queryByRole("button", { name: /^Sync:/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Edited/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /^Created:/ }),
		).not.toBeInTheDocument();
	}
});

it("keeps the summary and sort/view controls on one results row", () => {
	renderToolbar({
		trailing: <button type="button">Sort results</button>,
		lanesCount: 3,
	});
	const row = screen.getByTestId("roadmap-filter-count").parentElement
		?.parentElement?.parentElement;
	expect(row).toContainElement(
		screen.getByRole("button", { name: "Sort results" }),
	);
	expect(row).toHaveTextContent("5 work items · 3 lanes");
});

it.each([false, true])(
	"joins results summary separators with lanes=%s",
	(lanes) => {
		renderToolbar({
			totalCount: 12,
			filteredCount: 12,
			lanesCount: lanes ? 3 : undefined,
		});
		const result = screen.getByTestId("roadmap-filter-count").parentElement;
		expect(result?.textContent).toBe(
			lanes ? "12 work items · 3 lanes" : "12 work items",
		);
	},
);
it("keeps the recency trigger mounted and focused after clearing its last active filter", async () => {
	const user = userEvent.setup();
	function Filters() {
		const [filters, setFilters] = useState<RoadmapFilters>({
			...EMPTY_ROADMAP_FILTERS,
			recentlyChanged: 7,
		});
		return (
			<RoadmapFilterToolbar
				filters={filters}
				onFiltersChange={(next) =>
					setFilters((prev) => ({ ...prev, ...next }))
				}
				onClearAll={vi.fn()}
				onRemoveFilter={vi.fn()}
				totalCount={5}
				filteredCount={5}
				hasActiveFilters
				projectId="project_1"
				organizationId={null}
			/>
		);
	}
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<Filters />
		</QueryClientProvider>,
	);
	await user.click(screen.getByRole("button", { name: /More filters/ }));
	const trigger = screen.getByRole("button", { name: /Edited/ });
	await user.click(trigger);
	await user.click(screen.getByRole("option", { name: "Any time" }));
	expect(trigger).toBeInTheDocument();
	expect(trigger).toHaveTextContent("Any time");
	expect(trigger).toHaveFocus();
});

it("translates the search label, placeholder and passive hidden count into German", () => {
	locale.value = "de";
	renderToolbar({ hiddenMatchCount: 3 });
	expect(screen.getByText("3 ausgeblendet")).toBeInTheDocument();
	const search = screen.getByRole("searchbox", {
		name: "Arbeitselemente suchen",
	});
	expect(search).toHaveAttribute(
		"placeholder",
		"Nach Titel, ID oder Stichwort suchen…",
	);
});
