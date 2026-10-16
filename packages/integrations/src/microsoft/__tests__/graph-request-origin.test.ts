import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	canUseWorkflowIntegrations: vi.fn().mockResolvedValue(true),
	resolveWorkflowIntegrationForProvider: vi.fn().mockResolvedValue({
		id: "example-integration",
		credentials: JSON.stringify({ access_token: "example-access-token" }),
	}),
	workflowIntegrationAccessWhere: vi.fn(),
	db: { workflowIntegration: { update: vi.fn() } },
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => value,
	encryptApiKey: (value: string) => value,
}));
vi.mock("@repo/ai", () => ({ extractRelevantExcerpts: vi.fn() }));

import { executeMicrosoftTeamsTool } from "../index";

const fetchMock = vi.fn();
const tools = ["list_channel_threads", "list_chat_messages_for_monitor"];
const args = {
	teamId: "example-team",
	channelId: "example-channel",
	chatId: "example-chat",
};

beforeEach(() => {
	fetchMock
		.mockReset()
		.mockImplementation(async () => Response.json({ value: [] }));
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe.each(tools)("%s Graph request origin", (tool) => {
	it.each([
		"https://example.com/page",
		"http://127.0.0.1/page",
		"https://graph.microsoft.com.example.com/page",
		"https://graph.microsoft.com@example.com/page",
		"https://graph.microsoft.com:8443/page",
		"https://user:password@graph.microsoft.com/v1.0/page",
	])(
		"rejects a supplied cursor before sending credentials: %s",
		async (nextPageToken) => {
			await expect(
				executeMicrosoftTeamsTool(
					tool,
					{ ...args, nextPageToken },
					"example-user",
					"example-org",
				),
			).rejects.toThrow("Microsoft Graph");
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("rejects a provider nextLink before sending a second request", async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json({
				value: [],
				"@odata.nextLink": "https://example.com/page",
			}),
		);
		await expect(
			executeMicrosoftTeamsTool(
				tool,
				args,
				"example-user",
				"example-org",
			),
		).rejects.toThrow("Microsoft Graph");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		"graph.microsoft.com",
		"graph.microsoft.us",
		"graph.microsoft.de",
	])(
		"keeps supported Graph pagination on %s and refuses redirects",
		async (host) => {
			const nextPageToken = `https://${host}/v1.0/me/chats?$skiptoken=example`;
			await executeMicrosoftTeamsTool(
				tool,
				{ ...args, nextPageToken },
				"example-user",
				"example-org",
			);
			expect(fetchMock).toHaveBeenCalledWith(
				nextPageToken,
				expect.objectContaining({
					redirect: "error",
					headers: expect.objectContaining({
						Authorization: "Bearer example-access-token",
					}),
				}),
			);
		},
	);
});
