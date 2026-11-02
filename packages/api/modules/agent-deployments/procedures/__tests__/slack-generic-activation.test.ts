import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	update: vi.fn(),
	getDeployment: vi.fn(),
	credentials: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		agentDeploymentTrigger: {
			findUnique: mocks.findUnique,
			update: mocks.update,
		},
	},
	getAgentDeploymentById: mocks.getDeployment,
}));
vi.mock("@repo/integrations/slack", () => ({
	getSlackCredentials: mocks.credentials,
}));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async () => ({ role: "member" }),
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
	Permissions: { AGENT_UPDATE: "agent:update" },
	requirePermission: () => () => {},
	requireInputOrgPermission: () => () => {},
	resolveOrganizationId: (id: string) => id,
}));

import { updateTriggerProcedure } from "../triggers";

const handler = (
	updateTriggerProcedure as unknown as {
		_handler: (args: unknown) => Promise<unknown>;
	}
)._handler;
const context = {
	user: { id: "editor-example" },
	session: { activeOrganizationId: "example-org" },
};
const trigger = {
	id: "trigger-example",
	deploymentId: "deployment-example",
	type: "CHANNEL_MESSAGE",
	userId: "owner-example",
	organizationId: "example-org",
	slackTeamId: "T0EXAMPLE",
	slackChannelId: "C0EXAMPLE",
	config: {
		channel: "slack",
		teamId: "T0EXAMPLE",
		chatIdPattern: "^T0EXAMPLE/C0EXAMPLE$",
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findUnique.mockResolvedValue(trigger);
	mocks.getDeployment.mockResolvedValue({
		id: "deployment-example",
		organizationId: "example-org",
	});
	mocks.credentials.mockResolvedValue({ teamId: "T0EXAMPLE" });
	mocks.update.mockResolvedValue({ ...trigger, isActive: true });
});

it("refuses generic reactivation when the Slack owner is connected to another team", async () => {
	mocks.credentials.mockResolvedValue({ teamId: "T0OTHER" });
	await expect(
		handler({
			input: {
				triggerId: "trigger-example",
				organizationId: "example-org",
				isActive: true,
			},
			context,
		}),
	).rejects.toThrow(/workspace/i);
	expect(mocks.update).not.toHaveBeenCalled();
});

it("allows generic reactivation for the owner's matching connection", async () => {
	await handler({
		input: {
			triggerId: "trigger-example",
			organizationId: "example-org",
			isActive: true,
		},
		context,
	});
	expect(mocks.credentials).toHaveBeenCalledWith(
		"owner-example",
		"example-org",
		true,
	);
	expect(mocks.update).toHaveBeenCalled();
});

it("refuses generic reactivation when the owner connection cannot be read", async () => {
	mocks.credentials.mockRejectedValue(new Error("unreadable"));
	await expect(
		handler({
			input: {
				triggerId: "trigger-example",
				organizationId: "example-org",
				isActive: true,
			},
			context,
		}),
	).rejects.toThrow();
	expect(mocks.update).not.toHaveBeenCalled();
});

it("refuses a Slack trigger stored under another organization", async () => {
	mocks.findUnique.mockResolvedValue({
		...trigger,
		organizationId: "other-org",
	});
	await expect(
		handler({
			input: {
				triggerId: "trigger-example",
				organizationId: "example-org",
				isActive: true,
			},
			context,
		}),
	).rejects.toThrow(/organization/i);
	expect(mocks.update).not.toHaveBeenCalled();
});

it("refuses a Slack trigger with an unsafe stored pattern", async () => {
	mocks.findUnique.mockResolvedValue({
		...trigger,
		config: { ...trigger.config, chatIdPattern: ".*" },
	});
	await expect(
		handler({
			input: {
				triggerId: "trigger-example",
				organizationId: "example-org",
				isActive: true,
			},
			context,
		}),
	).rejects.toThrow(/workspace/i);
	expect(mocks.update).not.toHaveBeenCalled();
});

it("leaves webhook activation independent of Slack", async () => {
	mocks.findUnique.mockResolvedValue({
		...trigger,
		type: "WEBHOOK",
		slackTeamId: null,
		config: { requireAuth: true },
	});
	await handler({
		input: {
			triggerId: "trigger-example",
			organizationId: "example-org",
			isActive: true,
		},
		context,
	});
	expect(mocks.credentials).not.toHaveBeenCalled();
	expect(mocks.update).toHaveBeenCalled();
});
