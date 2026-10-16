/**
 * What each outcome of an engine start means for the execution row, for every
 * surface that starts a run (the Run button, the Fabric Agent, the webhook and
 * the public API). Pinned here once, so the surfaces cannot drift: a start the
 * engine accepted but whose response was lost must not fail the row (a retry
 * would run it twice), and a start that never reached the engine must not leave
 * the row PENDING for good.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	attempt: vi.fn(),
	markRunning: vi.fn(),
	executionUpdate: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { workflowExecution: { update: mocks.executionUpdate } },
	markExecutionRunningIfPending: mocks.markRunning,
	// The key moves out of the matched path, as the real helper does.
	releasedIdempotencyTriggerInput: (input: Record<string, unknown>) =>
		"idempotencyKey" in input
			? { releasedIdempotencyKey: input.idempotencyKey }
			: undefined,
}));

vi.mock("../start-builder-execution", () => ({
	attemptWorkflowBuilderStart: mocks.attempt,
	startFailureMessage: (error: unknown) =>
		error instanceof Error ? error.message : "Failed to start workflow",
	unconfirmedStartMessage: (executionId: string) =>
		`The workflow engine did not confirm whether execution ${executionId} started.`,
}));

import {
	ENGINE_UNAVAILABLE_MESSAGE,
	startReservedExecution,
} from "../start-reserved-execution";

const startedAt = new Date("2026-10-14T09:00:00Z");

function execution(triggerInput: unknown = {}) {
	return {
		id: "exec-1",
		status: "PENDING",
		startedAt,
		triggerInput,
	} as never;
}

function start(row = execution()) {
	return startReservedExecution({
		execution: row,
		logTag: "test",
		start: {
			workflowId: "wf-1",
			userId: "user-1",
			organizationId: "org-1",
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.markRunning.mockResolvedValue(true);
	mocks.executionUpdate.mockResolvedValue({});
	mocks.attempt.mockResolvedValue({
		status: "confirmed",
		workflowId: "workflow-execution-exec-1",
		runId: "run-1",
		via: "start",
	});
});

describe("startReservedExecution", () => {
	it("starts the run against the row's own id", async () => {
		await start();

		expect(mocks.attempt).toHaveBeenCalledExactlyOnceWith({
			workflowId: "wf-1",
			userId: "user-1",
			organizationId: "org-1",
			executionId: "exec-1",
		});
	});

	it("marks the row RUNNING with the engine's id when the start is confirmed", async () => {
		const outcome = await start();

		expect(outcome).toEqual({
			status: "started",
			temporalWorkflowId: "workflow-execution-exec-1",
			rowAlreadyAdvanced: false,
		});
		expect(mocks.markRunning).toHaveBeenCalledWith({
			executionId: "exec-1",
			temporalRunId: "workflow-execution-exec-1",
		});
		expect(mocks.executionUpdate).not.toHaveBeenCalled();
	});

	it("says so when a short run had already moved the row on", async () => {
		mocks.markRunning.mockResolvedValue(false);

		const outcome = await start();

		expect(outcome).toMatchObject({
			status: "started",
			rowAlreadyAdvanced: true,
		});
	});

	it("still reports a started run when the row cannot be marked, and never fails it", async () => {
		mocks.markRunning.mockRejectedValue(new Error("connection reset"));

		const outcome = await start();

		expect(outcome.status).toBe("started");
		expect(mocks.executionUpdate).not.toHaveBeenCalled();
	});

	it("leaves the row exactly as it is when the start cannot be settled", async () => {
		mocks.attempt.mockResolvedValue({
			status: "unknown",
			workflowId: "workflow-execution-exec-1",
			error: new Error("DEADLINE_EXCEEDED"),
		});

		const outcome = await start();

		expect(outcome).toMatchObject({
			status: "unconfirmed",
			temporalWorkflowId: "workflow-execution-exec-1",
		});
		expect(outcome.status === "unconfirmed" && outcome.message).toContain(
			"exec-1",
		);
		expect(mocks.markRunning).not.toHaveBeenCalled();
		expect(mocks.executionUpdate).not.toHaveBeenCalled();
	});

	it("fails the row, with the engine unavailable as the reason, when no request left the process", async () => {
		mocks.attempt.mockResolvedValue({
			status: "not-started",
			workflowId: "workflow-execution-exec-1",
			error: new Error("no client"),
			cause: "engine-unavailable",
		});

		const outcome = await start();

		expect(outcome).toEqual({
			status: "failed",
			failure: "engine-unavailable",
			message: ENGINE_UNAVAILABLE_MESSAGE,
		});
		expect(mocks.executionUpdate).toHaveBeenCalledWith({
			where: { id: "exec-1" },
			data: expect.objectContaining({
				status: "FAILED",
				error: ENGINE_UNAVAILABLE_MESSAGE,
			}),
		});
	});

	it("fails the row, naming why, when the engine refused the start", async () => {
		mocks.attempt.mockResolvedValue({
			status: "not-started",
			workflowId: "workflow-execution-exec-1",
			error: new Error("task queue closed"),
			cause: "start-rejected",
		});

		const outcome = await start();

		expect(outcome).toEqual({
			status: "failed",
			failure: "start-rejected",
			message:
				"The workflow engine rejected the start: task queue closed",
		});
	});

	it("records how long the row waited when it fails", async () => {
		mocks.attempt.mockResolvedValue({
			status: "not-started",
			workflowId: "workflow-execution-exec-1",
			error: new Error("x"),
			cause: "start-rejected",
		});

		await start();

		const { data } = mocks.executionUpdate.mock.calls[0][0];
		expect(data.completedAt).toBeInstanceOf(Date);
		expect(data.duration).toBe(
			data.completedAt.getTime() - startedAt.getTime(),
		);
	});

	it("releases the idempotency key in the same write that fails the row", async () => {
		mocks.attempt.mockResolvedValue({
			status: "not-started",
			workflowId: "workflow-execution-exec-1",
			error: new Error("x"),
			cause: "start-rejected",
		});

		await start(execution({ idempotencyKey: "key-1" }));

		const { data } = mocks.executionUpdate.mock.calls[0][0];
		expect(data.triggerInput).toEqual({ releasedIdempotencyKey: "key-1" });
	});

	it("writes no trigger input for a row that never carried a key", async () => {
		mocks.attempt.mockResolvedValue({
			status: "not-started",
			workflowId: "workflow-execution-exec-1",
			error: new Error("x"),
			cause: "start-rejected",
		});

		await start();

		const { data } = mocks.executionUpdate.mock.calls[0][0];
		expect(data).not.toHaveProperty("triggerInput");
	});
});
