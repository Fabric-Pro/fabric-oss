/**
 * A Fabric pattern run for a chat records that chat on its usage-log row.
 *
 * Hybrid mode resolves the tenant's model through `getAIModelWithMetadata`,
 * whose usage interceptor writes the row from the resolver context, so the
 * user context's `conversationId` must reach that context. Without one the
 * context has no such key. `fetch` (the pattern lookup) is mocked at the
 * global boundary.
 */

import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	getAIModelWithMetadata: vi.fn(),
}));

vi.mock("@repo/database", () => ({ logAiUsageAsync: vi.fn() }));
vi.mock("@repo/ai", () => ({
	chatGptPlanServesCall: vi.fn().mockResolvedValue(false),
	getAIModelWithMetadata: hoisted.getAIModelWithMetadata,
	AIProviderNotConfiguredError: class extends Error {},
	AUDIO_PROVIDER_REQUIRED: { transcription: "transcription refused" },
	getRAGProviderConfig: vi.fn(),
	getSystemRAGProviderConfig: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/observability", () => ({
	withProviderBreaker: (
		_provider: string,
		_operation: string,
		fn: () => Promise<unknown>,
	) => fn(),
}));

import { executePatternHybrid } from "../hybrid-executor";

const BASE_URL = "http://fabric.example.com";

function textModel() {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: "text", text: "A summary." }],
			finishReason: { unified: "stop", raw: "stop" },
			usage: {
				inputTokens: {
					total: 1,
					noCache: 1,
					cacheRead: 0,
					cacheWrite: 0,
				},
				outputTokens: { total: 1, text: 1, reasoning: 0 },
			},
			warnings: [],
		}),
	} as never);
}

function resolverContext(): Record<string, unknown> {
	return hoisted.getAIModelWithMetadata.mock.calls[0][1] as Record<
		string,
		unknown
	>;
}

beforeEach(() => {
	hoisted.getAIModelWithMetadata.mockReset();
	hoisted.getAIModelWithMetadata.mockResolvedValue({
		model: textModel(),
		metadata: { modelString: "example-model", provider: "OPENAI_DIRECT" },
		trackUsage: vi.fn(),
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ Pattern: "Summarize the input." })),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("executePatternHybrid — usage attribution", () => {
	it("hands the chat's conversation to the model resolver", async () => {
		const result = await executePatternHybrid({
			input: "Some text",
			pattern: "summarize",
			userContext: {
				userId: "user-1",
				organizationId: "org-1",
				conversationId: "conv-1",
			},
			fabricConfig: { baseUrl: BASE_URL },
		});

		expect(result.success).toBe(true);
		expect(resolverContext()).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			conversationId: "conv-1",
		});
	});

	it("adds no conversation when the work has none", async () => {
		await executePatternHybrid({
			input: "Some text",
			pattern: "summarize",
			userContext: { userId: "user-1", organizationId: "org-1" },
			fabricConfig: { baseUrl: BASE_URL },
		});

		expect(resolverContext()).not.toHaveProperty("conversationId");
	});
});
