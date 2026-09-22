/**
 * REST-GitLab branch of `fetchPMItemsByIds` (Fizzy #2304, spec D2.2).
 *
 * The hourly poll passes `concurrency: 8`, `callTimeoutMs: 20_000` and
 * `budgetMs: 240_000`, and its fetch activity declares a 60 s heartbeat
 * timeout. The REST branch used to ignore all three and never heartbeat, so
 * a REST project with a few hundred linked issues was killed on every poll.
 *
 * `callPmToolWithFallback` is mocked HERE on purpose: this file pins the
 * read pool (an abandoned read keeps its slot until it settles), the timeout,
 * the budget and the ticker. The real adapter chain (where mocking it is
 * forbidden) runs in `pm-status-sync-seam.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const activity = vi.hoisted(() => ({
	/** False simulates a caller outside any Temporal activity (API routes). */
	inside: true,
	/** Heartbeats that reached a live activity context. */
	heartbeat: vi.fn(),
	/**
	 * Every `heartbeat()` CALL, recorded before the outside-an-activity throw.
	 * `heartbeat` alone cannot tell "the ticker never ran" from "it ran and its
	 * calls threw", because a throwing call never reaches that spy.
	 */
	heartbeatAttempt: vi.fn(),
}));

vi.mock("@temporalio/activity", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@temporalio/activity")>();
	const outside = () => new Error("not running inside an activity");
	return {
		...actual,
		heartbeat: (details?: unknown) => {
			activity.heartbeatAttempt(details);
			if (!activity.inside) {
				throw outside();
			}
			activity.heartbeat(details);
		},
		Context: {
			current: () => {
				if (!activity.inside) {
					throw outside();
				}
				return {
					heartbeat: (details?: unknown) =>
						activity.heartbeat(details),
				};
			},
		},
	};
});

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		log: vi.fn(),
	},
}));

// MCP plumbing: story-sync imports it at module load; the REST branch never
// reaches it.
vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	getMcpClientResult: vi.fn(),
	closeMcpClientSafe: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

const dbState = vi.hoisted(() => {
	/**
	 * Reads-only `select` projection (pattern:
	 * publishing-shared/__tests__/contributor-names.test.ts:144-155). A
	 * selected field the fixture row lacks throws instead of reading as
	 * `undefined`.
	 */
	const pick = (
		row: Record<string, unknown>,
		select: Record<string, unknown> | undefined,
	): Record<string, unknown> => {
		if (!select) {
			return { ...row };
		}
		const out: Record<string, unknown> = {};
		for (const [key, wanted] of Object.entries(select)) {
			if (wanted !== true) {
				continue;
			}
			if (!(key in row)) {
				throw new Error(`fake db: fixture row has no field "${key}"`);
			}
			out[key] = row[key];
		}
		return out;
	};
	return {
		pick,
		project: {} as Record<string, unknown>,
		linked: [] as Array<Record<string, unknown>>,
	};
});

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	Prisma: {},
	db: {
		project: {
			findUnique: async (args: { select?: Record<string, unknown> }) =>
				dbState.pick(dbState.project, args.select),
		},
	},
	getLinkedExternalIds: async () => dbState.linked,
	getStoryById: vi.fn(),
	getMcpConfigById: vi.fn(),
	updateStory: vi.fn(),
	updateTask: vi.fn(),
	autoDismissReappearedFlagMissing: vi.fn(),
	createPmSyncConflictNotifications: vi.fn(),
	findFabricItemByExternalId: vi.fn(),
	findFabricItemsByExternalId: vi.fn(),
	incrementMissingStreak: vi.fn(),
	pendingFlagMissingExists: vi.fn(),
	recordAudit: vi.fn(),
	resetMissingStreaks: vi.fn(),
	upsertPendingChange: vi.fn(),
	mergePmStatusSyncLastRun: vi.fn(),
}));

const rest = vi.hoisted(() => ({
	callPmToolWithFallback: vi.fn(),
	resolvePmSource: vi.fn(),
}));
vi.mock("../../pm-tool-fallback", () => ({
	callPmToolWithFallback: rest.callPmToolWithFallback,
}));
vi.mock("../../pm-source", () => ({
	resolvePmSource: rest.resolvePmSource,
	resolvePmServerKey: vi.fn(async () => "gitlab-official"),
	PMSourceNotFound: class PMSourceNotFound extends Error {},
}));

