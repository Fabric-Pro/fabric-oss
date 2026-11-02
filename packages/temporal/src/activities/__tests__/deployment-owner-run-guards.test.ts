import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getDeployment: vi.fn(),
	member: vi.fn(),
	createExecution: vi.fn(),
	startExecution: vi.fn(),
	updateCurrentExecutions: vi.fn(),
	incrementExecutionCounts: vi.fn(),
	incrementExecutionQuota: vi.fn(),
	updateExecutionStatus: vi.fn(),
	quota: vi.fn(),
	trigger: vi.fn(),
	createScheduled: vi.fn(),
	updateTrigger: vi.fn(),
	workflowStart: vi.fn(),
	signal: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getAgentDeploymentById: mocks.getDeployment,
	isDeploymentOwnerCurrentMember: mocks.member,
	createAgentDeploymentExecution: mocks.createExecution,
	startExecution: mocks.startExecution,
	updateCurrentExecutions: mocks.updateCurrentExecutions,
	incrementExecutionCounts: mocks.incrementExecutionCounts,
	incrementExecutionQuota: mocks.incrementExecutionQuota,
	updateExecutionStatus: mocks.updateExecutionStatus,
	checkExecutionQuota: mocks.quota,
	db: {
		agentDeployment: { findUnique: mocks.getDeployment },
		agentDeploymentTrigger: {
			findFirst: mocks.trigger,
			update: mocks.updateTrigger,
		},
		agentDeploymentExecution: { create: mocks.createScheduled },
	},
}));
vi.mock("../../client", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: mocks.workflowStart,
			getHandle: () => ({ signal: mocks.signal }),
		},
	}),
}));

import { startAgentExecution } from "../agent-supervisor";
import { signalSupervisorForScheduledExecution } from "../schedule-trigger";

const deployment = {
	id: "deployment-example",
	userId: "owner-example",
	organizationId: "example-org",
	status: "ACTIVE",
	instance: { executionMode: "single_turn" },
};
const startInput = {
	workflowId: "supervisor-example",
	deploymentId: deployment.id,
	instanceId: "instance-example",
	executionId: "execution-example",
	userId: deployment.userId,
	organizationId: deployment.organizationId,
	input: {},
	triggerType: "WEBHOOK",
	timeoutMs: 30000,
};
const scheduleInput = {
	supervisorWorkflowId: "supervisor-example",
	deploymentId: deployment.id,
	triggerId: "trigger-example",
	triggerType: "SCHEDULE" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getDeployment.mockResolvedValue(deployment);
	mocks.member.mockResolvedValue(true);
	mocks.quota.mockResolvedValue({ allowed: true });
	mocks.trigger.mockResolvedValue({
		id: "trigger-example",
		isActive: true,
		config: {},
	});
	mocks.createScheduled.mockResolvedValue({ id: "execution-example" });
});

describe("startAgentExecution", () => {
	it("refuses a removed owner before writing or starting a workflow", async () => {
		mocks.member.mockResolvedValue(false);
		await expect(startAgentExecution(startInput)).rejects.toMatchObject({
			type: "AGENT_DEPLOYMENT_OWNER_NOT_MEMBER",
			nonRetryable: true,
		});
		expect(mocks.createExecution).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("propagates a membership lookup error for retry", async () => {
		mocks.member.mockRejectedValue(new Error("lookup failed"));
		await expect(startAgentExecution(startInput)).rejects.toThrow(
			"lookup failed",
		);
		expect(mocks.createExecution).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("still starts a current member's execution", async () => {
		await expect(startAgentExecution(startInput)).resolves.toMatchObject({
			success: true,
		});
		expect(mocks.member).toHaveBeenCalledWith(deployment);
		expect(mocks.createExecution).toHaveBeenCalledTimes(1);
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});
});

describe("signalSupervisorForScheduledExecution", () => {
	it("skips a removed owner without creating an execution", async () => {
		mocks.member.mockResolvedValue(false);
		await expect(
			signalSupervisorForScheduledExecution(scheduleInput),
		).resolves.toMatchObject({ success: false });
		expect(mocks.createScheduled).not.toHaveBeenCalled();
		expect(mocks.signal).not.toHaveBeenCalled();
	});

	it("propagates a membership lookup error for retry", async () => {
		mocks.member.mockRejectedValue(new Error("lookup failed"));
		await expect(
			signalSupervisorForScheduledExecution(scheduleInput),
		).rejects.toThrow("lookup failed");
		expect(mocks.createScheduled).not.toHaveBeenCalled();
	});

	it("queues a current member's scheduled execution", async () => {
		await expect(
			signalSupervisorForScheduledExecution(scheduleInput),
		).resolves.toMatchObject({ success: true });
		expect(mocks.createScheduled).toHaveBeenCalledTimes(1);
		expect(mocks.signal).toHaveBeenCalledTimes(1);
	});
});
