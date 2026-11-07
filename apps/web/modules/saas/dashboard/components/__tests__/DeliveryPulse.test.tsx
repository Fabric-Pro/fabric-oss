import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DeliveryInsightsResult } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("recharts", () => {
	const Container = ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	);
	return {
		ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => (
			<div data-testid="responsive-chart">{children}</div>
		),
		LineChart: Container,
		CartesianGrid: () => null,
		Legend: () => null,
		Line: () => null,
		Tooltip: () => null,
		XAxis: () => null,
		YAxis: () => null,
	};
});

import { DeliveryPulse } from "../DeliveryPulse";

const data: DeliveryInsightsResult = {
	hasData: true,
	timeline: [
		{ date: "2026-11-04", scope: 2, ready: 0 },
		{ date: "2026-11-05", scope: 3, ready: 1 },
	],
	flow: [
		{ stage: "drafting", count: 1 },
		{ stage: "sanityCheck", count: 0 },
		{ stage: "readyForDev", count: 1 },
		{ stage: "implementing", count: 1 },
		{ stage: "review", count: 2 },
		{ stage: "blocked", count: 1 },
	],
	agentOutcomes: [
		{ status: "active", count: 1 },
		{ status: "completed", count: 4 },
		{ status: "review", count: 2 },
		{ status: "failed", count: 1 },
		{ status: "cancelled", count: 0 },
	],
	summary: {
		createdInRange: 2,
		readyInRange: 3,
		previousReady: 1,
		medianReadyDays: 2.4,
		readyDurationSamples: 3,
		runsNeedingAttention: 3,
		reviewRuns: 2,
		failedRuns: 1,
	},
	generatedAt: new Date("2026-11-05T12:00:00.000Z"),
};

function renderPulse(
	overrides: Partial<Parameters<typeof DeliveryPulse>[0]> = {},
) {
	const props = {
		data,
		loading: false,
		error: false,
		range: 30 as const,
		onRangeChange: vi.fn(),
		onStageChange: vi.fn(),
		onRetry: vi.fn(),
		...overrides,
	};
	render(<DeliveryPulse {...props} />);
	return props;
}

describe("DeliveryPulse", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders real metrics and a deterministic briefing", () => {
		renderPulse();

		expect(
			screen.getByRole("heading", { name: "Delivery pulse" }),
		).toBeInTheDocument();
		expect(screen.getByText("2.4d")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Readiness increased from 1 to 3 features compared with the previous period.",
			),
		).toBeInTheDocument();
		expect(screen.getByText("View chart data")).toBeInTheDocument();
		expect(
			screen.getByTestId("responsive-chart").parentElement,
		).toHaveClass("min-h-64", "flex-1");
	});

	it("selects flow stages and changes the date range", async () => {
		const user = userEvent.setup();
		const props = renderPulse();

		await user.click(
			screen.getByRole("button", { name: "Show Review features: 2" }),
		);
		expect(props.onStageChange).toHaveBeenCalledWith("review");

		await user.click(screen.getByRole("button", { name: "7 days" }));
		expect(props.onRangeChange).toHaveBeenCalledWith(7);
	});

	it("hides when there is no delivery data", () => {
		renderPulse({ data: { ...data, hasData: false } });
		expect(
			screen.queryByRole("heading", { name: "Delivery pulse" }),
		).not.toBeInTheDocument();
	});

	it("offers an independent retry when insights fail", async () => {
		const user = userEvent.setup();
		const props = renderPulse({ data: undefined, error: true });
		await user.click(
			screen.getByRole("button", { name: "Retry insights" }),
		);
		expect(props.onRetry).toHaveBeenCalledOnce();
	});
});
