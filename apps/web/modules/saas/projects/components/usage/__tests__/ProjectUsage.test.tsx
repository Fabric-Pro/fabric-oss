import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectUsage } from "../../ProjectUsage";
import { DecisionReplayDashboard } from "../DecisionReplayDashboard";
import type { ReplaySummary } from "../decision-replay";

const mocks = vi.hoisted(() => ({
	mint: vi.fn(),
	initialize: vi.fn(),
	flag: true,
	search: "tab=usage&keep=yes",
	replace: vi.fn(),
	summary: vi.fn(),
	review: vi.fn(),
	cost: vi.fn(),
	breakdown: vi.fn(),
	recent: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(mocks.search),
	usePathname: () => "/app/example-org/projects/example-project",
	useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => mocks.flag,
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useBasePath: () => "/app/example-org",
}));
vi.mock("@saas/get-started/components/PageTourButton", () => ({
	PageTourButton: () => null,
}));
vi.mock("next/dynamic", () => ({
	default:
		() => (props: React.ComponentProps<typeof DecisionReplayDashboard>) => (
			<DecisionReplayDashboard {...props} />
		),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			decisionReplay: {
				getEmbedToken: (...a: unknown[]) => mocks.mint(...a),
				getSummary: (...a: unknown[]) => mocks.summary(...a),
				listNeedsReview: (...a: unknown[]) => mocks.review(...a),
			},
			usage: {
				getSummary: (...a: unknown[]) => mocks.cost(...a),
				getTimeSeries: async () => [],
				getBreakdown: (...a: unknown[]) => mocks.breakdown(...a),
				listRecent: (...a: unknown[]) => mocks.recent(...a),
				getConfiguredModels: async () => ({
					patternModel: "Example model",
				}),
			},
		},
	},
}));
const period = {
	changeOutcomes: {
		applied: 5,
		alreadyOnRoadmap: 2,
		notSelected: 3,
		failed: 0,
		inProgress: 0,
		rejected: 0,
		superseded: 1,
		pending: 2,
	},
	changeAcceptance: { accepted: 5, decided: 8, rate: 0.625 },
	partlyApplied: 1,
	acceptance: { accepted: 3, decided: 4, rate: 0.75 },
	medianReviewSeconds: 7200,
	keptAsApplied: { kept: 1, mature: 2, rate: 0.5 },
	outcomes: { applied: 3, rejected: 1, pending: 2, other: 1 },
};
const summary = (): ReplaySummary => ({
	changeCoverageStartedAt: new Date("2026-01-01T00:00:00Z"),
	waiting: 2,
	oldestWaitingAt: new Date(Date.now() - 86400000),
	current: structuredClone(period),
	previous: {
		...structuredClone(period),
		acceptance: { accepted: 1, decided: 2, rate: 0.5 },
		changeAcceptance: { accepted: 1, decided: 2, rate: 0.5 },
		medianReviewSeconds: 10800,
	},
});
vi.mock("@databricks/aibi-client", () => ({
	DatabricksDashboard: class {
		constructor(options: { container: HTMLElement }) {
			this.container = options.container;
		}
		container: HTMLElement;
		initialize() {
			mocks.initialize();
			const frame = document.createElement("iframe");
			this.container.append(frame);
			queueMicrotask(() => frame.dispatchEvent(new Event("load")));
		}
		destroy() {
			this.container.replaceChildren();
		}
	},
}));
function setup() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const view = render(
		<QueryClientProvider client={client}>
			<ProjectUsage projectId="example-project" />
		</QueryClientProvider>,
	);
	return {
		...view,
		client,
		redraw: () =>
			view.rerender(
				<QueryClientProvider client={client}>
					<ProjectUsage projectId="example-project" />
				</QueryClientProvider>,
			),
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.mint.mockResolvedValue({
		available: true,
		token: "example-token",
		expiresAt: new Date(Date.now() + 3600000).toISOString(),
		instanceUrl: "https://example.com",
		workspaceId: "example-workspace",
		dashboardId: "example-dashboard",
	});
	mocks.flag = true;
	mocks.search = "tab=usage&keep=yes&usageView=outcomes";
	mocks.summary.mockResolvedValue(summary());
	mocks.review.mockResolvedValue({
		total: 2,
		items: [
			{
				id: "example/proposal",
				summary: "Improve example search",
				source: "TEAMS_CHANNEL",
				changeCount: 2,
				createdAt: new Date(Date.now() - 86400000),
			},
		],
	});
	mocks.cost.mockResolvedValue({
		byBillingCategory: {
			INCLUDED_CREDIT: { costCents: 100 },
			STRIPE_METERED: { costCents: 200 },
			PLATFORM_UNBILLED: { costCents: 0 },
			EXTERNAL_BYOK: { costCents: 0 },
		},
		totalTokens: 2000,
		totalCalls: 3,
		successRate: 1,
	});
	mocks.breakdown.mockResolvedValue([]);
	mocks.recent.mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(cleanup);
it("flag off keeps Cost and makes no outcomes requests", async () => {
	mocks.flag = false;
	setup();
	expect(await screen.findByText("$3.00")).toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: /AI outcomes/ }),
	).not.toBeInTheDocument();
	expect(mocks.summary).not.toHaveBeenCalled();
});
it("reads the URL and writes both views while preserving other params", async () => {
	const view = setup();
	expect(
		await screen.findByRole("heading", { name: "AI outcomes" }),
	).toBeInTheDocument();
	expect(
		await screen.findByRole("button", {
			name: /AI outcomes, 2 waiting for review/,
		}),
	).toHaveAttribute("aria-pressed", "true");
	fireEvent.click(screen.getByRole("button", { name: "Cost" }));
	expect(mocks.replace).toHaveBeenCalledWith(
		"/app/example-org/projects/example-project?tab=usage&keep=yes",
		{ scroll: false },
	);
	mocks.search = "tab=usage&keep=yes&usageView=invalid";
	view.redraw();
	expect(
		screen.getByRole("heading", { name: "Usage & cost" }),
	).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: /AI outcomes/ }));
	expect(mocks.replace).toHaveBeenLastCalledWith(
		"/app/example-org/projects/example-project?tab=usage&keep=yes&usageView=outcomes",
		{ scroll: false },
	);
});
it.each(["summary", "review"] as const)(
	"NOT_FOUND from %s hides switch and shows Cost",
	async (endpoint) => {
		mocks[endpoint].mockRejectedValue({ code: "NOT_FOUND" });
		setup();
		expect(
			await screen.findByRole("heading", { name: "Usage & cost" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /AI outcomes/ }),
		).not.toBeInTheDocument();
	},
);
it("renders metric values, deltas, queue links, legend and review focus", async () => {
	setup();
	expect(await screen.findByText("5 of 8")).toBeInTheDocument();
	expect(screen.getByText(/63% accepted/)).toHaveTextContent(
		"+12.5 percentage points vs previous period",
	);
	expect(screen.getByText("2 hours")).toBeInTheDocument();
	expect(screen.getByText(/inbox proposals only/)).toHaveTextContent(
		"−1 hour vs previous period",
	);
	expect(screen.getByText("50%")).toBeInTheDocument();
	const row = await screen.findByRole("link", {
		name: /Improve example search/,
	});
	expect(row).toHaveAttribute(
		"href",
		"/app/example-org/projects/example-project?tab=stories&proposal=example%2Fproposal",
	);
	expect(row).toHaveTextContent("Teams channel · 2 changes");
	expect(
		screen.getByText("Oldest first · showing 1 of 2"),
	).toBeInTheDocument();
	expect(
		screen.getByRole("link", { name: "Open inbox (2)" }),
	).toHaveAttribute(
		"href",
		"/app/example-org/projects/example-project?tab=stories&inbox=proposals",
	);
	expect(
		screen.getByText(/Rejected includes Move to Rejected/),
	).toBeInTheDocument();
	expect(screen.getByText("Applied · 5")).toBeInTheDocument();
	const outcomeBar = screen.getByRole("img", {
		name: /Applied: 5, Not selected: 3, Already on roadmap: 2, Rejected:/,
	});
	const outcomeRects = outcomeBar.querySelectorAll("rect");
	for (const [index, label, fill, swatch, stroke] of [
		[0, "Applied", "fill-success", "bg-success", "stroke-background"],
		[
			3,
			"Rejected",
			"fill-destructive/95 dark:fill-destructive/70",
			"bg-destructive/95 dark:bg-destructive/70",
			"stroke-background",
		],
		[4, "Pending", "fill-muted", "bg-muted", "stroke-foreground"],
		[
			5,
			"Failed / in progress",
			"fill-muted-foreground",
			"bg-muted-foreground",
			"stroke-background",
		],
	] as const) {
		expect(outcomeRects[index]).toHaveClass(fill, stroke);
		const legend = screen.getByText(new RegExp(`^${label} ·`));
		expect(legend.querySelector("span")).toHaveClass(
			swatch,
			"border-foreground",
		);
		expect(legend.closest("a")).toBeNull();
	}
	fireEvent.click(screen.getByRole("link", { name: /Waiting for review/ }));
	expect(screen.getByRole("heading", { name: "Needs review" })).toHaveFocus();
});
it("null metrics show reasons and all-time omits deltas", async () => {
	const data = summary();
	data.current.changeAcceptance = {
		accepted: 0,
		decided: 0,
		rate: null,
	};
	data.current.medianReviewSeconds = null;
	data.current.keptAsApplied.rate = null;
	mocks.summary.mockResolvedValue({ ...data, previous: null });
	setup();
	expect(await screen.findAllByText("—")).toHaveLength(2);
	expect(screen.getByText("0 of 0")).toBeInTheDocument();
	expect(screen.getByText(/no decisions yet/)).toBeInTheDocument();
	expect(
		screen.getByText(/no reviewed inbox proposals yet/),
	).toBeInTheDocument();
	expect(
		screen.getByText(/no proposals applied at least 7 days ago/),
	).toBeInTheDocument();
	expect(screen.queryByText(/vs previous period/)).not.toBeInTheDocument();
});
it("empty period offers Roadmap and a working 90-day action", async () => {
	mocks.summary.mockResolvedValue({
		...summary(),
		waiting: 0,
		current: {
			...period,
			outcomes: { applied: 0, rejected: 0, pending: 0, other: 0 },
			changeOutcomes: {
				applied: 0,
				alreadyOnRoadmap: 0,
				notSelected: 0,
				failed: 0,
				inProgress: 0,
				rejected: 0,
				superseded: 0,
				pending: 0,
			},
		},
	});
	mocks.review.mockResolvedValue({ total: 0, items: [] });
	setup();
	expect(
		await screen.findByText("No AI suggestions in the last 30 days"),
	).toBeInTheDocument();
	expect(
		screen.getByRole("link", { name: "Open the Roadmap" }),
	).toHaveAttribute(
		"href",
		"/app/example-org/projects/example-project?tab=stories",
	);
	fireEvent.click(screen.getByRole("button", { name: "Show last 90 days" }));
	await waitFor(() =>
		expect(mocks.summary).toHaveBeenCalledWith(
			expect.objectContaining({ range: "90d" }),
			expect.anything(),
		),
	);
});
it("live waiting prevents empty state even with no period proposals", async () => {
	mocks.summary.mockResolvedValue({
		...summary(),
		current: {
			...period,
			outcomes: { applied: 0, rejected: 0, pending: 0, other: 0 },
			changeOutcomes: {
				applied: 0,
				alreadyOnRoadmap: 0,
				notSelected: 0,
				failed: 0,
				inProgress: 0,
				rejected: 0,
				superseded: 0,
				pending: 0,
			},
		},
	});
	setup();
	expect(
		await screen.findByText("Improve example search"),
	).toBeInTheDocument();
	expect(screen.queryByText(/No AI suggestions/)).not.toBeInTheDocument();
});
it("empty review list and inline query retry", async () => {
	mocks.review
		.mockRejectedValueOnce(new Error("Unavailable"))
		.mockResolvedValue({ total: 0, items: [] });
	setup();
	const section = await screen.findByRole("region", { name: "Needs review" });
	fireEvent.click(
		await within(section).findByRole("button", { name: "Try again" }),
	);
	expect(
		await screen.findByText("Nothing waiting for review"),
	).toBeInTheDocument();
});
it("summary errors retry inline", async () => {
	mocks.summary
		.mockRejectedValueOnce(new Error("Unavailable"))
		.mockResolvedValue(summary());
	setup();
	const retry = await screen.findByRole("button", { name: "Try again" });
	expect(
		screen.getByRole("region", { name: "Trends and details" }),
	).toBeInTheDocument();
	await waitFor(() => expect(mocks.initialize).toHaveBeenCalledTimes(1));
	fireEvent.click(retry);
	expect(await screen.findByText("5 of 8")).toBeInTheDocument();
});
it("Cost range and breakdown work and range survives switching views", async () => {
	mocks.search = "tab=usage";
	const view = setup();
	expect(await screen.findByText("Example model")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
	fireEvent.click(screen.getByRole("button", { name: "Provider" }));
	await waitFor(() =>
		expect(mocks.breakdown).toHaveBeenCalledWith(
			expect.objectContaining({ range: "7d", groupBy: "provider" }),
			expect.anything(),
		),
	);
	mocks.search = "tab=usage&usageView=outcomes";
	view.redraw();
	expect(screen.getByRole("button", { name: "Last 7 days" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await waitFor(() =>
		expect(mocks.summary).toHaveBeenCalledWith(
			expect.objectContaining({ range: "7d" }),
			expect.anything(),
		),
	);
});

it("all-time with observations omits comparisons and requests all", async () => {
	mocks.summary.mockResolvedValue({ ...summary(), previous: null });
	setup();
	expect(await screen.findByText("5 of 8")).toBeInTheDocument();
	expect(screen.queryByText(/vs previous period/)).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "All time" }));
	await waitFor(() =>
		expect(mocks.summary).toHaveBeenCalledWith(
			expect.objectContaining({ range: "all" }),
			expect.anything(),
		),
	);
});

it("Cost infinite scroll reconnects after switching back from outcomes", async () => {
	const observe = vi.fn();
	const disconnect = vi.fn();
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe = observe;
			disconnect = disconnect;
		},
	);
	try {
		mocks.search = "tab=usage";
		mocks.recent.mockResolvedValue({
			items: [
				{
					id: "example-call",
					createdAt: new Date(),
					success: true,
					totalTokens: 10,
					costCents: 1,
				},
			],
			nextCursor: "example-next",
		});
		const view = setup();
		await waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
		mocks.search = "tab=usage&usageView=outcomes";
		view.redraw();
		expect(disconnect).toHaveBeenCalledTimes(1);
		mocks.search = "tab=usage";
		view.redraw();
		await waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
	} finally {
		vi.unstubAllGlobals();
	}
});

