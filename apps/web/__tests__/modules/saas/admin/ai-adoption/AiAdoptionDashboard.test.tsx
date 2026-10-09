/**
 * Tests for the instance-admin AiAdoptionDashboard client component
 * (Fizzy #2230, Phase 0). Coverage: populated payload renders the
 * acceptance tiles, composition labels, and usage tiles; the empty payload
 * shows the zero states; the period switcher refetches with the new day
 * count; low-sample decisions surface the caution badge; the ChatGPT plan
 * vs API table splits mixed organizations.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockMetrics } = vi.hoisted(() => ({
	mockMetrics: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		admin: {
			aiAdoption: {
				metrics: {
					queryOptions: (opts: { input: unknown }) => ({
						queryKey: ["admin", "aiAdoption", opts.input],
						queryFn: () => mockMetrics(opts.input),
					}),
				},
			},
		},
	},
}));

import { AiAdoptionDashboard } from "@saas/admin/component/ai-adoption/AiAdoptionDashboard";

function renderDashboard() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<AiAdoptionDashboard />
		</QueryClientProvider>,
	);
}

const POPULATED = {
	periodDays: 30,
	from: "2026-07-19T00:00:00.000Z",
	to: "2026-08-18T00:00:00.000Z",
	maturation: {
		totals: { aiSuggested: 60, aiEdited: 25, manual: 15, total: 100 },
		series: [
			{ date: "2026-08-16", aiSuggested: 3, aiEdited: 1, manual: 1 },
			{ date: "2026-08-17", aiSuggested: 2, aiEdited: 2, manual: 0 },
		],
	},
	backlog: {
		statusTotals: {
			PENDING: 3,
			APPROVED: 6,
			APPLIED: 20,
			REJECTED: 6,
			FAILED: 1,
			SUPERSEDED: 2,
			BACKLOG: 0,
		},
		totalProposals: 38,
		series: [],
		sessions: { count: 5, appliedChanges: 40, failedChanges: 2 },
	},
	usage: {
		requests: 1234,
		failedRequests: 12,
		totalTokens: 5_000_000,
		costMicroUsd: 12_340_000,
	},
	usageByFeature: [
		{
			featureKey: "maturation",
			requests: 60,
			failedRequests: 1,
			totalTokens: 600_000,
			costMicroUsd: 6_000_000,
		},
		{
			featureKey: "__embeddings__",
			requests: 300,
			failedRequests: 0,
			totalTokens: 300_000,
			costMicroUsd: 300_000,
		},
		{
			featureKey: null,
			requests: 40,
			failedRequests: 0,
			totalTokens: 400_000,
			costMicroUsd: 4_000_000,
		},
	],
	outcomeSegments: [
		{
			modelCanonicalName: "claude-sonnet-5",
			promptVersionId: "pv-abcdef123456",
			featureKey: "maturation",
			counts: {
				ACCEPTED_AS_IS: 40,
				ACCEPTED_WITH_EDITS: 10,
				REJECTED: 10,
				RATED_UP: 0,
				RATED_DOWN: 0,
			},
			total: 60,
			decided: 60,
			acceptanceRate: 83,
		},
		{
			modelCanonicalName: "claude-haiku-4-5",
			promptVersionId: null,
			featureKey: "chat-agent",
			counts: {
				ACCEPTED_AS_IS: 0,
				ACCEPTED_WITH_EDITS: 0,
				REJECTED: 0,
				RATED_UP: 3,
				RATED_DOWN: 2,
			},
			total: 5,
			decided: 5,
			acceptanceRate: 60,
		},
	],
	changeAnnotations: [
		{
			kind: "PROMPT_VERSION",
			date: "2026-08-12",
			label: "feature_clean_spec_generator v4",
			detail: "tightened the rubric",
		},
	],
	billingSourceByOrganization: {
		rows: [
			{
				organizationId: "org-a",
				organizationName: "Example Org",
				plan: {
					requests: 30,
					totalTokens: 45_000,
					estimatedApiCostMicroUsd: 1_250_000,
					referenceModels: ["gpt-6-astra"],
				},
				api: {
					requests: 10,
					totalTokens: 8_000,
					costMicroUsd: 3_500_000,
				},
			},
			{
				organizationId: null,
				organizationName: null,
				plan: {
					requests: 2,
					totalTokens: 700,
					estimatedApiCostMicroUsd: 20_000,
					referenceModels: ["gpt-6-sol"],
				},
				api: { requests: 0, totalTokens: 0, costMicroUsd: 0 },
			},
			{
				organizationId: "org-gone",
				organizationName: null,
				plan: {
					requests: 0,
					totalTokens: 0,
					estimatedApiCostMicroUsd: 0,
					referenceModels: [],
				},
				api: { requests: 4, totalTokens: 900, costMicroUsd: 70_000 },
			},
		],
		totalOrganizations: 3,
	},
	minSampleSize: 30,
};

const EMPTY = {
	...POPULATED,
	maturation: {
		totals: { aiSuggested: 0, aiEdited: 0, manual: 0, total: 0 },
		series: [],
	},
	backlog: {
		statusTotals: {
			PENDING: 0,
			APPROVED: 0,
			APPLIED: 0,
			REJECTED: 0,
			FAILED: 0,
			SUPERSEDED: 0,
			BACKLOG: 0,
		},
		totalProposals: 0,
		series: [],
		sessions: { count: 0, appliedChanges: 0, failedChanges: 0 },
	},
	usage: {
		requests: 0,
		failedRequests: 0,
		totalTokens: 0,
		costMicroUsd: 0,
	},
	usageByFeature: [],
	outcomeSegments: [],
	changeAnnotations: [],
	billingSourceByOrganization: { rows: [], totalOrganizations: 0 },
	minSampleSize: 30,
};

describe("AiAdoptionDashboard", () => {
	beforeEach(() => {
		mockMetrics.mockReset();
	});

	it("renders acceptance, backlog, and usage metrics for a populated payload", async () => {
		mockMetrics.mockResolvedValue(POPULATED);
		renderDashboard();

		expect(
			await screen.findByRole("heading", { name: "AI Adoption" }),
		).toBeInTheDocument();

		// Maturation tiles: 60/100 as-is, 25 edited, 15 manual. Await a
		// data-dependent element first (the header renders before the query
		// resolves); labels and percentages legitimately appear in both the
		// stat tiles and the composition-bar legend.
		expect(await screen.findByText("60 answers")).toBeInTheDocument();
		expect(screen.getAllByText("Taken as-is").length).toBeGreaterThan(0);
		expect(screen.getAllByText("60%").length).toBeGreaterThan(0);
		expect(screen.getAllByText("25%").length).toBeGreaterThan(0);
		expect(screen.getAllByText("15%").length).toBeGreaterThan(0);

		// No low-sample badge for maturation (n=100) but the backlog side
		// (32 decided) also clears the threshold, so none should render.
		expect(screen.queryByText(/Low sample/)).not.toBeInTheDocument();

		// Backlog: accepted 26 of 32 decided → 81%.
		expect(screen.getByText("Review acceptance")).toBeInTheDocument();
		expect(screen.getByText("81%")).toBeInTheDocument();
		expect(screen.getByText("26 of 32 decided")).toBeInTheDocument();
		expect(screen.getByText("5 apply sessions")).toBeInTheDocument();

		// Usage tiles.
		expect(screen.getByText("1.2K")).toBeInTheDocument();
		expect(screen.getByText("5M")).toBeInTheDocument();
		expect(screen.getByText("$12.34")).toBeInTheDocument();
		// Requests count successes only; failed attempts are apart and the
		// error rate is of attempts (Fizzy #2972 AC3).
		expect(
			screen.getByText("12 failed attempts, not in the counts above"),
		).toBeInTheDocument();
	});

	it("shows zero states for an empty payload", async () => {
		mockMetrics.mockResolvedValue(EMPTY);
		renderDashboard();

		expect(
			await screen.findAllByText("No activity in this period."),
		).toHaveLength(2);
		// Rates degrade to em-dashes instead of NaN.
		expect(screen.getAllByText("—").length).toBeGreaterThan(0);
	});

	it("shows the low-sample badge when decisions are sparse", async () => {
		mockMetrics.mockResolvedValue({
			...POPULATED,
			maturation: {
				totals: { aiSuggested: 4, aiEdited: 2, manual: 1, total: 7 },
				series: [],
			},
		});
		renderDashboard();

		expect(
			await screen.findByText(/Low sample \(n=7\)/),
		).toBeInTheDocument();
	});

	it("refetches with the selected period's day count", async () => {
		mockMetrics.mockResolvedValue(POPULATED);
		renderDashboard();
		await screen.findByRole("heading", { name: "AI Adoption" });
		expect(mockMetrics).toHaveBeenCalledWith({ days: 30 });

		await userEvent.click(screen.getByRole("tab", { name: "7 days" }));
		await waitFor(() => {
			expect(mockMetrics).toHaveBeenCalledWith({ days: 7 });
		});
	});

	it("names untagged traffic instead of quietly folding it into the shares", async () => {
		mockMetrics.mockResolvedValue(POPULATED);
		renderDashboard();

		// The tagged row uses its friendly label, not the raw key. It appears
		// in both the per-feature table and the segmentation table, which is
		// why this counts rather than expecting a single node.
		expect(
			(await screen.findAllByText("Feature maturation")).length,
		).toBeGreaterThan(0);
		// 40 of 400 calls are genuinely untagged, and the copy says so rather
		// than letting the reader treat tagged shares as the whole picture.
		expect(screen.getByText(/40 calls \(10%\)/)).toBeInTheDocument();
		expect(screen.getByText(/not tagged yet/)).toBeInTheDocument();
		// Embeddings get their own named row instead of inflating "untagged"
		// with traffic that can never carry a feature key.
		expect(
			screen.getByText("Embeddings (RAG indexing)"),
		).toBeInTheDocument();
	});

	it("flags a segment with too few verdicts to read a rate from", async () => {
		mockMetrics.mockResolvedValue(POPULATED);
		renderDashboard();

		expect(
			await screen.findByText("Acceptance by what produced it"),
		).toBeInTheDocument();
		// Both segments render, keyed by the model that produced them.
		expect(screen.getByText("claude-sonnet-5")).toBeInTheDocument();
		expect(screen.getByText("claude-haiku-4-5")).toBeInTheDocument();
		// 60 verdicts clears the threshold; 5 does not, so exactly one row is
		// flagged. ("60%" alone is ambiguous — the maturation tile shows it
		// too — which is why this asserts the flag, not the number.)
		expect(screen.getByText("83%")).toBeInTheDocument();
		expect(screen.getAllByText("low n")).toHaveLength(1);
	});

	it("lists model and prompt changes for the window", async () => {
		mockMetrics.mockResolvedValue(POPULATED);
		renderDashboard();

		expect(
			await screen.findByText("feature_clean_spec_generator v4"),
		).toBeInTheDocument();
		expect(screen.getByText("tightened the rubric")).toBeInTheDocument();
	});

	it("explains the empty segmentation state instead of rendering a bare table", async () => {
		mockMetrics.mockResolvedValue(EMPTY);
		renderDashboard();

		expect(
			await screen.findByText(/No verdicts recorded yet/),
		).toBeInTheDocument();
	});

	it("splits each organization's calls between ChatGPT plan and API", async () => {
		mockMetrics.mockResolvedValue(POPULATED);
		renderDashboard();

		const table = await screen.findByRole("table", {
			name: "ChatGPT plan and API usage per organization",
		});
		const rows = within(table).getAllByRole("row");
		// Header + three organizations, in the order the query returned them.
		expect(rows).toHaveLength(4);

		const mixed = within(rows[1] as HTMLElement);
		expect(mixed.getByRole("rowheader")).toHaveTextContent("Example Org");
		expect(mixed.getByText("30")).toBeInTheDocument();
		expect(mixed.getByText("45K")).toBeInTheDocument();
		expect(mixed.getByText("10")).toBeInTheDocument();
		expect(mixed.getByText("8K")).toBeInTheDocument();
		expect(mixed.getByText("$3.50")).toBeInTheDocument();
		// 30 of 40 calls ran on the plan.
		expect(mixed.getByText("75%")).toBeInTheDocument();
		// What the plan calls would have cost on API billing, as an estimate.
		expect(
			within(table).getByRole("columnheader", {
				name: "Est. API cost of plan usage",
			}),
		).toBeInTheDocument();
		// Struck through — what it would have cost, not what was charged —
		// with the explanation on focus.
		const estimate = mixed.getByText("$1.25");
		expect(estimate.tagName).toBe("S");
		fireEvent.focus(estimate.closest("button") as HTMLElement);
		expect(
			(
				await screen.findAllByText(
					"Covered by members' ChatGPT plans, so nothing was billed. At the provider's API list prices these tokens would have cost about $1.25 (estimate, priced as gpt-6-astra).",
				)
			).length,
		).toBeGreaterThan(0);

		const unattributed = within(rows[2] as HTMLElement);
		expect(unattributed.getByRole("rowheader")).toHaveTextContent(
			"No organization",
		);
		expect(unattributed.getByText("100%")).toBeInTheDocument();

		const apiOnly = within(rows[3] as HTMLElement);
		expect(apiOnly.getByRole("rowheader")).toHaveTextContent(
			"Deleted organization",
		);
		expect(apiOnly.getByText("$0.07")).toBeInTheDocument();
		expect(apiOnly.getByText("0%")).toBeInTheDocument();

		expect(screen.queryByText(/Showing the top/)).not.toBeInTheDocument();
	});

	it("says when the organization table is truncated", async () => {
		mockMetrics.mockResolvedValue({
			...POPULATED,
			billingSourceByOrganization: {
				...POPULATED.billingSourceByOrganization,
				totalOrganizations: 75,
			},
		});
		renderDashboard();

		expect(
			await screen.findByText(/Showing the top 3 of 75 organizations/),
		).toBeInTheDocument();
	});

	it("omits the billing source table when the window has no usage", async () => {
		mockMetrics.mockResolvedValue(EMPTY);
		renderDashboard();

		await screen.findAllByText("No activity in this period.");
		expect(
			screen.queryByText("ChatGPT plan vs API by organization"),
		).not.toBeInTheDocument();
	});
});
