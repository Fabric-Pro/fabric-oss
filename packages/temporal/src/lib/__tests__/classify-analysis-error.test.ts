/**
 * Unit tests for classifyBacklogAnalysisError (Bug #391).
 *
 * Run with:
 *   pnpm --filter @repo/temporal test src/lib/__tests__/classify-analysis-error.test.ts
 */

import { classifyLimitError } from "@repo/ai/limits";
import { type FinishReason, NoObjectGeneratedError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyBacklogAnalysisError } from "../classify-analysis-error";

/**
 * Build a real `NoObjectGeneratedError` (symbol-marked, so `isInstance` matches)
 * carrying a given `finishReason`. `response`/`usage` are required by the SDK
 * constructor; minimal valid values suffice for classification.
 */
function makeNoObjectGeneratedError(
	finishReason: FinishReason,
	message: string,
): NoObjectGeneratedError {
	return new NoObjectGeneratedError({
		message,
		text: "partial output",
		response: {
			id: "resp-1",
			timestamp: new Date(0),
			modelId: "test-model",
		},
		usage: {
			inputTokens: 1,
			outputTokens: 1,
			totalTokens: 2,
			inputTokenDetails: {
				noCacheTokens: 1,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
			outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
		},
		finishReason,
	});
}

vi.mock("@repo/ai/limits", async (importOriginal) => {
	const original = await importOriginal<typeof import("@repo/ai/limits")>();
	return {
		...original,
		classifyLimitError: vi.fn(original.classifyLimitError),
	};
});

describe("classifyBacklogAnalysisError", () => {
	afterEach(() => {
		vi.mocked(classifyLimitError).mockRestore();
	});

	it("maps context-length errors", () => {
		const r = classifyBacklogAnalysisError(
			new Error("This model's maximum context length is 128000 tokens"),
		);
		expect(r.errorClass).toBe("context_length");
		expect(r.userMessage).toMatch(/too large for the AI model/);
		expect(r.logFields.errorClass).toBe("context_length");
		expect(typeof r.logFields.rawCause).toBe("string");
	});

	it("maps provider quota (HTTP 402) errors", () => {
		const r = classifyBacklogAnalysisError({
			statusCode: 402,
			message: "Payment required",
		});
		expect(r.errorClass).toBe("provider_quota");
		expect(r.userMessage).toMatch(/quota exceeded/);
	});

	it("maps rate-limit (HTTP 429) errors", () => {
		const r = classifyBacklogAnalysisError({
			statusCode: 429,
			message: "Too many requests",
		});
		expect(r.errorClass).toBe("provider_rate_limit");
	});

	it("maps provider_overloaded (HTTP 529) errors", () => {
		const r = classifyBacklogAnalysisError({
			statusCode: 529,
			message: "Overloaded",
		});
		expect(r.errorClass).toBe("provider_overloaded");
		expect(r.userMessage).toMatch(/busy right now/);
		expect(r.logFields.limitKind).toBe("provider_overloaded");
	});

	it("maps internal_budget → provider_quota (defensive mapping)", () => {
		vi.mocked(classifyLimitError).mockReturnValueOnce({
			kind: "internal_budget",
			message: "token budget exhausted",
		});
		const r = classifyBacklogAnalysisError(new Error("budget exceeded"));
		expect(r.errorClass).toBe("provider_quota");
		expect(r.logFields.limitKind).toBe("internal_budget");
		expect(r.userMessage).toMatch(/quota exceeded/);
	});

	it("uses sanitized limit.message as rawCause on the limit path", () => {
		// Provide an error whose raw message contains a secret; the limit path
		// should surface limit.message (already sanitized) rather than rawCause
		// re-extracted from the original error.
		const r = classifyBacklogAnalysisError({
			statusCode: 429,
			message: "Rate limited. Token: Bearer sk-SECRET999",
		});
		expect(r.errorClass).toBe("provider_rate_limit");
		expect(r.logFields.rawCause).not.toContain("sk-SECRET999");
		expect(r.logFields.rawCause).not.toContain("Bearer sk-");
	});

	it("maps schema/parse (NoObjectGeneratedError) failures", () => {
		const e = new Error("response did not match schema");
		(e as Error & { name: string }).name = "NoObjectGeneratedError";
		const r = classifyBacklogAnalysisError(e);
		expect(r.errorClass).toBe("schema_parse");
		expect(r.userMessage).toMatch(/malformed result/);
	});

	it("maps a NoObjectGeneratedError with finishReason 'length' to output_limit (deterministic cut-off, not schema_parse)", () => {
		const e = makeNoObjectGeneratedError(
			"length",
			"No object generated: response cut off",
		);
		const r = classifyBacklogAnalysisError(e);
		expect(r.errorClass).toBe("output_limit");
		expect(r.userMessage).toMatch(/output limit/i);
		// Non-retryable copy: tells the user to reduce size / switch models, and
		// that retrying at the same size won't help — NOT the schema_parse
		// "retry — this is usually transient" framing.
		expect(r.userMessage).toMatch(/won't help|reduce|larger output limit/i);
		expect(r.userMessage).not.toMatch(/usually transient/i);
	});

	it("still maps a NoObjectGeneratedError whose finishReason is not 'length' to schema_parse", () => {
		const e = makeNoObjectGeneratedError(
			"stop",
			"No object generated: could not parse",
		);
		const r = classifyBacklogAnalysisError(e);
		expect(r.errorClass).toBe("schema_parse");
	});

	it("detects a finishReason 'length' cut-off wrapped in a cause chain", () => {
		const inner = makeNoObjectGeneratedError(
			"length",
			"No object generated: response cut off",
		);
		const wrapper = new Error("Activity task failed");
		(wrapper as Error & { cause?: unknown }).cause = inner;
		const r = classifyBacklogAnalysisError(wrapper);
		expect(r.errorClass).toBe("output_limit");
	});

	it("maps provider-not-configured failures", () => {
		const e = new Error("No AI provider configured for org");
		(e as Error & { name: string }).name = "AIProviderNotConfiguredError";
		const r = classifyBacklogAnalysisError(e);
		expect(r.errorClass).toBe("provider_not_configured");
		expect(r.userMessage).toMatch(/No AI provider is configured/);
	});

	it("maps provider 5xx (HTTP 503) to provider_unavailable", () => {
		const r = classifyBacklogAnalysisError({
			name: "AI_APICallError",
			statusCode: 503,
			message: "Service Unavailable",
		});
		expect(r.errorClass).toBe("provider_unavailable");
		expect(r.userMessage).toMatch(
			/temporarily unavailable|try again|retry/i,
		);
		expect(r.logFields.rawCause).toContain("Service Unavailable");
	});

	it("sees through AI SDK RetryError to classify the wrapped 503", () => {
		// AI SDK v6 retries 5xx/transient provider errors and, on exhaustion,
		// throws RetryError wrapping the real APICallError in .lastError/.errors.
		// The classifier must descend into that wrapper (Bug #1681 root cause).
		const apiErr = {
			name: "AI_APICallError",
			statusCode: 503,
			message: "Service Unavailable",
		};
		const retry = {
			name: "AI_RetryError",
			// Deliberately generic message — forces the classifier to read the
			// wrapped leaf for both class AND rawCause, not the wrapper text.
			message: "Failed after 3 attempts.",
			reason: "maxRetriesExceeded",
			lastError: apiErr,
			errors: [apiErr],
		};
		const r = classifyBacklogAnalysisError(retry);
		expect(r.errorClass).toBe("provider_unavailable");
		expect(r.logFields.rawCause).toContain("Service Unavailable");
	});

	it("sees through RetryError to classify a wrapped 529 as provider_overloaded", () => {
		const apiErr = {
			name: "AI_APICallError",
			statusCode: 529,
			message: "Overloaded",
		};
		const retry = {
			name: "AI_RetryError",
			message: "Failed after 3 attempts.",
			reason: "maxRetriesExceeded",
			lastError: apiErr,
			errors: [apiErr],
		};
		const r = classifyBacklogAnalysisError(retry);
		expect(r.errorClass).toBe("provider_overloaded");
	});

	it("falls back to transient_or_unknown for unrecognized errors", () => {
		const r = classifyBacklogAnalysisError(new Error("socket hang up"));
		expect(r.errorClass).toBe("transient_or_unknown");
		expect(r.userMessage).toMatch(/unexpected error/);
		expect(r.logFields.rawCause).toContain("socket hang up");
	});

	it("recovers the deepest informative cause for the log", () => {
		const root = new Error("ECONNRESET upstream");
		const wrapper = new Error("Activity task failed");
		(wrapper as Error & { cause?: unknown }).cause = root;
		const r = classifyBacklogAnalysisError(wrapper);
		expect(r.logFields.rawCause).toContain("ECONNRESET");
	});

	// A provider content-policy rejection is a 400, so every branch above
	// declines it and it used to land in the catch-all — whose copy tells the
	// user to retry, which cannot work: the same prompt trips the same filter.
	describe("provider content-policy rejections", () => {
		it.each([
			[
				"azure content_filter",
				"400 The response was filtered due to the prompt triggering Azure OpenAI's content_filter",
			],
			[
				"azure responsible AI policy",
				"ResponsibleAIPolicyViolation: prompt blocked",
			],
			["bedrock guardrail", "Request blocked by guardrail policy"],
			["prompt shield", "Prompt Shield detected a jailbreak attempt"],
		])("classifies %s", (_label, message) => {
			const r = classifyBacklogAnalysisError(new Error(message));
			expect(r.errorClass).toBe("provider_content_filter");
			expect(r.userMessage).toMatch(/content policy/i);
			expect(r.userMessage).toMatch(/won't help/);
		});

		it("does not shadow a genuine context-length overflow", () => {
			const r = classifyBacklogAnalysisError(
				new Error(
					"This model's maximum context length is 8192 tokens, however you requested 9000",
				),
			);
			expect(r.errorClass).toBe("context_length");
		});
	});

	describe("diagnostic tail on the unclassified bucket", () => {
		it("carries the provider's own words into the user message", () => {
			const r = classifyBacklogAnalysisError(
				new Error("upstream connect error, transport failure"),
			);
			expect(r.errorClass).toBe("transient_or_unknown");
			expect(r.userMessage).toContain("upstream connect error");
		});

		it("redacts credentials and endpoints out of the tail", () => {
			const r = classifyBacklogAnalysisError(
				new Error(
					"failed calling https://fabric.openai.azure.com/deployments with sk-abcdef123456",
				),
			);
			expect(r.userMessage).not.toContain("sk-abcdef123456");
			expect(r.userMessage).not.toContain("openai.azure.com");
			expect(r.userMessage).toContain("[key]");
		});

		it("truncates a stack-trace-shaped message rather than swamping the card", () => {
			const r = classifyBacklogAnalysisError(new Error("x".repeat(900)));
			expect(r.userMessage.length).toBeLessThan(400);
			expect(r.userMessage).toContain("…");
			// The log still keeps the longer copy for whoever can read it.
			expect(String(r.logFields.rawCause).length).toBeGreaterThan(400);
		});

		it("leaves every classified message untouched", () => {
			const r = classifyBacklogAnalysisError(
				new Error("no ai provider configured"),
			);
			expect(r.errorClass).toBe("provider_not_configured");
			expect(r.userMessage).toBe(
				"No AI provider is configured for this workspace. Set one up in AI settings.",
			);
		});
	});
});
