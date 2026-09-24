/**
 * `start-sync-workflow.ts` unit coverage (review round 1, S2a).
 *
 * The main procedure test mocks this whole module (`vi.mock("../start-sync-
 * workflow")`), so nothing there pins the workflow id, the task queue, the
 * conflict policy, the correlation memo, or the two failure-classification
 * branches. This file exercises the module directly with a fake Temporal
 * client.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	start: vi.fn(),
	getHandle: vi.fn(),
	withCorrelationMemo: vi.fn((o: unknown) => o),
}));

vi.mock("@repo/instructions", () => ({
	instructionRepositorySyncWorkflowId: (projectId: string) =>
		`project-instruction-repository-sync-${projectId}`,
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: m.start, getHandle: m.getHandle },
	}),
}));
vi.mock("../../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: m.withCorrelationMemo,
}));

import {
	isInstructionRepositorySyncRunning,
	startInstructionRepositorySync,
} from "../start-sync-workflow";

const input = {
	projectId: "proj_1",
	organizationId: "org_1",
	trigger: "MANUAL" as const,
	requesterUserId: "user_1",
};

const expectedOptions = {
	taskQueue: "project-instructions",
	workflowId: "project-instruction-repository-sync-proj_1",
	workflowIdConflictPolicy: "FAIL",
	args: [input],
};

beforeEach(() => {
	m.start.mockReset();
	m.getHandle.mockReset();
	m.withCorrelationMemo.mockClear();
	m.withCorrelationMemo.mockImplementation((o: unknown) => o);
});

describe("startInstructionRepositorySync", () => {
	it("starts the workflow by the deterministic id, on the instructions queue, FAIL conflict policy, args=[input], through the correlation memo", async () => {
		m.start.mockResolvedValue(undefined);

		expect(await startInstructionRepositorySync(input)).toBe(true);

		expect(m.withCorrelationMemo).toHaveBeenCalledWith(expectedOptions);
		expect(m.start).toHaveBeenCalledWith(
			"projectInstructionRepositorySyncWorkflow",
			expectedOptions,
		);
	});

	it("reports already_running (false) when Temporal refuses the duplicate workflow id", async () => {
		const err = new Error("dup");
		err.name = "WorkflowExecutionAlreadyStartedError";
		m.start.mockRejectedValue(err);

		expect(await startInstructionRepositorySync(input)).toBe(false);
	});

	it("rethrows any other start failure — only the conflict is swallowed", async () => {
		m.start.mockRejectedValue(new Error("temporal unreachable"));

		await expect(startInstructionRepositorySync(input)).rejects.toThrow(
			"temporal unreachable",
		);
	});
});

describe("isInstructionRepositorySyncRunning", () => {
	it("is true only when the handle describes as RUNNING", async () => {
		m.getHandle.mockReturnValue({
			describe: async () => ({ status: { name: "RUNNING" } }),
		});

		expect(await isInstructionRepositorySyncRunning("proj_1")).toBe(true);
		expect(m.getHandle).toHaveBeenCalledWith(
			"project-instruction-repository-sync-proj_1",
		);
	});

	it("is false for a completed (or any non-RUNNING) workflow", async () => {
		m.getHandle.mockReturnValue({
			describe: async () => ({ status: { name: "COMPLETED" } }),
		});

		expect(await isInstructionRepositorySyncRunning("proj_1")).toBe(false);
	});

	it("degrades to false when describe fails — never running is the safe misread", async () => {
		m.getHandle.mockReturnValue({
			describe: async () => {
				throw new Error("no such workflow");
			},
		});

		expect(await isInstructionRepositorySyncRunning("proj_1")).toBe(false);
	});
});
