/**
 * Important 4 (round 4). The tab polled the snapshot LIST and stopped on any
 * terminal status, but `finalizeInstructionSnapshot` writes READY one activity
 * BEFORE `publishInstructionSnapshotActivity` moves the project's published
 * pointer — and `getPublished` was invalidated only immediately after
 * `finalize` returned, normally minutes before validation finished. So a first
 * upload kept showing "nothing published" and a replacement kept showing the
 * old tree until the viewer reloaded or refocused the tab.
 *
 * These tests drive the tab's two queries through a fake clock and assert what
 * it asks the server for: that seeing READY triggers an immediate re-read of
 * the pointer, that both queries keep polling until the pointer names that
 * snapshot, and that everything stops once it does.
 *
 * The three child components are stubbed. What is under test is the tab's
 * query behaviour, and rendering the real published view would drag in the
 * file tree, the settings dialog and the folder picker for no added coverage.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Snapshot = {
	id: string;
	version: number;
	status: string;
	publishOnReady: boolean;
};

const IDLE_SYNC = {
	sourceOfTruth: "UPLOAD",
	canConfigure: false,
	running: false,
	configured: null,
	latestRun: null,
	availableIntegrations: [],
};

const state = vi.hoisted(() => ({
	snapshots: [] as unknown[],
	published: null as unknown,
	sync: null as unknown,
	settingsPending: false,
	listCalls: 0,
	publishedCalls: 0,
	syncCalls: 0,
	listRunsCalls: 0,
	/** While set, `repositorySync.get` waits for it before answering. */
	syncGate: null as Promise<void> | null,
	/** How many `onChanged` promises the published-view stub saw resolve. */
	changedSettled: 0,
}));

/**
 * One `queryOptions` stub per procedure. The key carries the procedure NAME as
 * well as the input, because the tab invalidates `getPublished` by the key it
 * builds from the same helper — a shared key would make that invalidation hit
 * the list too and the test would pass for the wrong reason.
 */
function queryOptionsStub(name: string, queryFn: () => Promise<unknown>) {
	return (o: { input: unknown }) => ({
		queryKey: [name, o.input],
		queryFn,
	});
}

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				list: {
					queryOptions: queryOptionsStub("list", async () => {
						state.listCalls++;
						return state.snapshots;
					}),
				},
				getPublished: {
					queryOptions: queryOptionsStub("getPublished", async () => {
						state.publishedCalls++;
						return state.published;
					}),
				},
				getSettings: {
					queryOptions: queryOptionsStub("getSettings", () =>
						state.settingsPending
							? new Promise(() => undefined)
							: Promise.resolve({
									ignoreGlobs: null,
									defaultIgnoreGlobs: [],
									sourceOfTruth: null,
								}),
					),
				},
				proposals: {
					list: {
						queryOptions: queryOptionsStub(
							"proposals-list",
							async () => [],
						),
					},
				},
				repositorySync: {
					get: {
						queryOptions: queryOptionsStub(
							"repositorySync-get",
							async () => {
								state.syncCalls++;
								if (state.syncGate) {
									await state.syncGate;
								}
								return state.sync;
							},
						),
					},
					listRuns: {
						queryOptions: queryOptionsStub(
							"repositorySync-listRuns",
							async () => {
								state.listRunsCalls++;
								return { runs: [] };
							},
						),
					},
					syncNow: {
						mutationOptions: (
							opts: Record<string, unknown> = {},
						) => ({
							mutationFn: async () => ({ started: true }),
							...opts,
						}),
					},
				},
			},
		},
	},
}));

vi.mock("../ConfigureRepositorySyncDialog", () => ({
	ConfigureRepositorySyncDialog: () => null,
}));

