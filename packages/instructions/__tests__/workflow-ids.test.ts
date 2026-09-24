import { describe, expect, it } from "vitest";
import {
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
});
