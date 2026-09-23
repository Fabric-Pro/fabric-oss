/**
 * "Sync now" only STARTS a workflow. Everything the Testing views show from it
 * — findings, each case's result, feature and plan pass rates — is written
 * later, by the ingest that workflow runs, so a refresh at the moment the
 * mutation succeeds reads the pre-sync state and keeps it. QA saw "Seen 1
 * time" beside two ingested red runs, and "Not run" beside a failed case,
 * until a full page reload (Fizzy #2226).
 *
 * Real react-query and fake timers here, not a mocked `useQuery`: the defect
 * is about WHEN a cached query is re-read, which a mock cannot show.
 */

import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What the server would answer right now. Tests move it forward. */
const server = {
	syncStates: [] as Array<{
		id: string;
		provider: string;
		status: string;
		lastFetchedAt: Date | null;
		updatedAt: Date;
	}>,
	syncStateReads: 0,
	findingsSeen: 1,
	caseResult: "NOT_RUN",
	featurePassed: 0,
	planPassRate: 0,
};

function queryOf<T>(name: string, read: () => T) {
	return {
		key: () => [name],
		queryOptions: (opts: {
			input?: unknown;
			refetchInterval?: unknown;
		}) => ({
			queryKey: [name, opts.input],
			queryFn: async () => read(),
			refetchInterval: opts.refetchInterval,
		}),
	};
}

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			pipelineResults: {
				listRuns: queryOf("runs", () => []),
				listRunsPage: {
					key: () => ["runsPage"],
					infiniteOptions: () => ({
						queryKey: ["runsPage"],
						queryFn: async () => ({ runs: [], total: 0 }),
					}),
				},
				syncStates: queryOf("syncStates", () => {
					server.syncStateReads += 1;
					return server.syncStates;
				}),
				sources: queryOf("sources", () => ({
					sources: [{ id: "r1" }],
					noSourcesReason: null,
				})),
				findings: queryOf("findings", () => ({
					seen: server.findingsSeen,
				})),
				unmatchedTests: queryOf("unmatched", () => []),
				sync: {
					mutationOptions: (opts: object) => ({
						mutationFn: async () => ({ status: "started" }),
						...opts,
					}),
				},
			},
			testCases: {
				list: queryOf("cases", () => ({ result: server.caseResult })),
				get: queryOf("case", () => null),
				resultHistory: queryOf("resultHistory", () => []),
				featureCoverage: queryOf("features", () => ({
					passed: server.featurePassed,
				})),
				plans: {
					list: queryOf("plans", () => ({
						passRate: server.planPassRate,
					})),
					get: queryOf("plan", () => null),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

/**
 * Stand-in for the findings list, reading the SAME query key the real one
 * does. What it prints is what a user would be looking at.
 */
vi.mock("../FindingsSection", async () => {
	const { orpc } = await import("@shared/lib/orpc-query-utils");
	return {
		FindingsSection: () => {
			const q = useQuery(
				orpc.projects.pipelineResults.findings.queryOptions({
					input: { status: "OPEN" },
				}),
			);
			return <div data-testid="findings">{`Seen ${q.data?.seen}`}</div>;
		},
	};
});
vi.mock("../UnmatchedTestsSection", () => ({
	UnmatchedTestsSection: () => null,
}));
vi.mock("../TriggerRunDialog", () => ({ TriggerRunDialog: () => null }));
vi.mock("../PipelineRunDetailSheet", () => ({
	PipelineRunDetailSheet: () => null,
}));
vi.mock("../../HistoryMoreDialog", () => ({
	HISTORY_DIALOG_PAGE: 20,
	HISTORY_PANEL_PREVIEW: 5,
	HistoryMoreDialog: () => null,
}));

import { orpc } from "@shared/lib/orpc-query-utils";
import { PipelineRunsPanel } from "../PipelineRunsPanel";
import {
	resetPipelineSyncWatches,
	usePipelineIngestionRefresh,
} from "../use-pipeline-sync-watch";

/**
 * The Testing tab as `TestCasesList` lays it out: the refresh hook above the
 * segments, and exactly one segment mounted at a time.
 */
function TestingTab() {
	usePipelineIngestionRefresh("p1");
	const [segment, setSegment] = useState<"runs" | "cases" | "features">(
		"runs",
	);
	return (
		<>
			<button type="button" onClick={() => setSegment("runs")}>
				to-runs
			</button>
			<button type="button" onClick={() => setSegment("cases")}>
				to-cases
			</button>
			<button type="button" onClick={() => setSegment("features")}>
				to-features
			</button>
			{segment === "runs" && <PipelineRunsPanel projectId="p1" />}
			{segment === "cases" && <CasesResult />}
			{segment === "features" && <FeatureAndPlanRates />}
		</>
	);
}

function CasesResult() {
	const q = useQuery(
		orpc.projects.testCases.list.queryOptions({ input: {} }),
	);
	return <div data-testid="case-result">{q.data?.result}</div>;
}

function FeatureAndPlanRates() {
	const features = useQuery(
		orpc.projects.testCases.featureCoverage.queryOptions({ input: {} }),
	);
	const plans = useQuery(
		orpc.projects.testCases.plans.list.queryOptions({ input: {} }),
	);
	return (
		<div data-testid="rates">
			{`features ${features.data?.passed} plans ${plans.data?.passRate}`}
		</div>
	);
}

function renderTab() {
	const client = new QueryClient({
		// The app's own default, so a remount inside it serves the cache.
		defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
	});
	render(
		<QueryClientProvider client={client}>
			<TestingTab />
		</QueryClientProvider>,
	);
	return client;
}

const T0 = new Date("2026-08-17T17:00:00Z");
const T1 = new Date("2026-08-17T17:05:00Z");

/** The workflow's ingest finishing: results written, then the source row. */
function ingestLands({ failedAfterIngest = false } = {}) {
	server.findingsSeen = 2;
	server.caseResult = "FAILED";
	server.featurePassed = 3;
	server.planPassRate = 75;
	server.syncStates = [
		{
			...server.syncStates[0],
			// A source whose RCA step threw after its ingest keeps its old
			// lastFetchedAt; only the row's updatedAt says it finished.
			lastFetchedAt: failedAfterIngest ? T0 : T1,
			status: failedAfterIngest ? "FAILED" : "OK",
			updatedAt: T1,
		},
	];
}

async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

async function clickSync() {
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: /^sync$/ }));
	});
	await advance(0);
}

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	resetPipelineSyncWatches();
	server.syncStates = [
		{
			id: "s1",
			provider: "GITHUB_ACTIONS",
			status: "OK",
			lastFetchedAt: T0,
			updatedAt: T0,
		},
	];
	server.syncStateReads = 0;
	server.findingsSeen = 1;
	server.caseResult = "NOT_RUN";
	server.featurePassed = 0;
	server.planPassRate = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Testing tab — what a completed sync produced is visible without a reload", () => {
	it("re-reads the findings once the sync's ingest lands", async () => {
		renderTab();
		expect(await screen.findByText("Seen 1")).toBeInTheDocument();

		await clickSync();
		ingestLands();
		await advance(3100);

		expect(await screen.findByText("Seen 2")).toBeInTheDocument();
	});

	it("still refreshes the Cases table when the user left the Runs segment before the ingest landed", async () => {
		renderTab();
		// Visit Cases first so its pre-sync answer is cached, as it is for
		// anyone who looked at the table before syncing.
		fireEvent.click(screen.getByText("to-cases"));
		expect(await screen.findByText("NOT_RUN")).toBeInTheDocument();
		fireEvent.click(screen.getByText("to-runs"));
		expect(await screen.findByText("Seen 1")).toBeInTheDocument();

		await clickSync();
		// Straight to Cases: the Runs panel is unmounted while the sync runs.
		fireEvent.click(screen.getByText("to-cases"));
		ingestLands();
		await advance(3100);

		expect(await screen.findByText("FAILED")).toBeInTheDocument();
	});

	it("refreshes feature and plan pass rates, which come from the same results", async () => {
		renderTab();
		fireEvent.click(screen.getByText("to-features"));
		expect(
			await screen.findByText("features 0 plans 0"),
		).toBeInTheDocument();
		fireEvent.click(screen.getByText("to-runs"));
		expect(await screen.findByText("Seen 1")).toBeInTheDocument();

		await clickSync();
		ingestLands();
		await advance(3100);
		fireEvent.click(screen.getByText("to-features"));

		expect(
			await screen.findByText("features 3 plans 75"),
		).toBeInTheDocument();
	});

	it("keeps watching a sync that takes longer than the old 30-second window", async () => {
		renderTab();
		expect(await screen.findByText("Seen 1")).toBeInTheDocument();

		await clickSync();
		await advance(45_000);
		ingestLands();
		await advance(10_100);

		expect(await screen.findByText("Seen 2")).toBeInTheDocument();
	});

	it("re-reads results when a source wrote them and then failed, without advancing lastFetchedAt", async () => {
		renderTab();
		expect(await screen.findByText("Seen 1")).toBeInTheDocument();

		await clickSync();
		ingestLands({ failedAfterIngest: true });
		await advance(3100);

		expect(await screen.findByText("Seen 2")).toBeInTheDocument();
	});

	it("stops polling once every source has finished", async () => {
		renderTab();
		expect(await screen.findByText("Seen 1")).toBeInTheDocument();

		await clickSync();
		ingestLands();
		await advance(3100);
		expect(await screen.findByText("Seen 2")).toBeInTheDocument();

		const readsWhenSettled = server.syncStateReads;
		await advance(60_000);
		expect(server.syncStateReads).toBe(readsWhenSettled);
	});

	it("does not re-read on a poll that found no finished source", async () => {
		renderTab();
		expect(await screen.findByText("Seen 1")).toBeInTheDocument();

		await clickSync();
		// Something changed server-side that no sync produced; an unchanged
		// sync state must not turn every poll into a refetch of every view.
		server.findingsSeen = 5;
		await advance(9_100);

		expect(screen.getByTestId("findings")).toHaveTextContent("Seen 1");
	});
});
