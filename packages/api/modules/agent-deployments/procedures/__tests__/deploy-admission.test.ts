import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	instance: vi.fn(),
	existing: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	receipt: vi.fn(),
	quota: vi.fn(),
	start: vi.fn(),
	describe: vi.fn(),
	triggers: vi.fn(),
	triggerUpdate: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getAgentTemplateInstance: m.instance,
	getAgentDeploymentByInstanceId: m.existing,
	createAgentDeployment: m.create,
	db: {
		agentDeployment: { update: m.update },
		agentDeploymentTrigger: {
			findMany: m.triggers,
			update: m.triggerUpdate,
		},
	},
	setDeploymentSupervisor: m.receipt,
	checkDeploymentQuota: m.quota,
	resolveWorkflowIntegrationForProvider: vi.fn(),
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: m.start,
			getHandle: () => ({ describe: m.describe }),
		},
	}),
	getScheduleClient: vi.fn(),
}));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async () => ({ role: "admin" }),
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));
vi.mock("../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		input: () => chain,
		handler: (run: unknown) => ({ _handler: run }),
	};
	return {
		tenantProtectedProcedure: chain,
		Permissions: { AGENT_UPDATE: "update" },
		requireInputOrgPermission: () => () => {},
		resolveOrganizationId: (
			id: unknown,
			s: { activeOrganizationId: string },
		) => (id === undefined ? s.activeOrganizationId : id),
	};
});

import { deployProcedure } from "../deploy";

const invoke = (input: Record<string, unknown> = {}) =>
	(
		deployProcedure as unknown as {
			_handler: (a: unknown) => Promise<unknown>;
		}
	)._handler({
		input: { instanceId: "example-instance", ...input },
		context: {
			user: { id: "example-user" },
			session: { activeOrganizationId: "example-org" },
		},
	});
const deployment = {
	id: "example-deployment",
	instanceId: "example-instance",
	userId: "example-user",
	organizationId: "example-org",
	name: "Example",
	status: "PENDING",
	maxConcurrentExecutions: 5,
	rateLimitPerMinute: 60,
	rateLimitPerHour: 500,
	supervisorWorkflowId: null,
	supervisorRunId: null,
};
beforeEach(() => {
	vi.clearAllMocks();
	m.instance.mockResolvedValue({
		id: "example-instance",
		userId: "example-user",
		organizationId: "example-org",
		name: "Example",
		customInstructions: {},
		triggers: [],
	});
	m.existing.mockResolvedValue(null);
	m.create.mockResolvedValue({ ...deployment });
	m.update.mockImplementation(async ({ data }: { data: object }) => ({
		...deployment,
		...data,
	}));
	m.quota.mockResolvedValue({ allowed: true });
	m.start.mockResolvedValue({ firstExecutionRunId: "example-run" });
	m.receipt.mockResolvedValue(deployment);
});
describe("deployment admission and recovery", () => {
	it("preserves the managed run schedule while reconciling removed advanced triggers", async () => {
		m.instance.mockResolvedValue({
			id: "example-instance",
			userId: "example-user",
			organizationId: "example-org",
			name: "Example",
			customInstructions: {},
			triggers: [{ type: "manual", enabled: true }],
		});
		m.triggers.mockResolvedValue([
			{
				id: "fabric-run-schedule-example-deployment",
				type: "SCHEDULE",
				slackChannelId: null,
				isActive: true,
				config: {
					fabricManagedRunSchedule: 1,
					inputTemplate: { message: "Example" },
				},
			},
			{
				id: "example-advanced",
				type: "SCHEDULE",
				slackChannelId: null,
				isActive: true,
				config: {},
			},
		]);
		await invoke();
		expect(m.triggerUpdate).toHaveBeenCalledExactlyOnceWith({
			where: { id: "example-advanced" },
			data: { isActive: false },
		});
	});
	it("refuses a foreign instance even for its owner before creating anything", async () => {
		m.instance.mockResolvedValue({
			userId: "example-user",
			organizationId: "other-org",
		});
		await expect(invoke()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.create).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});
	it("refuses unavailable code-backed implementations instead of native fallback", async () => {
		m.instance.mockResolvedValue({
			userId: "example-user",
			organizationId: "example-org",
			customInstructions: {
				portableImplementation: { kind: "harness_finite" },
			},
		});
		await expect(invoke()).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.start).not.toHaveBeenCalled();
	});
	it("persists one identity before dispatch and uses the worker-polled queue", async () => {
		await invoke();
		expect(m.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					supervisorWorkflowId: "agent-supervisor-example-deployment",
					taskQueue: "agents",
				},
			}),
		);
		expect(m.update.mock.invocationCallOrder[0]).toBeLessThan(
			m.start.mock.invocationCallOrder[0]!,
		);
		expect(m.start).toHaveBeenCalledWith(
			"agentSupervisorWorkflow",
			expect.objectContaining({
				workflowId: "agent-supervisor-example-deployment",
				taskQueue: "agents",
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				workflowIdConflictPolicy: "FAIL",
			}),
		);
		expect(m.receipt).toHaveBeenCalledWith(
			"example-deployment",
			"agent-supervisor-example-deployment",
			"example-run",
			"agents",
		);
	});
	it("keeps an unresolved durable intent after a lost start response", async () => {
		m.start.mockRejectedValue(new Error("transport failure"));
		await expect(invoke()).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			data: {
				deploymentId: "example-deployment",
				workflowId: "agent-supervisor-example-deployment",
			},
		});
		expect(m.receipt).not.toHaveBeenCalled();
		expect(m.update).toHaveBeenCalledTimes(1);
	});
	it("reattaches an existing receipt without starting or charging a second supervisor", async () => {
		m.existing.mockResolvedValue({
			...deployment,
			supervisorWorkflowId: "agent-supervisor-example-deployment",
			supervisorRunId: "example-run",
			status: "ACTIVE",
		});
		await invoke();
		expect(m.create).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
		expect(m.receipt).not.toHaveBeenCalled();
	});
	it("does not replace configuration while recovering an admitted intent", async () => {
		m.existing.mockResolvedValue({
			...deployment,
			supervisorWorkflowId: "agent-supervisor-example-deployment",
		});
		await invoke({ config: { maxConcurrentExecutions: 90 } });
		expect(m.create).not.toHaveBeenCalled();
		expect(m.start).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				args: [
					expect.objectContaining({
						config: expect.objectContaining({
							maxConcurrentExecutions: 5,
						}),
					}),
				],
			}),
		);
	});
});