it("mounts Trends once per project while the view has data", async () => {
	let resolve!: (value: ReplaySummary) => void;
	mocks.summary.mockReturnValueOnce(
		new Promise((r) => {
			resolve = r;
		}),
	);
	const { client } = setup();
	expect(mocks.mint).not.toHaveBeenCalled();
	expect(
		screen
			.getByRole("status", { name: "Loading AI outcomes" })
			.querySelector(".h-340"),
	).toBeNull();
	resolve(summary());
	expect(await screen.findByText("5 of 8")).toBeInTheDocument();
	mocks.summary.mockReturnValueOnce(
		new Promise((r) => {
			resolve = r;
		}),
	);
	fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
	await waitFor(() => expect(mocks.summary).toHaveBeenCalledTimes(2));
	expect(screen.getByText("5 of 8")).toBeInTheDocument();
	const stale = screen.getByText("5 of 8").closest("[aria-busy]");
	expect(stale).toHaveAttribute("aria-busy", "true");
	expect(stale).toHaveClass("opacity-50");
	resolve(summary());
	await waitFor(() => expect(mocks.initialize).toHaveBeenCalledTimes(1));
	mocks.summary.mockReturnValueOnce(
		new Promise((r) => {
			resolve = r;
		}),
	);
	const refresh = client.invalidateQueries();
	await waitFor(() => expect(mocks.summary).toHaveBeenCalledTimes(3));
	expect(screen.getByText("5 of 8")).toBeInTheDocument();
	expect(document.querySelector("iframe")).toBeInTheDocument();
	resolve(summary());
	await refresh;
	expect(mocks.initialize).toHaveBeenCalledTimes(1);
	expect(mocks.mint).toHaveBeenCalledTimes(1);
});
it.each(["7d", "30d", "90d", "all"] as const)(
	"empty %s offers only the next wider range",
	async (range) => {
		mocks.summary.mockResolvedValue({
			...summary(),
			waiting: 0,
			current: {
				...period,
				outcomes: { applied: 0, rejected: 0, pending: 0, other: 0 },
				changeOutcomes: {
					applied: 0,
					alreadyOnRoadmap: 0,
					notSelected: 0,
					failed: 0,
					inProgress: 0,
					rejected: 0,
					superseded: 0,
					pending: 0,
				},
			},
		});
		setup();
		await screen.findByText(/No AI suggestions/);
		const labels = {
			"7d": "Last 7 days",
			"30d": "Last 30 days",
			"90d": "Last 90 days",
			all: "All time",
		};
		fireEvent.click(screen.getByRole("button", { name: labels[range] }));
		await waitFor(() =>
			expect(screen.getByText(/No AI suggestions/)).toHaveTextContent(
				range === "all" ? "yet" : `last ${range.slice(0, -1)} days`,
			),
		);
		expect(
			screen.getByRole("link", { name: "Open the Roadmap" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("region", { name: "Trends and details" }),
		).not.toBeInTheDocument();
		expect(mocks.mint).not.toHaveBeenCalled();
		const next = {
			"7d": "Show last 30 days",
			"30d": "Show last 90 days",
			"90d": "Show all time",
			all: null,
		}[range];
		const actions = screen.queryAllByRole("button", { name: /^Show / });
		expect(actions).toHaveLength(next ? 1 : 0);
		if (next) {
			expect(actions[0]).toHaveTextContent(next);
			fireEvent.click(actions[0]);
			const nextRange = {
				"7d": "30d",
				"30d": "90d",
				"90d": "all",
				all: "all",
			}[range] as keyof typeof labels;
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: labels[nextRange] }),
				).toHaveAttribute("aria-pressed", "true"),
			);
		}
	},
);
it.each([0, 2])(
	"switch labels %i waiting and hides zero badge",
	async (waiting) => {
		mocks.summary.mockResolvedValue({ ...summary(), waiting });
		setup();
		await screen.findByText("5 of 8");
		const button = screen.getByRole("button", {
			name: waiting
				? `AI outcomes, ${waiting} waiting for review`
				: "AI outcomes",
		});
		expect(button).toHaveTextContent(
			waiting ? "AI outcomes 2" : /^AI outcomes\s*$/,
		);
	},
);
it("zero deltas say no change without plus zero", async () => {
	mocks.summary.mockResolvedValue({
		...summary(),
		previous: structuredClone(period),
	});
	setup();
	expect(
		await screen.findAllByText(/No change vs previous period/),
	).toHaveLength(2);
	expect(screen.queryByText(/\+0/)).not.toBeInTheDocument();
});