vi.mock("../InstructionsPublishedView", async () => {
	// History's run list is a query only History mounts. The stub mounts
	// one observer of it, so the tab's invalidation has something to
	// refetch and the test can see the re-read (Fizzy #2694).
	const { useQuery } = await import("@tanstack/react-query");
	const { orpc } = await import("@shared/lib/orpc-query-utils");
	function RunsObserver({ projectId }: { projectId: string }) {
		useQuery(
			orpc.projects.instructions.repositorySync.listRuns.queryOptions({
				input: { projectId },
			}),
		);
		return null;
	}
	return {
		InstructionsPublishedView: ({
			projectId,
			published,
			repositoryBacked,
			repositoryConfirmed,
			repositorySync,
			canRead,
		}: {
			projectId: string;
			published: { id?: string } | null;
			repositoryBacked?: boolean;
			repositoryConfirmed?: boolean;
			canRead?: boolean;
			repositorySync?: {
				state: { latestRun: { id: string } | null };
				onChanged: () => Promise<void> | void;
			};
		}) => (
			<>
				<RunsObserver projectId={projectId} />
				<div data-testid="published-id">{published?.id ?? "none"}</div>
				<div data-testid="latest-run">
					{repositorySync?.state.latestRun?.id ?? "none"}
				</div>
				<button
					type="button"
					onClick={() => {
						// `Promise.resolve` so the stub also runs against a
						// handler that returns nothing.
						void Promise.resolve(repositorySync?.onChanged()).then(
							() => {
								state.changedSettled++;
							},
						);
					}}
				>
					settings-changed
				</button>
				<div data-testid="repository-backed">
					{String(repositoryBacked)}
				</div>
				<div data-testid="repository-confirmed">
					{String(repositoryConfirmed)}
				</div>
				<div data-testid="can-read">{String(canRead)}</div>
			</>
		),
	};
});
vi.mock("../InstructionsEmptyState", () => ({
	InstructionsEmptyState: () => <div data-testid="empty" />,
}));
vi.mock("../UploadFolderDialog", () => ({
	UploadFolderDialog: () => null,
}));

import { CodingInstructionsTab } from "../CodingInstructionsTab";

const POLL_MS = 3_000;
const IDLE_POLL_MS = 60_000;

function snapshot(id: string, status: string): Snapshot {
	return { id, version: 2, status, publishOnReady: true };
}

/**
 * Advance the fake clock and let React flush what that produced.
 *
 * `waitFor` is deliberately not used: Testing Library only auto-advances
 * JEST fake timers, so under `vi.useFakeTimers()` it waits on a clock nothing
 * is moving and times out. Driving the clock explicitly is also the point of
 * these tests — every assertion is about what happens after N polls.
 */
