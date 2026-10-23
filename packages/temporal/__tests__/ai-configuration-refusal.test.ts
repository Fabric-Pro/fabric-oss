import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { ChatGptPlanModelNotServedError } from "@repo/ai/lib/chatgpt-plan/models";
import { ChatGptPlanAuthError } from "@repo/ai/lib/chatgpt-plan/oauth";
import { UnsupportedEmbeddingModelError } from "@repo/ai/lib/embedding-dimensions";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { describe, expect, it } from "vitest";
import { describeSyncErrorForUser } from "../src/activities/pm-integration/pm-sync-user-error";
import {
	aiConfigurationRefusalMessage,
	findAiConfigurationRefusal,
} from "../src/lib/ai-configuration-refusal";

const auth = new ChatGptPlanAuthError(
	"raw provider detail",
	"invalid_grant",
	true,
);
const exhausted = new SubscriptionPlanExhaustedError("raw usage detail", null);
const model = new ChatGptPlanModelNotServedError("example-model");
const limit = new AiUsageLimitExceededError({
	message: "AI usage limit reached. Raise the limit in settings.",
	limitId: "example-limit",
	dimension: "TOKENS",
	window: "DAILY",
	used: 10n,
	max: 10n,
	manageLimitsUrl: "/settings/ai-usage",
});

describe("findAiConfigurationRefusal", () => {
	it.each([
		auth,
		exhausted,
		model,
		limit,
		new UnsupportedEmbeddingModelError("databricks-gte-large-en"),
	])("preserves the %s instance", (error) => {
		expect(findAiConfigurationRefusal(error)).toBe(error);
	});
	it.each([
		{ cause: auth },
		{ error: auth },
		{ name: "AI_RetryError", lastError: auth },
		{
			name: "AI_RetryError",
			errors: [new Error("transient"), { cause: auth }],
		},
		{ cause: new Error("unrelated"), lastError: { error: auth } },
	])("searches all wrapper branches: %j", (wrapper) => {
		expect(findAiConfigurationRefusal(wrapper)).toBe(auth);
	});
	it("matches the constructor name when the error name is generic", () => {
		class Refusal extends Error {}
		Object.defineProperty(Refusal, "name", {
			value: "ChatGptPlanAuthError",
		});
		const error = new Refusal("refused");
		expect(findAiConfigurationRefusal(error)).toBe(error);
	});
	it("converts raw exhaustion bodies inside errors arrays", () => {
		const found = findAiConfigurationRefusal({
			errors: [
				{
					responseBody: JSON.stringify({
						error: {
							code: "subscription_sharing_usage_limit_exceeded",
							message: "raw provider usage detail",
						},
					}),
				},
			],
		});
		expect(found).toBeInstanceOf(SubscriptionPlanExhaustedError);
	});

	it("preserves the reset time when converting a raw exhaustion envelope", () => {
		const found = findAiConfigurationRefusal({
			error: {
				code: "subscription_sharing_usage_limit_exceeded",
				resets_at: "2030-01-01T12:00:00Z",
			},
		});
		expect(found).toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(
			(found as SubscriptionPlanExhaustedError).resetAt?.toISOString(),
		).toBe("2030-01-01T12:00:00.000Z");
	});
	it.each([
		"PlanSourceRotatedError",
		"Error",
		"AIProviderNotConfiguredError",
	])("ignores %s", (name) => {
		expect(
			findAiConfigurationRefusal(
				Object.assign(new Error("failure"), { name }),
			),
		).toBeNull();
	});
	it("bounds traversal and handles cycles", () => {
		const cycle: { cause?: unknown; lastError?: unknown } = {};
		cycle.cause = cycle;
		cycle.lastError = auth;
		expect(findAiConfigurationRefusal(cycle)).toBe(auth);
		let deep: unknown = auth;
		for (let i = 0; i < 10; i++) {
			deep = { cause: deep };
		}
		expect(findAiConfigurationRefusal(deep)).toBeNull();
	});
	it.each([
		[auth, "Your ChatGPT connection needs to be reconnected."],
		[exhausted, "Wait for its limit to reset"],
		[model, "Choose another model"],
		[limit, "Raise the limit"],
	] as const)(
		"gives downstream surfaces an actionable message for %s",
		(error, message) => {
			expect(aiConfigurationRefusalMessage(error)).toContain(message);
			expect(describeSyncErrorForUser(error)).toContain(message);
		},
	);
});

describe("safe refusal formatting", () => {
	it.each(["name", "cause", "constructor"])(
		"does not throw when %s is unreadable",
		(key) => {
			const error = Object.defineProperty({}, key, {
				get() {
					throw new Error("unreadable");
				},
			});
			expect(findAiConfigurationRefusal(error)).toBeNull();
			expect(aiConfigurationRefusalMessage(error)).toBeNull();
			expect(() => describeSyncErrorForUser(error)).not.toThrow();
		},
	);
	it("does not throw when a matched refusal's message getter throws", () => {
		const error = Object.defineProperty(
			{ name: "AiUsageLimitExceededError" },
			"message",
			{
				get() {
					throw new Error("unreadable");
				},
			},
		);
		expect(aiConfigurationRefusalMessage(error)).toBeNull();
	});
	it.each([
		[5, "It resets in about 5 min."],
		[120, "It resets in about 2 h."],
	] as const)(
		"formats a reset in %s minutes like oRPC",
		(minutes, phrase) => {
			const now = Date.parse("2030-01-01T00:00:00Z");
			const error = new SubscriptionPlanExhaustedError(
				"raw",
				new Date(now + minutes * 60_000),
			);
			expect(aiConfigurationRefusalMessage(error, now)).toBe(
				`Your ChatGPT plan has no usage left. ${phrase}`,
			);
			expect(describeSyncErrorForUser(error)).not.toContain("raw");
		},
	);
});

it("preserves a wrapped embedding configuration verdict and its actionable message", () => {
	const error = new UnsupportedEmbeddingModelError("unknown-embedding");
	const wrapper = new Error("embedding failed", { cause: error });
	expect(findAiConfigurationRefusal(wrapper)).toBe(error);
	expect(aiConfigurationRefusalMessage(wrapper)).toBe(error.message);
});
