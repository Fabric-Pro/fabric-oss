import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	update: vi.fn(),
	credentials: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	Prisma: { JsonNull: null },
	db: {
		agentDeploymentTrigger: {
			findMany: mocks.findMany,
			update: mocks.update,
			updateMany: mocks.update,
		},
	},
}));
vi.mock("@repo/integrations/slack", () => ({
	getSlackCredentials: mocks.credentials,
}));
vi.mock("@repo/temporal", () => ({ getScheduleClient: vi.fn() }));
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
}));

import {
	pauseDeploymentTriggers,
	resumeDeploymentTriggers,
} from "../lifecycle";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.credentials.mockResolvedValue({ teamId: "T0EXAMPLE" });
});

describe("Slack lifecycle activation", () => {
	it("preserves Slack config while pausing", async () => {
		mocks.findMany.mockResolvedValue([
			{
				id: "trigger-example",
				type: "CHANNEL_MESSAGE",
				config: { channel: "slack", chatIdPattern: "^T0EXAMPLE/" },
			},
		]);
		await pauseDeploymentTriggers("deployment-example");
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "trigger-example",
					deploymentId: "deployment-example",
				}),
				data: {
					isActive: false,
					config: {
						channel: "slack",
						chatIdPattern: "^T0EXAMPLE/",
						_pausedByLifecycle: true,
					},
				},
			}),
		);
	});

	it("refuses to reactivate a Slack trigger with an unbound owner", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.findMany.mockResolvedValue([
			{
				id: "trigger-example",
				type: "CHANNEL_MESSAGE",
				slackTeamId: "T0EXAMPLE",
				userId: "user-example",
				organizationId: "example-org",
				config: {
					channel: "slack",
					chatIdPattern: "^T0EXAMPLE/",
					_pausedByLifecycle: true,
				},
			},
		]);
		mocks.credentials.mockResolvedValue({ teamId: "T0OTHER" });
		await resumeDeploymentTriggers("deployment-example");
		expect(mocks.update).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			"[AgentDeployments] Slack trigger binding failed during resume",
			{
				triggerId: "trigger-example",
				deploymentId: "deployment-example",
			},
		);
		warn.mockRestore();
	});

	it("reactivates a Slack trigger whose owner still has the connected team", async () => {
		mocks.findMany.mockResolvedValue([
			{
				id: "trigger-example",
				type: "CHANNEL_MESSAGE",
				slackTeamId: "T0EXAMPLE",
				slackChannelId: null,
				userId: "user-example",
				organizationId: "example-org",
				config: {
					channel: "slack",
					chatIdPattern: "^T0EXAMPLE/",
					_pausedByLifecycle: true,
				},
			},
		]);
		await resumeDeploymentTriggers("deployment-example");
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "trigger-example",
					deploymentId: "deployment-example",
				}),
				data: {
					isActive: true,
					config: { channel: "slack", chatIdPattern: "^T0EXAMPLE/" },
				},
			}),
		);
	});

	it("does not reactivate Slack when the connection read fails", async () => {
		mocks.findMany.mockResolvedValue([
			{
				id: "trigger-example",
				type: "CHANNEL_MESSAGE",
				slackTeamId: "T0EXAMPLE",
				slackChannelId: null,
				userId: "user-example",
				organizationId: "example-org",
				config: {
					channel: "slack",
					chatIdPattern: "^T0EXAMPLE/",
					_pausedByLifecycle: true,
				},
			},
		]);
		mocks.credentials.mockRejectedValue(new Error("unreadable"));
		await resumeDeploymentTriggers("deployment-example");
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("resumes a non-Slack trigger without a Slack connection lookup", async () => {
		mocks.findMany.mockResolvedValue([
			{
				id: "webhook-example",
				type: "WEBHOOK",
				slackTeamId: null,
				config: { requireAuth: true, _pausedByLifecycle: true },
			},
		]);
		await resumeDeploymentTriggers("deployment-example");
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					isActive: true,
					config: { requireAuth: true },
				},
			}),
		);
		expect(mocks.credentials).not.toHaveBeenCalled();
	});
});
