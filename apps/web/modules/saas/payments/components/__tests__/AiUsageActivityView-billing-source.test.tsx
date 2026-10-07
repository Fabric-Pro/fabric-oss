/**
 * Billing source coverage for `AiUsageActivityView`: the "Billing source"
 * filter reaches the list, chart and pagination inputs, the plan vs API
 * split summary renders from `totals.bySource`, and plan rows read as
 * "ChatGPT plan" with an explicit "On plan" note beside their $0 cost.
 *
 * Mocks follow `AiUsageActivityView-limits-integration.test.tsx`, except the
 * orpc stub keeps each procedure's path and input so the test can tell the
 * three queries apart and see what was sent.
 */
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../AiUsageLimitsCard", () => ({
	AiUsageLimitsCard: () => <div data-testid="ai-usage-limits-card" />,
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

type QueryOptions = { queryKey: [string, Record<string, unknown>] };

const useQueryMock = vi.fn();
vi.mock("@tanstack/react-query", async () => {
	const actual = await vi.importActual<
		typeof import("@tanstack/react-query")
	>("@tanstack/react-query");
	return {
		...actual,
		useQuery: (options: QueryOptions) => useQueryMock(options),
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
			get: (_root, namespace: string) =>
				new Proxy(
					{},
					{
						get: (_ns, procedure: string) => ({
							queryOptions: (opts: { input: unknown }) => ({
								queryKey: [
									`${namespace}.${procedure}`,
									opts.input,
								],
							}),
						}),
					},
				),
		},
	),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: new Proxy(
		{},
		{
			get: () =>
				new Proxy(
					{},
					{ get: () => () => Promise.resolve({ rows: [] }) },
				),
		},
	),
}));

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

const BASE_ROW = {
	createdAt: "2026-09-20T10:00:00.000Z",
	userId: "user-1",
	userName: "Dev Example",
	userEmail: "dev@example.com",
	modelCanonicalName: null,
	taskType: "CHAT",
	agentId: null,
	conversationId: null,
	jobType: null,
	projectId: null,
	projectName: null,
	inputTokens: 100,
	outputTokens: 50,
	totalTokens: 150,
	latencyMs: 800,
	success: true,
	errorMessage: null,
};

const LIST_DATA = {
	rows: [
		{
			...BASE_ROW,
			id: "row-plan",
			provider: "OPENAI_CHATGPT_PLAN",
			providerModelId: "gpt-6-astra",
			costMicroUsd: 0,
		},
		{
			...BASE_ROW,
			id: "row-api",
			provider: "OPENAI_DIRECT",
			providerModelId: "gpt-4.1",
			costMicroUsd: 2_500_000,
		},
	],
	nextCursor: null,
	periodDays: 30,
	totals: {
		requests: 12,
		inputTokens: 9_000,
		outputTokens: 3_000,
		totalTokens: 12_000,
		costMicroUsd: 2_500_000,
		avgLatencyMs: 640,
		bySource: {
			chatgpt_plan: {
				requests: 9,
				inputTokens: 6_000,
				outputTokens: 1_500,
				totalTokens: 7_500,
				costMicroUsd: 0,
			},
			api: {
				requests: 3,
				inputTokens: 3_000,
				outputTokens: 1_500,
				totalTokens: 4_500,
				costMicroUsd: 2_500_000,
			},
		},
	},
	chatGptPlanApiEstimate: {
		estimatedApiCostMicroUsd: 15_000_000,
		referenceModels: ["gpt-6-astra"],
	},
};

function facetsData(planRequests: number) {
	return {
		models: [],
		projects: [],
		users: [],
		billingSources: [
			{ value: "chatgpt_plan", requests: planRequests },
			{ value: "api", requests: 3 },
		],
	};
}

function mockQueries({ planRequests = 9 }: { planRequests?: number } = {}) {
	useQueryMock.mockImplementation((options: QueryOptions) => {
		const [path] = options.queryKey;
		const data =
			path === "payments.listAiActivity"
				? LIST_DATA
				: path === "payments.getAiActivityFacets"
					? facetsData(planRequests)
					: path === "payments.getAiActivityTimeSeries"
						? { points: [] }
						: undefined;
		return {
			data,
			isLoading: false,
			isPending: false,
			isError: false,
			error: null,
		};
	});
}

function lastInputFor(path: string): Record<string, unknown> | undefined {
	const calls = useQueryMock.mock.calls
		.map(([options]) => (options as QueryOptions).queryKey)
		.filter(([callPath]) => callPath === path);
	return calls[calls.length - 1]?.[1];
}

