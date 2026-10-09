/**
 * Delegated mode hands the organization's raw API key to the Fabric AI
 * server, which a ChatGPT plan does not have (Fizzy #2770 D9). Work a plan
 * serves runs in hybrid mode instead, through the plan-aware model
 * resolution; everything else keeps delegated mode as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	planServes: vi.fn(),
	supported: vi.fn(),
	delegated: vi.fn(),
	hybrid: vi.fn(),
	youtubeHybrid: vi.fn(),
	transcript: vi.fn(),
}));

vi.mock("@repo/ai", () => ({ chatGptPlanServesCall: mocks.planServes }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../delegated-executor", () => ({
	executePatternDelegated: mocks.delegated,
	executePatternDelegatedStream: vi.fn(),
	isDelegatedModeSupported: mocks.supported,
}));
vi.mock("../hybrid-executor", () => ({
	executePatternHybrid: mocks.hybrid,
	executePatternHybridStream: vi.fn(),
	analyzeYouTubeHybrid: mocks.youtubeHybrid,
}));
vi.mock("../full-executor", () => ({
	executePatternFull: vi.fn(),
	executePatternFullStream: vi.fn(),
	analyzeYouTubeFull: vi.fn(),
}));
vi.mock("../client", () => ({
	createFabricClient: () => ({ extractYouTubeTranscript: mocks.transcript }),
}));

import { analyzeYouTube, executeFabricPattern } from "../executor";

const userContext = { userId: "user-1", organizationId: "org-1" };
const options = {
	input: "text",
	pattern: "summarize",
	mode: "delegated" as const,
	userContext,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.supported.mockResolvedValue(true);
	mocks.hybrid.mockResolvedValue({ output: "hybrid", success: true });
	mocks.delegated.mockResolvedValue({ output: "delegated", success: true });
	mocks.youtubeHybrid.mockResolvedValue({
		output: "yt-hybrid",
		success: true,
	});
});

describe("executeFabricPattern in delegated mode", () => {
	it("runs plan-served work in hybrid mode, never handing out the raw key", async () => {
		mocks.planServes.mockResolvedValue(true);
		const result = await executeFabricPattern(options as never);
		expect(result.mode).toBe("hybrid");
		expect(mocks.delegated).not.toHaveBeenCalled();
		expect(mocks.planServes).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			projectId: undefined,
		});
	});

	it("keeps delegated mode for work no plan serves", async () => {
		mocks.planServes.mockResolvedValue(false);
		const result = await executeFabricPattern(options as never);
		expect(result.mode).toBe("delegated");
		expect(mocks.hybrid).not.toHaveBeenCalled();
	});
});

describe("analyzeYouTube in delegated mode", () => {
	it("analyzes plan-served work in hybrid mode", async () => {
		mocks.planServes.mockResolvedValue(true);
		const result = await analyzeYouTube({
			url: "https://www.youtube.com/watch?v=example",
			pattern: "summarize",
			mode: "delegated",
			userContext,
		} as never);
		expect(result.mode).toBe("hybrid");
		expect(mocks.transcript).not.toHaveBeenCalled();
		expect(mocks.delegated).not.toHaveBeenCalled();
	});
});