it("marks previous-period tiles and lists busy and de-emphasized until replacement arrives", async () => {
	setup();
	await screen.findByText("5 of 8");
	let resolve!: (value: ReplaySummary) => void;
	mocks.summary.mockReturnValueOnce(
		new Promise((r) => {
			resolve = r;
		}),
	);
	fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
	await waitFor(() => expect(mocks.summary).toHaveBeenCalledTimes(2));
	const stale = screen.getByText("5 of 8").closest("[aria-busy]");
	expect(stale).toHaveAttribute("aria-busy", "true");
	expect(stale).toHaveClass("opacity-50");
	expect(stale).toContainElement(
		screen.getByRole("region", { name: "Needs review" }),
	);
	resolve(summary());
	await waitFor(() => expect(stale).toHaveAttribute("aria-busy", "false"));
	expect(stale).not.toHaveClass("opacity-50");
});
it("summary loading reserves no dashboard-sized placeholder", async () => {
	mocks.summary.mockReturnValueOnce(new Promise(() => {}));
	setup();
	expect(
		screen
			.getByRole("status", { name: "Loading AI outcomes" })
			.querySelector(".h-340"),
	).toBeNull();
});

it("switch navigation preserves query params without URLSearchParams.size", async () => {
	const descriptor = Object.getOwnPropertyDescriptor(
		URLSearchParams.prototype,
		"size",
	);
	Object.defineProperty(URLSearchParams.prototype, "size", {
		configurable: true,
		get: () => undefined,
	});
	try {
		setup();
		await screen.findByText("5 of 8");
		fireEvent.click(screen.getByRole("button", { name: "Cost" }));
		expect(mocks.replace).toHaveBeenLastCalledWith(
			"/app/example-org/projects/example-project?tab=usage&keep=yes",
			{ scroll: false },
		);
	} finally {
		if (descriptor) {
			Object.defineProperty(
				URLSearchParams.prototype,
				"size",
				descriptor,
			);
		} else {
			Reflect.deleteProperty(URLSearchParams.prototype, "size");
		}
	}
});
it.each([1, -1])(
	"tiny deltas (%i) display No change after rounding",
	async (direction) => {
		const data = summary();
		data.previous = {
			...structuredClone(period),
			changeAcceptance: {
				...period.changeAcceptance,
				rate: 0.625 - direction * 0.00001,
			},
			medianReviewSeconds: 7200 - direction * 0.001,
		};
		mocks.summary.mockResolvedValue(data);
		setup();
		expect(
			await screen.findAllByText(/No change vs previous period/),
		).toHaveLength(2);
		expect(screen.queryByText(/[+−]0(?: |$)/)).not.toBeInTheDocument();
	},
);

