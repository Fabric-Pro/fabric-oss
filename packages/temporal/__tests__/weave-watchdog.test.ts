/**
 * Unit test for the weave-execution-watchdog workflow body.
 *
 * Asserts the per-row sequencing contract:
 *  1. signal-cancel
 *  2. fall through to terminate ONLY if signal didn't ack
 *  3. always call provider cleanup
 *  4. always flip the DB row to TERMINATED_STALE
 *
 * One bad row must not stop the sweep — the loop catches per-row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	findStaleWeaveSessions: vi.fn(),
	cancelWeaveExecutionViaSignal: vi.fn(),
	terminateWeaveWorkflow: vi.fn(),
	cleanupWeaveResourcesActivity: vi.fn(),
	markWeaveExecutionStale: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	proxyActivities: vi.fn(() => activityStubs),
}));

import { weaveExecutionWatchdogWorkflow } from "../src/workflows/weave-execution-watchdog";

const baseRow = {
	id: "we-1",
	kind: "weave" as const,
	sessionId: "sess-1",
	provider: "BACKGROUND_AGENTS",
	userId: "u-1",
	organizationId: "o-1",
	workflowId: "weave-exec-plan-1-1234",
	startedAtMs: Date.now() - 3 * 60 * 60_000, // 3h ago
};

const codingRow = {
	id: "cr-1",
	kind: "coding_run" as const,
	sessionId: "sess-coding",
	provider: "KANBAN_LOCAL",
	userId: "u-2",
	organizationId: null as string | null,
	workflowId: "coding-run-cr-1",
	startedAtMs: Date.now() - 4 * 60 * 60_000,
};

describe("weaveExecutionWatchdogWorkflow", () => {
	beforeEach(() => {
		activityStubs.findStaleWeaveSessions.mockReset();
		activityStubs.cancelWeaveExecutionViaSignal.mockReset();
		activityStubs.terminateWeaveWorkflow.mockReset();
		activityStubs.cleanupWeaveResourcesActivity.mockReset();
		activityStubs.markWeaveExecutionStale.mockReset();
	});

	it("signals + cleanup + mark-stale on the happy path (no fallback terminate)", async () => {
		activityStubs.findStaleWeaveSessions.mockResolvedValueOnce({
			rows: [baseRow],
		});
		activityStubs.cancelWeaveExecutionViaSignal.mockResolvedValueOnce(true);
		activityStubs.cleanupWeaveResourcesActivity.mockResolvedValueOnce(
			undefined,
		);
		activityStubs.markWeaveExecutionStale.mockResolvedValueOnce(undefined);

		const result = await weaveExecutionWatchdogWorkflow({
			staleAfterMinutes: 120,
			batchSize: 10,
		});

		expect(result).toEqual({
			killedWeave: 1,
			killedCodingRun: 0,
			scanned: 1,
		});
		expect(
			activityStubs.cancelWeaveExecutionViaSignal,
		).toHaveBeenCalledWith({
			workflowId: baseRow.workflowId,
			kind: "weave",
		});
		// Did NOT need to fall through to terminate.
		expect(activityStubs.terminateWeaveWorkflow).not.toHaveBeenCalled();

		expect(
			activityStubs.cleanupWeaveResourcesActivity,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "sess-1",
				provider: "BACKGROUND_AGENTS",
				userId: "u-1",
				organizationId: "o-1",
				weaveExecutionId: "we-1",
				codingRunId: null,
				exitReason: "timeout",
				workflowId: baseRow.workflowId,
			}),
		);
		expect(activityStubs.markWeaveExecutionStale).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "weave",
				id: "we-1",
				sessionId: "sess-1",
			}),
		);
	});

	it("falls through to terminate when signal goes unacknowledged", async () => {
		activityStubs.findStaleWeaveSessions.mockResolvedValueOnce({
			rows: [baseRow],
		});
		activityStubs.cancelWeaveExecutionViaSignal.mockResolvedValueOnce(
			false,
		);
		activityStubs.terminateWeaveWorkflow.mockResolvedValueOnce(undefined);
		activityStubs.cleanupWeaveResourcesActivity.mockResolvedValueOnce(
			undefined,
		);
		activityStubs.markWeaveExecutionStale.mockResolvedValueOnce(undefined);

		const result = await weaveExecutionWatchdogWorkflow();

		expect(result.killedWeave).toBe(1);
		expect(activityStubs.terminateWeaveWorkflow).toHaveBeenCalledWith({
			workflowId: baseRow.workflowId,
			reason: "watchdog_stale",
		});
	});

	it("counts weave + coding_run rows separately and passes the correct id field", async () => {
		activityStubs.findStaleWeaveSessions.mockResolvedValueOnce({
			rows: [baseRow, codingRow],
		});
		activityStubs.cancelWeaveExecutionViaSignal.mockResolvedValue(true);
		activityStubs.cleanupWeaveResourcesActivity.mockResolvedValue(
			undefined,
		);
		activityStubs.markWeaveExecutionStale.mockResolvedValue(undefined);

		const result = await weaveExecutionWatchdogWorkflow();

		expect(result).toEqual({
			killedWeave: 1,
			killedCodingRun: 1,
			scanned: 2,
		});
		// CodingRun row → codingRunId set, weaveExecutionId null
		expect(
			activityStubs.cleanupWeaveResourcesActivity,
		).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				weaveExecutionId: null,
				codingRunId: "cr-1",
				provider: "KANBAN_LOCAL",
			}),
		);
	});

	it("continues the sweep when one row throws", async () => {
		const goodRow = { ...baseRow, id: "we-2", workflowId: "weave-exec-2" };
		activityStubs.findStaleWeaveSessions.mockResolvedValueOnce({
			rows: [baseRow, goodRow],
		});
		// First row: cancel signal throws
		activityStubs.cancelWeaveExecutionViaSignal
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(true);
		activityStubs.cleanupWeaveResourcesActivity.mockResolvedValue(
			undefined,
		);
		activityStubs.markWeaveExecutionStale.mockResolvedValue(undefined);

		const result = await weaveExecutionWatchdogWorkflow();

		// First row failed → not counted; second row succeeded → counted.
		expect(result).toEqual({
			killedWeave: 1,
			killedCodingRun: 0,
			scanned: 2,
		});
		// Second row was still processed:
		expect(activityStubs.markWeaveExecutionStale).toHaveBeenCalledTimes(1);
		expect(activityStubs.markWeaveExecutionStale).toHaveBeenCalledWith(
			expect.objectContaining({ id: "we-2" }),
		);
	});

	it("returns a zero-kill result when no stale rows are found (no audit emitted)", async () => {
		activityStubs.findStaleWeaveSessions.mockResolvedValueOnce({
			rows: [],
		});

		const result = await weaveExecutionWatchdogWorkflow({
			staleAfterMinutes: 120,
		});

		expect(result).toEqual({
			killedWeave: 0,
			killedCodingRun: 0,
			scanned: 0,
		});
		expect(
			activityStubs.cleanupWeaveResourcesActivity,
		).not.toHaveBeenCalled();
		expect(activityStubs.markWeaveExecutionStale).not.toHaveBeenCalled();
	});

	it("passes staleAfterMinutes=0 to the activity when input is 0 / missing (activity owns env+default)", async () => {
		// Env-read responsibility moved from the workflow into
		// findStaleWeaveSessions to keep the workflow deterministic
		// under SDK 1.16 + reuseV8Context. The activity-side env+default
		// logic is exercised in watchdog-activities.test.ts.
		const originalEnv = process.env.WEAVE_MAX_RUN_MINUTES;
		try {
			activityStubs.findStaleWeaveSessions.mockResolvedValueOnce({
				rows: [],
			});
			await weaveExecutionWatchdogWorkflow({ staleAfterMinutes: 0 });
			expect(
				activityStubs.findStaleWeaveSessions,
			).toHaveBeenLastCalledWith({
				staleAfterMinutes: 0,
				batchSize: 50,
			});

			activityStubs.findStaleWeaveSessions.mockResolvedValueOnce({
				rows: [],
			});
			await weaveExecutionWatchdogWorkflow();
			expect(
				activityStubs.findStaleWeaveSessions,
			).toHaveBeenLastCalledWith({
				staleAfterMinutes: 0,
				batchSize: 50,
			});
		} finally {
			if (originalEnv === undefined) {
				delete process.env.WEAVE_MAX_RUN_MINUTES;
			} else {
				process.env.WEAVE_MAX_RUN_MINUTES = originalEnv;
			}
		}
	});
});
