/**
 * Regression coverage for the integration into
 * `AiUsageActivityView`:
 * 1. The new `<AiUsageLimitsCard />` mounts above the period-selector
 * tablist when the user can read the page (org admin / personal
 * context). DOM order is asserted via `compareDocumentPosition` so
 * a future re-shuffle of the layout is caught.
 * 2. The card does NOT render when the existing forbidden-card branch
 * fires (org members below admin — in tasks.md).
 * 3. The recharts `ReferenceLine` overlay only paints when the
 * selected period matches a limit's window AND the chart's metric
 * matches the limit's dimension. Verified with the
 * default `30d` period + `cost` chartMetric → MONTHLY/SPEND_USD
 * limit produces an overlay; same period + a HOURLY/TOKENS limit
 * produces none.
 * The component is ~3500 lines and pulls in oRPC, recharts, and
 * date-fns — we mock at the module boundary instead of mounting the
 * full TanStack Query / Next router providers. Only the surface this
 * task introduces is exercised here; the parent-component's existing
 * activity-table behaviour is covered by Playwright e2e.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks --------------------------------------------------------------

// Stub the full child card — the integration test only needs to know
// that the card is mounted at the right slot. Card-level behaviour is
// covered by `AiUsageLimitsCard.test.tsx`.
vi.mock("../AiUsageLimitsCard", () => ({
	AiUsageLimitsCard: ({
		organizationId,
		canManage,
	}: {
		organizationId?: string;
		canManage: boolean;
	}) => (
		<div
			data-testid="ai-usage-limits-card"
			data-org-id={organizationId ?? ""}
			data-can-manage={String(canManage)}
		/>
	),
}));

// Hook mock — return a controllable value per test. The view reads
// `data?.canManage` for the card prop and `data?.limits` for the
// recharts overlay.
const useAiUsageLimitsMock = vi.fn();
vi.mock("@saas/payments/hooks/useAiUsageLimits", async () => {
	const actual = await vi.importActual<
		typeof import("@saas/payments/hooks/useAiUsageLimits")
	>("@saas/payments/hooks/useAiUsageLimits");
	return {
		...actual,
		useAiUsageLimits: (...args: unknown[]) =>
			useAiUsageLimitsMock(...args) ?? {
				data: undefined,
				isLoading: false,
				isError: false,
				error: null,
			},
	};
});

// TanStack Query — the view runs three `useQuery(..)` calls (activity,
// facets, time-series) plus the `useAiUsageLimits` hook above. Returning
// a quiet "no data, no error" state for them keeps the render fast and
// deterministic. `keepPreviousData` is preserved as the actual export
// because the parent imports it directly.
const useQueryMock = vi.fn();
vi.mock("@tanstack/react-query", async () => {
	const actual = await vi.importActual<
		typeof import("@tanstack/react-query")
	>("@tanstack/react-query");
	return {
		...actual,
		useQuery: (...args: unknown[]) => useQueryMock(...args),
	};
});

// Recharts — bypass `ResponsiveContainer` and `AreaChart` (both refuse
// to walk their children in jsdom because the layout has 0 dimensions —
// known recharts behaviour) so the overlay block executes against the
// real `limitOverlays` value. Replace `ReferenceLine` with a simple
// recognisable stub we can `getAllByTestId(..)`. Other primitives stay
// as no-op pass-throughs to avoid SVG measurement errors.
vi.mock("recharts", async () => {
	const actual = await vi.importActual<typeof import("recharts")>("recharts");
	const PassThrough = ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	);
	return {
		...actual,
		ResponsiveContainer: PassThrough,
		AreaChart: PassThrough,
		Area: () => null,
		CartesianGrid: () => null,
		XAxis: () => null,
		YAxis: () => null,
		Tooltip: () => null,
		ReferenceArea: () => null,
		ReferenceLine: ({ y }: { y: number | string }) => (
			<div data-testid="recharts-reference-line" data-y={String(y)} />
		),
	};
});

// orpc-query-utils — the parent imports `orpc.payments.*.queryOptions`
// to build the `useQuery` argument. Returning an empty object is fine
// because our `useQueryMock` above doesn't read the input.
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: new Proxy(
		{},
		{
			get: () =>
				new Proxy(
					{},
					{
						get: () =>
							new Proxy(
								{},
								{
									get:
										() =>
										(..._args: unknown[]) => ({
											queryKey: [],
											queryFn: () =>
												Promise.resolve(null),
										}),
								},
							),
					},
				),
		},
	),
}));

// orpc-client — only used by the export CSV path which the test never
// triggers; stub it so the module resolves.
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: new Proxy(
		{},
		{
			get: () =>
				new Proxy(
					{},
					{
						get: () =>
							new Proxy(
								{},
								{ get: () => () => Promise.resolve({}) },
							),
					},
				),
		},
	),
}));

// jsdom polyfills the chart needs for ResizeObserver / pointer capture.
class ResizeObserverMock {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;

HTMLElement.prototype.hasPointerCapture ??= () => false;
HTMLElement.prototype.setPointerCapture ??= () => {};
HTMLElement.prototype.releasePointerCapture ??= () => {};
HTMLElement.prototype.scrollIntoView ??= () => {};

import { AiUsageActivityView } from "../AiUsageActivityView";

// ---- Fixtures ----------------------------------------------------------

const MONTHLY_SPEND_LIMIT = {
	id: "limit-monthly-spend",
	organizationId: null,
	userId: "user-1",
	name: "Monthly spend cap",
	providerConfigId: null,
	modelCanonicalName: null,
	taskType: null,
	dimension: "SPEND_USD" as const,
	window: "MONTHLY" as const,
	// 100 USD stored as micro-USD = 100 * 1_000_000.
	maxValue: (BigInt(100) * BigInt(1_000_000)).toString(),
	enforcement: "HARD" as const,
	createdById: "user-1",
	createdAt: new Date("2026-05-14T00:00:00Z").toISOString(),
};

const HOURLY_TOKENS_LIMIT = {
	id: "limit-hourly-tokens",
	organizationId: null,
	userId: "user-1",
	name: "Hourly burst cap",
	providerConfigId: null,
	modelCanonicalName: null,
	taskType: null,
	dimension: "TOKENS" as const,
	window: "HOURLY" as const,
	maxValue: "50000",
	enforcement: "SOFT" as const,
	createdById: "user-1",
	createdAt: new Date("2026-05-14T00:00:00Z").toISOString(),
};

function setLimits(
	limits: Array<typeof MONTHLY_SPEND_LIMIT | typeof HOURLY_TOKENS_LIMIT>,
	canManage = true,
) {
	useAiUsageLimitsMock.mockReturnValue({
		data: { limits, canManage },
		isLoading: false,
		isError: false,
		error: null,
	});
}

function setQuiet() {
	// `isPending` is what the chart-loading gate reads (line 3136 of the
	// view); `isLoading` covers the top-level activity / facets queries.
	// Returning both flags as false keeps the JSX walking past every
	// loading short-circuit and into the recharts overlay block.
	useQueryMock.mockReturnValue({
		data: undefined,
		isLoading: false,
		isPending: false,
		isError: false,
		error: null,
	});
}

function setForbidden() {
	useQueryMock.mockReturnValue({
		data: undefined,
		isLoading: false,
		isError: true,
		error: { code: "FORBIDDEN", message: "FORBIDDEN" },
	});
}

beforeEach(() => {
	useAiUsageLimitsMock.mockReset();
	useQueryMock.mockReset();
});

afterEach(() => {
	vi.clearAllMocks();
});

// ---- Tests --------------------------------------------------------------

describe("AiUsageActivityView — limits integration", () => {
	it("mounts AiUsageLimitsCard above the period-selector tablist (personal context)", () => {
		setLimits([], /* canManage */ true);
		setQuiet();

		render(<AiUsageActivityView />);

		const card = screen.getByTestId("ai-usage-limits-card");
		expect(card).toBeInTheDocument();
		expect(card.dataset.canManage).toBe("true");

		const tablist = screen.getByRole("tablist", { name: "Time period" });
		expect(tablist).toBeInTheDocument();

		// DOM order: card precedes tablist. `compareDocumentPosition`
		// returns DOCUMENT_POSITION_FOLLOWING (4) when `card` is the
		// reference and `tablist` follows it.
		const followingMask = Node.DOCUMENT_POSITION_FOLLOWING;
		expect(card.compareDocumentPosition(tablist) & followingMask).toBe(
			followingMask,
		);
	});

	it("forwards the organisation id and the canManage gate to the card", () => {
		setLimits([], /* canManage */ false);
		setQuiet();

		render(<AiUsageActivityView organizationId="org-42" />);

		const card = screen.getByTestId("ai-usage-limits-card");
		expect(card.dataset.orgId).toBe("org-42");
		expect(card.dataset.canManage).toBe("false");
	});

	it("does NOT render the card on the forbidden branch (org member)", () => {
		setLimits([], /* canManage */ false);
		setForbidden();

		render(
			<AiUsageActivityView
				organizationId="org-42"
				organizationName="Acme"
			/>,
		);

		// The forbidden destructive surface must show…
		expect(
			screen.getByText(/don't have access to this organization/i),
		).toBeInTheDocument();
		// …and the new limits card must NOT be reached.
		expect(
			screen.queryByTestId("ai-usage-limits-card"),
		).not.toBeInTheDocument();
		// Period-selector tablist also short-circuited on this branch.
		expect(
			screen.queryByRole("tablist", { name: "Time period" }),
		).not.toBeInTheDocument();
	});

	it("renders a recharts ReferenceLine when the selected period + chart metric match a limit", () => {
		// Default state: period="30d", chartMetric="cost".
		// MONTHLY + SPEND_USD limit ⇒ should overlay one ReferenceLine.
		setLimits([MONTHLY_SPEND_LIMIT], /* canManage */ true);
		setQuiet();

		render(<AiUsageActivityView />);

		const lines = screen.getAllByTestId("recharts-reference-line");
		expect(lines).toHaveLength(1);
		// Y axis for `cost` plots USD = micro-USD / 1_000_000 → 100.
		expect(lines[0]?.dataset.y).toBe("100");
	});

	it("renders no ReferenceLine when no limit's window matches the period", () => {
		// Default period 30d → MONTHLY window is the only match for cost.
		// An HOURLY/TOKENS limit alone produces no overlay regardless of
		// the chart metric (TOKENS ≠ default `cost` dimension AND HOURLY
		// ≠ MONTHLY).
		setLimits([HOURLY_TOKENS_LIMIT], /* canManage */ true);
		setQuiet();

		render(<AiUsageActivityView />);

		expect(screen.queryAllByTestId("recharts-reference-line")).toHaveLength(
			0,
		);
	});
});
