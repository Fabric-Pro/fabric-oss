/**
 * Unit tests for `IncidentTimelineList` (admin monitoring "Incident history").
 *
 * The timeline is now SERVER-SIDE paginated + filtered. It:
 *   - pulls ONE newest-first page of merged, `kind`-tagged rows (every status
 *     incl. RESOLVED, every severity) via a SINGLE `incidents.listHistory`
 *     call that takes `{ sinceDays, status, source, page, pageSize }`,
 *   - renders all THREE streams (errorRate / integration / component),
 *   - exposes Window (30/90/365), Status, Source, and Per-page (25/50/100)
 *     filters that all drive the server query,
 *   - renders the shared `Pagination` control below the list,
 *   - resets to page 1 whenever Window / Status / Source / Per-page changes.
 *
 * `useQuery` and the orpc client are mocked so the test never touches the
 * network and never needs a QueryClientProvider. The single history query is
 * driven through `mockUseQuery` keyed off the queryKey; the lazy per-row
 * event query is given its own branch.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseQuery, mockListHistory, mockErrorRateEvents } = vi.hoisted(
	() => ({
		mockUseQuery: vi.fn(),
		mockListHistory: vi.fn(),
		mockErrorRateEvents: vi.fn(),
	}),
);

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		incidents: {
			listHistory: (input: unknown) => mockListHistory(input),
			errorRate: {
				listEvents: (input: unknown) => mockErrorRateEvents(input),
			},
			component: {
				listEvents: vi.fn(),
			},
		},
		integrationHealth: {
			listEvents: vi.fn(),
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

import { IncidentTimelineList } from "../../../../../modules/saas/admin/component/monitoring/IncidentTimelineList";

// --- normalized, `kind`-tagged rows as the server now returns them ---
const errorRateItem = {
	id: "e1",
	kind: "errorRate" as const,
	severity: "SEV1" as const,
	status: "FIRING" as const,
	alertName: "AppErrorBudgetBurn_Critical",
	service: "api",
	feature: "ai_generation",
	errorClass: null,
	startedAt: new Date("2026-05-15T12:00:00Z").toISOString(),
	resolvedAt: null,
};

// A RESOLVED integration row — the active banner hides these; the history
// timeline MUST surface them.
const integrationItem = {
	id: "i1",
	kind: "integration" as const,
	severity: "SEV2" as const,
	status: "RESOLVED" as const,
	providerName: "OpenAI",
	detectionMethod: "STATUSPAGE_POLL",
	summary: "Elevated error rates on chat completions",
	startedAt: new Date("2026-05-15T13:00:00Z").toISOString(),
	resolvedAt: new Date("2026-05-15T14:00:00Z").toISOString(),
};

// A component (internal subsystem) row — never shown by the old timeline.
const componentItem = {
	id: "c1",
	kind: "component" as const,
	severity: "SEV3" as const,
	status: "RESOLVED" as const,
	componentName: "Temporal Worker",
	summary: "Worker poll latency above threshold",
	startedAt: new Date("2026-05-15T11:00:00Z").toISOString(),
	resolvedAt: new Date("2026-05-15T11:30:00Z").toISOString(),
};

/** Capture the latest history-query input the component passed to the orpc
 * client, so assertions can read e.g. the current page/pageSize/status. */
let lastHistoryInput: Record<string, unknown> | undefined;

/**
 * Drive the single history query + the lazy per-row event query off the
 * queryKey. The history query key is
 *   ["monitoring", "timeline", "history", { ... }]
 * and the event query key is
 *   ["monitoring", "timeline", <kind>, "events", <id>].
 */
function configure(items: unknown[], total: number) {
	mockUseQuery.mockImplementation(
		(options: { queryKey: unknown[]; queryFn?: () => unknown }) => {
			const marker = String(options.queryKey?.[2] ?? "");
			if (marker === "history") {
				// Invoke the real queryFn so the test can assert the orpc call
				// args (window/page/filter refetch behaviour) via mockListHistory.
				options.queryFn?.();
				return {
					data: { items, total },
					isLoading: false,
					isError: false,
				};
			}
			// Event drill-down query.
			return { data: [], isLoading: false, isError: false };
		},
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	lastHistoryInput = undefined;
	mockListHistory.mockImplementation((input: Record<string, unknown>) => {
		lastHistoryInput = input;
		return Promise.resolve({ items: [], total: 0 });
	});
});