async function tick(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

function Wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	state.snapshots = [snapshot("snap_2", "VALIDATING")];
	state.published = { id: "snap_1", version: 1, status: "READY" };
	state.sync = IDLE_SYNC;
	state.settingsPending = false;
	state.listCalls = 0;
	state.publishedCalls = 0;
	state.syncCalls = 0;
	state.listRunsCalls = 0;
	state.syncGate = null;
	state.changedSettled = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("CodingInstructionsTab publication convergence", () => {
	it("re-reads the published pointer on seeing READY and keeps polling until it matches", async () => {
		render(
			<CodingInstructionsTab
				projectId="p"
				projectName="Checkout Rewrite"
			/>,
			{ wrapper: Wrapper },
		);
		await tick(0);
		expect(screen.getByTestId("published-id")).toHaveTextContent("snap_1");
		const publishedAfterMount = state.publishedCalls;

		// The workflow finishes validating and writes READY. The pointer has
		// NOT moved yet — the publish activity is the next step.
		state.snapshots = [snapshot("snap_2", "READY")];
		await tick(POLL_MS);

		// Seeing READY re-reads the pointer immediately rather than waiting a
		// whole further interval, because publication normally lands within a
		// second of the READY write.
		expect(state.publishedCalls).toBeGreaterThan(publishedAfterMount);

		// The pointer is still behind, so BOTH queries keep polling even
		// though the list is now entirely terminal.
		const before = {
			list: state.listCalls,
			published: state.publishedCalls,
		};
		await tick(POLL_MS);
		await tick(POLL_MS);
		expect(state.listCalls).toBeGreaterThan(before.list);
		expect(state.publishedCalls).toBeGreaterThan(before.published);

		// The publish activity moves the pointer.
		state.published = { id: "snap_2", version: 2, status: "READY" };
		await tick(POLL_MS);
		await tick(POLL_MS);
		expect(screen.getByTestId("published-id")).toHaveTextContent("snap_2");

		// Converged: nothing is polled any more.
		const settled = {
			list: state.listCalls,
			published: state.publishedCalls,
		};
		for (let i = 0; i < 5; i++) {
			await tick(POLL_MS);
		}
		expect(state.listCalls).toBe(settled.list);
		expect(state.publishedCalls).toBe(settled.published);
	});

	// The budget is what keeps this from re-creating the unbounded poll the
	// interval policy was extracted to end: a workflow that dies between the
	// READY write and the publish activity never moves the pointer, and the
	// tab must give up rather than poll that project forever, for every viewer.
	it("gives up after the bounded run of polls when publication never lands", async () => {
		render(
			<CodingInstructionsTab
				projectId="p"
				projectName="Checkout Rewrite"
			/>,
			{ wrapper: Wrapper },
		);
		await tick(0);

		state.snapshots = [snapshot("snap_2", "READY")];
		// Well past INSTRUCTIONS_PUBLISH_CONVERGENCE_POLLS, with the pointer
		// left behind on snap_1 throughout.
		for (let i = 0; i < 30; i++) {
			await tick(POLL_MS);
		}
		const settled = {
			list: state.listCalls,
			published: state.publishedCalls,
		};

		for (let i = 0; i < 5; i++) {
			await tick(POLL_MS);
		}
		expect(state.listCalls).toBe(settled.list);
		expect(state.publishedCalls).toBe(settled.published);
	});

	it.each(["REJECTED", "FAILED"])(
		"stops polling on %s, which never publishes",
		async (status) => {
			render(
				<CodingInstructionsTab
					projectId="p"
					projectName="Checkout Rewrite"
				/>,
				{
					wrapper: Wrapper,
				},
			);
			await tick(0);
			expect(screen.getByTestId("published-id")).toHaveTextContent(
				"snap_1",
			);

			state.snapshots = [snapshot("snap_2", status)];
			await tick(POLL_MS);
			const settled = {
				list: state.listCalls,
				published: state.publishedCalls,
			};

			for (let i = 0; i < 5; i++) {
				await tick(POLL_MS);
			}
			expect(state.listCalls).toBe(settled.list);
			expect(state.publishedCalls).toBe(settled.published);
		},
	);
});

describe("CodingInstructionsTab repository sync polling", () => {
	it("re-reads the sync state and the list while a run is open, and stops once it closes", async () => {
		state.snapshots = [snapshot("snap_1", "READY")];
		state.published = { id: "snap_1", version: 2, status: "READY" };
		state.sync = { ...IDLE_SYNC, running: true };
		render(
			<CodingInstructionsTab
				projectId="p"
				projectName="Checkout Rewrite"
			/>,
			{
				wrapper: Wrapper,
			},
		);
		await tick(0);
		const opened = { sync: state.syncCalls, list: state.listCalls };

		await tick(POLL_MS);
		await tick(POLL_MS);
		// Nothing in the list is in flight; only the open run keeps it polled,
		// so the snapshot the run creates appears without a reload.
		expect(state.syncCalls).toBeGreaterThan(opened.sync);
		expect(state.listCalls).toBeGreaterThan(opened.list);

		state.sync = IDLE_SYNC;
		await tick(POLL_MS);
		await tick(POLL_MS);
		const settled = {
			sync: state.syncCalls,
			list: state.listCalls,
			published: state.publishedCalls,
		};
		for (let i = 0; i < 5; i++) {
			await tick(POLL_MS);
		}
		expect(state.syncCalls).toBe(settled.sync);
		expect(state.listCalls).toBe(settled.list);
		expect(state.publishedCalls).toBe(settled.published);
	});

	it("reads the sync state once and never polls it with no run open", async () => {
		state.snapshots = [snapshot("snap_1", "READY")];
		state.published = { id: "snap_1", version: 2, status: "READY" };
		render(
			<CodingInstructionsTab
				projectId="p"
				projectName="Checkout Rewrite"
			/>,
			{
				wrapper: Wrapper,
			},
		);
		await tick(0);
		expect(state.syncCalls).toBe(1);
		for (let i = 0; i < 5; i++) {
			await tick(POLL_MS);
		}
		expect(state.syncCalls).toBe(1);
	});
});

describe("CodingInstructionsTab automatic sync discovery (Decision 39)", () => {
	const AUTOMATIC_SYNC = {
		...IDLE_SYNC,
		sourceOfTruth: "REPOSITORY",
		configured: { automatic: true, automaticPausedReason: null },
		latestRun: { id: "sync_1:run_a" },
	};

	beforeEach(() => {
		state.snapshots = [snapshot("snap_1", "READY")];
		state.published = { id: "snap_1", version: 2, status: "READY" };
		state.sync = AUTOMATIC_SYNC;
	});

	it("reads an idle automatic sync once a minute, and re-reads the tab when a run it never saw open appears", async () => {
		render(
			<CodingInstructionsTab
				projectId="p"
				projectName="Checkout Rewrite"
			/>,
			{ wrapper: Wrapper },
		);
		await tick(0);
		expect(state.syncCalls).toBe(1);
		const mounted = {
			list: state.listCalls,
			published: state.publishedCalls,
		};

		// No run is open, so nothing is read at the 3 s cadence.
		await tick(POLL_MS);
		expect(state.syncCalls).toBe(1);

		// A push started a run that published before the next idle read.
		state.sync = { ...AUTOMATIC_SYNC, latestRun: { id: "sync_1:run_b" } };
		await tick(IDLE_POLL_MS - POLL_MS);
		// The read fires at the very end of that advance. TanStack Query hands
		// its answer to React on a zero-delay timer, which Node runs after 1 ms.
		await tick(1);
		expect(state.syncCalls).toBe(2);
		expect(screen.getByTestId("latest-run")).toHaveTextContent(
			"sync_1:run_b",
		);
		// The tab never saw it open, so `running` never flipped; the new id
		// alone re-reads the list and the pointer.
		expect(state.listCalls).toBeGreaterThan(mounted.list);
		expect(state.publishedCalls).toBeGreaterThan(mounted.published);
	});

	it("surfaces a REF_MISSING receipt the scheduled check wrote, then stops polling while the sync is paused", async () => {
		render(
			<CodingInstructionsTab
				projectId="p"
				projectName="Checkout Rewrite"
			/>,
			{ wrapper: Wrapper },
		);
		await tick(0);

		// Task 2's failure receipt: `<syncId>:<pollRunId>:<generation>`.
		state.sync = {
			...AUTOMATIC_SYNC,
			configured: {
				automatic: true,
				automaticPausedReason: "REF_MISSING",
			},
			latestRun: { id: "sync_1:poll_run_1:3" },
		};
		await tick(IDLE_POLL_MS);
		await tick(1);
		expect(screen.getByTestId("latest-run")).toHaveTextContent(
			"sync_1:poll_run_1:3",
		);

		const paused = state.syncCalls;
		for (let i = 0; i < 3; i++) {
			await tick(IDLE_POLL_MS);
		}
		expect(state.syncCalls).toBe(paused);
	});

	it.each([
		["not configured", IDLE_SYNC],
		[
			"manual",
			{
				...IDLE_SYNC,
				configured: { automatic: false, automaticPausedReason: null },
			},
		],
	])("never idle-polls a sync that is %s", async (_label, sync) => {
		state.sync = sync;
		render(
			<CodingInstructionsTab
				projectId="p"
				projectName="Checkout Rewrite"
			/>,
			{ wrapper: Wrapper },
		);
		await tick(0);
		for (let i = 0; i < 3; i++) {
			await tick(IDLE_POLL_MS);
		}
		expect(state.syncCalls).toBe(1);
	});
});

describe("CodingInstructionsTab settings changes (Decision 53)", () => {
	it("resolves onChanged only once the sync state it changed has been read again", async () => {
		state.snapshots = [snapshot("snap_1", "READY")];
		state.published = { id: "snap_1", version: 2, status: "READY" };
		render(
			<CodingInstructionsTab
				projectId="p"
				projectName="Checkout Rewrite"
			/>,
			{ wrapper: Wrapper },
		);
		await tick(0);
		const before = state.syncCalls;
		const runsBefore = state.listRunsCalls;

		let release: () => void = () => {};
		state.syncGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await act(async () => {
			screen.getByRole("button", { name: "settings-changed" }).click();
		});
		await tick(0);

		// The re-read started and is held, so the change is still pending.
		expect(state.syncCalls).toBe(before + 1);
		await tick(1_000);
		expect(state.changedSettled).toBe(0);

		release();
		await tick(0);
		expect(state.changedSettled).toBe(1);
		// History's run list was re-read with the change, not left to the
		// next idle poll (Fizzy #2694).
		expect(state.listRunsCalls).toBe(runsBefore + 1);
	});
});

describe("CodingInstructionsTab source-of-truth while settings load", () => {
	// The actions fail closed (treated as repository-backed until settings
	// load), but the rejected banner's copy must not claim the files live in
	// the repository before that is known.
	it("hides actions but does not confirm repository mode while settings are loading", async () => {
		state.settingsPending = true;
		render(
			<CodingInstructionsTab
				projectId="p"
				projectName="Checkout Rewrite"
			/>,
			{ wrapper: Wrapper },
		);
		await tick(0);
		expect(screen.getByTestId("repository-backed")).toHaveTextContent(
			"true",
		);
		expect(screen.getByTestId("repository-confirmed")).toHaveTextContent(
			"false",
		);
	});

	it("leaves both off once the settings resolve to upload mode", async () => {
		render(
			<CodingInstructionsTab
				projectId="p"
				projectName="Checkout Rewrite"
			/>,
			{ wrapper: Wrapper },
		);
		await tick(0);
		expect(screen.getByTestId("repository-backed")).toHaveTextContent(
			"false",
		);
		expect(screen.getByTestId("repository-confirmed")).toHaveTextContent(
			"false",
		);
	});
});

// Fizzy #2563 spec §12: a reader may suggest a change on a repository-backed
// project once the project allows it. Whether the viewer can read is what the
// INSTRUCTION_READ-gated sync state answers by loading at all; the project's
// `canEditInstructions` flag says nothing about READ.
describe("CodingInstructionsTab reader proposals", () => {
	it("tells the published view the viewer can read only once the read-gated sync state has loaded", async () => {
		let open: () => void = () => undefined;
		state.syncGate = new Promise<void>((resolve) => {
			open = resolve;
		});
		render(
			<CodingInstructionsTab
				projectId="p"
				projectName="Checkout Rewrite"
			/>,
			{ wrapper: Wrapper },
		);
		await tick(0);
		expect(screen.getByTestId("can-read")).toHaveTextContent("false");
		open();
		await tick(0);
		expect(screen.getByTestId("can-read")).toHaveTextContent("true");
	});
});

/**
 * Publish first, scan afterwards (Fizzy #2737). A version published before
 * its secret scan is READY and IS the pointer while that scan runs, so
 * neither the list's terminal status nor the convergence rule keeps the tab
 * polling; the pending scan has to, until its verdict lands.
 */
describe("CodingInstructionsTab deferred secret scan", () => {
	function scanned(deferredScanStatus: string) {
		return {
			...snapshot("snap_2", "READY"),
			publishBeforeScan: true,
			deferredScanStatus,
			readyAt: new Date(Date.now()),
		};
	}

	it("keeps polling both queries while the published version's scan is pending, and stops on its verdict", async () => {
		state.snapshots = [scanned("PENDING")];
		state.published = scanned("PENDING");
		render(
			<CodingInstructionsTab
				projectId="p"
				projectName="Checkout Rewrite"
			/>,
			{ wrapper: Wrapper },
		);
		await tick(0);
		expect(screen.getByTestId("published-id")).toHaveTextContent("snap_2");

		const before = {
			list: state.listCalls,
			published: state.publishedCalls,
		};
		for (let i = 0; i < 3; i++) {
			await tick(POLL_MS);
		}
		expect(state.listCalls).toBeGreaterThan(before.list);
		expect(state.publishedCalls).toBeGreaterThan(before.published);

		state.snapshots = [scanned("PASSED")];
		state.published = scanned("PASSED");
		await tick(POLL_MS);
		await tick(POLL_MS);
		const settled = {
			list: state.listCalls,
			published: state.publishedCalls,
		};
		for (let i = 0; i < 5; i++) {
			await tick(POLL_MS);
		}
		expect(state.listCalls).toBe(settled.list);
		expect(state.publishedCalls).toBe(settled.published);
	});

	// The published version need not be in the list the tab holds (a newer
	// version saved without publishing sits above it), and the published view
	// renders its alert off the pointer row: that row alone keeps the poll.
	it("keeps polling on the pointer row's pending scan when the list holds nothing in flight", async () => {
		state.snapshots = [
			{
				id: "snap_3",
				version: 3,
				status: "READY",
				publishOnReady: false,
			},
		];
		state.published = scanned("PENDING");
		render(
			<CodingInstructionsTab
				projectId="p"
				projectName="Checkout Rewrite"
			/>,
			{ wrapper: Wrapper },
		);
		await tick(0);
		const before = {
			list: state.listCalls,
			published: state.publishedCalls,
		};
		for (let i = 0; i < 3; i++) {
			await tick(POLL_MS);
		}
		expect(state.listCalls).toBeGreaterThan(before.list);
		expect(state.publishedCalls).toBeGreaterThan(before.published);
	});

	// The two queries poll separately, so a verdict can reach one a tick
	// before the other. The tab re-reads both at once rather than showing
	// the published view and History disagreeing until the next interval.
	it("re-reads both queries at once when the list and the pointer disagree about the scan", async () => {
		state.snapshots = [scanned("ISSUES_FOUND")];
		state.published = scanned("PENDING");
		render(
			<CodingInstructionsTab
				projectId="p"
				projectName="Checkout Rewrite"
			/>,
			{ wrapper: Wrapper },
		);
		// Well inside the first interval: only the mount reads and the
		// disagreement's re-reads can have happened.
		await tick(10);
		expect(state.listCalls).toBe(2);
		expect(state.publishedCalls).toBe(2);
	});
});
