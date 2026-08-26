import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		agentTask: {
			create: vi.fn(),
		},
		agentApproval: {
			create: vi.fn(),
		},
	},
}));

import { db } from "@repo/database";
import { createOrchestratorApprovalRequest } from "../src/activities/orchestrator/approval/create-approval-request";

describe("createOrchestratorApprovalRequest weave linkage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(db.agentTask.create).mockResolvedValue({
			id: "task_123",
		} as never);
		vi.mocked(db.agentApproval.create).mockResolvedValue({
			id: "approval_123",
		} as never);
	});

	it("persists weave execution linkage when provided", async () => {
		await createOrchestratorApprovalRequest({
			executionId: "workflow_123",
			stepId: "step_123",
			stepDescription: "Review generated changes",
			stepType: "agent",
			userId: "user_123",
			organizationId: "org_123",
			weaveExecutionId: "weave_exec_123",
			weavePlanId: "weave_plan_123",
			weaveContext: {
				checkboxText: "Run Weft review",
				agent: "weave_weft",
				reviewType: "work",
			},
		});

		expect(db.agentApproval.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				userId: "user_123",
				weaveExecutionId: "weave_exec_123",
				weavePlanId: "weave_plan_123",
				weaveContext: {
					checkboxText: "Run Weft review",
					agent: "weave_weft",
					reviewType: "work",
				},
			}),
		});
	});
});