afterEach(() => {
	mockUseQuery.mockReset();
});

describe("IncidentTimelineList", () => {
	it("renders the 'Incident history' heading", () => {
		configure([], 0);
		render(<IncidentTimelineList />);
		expect(
			screen.getByRole("heading", { name: /Incident history/i }),
		).toBeInTheDocument();
		expect(screen.queryByText("Last 30 days")).not.toBeInTheDocument();
	});

	it("renders rows from all three streams, including RESOLVED + component", () => {
		configure([errorRateItem, integrationItem, componentItem], 3);
		render(<IncidentTimelineList />);

		// error-rate row
		expect(
			screen.getByText("AppErrorBudgetBurn_Critical"),
		).toBeInTheDocument();
		// RESOLVED integration row — proves resolved rows are not filtered out
		expect(screen.getByText("OpenAI")).toBeInTheDocument();
		// component row — proves the new third stream renders
		expect(screen.getByText("Temporal Worker")).toBeInTheDocument();
		expect(
			screen.getByText("Worker poll latency above threshold"),
		).toBeInTheDocument();
		// All three severities present
		expect(screen.getByText("SEV1")).toBeInTheDocument();
		expect(screen.getByText("SEV2")).toBeInTheDocument();
		expect(screen.getByText("SEV3")).toBeInTheDocument();

		const list = screen.getByTestId("incident-timeline-list");
		expect(within(list).getAllByRole("listitem")).toHaveLength(3);
	});

	it("renders the server order verbatim (newest-first), without re-sorting", () => {
		// Server returns i1, e1, c1 in that order; the component must NOT
		// reorder them.
		configure([integrationItem, errorRateItem, componentItem], 3);
		render(<IncidentTimelineList />);
		const list = screen.getByTestId("incident-timeline-list");
		const labels = within(list)
			.getAllByRole("listitem")
			.map(
				(li) =>
					li.querySelector("p.text-sm.font-medium")?.textContent ??
					"",
			);
		expect(labels).toEqual([
			"OpenAI",
			"AppErrorBudgetBurn_Critical",
			"Temporal Worker",
		]);
	});

	it("requests the default window/status/source/page/pageSize on first render", () => {
		configure([], 0);
		render(<IncidentTimelineList />);
		expect(mockListHistory).toHaveBeenCalledWith({
			sinceDays: 30,
			status: "all",
			source: "all",
			page: 1,
			pageSize: 25,
		});
	});

	it("refetches with the new window when a Window chip is clicked", () => {
		configure([], 0);
		render(<IncidentTimelineList />);
		mockListHistory.mockClear();

		fireEvent.click(screen.getByRole("button", { name: /90 days/i }));
		expect(lastHistoryInput).toMatchObject({ sinceDays: 90, page: 1 });

		fireEvent.click(screen.getByRole("button", { name: /365 days/i }));
		expect(lastHistoryInput).toMatchObject({ sinceDays: 365, page: 1 });
	});

	it("reflects the selected window in the copy", () => {
		configure([], 0);
		render(<IncidentTimelineList />);
		const intro = screen
			.getByText(/active and hidden alerts across/i)
			.closest("p") as HTMLElement;
		expect(intro.textContent).toMatch(/Last 30 days/i);
		fireEvent.click(screen.getByRole("button", { name: /90 days/i }));
		expect(intro.textContent).toMatch(/Last 90 days/i);
	});

	it("sends the Source facet to the server (does not filter client-side)", () => {
		// The server is the single source of truth now: clicking Component must
		// re-issue the query with source=component (NOT slice the rows locally).
		configure([componentItem], 1);
		render(<IncidentTimelineList />);

		fireEvent.click(
			screen.getByRole("button", {
				name: /^Component$/i,
				pressed: false,
			}),
		);
		expect(lastHistoryInput).toMatchObject({
			source: "component",
			page: 1,
		});
	});

	it("sends the Status facet to the server when 'History (hidden)' is clicked", () => {
		configure([integrationItem, componentItem], 2);
		render(<IncidentTimelineList />);

		fireEvent.click(
			screen.getByRole("button", { name: /History \(hidden\)/i }),
		);
		expect(lastHistoryInput).toMatchObject({
			status: "hidden",
			page: 1,
		});
	});

	it("renders the Per-page selector and changes pageSize on click", () => {
		configure([], 0);
		render(<IncidentTimelineList />);

		// All three options render under the "Per page" group.
		const group = screen.getByRole("group", {
			name: /Incidents per page/i,
		});
		expect(
			within(group).getByRole("button", { name: "25" }),
		).toBeInTheDocument();
		expect(
			within(group).getByRole("button", { name: "50" }),
		).toBeInTheDocument();
		expect(
			within(group).getByRole("button", { name: "100" }),
		).toBeInTheDocument();

		fireEvent.click(within(group).getByRole("button", { name: "50" }));
		expect(lastHistoryInput).toMatchObject({ pageSize: 50, page: 1 });
	});

	it("renders the Pagination control reflecting total + pageSize", () => {
		// total 60, pageSize 25 → "1 - 25 of 60".
		configure([errorRateItem], 60);
		render(<IncidentTimelineList />);
		expect(screen.getByText(/1\s*-\s*25 of 60/)).toBeInTheDocument();
	});

	/** Locate the pager's enabled "next" button by scoping to the pager
	 * container (found via its "{start} - {end} of {total}" label) and taking
	 * the trailing enabled icon button. Avoids colliding with the collapse
	 * chevrons inside the timeline rows. */
	function getPagerNext(total: number): HTMLButtonElement {
		const label = screen.getByText(new RegExp(`-\\s*\\d+ of ${total}`));
		const pager = label.parentElement as HTMLElement;
		const buttons = within(pager).getAllByRole("button");
		// prev (disabled on page 1) then next.
		const next = buttons[buttons.length - 1] as HTMLButtonElement;
		return next;
	}

	it("advances the page via Pagination Next and requests page 2", () => {
		configure([errorRateItem], 60);
		render(<IncidentTimelineList />);
		mockListHistory.mockClear();

		fireEvent.click(getPagerNext(60));
		expect(lastHistoryInput).toMatchObject({ page: 2 });
	});

	it("resets to page 1 when the window changes after paging forward", () => {
		configure([errorRateItem], 200);
		render(<IncidentTimelineList />);

		// Page forward first.
		fireEvent.click(getPagerNext(200));
		expect(lastHistoryInput).toMatchObject({ page: 2 });

		// Now change the window → page must snap back to 1.
		fireEvent.click(screen.getByRole("button", { name: /90 days/i }));
		expect(lastHistoryInput).toMatchObject({ sinceDays: 90, page: 1 });
	});

	it("expands a row and fetches its event history (error-rate branch)", () => {
		configure([errorRateItem], 1);
		render(<IncidentTimelineList />);
		// The whole row is the expand toggle.
		const toggle = screen.getByRole("button", { expanded: false });
		fireEvent.click(toggle);
		// The event query mounted (a useQuery call carrying an "events" key).
		const sawEventQuery = mockUseQuery.mock.calls.some(
			(call) =>
				String((call[0] as { queryKey?: unknown[] }).queryKey?.[3]) ===
				"events",
		);
		expect(sawEventQuery).toBe(true);
	});

	it("shows the loading state while the history query is fetching", () => {
		mockUseQuery.mockReturnValue({
			data: undefined,
			isLoading: true,
			isError: false,
		});
		render(<IncidentTimelineList />);
		expect(screen.getByText(/Loading timeline/i)).toBeInTheDocument();
	});

	it("shows the error state when the history query errors", () => {
		mockUseQuery.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
		});
		render(<IncidentTimelineList />);
		expect(
			screen.getByText(/Failed to load timeline/i),
		).toBeInTheDocument();
	});
});
