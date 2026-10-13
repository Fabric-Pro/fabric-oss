/**
 * React #418 (hydration text mismatch) on the AI usage page: the period
 * header printed the viewer's short timezone name ("GMT+9", "EEST") on the
 * first render. The server resolves that name in its own zone, the browser
 * in the viewer's, so the two markups differed for everyone outside the
 * server's zone. The server markup must not depend on the zone; the browser
 * shows the real name once it has hydrated.
 */
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ChatgptPlanUsageBreakdown", () => ({
	ChatgptPlanUsageBreakdown: () => null,
}));

vi.mock("../AiUsageLimitsCard", () => ({
	AiUsageLimitsCard: () => null,
}));

vi.mock("@saas/payments/hooks/useAiUsageLimits", async () => {
	const actual = await vi.importActual<
		typeof import("@saas/payments/hooks/useAiUsageLimits")
	>("@saas/payments/hooks/useAiUsageLimits");
	return {
		...actual,
		useAiUsageLimits: () => ({
			data: { limits: [], canManage: false },
			isLoading: false,
			isError: false,
			error: null,
		}),
	};
});

vi.mock("@tanstack/react-query", async () => {
	const actual = await vi.importActual<
		typeof import("@tanstack/react-query")
	>("@tanstack/react-query");
	return {
		...actual,
		useQuery: () => ({
			data: undefined,
			isLoading: true,
			isPending: true,
			isError: false,
			error: null,
		}),
	};
});

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
		ReferenceLine: () => null,
	};
});

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: new Proxy(
		{},
		{
			get: () =>
				new Proxy(
					{},
					{ get: () => ({ queryOptions: () => ({ queryKey: [] }) }) },
				),
		},
	),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {},
}));

class ResizeObserverMock {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;

import { AiUsageActivityView } from "../AiUsageActivityView";

const VIEWER_ZONE = "GMT+9";

beforeEach(() => {
	vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockReturnValue([
		{ type: "timeZoneName", value: VIEWER_ZONE },
	]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AiUsageActivityView — hydration", () => {
	it("renders server markup that does not depend on the timezone", () => {
		const html = renderToString(
			<AiUsageActivityView organizationId="org-1" />,
		);

		expect(html).not.toContain(VIEWER_ZONE);
		expect(html).toContain("Local");
	});

	it("shows the viewer's timezone once mounted in the browser", () => {
		render(<AiUsageActivityView organizationId="org-1" />);

		expect(screen.getByText(VIEWER_ZONE)).toBeInTheDocument();
	});
});
