/**
 * Unit tests for `ActiveIncidentsTable`. Covers the acceptance criteria from
 *
 *   - Both incident kinds (error-rate + integration) render in a single
 *     sorted list, newest first.
 *   - The row's Acknowledge / Resolve / Comment buttons each dispatch the
 *     correct procedure via the orpc client mock.
 *   - The sort toggle swaps to severity-first ordering.
 *
 * `useQuery` and the orpc mutation methods are mocked so the test never
 * touches the network and never has to spin up a QueryClientProvider. The
 * dialog is mocked at the boundary so we only verify which action the row
 * button fired off; the dialog itself has its own test file.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockUseQuery,
	mockAckErrorRate,
	mockResolveErrorRate,
	mockAckIntegration,
	mockResolveIntegration,
	mockAddCommentErrorRate,
	mockAddCommentIntegration,
} = vi.hoisted(() => ({
	mockUseQuery: vi.fn(),
	mockAckErrorRate: vi.fn(),
	mockResolveErrorRate: vi.fn(),
	mockAckIntegration: vi.fn(),
	mockResolveIntegration: vi.fn(),
	mockAddCommentErrorRate: vi.fn(),
	mockAddCommentIntegration: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		incidents: {
			errorRate: {
				list: vi.fn(),
				acknowledge: (input: unknown) => mockAckErrorRate(input),
				resolve: (input: unknown) => mockResolveErrorRate(input),
				addComment: (input: unknown) => mockAddCommentErrorRate(input),
			},
		},
		integrationHealth: {
			listActiveIncidents: vi.fn(),
			acknowledgeIntegrationIncident: (input: unknown) =>
				mockAckIntegration(input),
			resolveIntegrationIncident: (input: unknown) =>
				mockResolveIntegration(input),
			addComment: (input: unknown) => mockAddCommentIntegration(input),
		},
	},
}));

vi.mock("@tanstack/react-query", async () => {
	// Use a real `useMutation` shape but mocked `useQuery` so we drive the
	// data flow directly. `useQueryClient` is stubbed; the table doesn't
	// invalidate anything itself (the dialog does that).
	return {
		useQuery: (...args: unknown[]) => mockUseQuery(...args),
		useMutation: ({
			mutationFn,
			onSuccess,
			onError,
		}: {
			mutationFn: (input: unknown) => Promise<unknown>;
			onSuccess?: (data: unknown) => void;
			onError?: (err: unknown) => void;
		}) => {
			return {
				mutate: async (input: unknown) => {
					try {
						const result = await mutationFn(input);
						onSuccess?.(result);
					} catch (err) {
						onError?.(err);
					}
				},
				isPending: false,
			};
		},
		useQueryClient: () => ({
			invalidateQueries: vi.fn(),
		}),
	};
});

// `nuqs` powers the URL-backed pagination state. The test surfaces want a
// deterministic in-memory store so we can drive the current page from a
// per-test setter without touching the real history API.
const nuqsState: { page: number } = { page: 1 };
const mockSetPage = vi.fn((next: number) => {
	nuqsState.page = next;
});
vi.mock("nuqs", () => ({
	useQueryState: () => [nuqsState.page, mockSetPage] as const,
	parseAsInteger: { withDefault: () => ({}) },
}));

// Sonner toast — we don't assert on it but mocking prevents the real
// implementation from trying to mount a toaster.
vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
	},
}));

// Stub the dialog so we can observe which target / action it was opened
// with. The actual dialog logic is covered by its own test file.
const { dialogProps } = vi.hoisted(() => ({
	dialogProps: { last: null as null | Record<string, unknown> },
}));

vi.mock(
	"../../../../../modules/saas/admin/component/monitoring/IncidentAckResolveDialog",
	() => ({
		IncidentAckResolveDialog: (props: Record<string, unknown>) => {
			dialogProps.last = props;
			return null;
		},
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

import {
	ActiveIncidentsTable,
	formatRelative,
} from "../../../../../modules/saas/admin/component/monitoring/ActiveIncidentsTable";

const errorRateRow = {
	id: "e1",
	alertName: "AppErrorBudgetBurn_Critical",
	severity: "SEV1",
	status: "FIRING",
	service: "api",
	feature: "ai_generation",
	firedAt: new Date("2026-05-15T12:00:00Z").toISOString(),
};

const integrationRow = {
	id: "i1",
	providerKey: "openai",
	providerName: "OpenAI",
	severity: "SEV2",
	status: "ACKNOWLEDGED",
	detectionMethod: "STATUSPAGE_POLL",
	startedAt: new Date("2026-05-15T13:00:00Z").toISOString(),
};

function configureQueries({
	errorRate,
	integration,
}: {
	errorRate: (typeof errorRateRow)[];
	integration: (typeof integrationRow)[];
}) {
	mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
		const key = String(opts.queryKey?.[1] ?? "");
		if (key === "incidents") {
			return { data: errorRate, isLoading: false, isError: false };
		}
		if (key === "active-incidents") {
			return {
				data: { errorRate: [], integration },
				isLoading: false,
				isError: false,
			};
		}
		return { data: [], isLoading: false, isError: false };
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	dialogProps.last = null;
	nuqsState.page = 1;
});

afterEach(() => {
	mockUseQuery.mockReset();
});

describe("ActiveIncidentsTable", () => {
	it("renders the empty state when both streams are clear", () => {
		configureQueries({ errorRate: [], integration: [] });
		render(<ActiveIncidentsTable />);
		expect(
			screen.getByText(/All quiet — no active incidents/i),
		).toBeInTheDocument();
	});

	it("renders rows from both incident streams in the same list", () => {
		configureQueries({
			errorRate: [errorRateRow],
			integration: [integrationRow],
		});
		render(<ActiveIncidentsTable />);
		expect(
			screen.getByText("AppErrorBudgetBurn_Critical"),
		).toBeInTheDocument();
		expect(screen.getByText("OpenAI")).toBeInTheDocument();
		// Severity badges
		expect(screen.getByText("SEV1")).toBeInTheDocument();
		expect(screen.getByText("SEV2")).toBeInTheDocument();
		// Status badges
		expect(screen.getByText("FIRING")).toBeInTheDocument();
		expect(screen.getByText("ACKNOWLEDGED")).toBeInTheDocument();
	});

	it("opens the dialog with the acknowledge action when the Acknowledge button is clicked", () => {
		configureQueries({
			errorRate: [errorRateRow],
			integration: [],
		});
		render(<ActiveIncidentsTable />);
		const ackButton = screen.getByRole("button", {
			name: /Acknowledge AppErrorBudgetBurn_Critical/i,
		});
		fireEvent.click(ackButton);
		expect(dialogProps.last).toMatchObject({
			open: true,
			defaultAction: "acknowledge",
			target: {
				kind: "errorRate",
				incidentId: "e1",
				alertName: "AppErrorBudgetBurn_Critical",
				status: "FIRING",
			},
		});
	});

	it("opens the dialog with the resolve action for integration rows", () => {
		configureQueries({
			errorRate: [],
			integration: [integrationRow],
		});
		render(<ActiveIncidentsTable />);
		// "Resolve" was renamed to "Hide" so the SRE prose matches what
		// the button actually does — hide the alert from every admin's
		// open list. The underlying defaultAction key still says
		// `resolve` because the DB enum value is unchanged.
		const resolveBtn = screen.getByRole("button", {
			name: /Hide OpenAI for all admins/i,
		});
		fireEvent.click(resolveBtn);
		expect(dialogProps.last).toMatchObject({
			open: true,
			defaultAction: "resolve",
			target: {
				kind: "integration",
				incidentId: "i1",
				providerName: "OpenAI",
				status: "ACKNOWLEDGED",
			},
		});
	});

	it("filters out RESOLVED rows from the active list", () => {
		configureQueries({
			errorRate: [
				{
					...errorRateRow,
					status: "RESOLVED",
				},
			],
			integration: [],
		});
		render(<ActiveIncidentsTable />);
		expect(
			screen.queryByText("AppErrorBudgetBurn_Critical"),
		).not.toBeInTheDocument();
		expect(
			screen.getByText(/All quiet — no active incidents/i),
		).toBeInTheDocument();
	});

	it("disables the Acknowledge button for an already-ACK'd row", () => {
		configureQueries({
			errorRate: [],
			integration: [integrationRow],
		});
		render(<ActiveIncidentsTable />);
		const ackBtn = screen.getByRole("button", {
			name: /Acknowledge OpenAI/i,
		});
		expect(ackBtn).toBeDisabled();
	});

	it("re-sorts by severity when the Severity toggle is pressed", () => {
		configureQueries({
			errorRate: [
				{
					...errorRateRow,
					id: "old",
					severity: "SEV2",
					firedAt: new Date("2026-05-15T08:00:00Z").toISOString(),
				},
			],
			integration: [
				{
					...integrationRow,
					id: "new",
					severity: "SEV1",
					startedAt: new Date("2026-05-15T07:00:00Z").toISOString(),
				},
			],
		});
		render(<ActiveIncidentsTable />);
		// Initially "Recent" sort puts the error-rate row first (newer
		// timestamp). After clicking Severity, the SEV1 integration row
		// should come first. v2 layout is a `<ol>` of `<li>` cards, so we
		// assert on the order of list items inside the list-container.
		const listBefore = screen.getByTestId("active-incidents-list");
		const itemsBefore = within(listBefore).getAllByRole("listitem");
		expect(
			itemsBefore[0]
				?.querySelector("[data-testid]")
				?.getAttribute("data-testid"),
		).toBe("incident-row-old");

		fireEvent.click(
			screen.getByRole("button", { name: /^Severity$/, pressed: false }),
		);
		const listAfter = screen.getByTestId("active-incidents-list");
		const itemsAfter = within(listAfter).getAllByRole("listitem");
		expect(
			itemsAfter[0]
				?.querySelector("[data-testid]")
				?.getAttribute("data-testid"),
		).toBe("incident-row-new");
	});

	it("does NOT render a wide table that forces horizontal scrolling", () => {
		// Regression guard: the v1 implementation used
		// `<table className="min-w-[860px]">` inside an `overflow-x-auto`
		// wrapper, which forced narrow viewports into a horizontal scroll.
		// The v2 layout is `<ol>` / `<li>` cards — there must be no
		// `<table>` in the rendered output and no element carrying the
		// previous `min-w-[860px]` class.
		configureQueries({
			errorRate: [errorRateRow],
			integration: [integrationRow],
		});
		const { container } = render(<ActiveIncidentsTable />);
		expect(container.querySelector("table")).toBeNull();
		expect(container.querySelector(".min-w-\\[860px\\]")).toBeNull();
	});

	it("surfaces a loading message while either query is fetching", () => {
		mockUseQuery.mockReturnValue({
			data: undefined,
			isLoading: true,
			isError: false,
		});
		render(<ActiveIncidentsTable />);
		expect(
			screen.getByText(/Loading active incidents/i),
		).toBeInTheDocument();
	});

	it("surfaces an error message when either query errors", () => {
		mockUseQuery.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
		});
		render(<ActiveIncidentsTable />);
		expect(
			screen.getByText(/Failed to load incidents/i),
		).toBeInTheDocument();
	});
});

describe("ActiveIncidentsTable — pagination", () => {
	function buildErrorRateRows(count: number) {
		return Array.from({ length: count }, (_, idx) => ({
			...errorRateRow,
			id: `e-${idx + 1}`,
			alertName: `alert_${idx + 1}`,
			firedAt: new Date(
				Date.UTC(2026, 4, 15, 12, 0, 0) - idx * 60_000,
			).toISOString(),
		}));
	}

	it("renders no pagination footer when the list fits on one page", () => {
		configureQueries({
			errorRate: buildErrorRateRows(20),
			integration: [],
		});
		render(<ActiveIncidentsTable />);
		expect(
			screen.queryByTestId("active-incidents-pagination"),
		).not.toBeInTheDocument();
	});

	it("renders the pagination footer with computed counts when the list overflows", () => {
		configureQueries({
			errorRate: buildErrorRateRows(47),
			integration: [],
		});
		render(<ActiveIncidentsTable />);
		const footer = screen.getByTestId("active-incidents-pagination");
		expect(footer).toBeInTheDocument();
		// Default page size is 20 → first page should show 1–20 of 47.
		expect(footer.textContent).toMatch(/1.{1,3}20/);
		expect(footer.textContent).toMatch(/of\s+47/i);
	});

	it("renders only the requested page slice on first page", () => {
		configureQueries({
			errorRate: buildErrorRateRows(47),
			integration: [],
		});
		render(<ActiveIncidentsTable />);
		// First page should render exactly 20 rows.
		const list = screen.getByTestId("active-incidents-list");
		expect(list.querySelectorAll("li")).toHaveLength(20);
	});

	it("renders the second page slice when nuqs reports page=2", () => {
		nuqsState.page = 2;
		configureQueries({
			errorRate: buildErrorRateRows(47),
			integration: [],
		});
		render(<ActiveIncidentsTable />);
		const list = screen.getByTestId("active-incidents-list");
		// Page 2 should render rows 21–40 = 20 entries.
		expect(list.querySelectorAll("li")).toHaveLength(20);
		const footer = screen.getByTestId("active-incidents-pagination");
		expect(footer.textContent).toMatch(/21.{1,3}40/);
	});

	it("renders the partial last page when totals are not a multiple of the page size", () => {
		nuqsState.page = 3;
		configureQueries({
			errorRate: buildErrorRateRows(47),
			integration: [],
		});
		render(<ActiveIncidentsTable />);
		const list = screen.getByTestId("active-incidents-list");
		expect(list.querySelectorAll("li")).toHaveLength(7);
	});
});

describe("formatRelative", () => {
	const now = new Date("2026-05-15T12:00:00Z");

	it("formats seconds", () => {
		expect(formatRelative(new Date("2026-05-15T11:59:30Z"), now)).toBe(
			"30s ago",
		);
	});

	it("formats minutes", () => {
		expect(formatRelative(new Date("2026-05-15T11:55:00Z"), now)).toBe(
			"5m ago",
		);
	});

	it("formats hours", () => {
		expect(formatRelative(new Date("2026-05-15T09:00:00Z"), now)).toBe(
			"3h ago",
		);
	});

	it("formats days", () => {
		expect(formatRelative(new Date("2026-05-12T12:00:00Z"), now)).toBe(
			"3d ago",
		);
	});

	it("falls back to a date for distances > 30 days", () => {
		const result = formatRelative(new Date("2026-01-01T00:00:00Z"), now);
		expect(result).not.toMatch(/ago/);
	});
});
