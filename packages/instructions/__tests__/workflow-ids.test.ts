import { describe, expect, it } from "vitest";
import {
	INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_WORKFLOW_ID,
	instructionProposalPullRequestWorkflowId,
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
	it("derives one proposal pull-request workflow id per operation (Fizzy #2563 spec §6)", () => {
		expect(
			instructionProposalPullRequestWorkflowId(
				"cexample000000000000000a",
			),
		).toBe(
			"project-instruction-proposal-pull-request-cexample000000000000000a",
		);
	});
	it("gives the proposal sweeper one fixed id, distinct from every per-row id", () => {
		expect(INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_WORKFLOW_ID).toBe(
			"instruction-proposal-pull-request-sweep",
		);
		for (const id of [
			instructionProposalPullRequestWorkflowId("x"),
			instructionRepositorySyncWorkflowId("x"),
			instructionSnapshotWorkflowId("x"),
		]) {
			expect(id).not.toBe(
				INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_WORKFLOW_ID,
			);
		}
		expect(instructionProposalPullRequestWorkflowId("x")).not.toBe(
			instructionSnapshotWorkflowId("x"),
		);
	});
});
