import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findInstance: vi.fn(),
	ownerMember: vi.fn(),
	quota: vi.fn(),
	transaction: vi.fn(),
	workflowStart: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		agentTemplateInstance: { findFirst: mocks.findInstance },
		$transaction: mocks.transaction,
	},
	checkExecutionQuota: mocks.quota,
	isDeploymentOwnerCurrentMember: mocks.ownerMember,
	Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } },
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));

import { executeAgent } from "../execute-agent";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findInstance.mockResolvedValue({
		id: "instance-example",
		name: "Example agent",
		executionMode: "single_turn",
		deployment: {
			id: "deployment-example",
			userId: "owner-example",
			organizationId: "example-org",
		},
	});
	mocks.quota.mockResolvedValue({ allowed: true });
	mocks.transaction.mockResolvedValue({
		idempotent: true,
		existing: { id: "execution-example", status: "PENDING", output: null },
	});
});

it("refuses an API deployment owned by a removed member before creating a run", async () => {
	mocks.ownerMember.mockResolvedValue(false);
	const result = await executeAgent("instance-example", { input: {} }, {
		userId: "caller-example",
		organizationId: "example-org",
	} as never);
	expect(result).toMatchObject({ error: "Agent not found", status: 404 });
	expect(mocks.transaction).not.toHaveBeenCalled();
	expect(mocks.workflowStart).not.toHaveBeenCalled();
});