it("explains covered changes and partly applied proposals with text alternatives", async () => {
	setup();
	expect(await screen.findByText("5 of 8")).toBeInTheDocument();
	expect(screen.getByText("Not selected · 3")).toBeInTheDocument();
	expect(screen.getByText("Already on roadmap · 2")).toBeInTheDocument();
	expect(
		screen.getByText("Partly applied · 1 (included in applied)"),
	).toBeInTheDocument();
	expect(screen.getByText("Superseded · 1")).toBeInTheDocument();
	expect(
		screen.getByRole("img", {
			name: /Applied: 5, Not selected: 3, Already on roadmap: 2/,
		}),
	).toBeInTheDocument();
	expect(screen.getByText(/Not selected means omitted/)).toBeInTheDocument();
	expect(
		screen.getByText(
			/Changes are counted from when review recording started/,
		),
	).toBeInTheDocument();
});
it("shows a coverage empty state while retaining proposal counts", async () => {
	mocks.summary.mockResolvedValue({
		...summary(),
		changeCoverageStartedAt: null,
	});
	setup();
	expect(
		await screen.findByText(
			"Change review recording has not started for this project yet.",
		),
	).toBeInTheDocument();
	expect(screen.getByText("Applied proposals · 3")).toBeInTheDocument();
	expect(
		screen.queryByRole("img", { name: /Applied:/ }),
	).not.toBeInTheDocument();
});

