/**
 * Tests for `checkDuplicateProcedure` — the roadmap "Add" dialog's
 * duplicate-detection warning on manual create (Fizzy #2180), NOT the
 * feature-proposal review flow. Both now share ONE decision engine
 * (`@repo/temporal/backlog-routing-core`); this procedure adds only the
 * interactive contract on top of it: tenant auth derived from the
 * access-checked project row, a title segment derived from the description's
 * own first line, an inline stale-embed cap, and — the one behaviour this
 * whole card exists to guarantee — NEVER blocking creation: every engine
 * failure, timeout, or usage-limit rejection degrades to a "create" result
 * with `error` set rather than throwing.
 *
 * Strategy mirrors `scan-duplicates.test.ts`: mock the embedding provider
 * (`@repo/rag`), the LLM SDK (`@repo/ai`) and the DB query helpers
 * (`@repo/database`), but run the REAL shared core
 * (`@repo/temporal/backlog-routing-core`, loaded via `importActual`) and the
 * REAL pure detection/routing libs, so the shortlist, the judge fast path and
 * the fail-open contract are genuinely exercised end-to-end through the
 * procedure rather than stubbed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, uses } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	uses: [] as unknown[],
}));

const {
	mockGenerateEmbeddings,
	mockGenerateObject,
	mockGetAIModelWithMetadata,
	mockResolveModelWithProvider,
	mockGetDecisionModel,
	mockEvaluate,
	mockHasProjectAccess,
	mockGetProjectTenantId,
	mockListActiveStories,
	mockListCacheMeta,
	mockListCacheRows,
	mockUpsertCache,
	mockGetBoundPrompt,
	AiUsageLimitExceededError,
} = vi.hoisted(() => {
	class AiUsageLimitExceededError extends Error {
		constructor() {
			super("AI usage limit exceeded");
			this.name = "AiUsageLimitExceededError";
		}
	}
	return {
		AiUsageLimitExceededError,
		mockGenerateEmbeddings: vi.fn(),
		mockGenerateObject: vi.fn(),
		mockGetAIModelWithMetadata: vi.fn(),
		mockResolveModelWithProvider: vi.fn(),
		mockGetDecisionModel: vi.fn(),
		mockEvaluate: vi.fn(),
		mockHasProjectAccess: vi.fn(async () => true),
		mockGetProjectTenantId: vi.fn(),
		mockListActiveStories: vi.fn(),
		mockListCacheMeta: vi.fn(),
		mockListCacheRows: vi.fn(),
		mockUpsertCache: vi.fn(),
		mockGetBoundPrompt: vi.fn(),
	};
});

vi.mock("@repo/rag", () => ({
	generateEmbeddings: (...a: unknown[]) => mockGenerateEmbeddings(...a),
}));

vi.mock("@repo/ai", () => {
	class AIProviderNotConfiguredError extends Error {
		constructor(message: string) {
			super(message);
			this.name = "AIProviderNotConfiguredError";
		}
	}
	return {
		AIProviderNotConfiguredError,
		hasProviderCredentials: (c: {
			apiKey?: string | null;
			clientId?: string | null;
			encryptedClientSecret?: string | null;
		}) =>
			Boolean(c.apiKey) || Boolean(c.clientId && c.encryptedClientSecret),
		generateObject: (...a: unknown[]) => mockGenerateObject(...a),
		getAIModelWithMetadata: (...a: unknown[]) =>
			mockGetAIModelWithMetadata(...a),
		resolveModelWithProvider: (...a: unknown[]) =>
			mockResolveModelWithProvider(...a),
		getAIDecisionModelWithMetadata: (...a: unknown[]) =>
			mockGetDecisionModel(...a),
		experimental_evaluate: (...a: unknown[]) => mockEvaluate(...a),
	};
});

vi.mock("@repo/payments/lib/ai-usage-limit-error", () => ({
	AiUsageLimitExceededError,
}));

const { mockLoggerInfo, mockLoggerWarn } = vi.hoisted(() => ({
	mockLoggerInfo: vi.fn(),
	mockLoggerWarn: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: mockLoggerInfo, warn: mockLoggerWarn, error: vi.fn() },
}));

vi.mock("@repo/database", async () => {
	const detection = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/duplicate-detection")
	>("@repo/database/prisma/queries/projects/duplicate-detection");
	const routing = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/action-item-routing")
	>("@repo/database/prisma/queries/projects/action-item-routing");
	return {
		...detection,
		...routing,
		hasProjectAccess: (...a: unknown[]) => mockHasProjectAccess(...a),
		getProjectTenantId: (...a: unknown[]) => mockGetProjectTenantId(...a),
		listActiveStoriesForDetection: (...a: unknown[]) =>
			mockListActiveStories(...a),
		listStoryDuplicateEmbeddingMetadata: (...a: unknown[]) =>
			mockListCacheMeta(...a),
		listStoryDuplicateEmbeddings: (...a: unknown[]) =>
			mockListCacheRows(...a),
		upsertStoryDuplicateEmbeddings: (...a: unknown[]) =>
			mockUpsertCache(...a),
		getBoundPromptForAgent: (...a: unknown[]) => mockGetBoundPrompt(...a),
		GATEWAY_PROVIDERS: [],
		DB_GATEWAY_PROVIDERS: [],
	};
});

vi.mock("@repo/temporal/backlog-routing-core", async () => {
	// The procedure needs only the shared core; load the REAL implementation
	// (its @repo/database / @repo/ai / @repo/rag imports resolve to the mocks
	// above) rather than stubbing routing behaviour itself.
	const core = await vi.importActual<
		typeof import("@repo/temporal/backlog-routing-core")
	>("@repo/temporal/backlog-routing-core");
	return {
		loadRoutingCorpus: core.loadRoutingCorpus,
		resolveRoutingModels: core.resolveRoutingModels,
		judgeRoutingItem: core.judgeRoutingItem,
	};
});

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: (...args: unknown[]) => {
			uses.push(...args);
			return chainable;
		},
		route: () => chainable,
		input: (schema: unknown) => {
			(chainable as { _input?: unknown })._input = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.checkDuplicate = fn;
			return { _handler: fn };
		},
	});
	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;
	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requireProjectPermission: (perm: string) => {
			uses.push({ requireProjectPermission: perm });
			return (c: unknown) => c;
		},
		enforceAiRateLimit: vi.fn(),
	};
});

import "../check-duplicate";

type CheckDuplicateResult = {
	decision: "create" | "enrich";
	confidence: number;
	matchedStoryId?: string;
	matchedIdentifier?: string;
	matchedTitle?: string;
	reasoning?: string | null;
	alternatives: Array<{
		storyId: string;
		identifier: string;
		title: string;
		similarity: number;
	}>;
	error?: string;
};

const ctx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

function runCheck(description = "Rate limit the export endpoint") {
	return handlers.checkDuplicate({
		input: { projectId: "proj-1", organizationId: null, description },
		context: ctx,
	}) as Promise<CheckDuplicateResult>;
}

async function errorFrom(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (err) {
		return err as { code?: string; message?: string };
	}
	throw new Error("expected the handler to throw");
}

const TICKET = {
	id: "story-1",
	identifier: "F-12",
	title: "Export throttling",
	description: "Exports need a queue.",
	acceptanceCriteria: null,
	createdAt: new Date("2026-01-01"),
	tasks: [],
};

/** Wire the mocks so the description embeds identical to `TICKET` (cosine
 * 1.0), clearing any floor, and the language judge returns `verdict`. */