import { isNotAttemptedError } from "../pm-fetch-complete";
import { fetchAdoWorkItemStates } from "../pm-state-poll";
import { fetchPMItemsByIds } from "../story-sync";

const REST_SOURCE = {
	kind: "rest-gitlab" as const,
	token: "tok-test",
	baseUrl: "https://gitlab.com/api/v4",
	projectId: "example-group/example-project",
};

const BASE_INPUT = {
	mcpConfigId: null,
	mcpServerId: "key:gitlab-official",
	containerId: "example-group/example-project",
	userId: "owner-1",
	organizationId: "org-1",
};

/** What `getGitLabIssueForPM` returns for one issue. */
function issueFor(iid: string) {
	return {
		title: `Issue ${iid}`,
		description: "Body",
		externalUrl: `https://gitlab.com/example-group/example-project/-/issues/${iid}`,
		labels: ["workflow::todo"],
		state: "opened",
		updatedAt: "2026-09-20T10:00:00.000Z",
	};
}

type RestCall = { call: { tool: string; externalId: string } };

/** Every read resolves after `ms`; tracks how many are in flight at once. */
function trackedReads(ms: number) {
	const tracker = { inFlight: 0, max: 0 };
	rest.callPmToolWithFallback.mockImplementation(
		async ({ call }: RestCall) => {
			tracker.inFlight++;
			tracker.max = Math.max(tracker.max, tracker.inFlight);
			await new Promise((resolve) => setTimeout(resolve, ms));
			tracker.inFlight--;
			return issueFor(call.externalId);
		},
	);
	return tracker;
}

const PROJECT_ROW = {
	organizationId: "org-1",
	userId: "owner-1",
	pmTerminalStatuses: [],
	pmAutoCloseEnabled: false,
	pmStatusSyncEnabled: false,
	pmStatusSyncSessionAt: null,
	pmStatusSyncLastRun: null,
	projectManagementAdditionalContext: null,
	projectManagementMcpConfigId: null,
	projectManagementMcpServerId: "key:gitlab-official",
};

function linkedRows(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		entityType: "STORY",
		entityId: `story-${i + 1}`,
		externalId: String(i + 1),
		draftingStage: "DRAFT",
		pmAutoHidden: false,
		lastSyncedPmHash: null,
		lastPmSyncStatus: null,
	}));
}

const POLL_INPUT = {
	projectId: "proj-1",
	mcpConfigId: null,
	mcpServerId: "key:gitlab-official",
	pmTool: "gitlab-official",
	sourceKind: "rest-gitlab" as const,
	containerId: "example-group/example-project",
	containerName: null,
	lastAdoStatePollAt: null,
	userId: "owner-1",
	organizationId: "org-1",
};

