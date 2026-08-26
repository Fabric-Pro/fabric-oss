import { describe, expect, it } from "vitest";
import { classifyLimitError } from "../lib/classify-limit-error";

describe("classifyLimitError", () => {
	it("returns null for non-limit errors", () => {
		expect(classifyLimitError(new Error("database is down"))).toBeNull();
		expect(classifyLimitError(null)).toBeNull();
		expect(classifyLimitError(undefined)).toBeNull();
	});

	it("maps HTTP 402 → provider_quota", () => {
		const err = Object.assign(new Error("Payment required"), {
			statusCode: 402,
		});
		expect(classifyLimitError(err)?.kind).toBe("provider_quota");
	});

	it("maps HTTP 429 → provider_rate_limit by default", () => {
		const err = Object.assign(new Error("Too Many Requests"), {
			statusCode: 429,
		});
		expect(classifyLimitError(err)?.kind).toBe("provider_rate_limit");
	});

	it("maps OpenAI 429 with insufficient_quota code → provider_quota", () => {
		const err = Object.assign(
			new Error("You exceeded your current quota"),
			{
				statusCode: 429,
				code: "insufficient_quota",
				name: "OpenAI_APIError",
			},
		);
		const signal = classifyLimitError(err);
		expect(signal?.kind).toBe("provider_quota");
		expect(signal?.provider).toBe("openai");
	});

	it("maps HTTP 529 or Anthropic overloaded_error → provider_overloaded", () => {
		expect(
			classifyLimitError({
				statusCode: 529,
				message: "Overloaded",
			})?.kind,
		).toBe("provider_overloaded");
		expect(
			classifyLimitError({
				error: { type: "overloaded_error", message: "Overloaded" },
				name: "AnthropicError",
			})?.kind,
		).toBe("provider_overloaded");
	});

	it("maps Anthropic rate_limit_error → provider_rate_limit with provider=anthropic", () => {
		const signal = classifyLimitError({
			name: "AnthropicError",
			error: { type: "rate_limit_error", message: "rate limit exceeded" },
		});
		expect(signal?.kind).toBe("provider_rate_limit");
		expect(signal?.provider).toBe("anthropic");
	});

	it("maps context_length_exceeded code → context_length", () => {
		const err = Object.assign(
			new Error("This model's maximum context length is 8192 tokens"),
			{ code: "context_length_exceeded", statusCode: 400 },
		);
		expect(classifyLimitError(err)?.kind).toBe("context_length");
	});

	it("maps AI SDK InvalidPromptError with context-length message → context_length", () => {
		const err = Object.assign(
			new Error("prompt exceeds the model context window of 128k tokens"),
			{ name: "AI_InvalidPromptError" },
		);
		expect(classifyLimitError(err)?.kind).toBe("context_length");
	});

	it("string fallback catches 'rate limit' in plain Error messages", () => {
		expect(
			classifyLimitError(new Error("Hit the rate limit, please retry"))
				?.kind,
		).toBe("provider_rate_limit");
	});

	it("string fallback catches 'insufficient_quota' in plain Error messages", () => {
		expect(
			classifyLimitError(
				new Error("insufficient_quota: please top up your account"),
			)?.kind,
		).toBe("provider_quota");
	});

	it("parses Retry-After header (seconds) into retryAfterMs", () => {
		const err = {
			statusCode: 429,
			message: "Too Many Requests",
			headers: { "retry-after": "12" },
		};
		expect(classifyLimitError(err)?.retryAfterMs).toBe(12_000);
	});

	it("reads Retry-After off an AI SDK APICallError nested in RetryError.lastError", () => {
		// Bug #2288: `pickRetryAfterMs` used to read only the TOP-level
		// `.headers`/`.response.headers`, so a rate-limited AI SDK call — whose
		// real headers sit on `APICallError.responseHeaders` inside
		// `RetryError.lastError` — always classified with no retry hint.
		const signal = classifyLimitError({
			name: "AI_RetryError",
			message: "Failed after 3 attempts.",
			lastError: {
				name: "AI_APICallError",
				message: "Too Many Requests",
				statusCode: 429,
				responseHeaders: { "retry-after": "30" },
			},
		});
		expect(signal?.kind).toBe("provider_rate_limit");
		expect(signal?.retryAfterMs).toBe(30_000);
	});

	it("prefers the millisecond-precision retry-after-ms header", () => {
		const signal = classifyLimitError({
			statusCode: 429,
			message: "Too Many Requests",
			responseHeaders: { "retry-after-ms": "1500", "retry-after": "2" },
		});
		expect(signal?.retryAfterMs).toBe(1500);
	});

	it("finds Retry-After on an error nested in RetryError.errors[]", () => {
		const signal = classifyLimitError({
			name: "AI_RetryError",
			message: "Failed after 3 attempts.",
			errors: [
				{
					name: "AI_APICallError",
					message: "Too Many Requests",
					statusCode: 429,
					responseHeaders: { "retry-after-ms": "2500" },
				},
			],
		});
		expect(signal?.kind).toBe("provider_rate_limit");
		expect(signal?.retryAfterMs).toBe(2500);
	});

	it("parses the HTTP-date form of Retry-After off a nested responseHeaders", () => {
		// The third header form the security-scan `verdictFromScanError` fallback
		// used to handle by hand. Now subsumed here, so that fallback is gone.
		const httpDate = new Date(Date.now() + 45_000).toUTCString();
		const signal = classifyLimitError({
			name: "AI_RetryError",
			message: "Failed after 3 attempts.",
			lastError: {
				name: "AI_APICallError",
				message: "Too Many Requests",
				statusCode: 429,
				responseHeaders: { "retry-after": httpDate },
			},
		});
		expect(signal?.kind).toBe("provider_rate_limit");
		// Whole-second HTTP-date resolution — allow a little clock slop.
		expect(signal?.retryAfterMs).toBeGreaterThan(43_000);
		expect(signal?.retryAfterMs).toBeLessThanOrEqual(45_000);
	});

	it("still finds responseHeaders when an unrelated .headers bag is present", () => {
		// `.headers` is non-null but carries no Retry-After. Short-circuiting on
		// the first non-null header bag would drop the real hint.
		const signal = classifyLimitError({
			statusCode: 429,
			message: "Too Many Requests",
			headers: { "content-type": "application/json" },
			responseHeaders: { "retry-after": "20" },
		});
		expect(signal?.retryAfterMs).toBe(20_000);
	});

	it("sanitizes secrets out of the surfaced message", () => {
		const err = new Error(
			"Upstream 429 from https://api.openai.com/v1/chat Bearer sk-SECRET123",
		);
		Object.assign(err, { statusCode: 429 });
		const signal = classifyLimitError(err);
		expect(signal?.kind).toBe("provider_rate_limit");
		expect(signal?.message).not.toContain("api.openai.com");
		expect(signal?.message).not.toContain("sk-SECRET123");
	});

	it("walks .cause chain for statusCode", () => {
		const cause = Object.assign(new Error("upstream"), { statusCode: 429 });
		const wrapped = Object.assign(new Error("wrapper"), { cause });
		expect(classifyLimitError(wrapped)?.kind).toBe("provider_rate_limit");
	});

	it("sees through AI SDK RetryError (.lastError) to a wrapped 429", () => {
		// Bug #1681: the AI SDK retries transient provider errors and wraps the
		// real APICallError in RetryError.lastError/.errors[]. The limit
		// classifier must descend that wrapper, not just `.cause`/`.error`.
		const apiErr = Object.assign(new Error("Too Many Requests"), {
			statusCode: 429,
			name: "AI_APICallError",
		});
		const retry = Object.assign(new Error("Failed after 3 attempts."), {
			name: "AI_RetryError",
			reason: "maxRetriesExceeded",
			lastError: apiErr,
			errors: [apiErr],
		});
		expect(classifyLimitError(retry)?.kind).toBe("provider_rate_limit");
	});

	it("sees through RetryError (.errors[]) to a wrapped 529 → provider_overloaded", () => {
		const apiErr = Object.assign(new Error("Overloaded"), {
			statusCode: 529,
			name: "AI_APICallError",
		});
		const retry = Object.assign(new Error("Failed after 3 attempts."), {
			name: "AI_RetryError",
			reason: "maxRetriesExceeded",
			errors: [apiErr],
		});
		expect(classifyLimitError(retry)?.kind).toBe("provider_overloaded");
	});

	it("sees through RetryError to OpenAI insufficient_quota → provider_quota", () => {
		// The AI SDK wraps even NON-retryable errors in RetryError
		// (reason: "errorNotRetryable"), so a 429 + insufficient_quota must be
		// disambiguated from a plain rate-limit by descending to the leaf code.
		const apiErr = Object.assign(
			new Error("You exceeded your current quota"),
			{
				statusCode: 429,
				code: "insufficient_quota",
				name: "AI_APICallError",
			},
		);
		const retry = Object.assign(new Error("Error not retryable."), {
			name: "AI_RetryError",
			reason: "errorNotRetryable",
			lastError: apiErr,
			errors: [apiErr],
		});
		expect(classifyLimitError(retry)?.kind).toBe("provider_quota");
	});

	it("sees through RetryError to an Anthropic rate_limit_error type (no status)", () => {
		// Anthropic errors carry a `.type` rather than an HTTP status. Wrapped in
		// RetryError, `pickAnthropicType` must descend the same way as status/code.
		const apiErr = {
			name: "AI_APICallError",
			message: "rate limit",
			error: { type: "rate_limit_error", message: "rate limit exceeded" },
		};
		const retry = Object.assign(new Error("Failed after 3 attempts."), {
			name: "AI_RetryError",
			reason: "maxRetriesExceeded",
			errors: [apiErr],
		});
		expect(classifyLimitError(retry)?.kind).toBe("provider_rate_limit");
	});
});
