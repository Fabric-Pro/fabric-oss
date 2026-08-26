import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/ai so getAIModelWithMetadata returns a fixture
const fakeModel = { id: "claude-3-5-sonnet" } as unknown as object;
const fakeMetadata = {
	modelString: "anthropic:claude-3-5-sonnet",
	provider: "anthropic",
	selectionSource: "user-preference",
};
const fakeTrackUsage = vi.fn();

vi.mock("@repo/ai", async (orig) => ({
	...(await orig<typeof import("@repo/ai")>()),
	getAIModelWithMetadata: vi.fn(async () => ({
		model: fakeModel,
		metadata: fakeMetadata,
		trackUsage: fakeTrackUsage,
	})),
	getRAGProviderConfig: vi.fn(() => undefined),
}));

// Minimal stubs required at module-load time
vi.mock("@repo/database", () => ({
	db: {},
	setAiUsageRecorder: vi.fn(),
	GATEWAY_PROVIDERS: [
		"VERCEL_GATEWAY",
		"OPENROUTER",
		"CLOUDFLARE_AI",
	] as const,
	DIRECT_PROVIDERS: ["OPENAI_DIRECT", "ANTHROPIC_DIRECT", "GROQ"] as const,
	AI_PROVIDER_METADATA: {},
	isGatewayProvider: () => false,
	isDirectProvider: () => false,
	getProviderDisplayName: (p: string) => p,
	getProviderMetadata: () => undefined,
}));

import { getAiModelWithSelection } from "../src/activities/orchestrator/utils/model-selector";

beforeEach(() => {
	fakeTrackUsage.mockClear();
});

describe("getAiModelWithSelection", () => {
	it("returns model, provider, and modelString from metadata", async () => {
		const result = await getAiModelWithSelection("user-1", "org-1", true);
		expect(result.model).toBe(fakeModel);
		expect(result.provider).toBe("anthropic");
		expect(result.modelString).toBe("anthropic:claude-3-5-sonnet");
	});

	it("calls trackUsage exactly once", async () => {
		await getAiModelWithSelection("user-1");
		expect(fakeTrackUsage).toHaveBeenCalledTimes(1);
	});

	it("works without organizationId (defaults)", async () => {
		const result = await getAiModelWithSelection("user-1");
		expect(result.provider).toBe("anthropic");
		expect(result.modelString).toBe("anthropic:claude-3-5-sonnet");
	});
});
