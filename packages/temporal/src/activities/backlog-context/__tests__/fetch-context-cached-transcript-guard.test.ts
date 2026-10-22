import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../../../lib/redis-cache", async (importOriginal) => ({
	RedisCache: {
		get: (...a: unknown[]) => redisGet(...a),
		set: (...a: unknown[]) => redisSet(...a),
	},
	CacheKeys: {
		...(await importOriginal<typeof import("../../../lib/redis-cache")>())
			.CacheKeys,
		meetingTranscript: () => "tkey",
	},
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

describe("fetchMeetingTranscript — cached-body analysis ceiling", () => {
	it("summarizes a cached transcript that exceeds the threshold", async () => {
		const long = "x".repeat(320_001);
		expect(long.length).toBeGreaterThan(320_000);
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

// The former 50K guard summarized these bodies before analysis could budget them.
it.each([70_000, 320_000])(
	"keeps a %i-character cached transcript verbatim",
	async (length) => {
		const transcript = "x".repeat(length);
		wireCachedBody(transcript);
		const result = await fetchMeetingTranscript(INPUT);
		expect(result.transcript).toBe(transcript);
		expect(result.wasSummarized).toBe(false);
		expect(generateTextMock).not.toHaveBeenCalled();
	},
);

it.each(["error", "empty"])(
	"caps a cached transcript at the ceiling on a summary %s",
	async (failure) => {
		const transcript = "x".repeat(320_001);
		wireCachedBody(transcript);
		if (failure === "error") {
			generateTextMock.mockRejectedValue(
				new Error("summary unavailable"),
			);
		} else {
			generateTextMock.mockResolvedValue({ text: "  ", usage: {} });
		}
		const result = await fetchMeetingTranscript(INPUT);
		expect(result.success).toBe(true);
		expect(result.transcript.length).toBeLessThanOrEqual(320_000);
		expect(result.transcript).toMatch(/^x+\n\n\[.*truncated.*\]$/);
		expect(redisSet).not.toHaveBeenCalled();
		expect(result.wasSummarized).toBe(false);
	},
);

it.each(["x".repeat(70_000), "界".repeat(10_000)])(
	"applies the selected-meeting byte share to cached bodies (%#)",
	async (transcript) => {
		wireCachedBody(transcript);
		const result = await fetchMeetingTranscript({
			...INPUT,
			selectedMeetingCount: 60,
		});
		expect(generateTextMock).toHaveBeenCalledTimes(1);
		expect(result.wasSummarized).toBe(true);
		expect(Buffer.byteLength(result.transcript)).toBeLessThanOrEqual(
			26_214,
		);
	},
);

it.each([110_000, 320_000])(
	"keeps a stored %i-character CJK transcript whole for one selection",
	async (length) => {
		const transcript = "界".repeat(length);
		wireCachedBody(transcript);
		const result = await fetchMeetingTranscript(INPUT);
		expect(result.transcript).toBe(transcript);
		expect(result.wasSummarized).toBe(false);
		expect(generateTextMock).not.toHaveBeenCalled();
	},
);
it("reuses a successful stored-body summary across repeat selections", async () => {
	const transcript = "x".repeat(70_000);
	wireCachedBody(transcript);
	const cache = new Map<string, unknown>();
	redisGet.mockImplementation(async (key: string) => cache.get(key) ?? null);
	redisSet.mockImplementation(async (key: string, value: unknown) => {
		cache.set(key, value);
	});
	generateTextMock.mockResolvedValue({ text: "Summary", usage: {} });
	const input = { ...INPUT, selectedMeetingCount: 60 };
	const first = await fetchMeetingTranscript(input);
	const second = await fetchMeetingTranscript(input);
	expect(first.wasSummarized).toBe(true);
	expect(second.transcript).toBe(first.transcript);
	expect(generateTextMock).toHaveBeenCalledTimes(1);
	expect(redisSet).toHaveBeenCalledWith(
		expect.stringMatching(/^transcript-summary:v4:/),
		expect.any(String),
		604800,
	);
	expect(execTool).not.toHaveBeenCalled();
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

it.each(["read", "write"])(
	"tolerates a fetch summary cache %s failure",
	async (operation) => {
		wireCachedBody("x".repeat(70_000));
		if (operation === "read") {
			redisGet.mockRejectedValue(new Error("cache unavailable"));
		} else {
			redisSet.mockRejectedValue(new Error("cache unavailable"));
		}
		const result = await fetchMeetingTranscript({
			...INPUT,
			selectedMeetingCount: 60,
		});
		expect(result.success).toBe(true);
		expect(result.wasSummarized).toBe(true);
		expect(generateTextMock).toHaveBeenCalledTimes(1);
		expect(redisGet).toHaveBeenCalledWith(
			expect.stringMatching(/^transcript-summary:v4:/),
		);
	},
);

it("bounds fetch summary cache reads and writes that do not settle", async () => {
	vi.useFakeTimers();
	wireCachedBody("x".repeat(70_000));
	redisGet.mockImplementation(() => new Promise(() => {}));
	redisSet.mockImplementation(() => new Promise(() => {}));
	const fetched = fetchMeetingTranscript({
		...INPUT,
		selectedMeetingCount: 60,
	});
	await vi.advanceTimersByTimeAsync(4_000);
	expect((await fetched).wasSummarized).toBe(true);
	expect(redisGet).toHaveBeenCalledTimes(1);
	expect(redisSet).toHaveBeenCalledTimes(1);
	expect(vi.getTimerCount()).toBe(0);
});

it("does not share fetch summaries without a resolved organization", async () => {
	wireCachedBody("x".repeat(70_000));
	for (let attempt = 0; attempt < 2; attempt++) {
		await fetchMeetingTranscript({
			...INPUT,
			organizationId: undefined,
			selectedMeetingCount: 60,
		});
	}
	expect(generateTextMock).toHaveBeenCalledTimes(2);
	expect(redisGet).not.toHaveBeenCalled();
	expect(redisSet).not.toHaveBeenCalled();
});
