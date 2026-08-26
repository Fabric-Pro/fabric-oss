/**
 * Asserts that the admin monitoring dashboard surfaces plain-language help
 * tooltips for every key term, and that table containers handle narrow
 * viewports without cropping.
 *
 * Scope (per acceptance criteria):
 *   1. Tooltips render on hover/focus for at least 5 key terms — covers the
 *      "Add tooltips to explain everything" requirement from the user
 *      feedback.
 *   2. Tables are wrapped in a horizontal-scroll container so they never
 *      crop on narrow viewports.
 *   3. Every icon-only help trigger carries an `aria-label`.
 *
 * Implementation notes
 * --------------------
 * - `useQuery` is mocked to short-circuit the network so each component
 *   renders in its terminal "data ready" state.
 * - The Radix Tooltip portal renders into `document.body`, so we use
 *   `screen.getByText` (queries the whole DOM) rather than the
 *   `render` result.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseQuery } = vi.hoisted(() => ({
	mockUseQuery: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		incidents: {
			// Full-history endpoint backing the timeline (incident-history pass).
			listHistory: vi.fn(),
			errorRate: {
				list: vi.fn(),
				acknowledge: vi.fn(),
				resolve: vi.fn(),
				addComment: vi.fn(),
				listEvents: vi.fn(),
			},
			component: {
				listEvents: vi.fn(),
			},
		},
		integrationHealth: {
			listActiveIncidents: vi.fn(),
			listProviderHealth: vi.fn(),
			acknowledgeIntegrationIncident: vi.fn(),
			resolveIntegrationIncident: vi.fn(),
			addComment: vi.fn(),
			listEvents: vi.fn(),
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => mockUseQuery(...args),
	useMutation: ({ mutationFn }: { mutationFn: () => Promise<unknown> }) => ({
		mutate: mutationFn,
		isPending: false,
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// nuqs powers URL-backed pagination on the active-incidents table. The
// component-under-test exercise here doesn't care about page navigation,
// so we stub a static `[1, setPage]` and a no-op `parseAsInteger`. This
// keeps the suite focused on the tooltip + layout assertions.
vi.mock("nuqs", () => ({
	useQueryState: () => [1, vi.fn()] as const,
	parseAsInteger: { withDefault: () => ({}) },
}));

// Stub the dialog so the table renders without the full dialog tree.
vi.mock(
	"../../../../../modules/saas/admin/component/monitoring/IncidentAckResolveDialog",
	() => ({
		IncidentAckResolveDialog: () => null,
		MONITORING_QUERY_KEYS: {
			activeIncidents: ["monitoring", "active-incidents"] as const,
			errorRateList: [
				"monitoring",
				"incidents",
				"error-rate",
				"list",
			] as const,
			integrationProviders: [
				"monitoring",
				"integration-health",
				"providers",
			] as const,
		},
	}),
);

import { ActiveIncidentsTable } from "../../../../../modules/saas/admin/component/monitoring/ActiveIncidentsTable";
import { IncidentTimelineList } from "../../../../../modules/saas/admin/component/monitoring/IncidentTimelineList";
import { MonitoringDashboard } from "../../../../../modules/saas/admin/component/monitoring/MonitoringDashboard";
import { ProviderHealthGrid } from "../../../../../modules/saas/admin/component/monitoring/ProviderHealthGrid";
import { ThresholdConfigDisplay } from "../../../../../modules/saas/admin/component/monitoring/ThresholdConfigDisplay";

/**
 * Drive each `useQuery` invocation through this helper so every test
 * starts in the same "data ready" terminal state. The dashboard composite
 * fires multiple distinct queries (error rate, integration active,
 * providers, timeline) and each expects a slightly different shape — we
 * branch on `queryKey[1]` to dispatch.
 */
function configureEmptyQueries(): void {
	mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
		const key = String(opts.queryKey?.[1] ?? "");
		if (key === "active-incidents") {
			return {
				data: { errorRate: [], integration: [] },
				isLoading: false,
				isError: false,
			};
		}
		// All other queries (`incidents`, `timeline`, `integration-health`)
		// expect a plain array.
		return { data: [], isLoading: false, isError: false };
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	configureEmptyQueries();
});

