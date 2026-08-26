import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMicrosoftTeamsToolMock = vi.fn();

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: (...args: unknown[]) =>
		executeMicrosoftTeamsToolMock(...args),
	truncateContent: (content: string | undefined) =>
		(content ?? "").replace(/<[^>]*>/g, " ").trim(),
}));

vi.mock("@repo/database", () => ({
	// No threads will be reported as already-seen by these tests.
	getSeenMessageIds: vi.fn(async () => new Set<string>()),
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

/**
 * Build a quiet thread (idle for `quietWindowMinutes + 5` minutes) so the
 * activity's quiet-window filter doesn't reject it.
 */
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

describe("fetchNewChannelThreadsActivity — pending attachments", () => {
	beforeEach(() => {
		executeMicrosoftTeamsToolMock.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("rounds-trips hostedContent refs from the tool into thread + reply pendingAttachments", async () => {
		const rootTs = quietTimestamp();
		const replyTs = quietTimestamp();

		executeMicrosoftTeamsToolMock.mockResolvedValue({
			threads: [
				{
					id: "M1",
					createdDateTime: rootTs,
					lastModifiedDateTime: rootTs,
					webUrl: "https://teams/M1",
					from: "Alice",
					bodyContent: "<p>see screenshots</p>",
					replies: [
						{
							id: "M1-R1",
							createdDateTime: replyTs,
							lastModifiedDateTime: replyTs,
							webUrl: "https://teams/M1-R1",
							from: "Bob",
							bodyContent: "<p>another shot</p>",
							pendingAttachments: [
								{
									source: "teams",
									ref: {
										id: "reply-img",
										messageId: "M1-R1",
										contentType: "application/octet-stream",
										altText: "reply shot",
									},
								},
							],
						},
					],
					pendingAttachments: [
						{
							source: "teams",
							ref: {
								id: "root-img-1",
								messageId: "M1",
								contentType: "application/octet-stream",
								altText: "first",
							},
						},
						{
							source: "teams",
							ref: {
								id: "root-img-2",
								messageId: "M1",
								contentType: "application/octet-stream",
							},
						},
						{
							source: "teams",
							ref: {
								id: "reply-img",
								messageId: "M1-R1",
								contentType: "application/octet-stream",
								altText: "reply shot",
							},
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
		expect(thread.rootMessageId).toBe("M1");
		// Thread-level pendingAttachments — flattened from root + replies.
		expect(thread.pendingAttachments).toHaveLength(3);
		expect(thread.pendingAttachments).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: "teams",
					ref: expect.objectContaining({ id: "root-img-1" }),
				}),
				expect.objectContaining({
					source: "teams",
					ref: expect.objectContaining({ id: "root-img-2" }),
				}),
				expect.objectContaining({
					source: "teams",
					ref: expect.objectContaining({ id: "reply-img" }),
				}),
			]),
		);
		// Reply-level pendingAttachments — only the reply's image.
		expect(thread.replies).toHaveLength(1);
		expect(thread.replies[0].pendingAttachments).toHaveLength(1);
		expect(thread.replies[0].pendingAttachments?.[0]).toMatchObject({
			source: "teams",
			ref: { id: "reply-img", messageId: "M1-R1" },
		});

		// attachmentWarnings is present and empty at fetch time (Teams parser
		// is silent for malformed-tag drops and per-message dedup).
		expect(result.attachmentWarnings).toEqual([]);
	});

	it("is backward-compatible: threads without pendingAttachments yield empty arrays", async () => {
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
					bodyContent: "<p>plain text only</p>",
					replies: [
						{
							id: "M2-R1",
							createdDateTime: replyTs,
							lastModifiedDateTime: replyTs,
							webUrl: "https://teams/M2-R1",
							from: "Bob",
							bodyContent: "<p>also plain</p>",
							// No pendingAttachments key — old tool output shape.
						},
					],
					// No pendingAttachments key — old tool output shape.
				},
			],
			count: 1,
			fetchedAllPages: true,
		});

		const result = await fetchNewChannelThreadsActivity(VALID_INPUT);

		expect(result.success).toBe(true);
		expect(result.threads).toHaveLength(1);
		expect(result.threads[0].pendingAttachments).toEqual([]);
		expect(result.threads[0].replies[0].pendingAttachments).toEqual([]);
		expect(result.attachmentWarnings).toEqual([]);
	});
});
