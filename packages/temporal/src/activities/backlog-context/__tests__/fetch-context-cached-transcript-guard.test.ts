/**
 * Fizzy #2316 — the cached (linked-meeting) path must cap what it hands the
 * analyzer.
 *
 * That path used to return `ProjectContext.content` untouched, which was safe
 * only because the sync had already capped it at ingest. The sync now stores a
 * transcript whole, so this is the last thing standing between a very long
 * meeting and `applyTokenBudget` — which allocates greedily and ranks
 * `meetingTranscripts` above `notionContent` and `ragContext`, so an unbounded
 * transcript silently drops the project's other context.
 *
 * Mock shape follows `fetch-context-transcript-cache.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const execTool = vi.fn();
const redisGet = vi.fn();
const redisSet = vi.fn();
const findLinkedMeeting = vi.fn();
const findContext = vi.fn();
const generateTextMock = vi.fn();
const getModelMock = vi.fn();

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: (...a: unknown[]) => execTool(...a),
}));
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
		projectContext: { findUnique: (...a: unknown[]) => findContext(...a) },
	},
}));
vi.mock("@repo/ai", () => ({
	generateText: (...a: unknown[]) => generateTextMock(...a),
	getAIModelWithMetadata: (...a: unknown[]) => getModelMock(...a),
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/ai/lib/output-token-budget", () => ({
	computeScaledOutputTokenBudget: () => 16_384,
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

const INPUT = {
	joinUrl: "https://teams.microsoft.com/l/meetup-join/xyz",
	userId: "u-1",
	organizationId: "o-1",
	projectId: "proj-1",
};

function wireCachedBody(content: string) {
	findLinkedMeeting.mockResolvedValue({
		id: "lm-1",
		transcripts: [
			{
				contextId: "ctx-1",
				meetingSubject: "Discovery call",
				meetingDate: new Date("2026-06-16T10:00:00.000Z"),
				wasSummarized: false,
			},
		],
	});
	findContext.mockResolvedValue({ content });
}

beforeEach(() => {
	execTool.mockReset();
	redisGet.mockReset().mockResolvedValue(null);
	redisSet.mockReset().mockResolvedValue(undefined);
	findLinkedMeeting.mockReset();
	findContext.mockReset();
	generateTextMock.mockReset().mockResolvedValue({
		text: "- shipped the thing",
		usage: {},
	});
	getModelMock.mockReset().mockResolvedValue({
		model: {},
		metadata: {},
		trackUsage: () => {},
	});
});

describe("fetchMeetingTranscript — cached-body size guard (#2316)", () => {
	it("summarizes a cached transcript that exceeds the threshold", async () => {
		const long = `Alice: ${"we talked about the integration surface. ".repeat(2000)}`;
		expect(long.length).toBeGreaterThan(50_000);
		wireCachedBody(long);

		const result = await fetchMeetingTranscript(INPUT);

		expect(result.success).toBe(true);
		expect(result.wasSummarized).toBe(true);
		expect(result.transcript).toContain("shipped the thing");
		expect(result.transcript.length).toBeLessThan(long.length);
		expect(generateTextMock).toHaveBeenCalledTimes(1);
		// The guard must not send us back to Graph.
		expect(execTool).not.toHaveBeenCalled();
	});

	it("passes a normal cached transcript through untouched", async () => {
		const short = "Alice: short and to the point.\nBob: agreed.";
		wireCachedBody(short);

		const result = await fetchMeetingTranscript(INPUT);

		expect(result.success).toBe(true);
		expect(result.transcript).toBe(short);
		expect(result.wasSummarized).toBe(false);
		expect(generateTextMock).not.toHaveBeenCalled();
	});
});
