import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` factories are hoisted above module-level consts, and the static
// import below loads the module under test before they would be assigned.
const { mockLogAiUsageAsync, mockWarn } = vi.hoisted(() => ({
	mockLogAiUsageAsync: vi.fn(),
	mockWarn: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	logAiUsageAsync: (...args: unknown[]) => mockLogAiUsageAsync(...args),
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: mockWarn, info: vi.fn(), error: vi.fn() },
}));

import { createUsageLoggingMiddleware } from "../lib/usage-logging-middleware";

const CONTEXT = {
	userId: "u1",
	organizationId: "org1",
	projectId: "proj1",
	provider: "VERCEL_GATEWAY",
	providerModelId: "gpt-5.4",
	taskType: "COMPLEX",
} as Parameters<typeof createUsageLoggingMiddleware>[0];

/**
 * The middleware's declared type is the SDK's union (single or array), and the
 * factory always returns the single form. Naming the shape once keeps the
 * narrowing in one place instead of at every call.
 */
type GenerateWrapper = {
	wrapGenerate: (args: {
		doGenerate: () => Promise<Record<string, unknown>>;
	}) => Promise<Record<string, unknown>>;
};

/** Drive one generate call through the middleware and return its result. */
async function generateThrough(result: Record<string, unknown>) {
	const middleware = createUsageLoggingMiddleware(
		CONTEXT,
	) as unknown as GenerateWrapper;
	return middleware.wrapGenerate({ doGenerate: async () => result });
}

/**
 * This middleware is the single writer of the AI usage ledger, and every one of
 * its failure paths was silent: a rejected write was swallowed by a bare
 * `.catch(() => {})`, and a successful call reporting no tokens was dropped
 * without a word. Both produce the same symptom — spend that simply never
 * appears — and neither leaves anything to search for.
 */
describe("usage interceptor makes its own blind spots visible", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("reads usage a provider reported under OpenAI-compatible names", async () => {
		// A provider whose usage arrives unmapped as `prompt_tokens` /
		// `completion_tokens` normalizes to all-zero, which this middleware
		// treats as "no billing signal" and drops. Defensive: no provider in
		// the current graph is known to do this — the live all-zero report was
		// the v6 breakdown shape covered below, not an unmapped alias.
		mockLogAiUsageAsync.mockResolvedValue(undefined);

		await generateThrough({
			usage: { prompt_tokens: 120, completion_tokens: 45 },
			text: "ok",
		});

		expect(mockLogAiUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				inputTokens: 120,
				outputTokens: 45,
				totalTokens: 165,
				projectId: "proj1",
			}),
		);
		expect(mockWarn).not.toHaveBeenCalled();
	});

	it("reads the v6 breakdown shape, where the token fields are objects", async () => {
		// The exact shape @ai-sdk/openai, /anthropic and /groq v3 build (see
		// their `mapUsage`): the token fields hold a breakdown OBJECT, not a
		// number, alongside a `raw` passthrough. Reading them as numbers gives
		// NaN → 0, and an all-zero count is dropped as "no billing signal" —
		// so every generation through those providers went unrecorded.
		//
		// Observed live on staging 2026-08-12, which is where the shape came
		// from: `ai.usage.no_tokens_reported { provider: 'DATABRICKS',
		// observedUsageKeys: [ 'inputTokens', 'outputTokens', 'raw' ] }` for a
		// generation that otherwise succeeded and produced 14 test cases.
		mockLogAiUsageAsync.mockResolvedValue(undefined);

		await generateThrough({
			usage: {
				inputTokens: {
					total: 1200,
					noCache: 900,
					cacheRead: 300,
					cacheWrite: undefined,
				},
				outputTokens: { total: 450, text: 400, reasoning: 50 },
				raw: { prompt_tokens: 1200, completion_tokens: 450 },
			},
			text: "ok",
		});

		expect(mockLogAiUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				inputTokens: 1200,
				outputTokens: 450,
				totalTokens: 1650,
				cachedInputTokens: 300,
				reasoningTokens: 50,
				projectId: "proj1",
			}),
		);
		expect(mockWarn).not.toHaveBeenCalled();
	});

	it("reads cache-write tokens from the v6 input breakdown", async () => {
		// Anthropic's cache-WRITE count reaches us on the breakdown as well as
		// on provider metadata; pricing a cached call correctly needs it.
		mockLogAiUsageAsync.mockResolvedValue(undefined);

		await generateThrough({
			usage: {
				inputTokens: {
					total: 80,
					noCache: 30,
					cacheRead: 10,
					cacheWrite: 40,
				},
				outputTokens: { total: 20, text: 20, reasoning: 0 },
			},
			text: "ok",
		});

		expect(mockLogAiUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				inputTokens: 80,
				cachedInputTokens: 10,
				cacheCreationInputTokens: 40,
			}),
		);
	});

	it("still reads the flat shape, where the same fields are numbers", async () => {
		// The breakdown handling must not cost us the shape that already
		// worked — not every path through this middleware is a v6 provider.
		mockLogAiUsageAsync.mockResolvedValue(undefined);

		await generateThrough({
			usage: {
				inputTokens: 70,
				outputTokens: 30,
				totalTokens: 100,
				cachedInputTokens: 5,
				reasoningTokens: 7,
			},
			text: "ok",
		});

		expect(mockLogAiUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				inputTokens: 70,
				outputTokens: 30,
				totalTokens: 100,
				cachedInputTokens: 5,
				reasoningTokens: 7,
			}),
		);
	});

	it("names the fields it saw when tokens still come out zero", async () => {
		// Without the key list, a provider reporting usage under a name this
		// normalizer does not read is indistinguishable from one reporting none.
		mockLogAiUsageAsync.mockResolvedValue(undefined);

		await generateThrough({ usage: { totalTokenCount: 99 } });

		expect(mockWarn).toHaveBeenCalledWith(
			"ai.usage.no_tokens_reported",
			expect.objectContaining({ observedUsageKeys: ["totalTokenCount"] }),
		);
	});

	it("warns when a SUCCESSFUL call reports no tokens", async () => {
		// Nothing is written for a zero-token call, which is right — but a
		// provider that never resolves usage would empty the ledger silently.
		mockLogAiUsageAsync.mockResolvedValue(undefined);

		await generateThrough({ usage: { inputTokens: 0, outputTokens: 0 } });

		expect(mockLogAiUsageAsync).not.toHaveBeenCalled();
		expect(mockWarn).toHaveBeenCalledWith(
			"ai.usage.no_tokens_reported",
			expect.objectContaining({ projectId: "proj1" }),
		);
	});

	it("stays quiet when a FAILED call reports no tokens", async () => {
		// A throw before any tokens legitimately has nothing to report; warning
		// there would train everyone to ignore the line that matters.
		mockLogAiUsageAsync.mockResolvedValue(undefined);
		const middleware = createUsageLoggingMiddleware(
			CONTEXT,
		) as unknown as GenerateWrapper;

		await expect(
			middleware.wrapGenerate({
				doGenerate: async () => {
					throw new Error("upstream refused");
				},
			}),
		).rejects.toThrow("upstream refused");

		expect(mockWarn).not.toHaveBeenCalledWith(
			"ai.usage.no_tokens_reported",
			expect.anything(),
		);
	});

	it("warns when the ledger write rejects, and still returns the generation", async () => {
		// The call must survive a logging failure — but the spend it represents
		// has vanished from the product, so it cannot vanish from the logs too.
		mockLogAiUsageAsync.mockRejectedValue(new Error("db unreachable"));

		const result = await generateThrough({
			usage: { inputTokens: 10, outputTokens: 5 },
			text: "ok",
		});

		expect(result.text).toBe("ok");
		await vi.waitFor(() => {
			expect(mockWarn).toHaveBeenCalledWith(
				"ai.usage.record_failed",
				expect.objectContaining({
					projectId: "proj1",
					error: "db unreachable",
				}),
			);
		});
	});

	it("warns when the ledger write throws synchronously", async () => {
		mockLogAiUsageAsync.mockImplementation(() => {
			throw new Error("bad payload");
		});

		const result = await generateThrough({
			usage: { inputTokens: 10, outputTokens: 5 },
			text: "ok",
		});

		expect(result.text).toBe("ok");
		expect(mockWarn).toHaveBeenCalledWith(
			"ai.usage.record_failed",
			expect.objectContaining({ error: "bad payload" }),
		);
	});
});
