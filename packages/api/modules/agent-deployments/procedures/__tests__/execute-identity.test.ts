import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	membership: vi.fn(),
	deployment: vi.fn(),
	scope: vi.fn(),
	quota: vi.fn(),
	create: vi.fn(),
	find: vi.fn(),
	signal: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getOrganizationMembership: m.membership,
	getTenantContext: () => ({}),
	grantProjectAccess: vi.fn(),
	getAgentDeploymentById: m.deployment,
	getAgentTemplateInstanceForExecution: m.scope,
	isDeploymentOwnerCurrentMember: async () => true,
	checkExecutionQuota: m.quota,
	db: { agentDeploymentExecution: { create: m.create, findFirst: m.find } },
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { getHandle: () => ({ signal: m.signal }) },
	}),
}));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: m.membership,
}));
vi.mock("../../../../orpc/procedures", async () => {
	const { os } = await import("@orpc/server");
	const { Permissions } = await import("@repo/permissions");
	const { requireInputOrgPermission } = await import(
		"../../../../orpc/middleware/require-permission"
	);
	return {
		tenantProtectedProcedure: os,
		Permissions,
		requireInputOrgPermission,
		resolveOrganizationId: (
			id: unknown,
			session: { activeOrganizationId: string },
		) => (id === undefined ? session.activeOrganizationId : id),
	};
});

import {
	cancelExecutionProcedure,
	executeDeploymentProcedure,
} from "../execute";

const context = {
	user: { id: "example-user", email: "dev@example.com", name: "Example" },
	session: { activeOrganizationId: "example-org" },
	activeOrganizationRole: "owner",
	allowedProjectIds: [],
	tenantContext: {
		type: "organization" as const,
		userId: "example-user",
		organizationId: "example-org",
	},
	headers: new Headers(),
};
const deployment = {
	id: "example-deployment",
	instanceId: "example-instance",
	userId: "example-user",
	organizationId: "example-org",
	status: "ACTIVE",
	supervisorWorkflowId: "example-supervisor",
};
const execution = {
	id: "example-row",
	executionId: "00000000-0000-4000-8000-000000000001",
	deploymentId: "example-deployment",
	userId: "example-user",
	organizationId: "example-org",
};
const execute = () =>
	call(
		executeDeploymentProcedure,
		{
			deploymentId: "example-deployment",
			organizationId: "example-org",
			input: { message: "Example task" },
		},
		{ context },
	);
const cancel = () =>
	call(
		cancelExecutionProcedure,
		{
			deploymentId: "example-deployment",
			executionId: "example-row",
			organizationId: "example-org",
		},
		{ context },
	);
beforeEach(() => {
	vi.clearAllMocks();
	m.membership.mockResolvedValue({ role: "admin" });
	m.deployment.mockResolvedValue({ ...deployment });
	m.scope.mockResolvedValue({
		instance: {
			id: "example-instance",
			organizationId: "example-org",
			customInstructions: {},
		},
		projectId: "example-project",
	});
	m.quota.mockResolvedValue({ allowed: true });
	m.create.mockImplementation(
		async ({ data }: { data: Record<string, unknown> }) => ({
			id: "example-row",
			createdAt: new Date("2026-01-01T00:00:00Z"),
			...data,
		}),
	);
	m.find.mockResolvedValue({ ...execution });
	m.signal.mockResolvedValue(undefined);
});
describe("manual deployment execution identity", () => {
	it("signals the stored workflow UUID while keeping the UI row ID in its receipt", async () => {
		const result = await execute();
		const created = m.create.mock.results[0];
		const row = await created.value;
		expect(row.executionId).not.toBe(row.id);
		expect(m.signal).toHaveBeenCalledWith(
			"execute",
			expect.objectContaining({ executionId: row.executionId }),
		);
		expect(result.execution.id).toBe("example-row");
		expect(m.scope).toHaveBeenCalledWith({
			instanceId: "example-instance",
			userId: "example-user",
			organizationId: "example-org",
		});
	});
	it("loads a same-owner/org/deployment row and translates its UI row ID to the cancellation UUID", async () => {
		await cancel();
		expect(m.find).toHaveBeenCalledWith({
			where: {
				id: "example-row",
				deploymentId: "example-deployment",
				userId: "example-user",
				organizationId: "example-org",
			},
			select: {
				id: true,
				executionId: true,
				deploymentId: true,
				userId: true,
				organizationId: true,
			},
		});
		expect(m.signal).toHaveBeenCalledWith("cancelExecution", {
			executionId: execution.executionId,
		});
	});
	it.each(["execute", "cancel"])(
		"rejects foreign actor and foreign organization deployment rows for %s",
		async (method) => {
			for (const row of [
				{ ...deployment, userId: "other-user" },
				{ ...deployment, organizationId: "other-org" },
			]) {
				m.deployment.mockResolvedValue(row);
				await expect(
					method === "execute" ? execute() : cancel(),
				).rejects.toMatchObject({ code: "NOT_FOUND" });
			}
			expect(m.create).not.toHaveBeenCalled();
			expect(m.signal).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ deploymentId: "other-deployment" },
		{ userId: "other-user" },
		{ organizationId: "other-org" },
	])("refuses a cancellation row from another scope %j", async (fields) => {
		m.find.mockResolvedValue({ ...execution, ...fields });
		await expect(cancel()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.signal).not.toHaveBeenCalled();
	});
	it("does not let a member of two organizations cancel an execution in the wrong requested organization", async () => {
		await expect(
			call(
				cancelExecutionProcedure,
				{
					deploymentId: "example-deployment",
					executionId: "example-row",
					organizationId: "other-org",
				},
				{ context },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.membership).toHaveBeenCalledWith("other-org", "example-user");
		expect(m.signal).not.toHaveBeenCalled();
	});
	it.each(["execute", "cancel"])(
		"rechecks project/instance execution access and native implementation before %s",
		async (method) => {
			m.scope.mockResolvedValue(null);
			await expect(
				method === "execute" ? execute() : cancel(),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			m.scope.mockResolvedValue({
				instance: {
					id: "example-instance",
					organizationId: "example-org",
					customInstructions: {
						portableImplementation: { kind: "harness_finite" },
					},
				},
			});
			await expect(
				method === "execute" ? execute() : cancel(),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(m.create).not.toHaveBeenCalled();
			expect(m.signal).not.toHaveBeenCalled();
		},
	);
	it("checks live requested-organization permission before loading deployment state", async () => {
		m.membership.mockResolvedValue(null);
		await expect(execute()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.deployment).not.toHaveBeenCalled();
		expect(m.create).not.toHaveBeenCalled();
	});
});
