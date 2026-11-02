import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	triggerById: vi.fn(),
	createTrigger: vi.fn(),
	triggerByUrl: vi.fn(),
	update: vi.fn(),
	remove: vi.fn(),
	createExecution: vi.fn(),
	getDeployment: vi.fn(),
	membership: vi.fn(),
	ownerMember: vi.fn(),
	quota: vi.fn(),
	signal: vi.fn(),
	incrementRunCount: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		agentDeploymentTrigger: {
			findUnique: mocks.triggerById,
			findFirst: mocks.triggerByUrl,
			update: mocks.update,
			delete: mocks.remove,
			create: mocks.createTrigger,
		},
		agentDeploymentExecution: { create: mocks.createExecution },
	},
	getAgentDeploymentById: mocks.getDeployment,
	isDeploymentOwnerCurrentMember: mocks.ownerMember,
	checkExecutionQuota: mocks.quota,
	incrementInstanceRunCount: mocks.incrementRunCount,
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { getHandle: () => ({ signal: mocks.signal }) },
	}),
}));
vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => value,
	decryptApiKeyMaybe: (value: string) => value,
}));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.membership,
}));
vi.mock("../../lib/sync-triggers", () => ({
	assertPersistedSlackTriggerBinding: vi.fn(),
}));
const procedure = vi.hoisted(() => ({
	use() {
		return this;
	},
	input() {
		return this;
	},
	handler(fn: unknown) {
		return { _handler: fn };
	},
}));
vi.mock("../../../../orpc/procedures", () => ({
	tenantProtectedProcedure: procedure,
	publicProcedure: procedure,
	Permissions: {
		AGENT_UPDATE: "agent:update",
		AGENT_EXECUTE: "AGENT_EXECUTE",
	},
	requirePermission: () => () => {},
	requireInputOrgPermission: () => () => {},
	resolveOrganizationId: (id: string | null | undefined) => id ?? undefined,
}));

import {
	createTriggerProcedure,
	deleteTriggerProcedure,
	regenerateWebhookSecretProcedure,
	updateTriggerProcedure,
} from "../triggers";
import { handleWebhookProcedure } from "../webhook-handler";

type Handler = {
	_handler: (args: {
		input: Record<string, unknown>;
		context?: unknown;
	}) => Promise<unknown>;
};
const handlers = [
	[
		"update",
		(updateTriggerProcedure as unknown as Handler)._handler,
		"update",
	],
	[
		"delete",
		(deleteTriggerProcedure as unknown as Handler)._handler,
		"remove",
	],
	[
		"regenerate secret",
		(regenerateWebhookSecretProcedure as unknown as Handler)._handler,
		"update",
	],
] as const;
const webhook = (handleWebhookProcedure as unknown as Handler)._handler;
const createTrigger = (createTriggerProcedure as unknown as Handler)._handler;
const context = {
	user: { id: "editor-example" },
	session: { activeOrganizationId: "example-org" },
};
const deployment = {
	id: "deployment-example",
	userId: "owner-example",
	organizationId: "example-org",
	status: "ACTIVE",
	supervisorWorkflowId: "supervisor-example",
	instanceId: "instance-example",
};
const trigger = {
	id: "trigger-example",
	deploymentId: deployment.id,
	deployment,
	userId: deployment.userId,
	organizationId: deployment.organizationId,
	type: "WEBHOOK",
	isActive: true,
	config: { requireAuth: false },
	webhookUrl: "/api/webhooks/agent/example",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.triggerById.mockResolvedValue(trigger);
	mocks.triggerByUrl.mockResolvedValue(trigger);
	mocks.getDeployment.mockResolvedValue(deployment);
	mocks.membership.mockResolvedValue({ role: "member" });
	mocks.ownerMember.mockResolvedValue(true);
	mocks.quota.mockResolvedValue({ allowed: true });
	mocks.update.mockResolvedValue(trigger);
	mocks.createTrigger.mockResolvedValue(trigger);
	mocks.createExecution.mockResolvedValue({ id: "execution-example" });
});

