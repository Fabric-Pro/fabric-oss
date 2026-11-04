import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	legacy: vi.fn(),
	managed: vi.fn(),
	patch: vi.fn(),
	patchEnabled: true,
}));
vi.mock("@temporalio/workflow", async () => ({
	ApplicationFailure: (await import("@temporalio/common")).ApplicationFailure,
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	patched: (id: string) => {
		m.patch(id);
		return m.patchEnabled;
	},
	workflowInfo: () => ({
		workflowId: "example-actual-occurrence",
		firstExecutionRunId: "example-actual-first-run",
	}),
	proxyActivities: (options: object) => ({
		signalSupervisorForScheduledExecution: (input: unknown) =>
			m.legacy(input, options),
		dispatchManagedAgentScheduledExecution: (input: unknown) =>
			m.managed(input, options),
	}),
}));

import {
	MANAGED_AGENT_SCHEDULE_ACTIVITY_PATCH,
	managedAgentRunScheduleWorkflow,
	scheduleTriggerWorkflow,
} from "../schedule-trigger";

const input = {
	managedRunSchedule: 1 as const,
	userId: "example-user",
	organizationId: "example-org",
	supervisorWorkflowId: "",
	deploymentId: "example-deployment",
	triggerId: "example-trigger",
	triggerType: "SCHEDULE" as const,
};
beforeEach(() => {
	vi.clearAllMocks();
	m.patchEnabled = true;
	m.legacy.mockResolvedValue({ success: true, executionId: "example-row" });
	m.managed.mockResolvedValue({ success: true, executionId: "example-row" });
});
describe("managed schedule Activity rollout fence", () => {
	it("uses a distinct task with native unlimited transient retry and trusted occurrence identity", async () => {
		expect(await managedAgentRunScheduleWorkflow(input)).toEqual({
			success: true,
			executionId: "example-row",
		});
		expect(m.patch).toHaveBeenCalledWith(
			MANAGED_AGENT_SCHEDULE_ACTIVITY_PATCH,
		);
		expect(m.managed).toHaveBeenCalledWith(
			{
				...input,
				occurrenceWorkflowId: "example-actual-occurrence",
				occurrenceFirstRunId: "example-actual-first-run",
			},
			expect.objectContaining({
				startToCloseTimeout: "1 minute",
				heartbeatTimeout: "15 seconds",
				retry: {
					initialInterval: "1s",
					backoffCoefficient: 2,
					maximumInterval: "30s",
				},
			}),
		);
		expect(m.managed.mock.calls[0][1].retry).not.toHaveProperty(
			"maximumAttempts",
		);
		expect(m.legacy).not.toHaveBeenCalled();
	});
	it("preserves recorded pre-fence managed Activity type and retry policy", async () => {
		m.patchEnabled = false;
		await managedAgentRunScheduleWorkflow(input);
		expect(m.managed).not.toHaveBeenCalled();
		expect(m.legacy).toHaveBeenCalledWith(
			expect.objectContaining({
				...input,
				occurrenceWorkflowId: "example-actual-occurrence",
			}),
			expect.objectContaining({
				retry: expect.objectContaining({ maximumAttempts: 3 }),
			}),
		);
	});
	it("keeps the generic legacy flow unchanged without even calling the patch", async () => {
		const {
			managedRunSchedule: _marker,
			userId: _user,
			organizationId: _org,
			...legacy
		} = input;
		await scheduleTriggerWorkflow(legacy);
		expect(m.legacy).toHaveBeenCalledWith(
			legacy,
			expect.objectContaining({
				retry: expect.objectContaining({ maximumAttempts: 3 }),
			}),
		);
		expect(m.managed).not.toHaveBeenCalled();
		expect(m.patch).not.toHaveBeenCalled();
	});
	it("rejects a permanent managed refusal without trying legacy signaling", async () => {
		m.managed.mockResolvedValue({
			success: false,
			error: "Example permission refused",
		});
		await expect(
			managedAgentRunScheduleWorkflow(input),
		).rejects.toMatchObject({
			type: "SCHEDULE_TRIGGER_FAILED",
			nonRetryable: true,
		});
		expect(m.legacy).not.toHaveBeenCalled();
	});
});
