/**
 * "Sync now" only STARTS a workflow. Everything the Testing views show from it
 * — findings, each case's result, feature and plan pass rates, the Runs
 * section badge, the QA traceability matrix — is written later, by the ingest
 * that workflow runs, so a refresh at the moment the mutation succeeds reads
 * the pre-sync state and keeps it. QA saw "Seen 1 time" beside two ingested
 * red runs, and "Not run" beside a failed case, until a full page reload
 * (Fizzy #2226).
 *
 * Completion is anchored to the exact Temporal RUN the click started or
 * joined (its `runId`), not to a sync-state row's `updatedAt` (Fizzy #2722):
 * a row another writer touched looks identical to one this sync wrote, and a
 * row the previous sync never wrote (a first sync, a newly connected source)
 * never existed to compare against. Two ingestion-derived displays — the
 * Testing tab's section badges and the QA matrix's evidence — were never
 * re-read at all (Fizzy #2723).
 *
 * Real react-query and fake timers here, not a mocked `useQuery`: the defect
 * is about WHEN a cached query is re-read, which a mock cannot show.
 */

import {
	QueryClient,
	QueryClientProvider,
	skipToken,
	useQuery,
} from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SyncStateRow = {
	id: string;
	provider: string;
	status: string;
	lastFetchedAt: Date | null;
	updatedAt: Date;
};

