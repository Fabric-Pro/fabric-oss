import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getSlackCredentials,
	findInstance,
	findDeployment,
	findTriggers,
	createTrigger,
	updateTrigger,
} = vi.hoisted(() => ({
	getSlackCredentials: vi.fn(),
	findInstance: vi.fn(),
	findDeployment: vi.fn(),
	findTriggers: vi.fn(),
	createTrigger: vi.fn(),
	updateTrigger: vi.fn(),
}));
vi.mock("@repo/integrations/slack", () => ({ getSlackCredentials }));
vi.mock("@repo/database", () => ({
	db: {
		agentTemplateInstance: { findUnique: findInstance },
		agentDeployment: { findUnique: findDeployment },
		agentDeploymentTrigger: {
			findMany: findTriggers,
			create: createTrigger,
			update: updateTrigger,
		},
	},
}));

import {
	buildSlackChannelConfig,
	resolveBoundSlackIds,
	syncDeploymentTriggers,
} from "../sync-triggers";

beforeEach(() => {
	getSlackCredentials.mockReset().mockResolvedValue({ teamId: "T0EXAMPLE" });
	findInstance.mockReset().mockResolvedValue({
		id: "instance-example",
		name: "Example",
		userId: "user-example",
		organizationId: "example-org",
		triggers: [
			{
				type: "slack",
				config: { teamId: "T0EXAMPLE", channelId: "C0EXAMPLE" },
			},
		],
	});
	findDeployment.mockReset().mockResolvedValue({ id: "deployment-example" });
	findTriggers.mockReset().mockResolvedValue([]);
	createTrigger.mockReset().mockResolvedValue({ id: "trigger-example" });
	updateTrigger.mockReset().mockResolvedValue({ id: "trigger-example" });
});

it("refuses to write a mismatched team into an active deployment trigger", async () => {
	findInstance.mockResolvedValue({
		id: "instance-example",
		name: "Example",
		userId: "user-example",
		organizationId: "example-org",
		triggers: [{ type: "slack", config: { teamId: "T0OTHER" } }],
	});
	await expect(
		syncDeploymentTriggers({
			instanceId: "instance-example",
			userId: "user-example",
			organizationId: "example-org",
		}),
	).rejects.toThrow(/workspace/);
	expect(createTrigger).not.toHaveBeenCalled();
});

it("writes the owner's connected team to the active trigger", async () => {
	await syncDeploymentTriggers({
		instanceId: "instance-example",
		userId: "editor-example",
		organizationId: "example-org",
	});
	expect(getSlackCredentials).toHaveBeenCalledWith(
		"user-example",
		"example-org",
		true,
	);
	expect(createTrigger).toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({
				isActive: true,
				slackTeamId: "T0EXAMPLE",
				slackChannelId: "C0EXAMPLE",
				userId: "user-example",
				config: expect.objectContaining({
					chatIdPattern: "^T0EXAMPLE/C0EXAMPLE$",
				}),
			}),
		}),
	);
});

it("corrects the owner of an existing Slack trigger during reconciliation", async () => {
	findTriggers.mockResolvedValue([
		{
			id: "trigger-example",
			type: "CHANNEL_MESSAGE",
			slackChannelId: "C0EXAMPLE",
			isActive: true,
		},
	]);
	await syncDeploymentTriggers({
		instanceId: "instance-example",
		userId: "editor-example",
		organizationId: "example-org",
	});
	expect(updateTrigger).toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({
				userId: "user-example",
				organizationId: "example-org",
				slackTeamId: "T0EXAMPLE",
			}),
		}),
	);
});

it("refuses to build a Slack regex from unvalidated identifiers", () => {
	expect(() =>
		buildSlackChannelConfig({}, "C0EXAMPLE.*", "T0EXAMPLE"),
	).toThrow(/ID/);
	expect(() =>
		buildSlackChannelConfig({}, "C0EXAMPLE", "T0EXAMPLE.*"),
	).toThrow(/ID/);
	expect(() => buildSlackChannelConfig({}, null, null)).toThrow(/ID/);
});

describe("resolveBoundSlackIds", () => {
	const owner = { userId: "user-example", organizationId: "example-org" };

	it.each(["", "   "])(
		"treats a cleared channel ID %j as workspace-wide",
		async (channelId) => {
			await expect(
				resolveBoundSlackIds({ teamId: "T0EXAMPLE", channelId }, owner),
			).resolves.toEqual({
				slackTeamId: "T0EXAMPLE",
				slackChannelId: null,
			});
		},
	);

	it.each(["", "   "])(
		"uses the connected team when the supplied team ID is %j",
		async (teamId) => {
			await expect(
				resolveBoundSlackIds({ teamId, channelId: "C0EXAMPLE" }, owner),
			).resolves.toEqual({
				slackTeamId: "T0EXAMPLE",
				slackChannelId: "C0EXAMPLE",
			});
		},
	);

	it("uses the owner's active connection and accepts a matching team", async () => {
		await expect(
			resolveBoundSlackIds(
				{ teamId: "T0EXAMPLE", channelId: "C0EXAMPLE" },
				owner,
			),
		).resolves.toEqual({
			slackTeamId: "T0EXAMPLE",
			slackChannelId: "C0EXAMPLE",
		});
		expect(getSlackCredentials).toHaveBeenCalledWith(
			"user-example",
			"example-org",
			true,
		);
	});

	it("refuses a different caller-supplied team", async () => {
		await expect(
			resolveBoundSlackIds({ teamId: "T0OTHER" }, owner),
		).rejects.toThrow(/workspace/i);
	});

	it("refuses a missing connection", async () => {
		getSlackCredentials.mockRejectedValue(new Error("not connected"));
		await expect(
			resolveBoundSlackIds({ teamId: "T0EXAMPLE" }, owner),
		).rejects.toThrow(/agent owner's Slack connection is missing/i);
	});

	it("refuses a connection without a readable team id", async () => {
		getSlackCredentials.mockResolvedValue({ teamId: undefined });
		await expect(
			resolveBoundSlackIds({ teamId: "T0EXAMPLE" }, owner),
		).rejects.toThrow(/team ID/i);
	});

	it("refuses a malformed connected team id", async () => {
		getSlackCredentials.mockResolvedValue({ teamId: "T0EXAMPLE.*" });
		await expect(resolveBoundSlackIds({}, owner)).rejects.toThrow(
			/team ID/i,
		);
	});

	it("refuses a trigger without an organization", async () => {
		await expect(
			resolveBoundSlackIds(
				{},
				{ userId: "user-example", organizationId: null },
			),
		).rejects.toThrow(/organization/i);
		expect(getSlackCredentials).not.toHaveBeenCalled();
	});

	it.each([
		{ teamId: "T0EXAMPLE.*" },
		{ teamId: "T0EXAMPLE", channelId: "C0EXAMPLE.*" },
		{ workspaceId: "T0OTHER" },
		{ slackTeamId: "T0OTHER" },
		{ teamId: "T0EXAMPLE", workspaceId: "T0OTHER" },
		{ channelId: "C0EXAMPLE", slackChannelId: "C0OTHER" },
		{ channelId: 42 },
	])("refuses malformed or conflicting identifiers: %j", async (config) => {
		await expect(resolveBoundSlackIds(config, owner)).rejects.toThrow();
	});
});
