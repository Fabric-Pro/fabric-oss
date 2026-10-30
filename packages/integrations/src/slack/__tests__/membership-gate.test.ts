/**
 * `getSlackCredentials` uses an organization's Slack connection only while
 * the user is a member of that organization, as the Teams helpers do: a
 * user who is not a member gets no credentials, even when a connection row
 * with their id exists. `executeSlackTool`, which the internal Slack tools
 * route reaches, goes through the same helper.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { canUseWorkflowIntegrations, findFirst, fetchMock } = vi.hoisted(() => ({
	canUseWorkflowIntegrations: vi.fn(),
	findFirst: vi.fn(),
	fetchMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	canUseWorkflowIntegrations,
	db: { workflowIntegration: { findFirst } },
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => value,
}));

import { executeSlackTool, getSlackCredentials } from "../index";

const NOT_CONNECTED =
	"Slack not connected. Please connect your Slack workspace in Settings > Integrations.";

const row = {
	id: "integration-example-1",
	credentials: JSON.stringify({
		access_token: "xoxb-test",
		user_access_token: "xoxp-test",
		team_id: "T-example",
		team_name: "Example workspace",
	}),
};

beforeEach(() => {
	vi.clearAllMocks();
	canUseWorkflowIntegrations.mockResolvedValue(true);
	findFirst.mockResolvedValue(row);
	globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

describe("getSlackCredentials", () => {
	it("refuses a user who is not a member of the organization, without reading the connection", async () => {
		canUseWorkflowIntegrations.mockResolvedValue(false);

		await expect(
			getSlackCredentials("user-example-1", "org-example-1"),
		).rejects.toThrow(NOT_CONNECTED);

		expect(canUseWorkflowIntegrations).toHaveBeenCalledWith(
			"user-example-1",
			"org-example-1",
		);
		expect(findFirst).not.toHaveBeenCalled();
	});

	it("returns a member's own organization connection", async () => {
		await expect(
			getSlackCredentials("user-example-1", "org-example-1"),
		).resolves.toEqual({
			accessToken: "xoxb-test",
			userAccessToken: "xoxp-test",
			integrationId: "integration-example-1",
			teamId: "T-example",
			teamName: "Example workspace",
		});

		expect(findFirst).toHaveBeenCalledWith({
			where: expect.objectContaining({
				userId: "user-example-1",
				organizationId: "org-example-1",
				provider: "SLACK",
				isActive: true,
			}),
		});
	});

	it("reads a personal connection when no organization is named", async () => {
		await getSlackCredentials("user-example-1");

		expect(canUseWorkflowIntegrations).toHaveBeenCalledWith(
			"user-example-1",
			undefined,
		);
		expect(findFirst).toHaveBeenCalledWith({
			where: expect.objectContaining({
				userId: "user-example-1",
				organizationId: null,
			}),
		});
	});

	it("still says not connected when a member has no connection", async () => {
		findFirst.mockResolvedValue(null);

		await expect(
			getSlackCredentials("user-example-1", "org-example-1"),
		).rejects.toThrow(NOT_CONNECTED);
	});
});

describe("executeSlackTool", () => {
	it("refuses a user who is not a member of the organization before calling Slack", async () => {
		canUseWorkflowIntegrations.mockResolvedValue(false);

		await expect(
			executeSlackTool(
				"list_channels",
				{},
				"user-example-1",
				"org-example-1",
			),
		).rejects.toThrow(NOT_CONNECTED);

		expect(findFirst).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("calls Slack with a member's token", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, channels: [] }),
		});

		await executeSlackTool(
			"list_channels",
			{},
			"user-example-1",
			"org-example-1",
		);

		expect(fetchMock).toHaveBeenCalled();
		const [, init] = fetchMock.mock.calls[0] as [
			string,
			{ headers: Record<string, string> },
		];
		expect(init.headers.Authorization).toBe("Bearer xoxb-test");
	});
});
