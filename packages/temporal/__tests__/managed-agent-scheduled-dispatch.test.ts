import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	current: vi.fn(),
	scope: vi.fn(),
	find: vi.fn(),
	admit: vi.fn(),
	dispatch: vi.fn(),
	normalize: vi.fn(),
	quota: vi.fn(),
}));
vi.mock("@temporalio/activity", () => ({ Context: { current: m.current } }));
vi.mock("@repo/agent-types/agent-implementation", () => ({
	getAgentImplementationAvailability: () => ({ available: true }),
}));
vi.mock("@repo/database", () => ({
	db: { agentDeploymentExecution: { findFirst: m.find } },
	getAgentTemplateInstanceForExecution: m.scope,
	agentExecutionAdmissionId: () => "example-admission",
	normalizeAgentExecutionRequest: m.normalize,
	admitAgentDeploymentExecution: m.admit,
	checkExecutionQuota: m.quota,
	readAgentExecutionAdmission: (row: any) => row.metadata.fabricAdmission,
}));
vi.mock("../src/lib/agent-execution-dispatch", () => ({
	dispatchAdmittedAgentExecution: m.dispatch,
}));
vi.mock("../src/client", () => ({ getTemporalClient: vi.fn() }));

import { dispatchManagedAgentSchedule } from "../src/activities/lib/managed-agent-scheduled-dispatch";

