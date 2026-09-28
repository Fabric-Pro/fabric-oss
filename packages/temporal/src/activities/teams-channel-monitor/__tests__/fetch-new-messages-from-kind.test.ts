/**
 * Tests that `fetchNewChannelThreadsActivity` threads `fromKind` and
 * `repliesComplete` from the `list_channel_threads` tool output through to
 * `FetchedThread` (the app-authored-thread skip).
 *
 * Mirrors the mocking setup in `fetch-new-messages.test.ts`.
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
	getSeenThreadWatermarks: vi.fn(async () => new Map<string, Date>()),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: () => {},
}));

import { fetchNewChannelThreadsActivity } from "../fetch-new-messages";

function quietTimestamp(): string {
	return new Date(Date.now() - 65 * 60 * 1000).toISOString();
}

const VALID_INPUT = {
	projectId: "p1",
	linkedChannelId: "lc1",
	teamId: "T1",
	channelId: "C1",
	userId: "u1",
	organizationId: "o1",
	sinceIso: null,
};

describe("fetchNewChannelThreadsActivity — fromKind propagation", () => {
	beforeEach(() => {
		executeMicrosoftTeamsToolMock.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("carries application/user fromKind from the tool onto the root and each reply independently", async () => {
		const rootTs = quietTimestamp();
		const replyTs = quietTimestamp();

		executeMicrosoftTeamsToolMock.mockResolvedValue({
			threads: [
				{
					id: "M1",
					createdDateTime: rootTs,
					lastModifiedDateTime: rootTs,
					webUrl: "https://teams/M1",
					from: "Alerts Bot",
					fromKind: "application",
					bodyContent: "<p>Deploy alert fired</p>",
					replies: [
						{
							id: "M1-R1",
							createdDateTime: replyTs,
							lastModifiedDateTime: replyTs,
							webUrl: "https://teams/M1-R1",
							from: "Carol Oncall",
							fromKind: "user",
							bodyContent: "<p>Investigating</p>",
						},
					],
				},
			],
			count: 1,
			fetchedAllPages: true,
		});

		const result = await fetchNewChannelThreadsActivity(VALID_INPUT);

		expect(result.success).toBe(true);
		expect(result.threads).toHaveLength(1);
		const thread = result.threads[0];
		expect(thread.rootFromKind).toBe("application");
		expect(thread.replies).toHaveLength(1);
		expect(thread.replies[0].fromKind).toBe("user");
	});

	it("is backward-compatible: a tool response without fromKind yields undefined (treated as unknown downstream)", async () => {
		const rootTs = quietTimestamp();
		const replyTs = quietTimestamp();

		executeMicrosoftTeamsToolMock.mockResolvedValue({
			threads: [
				{
					id: "M2",
					createdDateTime: rootTs,
					lastModifiedDateTime: rootTs,
					webUrl: "https://teams/M2",
					from: "Alice",
					// No fromKind key — pre-feature tool response shape.
					bodyContent: "<p>plain text only</p>",
					replies: [
						{
							id: "M2-R1",
							createdDateTime: replyTs,
							lastModifiedDateTime: replyTs,
							webUrl: "https://teams/M2-R1",
							from: "Bob",
							bodyContent: "<p>also plain</p>",
						},
					],
				},
			],
			count: 1,
			fetchedAllPages: true,
		});

		const result = await fetchNewChannelThreadsActivity(VALID_INPUT);

		expect(result.success).toBe(true);
		expect(result.threads[0].rootFromKind).toBeUndefined();
		expect(result.threads[0].replies[0].fromKind).toBeUndefined();
	});

	it("carries repliesComplete: true from the tool onto the thread", async () => {
		const rootTs = quietTimestamp();

		executeMicrosoftTeamsToolMock.mockResolvedValue({
			threads: [
				{
					id: "M3",
					createdDateTime: rootTs,
					lastModifiedDateTime: rootTs,
					webUrl: "https://teams/M3",
					from: "Alerts Bot",
					fromKind: "application",
					repliesComplete: true,
					bodyContent: "<p>Deploy alert fired</p>",
					replies: [],
				},
			],
			count: 1,
			fetchedAllPages: true,
		});

		const result = await fetchNewChannelThreadsActivity(VALID_INPUT);

		expect(result.threads[0].repliesComplete).toBe(true);
	});

	it("carries repliesComplete: false from the tool onto the thread (Graph truncated the reply page)", async () => {
		const rootTs = quietTimestamp();
		const replyTs = quietTimestamp();

		executeMicrosoftTeamsToolMock.mockResolvedValue({
			threads: [
				{
					id: "M4",
					createdDateTime: rootTs,
					lastModifiedDateTime: rootTs,
					webUrl: "https://teams/M4",
					from: "Alerts Bot",
					fromKind: "application",
					repliesComplete: false,
					bodyContent: "<p>Deploy alert fired, many replies</p>",
					replies: [
						{
							id: "M4-R1",
							createdDateTime: replyTs,
							lastModifiedDateTime: replyTs,
							webUrl: "https://teams/M4-R1",
							from: "Alerts Bot",
							fromKind: "application",
							bodyContent: "<p>still firing</p>",
						},
					],
				},
			],
			count: 1,
			fetchedAllPages: true,
		});

		const result = await fetchNewChannelThreadsActivity(VALID_INPUT);

		expect(result.threads[0].repliesComplete).toBe(false);
	});

	it("is backward-compatible: a tool response without repliesComplete yields undefined", async () => {
		const rootTs = quietTimestamp();

		executeMicrosoftTeamsToolMock.mockResolvedValue({
			threads: [
				{
					id: "M5",
					createdDateTime: rootTs,
					lastModifiedDateTime: rootTs,
					webUrl: "https://teams/M5",
					from: "Alice",
					fromKind: "user",
					// No repliesComplete key — pre-feature tool response shape.
					bodyContent: "<p>plain text only</p>",
					replies: [],
				},
			],
			count: 1,
			fetchedAllPages: true,
		});

		const result = await fetchNewChannelThreadsActivity(VALID_INPUT);

		expect(result.threads[0].repliesComplete).toBeUndefined();
	});
});
