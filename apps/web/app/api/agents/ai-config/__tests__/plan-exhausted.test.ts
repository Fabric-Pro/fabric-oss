/**
 * The agents' ai-config routes when every ChatGPT plan that would serve the
 * work is spent (Fizzy #2770): a 429 the agent recognizes, never the
 * organization's key.
 */
import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { describe, expect, it, vi } from "vitest";

const RESET = new Date("2026-10-07T15:00:00Z");

vi.mock("@repo/agent-runtime", () => ({
	verifySignedTenantRequest: () => ({
		ok: true,
		userId: "user-1",
		organizationId: "org-1",
	}),
}));

vi.mock("@repo/ai", () => ({
	buildEffectiveBaseUrl: () => "https://gateway.example.com/v1",
	requiresBaseUrl: () => false,
	isReasoningModelName: () => false,
	getRAGProviderConfig: vi.fn(),
	getAIModelWithMetadata: async () => {
		throw new SubscriptionPlanExhaustedError(
			"Every ChatGPT plan this work may use has no usage left in this window.",
			RESET,
		);
	},
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class extends Error {},
}));

const { GET } = await import("../route");
const { GET: GET_TASK } = await import("../task/route");

describe("ai-config routes — every plan spent", () => {
	it.each([
		["/api/agents/ai-config", GET],
		["/api/agents/ai-config/task?taskType=CHAT", GET_TASK],
	])(
		"%s answers 429 CHATGPT_PLAN_EXHAUSTED with the reset",
		async (path, handler) => {
			const response = await handler(
				new Request(`http://localhost${path}`) as never,
			);
			expect(response.status).toBe(429);
			await expect(response.json()).resolves.toEqual({
				error: "Every ChatGPT plan this work may use has no usage left in this window.",
				code: "CHATGPT_PLAN_EXHAUSTED",
				resetAt: RESET.toISOString(),
			});
		},
	);
});
