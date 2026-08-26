/**
 * #2170 AC3 — the feature-proposals flow reads an IMPORTED personal meeting
 * from the project instead of re-fetching it from Microsoft Graph.
 *
 * An imported meeting deliberately has no `ProjectLinkedMeeting` behind it
 * (linking would enroll a private recurring meeting in ongoing auto-sync), so
 * the existing cache lookup — which resolves through that table — always misses
 * for one. Without the second lookup asserted here, "the flow reflects the
 * imported meeting" would rest entirely on a top-5 semantic RAG hit: true on a
 * small project, quietly false on a large one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const execTool = vi.fn();
const redisGet = vi.fn();
const redisSet = vi.fn();
const findLinkedMeeting = vi.fn();
const findManyContexts = vi.fn();
const findUniqueContext = vi.fn();
const generateTextMock = vi.fn();

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
		projectContext: {
			findUnique: (...a: unknown[]) => findUniqueContext(...a),
			findMany: (...a: unknown[]) => findManyContexts(...a),
		},
	},
}));
vi.mock("@repo/ai", () => ({
	generateText: (...a: unknown[]) => generateTextMock(...a),
	getAIModelWithMetadata: vi.fn(async () => ({
		model: {},
		metadata: {},
		trackUsage: vi.fn(),
	})),
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/ai/lib/output-token-budget", () => ({
	computeScaledOutputTokenBudget: () => undefined,
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

const JOIN_URL = "https://teams.microsoft.com/l/meetup-join/AAA";
const START_TIME = "2026-08-14T09:00:00Z";

/**
 * The lookup reads metadata for every candidate occurrence but fetches only the
 * chosen transcript's body, so the fixture has to model both calls: `findMany`
 * answers with ids + metadata, `findUnique` with the content for one id.
 */
const bodies = new Map<string, string>();
let nextContextId = 0;

