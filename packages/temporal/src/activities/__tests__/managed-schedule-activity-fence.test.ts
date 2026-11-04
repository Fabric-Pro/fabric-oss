import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	deployment: vi.fn(),
	trigger: vi.fn(),
	managed: vi.fn(),
	create: vi.fn(),
	signal: vi.fn(),
	AdmissionError: class AdmissionError extends Error {},
}));
vi.mock("@repo/database", () => ({
	AgentExecutionAdmissionError: m.AdmissionError,
	checkExecutionQuota: async () => ({ allowed: true }),
	db: {
		agentDeployment: { findUnique: m.deployment },
		agentDeploymentTrigger: { findFirst: m.trigger },
		agentDeploymentExecution: { create: m.create },
	},
}));
vi.mock("../lib/managed-agent-scheduled-dispatch", () => ({
	dispatchManagedAgentSchedule: m.managed,
}));
vi.mock("../../client", () => ({
	getTemporalClient: async () => ({
		workflow: { getHandle: () => ({ signal: m.signal }) },
	}),
}));

import { dispatchManagedAgentScheduledExecution } from "../schedule-trigger";

const input = {
	managedRunSchedule: 1 as const,
	userId: "example-user",
	organizationId: "example-org",
	supervisorWorkflowId: "",
	deploymentId: "example-deployment",
	triggerId: "fabric-run-schedule-example-deployment",
	triggerType: "SCHEDULE" as const,
	occurrenceWorkflowId: "example-occurrence",
	occurrenceFirstRunId: "example-first-run",
};
beforeEach(() => {
	vi.clearAllMocks();
	m.deployment.mockResolvedValue({
		id: input.deploymentId,
		status: "ACTIVE",
		userId: input.userId,
		organizationId: input.organizationId,
	});
	m.trigger.mockResolvedValue({
		id: input.triggerId,
		deploymentId: input.deploymentId,
		isActive: true,
		config: { fabricManagedRunSchedule: 1, inputTemplate: {} },
	});
	m.managed.mockResolvedValue({ success: true, executionId: "example-row" });
});
describe("distinct managed scheduled Activity", () => {
	it("refuses absent protocol before any database or legacy effect", async () => {
		await expect(
			dispatchManagedAgentScheduledExecution({
				...input,
				managedRunSchedule: undefined,
			}),
		).rejects.toMatchObject({
			type: "INVALID_MANAGED_SCHEDULE_ACTIVITY",
			nonRetryable: true,
		});
		expect(m.deployment).not.toHaveBeenCalled();
		expect(m.create).not.toHaveBeenCalled();
		expect(m.signal).not.toHaveBeenCalled();
	});
	it("delegates only to the existing current-authority managed admission path", async () => {
		expect(await dispatchManagedAgentScheduledExecution(input)).toEqual({
			success: true,
			executionId: "example-row",
		});
		expect(m.managed).toHaveBeenCalledWith(
			input,
			expect.objectContaining({ id: input.deploymentId }),
			expect.objectContaining({ id: input.triggerId }),
		);
		expect(m.create).not.toHaveBeenCalled();
		expect(m.signal).not.toHaveBeenCalled();
	});
	it("preserves explicit permanent authority refusals without falling back to legacy signaling", async () => {
		m.managed.mockResolvedValue({
			success: false,
			error: "Example current permission refused",
		});
		expect(await dispatchManagedAgentScheduledExecution(input)).toEqual({
			success: false,
			error: "Example current permission refused",
		});
		expect(m.create).not.toHaveBeenCalled();
		expect(m.signal).not.toHaveBeenCalled();
	});
	it("returns a permanent admission policy refusal instead of retrying it forever", async () => {
		m.managed.mockRejectedValue(
			new m.AdmissionError("Example quota refusal"),
		);
		expect(await dispatchManagedAgentScheduledExecution(input)).toEqual({
			success: false,
			error: "The managed schedule occurrence was refused by its admission policy.",
		});
		expect(m.create).not.toHaveBeenCalled();
	});
	it("keeps transient storage and dispatch failures retryable for the same occurrence", async () => {
		const error = new Error("Example storage outage");
		m.managed.mockRejectedValue(error);
		await expect(
			dispatchManagedAgentScheduledExecution(input),
		).rejects.toBe(error);
		expect(m.create).not.toHaveBeenCalled();
		expect(m.signal).not.toHaveBeenCalled();
	});
});