function arrange(
	verdict: {
		decision: "create" | "enrich";
		targetIdentifier?: string | null;
		confidence: number;
		reasoning?: string;
	},
	tickets = [TICKET],
) {
	mockListActiveStories.mockResolvedValue(tickets);
	mockGenerateEmbeddings.mockImplementation(async (texts: string[]) => ({
		embeddings: texts.map(() => [1, 0, 0]),
		model: "text-embedding-3-small",
	}));
	mockGetAIModelWithMetadata.mockResolvedValue({
		model: { id: "test-model" },
		trackUsage: vi.fn(),
	});
	mockGenerateObject.mockResolvedValue({ object: verdict });
}

function arrangeDecision(answers: Record<string, unknown>) {
	mockGetDecisionModel.mockResolvedValue({
		model: { modelId: "typesafe-ai/jev" },
		metadata: { provider: "VERCEL_GATEWAY" },
		trackUsage: vi.fn(),
	});
	mockEvaluate.mockResolvedValue({ answers });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockGetProjectTenantId.mockResolvedValue({ organizationId: null });
	mockResolveModelWithProvider.mockResolvedValue({
		modelString: "openai/text-embedding-3-small",
		apiKey: "encrypted-provider-key",
	});
	mockListCacheMeta.mockResolvedValue([]);
	mockListCacheRows.mockResolvedValue([]);
	mockUpsertCache.mockResolvedValue(undefined);
	mockGetBoundPrompt.mockResolvedValue(null);
	// No decision model by default — every test below judges through the
	// language model unless it opts in via `arrangeDecision`.
	mockGetDecisionModel.mockRejectedValue(
		new Error(
			"Decision evaluation requires this organization's configured Vercel AI Gateway provider.",
		),
	);
	delete process.env.DUPLICATE_CHECK_TIMEOUT_MS;
});

