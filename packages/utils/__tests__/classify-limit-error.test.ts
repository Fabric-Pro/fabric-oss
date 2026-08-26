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