it("uses unique fill and swatch classes for each change segment", async () => {
	setup();
	const bar = await screen.findByRole("img", {
		name: /Applied: 5, Not selected:/,
	});
	const fills = [...bar.querySelectorAll("rect")].map((r) =>
		[...r.classList].filter((c) => c.includes("fill-")).join(" "),
	);
	const cases = [
		["Applied", 5],
		["Not selected", 3],
		["Already on roadmap", 2],
		["Rejected", 0],
		["Pending", 2],
		["Failed / in progress", 0],
	] as const;
	const swatches = cases.map(([label, count]) => {
		const span = screen
			.getByText(`${label} · ${count}`)
			.querySelector("span");
		if (!span) {
			throw new Error("Missing legend swatch");
		}
		return [...span.classList].filter((c) => c.includes("bg-")).join(" ");
	});
	expect(new Set(fills).size).toBe(6);
	expect(new Set(swatches).size).toBe(6);
});
it("falls back to proposal acceptance until review coverage starts", async () => {
	const data = summary();
	data.changeCoverageStartedAt = null;
	data.current.changeAcceptance = { accepted: 0, decided: 0, rate: null };
	data.current.changeOutcomes = {
		applied: 0,
		alreadyOnRoadmap: 0,
		notSelected: 0,
		failed: 0,
		inProgress: 0,
		rejected: 0,
		superseded: 0,
		pending: 0,
	};
	mocks.summary.mockResolvedValue(data);
	setup();
	expect(await screen.findByText("Acceptance rate")).toBeInTheDocument();
	expect(screen.getByText("75%")).toBeInTheDocument();
	expect(screen.getByText(/3 accepted of 4 decided/)).toBeInTheDocument();
	expect(
		screen.getByText(/Per-change counts start when reviews are recorded/),
	).toBeInTheDocument();
	expect(screen.queryByText("0 of 0")).not.toBeInTheDocument();
});

