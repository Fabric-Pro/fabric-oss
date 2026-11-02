import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getDeployment: vi.fn(),
	membership: vi.fn(),
	ownerMember: vi.fn(),
	quota: vi.fn(),
	create: vi.fn(),
	signal: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getAgentDeploymentById: mocks.getDeployment,
	isDeploymentOwnerCurrentMember: mocks.ownerMember,
	checkExecutionQuota: mocks.quota,
	db: { agentDeploymentExecution: { create: mocks.create } },
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { getHandle: () => ({ signal: mocks.signal }) },
	}),
}));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.membership,
}));
vi.mock("../../../../orpc/procedures", () => ({
	tenantProtectedProcedure: {
		use() {
			return this;
		},
		input() {
			return this;
		},
		handler(fn: unknown) {
			return { _handler: fn };
		},
	},
	Permissions: { AGENT_EXECUTE: "AGENT_EXECUTE" },
	requirePermission: () => () => {},
	resolveOrganizationId: (id: string) => id,
}));

import { executeDeploymentProcedure } from "../execute";

const handler = (
	executeDeploymentProcedure as unknown as {
		_handler: (args: unknown) => Promise<unknown>;
	}
)._handler;
const deployment = {
	id: "deployment-example",
	userId: "owner-example",
	organizationId: "example-org",
	status: "ACTIVE",
	supervisorWorkflowId: "supervisor-example",
};
const args = {
	input: {
		deploymentId: deployment.id,
		organizationId: "example-org",
		priority: "NORMAL",
	},
	context: { user: { id: deployment.userId }, session: {} },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getDeployment.mockResolvedValue(deployment);
	mocks.membership.mockResolvedValue({ role: "member" });
	mocks.ownerMember.mockResolvedValue(true);
	mocks.quota.mockResolvedValue({ allowed: true });
	mocks.create.mockResolvedValue({
		id: "execution-example",
		status: "PENDING",
	});
});

it("refuses a manual run when the deployment owner is no longer a member", async () => {
	mocks.ownerMember.mockResolvedValue(false);
	await expect(handler(args)).rejects.toThrow("Deployment not found");
	expect(mocks.create).not.toHaveBeenCalled();
	expect(mocks.signal).not.toHaveBeenCalled();
});

it("queues a current owner's manual run", async () => {
	await handler(args);
	expect(mocks.ownerMember).toHaveBeenCalledWith(deployment);
	expect(mocks.create).toHaveBeenCalledTimes(1);
	expect(mocks.signal).toHaveBeenCalledTimes(1);
});
