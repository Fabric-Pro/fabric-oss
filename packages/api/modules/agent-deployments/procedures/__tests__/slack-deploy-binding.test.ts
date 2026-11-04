import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	create: vi.fn(),
	credentials: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		agentDeploymentTrigger: {
			findMany: mocks.findMany,
			create: mocks.create,
		},
	},
}));
vi.mock("@repo/integrations/slack", () => ({
	getSlackCredentials: mocks.credentials,
}));
vi.mock("@repo/temporal", () => ({
	getScheduleClient: vi.fn(),
	getTemporalClient: vi.fn(),
}));
vi.mock("@repo/utils", () => ({
	decryptApiKeyMaybe: () => null,
	encryptApiKey: vi.fn(),
}));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));
vi.mock("../../../../orpc/procedures", () => ({
	tenantProtectedProcedure: {
		use() {
			return this;
		},
		input() {
			return this;
		},
		handler() {
			return this;
		},
	},
	Permissions: { AGENT_UPDATE: "AGENT_UPDATE" },
	requirePermission: () => () => {},
	requireInputOrgPermission: () => () => {},
	resolveOrganizationId: (id: string) => id,
}));

import { activateInstanceTriggers } from "../deploy";

const input = {
	deploymentId: "deployment-example",
	supervisorWorkflowId: "workflow-example",
	taskQueue: "queue-example",
	userId: "editor-example",
	organizationId: "editor-org",
	slackOwnerId: "owner-example",
	slackOrganizationId: "example-org",
	instanceTriggers: [
		{
			type: "slack" as const,
			config: { teamId: "T0EXAMPLE", channelId: "C0EXAMPLE" },
		},
	],
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findMany.mockResolvedValue([]);
	mocks.create.mockResolvedValue({
		id: "trigger-example",
		type: "CHANNEL_MESSAGE",
		isActive: true,
	});
	mocks.credentials.mockResolvedValue({ teamId: "T0EXAMPLE" });
});

it("refuses activation when the owner's connection has a different team", async () => {
	mocks.credentials.mockResolvedValue({ teamId: "T0OTHER" });
	await expect(activateInstanceTriggers(input)).rejects.toThrow(/workspace/i);
	expect(mocks.create).not.toHaveBeenCalled();
});

it("writes a connected Slack trigger under the instance owner's tenant", async () => {
	await activateInstanceTriggers(input);
	expect(mocks.credentials).toHaveBeenCalledWith(
		"owner-example",
		"example-org",
		true,
	);
	expect(mocks.create).toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({
				userId: "owner-example",
				organizationId: "example-org",
				slackTeamId: "T0EXAMPLE",
				isActive: true,
				config: expect.objectContaining({
					chatIdPattern: "^T0EXAMPLE/C0EXAMPLE$",
				}),
			}),
		}),
	);
});