afterEach(() => {
	mockUseQuery.mockReset();
});

describe("MonitoringDashboard tooltips and accessibility", () => {
	it("renders help triggers for the major page-level terms", () => {
		render(<MonitoringDashboard />);
		// At least these five core sections have their own help icon.
		expect(
			screen.getByRole("button", {
				name: /What is the monitoring dashboard\?/i,
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: /What is open incidents\?/i,
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: /What is provider health\?/i,
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: /What is the incident timeline\?/i,
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: /What is alert thresholds\?/i,
			}),
		).toBeInTheDocument();
	});
});

describe("ActiveIncidentsTable section tooltips and layout", () => {
	// v2 ActiveIncidentsTable is a list-of-cards, not a tabular layout with
	// per-column headers — the user explicitly does not want any of the
	// monitoring surfaces to force horizontal scrolling, and a `<table>` with
	// `min-w-[860px]` inside `overflow-x-auto` was the v1 pattern we removed.
	// The section-level help tooltip ("What is open incidents?") still lives
	// on the heading; the per-column tooltips that used to ride the table
	// headers were dropped along with the table itself.

	it("renders the section-level help tooltip on the Open incidents heading", () => {
		render(<ActiveIncidentsTable />);
		expect(
			screen.getByRole("button", { name: /What is open incidents\?/i }),
		).toBeInTheDocument();
	});

	it("does not wrap the surface in a horizontal-scroll container", () => {
		const { container } = render(<ActiveIncidentsTable />);
		// No `overflow-x-auto` wrapper, no `<table>`, no `min-w-[*]` —
		// the v2 layout is `<ol>/<li>/<Card>` rows that wrap on narrow
		// viewports.
		expect(container.querySelector("div.overflow-x-auto")).toBeNull();
		expect(container.querySelector("table")).toBeNull();
		expect(container.querySelector(".min-w-\\[860px\\]")).toBeNull();
	});

	it("renders every help-tooltip trigger with a proper aria-label", () => {
		render(<ActiveIncidentsTable />);
		const helpButtons = screen
			.getAllByRole("button")
			.filter((b) =>
				b.getAttribute("aria-label")?.startsWith("What is "),
			);
		// At minimum, the section-level heading help tooltip.
		expect(helpButtons.length).toBeGreaterThanOrEqual(1);
		for (const button of helpButtons) {
			expect(button.getAttribute("aria-label")).toMatch(/^What is /);
		}
	});
});

describe("ProviderHealthGrid card tooltips and layout", () => {
	const providers = [
		{
			id: "p1",
			providerKey: "openai",
			displayName: "OpenAI",
			currentHealth: "MAJOR_OUTAGE" as const,
			lastPolledAt: new Date(Date.now() - 60_000).toISOString(),
			statusPageUrl: "https://status.openai.com",
			affectedFeatures: ["ai_generation", "agents", "embeddings"],
			activeIncident: null,
		},
	];

	beforeEach(() => {
		// The grid drives a single query (`integration-health` providers
		// list); the shape is a plain array of providers.
		mockUseQuery.mockReturnValue({
			data: providers,
			isLoading: false,
			isError: false,
		});
	});

	it("wraps the status pill in a tooltip explaining the health state", () => {
		render(<ProviderHealthGrid />);
		const statusTrigger = screen.getByRole("button", {
			name: /Health: Major outage/i,
		});
		expect(statusTrigger).toBeInTheDocument();
	});

	it("renders the last-poll and features tooltips with aria-labels", () => {
		render(<ProviderHealthGrid />);
		expect(
			screen.getByRole("button", { name: /What is last poll\?/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: /What is affected features\?/i,
			}),
		).toBeInTheDocument();
	});

	it("renders affected-features as wrapping chips so they do not crop", () => {
		const { container } = render(<ProviderHealthGrid />);
		// Look for the dd that holds the affected-feature chips.
		const featureChips = Array.from(container.querySelectorAll("dd")).find(
			(dd) => dd.querySelector("span"),
		);
		expect(featureChips).toBeDefined();
		// Each feature appears in its own chip, so we render 3 chips.
		const chipSpans = featureChips?.querySelectorAll("span");
		expect(chipSpans?.length ?? 0).toBeGreaterThanOrEqual(3);
	});

	it("uses an auto-fill grid so cards size to content", () => {
		const { container } = render(<ProviderHealthGrid />);
		const grid = container.querySelector(
			"[data-testid='provider-health-grid']",
		);
		expect(grid?.className).toMatch(/grid-template-columns/);
	});
});

