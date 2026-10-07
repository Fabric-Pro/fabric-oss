/**
 * The classifier has to recognise the exhaustion messages that actually
 * occurred, not the ones the SDK docs describe.
 *
 * Both payloads below are the real wording observed in production logs over
 * June–August 2026, when an exhausted balance was by a wide margin the single
 * largest cause of "the AI Assistant stopped responding". Neither matched the
 * previous `insufficient_quota` / `exceeded your quota` fallback:
 *
 *   - the gateway reports it as HTTP 402, so status alone caught that one;
 *   - the upstream provider reports it as HTTP **400**, so it classified as
 *     `null` and reached the user as a generic request failure.
 *
 * The rate-limit and overload cases are asserted too, because they must NOT
 * become `provider_quota`: those are transient and the agent is supposed to
 * keep retrying them. Widening the quota regex is exactly the change that
 * could swallow them.
 */
import { describe, expect, it } from "vitest";
import { classifyLimitError } from "../lib/classify-limit-error";

const GATEWAY_CREDIT_EXHAUSTED =
	"402 A positive credit balance is required for all requests, including BYOK, so fallback providers remain available. Add credits to continue.";

const PROVIDER_CREDIT_EXHAUSTED =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the API. Please go to Plans & Billing to upgrade or purchase credits."}}';

describe("classifyLimitError — provider credit exhaustion", () => {
	it("classifies the gateway's 402 credit message as provider_quota", () => {
		const signal = classifyLimitError(
			Object.assign(new Error(GATEWAY_CREDIT_EXHAUSTED), { status: 402 }),
		);
		expect(signal?.kind).toBe("provider_quota");
	});

	it("classifies the upstream provider's credit message even though it arrives as HTTP 400", () => {
		// The regression: status 400 is not a quota status and the wording
		// matched no existing pattern, so this returned null and the agent
		// surfaced "failed to generate" with no hint that it was billing.
		const signal = classifyLimitError(
			Object.assign(new Error(PROVIDER_CREDIT_EXHAUSTED), {
				status: 400,
			}),
		);
		expect(signal?.kind).toBe("provider_quota");
	});

	it("classifies a bare credit message with no status at all", () => {
		const signal = classifyLimitError(
			new Error("Your credit balance is too low to access the API."),
		);
		expect(signal?.kind).toBe("provider_quota");
	});

	it("keeps rate limits retryable rather than folding them into quota", () => {
		const signal = classifyLimitError(
			Object.assign(new Error("429 rate limit exceeded"), {
				status: 429,
			}),
		);
		expect(signal?.kind).toBe("provider_rate_limit");
	});

	it("keeps overload retryable rather than folding it into quota", () => {
		const signal = classifyLimitError(
			Object.assign(new Error("529 overloaded_error"), { status: 529 }),
		);
		expect(signal?.kind).toBe("provider_overloaded");
	});
});

describe("classifyLimitError — spent ChatGPT plan window (Fizzy #2939)", () => {
	it("classifies the plan's refusal before its 402 reads as a provider quota", () => {
		const signal = classifyLimitError({
			name: "AI_APICallError",
			statusCode: 402,
			message: "usage limit reached",
			responseBody: JSON.stringify({
				error: { code: "subscription_sharing_usage_limit_exceeded" },
			}),
		});
		expect(signal?.kind).toBe("subscription_exhausted");
	});

	it("carries the time until the window resets from the typed error", () => {
		const resetAt = new Date(Date.now() + 60 * 60_000);
		const signal = classifyLimitError(
			Object.assign(new Error("Your ChatGPT plan has no usage left"), {
				name: "SubscriptionPlanExhaustedError",
				code: "subscription_sharing_usage_limit_exceeded",
				resetAt,
			}),
		);
		expect(signal?.kind).toBe("subscription_exhausted");
		expect(signal?.retryAfterMs).toBeGreaterThan(59 * 60_000);
		expect(signal?.retryAfterMs).toBeLessThanOrEqual(60 * 60_000);
	});

	it("still reads an ordinary 402 as a provider quota", () => {
		expect(
			classifyLimitError({ statusCode: 402, message: "Payment required" })
				?.kind,
		).toBe("provider_quota");
	});
});

describe("classifyLimitError — ChatGPT plan needs reconnecting (Fizzy #2939)", () => {
	it("classifies the plan's sign-in refusal, also when wrapped", () => {
		const refusal = Object.assign(
			new Error(
				"Your ChatGPT connection needs to be reconnected. Reconnect it, or switch this organization to organization API billing.",
			),
			{ name: "ChatGptPlanAuthError", code: "needs_reconnect" },
		);
		expect(classifyLimitError(refusal)?.kind).toBe(
			"subscription_reconnect",
		);
		expect(
			classifyLimitError(new Error("wrapped", { cause: refusal }))?.kind,
		).toBe("subscription_reconnect");
	});

	it("classifies Fabric's own 409 answer", () => {
		expect(
			classifyLimitError({
				status: 409,
				code: "CHATGPT_PLAN_UNAVAILABLE",
				message: "reconnect",
			})?.kind,
		).toBe("subscription_reconnect");
	});
});