for (const [name, handler, mutation] of handlers) {
	describe(`${name} trigger`, () => {
		it("refuses a non-member before mutation", async () => {
			mocks.membership.mockResolvedValue(null);
			await expect(
				handler({
					input: {
						triggerId: trigger.id,
						organizationId: "example-org",
					},
					context,
				}),
			).rejects.toThrow();
			expect(mocks[mutation]).not.toHaveBeenCalled();
		});

		it("refuses a forged organization even if its membership exists", async () => {
			await expect(
				handler({
					input: {
						triggerId: trigger.id,
						organizationId: "other-example-org",
					},
					context,
				}),
			).rejects.toThrow();
			expect(mocks[mutation]).not.toHaveBeenCalled();
		});

		it("allows a member of the deployment's organization", async () => {
			await handler({
				input: { triggerId: trigger.id, organizationId: "example-org" },
				context: {
					...context,
					session: {
						activeOrganizationId: "other-example-org",
						activeOrganizationRole: "viewer",
					},
				},
			});
			expect(mocks.membership).toHaveBeenCalledWith(
				"example-org",
				"editor-example",
			);
			expect(mocks[mutation]).toHaveBeenCalledTimes(1);
		});

		it("refuses a target-org viewer even when the active-org role is admin", async () => {
			mocks.membership.mockResolvedValue({ role: "viewer" });
			await expect(
				handler({
					input: {
						triggerId: trigger.id,
						organizationId: "example-org",
					},
					context: {
						...context,
						session: {
							activeOrganizationId: "other-example-org",
							activeOrganizationRole: "admin",
						},
					},
				}),
			).rejects.toThrow();
			expect(mocks[mutation]).not.toHaveBeenCalled();
		});
	});
}

it("rechecks update permission before writing after Slack validation", async () => {
	mocks.membership
		.mockResolvedValueOnce({ role: "member" })
		.mockResolvedValueOnce({ role: "viewer" });
	await expect(
		(updateTriggerProcedure as unknown as Handler)._handler({
			input: {
				triggerId: trigger.id,
				organizationId: "example-org",
				isActive: true,
			},
			context,
		}),
	).rejects.toThrow("permission");
	expect(mocks.update).not.toHaveBeenCalled();
});

describe("create trigger", () => {
	const input = {
		deploymentId: deployment.id,
		organizationId: "example-org",
		type: "WEBHOOK",
		config: { requireAuth: false },
		isActive: true,
	};
	it("refuses a target-org viewer even when the active-org role is admin", async () => {
		mocks.membership.mockResolvedValue({ role: "viewer" });
		await expect(
			createTrigger({
				input,
				context: {
					...context,
					session: {
						activeOrganizationId: "other-example-org",
						activeOrganizationRole: "admin",
					},
				},
			}),
		).rejects.toThrow();
		expect(mocks.createTrigger).not.toHaveBeenCalled();
	});
	it("allows a member with agent update in the deployment organization", async () => {
		await createTrigger({
			input,
			context: {
				...context,
				session: {
					activeOrganizationId: "other-example-org",
					activeOrganizationRole: "viewer",
				},
			},
		});
		expect(mocks.createTrigger).toHaveBeenCalledTimes(1);
	});
});

describe("webhook procedure", () => {
	it("propagates a membership lookup error without queueing", async () => {
		mocks.ownerMember.mockRejectedValue(new Error("lookup failed"));
		await expect(
			webhook({ input: { webhookUrl: trigger.webhookUrl } }),
		).rejects.toThrow("lookup failed");
		expect(mocks.createExecution).not.toHaveBeenCalled();
		expect(mocks.signal).not.toHaveBeenCalled();
	});
	it("refuses a removed owner before creating an execution", async () => {
		mocks.ownerMember.mockResolvedValue(false);
		await expect(
			webhook({ input: { webhookUrl: trigger.webhookUrl } }),
		).rejects.toThrow("Webhook not found");
		expect(mocks.createExecution).not.toHaveBeenCalled();
		expect(mocks.signal).not.toHaveBeenCalled();
	});

	it("hides a removed owner's webhook before signature validation", async () => {
		mocks.ownerMember.mockResolvedValue(false);
		mocks.triggerByUrl.mockResolvedValue({
			...trigger,
			config: { requireAuth: true },
		});
		await expect(
			webhook({ input: { webhookUrl: trigger.webhookUrl } }),
		).rejects.toThrow("Webhook not found");
		expect(mocks.createExecution).not.toHaveBeenCalled();
	});

	it("rechecks membership immediately before queueing", async () => {
		mocks.ownerMember
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		await expect(
			webhook({ input: { webhookUrl: trigger.webhookUrl } }),
		).rejects.toThrow("Webhook not found");
		expect(mocks.createExecution).not.toHaveBeenCalled();
	});

	it("still queues a current owner's webhook", async () => {
		await webhook({ input: { webhookUrl: trigger.webhookUrl } });
		expect(mocks.ownerMember).toHaveBeenCalledWith(deployment);
		expect(mocks.createExecution).toHaveBeenCalledTimes(1);
		expect(mocks.signal).toHaveBeenCalledTimes(1);
	});
});
