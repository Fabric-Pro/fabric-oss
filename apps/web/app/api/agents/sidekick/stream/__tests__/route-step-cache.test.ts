/**
 * `POST /api/agents/sidekick/stream` keeps its up-front history cache marker on
 * every step of a tool loop and rolls one more marker over the step's tool
 * rounds (Fizzy #3099).
 *
 * The real handler and AI SDK run a two-step turn on a Claude route over a
 * mock provider; the test reads the prompt each step sent. Mocked: the
 * session, rate limit, database, model resolution and the Sidekick's tool
 * factory.
 */

import { describe, expect, it, vi } from "vitest";

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
			metadata: {
				provider: "ANTHROPIC_DIRECT",
				modelString: "claude-sonnet-5-5",
			},
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

import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { POST } from "../route";

const USAGE = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function toolCallStep() {
	return {
		stream: simulateReadableStream({
			chunks: [
				{ type: "stream-start" as const, warnings: [] },
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

function textStep() {
	return {
		stream: simulateReadableStream({
			chunks: [
				{ type: "stream-start" as const, warnings: [] },
				{ type: "text-start" as const, id: "t1" },
				{ type: "text-delta" as const, id: "t1", delta: "Done." },
				{ type: "text-end" as const, id: "t1" },
				{
					type: "finish" as const,
					finishReason: { unified: "stop" as const, raw: undefined },
					usage: USAGE,
				},
			],
		}),
	};
}

function breakpointIndexes(
	prompt: ReadonlyArray<{
		providerOptions?: { anthropic?: { cacheControl?: unknown } };
	}>,
): number[] {
	return prompt.flatMap((message, index) =>
		message.providerOptions?.anthropic?.cacheControl ? [index] : [],
	);
}

describe("POST /api/agents/sidekick/stream — cache markers across tool rounds", () => {
	it("keeps the history marker and adds one rolling marker after step 1", async () => {
		let calls = 0;
		const model = new MockLanguageModelV4({
			doStream: async () => {
				calls += 1;
				return calls === 1 ? toolCallStep() : textStep();
			},
		});
		state.model = model;

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
							parts: [{ type: "text", text: "Add a tool" }],
						},
						{
							id: "m2",
							role: "assistant",
							parts: [{ type: "text", text: "Added it." }],
						},
						{
							id: "m3",
							role: "user",
							parts: [{ type: "text", text: "Rename the agent" }],
						},
					],
				}),
			}) as never,
		);
		expect(response.status).toBe(200);
		await response.text();

		const prompts = model.doStreamCalls.map((call) => call.prompt);
		expect(prompts).toHaveLength(2);
		// [stable system (marked), date system, user, assistant (marked), user]
		const historyIndex = 3;
		expect(prompts[0][historyIndex]?.role).toBe("assistant");
		// Step 1: the stable system block and the history marker only.
		expect(breakpointIndexes(prompts[0])).toEqual([0, historyIndex]);
		// Step 2: the same two, plus one on the tool result just added.
		expect(breakpointIndexes(prompts[1])).toEqual([
			0,
			historyIndex,
			prompts[1].length - 1,
		]);
		expect(prompts[1].at(-1)?.role).toBe("tool");
	});
});
