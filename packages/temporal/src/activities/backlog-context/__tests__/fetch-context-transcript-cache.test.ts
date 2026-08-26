/**
 * Tests the per-user Redis transcript cache added to fetchMeetingTranscript:
 *  - a Redis cache hit returns immediately and never calls Microsoft Graph,
 *  - a cache miss fetches live and write-through caches the result.
 *
 * (The DB ProjectLinkedMeeting cache is mocked to miss so we isolate the new
 * Redis layer.)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const execTool = vi.fn();
const redisGet = vi.fn();
const redisSet = vi.fn();
const findLinkedMeeting = vi.fn();

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: (...a: unknown[]) => execTool(...a),
}));
// +1 `../` vs fetch-context's import — vi.mock resolves relative to this test.
vi.mock("../../../lib/redis-cache", () => ({
	RedisCache: {
		get: (...a: unknown[]) => redisGet(...a),
		set: (...a: unknown[]) => redisSet(...a),
	},
	CacheKeys: { meetingTranscript: () => "tkey" },
	CacheTTL: { meetingTranscript: 604800 },
}));
vi.mock("@repo/database", () => ({
	db: {
		projectLinkedMeeting: {
			findUnique: (...a: unknown[]) => findLinkedMeeting(...a),
		},
		projectContext: { findUnique: vi.fn() },
	},
}));
vi.mock("@repo/ai", () => ({
	generateText: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/mcp", () => ({ getCachedMcpClientForConfig: vi.fn() }));
vi.mock("@repo/rag", () => ({
	formatContextsForPrompt: vi.fn(),
	retrieveProjectContexts: vi.fn(),
}));
vi.mock("@repo/utils", () => ({ getBaseUrl: vi.fn() }));
vi.mock("../../search-project-slack-messages", () => ({
	fetchRecentSlackMessages: vi.fn(),
}));
vi.mock("../../search-project-teams-messages", () => ({
	fetchRecentTeamsMessages: vi.fn(),
}));

import { fetchMeetingTranscript } from "../fetch-context";

beforeEach(() => {
	execTool.mockReset();
	redisGet.mockReset().mockResolvedValue(null);
	redisSet.mockReset().mockResolvedValue(undefined);
	findLinkedMeeting.mockReset().mockResolvedValue(null); // DB cache miss
});

describe("fetchMeetingTranscript — Redis transcript cache", () => {
	it("returns the Redis-cached transcript and never calls Microsoft Graph", async () => {
		redisGet.mockResolvedValue({
			success: true,
			transcript: "cached text",
			meetingSubject: "Standup",
			wasSummarized: false,
		});

		const result = await fetchMeetingTranscript({
			joinUrl: "u1",
			startTime: "2026-06-11T10:00:00Z",
			userId: "user-1",
			projectId: "p1",
		});

		expect(result).toMatchObject({
			success: true,
			transcript: "cached text",
		});
		expect(execTool).not.toHaveBeenCalled();
		expect(redisSet).not.toHaveBeenCalled();
	});

	it("fetches live on a cache miss and write-through caches the result", async () => {
		execTool.mockImplementation(async (method: string) => {
			if (method === "get_meeting_by_join_url") {
				return { meeting: { id: "m1", subject: "Standup" } };
			}
			if (method === "list_meeting_transcripts") {
				return {
					transcripts: [
						{ id: "t1", createdDateTime: "2026-06-11T10:00:00Z" },
					],
				};
			}
			if (method === "get_meeting_transcript_content") {
				return { entries: [{ speaker: "Alice", text: "hello" }] };
			}
			return {};
		});

		const result = await fetchMeetingTranscript({
			joinUrl: "u1",
			startTime: "2026-06-11T10:00:00Z",
			userId: "user-1",
			projectId: "p1",
		});

		expect(result).toMatchObject({
			success: true,
			transcript: "Alice: hello",
			wasSummarized: false,
		});
		expect(redisSet).toHaveBeenCalledWith(
			"tkey",
			expect.objectContaining({
				success: true,
				transcript: "Alice: hello",
			}),
			604800,
		);
	});
});
