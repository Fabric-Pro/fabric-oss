import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	deployment: vi.fn(),
	trigger: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	signal: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	checkExecutionQuota: async () => ({ allowed: true }),
	isDeploymentOwnerCurrentMember: async () => true,
	db: {
		agentDeployment: { findUnique: m.deployment },
		agentDeploymentTrigger: { findFirst: m.trigger, update: m.update },
		agentDeploymentExecution: { create: m.create },
	},
}));
vi.mock("../../client", () => ({
	getTemporalClient: async () => ({
		workflow: { getHandle: () => ({ signal: m.signal }) },
	}),
}));

import { signalSupervisorForScheduledExecution } from "../schedule-trigger";

beforeEach(() => {
	vi.clearAllMocks();
	m.deployment.mockResolvedValue({
		id: "example-deployment",
		status: "ACTIVE",
		userId: "example-user",
		organizationId: "example-org",
	});
	m.trigger.mockResolvedValue({
		id: "example-trigger",
		deploymentId: "example-deployment",
		isActive: true,
		config: { name: "Example schedule" },
		cronExpression: "0 9 * * *",
		timezone: "UTC",
	});
	m.create.mockImplementation(async ({ data }: { data: object }) => ({
		id: "example-row",
		...data,
	}));
});
it("signals the scheduled execution UUID while retaining row IDs in the response and trigger foreign key", async () => {
	const result = await signalSupervisorForScheduledExecution({
		supervisorWorkflowId: "example-supervisor",
		deploymentId: "example-deployment",
		triggerId: "example-trigger",
		triggerType: "SCHEDULE",
	});
	const row = await m.create.mock.results[0].value;
	expect(m.signal).toHaveBeenCalledWith(
		"execute",
		expect.objectContaining({ executionId: row.executionId }),
	);
	expect(row.executionId).not.toBe(row.id);
	expect(result).toEqual({ success: true, executionId: "example-row" });
	expect(m.update).toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({ lastExecutionId: "example-row" }),
		}),
	);
});
