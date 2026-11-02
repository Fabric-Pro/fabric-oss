import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	updateMany: vi.fn(),
	membership: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	canUseWorkflowIntegrations: mocks.membership,
	db: {
		workflowIntegration: {
			findFirst: mocks.findFirst,
			updateMany: mocks.updateMany,
		},
	},
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => value,
	encryptApiKey: (value: string) => `encrypted:${value}`,
}));

import { resolveBoundSlackIds } from "../sync-triggers";

const owner = { userId: "user-example", organizationId: "example-org" };
const originalFetch = globalThis.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	mocks.membership.mockResolvedValue(true);
	mocks.findFirst.mockResolvedValue({
		id: "connection-example",
		userId: owner.userId,
		organizationId: owner.organizationId,
		credentials: JSON.stringify({ access_token: "xoxb-example" }),
	});
	mocks.updateMany.mockResolvedValue({ count: 1 });
	globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

it("binds a legacy connection after auth.test resolves and stores its team", async () => {
	fetchMock.mockResolvedValue({
		ok: true,
		json: async () => ({ ok: true, team_id: "T0EXAMPLE", team: "Example" }),
	});
	await expect(
		resolveBoundSlackIds(
			{ teamId: "T0EXAMPLE", channelId: "C0EXAMPLE" },
			owner,
		),
	).resolves.toEqual({
		slackTeamId: "T0EXAMPLE",
		slackChannelId: "C0EXAMPLE",
	});
	expect(fetchMock).toHaveBeenCalledWith(
		"https://slack.com/api/auth.test",
		expect.objectContaining({
			headers: { Authorization: "Bearer xoxb-example" },
		}),
	);
	expect(mocks.updateMany).toHaveBeenCalledWith({
		where: {
			id: "connection-example",
			credentials: '{"access_token":"xoxb-example"}',
		},
		data: {
			credentials:
				'encrypted:{"access_token":"xoxb-example","team_id":"T0EXAMPLE","team_name":"Example"}',
		},
	});
});

it("refuses a legacy connection when auth.test resolves a different team", async () => {
	fetchMock.mockResolvedValue({
		ok: true,
		json: async () => ({ ok: true, team_id: "T0OTHER" }),
	});
	await expect(
		resolveBoundSlackIds({ teamId: "T0EXAMPLE" }, owner),
	).rejects.toThrow(
		"agent owner's Slack connection points to a different workspace",
	);
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("refuses a legacy connection when auth.test cannot be reached", async () => {
	fetchMock.mockRejectedValue(new Error("network unavailable"));
	await expect(
		resolveBoundSlackIds({ teamId: "T0EXAMPLE" }, owner),
	).rejects.toThrow(/owner/i);
	expect(mocks.updateMany).not.toHaveBeenCalled();
});

it("refuses a legacy connection when auth.test returns no team", async () => {
	fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
	await expect(
		resolveBoundSlackIds({ teamId: "T0EXAMPLE" }, owner),
	).rejects.toThrow(/team ID/i);
	expect(mocks.updateMany).not.toHaveBeenCalled();
});

it("refuses a resolved team when its credential backfill cannot be saved", async () => {
	fetchMock.mockResolvedValue({
		ok: true,
		json: async () => ({ ok: true, team_id: "T0EXAMPLE" }),
	});
	mocks.updateMany.mockRejectedValue(new Error("write unavailable"));
	await expect(
		resolveBoundSlackIds({ teamId: "T0EXAMPLE" }, owner),
	).rejects.toThrow(/owner/i);
});

it("does not overwrite a concurrently reconnected Slack workspace", async () => {
	const originalCredentials = JSON.stringify({
		access_token: "xoxb-example",
	});
	const freshCredentials = JSON.stringify({
		access_token: "xoxb-reconnected",
		team_id: "T0OTHER",
		bot_user_id: "U0OTHER",
	});
	mocks.findFirst
		.mockResolvedValueOnce({
			id: "connection-example",
			userId: owner.userId,
			organizationId: owner.organizationId,
			credentials: originalCredentials,
		})
		.mockResolvedValueOnce({
			id: "connection-example",
			userId: owner.userId,
			organizationId: owner.organizationId,
			credentials: freshCredentials,
		});
	mocks.updateMany.mockImplementation(async ({ where }) => ({
		count: where.credentials === originalCredentials ? 0 : 1,
	}));
	fetchMock.mockResolvedValue({
		ok: true,
		json: async () => ({ ok: true, team_id: "T0EXAMPLE" }),
	});
	await expect(
		resolveBoundSlackIds({ teamId: "T0EXAMPLE" }, owner),
	).rejects.toThrow(/different workspace/i);
	expect(mocks.updateMany).toHaveBeenCalledWith(
		expect.objectContaining({
			where: {
				id: "connection-example",
				credentials: originalCredentials,
			},
		}),
	);
	expect(mocks.findFirst).toHaveBeenCalledTimes(2);
	expect(mocks.findFirst).toHaveBeenNthCalledWith(2, {
		where: {
			id: "connection-example",
			userId: owner.userId,
			organizationId: owner.organizationId,
			provider: "SLACK",
			isActive: true,
			NOT: { name: "SLACK_OAUTH_APP" },
		},
	});
});

it("uses the fresh stored team when a concurrent update already supplied it", async () => {
	mocks.findFirst
		.mockResolvedValueOnce({
			id: "connection-example",
			userId: owner.userId,
			organizationId: owner.organizationId,
			credentials: JSON.stringify({ access_token: "xoxb-example" }),
		})
		.mockResolvedValueOnce({
			id: "connection-example",
			userId: owner.userId,
			organizationId: owner.organizationId,
			credentials: JSON.stringify({
				access_token: "xoxb-reconnected",
				team_id: "T0EXAMPLE",
			}),
		});
	mocks.updateMany.mockResolvedValue({ count: 0 });
	fetchMock.mockResolvedValue({
		ok: true,
		json: async () => ({ ok: true, team_id: "T0EXAMPLE" }),
	});
	await expect(
		resolveBoundSlackIds({ teamId: "T0EXAMPLE" }, owner),
	).resolves.toEqual({
		slackTeamId: "T0EXAMPLE",
		slackChannelId: null,
	});
	expect(mocks.findFirst).toHaveBeenCalledTimes(2);
});

it("refuses when the concurrently changed row has no stored team", async () => {
	mocks.findFirst
		.mockResolvedValueOnce({
			id: "connection-example",
			userId: owner.userId,
			organizationId: owner.organizationId,
			credentials: JSON.stringify({ access_token: "xoxb-example" }),
		})
		.mockResolvedValueOnce({
			id: "connection-example",
			userId: owner.userId,
			organizationId: owner.organizationId,
			credentials: JSON.stringify({ access_token: "xoxb-reconnected" }),
		});
	mocks.updateMany.mockResolvedValue({ count: 0 });
	fetchMock.mockResolvedValue({
		ok: true,
		json: async () => ({ ok: true, team_id: "T0EXAMPLE" }),
	});
	await expect(
		resolveBoundSlackIds({ teamId: "T0EXAMPLE" }, owner),
	).rejects.toThrow(/owner/i);
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("refuses an unexpected backfill update count", async () => {
	mocks.updateMany.mockResolvedValue({ count: 2 });
	fetchMock.mockResolvedValue({
		ok: true,
		json: async () => ({ ok: true, team_id: "T0EXAMPLE" }),
	});
	await expect(
		resolveBoundSlackIds({ teamId: "T0EXAMPLE" }, owner),
	).rejects.toThrow(/owner/i);
});