beforeEach(() => {
	activity.inside = true;
	rest.resolvePmSource.mockResolvedValue(REST_SOURCE);
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("fetchPMItemsByIds — REST GitLab branch (Fizzy #2304, D2.2)", () => {
	it("defaults stay serial, keep input order and keep the not-found / transient split", async () => {
		const tracker = { inFlight: 0, max: 0 };
		rest.callPmToolWithFallback.mockImplementation(
			async ({ call }: RestCall) => {
				tracker.inFlight++;
				tracker.max = Math.max(tracker.max, tracker.inFlight);
				await new Promise((resolve) => setTimeout(resolve, 10));
				tracker.inFlight--;
				if (call.externalId === "2") {
					return null; // the adapter's "issue absent" signal
				}
				if (call.externalId === "3") {
					throw new Error("502 Bad Gateway");
				}
				return issueFor(call.externalId);
			},
		);

		const res = await fetchPMItemsByIds({
			...BASE_INPUT,
			externalIds: ["1", "2", "3", "4"],
		});

		expect(res.items.map((i) => i.id)).toEqual(["1", "4"]);
		expect(res.items[0]).toEqual({
			id: "1",
			displayId: "1",
			title: "Issue 1",
			description: "Body",
			url: "https://gitlab.com/example-group/example-project/-/issues/1",
			workItemType: "Issue",
			raw: issueFor("1"),
		});
		expect(res.failedIds).toEqual(["2", "3"]);
		expect(res.notFoundIds).toEqual(["2"]);
		expect(res.failedIdErrors).toEqual({
			"2": "not found",
			"3": "502 Bad Gateway",
		});
		expect(tracker.max).toBe(1);
	});

	it("runs up to `concurrency` issue reads at once and keeps input order", async () => {
		const tracker = trackedReads(20);

		const res = await fetchPMItemsByIds({
			...BASE_INPUT,
			externalIds: ["1", "2", "3", "4", "5", "6"],
			concurrency: 3,
		});

		expect(res.items.map((i) => i.id)).toEqual([
			"1",
			"2",
			"3",
			"4",
			"5",
			"6",
		]);
		expect(tracker.max).toBe(3);
	});

	it("heartbeats every 10 s while a read is in flight and abandons it at callTimeoutMs as a transient failure", async () => {
		vi.useFakeTimers();
		rest.callPmToolWithFallback.mockImplementation(
			() => new Promise(() => {}), // GitLab accepted the socket and went quiet
		);
		let settled = false;
		const pending = fetchPMItemsByIds({
			...BASE_INPUT,
			externalIds: ["7"],
			callTimeoutMs: 35_000,
		}).then((res) => {
			settled = true;
			return res;
		});

		await vi.advanceTimersByTimeAsync(34_999);
		// Exactly the 10 s cadence: the immediate check-in at 0 s, then ticks at
		// 10 s, 20 s and 30 s.
		expect(activity.heartbeat).toHaveBeenCalledTimes(4);
		expect(activity.heartbeat).toHaveBeenCalledWith({
			phase: "rest-gitlab-fetch",
			total: 1,
		});
		expect(settled).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		const res = await pending;
		expect(res.failedIds).toEqual(["7"]);
		expect(res.failedIdErrors).toEqual({
			"7": "GitLab fetch timed out after 35000ms (abandoned)",
		});
		expect(res.items).toEqual([]);
		// Abandoned is transient — it must never feed the FLAG_MISSING streak.
		expect(res.notFoundIds).toEqual([]);

		// The read never settles, yet the fetch returned — it does not await an
		// abandoned read — and its ticker stopped with it.
		const beats = activity.heartbeat.mock.calls.length;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(activity.heartbeat.mock.calls.length).toBe(beats);
	});

	it("an abandoned read keeps its slot: with every read hung, a 9th never starts and the fetch returns at the budget", async () => {
		vi.useFakeTimers();
		rest.callPmToolWithFallback.mockImplementation(
			() => new Promise(() => {}), // GitLab accepted every socket and went quiet
		);
		const ids = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
		let settled = false;
		const pending = fetchPMItemsByIds({
			...BASE_INPUT,
			externalIds: ids,
			concurrency: 8,
			callTimeoutMs: 20_000,
			budgetMs: 60_000,
		}).then((res) => {
			settled = true;
			return res;
		});

		// Positive control: the pool does start reads — exactly eight, the first
		// eight ids. They are abandoned at 20 s but never settle, so their slots
		// stay taken and id 9 cannot start.
		await vi.advanceTimersByTimeAsync(59_999);
		expect(
			rest.callPmToolWithFallback.mock.calls.map(
				(c) => (c[0] as RestCall).call.externalId,
			),
		).toEqual(ids.slice(0, 8));
		expect(settled).toBe(false);

		// At the budget the unstarted id is recorded, every id is accounted for,
		// and the fetch resolves without waiting for the eight hung reads.
		await vi.advanceTimersByTimeAsync(1);
		const res = await pending;
		expect(settled).toBe(true);
		expect(rest.callPmToolWithFallback).toHaveBeenCalledTimes(8);
		expect(res.items).toEqual([]);
		expect(res.failedIds).toEqual(ids);
		expect(res.notFoundIds).toEqual([]);
		expect(res.failedIdErrors).toEqual({
			...Object.fromEntries(
				ids
					.slice(0, 8)
					.map((id) => [
						id,
						"GitLab fetch timed out after 20000ms (abandoned)",
					]),
			),
			"9": "poll budget exceeded (not attempted)",
		});

		// The ticker stopped when the fetch returned.
		const beats = activity.heartbeat.mock.calls.length;
		expect(beats).toBeGreaterThan(0);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(activity.heartbeat.mock.calls.length).toBe(beats);
	});

	it("the deadline timer is authoritative: a wall clock that lags the timers cannot stall a fully hung pool", async () => {
		vi.useFakeTimers();
		rest.callPmToolWithFallback.mockImplementation(
			() => new Promise(() => {}), // GitLab accepted every socket and went quiet
		);
		const ids = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
		const run = () => {
			const state = { settled: false };
			const pending = fetchPMItemsByIds({
				...BASE_INPUT,
				externalIds: ids,
				concurrency: 8,
				callTimeoutMs: 20_000,
				budgetMs: 60_000,
			}).then((res) => {
				state.settled = true;
				return res;
			});
			return { state, pending };
		};

		// Positive control: with the wall clock in step with the timers, the
		// fetch resolves at the budget.
		const inStep = run();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(inStep.state.settled).toBe(true);
		expect((await inStep.pending).failedIds).toEqual(ids);

		// Node timers run on the monotonic clock; `Date.now()` is wall-clock. The
		// deadline timer can fire while `Date.now()` still reads deadlineAt - 1
		// (measured: about 2 in 2000 timers on Node 22), and an NTP step back does
		// the same. Every slot is held by a hung read, so nothing else will ever
		// wake the pool: the timer firing must itself count as the deadline.
		rest.callPmToolWithFallback.mockClear();
		const skewed = run();
		await vi.advanceTimersByTimeAsync(59_999);
		expect(skewed.state.settled).toBe(false);
		vi.setSystemTime(Date.now() - 1); // the wall clock now lags by 1 ms
		await vi.advanceTimersByTimeAsync(1);

		expect(skewed.state.settled).toBe(true);
		const res = await skewed.pending;
		expect(rest.callPmToolWithFallback).toHaveBeenCalledTimes(8);
		expect(res.items).toEqual([]);
		expect(res.failedIds).toEqual(ids);
		expect(res.notFoundIds).toEqual([]);
		expect(res.failedIdErrors).toEqual({
			...Object.fromEntries(
				ids
					.slice(0, 8)
					.map((id) => [
						id,
						"GitLab fetch timed out after 20000ms (abandoned)",
					]),
			),
			"9": "poll budget exceeded (not attempted)",
		});
	});

	it("a slot frees when the abandoned read settles, not at the timeout — and the late result is ignored", async () => {
		vi.useFakeTimers();
		const t0 = Date.now();
		const started: Array<{ id: string; at: number }> = [];
		rest.callPmToolWithFallback.mockImplementation(
			async ({ call }: RestCall) => {
				started.push({ id: call.externalId, at: Date.now() - t0 });
				// Issue 1 answers at 15 s — after its 10 s timeout; issue 2 in 1 s.
				await new Promise((resolve) =>
					setTimeout(
						resolve,
						call.externalId === "1" ? 15_000 : 1_000,
					),
				);
				return issueFor(call.externalId);
			},
		);

		const pending = fetchPMItemsByIds({
			...BASE_INPUT,
			externalIds: ["1", "2"],
			concurrency: 1,
			callTimeoutMs: 10_000,
		});
		await vi.advanceTimersByTimeAsync(20_000);
		const res = await pending;

		// Positive control: the second read did run — but only once the first
		// request settled at 15 s, not when it was abandoned at 10 s.
		expect(started).toEqual([
			{ id: "1", at: 0 },
			{ id: "2", at: 15_000 },
		]);
		// Issue 1's late answer is ignored: it stays an abandoned failure.
		expect(res.items.map((i) => i.id)).toEqual(["2"]);
		expect(res.failedIds).toEqual(["1"]);
		expect(res.failedIdErrors).toEqual({
			"1": "GitLab fetch timed out after 10000ms (abandoned)",
		});
		expect(res.notFoundIds).toEqual([]);
	});

	it("is a safe no-op outside an activity: same result, no heartbeat", async () => {
		trackedReads(5);
		const input = {
			...BASE_INPUT,
			externalIds: ["1"],
			callTimeoutMs: 20_000,
		};

		// Positive control: inside an activity the same fetch does check in, and
		// the attempt spy sees it.
		const inside = await fetchPMItemsByIds(input);
		expect(inside.items.map((i) => i.id)).toEqual(["1"]);
		expect(activity.heartbeatAttempt).toHaveBeenCalledWith({
			phase: "rest-gitlab-fetch",
			total: 1,
		});
		expect(activity.heartbeat).toHaveBeenCalledWith({
			phase: "rest-gitlab-fetch",
			total: 1,
		});

		activity.heartbeat.mockClear();
		activity.heartbeatAttempt.mockClear();
		activity.inside = false;
		const res = await fetchPMItemsByIds(input);

		expect(res).toEqual(inside);
		// Not merely "no heartbeat got through": outside an activity the ticker
		// never runs, so `heartbeat()` is never even called.
		expect(activity.heartbeatAttempt).not.toHaveBeenCalled();
	});

	it("stops issuing reads once the budget is spent; unattempted ids are transient failures", async () => {
		vi.useFakeTimers();
		trackedReads(10_000);

		// Reads start at 0 s, 10 s and 20 s (< 25 s); at 25 s the budget is
		// spent, so ids 4 and 5 are never attempted. The fetch returns when the
		// third read settles at 30 s.
		const pending = fetchPMItemsByIds({
			...BASE_INPUT,
			externalIds: ["1", "2", "3", "4", "5"],
			budgetMs: 25_000,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		const res = await pending;

		expect(res.items.map((i) => i.id)).toEqual(["1", "2", "3"]);
		expect(rest.callPmToolWithFallback).toHaveBeenCalledTimes(3);
		expect(res.failedIds).toEqual(["4", "5"]);
		expect(res.failedIdErrors).toEqual({
			"4": "poll budget exceeded (not attempted)",
			"5": "poll budget exceeded (not attempted)",
		});
		expect(res.notFoundIds).toEqual([]);
	});

	it("charges REST source resolution to the budget: a slow resolve leaves fewer reads", async () => {
		vi.useFakeTimers();
		trackedReads(10_000);
		const input = {
			...BASE_INPUT,
			externalIds: ["1", "2", "3", "4", "5"],
			budgetMs: 25_000,
		};

		// Positive control: source resolved at once, so reads start at 0 s,
		// 10 s and 20 s — three fit the 25 s budget.
		const prompt = fetchPMItemsByIds(input);
		await vi.advanceTimersByTimeAsync(60_000);
		expect((await prompt).items.map((i) => i.id)).toEqual(["1", "2", "3"]);

		// Resolution takes 20 s of the 25 s budget. The deadline is fixed at
		// entry (DEC-7), not after resolution, so only the read at 20 s starts;
		// the deadline at 25 s leaves ids 2-5 unattempted.
		rest.callPmToolWithFallback.mockClear();
		rest.resolvePmSource.mockImplementationOnce(
			() =>
				new Promise((resolve) =>
					setTimeout(() => resolve(REST_SOURCE), 20_000),
				),
		);
		const slow = fetchPMItemsByIds(input);
		await vi.advanceTimersByTimeAsync(60_000);
		const res = await slow;

		expect(res.items.map((i) => i.id)).toEqual(["1"]);
		expect(rest.callPmToolWithFallback).toHaveBeenCalledTimes(1);
		expect(res.failedIds).toEqual(["2", "3", "4", "5"]);
		expect(res.failedIdErrors).toEqual({
			"2": "poll budget exceeded (not attempted)",
			"3": "poll budget exceeded (not attempted)",
			"4": "poll budget exceeded (not attempted)",
			"5": "poll budget exceeded (not attempted)",
		});
		expect(res.notFoundIds).toEqual([]);
	});

	describe("a GitLab rate limit (HTTP 429) stops the pool starting reads", () => {
		/**
		 * The shape `@repo/integrations/gitlab` throws for a non-2xx answer
		 * (`GitLabApiError`: `name` plus a numeric `status`). Its producer side
		 * — `gitlabFetch` turning a plain-text 429 into this — is pinned in
		 * `packages/integrations/src/gitlab/__tests__/gitlab-fetch.test.ts`.
		 */
		class GitLabApiError extends Error {
			override name = "GitLabApiError";
			constructor(
				readonly status: number,
				message: string,
			) {
				super(message);
			}
		}
		const IDS = ["1", "2", "3", "4", "5", "6"];

		/**
		 * Id 1 is slow (30 ms); id 2 fails at 10 ms with `failure`; every other
		 * read succeeds after 10 ms. With two slots, ids 1 and 2 start at 0 ms.
		 */
		function routeReads(failure: Error) {
			rest.callPmToolWithFallback.mockImplementation(
				async ({ call }: RestCall) => {
					if (call.externalId === "1") {
						await new Promise((resolve) => setTimeout(resolve, 30));
						return issueFor("1");
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
					if (call.externalId === "2") {
						throw failure;
					}
					return issueFor(call.externalId);
				},
			);
		}
		const started = () =>
			rest.callPmToolWithFallback.mock.calls.map(
				(c) => (c[0] as RestCall).call.externalId,
			);

		it("positive control: a failure that is not a 429 does not stop the pool", async () => {
			for (const failure of [
				new GitLabApiError(500, "500 Internal Server Error"),
				new GitLabApiError(403, "403 Forbidden"),
				// Mentions a rate limit, but is not GitLab's 429 answer.
				new Error("upstream proxy said: 429 rate limit"),
			]) {
				rest.callPmToolWithFallback.mockClear();
				routeReads(failure);

				const res = await fetchPMItemsByIds({
					...BASE_INPUT,
					externalIds: IDS,
					concurrency: 2,
				});

				expect(started()).toEqual(IDS);
				expect(res.items.map((i) => i.id)).toEqual([
					"1",
					"3",
					"4",
					"5",
					"6",
				]);
				expect(res.failedIds).toEqual(["2"]);
				expect(res.failedIdErrors).toEqual({ "2": failure.message });
			}
		});

		it("after a 429 no further read starts; a read in flight settles normally; every unstarted id is deferred as not attempted", async () => {
			routeReads(new GitLabApiError(429, "Retry later"));

			const res = await fetchPMItemsByIds({
				...BASE_INPUT,
				externalIds: IDS,
				concurrency: 2,
			});

			// Only the two reads started before the 429 went out.
			expect(started()).toEqual(["1", "2"]);
			// Id 1 was in flight when id 2 hit the limit: it still landed.
			expect(res.items.map((i) => i.id)).toEqual(["1"]);
			expect(res.failedIds).toEqual(["2", "3", "4", "5", "6"]);
			// Deferred, never not-found: nothing feeds the FLAG_MISSING streak.
			expect(res.notFoundIds).toEqual([]);
			const deferred = "GitLab rate limit reached (not attempted)";
			expect(res.failedIdErrors).toEqual({
				// The 429 read itself was attempted: a genuine failure.
				"2": "Retry later",
				"3": deferred,
				"4": deferred,
				"5": deferred,
				"6": deferred,
			});
			expect(isNotAttemptedError(res.failedIdErrors?.["2"])).toBe(false);
			expect(isNotAttemptedError(deferred)).toBe(true);
		});

		it("the serial default path stops after a 429 too", async () => {
			routeReads(new GitLabApiError(429, "Retry later"));

			const res = await fetchPMItemsByIds({
				...BASE_INPUT,
				externalIds: IDS,
			});

			expect(started()).toEqual(["1", "2"]);
			expect(res.items.map((i) => i.id)).toEqual(["1"]);
			expect(res.failedIds).toEqual(["2", "3", "4", "5", "6"]);
			expect(res.notFoundIds).toEqual([]);
		});
	});

	it("a budget stop surfaces as an incomplete poll fetch, so the watermark holds", async () => {
		vi.useFakeTimers();
		dbState.project = { ...PROJECT_ROW };
		// Just under PM_POLL_CALL_TIMEOUT_MS (20 s): nothing is abandoned, so
		// every shortfall below is the budget's.
		trackedReads(19_000);

		// Positive control: 104 issues = 13 waves of 8, the last starting at
		// 228 s (< the 240 s budget). All are read → complete.
		dbState.linked = linkedRows(104);
		const fits = fetchAdoWorkItemStates(POLL_INPUT);
		await vi.advanceTimersByTimeAsync(2_500_000);
		const full = await fits;
		expect(full.seenExternalIds).toHaveLength(104);
		expect(full.failedIds).toEqual([]);
		expect(full.complete).toBe(true);

		// 120 issues: the same 13 waves fit; a 14th would start at 247 s, past
		// the budget, so ids 105-120 are never attempted.
		dbState.linked = linkedRows(120);
		const over = fetchAdoWorkItemStates(POLL_INPUT);
		await vi.advanceTimersByTimeAsync(2_500_000);
		const partial = await over;
		expect(partial.seenExternalIds).toHaveLength(104);
		expect(partial.failedIds).toEqual(
			Array.from({ length: 16 }, (_, i) => String(105 + i)),
		);
		expect(partial.notFoundIds).toEqual([]);
		expect(partial.complete).toBe(false);
	});

	it("forwards requireFreshToken to the REST source resolution, and only when asked", async () => {
		rest.callPmToolWithFallback.mockImplementation(
			async ({ call }: RestCall) => issueFor(call.externalId),
		);

		await fetchPMItemsByIds({
			...BASE_INPUT,
			externalIds: ["1"],
			requireFreshToken: true,
		});
		expect(rest.resolvePmSource).toHaveBeenLastCalledWith(
			expect.objectContaining({ requireFreshToken: true }),
		);

		await fetchPMItemsByIds({ ...BASE_INPUT, externalIds: ["1"] });
		expect(
			rest.resolvePmSource.mock.calls.at(-1)?.[0]?.requireFreshToken,
		).toBeUndefined();
	});
});