describe("IncidentTimelineList filter chips have tooltips", () => {
	it("renders all filter chips as buttons inside the group", () => {
		render(<IncidentTimelineList />);
		const group = screen.getByRole("group", {
			name: /Filter incident timeline by source/i,
		});
		// All / Error rate / Statuspage / Synthetic probe / Breaker /
		// Alertmanager / Component = 7 chips. ("Component" was added with
		// the incident-history pass — component incidents now surface in
		// the timeline.)
		expect(group).toBeInTheDocument();
		const chips = group.querySelectorAll("button");
		expect(chips.length).toBe(7);
	});

	it("renders the section-level help tooltip", () => {
		render(<IncidentTimelineList />);
		expect(
			screen.getByRole("button", {
				name: /What is the incident timeline\?/i,
			}),
		).toBeInTheDocument();
	});
});

describe("ThresholdConfigDisplay tooltips and layout", () => {
	it("renders a help tooltip on every non-obvious column header", () => {
		render(<ThresholdConfigDisplay />);
		for (const term of [
			/What is long window\?/i,
			/What is short window\?/i,
			/What is burn rate\?/i,
			/What is minimum count\?/i,
			/What is signal\?/i,
			/What is trigger condition\?/i,
			/What is recovery hysteresis\?/i,
		]) {
			expect(
				screen.getByRole("button", { name: term }),
			).toBeInTheDocument();
		}
	});

	it("does not wrap threshold tables in horizontal-scroll containers", () => {
		// v2: the user explicitly does not want any of the monitoring tables
		// to force horizontal scrolling. The `overflow-x-auto` + `min-w-[*]`
		// wrappers were removed; the columns flex to fit and long cells wrap
		// gracefully on narrow viewports.
		const { container } = render(<ThresholdConfigDisplay />);
		const scrollers = container.querySelectorAll("div.overflow-x-auto");
		expect(scrollers.length).toBe(0);
		// The two tables still exist (we kept the structure), but they no
		// longer carry `min-w-[*]` constraints.
		const tables = container.querySelectorAll("table");
		expect(tables.length).toBe(2);
		for (const table of Array.from(tables)) {
			expect(table.className).not.toMatch(/min-w-\[/);
		}
	});

	it("wraps every severity pill in a tooltip explaining the level", () => {
		render(<ThresholdConfigDisplay />);
		const sev1 = screen.getAllByRole("button", {
			name: /Severity SEV-1/i,
		});
		const sev2 = screen.getAllByRole("button", {
			name: /Severity SEV-2/i,
		});
		const sev3 = screen.getAllByRole("button", {
			name: /Severity SEV-3/i,
		});
		expect(sev1.length).toBeGreaterThan(0);
		expect(sev2.length).toBeGreaterThan(0);
		expect(sev3.length).toBeGreaterThan(0);
	});

	it("places help tooltips next to the hysteresis policy definitions", () => {
		render(<ThresholdConfigDisplay />);
		for (const term of [
			/What is error-rate hysteresis\?/i,
			/What is statuspage hysteresis\?/i,
			/What is synthetic-probe hysteresis\?/i,
			/What is recovery hysteresis policy\?/i,
		]) {
			expect(
				screen.getByRole("button", { name: term }),
			).toBeInTheDocument();
		}
	});
});
