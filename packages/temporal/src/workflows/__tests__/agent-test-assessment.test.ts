import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	assess: vi.fn(),
	fail: vi.fn(),
	proxy: vi.fn(),
}));
vi.mock("@temporalio/workflow", () => ({
	ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "wait" },
	proxyActivities: (options: unknown) => {
		m.proxy(options);
		return {
			assessAgentTestRun: m.assess,
			failAgentTestAssessment: m.fail,
		};
	},
}));

import { agentTestAssessmentWorkflow } from "../agent-test-assessment";

const input = {
	testRunId: "example-test-run",
	userId: "example-user",
	organizationId: "example-org",
};
beforeEach(() => {
	m.assess.mockReset();
	m.fail.mockReset();
	m.assess.mockResolvedValue({ status: "COMPLETED" });
	m.fail.mockResolvedValue({ status: "ERROR" });
});
describe("durable native assessment observer", () => {
	it("delegates one SDK wait/assessment to an activity with native heartbeat and retry policy", async () => {
		await expect(agentTestAssessmentWorkflow(input)).resolves.toEqual({
			status: "COMPLETED",
		});
		expect(m.assess).toHaveBeenCalledExactlyOnceWith(input);
		expect(m.fail).not.toHaveBeenCalled();
		expect(m.proxy).toHaveBeenCalledWith(
			expect.objectContaining({
				heartbeatTimeout: "20 seconds",
				retry: expect.objectContaining({ maximumAttempts: 3 }),
			}),
		);
	});
	it("projects observer failure without carrying provider exceptions or raw agent output into workflow commands", async () => {
		m.assess.mockRejectedValue(
			new Error("Example provider private output"),
		);
		await expect(agentTestAssessmentWorkflow(input)).resolves.toEqual({
			status: "ERROR",
		});
		expect(m.assess).toHaveBeenCalledTimes(1);
		expect(m.fail).toHaveBeenCalledExactlyOnceWith({
			...input,
			errorCode: "ASSESSMENT_UNAVAILABLE",
		});
		expect(JSON.stringify(m.fail.mock.calls)).not.toContain(
			"private output",
		);
	});
});

it("retains only an allow-listed native failure type through Temporal activity failure causes", async () => {
	m.assess.mockRejectedValue({
		message: "Example private output",
		cause: {
			type: "AGENT_TEST_CONFIG_CHANGED",
			message: "Example sensitive configuration",
		},
	});
	await agentTestAssessmentWorkflow(input);
	expect(m.fail).toHaveBeenCalledExactlyOnceWith({
		...input,
		errorCode: "AGENT_TEST_CONFIG_CHANGED",
	});
	expect(JSON.stringify(m.fail.mock.calls)).not.toContain("sensitive");
});
it("discards arbitrary provider failure types instead of storing them", async () => {
	m.assess.mockRejectedValue({
		type: "Example sensitive provider error",
		cause: { type: "Example secret" },
	});
	await agentTestAssessmentWorkflow(input);
	expect(m.fail).toHaveBeenCalledExactlyOnceWith({
		...input,
		errorCode: "ASSESSMENT_UNAVAILABLE",
	});
});