const input = {
	managedRunSchedule: 1 as const,
	deploymentId: "example-deployment",
	triggerId: "fabric-run-schedule-example-deployment",
	userId: "example-user",
	organizationId: "example-org",
	occurrenceWorkflowId: "example-occurrence",
	occurrenceFirstRunId: "example-first-run",
};
const deployment = {
	id: input.deploymentId,
	instanceId: "example-instance",
	userId: input.userId,
	organizationId: input.organizationId,
	status: "ACTIVE",
};
const trigger = {
	id: input.triggerId,
	deploymentId: deployment.id,
	userId: input.userId,
	organizationId: input.organizationId,
	type: "SCHEDULE",
	isActive: true,
	config: {
		fabricManagedRunSchedule: 1,
		inputTemplate: { message: "Original scheduled request" },
	},
};
const row = {
	id: "example-admission",
	input: { message: "Original scheduled request" },
	metadata: {
		fabricAdmission: {
			dispatch: {
				instanceId: deployment.instanceId,
				workflowType: "nativeDeploymentExecutionWorkflow",
			},
		},
	},
};
beforeEach(() => {
	vi.resetAllMocks();
	m.current.mockReturnValue({
		info: {
			workflowType: "managedAgentRunScheduleWorkflow",
			workflowExecution: { workflowId: input.occurrenceWorkflowId },
		},
	});
	m.scope.mockResolvedValue({
		instance: {
			status: "ACTIVE",
			customInstructions: {},
			executionMode: "standard",
		},
		projectId: "example-project",
	});
	m.find.mockResolvedValue(null);
	m.quota.mockResolvedValue({ allowed: true });
	m.admit.mockResolvedValue({ execution: row });
	m.dispatch.mockResolvedValue({ confirmed: true, execution: row });
	m.normalize.mockImplementation((value) => value);
});
describe("managed schedule occurrence admission", () => {
	it("recovers an occurrence admitted concurrently while quota preflight became exhausted", async () => {
		m.find.mockResolvedValueOnce(null).mockResolvedValueOnce(row);
		m.quota.mockResolvedValue({ allowed: false });
		expect(
			await dispatchManagedAgentSchedule(input, deployment, trigger),
		).toMatchObject({ success: true, executionId: row.id });
		expect(m.find).toHaveBeenCalledTimes(2);
		expect(m.find.mock.calls[1][0]).toEqual(m.find.mock.calls[0][0]);
		expect(m.admit).not.toHaveBeenCalled();
		expect(m.dispatch).toHaveBeenCalledOnce();
	});
	it("initializes native quota before the first scheduled admission", async () => {
		await dispatchManagedAgentSchedule(input, deployment, trigger);
		expect(m.quota).toHaveBeenCalledExactlyOnceWith(
			deployment.id,
			deployment.userId,
			input.organizationId,
		);
		expect(m.quota.mock.invocationCallOrder[0]).toBeLessThan(
			m.admit.mock.invocationCallOrder[0],
		);
	});
	it("reconciles a previously reserved occurrence even after quota exhaustion", async () => {
		m.find.mockResolvedValue(row);
		m.quota.mockResolvedValue({ allowed: false });
		expect(
			await dispatchManagedAgentSchedule(input, deployment, trigger),
		).toMatchObject({ success: true });
		expect(m.quota).not.toHaveBeenCalled();
		expect(m.admit).not.toHaveBeenCalled();
		expect(m.dispatch).toHaveBeenCalledOnce();
	});
	it("does not admit new scheduled work when initialized quota is exhausted", async () => {
		m.quota.mockResolvedValue({ allowed: false, reason: "Quota spent" });
		expect(
			await dispatchManagedAgentSchedule(input, deployment, trigger),
		).toEqual({ success: false, error: "Quota spent" });
		expect(m.admit).not.toHaveBeenCalled();
		expect(m.dispatch).not.toHaveBeenCalled();
	});
	it("honors configured message, exact tenant/project and one stable occurrence key", async () => {
		expect(
			await dispatchManagedAgentSchedule(input, deployment, trigger),
		).toEqual({ success: true, executionId: row.id });
		const admission = m.admit.mock.calls[0][0];
		expect(admission).toMatchObject({
			organizationId: input.organizationId,
			userId: input.userId,
			deploymentId: deployment.id,
			triggerType: "SCHEDULE",
			triggerId: trigger.id,
			request: { input: { message: "Original scheduled request" } },
			dispatch: { projectId: "example-project" },
		});
		await dispatchManagedAgentSchedule(input, deployment, trigger);
		expect(m.admit.mock.calls[1][0].idempotencyKey).toBe(
			admission.idempotencyKey,
		);
	});
	it("recovers admitted original snapshot after message/dispatch configuration changed", async () => {
		m.find.mockResolvedValue(row);
		const edited = {
			...trigger,
			config: {
				fabricManagedRunSchedule: 1,
				inputTemplate: { message: "Edited request" },
			},
		};
		await dispatchManagedAgentSchedule(input, deployment, edited);
		expect(m.admit).not.toHaveBeenCalled();
		expect(m.normalize).not.toHaveBeenCalled();
		expect(m.dispatch.mock.calls[0][0]).toBe(row);
	});
	it("retries lost dispatch acknowledgement against the existing occurrence rather than another admission", async () => {
		m.dispatch.mockResolvedValueOnce({ confirmed: false });
		await expect(
			dispatchManagedAgentSchedule(input, deployment, trigger),
		).rejects.toThrow("same occurrence");
		m.find.mockResolvedValue(row);
		await dispatchManagedAgentSchedule(input, deployment, trigger);
		expect(m.admit).toHaveBeenCalledOnce();
		expect(m.dispatch).toHaveBeenCalledTimes(2);
	});
	it.each([
		{ organizationId: "another-org" },
		{ userId: "another-user" },
		{ occurrenceWorkflowId: "another-workflow" },
	])("refuses forged occurrence tuple %j before admission", async (patch) => {
		expect(
			await dispatchManagedAgentSchedule(
				{ ...input, ...patch },
				deployment,
				trigger,
			),
		).toMatchObject({ success: false });
		expect(m.admit).not.toHaveBeenCalled();
		expect(m.dispatch).not.toHaveBeenCalled();
	});
	it("refuses the old workflow type even with a marker", async () => {
		m.current.mockReturnValue({
			info: {
				workflowType: "scheduleTriggerWorkflow",
				workflowExecution: { workflowId: input.occurrenceWorkflowId },
			},
		});
		expect(
			await dispatchManagedAgentSchedule(input, deployment, trigger),
		).toMatchObject({ success: false });
		expect(m.admit).not.toHaveBeenCalled();
	});
	it("rechecks current execution authority even for previously admitted occurrence", async () => {
		m.find.mockResolvedValue(row);
		m.scope.mockResolvedValue(null);
		expect(
			await dispatchManagedAgentSchedule(input, deployment, trigger),
		).toMatchObject({ success: false });
		expect(m.dispatch).not.toHaveBeenCalled();
	});
	it.each([
		{ isActive: false },
		{ organizationId: "another-org" },
		{ deploymentId: "another-deployment" },
	])("refuses inactive or foreign trigger %j", async (patch) => {
		expect(
			await dispatchManagedAgentSchedule(input, deployment, {
				...trigger,
				...patch,
			}),
		).toMatchObject({ success: false });
		expect(m.dispatch).not.toHaveBeenCalled();
	});
});