function importedContext(overrides: Record<string, unknown> = {}) {
	const id = `ctx-${++nextContextId}`;
	bodies.set(
		id,
		(overrides.content as string | undefined) ??
			"## Meeting Transcript: Weekly sync\n---\nAda: ship it",
	);
	return {
		id,
		metadata: {
			origin: "personal-import",
			joinUrl: JOIN_URL,
			meetingSubject: "Weekly sync",
			meetingDate: "2026-08-14T09:05:00Z",
			wasSummarized: false,
			...((overrides.metadata as Record<string, unknown>) ?? {}),
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	redisGet.mockResolvedValue(null);
	redisSet.mockResolvedValue(undefined);
	findLinkedMeeting.mockResolvedValue(null);
	findManyContexts.mockResolvedValue([]);
	bodies.clear();
	nextContextId = 0;
	findUniqueContext.mockImplementation(
		async (args: { where: { id: string } }) => {
			const content = bodies.get(args.where.id);
			return content === undefined ? null : { content };
		},
	);
});

describe("fetchMeetingTranscript — imported personal meetings", () => {
	it("returns the imported transcript without calling Microsoft Graph", async () => {
		findManyContexts.mockResolvedValue([importedContext()]);

		const result = await fetchMeetingTranscript({
			joinUrl: JOIN_URL,
			startTime: START_TIME,
			userId: "user-1",
			projectId: "p1",
		});

		expect(result).toMatchObject({
			success: true,
			transcript: "## Meeting Transcript: Weekly sync\n---\nAda: ship it",
			meetingSubject: "Weekly sync",
		});
		expect(execTool).not.toHaveBeenCalled();
	});

	it("scopes the lookup to this project's meeting transcripts for this join URL", async () => {
		findManyContexts.mockResolvedValue([importedContext()]);

		await fetchMeetingTranscript({
			joinUrl: JOIN_URL,
			startTime: START_TIME,
			userId: "user-1",
			projectId: "p1",
		});

		expect(findManyContexts.mock.calls[0][0].where).toMatchObject({
			projectId: "p1",
			type: "MEETING_TRANSCRIPT",
			metadata: { path: ["joinUrl"], equals: JOIN_URL },
		});
	});

	// A recurring series shares one join URL. Handing the analyzer last week's
	// standup because this week's has not been imported would put the wrong
	// meeting's decisions into a proposal — the same trap the linked-meeting
	// lookup guards with its 12-hour window.
	it("falls through to Graph when the only import is a different occurrence", async () => {
		findManyContexts.mockResolvedValue([
			importedContext({
				metadata: { meetingDate: "2026-08-07T09:05:00Z" },
			}),
		]);
		execTool.mockImplementation(async (method: string) => {
			if (method === "get_meeting_by_join_url") {
				return { meeting: { id: "m1", subject: "Weekly sync" } };
			}
			if (method === "list_meeting_transcripts") {
				return {
					transcripts: [{ id: "t1", createdDateTime: START_TIME }],
				};
			}
			return { entries: [{ speaker: "Ada", text: "live" }] };
		});

		const result = await fetchMeetingTranscript({
			joinUrl: JOIN_URL,
			startTime: START_TIME,
			userId: "user-1",
			projectId: "p1",
		});

		expect(result).toMatchObject({ transcript: "Ada: live" });
		expect(execTool).toHaveBeenCalled();
	});

	it("picks the occurrence nearest the selected start time", async () => {
		findManyContexts.mockResolvedValue([
			importedContext({
				content: "wrong occurrence",
				metadata: { meetingDate: "2026-08-14T17:30:00Z" },
			}),
			importedContext({
				content: "right occurrence",
				metadata: { meetingDate: "2026-08-14T09:05:00Z" },
			}),
		]);

		const result = await fetchMeetingTranscript({
			joinUrl: JOIN_URL,
			startTime: START_TIME,
			userId: "user-1",
			projectId: "p1",
		});

		expect(result).toMatchObject({ transcript: "right occurrence" });
	});

	// The team pipeline is the authority for a meeting it owns; the import path
	// is a fallback for meetings it does not.
	it("prefers a linked team transcript when the project has both", async () => {
		findLinkedMeeting.mockResolvedValue({
			transcripts: [
				{
					contextId: "ctx-team",
					meetingDate: new Date("2026-08-14T09:05:00Z"),
					meetingSubject: "Weekly sync (team)",
					wasSummarized: false,
				},
			],
		});
		findUniqueContext.mockResolvedValue({ content: "team copy" });
		findManyContexts.mockResolvedValue([importedContext()]);

		const result = await fetchMeetingTranscript({
			joinUrl: JOIN_URL,
			startTime: START_TIME,
			userId: "user-1",
			projectId: "p1",
		});

		expect(result).toMatchObject({ transcript: "team copy" });
		expect(findManyContexts).not.toHaveBeenCalled();
	});

	it("degrades to the live path rather than failing when the lookup throws", async () => {
		findManyContexts.mockRejectedValue(new Error("db down"));
		execTool.mockImplementation(async (method: string) => {
			if (method === "get_meeting_by_join_url") {
				return { meeting: { id: "m1", subject: "Weekly sync" } };
			}
			if (method === "list_meeting_transcripts") {
				return {
					transcripts: [{ id: "t1", createdDateTime: START_TIME }],
				};
			}
			return { entries: [{ speaker: "Ada", text: "live" }] };
		});

		const result = await fetchMeetingTranscript({
			joinUrl: JOIN_URL,
			startTime: START_TIME,
			userId: "user-1",
			projectId: "p1",
		});

		expect(result).toMatchObject({
			success: true,
			transcript: "Ada: live",
		});
	});
});

/**
 * The import stores a transcript whole — a stored fragment is data loss, and
 * the Context tab is meant to hold the real thing. That makes this the only
 * producer feeding `fetchMeetingTranscript` that could hand the analyzer a
 * million-character section: the live path summarises before returning, and the
 * linked path returns content the sync activity already summarised at ingest.
 *
 * It matters because `applyTokenBudget` allocates greedily in priority order
 * and ranks `meetingTranscripts` ahead of `notionContent` and `ragContext`, so
 * one oversized import would eat the whole budget and silently drop the rest of
 * the project's context — a worse analysis than not importing the meeting.
 */
describe("fetchMeetingTranscript — oversized imports are summarised on read", () => {
	const oversized = `Ada: ${"context ".repeat(10_000)}`; // > 50k chars

	it("summarises above the same threshold the live path uses", async () => {
		findManyContexts.mockResolvedValue([
			importedContext({ content: oversized }),
		]);
		generateTextMock.mockResolvedValue({
			text: "- decided to ship",
			usage: {},
		});

		const result = await fetchMeetingTranscript({
			joinUrl: JOIN_URL,
			startTime: START_TIME,
			userId: "user-1",
			projectId: "p1",
		});

		// summarizeTranscript prefixes its own heading, and the fallback on an
		// LLM failure is a 50k truncation — so this assertion also distinguishes
		// "summarised" from "quietly truncated", which look alike from outside.
		expect(result).toMatchObject({
			success: true,
			transcript: "## Meeting Summary: Weekly sync\n\n- decided to ship",
			wasSummarized: true,
		});
		expect(generateTextMock).toHaveBeenCalledTimes(1);
		expect(execTool).not.toHaveBeenCalled();
	});

	it("leaves an ordinary transcript untouched", async () => {
		findManyContexts.mockResolvedValue([importedContext()]);

		const result = await fetchMeetingTranscript({
			joinUrl: JOIN_URL,
			startTime: START_TIME,
			userId: "user-1",
			projectId: "p1",
		});

		expect(result).toMatchObject({ wasSummarized: false });
		expect(generateTextMock).not.toHaveBeenCalled();
	});
});
