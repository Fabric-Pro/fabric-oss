import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirstIntegration = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: {
			findFirst: (...args: unknown[]) => findFirstIntegration(...args),
			update: vi.fn(),
		},
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
	encryptApiKey: (v: string) => v,
}));

vi.mock("@repo/ai", () => ({
	extractRelevantExcerpts: vi.fn(),
}));

import { executeMicrosoftTeamsTool } from "../index";

describe("executeMicrosoftTeamsTool('list_chats')", () => {
	const fetchMock = vi.fn();
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		findFirstIntegration.mockReset();
		fetchMock.mockReset();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		findFirstIntegration.mockResolvedValue({
			id: "integration-1",
			credentials: JSON.stringify({
				access_token: "graph-test-token",
			}),
			settings: {
				oderId: "user-caller-id",
				email: "alice@example.com",
				name: "Alice Engineer",
			},
		});
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("filters caller out of 1:1 fallback topic and derives '1:1 with <Other Member>'", async () => {
		fetchMock.mockImplementation(async (url: string) => {
			if (url.includes("/me/chats")) {
				return {
					ok: true,
					status: 200,
					headers: new Headers(),
					json: async () => ({
						value: [
							{
								id: "chat-1to1",
								chatType: "oneOnOne",
								members: [
									{
										id: "membership-caller-123",
										userId: "user-caller-id",
										displayName: "Alice Engineer",
										email: "alice@example.com",
									},
									{
										id: "membership-other-456",
										userId: "user-other-id",
										displayName: "Bob Reviewer",
										email: "bob@example.com",
									},
								],
							},
							{
								id: "chat-group-named",
								chatType: "group",
								topic: "Architecture Sync",
								members: [
									{ displayName: "Alice Engineer" },
									{ displayName: "Bob Reviewer" },
								],
							},
							{
								id: "chat-group-unnamed",
								chatType: "group",
								members: [
									{ displayName: "Alice Engineer" },
									{ displayName: "Bob Reviewer" },
								],
							},
						],
					}),
				};
			}
			return { ok: false, status: 404 };
		});

		const result = (await executeMicrosoftTeamsTool(
			"list_chats",
			{},
			"user-1",
		)) as {
			chats: Array<{
				id: string;
				topic: string;
				type: string;
				members: string;
			}>;
		};

		expect(result.chats).toHaveLength(3);

		// 1:1 Direct Chat: topic excludes caller (Alice) and uses "1:1 with Bob Reviewer"
		expect(result.chats[0]).toMatchObject({
			id: "chat-1to1",
			topic: "1:1 with Bob Reviewer",
			type: "oneOnOne",
		});
		// Full members string still retains all members for display roster
		expect(result.chats[0].members).toContain("Alice Engineer");
		expect(result.chats[0].members).toContain("Bob Reviewer");

		// Named Group Chat: keeps custom topic
		expect(result.chats[1]).toMatchObject({
			id: "chat-group-named",
			topic: "Architecture Sync",
			type: "group",
		});

		// Unnamed Group Chat: falls back to "Unnamed chat"
		expect(result.chats[2]).toMatchObject({
			id: "chat-group-unnamed",
			topic: "Unnamed chat",
			type: "group",
		});
	});
});