/** What the server would answer right now. Tests move it forward. */
const server = {
	syncStates: [] as SyncStateRow[],
	syncStateReads: 0,
	// A syncStates poll that lands just before the run's final row write must
	// not see it: this pins the server to `preFinalSyncStates` until a
	// `syncRun` read has observed the run closed, modeling the poll racing
	// ahead of the workflow's last commit.
	lagFinalWrite: false,
	preFinalSyncStates: [] as SyncStateRow[],
	closeObserved: false,
	runId: "run-1",
	/** What `syncRun` reports for `server.runId`. Tests move it forward. */
	runState: "running" as "running" | "closed" | "unknown",
	runStateReads: 0,
	findingsSeen: 1,
	caseResult: "NOT_RUN",
	featurePassed: 0,
	planPassRate: 0,
	sectionCountsRuns: 10,
	coverageEvidence: 0,
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
					return server.lagFinalWrite && !server.closeObserved
						? server.preFinalSyncStates
						: server.syncStates;
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
						mutationFn: async () => ({
							status: "started",
							workflowId: "pipeline-results-sync-p1",
							runId: server.runId,
						}),
						...opts,
					}),
				},
				// `enabled` is not how `@orpc/tanstack-query` spells "nothing to
				// ask yet" — `skipToken` as the input is, so the mock has to
				// honor it or the watch-less mount would poll forever.
				syncRun: {
					key: () => ["syncRun"],
					queryOptions: (opts: {
						input: unknown;
						refetchInterval?: unknown;
					}) =>
						opts.input === skipToken
							? {
									queryKey: ["syncRun", "skip"],
									queryFn: skipToken,
								}
							: {
									queryKey: ["syncRun", opts.input],
									queryFn: async () => {
										server.runStateReads += 1;
										if (server.runState === "closed") {
											server.closeObserved = true;
										}
										return { state: server.runState };
									},
									refetchInterval: opts.refetchInterval,
								},
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
				sectionCounts: queryOf("sectionCounts", () => ({
					runs: server.sectionCountsRuns,
				})),
				coverageIndex: {
					get: queryOf("coverageIndex", () => ({
						evidenceCount: server.coverageEvidence,
					})),
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
 * segments, the section badges beside them, and exactly one segment mounted
 * at a time.
 */
function TestingTab() {
	usePipelineIngestionRefresh("p1");
	const [segment, setSegment] = useState<"runs" | "cases" | "features">(
		"runs",
	);
	return (
		<>
			<RunsBadge />
			<QaMatrix />
			<LastSynced />
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

/** Stand-in for the Testing tab's "Runs N" section badge (Fizzy #2723). */
function RunsBadge() {
	const q = useQuery(
		orpc.projects.testCases.sectionCounts.queryOptions({ input: {} }),
	);
	return <div data-testid="runs-badge">{`Runs ${q.data?.runs}`}</div>;
}

/** Stand-in for the QA matrix's "Last proved by" evidence (Fizzy #2723). */
function QaMatrix() {
	const q = useQuery(
		orpc.projects.testCases.coverageIndex.get.queryOptions({ input: {} }),
	);
	return (
		<div data-testid="qa-matrix">{`Evidence ${q.data?.evidenceCount}`}</div>
	);
}

/**
 * Stand-in for the "Last synced" line and the failure banner, both of which
 * read the syncStates query directly rather than through any ingestion
 * product key.
 */
function LastSynced() {
	const q = useQuery(
		orpc.projects.pipelineResults.syncStates.queryOptions({ input: {} }),
	);
	const rows = q.data ?? [];
	const latestMs = rows.reduce((max, row) => {
		const ms = row.lastFetchedAt
			? new Date(row.lastFetchedAt).getTime()
			: 0;
		return ms > max ? ms : max;
	}, 0);
	return (
		<div data-testid="last-synced">
			{`LastSynced ${latestMs > 0 ? new Date(latestMs).toISOString() : "none"}`}
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
const T0_PRIME = new Date("2026-08-17T17:01:00Z");
const T1 = new Date("2026-08-17T17:05:00Z");
const T2 = new Date("2026-08-17T17:08:00Z");

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

/** Move the watched run to closed, as Temporal would report once it exits. */
function closeRun() {
	server.runState = "closed";
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
	server.lagFinalWrite = false;
	server.preFinalSyncStates = [];
	server.closeObserved = false;
	server.runId = "run-1";
	server.runState = "running";
	server.runStateReads = 0;
	server.findingsSeen = 1;
	server.caseResult = "NOT_RUN";
	server.featurePassed = 0;
	server.planPassRate = 0;
	server.sectionCountsRuns = 10;
	server.coverageEvidence = 0;
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

	it("does not re-read on a poll that found no row change", async () => {
		renderTab();
		expect(await screen.findByText("Seen 1")).toBeInTheDocument();

		await clickSync();
		// Something changed server-side that no sync produced; an unchanged
		// sync state must not turn every poll into a refetch of every view.
		server.findingsSeen = 5;
		await advance(9_100);

		expect(screen.getByTestId("findings")).toHaveTextContent("Seen 1");
	});

	it("ends up showing this run's ingest even though the page's cache was already behind the server at click time (Fizzy #2722)", async () => {
		renderTab();
		expect(await screen.findByText("Seen 1")).toBeInTheDocument();

		// Another writer (the 15-minute auto-sync, a teammate, another tab)
		// rewrites the row the page is still caching — WITHOUT the page
		// refetching (staleTime keeps the cache at T0).
		server.syncStates = [{ ...server.syncStates[0], updatedAt: T0_PRIME }];

		await clickSync();
		// The first poll after the click sees exactly that other writer's
		// row — a row newer than what the page had cached at click time, but
		// produced by NOTHING this sync did.
		await advance(3100);
		// This sync's own ingest lands after that.
		ingestLands();
		await advance(3100);

		expect(await screen.findByText("Seen 2")).toBeInTheDocument();
	});

	it("re-reads syncStates (Last synced / the failure banner) once the run closes, even when the last poll raced ahead of the run's final write (Fizzy #2722)", async () => {
		renderTab();
		expect(
			await screen.findByText(`LastSynced ${T0.toISOString()}`),
		).toBeInTheDocument();

		await clickSync();
		// The run's activity commits the final row, but the poll that samples
		// syncStates lands just before that commit is visible — modeled by
		// pinning every syncStates read to the pre-final snapshot until a
		// `syncRun` read has observed the run closed.
		server.lagFinalWrite = true;
		server.preFinalSyncStates = [...server.syncStates];
		server.syncStates = [
			{ ...server.syncStates[0], lastFetchedAt: T1, updatedAt: T1 },
		];
		closeRun();
		await advance(3100);

		expect(
			await screen.findByText(`LastSynced ${T1.toISOString()}`),
		).toBeInTheDocument();
	});

	it("does not stop watching just because a row is missing on the first poll of a first sync", async () => {
		// A project's very first sync, or one with a newly connected source:
		// there is no previous row for it to be compared against at all.
		server.syncStates = [];
		renderTab();

		await clickSync();
		// Source A ingests first; source B has not written anything yet.
		server.syncStates = [
			{
				id: "s1",
				provider: "GITHUB_ACTIONS",
				status: "OK",
				lastFetchedAt: T1,
				updatedAt: T1,
			},
		];
		await advance(3100);
		const readsAfterFirstSource = server.syncStateReads;

		// The poll must keep going rather than stopping here.
		await advance(3000);
		expect(server.syncStateReads).toBeGreaterThan(readsAfterFirstSource);

		// Source B finally ingests too.
		server.findingsSeen = 2;
		server.syncStates = [
			...server.syncStates,
			{
				id: "s2",
				provider: "GITLAB",
				status: "OK",
				lastFetchedAt: T2,
				updatedAt: T2,
			},
		];
		await advance(3000);

		expect(await screen.findByText("Seen 2")).toBeInTheDocument();
	});

	it("keeps waiting on a live source that merely lags another by more than 10 minutes", async () => {
		// One source synced 11 minutes ago; the other is about to sync now.
		// The old heuristic read the stale one as "finished" the moment the
		// live one advanced, purely from the gap between them.
		const laggingSource = {
			id: "s-lag",
			provider: "GITLAB",
			status: "OK",
			lastFetchedAt: new Date(T0.getTime() - 11 * 60_000),
			updatedAt: new Date(T0.getTime() - 11 * 60_000),
		};
		server.syncStates = [...server.syncStates, laggingSource];
		renderTab();

		await clickSync();
		await advance(3100);
		const readsWhileRunning = server.syncStateReads;
		// Still running, both rows unchanged — must not be read as settled.
		await advance(120_000);
		expect(server.syncStateReads).toBeGreaterThan(readsWhileRunning);
		expect(screen.getByTestId("findings")).toHaveTextContent("Seen 1");

		// The live source finally reports.
		ingestLands();
		await advance(10_100);
		expect(await screen.findByText("Seen 2")).toBeInTheDocument();
	});

	it("stops polling once the watched run closes", async () => {
		renderTab();
		expect(await screen.findByText("Seen 1")).toBeInTheDocument();

		await clickSync();
		ingestLands();
		closeRun();
		await advance(3100);
		expect(await screen.findByText("Seen 2")).toBeInTheDocument();

		const readsWhenClosed = server.syncStateReads;
		await advance(60_000);
		expect(server.syncStateReads).toBe(readsWhenClosed);
	});

	it("stops polling on run close even when one source's row is long stale and never rewritten", async () => {
		// A repository disconnected since its last sync keeps its row, and no
		// sync writes it again. Staging had one ten hours old.
		const stale = {
			id: "s-stale",
			provider: "GITHUB_ACTIONS",
			status: "OK",
			lastFetchedAt: new Date("2026-08-17T07:00:00Z"),
			updatedAt: new Date("2026-08-17T07:00:00Z"),
		};
		server.syncStates = [...server.syncStates, stale];
		renderTab();
		expect(await screen.findByText("Seen 1")).toBeInTheDocument();

		await clickSync();
		ingestLands();
		server.syncStates = [...server.syncStates, stale];
		closeRun();
		await advance(3100);
		expect(await screen.findByText("Seen 2")).toBeInTheDocument();

		const readsWhenClosed = server.syncStateReads;
		await advance(60_000);
		expect(server.syncStateReads).toBe(readsWhenClosed);
	});

	it("keeps polling while the run state is unknown, and the 10-minute cap still ends it", async () => {
		server.runState = "unknown";
		renderTab();

		await clickSync();
		await advance(590_000);
		const readsNearTheCap = server.runStateReads;
		expect(readsNearTheCap).toBeGreaterThan(1);

		await advance(30_000);
		const readsPastTheCap = server.runStateReads;
		await advance(60_000);
		expect(server.runStateReads).toBe(readsPastTheCap);
		// syncStates polling stopped the same way, on the same cap.
		const syncStateReadsPastCap = server.syncStateReads;
		await advance(60_000);
		expect(server.syncStateReads).toBe(syncStateReadsPastCap);
	});

	it("re-reads the Runs section badge and the QA matrix once the run closes (Fizzy #2723)", async () => {
		renderTab();
		expect(await screen.findByText("Runs 10")).toBeInTheDocument();
		expect(await screen.findByText("Evidence 0")).toBeInTheDocument();

		await clickSync();
		// No source row changes before the run closes here, so the
		// progressive path never fires — only the close can re-read these.
		await advance(9_000);
		expect(screen.getByTestId("runs-badge")).toHaveTextContent("Runs 10");
		expect(screen.getByTestId("qa-matrix")).toHaveTextContent("Evidence 0");

		server.sectionCountsRuns = 11;
		server.coverageEvidence = 1;
		closeRun();
		await advance(10_100);

		expect(await screen.findByText("Runs 11")).toBeInTheDocument();
		expect(await screen.findByText("Evidence 1")).toBeInTheDocument();
	});
});
