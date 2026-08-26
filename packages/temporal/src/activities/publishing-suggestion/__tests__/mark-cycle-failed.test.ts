/**
 * The workflow's outer catch is the only always-reached failure hook, so it is
 * where a failed run's Job Hub row closes (Fizzy #1850).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The @repo/database writer is the double, never `job-progress` itself — see
// persist-cycle-terminal.test.ts for why a rejecting stand-in would be a
// fiction.
const dbMocks = vi.hoisted(() => {
	const updateMany = vi.fn();
	return {
		updateMany,
		db: { publishingSuggestionCycle: { updateMany } },
		failBackgroundJob: vi.fn(),
		failRunningBackgroundJobStep: vi.fn(),
	};
});
vi.mock("@repo/database", () => ({
	db: dbMocks.db,
	failBackgroundJob: dbMocks.failBackgroundJob,
	failRunningBackgroundJobStep: dbMocks.failRunningBackgroundJobStep,
}));

// REQUIRED: without it `currentExecution()` returns null and the job write is a
// silent no-op.
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			info: {
				workflowExecution: {
					workflowId: "publishing-suggestion-cycle-1",
					runId: "run-1",
				},
			},
		}),
	},
	heartbeat: vi.fn(),
}));

import { markCycleFailed } from "../mark-cycle-failed";

beforeEach(() => {
	vi.clearAllMocks();
	dbMocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("markCycleFailed — Job Hub close", () => {
	it("closes the row FAILED with the cycle's own error message, which the panel renders verbatim", async () => {
		await markCycleFailed("cycle-1", "proj-a", "all sources failed");

		expect(dbMocks.failBackgroundJob).toHaveBeenCalledWith(
			{
				workflowId: "publishing-suggestion-cycle-1",
				sourceId: null,
			},
			{ error: "all sources failed", errorClass: undefined },
		);
	});

	it("still fails the cycle when the underlying job writer rejects", async () => {
		dbMocks.failBackgroundJob.mockRejectedValueOnce(new Error("db down"));

		await expect(
			markCycleFailed("cycle-1", "proj-a", "boom"),
		).resolves.toBeUndefined();
		expect(dbMocks.updateMany).toHaveBeenCalledTimes(1);
	});

	it("marks the step the run died in as FAILED, not skipped, before closing the row", async () => {
		await markCycleFailed("cycle-1", "proj-a", "all sources failed");

		// "all sources failed" is thrown in WORKFLOW code after the collector
		// fan-out, when `collect` is still running and no single collector is in a
		// position to mark it. The close sweep maps running to skipped — "never
		// reached" — which is the opposite of what happened.
		expect(dbMocks.failRunningBackgroundJobStep).toHaveBeenCalledWith(
			{
				workflowId: "publishing-suggestion-cycle-1",
				sourceId: null,
			},
			"all sources failed",
		);
		const stepOrder =
			dbMocks.failRunningBackgroundJobStep.mock.invocationCallOrder[0];
		const closeOrder =
			dbMocks.failBackgroundJob.mock.invocationCallOrder[0];
		// Before the close, or the sweep would already have written `skipped`.
		expect(stepOrder).toBeLessThan(closeOrder);
	});

	it("fails the CYCLE before reporting it, so telemetry latency cannot delay the terminal write", async () => {
		const order: string[] = [];
		dbMocks.updateMany.mockImplementation(async () => {
			order.push("cycle");
			return { count: 1 };
		});
		dbMocks.failBackgroundJob.mockImplementation(async () => {
			order.push("job");
		});

		await markCycleFailed("cycle-1", "proj-a", "boom");

		expect(order).toEqual(["cycle", "job"]);
	});
});