describe("checkDuplicateProcedure — auth and gating", () => {
	it("requires STORY_CREATE and project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const err = await errorFrom(runCheck());
		expect(err.code).toBe("FORBIDDEN");
		expect(uses).toContainEqual({
			requireProjectPermission: "STORY_CREATE",
		});
		expect(mockListActiveStories).not.toHaveBeenCalled();
	});

	it("denies access when the project has no tenant row at all", async () => {
		mockGetProjectTenantId.mockResolvedValue(null);
		const err = await errorFrom(runCheck());
		expect(err.code).toBe("FORBIDDEN");
	});
});

describe("checkDuplicateProcedure — decision outcomes", () => {
	it("enriches from a confident language-judge verdict, with alternatives", async () => {
		arrange({
			decision: "enrich",
			targetIdentifier: "F-12",
			confidence: 0.92,
			reasoning: "Same export throttling work.",
		});

		const result = await runCheck();

		expect(result.decision).toBe("enrich");
		expect(result.confidence).toBe(0.92);
		expect(result.matchedStoryId).toBe("story-1");
		expect(result.matchedIdentifier).toBe("F-12");
		expect(result.matchedTitle).toBe("Export throttling");
		expect(result.reasoning).toBe("Same export throttling work.");
		expect(result.alternatives).toEqual([
			expect.objectContaining({ storyId: "story-1", identifier: "F-12" }),
		]);
		expect(result.error).toBeUndefined();
	});

	it("enriches from a confident typed decision-model verdict, without calling the language judge", async () => {
		arrange({ decision: "create", confidence: 1 });
		arrangeDecision({
			routing: {
				type: "choice",
				choice: "enrich",
				probabilities: { create: 0.04, enrich: 0.96 },
			},
			target: {
				type: "choice",
				choice: "F-12",
				probabilities: { "F-12": 0.98 },
			},
		});

		const result = await runCheck();

		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(result.decision).toBe("enrich");
		expect(result.confidence).toBe(0.96);
		expect(result.matchedIdentifier).toBe("F-12");
	});

	it("returns create below the confidence threshold", async () => {
		arrange({
			decision: "enrich",
			targetIdentifier: "F-12",
			confidence: 0.5,
		});

		const result = await runCheck();

		expect(result.decision).toBe("create");
		expect(result.matchedStoryId).toBeUndefined();
		expect(result.error).toBeUndefined();
	});

	it("returns create without calling any judge when the project has no active tickets", async () => {
		mockListActiveStories.mockResolvedValue([]);

		const result = await runCheck();

		expect(result.decision).toBe("create");
		expect(result.confidence).toBe(1);
		expect(result.alternatives).toEqual([]);
		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("returns create without calling the judge when nothing clears the shortlist floor", async () => {
		mockListActiveStories.mockResolvedValue([TICKET]);
		mockGenerateEmbeddings.mockImplementation(async (texts: string[]) => ({
			embeddings: texts.map((_t, i) => (i === 0 ? [1, 0] : [0, 1])),
			model: "text-embedding-3-small",
		}));
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: { id: "test-model" },
			trackUsage: vi.fn(),
		});

		const result = await runCheck();

		expect(result.decision).toBe("create");
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("degrades to create when the judge names a ticket that was not on the shortlist", async () => {
		arrange({
			decision: "enrich",
			targetIdentifier: "F-999",
			confidence: 0.99,
		});

		const result = await runCheck();

		expect(result.decision).toBe("create");
		expect(result.matchedStoryId).toBeUndefined();
	});

	it("derives the detection text's title from the description's own first line", async () => {
		arrange({ decision: "create", confidence: 1 });

		await runCheck("Export jobs stall\n\nLarge exports lock the worker.");

		const embedded = mockGenerateEmbeddings.mock.calls[0][0] as string[];
		expect(embedded[0]).toContain("Export jobs stall");
		expect(embedded[0]).toContain("Large exports lock the worker.");
	});

	it("logs per-stage timings on the decision line", async () => {
		arrange({ decision: "create", confidence: 1 });

		await runCheck();

		const call = mockLoggerInfo.mock.calls.find(
			([message]) => message === "[Duplicate Check] decision",
		);
		expect(call).toBeDefined();
		const [, detail] = call as [string, Record<string, unknown>];
		expect(detail.embeddingCheckMs).toBeGreaterThanOrEqual(0);
		expect(detail.corpusMs).toBeGreaterThanOrEqual(0);
		expect(detail.modelMs).toBeGreaterThanOrEqual(0);
		expect(detail.judgeMs).toBeGreaterThanOrEqual(0);
		expect(detail.totalMs).toBeGreaterThanOrEqual(0);
	});

	it("resolves the judge model concurrently with the corpus, not sequentially", async () => {
		let resolveCorpusStories: (() => void) | undefined;
		let resolveModel: (() => void) | undefined;
		mockListActiveStories.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCorpusStories = () => resolve([TICKET]);
				}),
		);
		mockGetAIModelWithMetadata.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveModel = () =>
						resolve({
							model: { id: "judge-model" },
							trackUsage: vi.fn(),
						});
				}),
		);

		const resultPromise = runCheck();
		// Let the embedding-credentials pre-check settle and both the corpus
		// and the model call actually fire, without letting either resolve.
		for (let i = 0; i < 10; i++) {
			await Promise.resolve();
		}

		// Both calls fired while the OTHER was still pending — sequential
		// code could never reach the model call while blocked awaiting the
		// still-unresolved corpus.
		expect(mockListActiveStories).toHaveBeenCalled();
		expect(mockGetAIModelWithMetadata).toHaveBeenCalled();

		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [[1, 0, 0]],
			model: "text-embedding-3-small",
		});
		mockGenerateObject.mockResolvedValue({
			object: { decision: "create", confidence: 1 },
		});
		resolveModel?.();
		resolveCorpusStories?.();

		const result = await resultPromise;
		expect(result.decision).toBe("create");
	});

	it("returns a clean create for an empty backlog even when model resolution fails", async () => {
		mockListActiveStories.mockResolvedValue([]);
		mockGetAIModelWithMetadata.mockRejectedValue(
			new Error("no COMPLEX model configured"),
		);

		const result = await runCheck();

		expect(result.decision).toBe("create");
		expect(result.confidence).toBe(1);
		expect(result.alternatives).toEqual([]);
		expect(result.error).toBeUndefined();
		expect(
			mockLoggerInfo.mock.calls.some(
				([message]) => message === "[Duplicate Check] decision",
			),
		).toBe(true);
	});
});

