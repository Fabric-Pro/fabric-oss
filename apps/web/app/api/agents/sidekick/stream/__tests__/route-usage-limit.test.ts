/**
 * `POST /api/agents/sidekick/stream` sends a usage-limit refusal that ends a
 * multi-step turn as the limit payload in the UI message stream.
 *
 * The route's own wiring, which stream-error-text.test.ts cannot see: the
 * real handler streams a turn whose model (the real per-request limit check
 * over a mock provider) answers step 1 with text and a tool call and refuses
 * step 2. Without the route's `onError`, the SDK would mask the refusal as
 * "An error occurred.".
 *
 * Mocked: the session, rate limit, database, model resolution and the
 * Sidekick's tool factory.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ model: undefined as unknown }));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: async () => ({
		user: { id: "user-1" },
		session: { activeOrganizationId: "org-1", impersonatedBy: null },
	}),
}));
vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: async () => ({
		allowed: true,
		remaining: 1,
		resetInSeconds: 60,
	}),
	RATE_LIMIT_PRESETS: { ai: { limit: 20, windowMs: 60_000 } },
}));
vi.mock("@repo/database", () => ({
	db: {},
	getOrganizationMembership: vi.fn(),
	getRegisteredAgentById: vi.fn(),
}));
vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class extends Error {},
}));
// The route's AI SDK entry points, real; only model resolution is replaced.
vi.mock("@repo/ai", async () => {
	const ai = await vi.importActual<typeof import("ai")>("ai");
	return {
		convertToModelMessages: ai.convertToModelMessages,
		createUIMessageStreamResponse: ai.createUIMessageStreamResponse,
		isStepCount: ai.isStepCount,
		streamText: ai.streamText,
		toUIMessageStream: ai.toUIMessageStream,
		getAIModelWithMetadata: async () => ({
			model: state.model,
			metadata: { provider: "OPENAI", modelString: "gpt-test" },
			trackUsage: () => {},
		}),
	};
});
vi.mock("@repo/ai/lib/chatgpt-plan/agent-config", () => ({
	chatGptPlanExhaustedChatResponse: () => null,
	chatGptPlanReconnectRefusal: () => null,
}));
vi.mock("@repo/ai/sidekick", async () => {
	const { tool } = await vi.importActual<typeof import("ai")>("ai");
	const { z } = await import("zod");
	return {
		createSidekickTools: () => ({
			updateField: tool({
				inputSchema: z.object({}),
				execute: async () => ({ ok: true }),
			}),
		}),
	};
});

import { wrapModelWithUsageLimits } from "@repo/ai/lib/usage-limit-middleware";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { POST } from "../route";

const USAGE = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textThenToolCall() {
	return {
		stream: simulateReadableStream({
			chunks: [
				{ type: "stream-start" as const, warnings: [] },
				{ type: "text-start" as const, id: "t1" },
				{ type: "text-delta" as const, id: "t1", delta: "Updating. " },
				{ type: "text-end" as const, id: "t1" },
				{
					type: "tool-call" as const,
					toolCallId: "call-1",
					toolName: "updateField",
					input: "{}",
				},
				{
					type: "finish" as const,
					finishReason: {
						unified: "tool-calls" as const,
						raw: undefined,
					},
					usage: USAGE,
				},
			],
		}),
	};
}

beforeEach(() => {
	let checks = 0;
	state.model = wrapModelWithUsageLimits(
		new MockLanguageModelV4({ doStream: async () => textThenToolCall() }),
		async () => {
			checks += 1;
			if (checks > 1) {
				throw new AiUsageLimitExceededError({
					message:
						"AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
					limitId: "limit-1",
					dimension: "TOKENS" as never,
					window: "MONTHLY" as never,
					used: BigInt(100),
					max: BigInt(100),
					manageLimitsUrl: "https://example.com/limits",
				});
			}
		},
	);
});

/** The `data:` chunks of a UI message stream response, parsed. */
async function readChunks(response: Response) {
	const body = await response.text();
	return body
		.split("\n")
		.filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
		.map(
			(line) =>
				JSON.parse(line.slice(6)) as {
					type: string;
					delta?: string;
					errorText?: string;
				},
		);
}

describe("POST /api/agents/sidekick/stream — usage limit reached mid-turn", () => {
	it("streams step 1's text, then the refusal as the limit payload", async () => {
		const response = await POST(
			new Request("http://localhost/api/agents/sidekick/stream", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					agentId: "new",
					entityType: "new",
					formSnapshot: {},
					messages: [
						{
							id: "m1",
							role: "user",
							parts: [{ type: "text", text: "Rename the agent" }],
						},
					],
				}),
			}) as never,
		);

		expect(response.status).toBe(200);
		const chunks = await readChunks(response);
		expect(
			chunks
				.filter((chunk) => chunk.type === "text-delta")
				.map((chunk) => chunk.delta)
				.join(""),
		).toBe("Updating. ");
		const errors = chunks.filter((chunk) => chunk.type === "error");
		expect(errors).toHaveLength(1);
		expect(JSON.parse(errors[0]?.errorText ?? "null")).toMatchObject({
			code: "AI_USAGE_LIMIT_EXCEEDED",
			data: { limitId: "limit-1", used: "100", max: "100" },
		});
	});
});
