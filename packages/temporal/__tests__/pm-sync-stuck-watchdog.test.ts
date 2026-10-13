/**
 * The stuck PM-sync watchdog, end to end across ticks.
 *
 * The workflow body runs with its real activities (only `proxyActivities` is
 * replaced, by the activity module itself), over a simulated `user_story` /
 * `test_case` store and a fake Temporal client. The clock is advanced tick by
 * tick, as the 5-minute schedule would.
 *
 * What this pins:
 *   - each retry keeps `pmSyncPendingSince`, so repeated retries still reach
 *     the 60-minute give-up bound (before, the bound read
 *     `lastPmSyncAttemptAt`, which every retry reset, so it was never
 *     reached);
 *   - a row whose workflow id is running is not retried;
 *   - a test case left PENDING reaches the give-up bound too (before, the
 *     watchdog skipped test cases entirely);
 *   - every write is scoped to the attempt the scan saw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const h = vi.hoisted(() => ({
	stories: new Map<string, Record<string, unknown> & { id: string }>(),
	testCases: new Map<string, Record<string, unknown> & { id: string }>(),
	describe: vi.fn(),
	workflowStart: vi.fn(),
	recordPmSyncLog: vi.fn(),
	resolveProjectPMConfigForUser: vi.fn(),
}));

function matches(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (value && typeof value === "object" && "lt" in value) {
			const cell = row[key];
			return cell instanceof Date && cell < (value as { lt: Date }).lt;
		}
		return (row[key] ?? null) === value;
	});
}

function table(rows: Map<string, Row>) {
	return {
		findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
			const row = rows.get(where.id);
			return row
				? {
						...row,
						project: { userId: "owner-1", organizationId: "org-1" },
					}
				: null;
		}),
		findFirst: vi.fn(
			async ({ where }: { where: { id: string } }) =>
				rows.get(where.id) ?? null,
		),
		update: vi.fn(
			async ({
				where,
				data,
			}: {
				where: { id: string };
				data: Record<string, unknown>;
			}) => {
				const row = rows.get(where.id);
				if (!row) {
					throw new Error("Record to update not found.");
				}
				Object.assign(row, data);
				return { ...row };
			},
		),
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				let count = 0;
				for (const row of rows.values()) {
					if (matches(row, where)) {
						Object.assign(row, data);
						count++;
					}
				}
				return { count };
			},
		),
	};
}

vi.mock("@temporalio/workflow", async () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	// The workflow's activities, run in-process: each stub calls the real
	// activity of the same name.
	proxyActivities: () =>
		new Proxy(
			{},
			{
				get:
					(_target, name: string) =>
					async (...args: unknown[]) => {
						const activities = (await import(
							"../src/activities/pm-sync-stuck-watchdog-activities"
						)) as unknown as Record<
							string,
							(...a: unknown[]) => Promise<unknown>
						>;
						const activity = activities[name];
						if (!activity) {
							throw new Error(`no activity ${name}`);
						}
						return activity(...args);
					},
			},
		),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", () => {
	const userStory = table(h.stories);
	const testCase = table(h.testCases);
	/** `findStuckPmSyncItems`'s contract over the simulated store. */
	async function findStuckPmSyncItems(input: {
		olderThan: Date;
		pendingBefore?: Date;
		limit?: number;
	}) {
		const pendingSinceOf = (row: Row) =>
			(row.pmSyncPendingSince as Date | null) ??
			(row.lastPmSyncAttemptAt as Date);
		const stuck = (
			rows: Map<string, Row>,
			itemType: (row: Row) => string,
		) =>
			[...rows.values()]
				.filter(
					(row) =>
						row.lastPmSyncStatus === "PENDING" &&
						row.lastPmSyncAttemptAt instanceof Date &&
						(row.lastPmSyncAttemptAt < input.olderThan ||
							(input.pendingBefore !== undefined &&
								pendingSinceOf(row) < input.pendingBefore)),
				)
				.map((row) => ({
					itemId: row.id,
					itemType: itemType(row),
					lastPmSyncAttemptAt: row.lastPmSyncAttemptAt as Date,
					lastPmSyncAttemptId:
						(row.lastPmSyncAttemptId as string | null) ?? null,
					pendingSince: pendingSinceOf(row),
				}));
		return [
			...stuck(h.stories, (row) =>
				row.kind === "BUG" ? "bug" : "story",
			),
			...stuck(h.testCases, () => "testCase"),
		];
	}
	return {
		db: {
			userStory,
			testCase,
			project: {
				findUnique: vi.fn(async () => ({
					id: "project-1",
					organizationId: "org-1",
					readOnlyMode: false,
					projectManagementMcpServerId: "server-1",
					projectManagementMcpConfigId: "config-1",
					projectManagementContainerId: "container-1",
					projectManagementContainerName: "Board",
					projectManagementAdditionalContext: null,
				})),
			},
			mCPServer: { findUnique: vi.fn(async () => null) },
		},
		findStuckPmSyncItems,
		PmSyncStatus: {
			PENDING: "PENDING",
			FAILED: "FAILED",
			SUCCESS: "SUCCESS",
		},
	};
});

