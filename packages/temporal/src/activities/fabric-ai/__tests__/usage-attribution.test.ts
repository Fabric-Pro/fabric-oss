/**
 * The Fabric AI activities hand the chat's conversation to `@repo/fabric-ai`
 * in the user context its model resolution and usage rows are built from.
 * Without a conversation the user context has no such key.
 *
 * `@repo/fabric-ai` is the boundary mocked here; its own tests show the user
 * context's conversation reaching the resolver and the transcription row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	executePattern: vi.fn(),
	analyzeYouTube: vi.fn(),
	executePatternHybrid: vi.fn(),
	transcribeAudio: vi.fn(),
	transcribeAndAnalyze: vi.fn(),
	scrapeUrl: vi.fn(),
	searchWeb: vi.fn(),
}));

vi.mock("@repo/fabric-ai", () => ({
	analyzeYouTube: h.analyzeYouTube,
	checkFabricAIHealth: vi.fn(),
	createFabricClient: () => ({
		scrapeUrl: h.scrapeUrl,
		searchWeb: h.searchWeb,
	}),
	createJinaClient: vi.fn(),
	executeFabricPattern: h.executePattern,
	executePatternHybrid: h.executePatternHybrid,
	extractYouTubeTranscript: vi.fn(),
	getFabricAIMode: () => "hybrid",
	listFabricContexts: vi.fn(),
	listFabricStrategies: vi.fn(),
	listFabricPatterns: vi.fn(),
	transcribeAndAnalyze: h.transcribeAndAnalyze,
	transcribeAudio: h.transcribeAudio,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/search", () => ({ createProvider: vi.fn() }));
// No tenant scraper or search provider: both fall back to the Fabric AI
// server client above, and the pattern then runs in hybrid mode.
vi.mock("../../lib/get-web-scraper", () => ({
	getWebScraperForTenant: vi.fn(async () => null),
}));
vi.mock("../../lib/get-search-provider", () => ({
	resolveSearchProviderForTenant: vi.fn(async () => null),
}));

import {
	analyzeYouTubeVideo,
	executeFabricPattern,
	scrapeAndAnalyzeActivity,
	searchAndAnalyzeActivity,
	transcribeAndAnalyzeActivity,
	transcribeAudioActivity,
} from "..";

const PATTERN_RESULT = {
	success: true,
	output: "out",
	mode: "hybrid",
	metadata: { pattern: "summarize", model: "m", executionMode: "hybrid" },
};

function userContextOf(mock: ReturnType<typeof vi.fn>, call = 0) {
	const args = mock.mock.calls[call];
	const options = (args.length === 3 ? args[2] : args[0]) as {
		userContext?: Record<string, unknown>;
	};
	return options.userContext;
}

const BASE = { userId: "user-1", organizationId: "org-1" };

beforeEach(() => {
	vi.clearAllMocks();
	h.executePattern.mockResolvedValue(PATTERN_RESULT);
	h.analyzeYouTube.mockResolvedValue(PATTERN_RESULT);
	h.executePatternHybrid.mockResolvedValue(PATTERN_RESULT);
	h.transcribeAudio.mockResolvedValue({
		success: true,
		transcript: "t",
		metadata: { model: "whisper-1", executionMode: "hybrid" },
	});
	h.transcribeAndAnalyze.mockResolvedValue({ success: true });
	h.scrapeUrl.mockResolvedValue("page");
	h.searchWeb.mockResolvedValue("results");
});

const CASES: Array<{
	name: string;
	run: (extra: { conversationId?: string }) => Promise<unknown>;
	mock: ReturnType<typeof vi.fn>;
}> = [
	{
		name: "executeFabricPattern",
		run: (extra) =>
			executeFabricPattern({
				pattern: "summarize",
				input: "text",
				...BASE,
				...extra,
			}),
		mock: h.executePattern,
	},
	{
		name: "analyzeYouTubeVideo",
		run: (extra) =>
			analyzeYouTubeVideo({
				url: "https://www.youtube.com/watch?v=example",
				...BASE,
				...extra,
			}),
		mock: h.analyzeYouTube,
	},
	{
		name: "scrapeAndAnalyzeActivity",
		run: (extra) =>
			scrapeAndAnalyzeActivity({
				url: "https://example.com",
				pattern: "summarize",
				...BASE,
				...extra,
			}),
		mock: h.executePatternHybrid,
	},
	{
		name: "searchAndAnalyzeActivity",
		run: (extra) =>
			searchAndAnalyzeActivity({
				question: "What shipped?",
				pattern: "summarize",
				...BASE,
				...extra,
			}),
		mock: h.executePatternHybrid,
	},
	{
		name: "transcribeAudioActivity",
		run: (extra) =>
			transcribeAudioActivity({
				fileContentBase64: "AAAA",
				fileName: "meeting.mp3",
				...BASE,
				...extra,
			}),
		mock: h.transcribeAudio,
	},
	{
		name: "transcribeAndAnalyzeActivity",
		run: (extra) =>
			transcribeAndAnalyzeActivity({
				fileContentBase64: "AAAA",
				fileName: "meeting.mp3",
				pattern: "summarize",
				...BASE,
				...extra,
			}),
		mock: h.transcribeAndAnalyze,
	},
];

describe("Fabric AI activities — usage attribution", () => {
	for (const { name, run, mock } of CASES) {
		it(`${name} passes the chat's conversation in the user context`, async () => {
			await run({ conversationId: "conv-1" });
			expect(userContextOf(mock)).toMatchObject({
				userId: "user-1",
				organizationId: "org-1",
				conversationId: "conv-1",
			});
		});

		it(`${name} adds no conversation without one`, async () => {
			await run({});
			expect(userContextOf(mock)).not.toHaveProperty("conversationId");
		});
	}
});
