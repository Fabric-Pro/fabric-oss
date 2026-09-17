/**
 * `markExecutionRunningIfPending` — the starter's RUNNING write.
 *
 * The workflow writes its own status as it progresses, and a short run can
 * reach COMPLETED or FAILED before the starter's write lands. An
 * unconditional update moved such a row back to RUNNING, where nothing ever
 * moved it forward again. The write is now conditional on PENDING; the
 * real-Postgres reservation suite drives it against the database, and this
 * pins the statement shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const updateManyMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		workflowExecution: {
			updateMany: (args: unknown) => updateManyMock(args),
		},
	},
}));

import { markExecutionRunningIfPending } from "../prisma/queries/workflows/executions";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("markExecutionRunningIfPending", () => {
	it("moves the row to RUNNING only where it is still PENDING", async () => {
		updateManyMock.mockResolvedValueOnce({ count: 1 });
		const startedAt = new Date("2026-09-16T12:00:00Z");

		await expect(
			markExecutionRunningIfPending({
				executionId: "exec-1",
				temporalRunId: "workflow-execution-exec-1",
				startedAt,
			}),
		).resolves.toBe(true);

		expect(updateManyMock).toHaveBeenCalledTimes(1);
		expect(updateManyMock).toHaveBeenCalledWith({
			where: { id: "exec-1", status: "PENDING" },
			data: {
				temporalRunId: "workflow-execution-exec-1",
				status: "RUNNING",
				startedAt,
			},
		});
	});

	it("leaves a row that already moved on in its status, recording only a missing run id", async () => {
		updateManyMock
			.mockResolvedValueOnce({ count: 0 })
			.mockResolvedValueOnce({ count: 1 });

		await expect(
			markExecutionRunningIfPending({
				executionId: "exec-1",
				temporalRunId: "workflow-execution-exec-1",
			}),
		).resolves.toBe(false);

		expect(updateManyMock).toHaveBeenCalledTimes(2);
		const [, second] = updateManyMock.mock.calls;
		expect(second[0]).toEqual({
			where: { id: "exec-1", temporalRunId: null },
			data: { temporalRunId: "workflow-execution-exec-1" },
		});
		// No write after the first one touches `status`.
		expect(second[0].data).not.toHaveProperty("status");
	});
});
