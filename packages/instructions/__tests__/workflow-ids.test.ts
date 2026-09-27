import { describe, expect, it } from "vitest";
import {
	INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_WORKFLOW_ID,
	instructionRepositorySyncWorkflowId,
	instructionSnapshotWorkflowId,
} from "../src/workflow-ids";

describe("workflow ids", () => {
	it("derives one sync workflow id per project, so a second start is refused while one runs", () => {
		expect(instructionRepositorySyncWorkflowId("proj_1")).toBe(
			"project-instruction-repository-sync-proj_1",
		);
	});
	it("never collides with a snapshot workflow id", () => {
		expect(instructionRepositorySyncWorkflowId("x")).not.toBe(
			instructionSnapshotWorkflowId("x"),
		);
	});
	it("gives the proposal sweeper one fixed id, distinct from every per-row id", () => {
		expect(INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_WORKFLOW_ID).toBe(
			"instruction-proposal-pull-request-sweep",
		);
		for (const id of [
			instructionRepositorySyncWorkflowId("x"),
			instructionSnapshotWorkflowId("x"),
		]) {
			expect(id).not.toBe(
				INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_WORKFLOW_ID,
			);
		}
	});
});
