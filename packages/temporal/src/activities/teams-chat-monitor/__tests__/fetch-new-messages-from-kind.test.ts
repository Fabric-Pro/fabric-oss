/**
 * Tests that `fetchNewChatThreadsActivity` threads `fromKind` from the
 * `list_chat_messages_for_monitor` tool output through to
 * `FetchedChatThread.rootFromKind` and `FetchedChatMessage.fromKind` for
 * bundled replies (the app-authored-thread skip).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMicrosoftTeamsToolMock = vi.fn();

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: (...args: unknown[]) =>
		executeMicrosoftTeamsToolMock(...args),
	truncateContent: (content: string | undefined) =>
		(content ?? "").replace(/<[^>]*>/g, " ").trim(),
}));

vi.mock("@repo/database", () => ({
	getSeenChatMessageIds: vi.fn(async () => new Set<string>()),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: () => {},
}));

import { fetchNewChatThreadsActivity } from "../fetch-new-messages";

function quietTimestamp(offsetMs = 0): string {
	return new Date(Date.now() - 65 * 60 * 1000 - offsetMs).toISOString();
}

const VALID_INPUT = {
	projectId: "p1",
	linkedChatId: "lc1",
	chatId: "chat-1",
	userId: "u1",
	organizationId: "o1",
	sinceIso: null,
};

describe("fetchNewChatThreadsActivity — fromKind propagation", () => {
	beforeEach(() => {
		executeMicrosoftTeamsToolMock.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("carries application/user fromKind from the tool onto the bundle root and each reply independently", async () => {
		executeMicrosoftTeamsToolMock.mockResolvedValue({
			messages: [
				{
					id: "C1",
					createdDateTime: quietTimestamp(2000),
					from: "Alerts Bot",
					fromKind: "application",
					bodyContent: "<p>Deploy alert fired</p>",
				},
				{
					id: "C2",
					createdDateTime: quietTimestamp(1000),
					from: "Carol Oncall",
					fromKind: "user",
					bodyContent: "<p>Investigating</p>",
				},
			],
			count: 2,
			fetchedAllPages: true,
		});

		const result = await fetchNewChatThreadsActivity(VALID_INPUT);

		expect(result.success).toBe(true);
		expect(result.threads).toHaveLength(1);
		const thread = result.threads[0];
		expect(thread.rootMessageId).toBe("C1");
		expect(thread.rootFromKind).toBe("application");
		expect(thread.replies).toHaveLength(1);
		expect(thread.replies[0].messageId).toBe("C2");
		expect(thread.replies[0].fromKind).toBe("user");
	});

	it("is backward-compatible: a tool response without fromKind yields undefined (treated as unknown downstream)", async () => {
		executeMicrosoftTeamsToolMock.mockResolvedValue({
			messages: [
				{
					id: "C3",
					createdDateTime: quietTimestamp(),
					from: "Alice",
					// No fromKind key — pre-feature tool response shape.
					bodyContent: "<p>plain text only</p>",
				},
			],
			count: 1,
			fetchedAllPages: true,
		});

		const result = await fetchNewChatThreadsActivity(VALID_INPUT);

		expect(result.success).toBe(true);
		expect(result.threads[0].rootFromKind).toBeUndefined();
	});
});
