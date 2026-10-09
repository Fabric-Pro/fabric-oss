/**
 * "By ChatGPT plan" on the usage page (Fizzy #2972 FR4/AC5): a row per
 * shared account and per member's own plan for the selected range; an empty
 * state; nothing at all while ChatGPT plans are off.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	flag: true,
	usage: vi.fn(),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => state.flag,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			getChatGptPlanUsage: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["payments", "getChatGptPlanUsage", input],
					queryFn: () => state.usage(input),
				}),
			},
		},
	},
}));

import { ChatgptPlanUsageBreakdown } from "../ChatgptPlanUsageBreakdown";

function renderBreakdown(range = { periodDays: 7 }) {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<ChatgptPlanUsageBreakdown range={range} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	state.flag = true;
	state.usage.mockReset();
});

describe("ChatgptPlanUsageBreakdown", () => {
	it("shows each subscription's usage for the selected range", async () => {
		state.usage.mockResolvedValue({
			rows: [
				{
					key: "account:acc-1",
					kind: "shared",
					label: "Design team",
					detail: "pl***@example.com",
					requests: 1234,
					uncachedInputTokens: 750_000,
					cachedInputTokens: 250_000,
					outputTokens: 40_000,
					apiEquivalentCostMicroUsd: 2_500_000,
					sharePercent: 71.4,
				},
				{
					key: "member:user-1",
					kind: "member",
					label: "Avery Example",
					detail: null,
					requests: 2,
					uncachedInputTokens: 200,
					cachedInputTokens: 0,
					outputTokens: 10,
					apiEquivalentCostMicroUsd: 1,
					sharePercent: 19,
				},
			],
		});
		renderBreakdown();
		const rows = await screen.findAllByTestId("chatgpt-plan-usage-row");
		expect(state.usage).toHaveBeenCalledWith({ periodDays: 7 });
		const shared = within(rows[0] as HTMLElement);
		expect(shared.getByText("Design team")).toBeInTheDocument();
		expect(shared.getByText("pl***@example.com")).toBeInTheDocument();
		expect(rows[0]).toHaveTextContent("1,234");
		expect(rows[0]).toHaveTextContent("750K");
		expect(rows[0]).toHaveTextContent("$2.50");
		expect(rows[0]).toHaveTextContent("71.4%");
		expect(
			within(rows[1] as HTMLElement).getByText("Own plan"),
		).toBeInTheDocument();
		expect(rows[1]).toHaveTextContent("< $0.01");
	});

	it("says so when the range holds no plan usage", async () => {
		state.usage.mockResolvedValue({ rows: [] });
		renderBreakdown();
		expect(
			await screen.findByText("No ChatGPT plan usage in this period."),
		).toBeInTheDocument();
	});

	it("is absent, and asks for nothing, while ChatGPT plans are off", () => {
		state.flag = false;
		renderBreakdown();
		expect(screen.queryByTestId("chatgpt-plan-usage-breakdown")).toBeNull();
		expect(state.usage).not.toHaveBeenCalled();
	});
});