beforeEach(() => {
	useQueryMock.mockReset();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("AiUsageActivityView — billing source", () => {
	it("sends no billing source until one is chosen, then sends it to the list and the chart", async () => {
		mockQueries();
		render(<AiUsageActivityView organizationId="org-1" />);

		expect(
			lastInputFor("payments.listAiActivity")?.billingSource,
		).toBeUndefined();

		const user = userEvent.setup();
		await user.click(
			screen.getByRole("combobox", { name: "Filter by billing source" }),
		);
		await user.click(await screen.findByRole("option", { name: "API" }));

		await waitFor(() => {
			expect(lastInputFor("payments.listAiActivity")).toMatchObject({
				organizationId: "org-1",
				billingSource: "api",
			});
		});
		expect(
			lastInputFor("payments.getAiActivityTimeSeries")?.billingSource,
		).toBe("api");
		expect(screen.getByText("Reset all filters")).toBeInTheDocument();
	});

	it("summarises requests, tokens and cost per billing source", () => {
		mockQueries();
		render(<AiUsageActivityView organizationId="org-1" />);

		const summary = screen.getByRole("region", {
			name: "Usage by billing source",
		});
		const plan = within(
			within(summary).getByTestId("billing-source-chatgpt_plan"),
		);
		expect(plan.getByText("9")).toBeInTheDocument();
		expect(
			plan.getByTestId("billing-source-chatgpt_plan-tokens"),
		).toHaveTextContent("6.0k in · 1.5k out");
		expect(plan.getByText("$0.00")).toBeInTheDocument();
		expect(plan.getByText(/75% of requests/)).toBeInTheDocument();
		// The real cost stays $0.00; beside it, what the same tokens would
		// have cost on API billing, struck through.
		const estimate = plan.getByTestId("billing-source-plan-api-estimate");
		expect(estimate.querySelector("s")).toHaveTextContent("$15.00");
		expect(screen.queryByText(/on API billing \(estimate/)).toBeNull();

		const api = within(within(summary).getByTestId("billing-source-api"));
		expect(api.getByText("3")).toBeInTheDocument();
		expect(api.getByTestId("billing-source-api-tokens")).toHaveTextContent(
			"3.0k in · 1.5k out",
		);
		expect(api.getByText("$2.50")).toBeInTheDocument();
		expect(api.queryByRole("button")).toBeNull();
	});

	it("hides the split when nobody used a ChatGPT plan in the window", () => {
		mockQueries({ planRequests: 0 });
		render(<AiUsageActivityView organizationId="org-1" />);

		expect(
			screen.queryByRole("region", { name: "Usage by billing source" }),
		).not.toBeInTheDocument();
		// The filter itself stays available, like every other filter.
		expect(
			screen.getByRole("combobox", { name: "Filter by billing source" }),
		).toBeInTheDocument();
	});

	it("labels plan rows as ChatGPT plan and marks their $0 cost", () => {
		mockQueries();
		render(<AiUsageActivityView organizationId="org-1" />);

		expect(screen.getAllByText("ChatGPT plan").length).toBeGreaterThan(0);
		expect(
			screen.queryByText("OPENAI_CHATGPT_PLAN"),
		).not.toBeInTheDocument();
		expect(screen.getAllByText("On plan")).toHaveLength(1);
		expect(screen.getByText("OPENAI_DIRECT")).toBeInTheDocument();
	});
});

describe("AiUsageActivityView — cost covered by ChatGPT plans (Fizzy #2939)", () => {
	const TOOLTIP =
		"Covered by members' ChatGPT plans, so nothing was billed. At the provider's API list prices these tokens would have cost about $15.00 (estimate, priced as gpt-6-astra).";

	it("explains the struck-through estimate on focus", async () => {
		mockQueries();
		render(<AiUsageActivityView organizationId="org-1" />);

		fireEvent.focus(screen.getByTestId("billing-source-plan-api-estimate"));

		expect((await screen.findAllByText(TOOLTIP)).length).toBeGreaterThan(0);
	});

	it("keeps the total cost to what was billed, with plan usage on a secondary line", async () => {
		mockQueries();
		render(<AiUsageActivityView organizationId="org-1" />);

		// Billed: API only, unchanged.
		const totalCost = screen
			.getByRole("button", { name: "Total cost details" })
			.closest("[role='button']") as HTMLElement;
		expect(within(totalCost).getByText("$2.50")).toBeInTheDocument();
		const footnote = screen.getByTestId("total-cost-plan-covered");
		expect(footnote).toHaveTextContent("+ $15.00 covered by ChatGPT plans");

		fireEvent.focus(footnote);
		expect((await screen.findAllByText(TOOLTIP)).length).toBeGreaterThan(0);
	});

	it("adds no secondary line when nobody used a plan", () => {
		mockQueries({ planRequests: 0 });
		useQueryMock.mockImplementation((options: QueryOptions) => {
			const [path] = options.queryKey;
			const data =
				path === "payments.listAiActivity"
					? {
							...LIST_DATA,
							totals: {
								...LIST_DATA.totals,
								bySource: {
									...LIST_DATA.totals.bySource,
									chatgpt_plan: {
										...LIST_DATA.totals.bySource
											.chatgpt_plan,
										requests: 0,
									},
								},
							},
						}
					: path === "payments.getAiActivityFacets"
						? facetsData(0)
						: path === "payments.getAiActivityTimeSeries"
							? { points: [] }
							: undefined;
			return {
				data,
				isLoading: false,
				isPending: false,
				isError: false,
				error: null,
			};
		});
		render(<AiUsageActivityView organizationId="org-1" />);

		expect(screen.queryByTestId("total-cost-plan-covered")).toBeNull();
	});
});