it("keeps adjacent change fills above 3:1 in the default light and dark themes", async () => {
	const data = summary();
	data.current.changeOutcomes.rejected = 1;
	data.current.changeOutcomes.failed = 1;
	mocks.summary.mockResolvedValue(data);
	setup();
	const bar = await screen.findByRole("img", {
		name: /Applied: 5, Not selected:/,
	});
	const css = readFileSync(
		resolve(
			__dirname,
			"../../../../../../../../tooling/tailwind/theme.css",
		),
		"utf8",
	);
	const rgb = (hex: string) =>
		[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
	const luminance = (values: number[]) =>
		values.reduce(
			(n, x, i) =>
				n +
				([0.2126, 0.7152, 0.0722][i] ?? 0) *
					(x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4),
			0,
		);
	for (const theme of ["light", "dark"]) {
		const start = css.indexOf(
			theme === "light" ? "\t:root {" : "\t.dark {",
		);
		expect(start).toBeGreaterThan(0);
		const block = css.slice(start, css.indexOf("\n\t}", start));
		const tokens = Object.fromEntries(
			[...block.matchAll(/--([\w-]+): (#[a-f0-9]{6});/g)].map((m) => [
				m[1],
				m[2],
			]),
		);
		const background = rgb(tokens.card);
		const fills = [...bar.querySelectorAll("rect")].map((rect) => {
			const classes = [...rect.classList];
			const fill =
				(theme === "dark"
					? classes.find((c) => c.startsWith("dark:fill-"))
					: undefined) ?? classes.find((c) => c.startsWith("fill-"));
			if (!fill) {
				throw new Error("Missing fill");
			}
			const [token, opacity] = fill
				.replace("dark:", "")
				.slice(5)
				.split("/");
			const alpha = opacity ? Number(opacity) / 100 : 1;
			if (!token || !tokens[token]) {
				throw new Error("Unknown theme token");
			}
			return rgb(tokens[token]).map(
				(v, i) => v * alpha + (background[i] ?? 0) * (1 - alpha),
			);
		});
		expect(fills).toHaveLength(6);
		for (let i = 1; i < fills.length; i++) {
			const left = fills[i - 1];
			const right = fills[i];
			if (!left || !right) {
				throw new Error("Missing segment");
			}
			const a = luminance(left);
			const b = luminance(right);
			expect(
				(Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
				`${theme} segments ${i - 1}/${i}`,
			).toBeGreaterThanOrEqual(3);
		}
	}
});
