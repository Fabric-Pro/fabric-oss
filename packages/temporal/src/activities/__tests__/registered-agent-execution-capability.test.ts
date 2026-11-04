import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	createAgentTask: vi.fn(),
	updateAgentTaskStatus: vi.fn(),
	updateAgentTaskWorkflow: vi.fn(),
}));

import { executeAgent } from "../agent-execution";

describe("registered agent background execution capability", () => {
	it("does not report a readiness-only operation as a completed execution", async () => {
		await expect(
			executeAgent({
				agentName: "example-agent",
				userId: "example-user",
				organizationId: "example-org",
				input: {},
			}),
		).rejects.toMatchObject({
			type: "AGENT_EXECUTION_UNSUPPORTED",
			nonRetryable: true,
		});
	});
});
