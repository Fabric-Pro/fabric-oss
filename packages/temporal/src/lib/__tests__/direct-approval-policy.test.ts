import { describe, expect, it } from "vitest";
import {
	DIRECT_APPROVAL_CAPABILITIES,
	DIRECT_APPROVAL_UNSUPPORTED_MESSAGE,
	directApprovalRefusal,
	directApprovalUnavailableResult,
} from "../direct-approval-policy";

describe("Direct approval boundary", () => {
	it.each([undefined, null])(
		"keeps ordinary Direct turns available for %s",
		(value) => {
			expect(directApprovalRefusal(value)).toBeNull();
		},
	);
	it.each([
		{
			toolName: "fabric_run_workflow",
			args: { workflowId: "example-workflow" },
		},
		{
			toolName: "fabric_delete_frame",
			args: { frameId: "example-frame" },
			checkpointId: "client-claimed-checkpoint",
			approved: true,
		},
		{},
		false,
		"client-claimed-approval",
	])(
		"never treats a client payload as durable approval evidence",
		(value) => {
			expect(directApprovalRefusal(value)).toEqual({
				code: "DIRECT_APPROVAL_UNSUPPORTED",
				status: 409,
				message: DIRECT_APPROVAL_UNSUPPORTED_MESSAGE,
			});
		},
	);
	it("returns actionable guidance without reflecting tool arguments or claiming an earlier outcome", () => {
		const result = directApprovalRefusal({
			toolName: "private-example-tool",
			args: { secret: "private-example-secret" },
		});
		expect(result?.message).toContain("Advisor Simple (Orchestrator)");
		expect(result?.message).toContain("unknown outcome");
		expect(JSON.stringify(result)).not.toContain("private-example");
		expect(directApprovalUnavailableResult()).toMatchObject({
			requiresConfirmation: false,
			code: "DIRECT_APPROVAL_UNSUPPORTED",
		});
		expect(DIRECT_APPROVAL_CAPABILITIES).toEqual({
			approvalResume: false,
			approvalRuntime: "orchestrator",
		});
	});
});
