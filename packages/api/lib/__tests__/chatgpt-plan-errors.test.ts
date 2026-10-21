/**
 * A ChatGPT plan that does not serve the chosen model (Fizzy #2770 F10) is a
 * plan refusal like the others: the procedure layer maps it to an error that
 * names the model and points at AI Models, instead of reporting an empty
 * result.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	DEFAULT_CHATGPT_PLAN_FALLBACK_MODEL: "gpt-6-astra",
	getChatGptPlanOrgPolicy: vi.fn(),
	getModelForTask: vi.fn(),
	getChatGptPlanServedModels: vi.fn(),
	ensureChatGptPlanCatalogModels: vi.fn(),
	replaceChatGptPlanServedModels: vi.fn(),
}));

import { ChatGptPlanModelNotServedError } from "@repo/ai/lib/chatgpt-plan/models";
import {
	chatGptPlanRefusalToORPCError,
	isChatGptPlanRefusal,
	rethrowChatGptPlanRefusal,
} from "../chatgpt-plan-errors";

describe("a model the ChatGPT plan does not serve", () => {
	const error = new ChatGptPlanModelNotServedError("gpt-5.6-luna");

	it("is a plan refusal, so callers do not swallow it", () => {
		expect(isChatGptPlanRefusal(error)).toBe(true);
		expect(() => rethrowChatGptPlanRefusal(error)).toThrow(error);
	});

	it("maps to PRECONDITION_FAILED naming the model", () => {
		const mapped = chatGptPlanRefusalToORPCError(error);
		expect(mapped?.code).toBe("PRECONDITION_FAILED");
		expect(mapped?.message).toBe(
			"The ChatGPT plan does not serve gpt-5.6-luna. Choose another model in Organization settings → AI Models.",
		);
		expect(mapped?.data).toEqual({
			code: "CHATGPT_PLAN_MODEL_NOT_SERVED",
			model: "gpt-5.6-luna",
		});
	});
});

describe("exhausted plan reset messages", () => {
	it.each([
		[null, "Wait for its limit to reset, then try again."],
		[5, "It resets in about 5 min."],
		[120, "It resets in about 2 h."],
		[-1, "It resets in about 1 min."],
	] as const)(
		"preserves the reset message for %s minutes",
		async (minutes, phrase) => {
			const { SubscriptionPlanExhaustedError } = await import(
				"@repo/agent-types/chatgpt-plan-fetch"
			);
			const now = Date.parse("2030-01-01T00:00:00Z");
			const resetAt =
				minutes === null ? null : new Date(now + minutes * 60_000);
			const mapped = chatGptPlanRefusalToORPCError(
				new SubscriptionPlanExhaustedError("raw", resetAt),
				now,
			);
			expect(mapped?.code).toBe("TOO_MANY_REQUESTS");
			expect(mapped?.message).toBe(
				`Your ChatGPT plan has no usage left. ${phrase}`,
			);
		},
	);
});