describe("checkDuplicateProcedure — never blocks creation", () => {
	it("returns an error result, never throwing, when no embedding provider is configured", async () => {
		mockResolveModelWithProvider.mockResolvedValue({
			modelString: "",
			apiKey: null,
			_error: "No embedding provider configured.",
		});

		const result = await runCheck();

		expect(result.decision).toBe("create");
		expect(result.confidence).toBe(0);
		expect(result.error).toBeTruthy();
		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
	});

	it("returns an error result, never throwing, when embeddings fail", async () => {
		mockListActiveStories.mockResolvedValue([TICKET]);
		mockGenerateEmbeddings.mockRejectedValue(new Error("embedding outage"));

		const result = await runCheck();

		expect(result.decision).toBe("create");
		expect(result.confidence).toBe(0);
		expect(result.error).toBeTruthy();
	});

	it("returns an error result, never throwing, when the candidate query fails", async () => {
		mockListActiveStories.mockRejectedValue(new Error("db down"));

		const result = await runCheck();

		expect(result.decision).toBe("create");
		expect(result.error).toBeTruthy();
	});

	it("returns an error result, never throwing, when the judge model cannot be resolved", async () => {
		mockListActiveStories.mockResolvedValue([TICKET]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 0, 0],
				[1, 0, 0],
			],
			model: "text-embedding-3-small",
		});
		mockGetAIModelWithMetadata.mockRejectedValue(
			new Error("no COMPLEX model configured"),
		);

		const result = await runCheck();

		expect(result.decision).toBe("create");
		expect(result.error).toBeTruthy();
	});

	it("returns an error result, never throwing, when the language judge itself fails", async () => {
		arrange({ decision: "create", confidence: 1 });
		mockGenerateObject.mockRejectedValue(new Error("gateway timeout"));

		const result = await runCheck();

		expect(result.decision).toBe("create");
		expect(result.confidence).toBe(0);
		expect(result.error).toBeTruthy();
		// The shortlist is still retained even on a failed judgement.
		expect(result.alternatives).toHaveLength(1);
	});

	it("returns an error result, never throwing, on a usage-limit rejection from the decision fast path", async () => {
		arrange({ decision: "create", confidence: 1 });
		mockGetDecisionModel.mockResolvedValue({
			model: { modelId: "typesafe-ai/jev" },
			metadata: { provider: "VERCEL_GATEWAY" },
			trackUsage: vi.fn(),
		});
		mockEvaluate.mockRejectedValue(new AiUsageLimitExceededError());

		const result = await runCheck();

		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(result.decision).toBe("create");
		expect(result.error).toBeTruthy();
	});

	it("returns an error result, never throwing, when the language judge aborts on the request's own timeout", async () => {
		arrange({ decision: "create", confidence: 1 });
		mockGenerateObject.mockImplementation(
			async (params: { abortSignal?: AbortSignal }) => {
				const controller = new AbortController();
				params.abortSignal?.addEventListener("abort", () => {
					controller.abort();
				});
				// Simulate the provider call being aborted mid-flight.
				params.abortSignal?.dispatchEvent(new Event("abort"));
				throw new DOMException(
					"The operation was aborted.",
					"AbortError",
				);
			},
		);

		const result = await runCheck();

		expect(result.decision).toBe("create");
		expect(result.error).toBeTruthy();
	});

	it("returns an error result within the request deadline when embeddings never resolve", async () => {
		process.env.DUPLICATE_CHECK_TIMEOUT_MS = "50";
		mockListActiveStories.mockResolvedValue([TICKET]);
		// Never settles — simulates a stalled embedding provider. Without a
		// request-wide deadline this would hang for the full default 20s.
		mockGenerateEmbeddings.mockImplementation(() => new Promise(() => {}));

		const startedAt = Date.now();
		const result = await runCheck();

		expect(Date.now() - startedAt).toBeLessThan(2_000);
		expect(result.decision).toBe("create");
		expect(result.confidence).toBe(0);
		expect(result.error).toBeTruthy();
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("returns an error result within the request deadline when the decision evaluation never resolves", async () => {
		process.env.DUPLICATE_CHECK_TIMEOUT_MS = "50";
		arrange({ decision: "create", confidence: 1 });
		mockGetDecisionModel.mockResolvedValue({
			model: { modelId: "typesafe-ai/jev" },
			metadata: { provider: "VERCEL_GATEWAY" },
			trackUsage: vi.fn(),
		});
		// Never settles — simulates a provider that does not honour the
		// abort signal it was given. The REQUEST still has to return on
		// time, which is exactly what the outer deadline race is for.
		mockEvaluate.mockImplementation(() => new Promise(() => {}));

		const startedAt = Date.now();
		const result = await runCheck();

		expect(Date.now() - startedAt).toBeLessThan(2_000);
		expect(result.decision).toBe("create");
		expect(result.error).toBeTruthy();
	});
});
