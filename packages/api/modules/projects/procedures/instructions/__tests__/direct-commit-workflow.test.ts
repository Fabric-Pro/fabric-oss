/**
 * Starting a direct commit's workflow (Fizzy #2878 §10). What is pinned is the
 * start's shape: one id per SNAPSHOT, a retried submission finding the open
 * run instead of failing, any other failure thrown for the caller to close the
 * row out, and the day-long execution bound that lets the reaper treat a
 * pending row older than it as having nothing behind it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	start: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { start: m.start } }),
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));

import { startDirectCommitWorkflow } from "../direct-commit-workflow";

const INPUT = { snapshotId: "snap_example", organizationId: "org_1" };

beforeEach(() => {
	m.start.mockReset();
});

describe("startDirectCommitWorkflow", () => {
	it("starts one workflow per snapshot, bounded to a day", async () => {
		m.start.mockResolvedValue(undefined);

		await startDirectCommitWorkflow(INPUT);

		expect(m.start).toHaveBeenCalledWith(
			"projectInstructionDirectCommitWorkflow",
			expect.objectContaining({
				workflowId: "project-instruction-direct-commit-snap_example",
				workflowExecutionTimeout: 24 * 60 * 60_000,
				args: [INPUT],
			}),
		);
	});

	it("takes the open run of a retried submission for the one it wanted", async () => {
		m.start.mockRejectedValue(
			Object.assign(new Error("workflow execution already started"), {
				name: "WorkflowExecutionAlreadyStartedError",
			}),
		);

		await expect(startDirectCommitWorkflow(INPUT)).resolves.toBeUndefined();
	});

	it("throws any other failure to start, for the caller to close the row out", async () => {
		m.start.mockRejectedValue(new Error("temporal is unreachable"));

		await expect(startDirectCommitWorkflow(INPUT)).rejects.toThrow(
			"temporal is unreachable",
		);
	});
});
