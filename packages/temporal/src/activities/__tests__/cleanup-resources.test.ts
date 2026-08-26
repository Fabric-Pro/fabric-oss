/**
 * Unit tests for `cleanupWeaveResourcesActivity`.
 *
 * Exercises the four teardown behavior contracts:
 *  1. Null sessionId — workflow exited before sandbox creation, the
 *     activity is a no-op but STILL writes an audit row so the lifecycle
 *     is observable. The audit row is `outcome: "success"` because no
 *     teardown failed — there was simply no session.
 *  2. Happy-path destroy — provider.cancelSession resolves; audit row
 *     marks outcome=success.
 *  3. 404 / not-found from provider — treat as success (the provider
 *     already destroyed the session; this is idempotent).
 *  4. Provider throws — log a warning, do NOT rethrow (the workflow has
 *     already chosen its exit state), and audit outcome=failure so the
 *     watchdog/operator can correlate.
 *
 * Plus the DB-reconciliation contracts: failure/exception exits flip the
 * `WeaveExecution` row to FAILED (cancelled → CANCELLED) — even when no
 * session ever existed — and restore the parent `WeavePlan` from RUNNING
 * to APPROVED. Timeout/success/oauth_blocked never write; reconciliation
 * errors are swallowed; coding-run callers (no weaveExecutionId) skip it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	recordAuditMock: vi.fn(),
	getProviderMock: vi.fn(),
	cancelSessionMock: vi.fn(),
	logInfoMock: vi.fn(),
	logWarnMock: vi.fn(),
	weaveExecutionUpdateManyMock: vi.fn(),
	weaveExecutionFindUniqueMock: vi.fn(),
	weavePlanUpdateManyMock: vi.fn(),
}));

vi.mock("@temporalio/activity", () => ({
	log: {
		info: mocks.logInfoMock,
		warn: mocks.logWarnMock,
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	recordAudit: (...args: unknown[]) => mocks.recordAuditMock(...args),
	db: {
		weaveExecution: {
			updateMany: (...args: unknown[]) =>
				mocks.weaveExecutionUpdateManyMock(...args),
			findUnique: (...args: unknown[]) =>
				mocks.weaveExecutionFindUniqueMock(...args),
		},
		weavePlan: {
			updateMany: (...args: unknown[]) =>
				mocks.weavePlanUpdateManyMock(...args),
		},
	},
}));

vi.mock("../../lib/coding-execution/registry", () => ({
	getCodingExecutionProvider: (...args: unknown[]) =>
		mocks.getProviderMock(...args),
}));

// Import AFTER the mocks so the activity captures them.
import { cleanupWeaveResourcesActivity } from "../weave/cleanup-resources";

const BASE_INPUT = {
	provider: "BACKGROUND_AGENTS" as const,
	userId: "user-1",
	organizationId: "org-1" as string | null,
	exitReason: "success" as const,
	workflowId: "weave-exec-plan-1-1700000000000",
	runDurationMs: 12_345,
};

beforeEach(() => {
	mocks.recordAuditMock.mockReset();
	mocks.getProviderMock.mockReset();
	mocks.cancelSessionMock.mockReset();
	mocks.logInfoMock.mockReset();
	mocks.logWarnMock.mockReset();
	mocks.weaveExecutionUpdateManyMock.mockReset();
	mocks.weaveExecutionFindUniqueMock.mockReset();
	mocks.weavePlanUpdateManyMock.mockReset();

	mocks.getProviderMock.mockReturnValue({
		cancelSession: mocks.cancelSessionMock,
	});
	mocks.weaveExecutionUpdateManyMock.mockResolvedValue({ count: 1 });
	// Default: a terminal execution so the plan-reconcile step runs. Tests
	// that care about the specific status override this per case.
	mocks.weaveExecutionFindUniqueMock.mockResolvedValue({
		status: "CANCELLED",
		planId: "plan-1",
	});
	mocks.weavePlanUpdateManyMock.mockResolvedValue({ count: 1 });
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("cleanupWeaveResourcesActivity", () => {
	it("returns no-op when sessionId is null but still writes an audit row with outcome=success", async () => {
		const result = await cleanupWeaveResourcesActivity({
			...BASE_INPUT,
			sessionId: null,
			weaveExecutionId: "wexec-1",
		});

		expect(result).toEqual({ destroyed: false, alreadyTerminal: true });
		expect(mocks.getProviderMock).not.toHaveBeenCalled();
		expect(mocks.cancelSessionMock).not.toHaveBeenCalled();

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		const [call] = mocks.recordAuditMock.mock.calls;
		expect(call[0]).toMatchObject({
			action: "weave.session.terminated_on_exit",
			category: "weave",
			severity: "info",
			// No teardown actually failed — there was simply no session.
			outcome: "success",
			actor: { type: "system", nameSnapshot: "temporal-worker" },
			organizationId: "org-1",
			resource: { type: "weave_execution", id: "wexec-1" },
		});
		expect(call[0].metadata).toMatchObject({
			sessionId: null,
			exitReason: "success",
			workflowId: BASE_INPUT.workflowId,
			runDurationMs: 12_345,
			provider: "BACKGROUND_AGENTS",
		});
	});

	it("destroys the session and audits success on the happy path", async () => {
		mocks.cancelSessionMock.mockResolvedValueOnce(undefined);

		const result = await cleanupWeaveResourcesActivity({
			...BASE_INPUT,
			sessionId: "sess-abc",
			weaveExecutionId: "wexec-1",
		});

		expect(result).toEqual({ destroyed: true, alreadyTerminal: false });
		expect(mocks.getProviderMock).toHaveBeenCalledWith("BACKGROUND_AGENTS");
		expect(mocks.cancelSessionMock).toHaveBeenCalledWith("sess-abc");

		expect(mocks.logInfoMock).toHaveBeenCalledWith(
			"weave_session_terminated_on_exit",
			expect.objectContaining({
				sessionId: "sess-abc",
				exitReason: "success",
				workflowId: BASE_INPUT.workflowId,
				runDurationMs: 12_345,
				provider: "BACKGROUND_AGENTS",
			}),
		);

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "weave.session.terminated_on_exit",
			outcome: "success",
		});
	});

	it("treats provider 404 as success (idempotent teardown)", async () => {
		mocks.cancelSessionMock.mockRejectedValueOnce(
			new Error("HTTP 404 Not Found"),
		);

		const result = await cleanupWeaveResourcesActivity({
			...BASE_INPUT,
			sessionId: "sess-already-gone",
			codingRunId: "run-7",
			weaveExecutionId: null,
			exitReason: "failure",
		});

		expect(result).toEqual({ destroyed: true, alreadyTerminal: false });
		expect(mocks.logInfoMock).toHaveBeenCalledWith(
			"weave_session_terminated_on_exit_already_gone",
			expect.objectContaining({
				sessionId: "sess-already-gone",
				workflowId: BASE_INPUT.workflowId,
				provider: "BACKGROUND_AGENTS",
			}),
		);
		expect(mocks.logWarnMock).not.toHaveBeenCalled();

		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "weave.session.terminated_on_exit",
			outcome: "success",
			resource: { type: "coding_run", id: "run-7" },
		});
	});

	it("swallows non-404 provider errors and audits failure (no rethrow)", async () => {
		mocks.cancelSessionMock.mockRejectedValueOnce(
			new Error("ECONNREFUSED control-plane unreachable"),
		);

		const result = await cleanupWeaveResourcesActivity({
			...BASE_INPUT,
			sessionId: "sess-stuck",
			weaveExecutionId: "wexec-broken",
			exitReason: "exception",
		});

		expect(result).toEqual({ destroyed: false, alreadyTerminal: true });
		expect(mocks.logWarnMock).toHaveBeenCalledWith(
			"weave_session_termination_failed",
			expect.objectContaining({
				error: "ECONNREFUSED control-plane unreachable",
				sessionId: "sess-stuck",
				provider: "BACKGROUND_AGENTS",
			}),
		);

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "weave.session.terminated_on_exit",
			outcome: "failure",
			actor: { type: "system", nameSnapshot: "temporal-worker" },
			resource: { type: "weave_execution", id: "wexec-broken" },
		});
		expect(mocks.recordAuditMock.mock.calls[0][0].metadata).toMatchObject({
			exitReason: "exception",
		});
	});

	it("omits resource when neither weaveExecutionId nor codingRunId is provided", async () => {
		mocks.cancelSessionMock.mockResolvedValueOnce(undefined);

		await cleanupWeaveResourcesActivity({
			...BASE_INPUT,
			sessionId: "sess-bare",
		});

		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "weave.session.terminated_on_exit",
		});
		expect(mocks.recordAuditMock.mock.calls[0][0].resource).toBeUndefined();
	});
});

describe("cleanupWeaveResourcesActivity — DB reconciliation", () => {
	const NON_TERMINAL = ["PENDING", "RUNNING", "PAUSED", "CHECKPOINT"];

	it("persists FAILED with the captured errorMessage and restores the plan to APPROVED — even when sessionId is null", async () => {
		mocks.weaveExecutionFindUniqueMock.mockResolvedValue({
			status: "FAILED",
			planId: "plan-failed",
		});

		const result = await cleanupWeaveResourcesActivity({
			...BASE_INPUT,
			sessionId: null,
			weaveExecutionId: "wexec-failed",
			exitReason: "failure",
			errorMessage:
				"Could not start the Background Agents sandbox: repoUrl is required",
		});

		// Still the no-op teardown contract for a null session…
		expect(result).toEqual({ destroyed: false, alreadyTerminal: true });
		expect(mocks.getProviderMock).not.toHaveBeenCalled();

		// …but the DB reconciliation ran anyway (the headline bug case:
		// init/sandbox failures exit before a session exists).
		expect(mocks.weaveExecutionUpdateManyMock).toHaveBeenCalledTimes(1);
		expect(mocks.weaveExecutionUpdateManyMock).toHaveBeenCalledWith({
			where: {
				id: "wexec-failed",
				status: { in: NON_TERMINAL },
			},
			data: {
				status: "FAILED",
				error: "Could not start the Background Agents sandbox: repoUrl is required",
				completedAt: expect.any(Date),
			},
		});
		// Plan reconciled from the execution's final status, keyed by planId.
		expect(mocks.weavePlanUpdateManyMock).toHaveBeenCalledTimes(1);
		expect(mocks.weavePlanUpdateManyMock).toHaveBeenCalledWith({
			where: { id: "plan-failed", status: "RUNNING" },
			data: { status: "APPROVED" },
		});
		// Audit row still written.
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
	});

	it("falls back to a generic error naming the exitReason when errorMessage is absent (exception)", async () => {
		mocks.cancelSessionMock.mockResolvedValueOnce(undefined);
		mocks.weaveExecutionFindUniqueMock.mockResolvedValue({
			status: "FAILED",
			planId: "plan-1",
		});

		await cleanupWeaveResourcesActivity({
			...BASE_INPUT,
			sessionId: "sess-1",
			weaveExecutionId: "wexec-exc",
			exitReason: "exception",
		});

		expect(mocks.weaveExecutionUpdateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "FAILED",
					error: "Execution failed (exception)",
				}),
			}),
		);
		expect(mocks.weavePlanUpdateManyMock).toHaveBeenCalledWith({
			where: { id: "plan-1", status: "RUNNING" },
			data: { status: "APPROVED" },
		});
	});

	it("maps cancelled to CANCELLED (no error overwrite) and reconciles the plan to APPROVED", async () => {
		mocks.cancelSessionMock.mockResolvedValueOnce(undefined);
		mocks.weaveExecutionFindUniqueMock.mockResolvedValue({
			status: "CANCELLED",
			planId: "plan-2",
		});

		await cleanupWeaveResourcesActivity({
			...BASE_INPUT,
			sessionId: "sess-2",
			weaveExecutionId: "wexec-cancelled",
			exitReason: "cancelled",
		});

		expect(mocks.weaveExecutionUpdateManyMock).toHaveBeenCalledWith({
			where: {
				id: "wexec-cancelled",
				status: { in: NON_TERMINAL },
			},
			data: {
				status: "CANCELLED",
				completedAt: expect.any(Date),
			},
		});
		expect(mocks.weavePlanUpdateManyMock).toHaveBeenCalledWith({
			where: { id: "plan-2", status: "RUNNING" },
			data: { status: "APPROVED" },
		});
	});

	it("THE BUG FIX: a cancelled run the phase reported as `success` still restores the plan (reconcile reads the CANCELLED execution, not the exit reason)", async () => {
		mocks.cancelSessionMock.mockResolvedValueOnce(undefined);
		// The cancel procedure already flipped the execution to CANCELLED;
		// the workflow exited `success` (Shuttle cancelled before a PR).
		mocks.weaveExecutionFindUniqueMock.mockResolvedValue({
			status: "CANCELLED",
			planId: "plan-cancel-success",
		});

		await cleanupWeaveResourcesActivity({
			...BASE_INPUT,
			sessionId: "sess-cs",
			weaveExecutionId: "wexec-cs",
			exitReason: "success",
		});

		// exitReason=success → no execution-row write…
		expect(mocks.weaveExecutionUpdateManyMock).not.toHaveBeenCalled();
		// …but the plan is reconciled from the CANCELLED execution → APPROVED.
		expect(mocks.weavePlanUpdateManyMock).toHaveBeenCalledWith({
			where: { id: "plan-cancel-success", status: "RUNNING" },
			data: { status: "APPROVED" },
		});
	});

	it("a genuinely completed run moves the plan to COMPLETED (fixes the success wedge)", async () => {
		mocks.cancelSessionMock.mockResolvedValueOnce(undefined);
		mocks.weaveExecutionFindUniqueMock.mockResolvedValue({
			status: "COMPLETED",
			planId: "plan-done",
		});

		await cleanupWeaveResourcesActivity({
			...BASE_INPUT,
			sessionId: "sess-done",
			weaveExecutionId: "wexec-done",
			exitReason: "success",
		});

		expect(mocks.weaveExecutionUpdateManyMock).not.toHaveBeenCalled();
		expect(mocks.weavePlanUpdateManyMock).toHaveBeenCalledWith({
			where: { id: "plan-done", status: "RUNNING" },
			data: { status: "COMPLETED" },
		});
	});

	it("does not touch the execution row on timeout, and leaves the plan alone while the execution is still non-terminal (the watchdog owns it)", async () => {
		mocks.cancelSessionMock.mockResolvedValueOnce(undefined);
		// On the watchdog's pre-stale cleanup call the row is still RUNNING.
		mocks.weaveExecutionFindUniqueMock.mockResolvedValue({
			status: "RUNNING",
			planId: "plan-timeout",
		});

		await cleanupWeaveResourcesActivity({
			...BASE_INPUT,
			sessionId: "sess-4",
			weaveExecutionId: "wexec-timeout",
			exitReason: "timeout",
		});

		expect(mocks.weaveExecutionUpdateManyMock).not.toHaveBeenCalled();
		// Non-terminal execution → no plan transition (watchdog handles it).
		expect(mocks.weavePlanUpdateManyMock).not.toHaveBeenCalled();
	});

	it("never writes the execution row for success/oauth_blocked exits", async () => {
		mocks.cancelSessionMock.mockResolvedValue(undefined);
		mocks.weaveExecutionFindUniqueMock.mockResolvedValue({
			status: "COMPLETED",
			planId: "plan-1",
		});

		await cleanupWeaveResourcesActivity({
			...BASE_INPUT,
			sessionId: "sess-5",
			weaveExecutionId: "wexec-success",
			exitReason: "success",
		});
		await cleanupWeaveResourcesActivity({
			...BASE_INPUT,
			sessionId: "sess-6",
			weaveExecutionId: "wexec-oauth",
			exitReason: "oauth_blocked",
		});

		expect(mocks.weaveExecutionUpdateManyMock).not.toHaveBeenCalled();
	});

	it("swallows reconciliation DB errors — teardown and audit still run", async () => {
		mocks.weaveExecutionUpdateManyMock.mockRejectedValueOnce(
			new Error("db connection lost"),
		);
		mocks.cancelSessionMock.mockResolvedValueOnce(undefined);

		const result = await cleanupWeaveResourcesActivity({
			...BASE_INPUT,
			sessionId: "sess-7",
			weaveExecutionId: "wexec-db-down",
			exitReason: "failure",
			errorMessage: "boom",
		});

		expect(result).toEqual({ destroyed: true, alreadyTerminal: false });
		expect(mocks.logWarnMock).toHaveBeenCalledWith(
			"weave_execution_reconciliation_failed",
			expect.objectContaining({
				error: "db connection lost",
				weaveExecutionId: "wexec-db-down",
				exitReason: "failure",
			}),
		);
		// Teardown + audit unaffected by the reconciliation failure.
		expect(mocks.cancelSessionMock).toHaveBeenCalledWith("sess-7");
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "weave.session.terminated_on_exit",
			outcome: "success",
		});
	});

	it("skips reconciliation entirely when weaveExecutionId is null (coding-run callers)", async () => {
		mocks.cancelSessionMock.mockResolvedValueOnce(undefined);

		await cleanupWeaveResourcesActivity({
			...BASE_INPUT,
			sessionId: "sess-8",
			codingRunId: "run-9",
			weaveExecutionId: null,
			exitReason: "failure",
			errorMessage: "irrelevant",
		});

		expect(mocks.weaveExecutionUpdateManyMock).not.toHaveBeenCalled();
		expect(mocks.weaveExecutionFindUniqueMock).not.toHaveBeenCalled();
		expect(mocks.weavePlanUpdateManyMock).not.toHaveBeenCalled();
	});
});
