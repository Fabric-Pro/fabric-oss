/**
 * Starting a revert's workflow and waiting for its answer (Fizzy #2878 §10).
 * What is pinned is the start's shape: one id per PROJECT, refused by
 * Temporal itself (`workflowIdConflictPolicy: "FAIL"`) while a revert of that
 * project's branch is open, and the wait that turns a slow revert into
 * `pending` instead of a failure.
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

import { runRevertCommitWorkflow } from "../revert-commit-workflow";

const INPUT = {
	projectId: "proj_1",
	organizationId: "org_1",
	userId: "user_1",
	sha: "a".repeat(40),
	requestId: "req_example_revert",
	author: { name: "Pat Example", email: "noreply@example.com" },
	committer: { name: "Fabric", email: "noreply@example.com" },
	committedAt: "2026-10-03T10:00:00Z",
};

beforeEach(() => {
	m.start.mockReset();
});

describe("runRevertCommitWorkflow", () => {
	it("starts one workflow per project and has Temporal refuse a second while it is open", async () => {
		m.start.mockResolvedValue({
			result: async () => ({ kind: "unchanged", sha: "b".repeat(40) }),
		});

		const answer = await runRevertCommitWorkflow(INPUT);

		expect(answer).toEqual({ kind: "unchanged", sha: "b".repeat(40) });
		expect(m.start).toHaveBeenCalledWith(
			"projectInstructionRevertCommitWorkflow",
			expect.objectContaining({
				workflowId: "project-instruction-revert-commit-proj_1",
				workflowIdConflictPolicy: "FAIL",
				args: [INPUT],
			}),
		);
	});

	it("bounds the workflow to a day, so one that nothing will finish does not stay open", async () => {
		m.start.mockResolvedValue({
			result: async () => ({ kind: "unchanged", sha: "b".repeat(40) }),
		});

		await runRevertCommitWorkflow(INPUT);

		expect(m.start).toHaveBeenCalledWith(
			"projectInstructionRevertCommitWorkflow",
			expect.objectContaining({
				workflowExecutionTimeout: 24 * 60 * 60_000,
			}),
		);
	});

	it("answers in_progress when a revert of this project is already open", async () => {
		m.start.mockRejectedValue(
			Object.assign(new Error("workflow execution already started"), {
				name: "WorkflowExecutionAlreadyStartedError",
			}),
		);

		await expect(runRevertCommitWorkflow(INPUT)).resolves.toEqual({
			kind: "in_progress",
		});
	});

	it("does not hide any other failure to start", async () => {
		m.start.mockRejectedValue(new Error("temporal is unreachable"));

		await expect(runRevertCommitWorkflow(INPUT)).rejects.toThrow(
			"temporal is unreachable",
		);
	});

	it("answers pending when the revert outlives the wait, leaving it running", async () => {
		m.start.mockResolvedValue({ result: () => new Promise(() => {}) });

		await expect(runRevertCommitWorkflow(INPUT, 10)).resolves.toEqual({
			kind: "pending",
		});
	});
});
