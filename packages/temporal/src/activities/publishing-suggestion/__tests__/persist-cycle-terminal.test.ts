/**
 * The generation run's terminal step is where its Job Hub row closes
 * (Fizzy #1850).
 *
 * The row closes here rather than after notification and chat delivery, and
 * that is the scope boundary rather than an oversight: those run afterwards,
 * each behind its own `patched()` marker and its own try/catch, so there is no
 * statically-known last step to close from — and delivery already has a surface
 * of its own in the refresh history's Notified column.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The @repo/database WRITERS are the doubles, never `job-progress` itself. Its
// exports cannot reject — each wraps `safely()` — so a rejecting stand-in would
// describe a state production never reaches, and would push this activity into
// a try/catch that guards nothing.
const dbMocks = vi.hoisted(() => ({
	persistCycleTerminal: vi.fn(),
	setBackgroundJobStep: vi.fn(),
	completeBackgroundJob: vi.fn(),
}));
vi.mock("@repo/database", () => dbMocks);

// REQUIRED: without it `currentExecution()` returns null and EVERY job write
// below is a silent no-op, leaving these assertions passing on nothing.
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

import { persistCycleTerminal } from "../persist-cycle-terminal";

// `sourceId: null` EXPLICITLY, not undefined: that is the form `completableStatus`
// lets repair a row the watchdog wrongly failed. Asserting the exact key is what
// keeps that from being quietly dropped.
const JOB_KEY = {
	workflowId: "publishing-suggestion-cycle-1",
	sourceId: null,
};

/** Just the (stepKey, status) pairs, in call order. */
const stepCalls = () =>
	dbMocks.setBackgroundJobStep.mock.calls.map((c) => [c[1], c[2]]);

const INPUT = {
	cycleId: "cycle-1",
	kind: "SUGGESTIONS" as const,
	topics: [{ title: "a" }, { title: "b" }, { title: "c" }],
	sourceCoverage: {},
	sourceFailures: {},
	tenant: { projectId: "proj-a", organizationId: null, userId: "user-1" },
} as never;

beforeEach(() => {
	vi.clearAllMocks();
	dbMocks.persistCycleTerminal.mockResolvedValue({
		persisted: true,
		status: "READY",
	});
});

describe("persistCycleTerminal — Job Hub close", () => {
	it("writes the cycle FIRST, then reports — telemetry must not spend this activity's 30-second budget ahead of the durable write", async () => {
		const order: string[] = [];
		dbMocks.persistCycleTerminal.mockImplementation(async () => {
			order.push("persist");
			return { persisted: true, status: "READY" };
		});
		dbMocks.setBackgroundJobStep.mockImplementation(async () => {
			order.push("step");
		});

		await persistCycleTerminal(INPUT);

		// `safely()` protects a caller from a writer that THROWS. Nothing protects
		// it from one that merely hangs, which is why order is the guard here.
		expect(order[0]).toBe("persist");
	});

	it("completes collect and persist, then closes the row with the topic count", async () => {
		await persistCycleTerminal(INPUT);

		expect(stepCalls()).toEqual([
			["collect", "completed"],
			["persist", "completed"],
		]);
		expect(dbMocks.completeBackgroundJob).toHaveBeenCalledWith(JOB_KEY, {
			counts: { topicsSuggested: 3 },
		});
	});

	it("closes an INSUFFICIENT_CONTEXT cycle with a zero count — a run that decided there was nothing to say is a real answer, not a gap", async () => {
		dbMocks.persistCycleTerminal.mockResolvedValue({
			persisted: true,
			status: "INSUFFICIENT_CONTEXT",
		});

		await persistCycleTerminal({
			...(INPUT as object),
			kind: "INSUFFICIENT_CONTEXT",
			topics: [],
		} as never);

		expect(dbMocks.completeBackgroundJob).toHaveBeenCalledWith(JOB_KEY, {
			counts: { topicsSuggested: 0 },
		});
	});

	it("completes collect on the insufficient path, where the summarizer never ran to do it", async () => {
		dbMocks.persistCycleTerminal.mockResolvedValue({
			persisted: true,
			status: "INSUFFICIENT_CONTEXT",
		});

		await persistCycleTerminal({
			...(INPUT as object),
			kind: "INSUFFICIENT_CONTEXT",
			topics: [],
		} as never);

		expect(stepCalls()).toContainEqual(["collect", "completed"]);
	});

	it("writes NO counter when the CAS was lost, and leaves persist unmarked so the sweep records it skipped", async () => {
		dbMocks.persistCycleTerminal.mockResolvedValue({
			persisted: false,
			status: "READY",
		});

		await persistCycleTerminal(INPUT);

		// A zero here would claim the run produced nothing. It produced nothing
		// UNDER THIS ROW, because a later dispatch reclaimed the cycle and marked
		// it FAILED while this run was still working — a different fact, and the
		// one `skipped` already states.
		expect(dbMocks.completeBackgroundJob).toHaveBeenCalledWith(JOB_KEY, {});
		expect(stepCalls()).not.toContainEqual(["persist", "completed"]);
	});

	it("marks persist FAILED and rethrows when the underlying write throws", async () => {
		dbMocks.persistCycleTerminal.mockRejectedValue(new Error("deadlock"));

		await expect(persistCycleTerminal(INPUT)).rejects.toThrow("deadlock");
		expect(stepCalls()).toContainEqual(["persist", "failed"]);
		// A failed persist must not also close the row as COMPLETED — the
		// workflow's markCycleFailed is what closes it, as FAILED.
		expect(dbMocks.completeBackgroundJob).not.toHaveBeenCalled();
	});

	it("returns the helper's result unchanged when the underlying job writer rejects", async () => {
		dbMocks.completeBackgroundJob.mockRejectedValueOnce(
			new Error("db down"),
		);
		dbMocks.setBackgroundJobStep.mockRejectedValue(new Error("db down"));

		await expect(persistCycleTerminal(INPUT)).resolves.toEqual({
			persisted: true,
			status: "READY",
		});
	});
});
