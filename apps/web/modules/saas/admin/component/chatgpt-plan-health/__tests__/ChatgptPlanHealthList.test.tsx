import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const list = vi.hoisted(() => ({ queryFn: vi.fn() }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		admin: {
			chatgptPlanHealth: {
				list: {
					queryOptions: () => ({
						queryKey: [["admin", "chatgptPlanHealth", "list"], {}],
						queryFn: () => list.queryFn(),
					}),
				},
			},
		},
	},
}));

import { ChatgptPlanHealthList } from "../ChatgptPlanHealthList";

const account = (overrides = {}) => ({
	id: "acc_1",
	organizationId: "org_a",
	organizationName: "Example A",
	label: "Design plan",
	maskedEmail: "de***@example.com",
	status: "ACTIVE",
	enabled: true,
	windowPercent: 42,
	windowPercentSource: "estimated",
	estimatedPercent: 42,
	reported: null,
	accuracy: {
		refusalEstimatePercents: [],
		windowsOverBudgetWithoutRefusal: 0,
		settledWindows: 0,
		latestReported: null,
		maxDriftPoints: null,
	},
	resetsAt: new Date("2026-10-08T15:00:00Z"),
	coolingUntil: null,
	lastExhaustedAt: null,
	budget: 1_200_000,
	budgetCalibrated: true,
	tier: "PLUS",
	subscriptionActiveUntil: new Date("2026-11-08T00:00:00Z"),
	...overrides,
});

function renderList() {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<ChatgptPlanHealthList />
		</QueryClientProvider>,
	);
}

describe("ChatgptPlanHealthList (Fizzy #2770 D6)", () => {
	it("lists every organization's accounts with status, window and budget", async () => {
		list.queryFn.mockResolvedValue({
			accounts: [
				account(),
				account({
					id: "acc_2",
					organizationName: "Example B",
					label: "Ops plan",
					status: "NEEDS_RECONNECT",
					windowPercent: 0,
					budget: 2_000_000,
					budgetCalibrated: false,
				}),
			],
		});
		renderList();
		const rows = await screen.findAllByTestId("chatgpt-plan-health-row");
		expect(rows).toHaveLength(2);
		const first = within(rows[0] as HTMLElement);
		expect(first.getByText("Example A")).toBeInTheDocument();
		expect(first.getByText("de***@example.com")).toBeInTheDocument();
		expect(first.getByText("Active")).toBeInTheDocument();
		expect(first.getByText("42%")).toBeInTheDocument();
		// Fizzy #2770 G7: the tier and paid-until date from the sign-in.
		expect(first.getByText("Plus")).toBeInTheDocument();
		expect(rows[0]).toHaveTextContent(
			new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
				new Date("2026-11-08T00:00:00Z"),
			),
		);
		// "2M tokens", never a bare "2m" that reads as minutes.
		expect(rows[0]).toHaveTextContent("1.2M tokens · calibrated");
		const second = within(rows[1] as HTMLElement);
		expect(second.getByText("Needs reconnect")).toBeInTheDocument();
		expect(rows[1]).toHaveTextContent("2M tokens · default");
	});

	it("marks a window ChatGPT reported, and shows how accurate the estimate was", async () => {
		list.queryFn.mockResolvedValue({
			accounts: [
				account({
					windowPercent: 48,
					windowPercentSource: "reported",
					estimatedPercent: 100,
					accuracy: {
						refusalEstimatePercents: [64.4, 91],
						windowsOverBudgetWithoutRefusal: 2,
						settledWindows: 9,
						latestReported: {
							estimatePercent: 100,
							reportedPercent: 48,
						},
						maxDriftPoints: 52,
					},
				}),
			],
		});
		renderList();
		const [row] = await screen.findAllByTestId("chatgpt-plan-health-row");
		const cells = within(row as HTMLElement);
		expect(
			cells.getByTestId("chatgpt-plan-health-source"),
		).toHaveTextContent("reported by ChatGPT · estimate 100%");
		const accuracy = cells.getByTestId("chatgpt-plan-health-accuracy");
		expect(accuracy).toHaveTextContent("Refused at: 64%, 91%");
		expect(accuracy).toHaveTextContent(
			"Over 100% without refusal: 2 of 9 windows",
		);
		expect(accuracy).toHaveTextContent(
			"estimate 100% · reported 48% · max gap 52 pts",
		);
	});

	it("says an estimated window is an estimate", async () => {
		list.queryFn.mockResolvedValue({ accounts: [account()] });
		renderList();
		expect(
			await screen.findByTestId("chatgpt-plan-health-source"),
		).toHaveTextContent("estimated");
	});

	it("says so when no organization has a shared account", async () => {
		list.queryFn.mockResolvedValue({ accounts: [] });
		renderList();
		expect(
			await screen.findByText(
				"No organization has connected a shared ChatGPT plan account.",
			),
		).toBeInTheDocument();
	});
});