vi.mock("@repo/integrations/gitlab", () => ({
	GitLabPmOriginMismatchError: class extends Error {},
	resolveProjectPMConfigForUser: h.resolveProjectPMConfigForUser,
}));

vi.mock("../src/activities/pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog: h.recordPmSyncLog,
}));

vi.mock("../src/client", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: {
			start: h.workflowStart,
			getHandle: (workflowId: string) => ({
				describe: () => h.describe(workflowId),
			}),
		},
	})),
}));

const { pmSyncStuckWatchdogWorkflow } = await import(
	"../src/workflows/pm-sync-stuck-watchdog"
);

const T0 = new Date("2026-05-28T12:00:00.000Z").getTime();
const minutes = (n: number) => n * 60_000;

/** A story stamped PENDING by a fresh enqueue at `at`. */
function pendingStory(id: string, at: number, kind = "FEATURE"): Row {
	return {
		id,
		projectId: "project-1",
		kind,
		externalId: null,
		title: "Example story",
		lastPmSyncStatus: "PENDING",
		lastPmSyncAttemptAt: new Date(at),
		lastPmSyncAttemptId: `attempt-${id}-0`,
		pmSyncPendingSince: new Date(at),
	};
}

function notFound() {
	return Object.assign(new Error("workflow not found"), {
		name: "WorkflowNotFoundError",
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
	h.stories.clear();
	h.testCases.clear();
	h.describe.mockReset();
	h.workflowStart.mockReset();
	h.recordPmSyncLog.mockReset();
	h.resolveProjectPMConfigForUser
		.mockReset()
		.mockResolvedValue({ id: "user-config-1", enabled: true });
	// The worker that should run the sync is down: Temporal accepts the
	// start (so the row stays PENDING) and has never heard of the id when
	// asked before the start.
	h.describe.mockRejectedValue(notFound());
	h.workflowStart.mockImplementation(
		async (_type: string, opts: { workflowId: string }) => ({
			workflowId: opts.workflowId,
		}),
	);
});

afterEach(() => {
	vi.useRealTimers();
});

async function tickAt(minutesAfterT0: number) {
	vi.setSystemTime(T0 + minutes(minutesAfterT0));
	return pmSyncStuckWatchdogWorkflow();
}

describe("pmSyncStuckWatchdogWorkflow", () => {
	it("keeps pending-since across its own retries and gives up 60 minutes after the sync began", async () => {
		h.stories.set("story-1", pendingStory("story-1", T0));

		const outcomes = [];
		// Every 5 minutes for 90 minutes, as the schedule fires.
		for (let at = 5; at <= 90; at += 5) {
			outcomes.push({ at, out: await tickAt(at) });
		}
		const retriedAt = outcomes
			.filter((o) => o.out.retried > 0)
			.map((o) => o.at);
		const failedAt = outcomes
			.filter((o) => o.out.failed > 0)
			.map((o) => o.at);

		// Retried more than once — each retry refreshes lastPmSyncAttemptAt,
		// which is what used to keep the give-up bound out of reach.
		expect(retriedAt).toEqual([15, 30, 45]);
		// Every retry kept the original pending-since and re-stamped a new
		// attempt through the real enqueue.
		expect(h.workflowStart).toHaveBeenCalledTimes(retriedAt.length);
		// Given up exactly once, on the tick the bound measured from T0 is
		// reached — not measured from the last retry, which would push it out
		// forever — although the row was retried 15 minutes earlier.
		expect(failedAt).toEqual([60]);
		const row = h.stories.get("story-1");
		expect(row).toMatchObject({
			lastPmSyncStatus: "FAILED",
			pmSyncPendingSince: new Date(T0),
		});
		expect(String(row?.lastPmSyncError)).toContain("60 minutes");
		// One audit row for the give-up.
		expect(h.recordPmSyncLog).toHaveBeenCalledTimes(1);
		expect(h.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: "story-1",
				errorPayload: expect.objectContaining({
					errorClass: "pending_timeout",
				}),
			}),
		);
	});

	it("gives up on an overdue row whose last retry was only minutes ago", async () => {
		h.stories.set("story-1", {
			...pendingStory("story-1", T0),
			// Retried 6 minutes before the tick: too recent for the retry scan.
			lastPmSyncAttemptAt: new Date(T0 + minutes(55)),
		});

		const out = await tickAt(61);

		expect(out).toMatchObject({ scanned: 1, failed: 1, retried: 0 });
		expect(h.stories.get("story-1")?.lastPmSyncStatus).toBe("FAILED");
		expect(h.describe).not.toHaveBeenCalled();
	});

	it("re-enqueues as the project owner, keeping pending-since and stamping a new attempt", async () => {
		h.stories.set("story-1", pendingStory("story-1", T0));

		const out = await tickAt(11);

		expect(out).toMatchObject({ scanned: 1, retried: 1, failed: 0 });
		expect(h.resolveProjectPMConfigForUser).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "owner-1",
				organizationId: "org-1",
			}),
		);
		expect(h.workflowStart).toHaveBeenCalledWith(
			"pmSyncSingleStoryWorkflow",
			expect.objectContaining({
				workflowId: "pm-sync-story-story-1",
				workflowIdConflictPolicy: "USE_EXISTING",
				args: [expect.objectContaining({ triggerSource: "retry" })],
			}),
		);
		const row = h.stories.get("story-1");
		expect(row?.lastPmSyncAttemptId).not.toBe("attempt-story-1-0");
		expect(row?.pmSyncPendingSince).toEqual(new Date(T0));
		expect(row?.lastPmSyncAttemptAt).toEqual(new Date(T0 + minutes(11)));
	});

	it("falls back to lastPmSyncAttemptAt for a row stamped before pending-since existed, and pins it on retry", async () => {
		h.stories.set("legacy-1", {
			...pendingStory("legacy-1", T0),
			lastPmSyncAttemptId: null,
			pmSyncPendingSince: null,
		});

		await tickAt(11);

		expect(h.stories.get("legacy-1")).toMatchObject({
			pmSyncPendingSince: new Date(T0),
			lastPmSyncAttemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
	});

	it("does not retry a row whose workflow is running", async () => {
		h.stories.set("story-1", pendingStory("story-1", T0));
		h.describe.mockResolvedValue({ status: { name: "RUNNING" } });

		const out = await tickAt(11);

		expect(out).toMatchObject({ retried: 0, skippedLive: 1, failed: 0 });
		expect(h.describe).toHaveBeenCalledWith("pm-sync-story-story-1");
		expect(h.workflowStart).not.toHaveBeenCalled();
		expect(h.stories.get("story-1")).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-story-1-0",
		});
	});

	it("probes a bug by the id its enqueue used", async () => {
		h.stories.set("bug-1", pendingStory("bug-1", T0, "BUG"));
		h.describe.mockResolvedValue({ status: { name: "RUNNING" } });

		await tickAt(11);

		expect(h.describe).toHaveBeenCalledWith("pm-sync-bug-bug-1");
	});

	it("does not retry when Temporal cannot say whether the workflow runs", async () => {
		h.stories.set("story-1", pendingStory("story-1", T0));
		h.describe.mockRejectedValue(new Error("connection reset"));

		const out = await tickAt(11);

		expect(out).toMatchObject({ retried: 0, skippedLive: 1 });
		expect(h.workflowStart).not.toHaveBeenCalled();
	});

	it("gives up on a test case left PENDING, without retrying it", async () => {
		h.testCases.set("case-1", {
			id: "case-1",
			projectId: "project-1",
			title: "Example case",
			externalId: null,
			externalUrl: null,
			externalMcpServerId: null,
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptAt: new Date(T0),
			lastPmSyncAttemptId: "attempt-case-1",
			pmSyncPendingSince: new Date(T0),
		});

		const early = await tickAt(30);
		expect(early).toMatchObject({ waitingTestCases: 1, retried: 0 });
		expect(h.testCases.get("case-1")?.lastPmSyncStatus).toBe("PENDING");

		const late = await tickAt(61);
		expect(late).toMatchObject({ failed: 1 });
		expect(h.testCases.get("case-1")).toMatchObject({
			lastPmSyncStatus: "FAILED",
		});
		expect(h.workflowStart).not.toHaveBeenCalled();
		expect(h.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({ entityType: "TEST_CASE" }),
		);
	});

	it("does not give up on a row that a newer attempt re-stamped after the scan", async () => {
		h.stories.set("story-1", pendingStory("story-1", T0));
		const giveUp = await import(
			"../src/activities/pm-sync-stuck-watchdog-activities"
		);
		vi.setSystemTime(T0 + minutes(61));
		const { rows } = await giveUp.findStuckPmSyncRowsActivity({
			batchSize: 10,
		});
		expect(rows[0]?.giveUpAtMs).toBeLessThanOrEqual(Date.now());
		// A user edit stamps a new attempt between the scan and the write.
		Object.assign(h.stories.get("story-1") as Row, {
			lastPmSyncAttemptId: "attempt-newer",
			pmSyncPendingSince: new Date(T0 + minutes(61)),
		});

		const wrote = await giveUp.giveUpStuckPmSyncActivity({
			itemId: "story-1",
			itemType: "story",
			attemptId: rows[0]?.attemptId ?? null,
		});

		expect(wrote).toBe(false);
		expect(h.stories.get("story-1")?.lastPmSyncStatus).toBe("PENDING");
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("does not re-arm a row that settled between the scan and the retry", async () => {
		h.stories.set("story-1", pendingStory("story-1", T0));
		const activities = await import(
			"../src/activities/pm-sync-stuck-watchdog-activities"
		);
		vi.setSystemTime(T0 + minutes(11));
		const { rows } = await activities.findStuckPmSyncRowsActivity({
			batchSize: 10,
		});
		// The run finished meanwhile.
		Object.assign(h.stories.get("story-1") as Row, {
			lastPmSyncStatus: "SUCCESS",
		});

		const result = await activities.retryStuckPmSyncActivity({
			itemId: "story-1",
			itemType: "story",
			attemptId: rows[0]?.attemptId ?? null,
			pendingSinceMs: rows[0]?.pendingSinceMs ?? 0,
		});

		expect(result).toEqual({ enqueued: false, reason: "superseded" });
		expect(h.workflowStart).not.toHaveBeenCalled();
		expect(h.stories.get("story-1")?.lastPmSyncStatus).toBe("SUCCESS");
	});
});
