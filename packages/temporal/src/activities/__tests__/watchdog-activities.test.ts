/**
 * Unit tests for the weave watchdog activities.
 *
 * Each activity has narrow scope so the tests stay focused:
 *  - `findStaleWeaveSessions` — non-terminal status + cutoff filter
 *  - `cancelWeaveExecutionViaSignal` — signal + race(terminal, timeout)
 *  - `terminateWeaveWorkflow` — swallow already-terminal errors
 *  - `markWeaveExecutionStale` — flip row + audit (idempotent)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	weaveFindManyMock: vi.fn(),
	codingFindManyMock: vi.fn(),
	weaveUpdateManyMock: vi.fn(),
	codingUpdateManyMock: vi.fn(),
	weavePlanUpdateManyMock: vi.fn(),
	recordAuditMock: vi.fn(),
	getHandleMock: vi.fn(),
	getTemporalClientMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		weaveExecution: {
			findMany: (...args: unknown[]) => mocks.weaveFindManyMock(...args),
			updateMany: (...args: unknown[]) =>
				mocks.weaveUpdateManyMock(...args),
		},
		codingRun: {
			findMany: (...args: unknown[]) => mocks.codingFindManyMock(...args),
			updateMany: (...args: unknown[]) =>
				mocks.codingUpdateManyMock(...args),
		},
		weavePlan: {
			updateMany: (...args: unknown[]) =>
				mocks.weavePlanUpdateManyMock(...args),
		},
	},
	recordAudit: (...args: unknown[]) => mocks.recordAuditMock(...args),
}));

vi.mock("../../client", () => ({
	getTemporalClient: (...args: unknown[]) =>
		mocks.getTemporalClientMock(...args),
}));

// Import AFTER mocks.
import {
	cancelWeaveExecutionViaSignal,
	findStaleWeaveSessions,
	markWeaveExecutionStale,
	terminateWeaveWorkflow,
} from "../weave/watchdog-activities";

beforeEach(() => {
	mocks.weaveFindManyMock.mockReset();
	mocks.codingFindManyMock.mockReset();
	mocks.weaveUpdateManyMock.mockReset();
	mocks.codingUpdateManyMock.mockReset();
	mocks.weavePlanUpdateManyMock.mockReset();
	mocks.recordAuditMock.mockReset();
	mocks.getHandleMock.mockReset();
	mocks.getTemporalClientMock.mockReset();

	mocks.weavePlanUpdateManyMock.mockResolvedValue({ count: 1 });
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("findStaleWeaveSessions", () => {
	it("returns weave + coding-run rows with the right shape and skips rows missing required ids", async () => {
		mocks.weaveFindManyMock.mockResolvedValueOnce([
			{
				id: "we-1",
				sandboxSessionId: "sess-1",
				userId: "u-1",
				organizationId: "o-1",
				startedAt: new Date("2025-01-01T00:00:00Z"),
				workflowId: "weave-exec-plan-1-1234",
			},
			// Skipped: null startedAt
			{
				id: "we-skip",
				sandboxSessionId: null,
				userId: "u-2",
				organizationId: null,
				startedAt: null,
				workflowId: "weave-exec-plan-2-2222",
			},
			// Skipped: empty workflowId
			{
				id: "we-skip-2",
				sandboxSessionId: "sess-x",
				userId: "u-3",
				organizationId: null,
				startedAt: new Date("2025-01-01T00:00:00Z"),
				workflowId: "",
			},
		]);
		mocks.codingFindManyMock.mockResolvedValueOnce([
			{
				id: "cr-1",
				providerSessionId: "sess-coding",
				userId: "u-1",
				organizationId: "o-1",
				startedAt: new Date("2025-01-02T00:00:00Z"),
				provider: "KANBAN_LOCAL",
				workflowId: "coding-run-cr-1",
			},
			// Skipped: null workflowId
			{
				id: "cr-skip",
				providerSessionId: "sess-orphan",
				userId: "u-1",
				organizationId: null,
				startedAt: new Date("2025-01-02T00:00:00Z"),
				provider: "BACKGROUND_AGENTS",
				workflowId: null,
			},
		]);

		const { rows } = await findStaleWeaveSessions({
			staleAfterMinutes: 120,
			batchSize: 50,
		});

		expect(rows).toHaveLength(2);

		// Weave rows are forced to BACKGROUND_AGENTS provider (the schema
		// doesn't persist it; the workflow only delegates there today).
		expect(rows[0]).toEqual({
			kind: "weave",
			id: "we-1",
			sessionId: "sess-1",
			provider: "BACKGROUND_AGENTS",
			userId: "u-1",
			organizationId: "o-1",
			workflowId: "weave-exec-plan-1-1234",
			startedAtMs: new Date("2025-01-01T00:00:00Z").getTime(),
		});

		expect(rows[1]).toEqual({
			kind: "coding_run",
			id: "cr-1",
			sessionId: "sess-coding",
			provider: "KANBAN_LOCAL",
			userId: "u-1",
			organizationId: "o-1",
			workflowId: "coding-run-cr-1",
			startedAtMs: new Date("2025-01-02T00:00:00Z").getTime(),
		});
	});

	it("uses a cutoff date derived from staleAfterMinutes", async () => {
		const now = Date.now();
		const expectedCutoffMs = now - 90 * 60_000;

		mocks.weaveFindManyMock.mockImplementationOnce((args: unknown) => {
			const where = (args as { where: { startedAt: { lt: Date } } })
				.where;
			const cutoff = where.startedAt.lt;
			// Allow a small tolerance for the duration of the call.
			expect(cutoff.getTime()).toBeGreaterThanOrEqual(
				expectedCutoffMs - 5_000,
			);
			expect(cutoff.getTime()).toBeLessThanOrEqual(
				expectedCutoffMs + 5_000,
			);
			return Promise.resolve([]);
		});
		mocks.codingFindManyMock.mockResolvedValueOnce([]);

		await findStaleWeaveSessions({ staleAfterMinutes: 90, batchSize: 25 });

		expect(mocks.weaveFindManyMock).toHaveBeenCalledTimes(1);
	});
});

describe("cancelWeaveExecutionViaSignal", () => {
	it("returns true when the workflow result resolves before the timeout", async () => {
		const signalMock = vi.fn().mockResolvedValue(undefined);
		const resultMock = vi.fn().mockResolvedValue("done");
		mocks.getHandleMock.mockReturnValue({
			signal: signalMock,
			result: resultMock,
		});
		mocks.getTemporalClientMock.mockResolvedValueOnce({
			workflow: { getHandle: mocks.getHandleMock },
		});

		const ok = await cancelWeaveExecutionViaSignal({
			workflowId: "weave-exec-1",
			kind: "weave",
			waitForTerminalMs: 50,
		});

		expect(ok).toBe(true);
		expect(signalMock).toHaveBeenCalledWith("cancel");
	});

	it("uses cancelCodingRun signal for coding_run kind", async () => {
		const signalMock = vi.fn().mockResolvedValue(undefined);
		const resultMock = vi.fn().mockResolvedValue("done");
		mocks.getHandleMock.mockReturnValue({
			signal: signalMock,
			result: resultMock,
		});
		mocks.getTemporalClientMock.mockResolvedValueOnce({
			workflow: { getHandle: mocks.getHandleMock },
		});

		await cancelWeaveExecutionViaSignal({
			workflowId: "coding-run-1",
			kind: "coding_run",
			waitForTerminalMs: 50,
		});

		expect(signalMock).toHaveBeenCalledWith("cancelCodingRun");
	});

	it("returns false if the workflow never reaches a terminal state before timeout", async () => {
		const signalMock = vi.fn().mockResolvedValue(undefined);
		const resultMock = vi.fn(() => new Promise(() => undefined)); // never resolves
		mocks.getHandleMock.mockReturnValue({
			signal: signalMock,
			result: resultMock,
		});
		mocks.getTemporalClientMock.mockResolvedValueOnce({
			workflow: { getHandle: mocks.getHandleMock },
		});

		const ok = await cancelWeaveExecutionViaSignal({
			workflowId: "weave-stuck",
			kind: "weave",
			waitForTerminalMs: 10,
		});

		expect(ok).toBe(false);
	});

	it("returns false when the Temporal client cannot be created", async () => {
		mocks.getTemporalClientMock.mockRejectedValueOnce(
			new Error("connection refused"),
		);

		const ok = await cancelWeaveExecutionViaSignal({
			workflowId: "weave-no-conn",
			kind: "weave",
			waitForTerminalMs: 10,
		});

		expect(ok).toBe(false);
	});

	it("returns false when signal/handle calls throw (workflow may have been GC'd)", async () => {
		const signalMock = vi.fn().mockRejectedValue(new Error("not found"));
		mocks.getHandleMock.mockReturnValue({ signal: signalMock });
		mocks.getTemporalClientMock.mockResolvedValueOnce({
			workflow: { getHandle: mocks.getHandleMock },
		});

		const ok = await cancelWeaveExecutionViaSignal({
			workflowId: "weave-gone",
			kind: "weave",
			waitForTerminalMs: 10,
		});

		expect(ok).toBe(false);
	});
});

describe("terminateWeaveWorkflow", () => {
	it("calls handle.terminate with the supplied reason", async () => {
		const terminateMock = vi.fn().mockResolvedValue(undefined);
		mocks.getHandleMock.mockReturnValue({ terminate: terminateMock });
		mocks.getTemporalClientMock.mockResolvedValueOnce({
			workflow: { getHandle: mocks.getHandleMock },
		});

		await terminateWeaveWorkflow({
			workflowId: "wf-1",
			reason: "watchdog_stale",
		});

		expect(terminateMock).toHaveBeenCalledWith("watchdog_stale");
	});

	it("swallows errors from already-terminal workflows", async () => {
		const terminateMock = vi
			.fn()
			.mockRejectedValue(new Error("workflow already completed"));
		mocks.getHandleMock.mockReturnValue({ terminate: terminateMock });
		mocks.getTemporalClientMock.mockResolvedValueOnce({
			workflow: { getHandle: mocks.getHandleMock },
		});

		await expect(
			terminateWeaveWorkflow({ workflowId: "wf-done", reason: "x" }),
		).resolves.toBeUndefined();
	});

	it("is a no-op when the Temporal client cannot be created", async () => {
		mocks.getTemporalClientMock.mockRejectedValueOnce(new Error("offline"));

		await expect(
			terminateWeaveWorkflow({ workflowId: "wf-x", reason: "y" }),
		).resolves.toBeUndefined();
	});
});

describe("markWeaveExecutionStale", () => {
	it("updates weaveExecution (guarded by non-terminal status) + writes warning audit row scoped to the org", async () => {
		mocks.weaveUpdateManyMock.mockResolvedValueOnce({ count: 1 });

		await markWeaveExecutionStale({
			kind: "weave",
			id: "we-1",
			organizationId: "o-1",
			sessionId: "sess-1",
			runDurationMs: 120 * 60_000,
		});

		expect(mocks.weaveUpdateManyMock).toHaveBeenCalledWith({
			where: {
				id: "we-1",
				status: { in: expect.arrayContaining(["RUNNING"]) },
			},
			data: expect.objectContaining({
				status: "TERMINATED_STALE",
				error: "killed by watchdog: exceeded WEAVE_MAX_RUN_MINUTES",
			}),
		});

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "weave.session.terminated_stale",
			category: "weave",
			severity: "warning",
			outcome: "success",
			actor: { type: "system", nameSnapshot: "weave-watchdog" },
			organizationId: "o-1",
			resource: { type: "weave_execution", id: "we-1" },
		});
		expect(mocks.recordAuditMock.mock.calls[0][0].metadata).toMatchObject({
			sessionId: "sess-1",
			runDurationMs: 120 * 60_000,
		});
	});

	it("updates codingRun with the CODING_RUN_MAX_MINUTES reason (also guarded)", async () => {
		mocks.codingUpdateManyMock.mockResolvedValueOnce({ count: 1 });

		await markWeaveExecutionStale({
			kind: "coding_run",
			id: "cr-1",
			organizationId: null,
			sessionId: null,
			runDurationMs: 999,
		});

		expect(mocks.codingUpdateManyMock).toHaveBeenCalledWith({
			where: {
				id: "cr-1",
				status: { in: expect.arrayContaining(["RUNNING"]) },
			},
			data: {
				status: "TERMINATED_STALE",
				lastError:
					"killed by watchdog: exceeded CODING_RUN_MAX_MINUTES",
			},
		});

		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "weave.session.terminated_stale",
			organizationId: null,
			resource: { type: "coding_run", id: "cr-1" },
		});
	});

	it("skips the audit when the row was already terminal (count === 0) so we don't spam a misleading terminated_stale entry", async () => {
		// Workflow's own finally raced ahead and flipped the row → updateMany
		// guard prevents the rewrite → no audit row.
		mocks.weaveUpdateManyMock.mockResolvedValueOnce({ count: 0 });

		await markWeaveExecutionStale({
			kind: "weave",
			id: "we-already-terminal",
			organizationId: "o-1",
			sessionId: null,
			runDurationMs: 100,
		});

		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("skips the audit when the DB update itself rejects (caught and treated as count=0)", async () => {
		mocks.weaveUpdateManyMock.mockRejectedValueOnce(
			new Error("connection lost"),
		);

		await expect(
			markWeaveExecutionStale({
				kind: "weave",
				id: "we-x",
				organizationId: "o-1",
				sessionId: null,
				runDurationMs: 100,
			}),
		).resolves.toBeUndefined();

		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("restores the parent plan RUNNING→APPROVED when a weave row was marked stale", async () => {
		mocks.weaveUpdateManyMock.mockResolvedValueOnce({ count: 1 });

		await markWeaveExecutionStale({
			kind: "weave",
			id: "we-stale",
			organizationId: "o-1",
			sessionId: "sess-1",
			runDurationMs: 1_000,
		});

		expect(mocks.weavePlanUpdateManyMock).toHaveBeenCalledTimes(1);
		expect(mocks.weavePlanUpdateManyMock).toHaveBeenCalledWith({
			where: {
				status: "RUNNING",
				executions: { some: { id: "we-stale" } },
			},
			data: { status: "APPROVED" },
		});
		// Stale-kill audit still written alongside the plan reconcile.
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
	});

	it("skips the plan write when the execution update was a no-op (count=0)", async () => {
		// The workflow's own finally won the race — its cleanup activity
		// also reconciles the plan, so the watchdog must not double up.
		mocks.weaveUpdateManyMock.mockResolvedValueOnce({ count: 0 });

		await markWeaveExecutionStale({
			kind: "weave",
			id: "we-raced",
			organizationId: "o-1",
			sessionId: null,
			runDurationMs: 100,
		});

		expect(mocks.weavePlanUpdateManyMock).not.toHaveBeenCalled();
	});

	it("never touches weavePlan for coding_run kind", async () => {
		mocks.codingUpdateManyMock.mockResolvedValueOnce({ count: 1 });

		await markWeaveExecutionStale({
			kind: "coding_run",
			id: "cr-stale",
			organizationId: null,
			sessionId: null,
			runDurationMs: 100,
		});

		expect(mocks.weavePlanUpdateManyMock).not.toHaveBeenCalled();
		// Coding-run stale-kill audit unaffected.
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
	});

	it("swallows plan-write failures — the stale-kill audit is still written", async () => {
		mocks.weaveUpdateManyMock.mockResolvedValueOnce({ count: 1 });
		mocks.weavePlanUpdateManyMock.mockRejectedValueOnce(
			new Error("plan write failed"),
		);

		await expect(
			markWeaveExecutionStale({
				kind: "weave",
				id: "we-plan-fail",
				organizationId: "o-1",
				sessionId: "sess-2",
				runDurationMs: 100,
			}),
		).resolves.toBeUndefined();

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "weave.session.terminated_stale",
			resource: { type: "weave_execution", id: "we-plan-fail" },
		});
	});
});
