import { UnsupportedEmbeddingModelError } from "@repo/ai/lib/embedding-dimensions";
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
	mockDecide,
	mockHasProjectAccess,
	mockGetProjectTenantId,
	mockListActiveStories,
	mockListCacheMeta,
	mockListCacheRows,
	mockUpsertCache,
	mockGetBoundPrompt,
	mockListInboxItems,
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
		mockDecide: vi.fn(),
		mockHasProjectAccess: vi.fn(async () => true),
		mockGetProjectTenantId: vi.fn(),
		mockListActiveStories: vi.fn(),
		mockListCacheMeta: vi.fn(),
		mockListCacheRows: vi.fn(),
		mockUpsertCache: vi.fn(),
		mockGetBoundPrompt: vi.fn(),
		mockListInboxItems: vi.fn(),
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
		generateText: (...a: unknown[]) => mockGenerateObject(...a),
		Output: { object: (spec: unknown) => spec },
		getAIModelWithMetadata: (...a: unknown[]) =>
			mockGetAIModelWithMetadata(...a),
		resolveModelWithProvider: (...a: unknown[]) =>
			mockResolveModelWithProvider(...a),
		getAIDecisionModelWithMetadata: (...a: unknown[]) =>
			mockGetDecisionModel(...a),
		experimental_decide: (...a: unknown[]) => mockDecide(...a),
		// Decision telemetry is not under test here.
		recordDecisionOutcome: () => {},
		createDecisionCapture: () => ({
			run: <T>(fn: () => T) => fn(),
			answeringModelLabel: undefined,
		}),
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
	const focus = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/duplicate-focus")
	>("@repo/database/prisma/queries/projects/duplicate-focus");
	const pairs = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/proposal-item-duplicate-pairs")
	>("@repo/database/prisma/queries/projects/proposal-item-duplicate-pairs");
	return {
		...detection,
		...routing,
		...focus,
		...pairs,
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
		listUnresolvedPendingProposalItems: (...a: unknown[]) =>
			mockListInboxItems(...a),
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
	proposalMatches: Array<{
		proposalId: string;
		changeIndex: number;
		title: string;
		summary: string;
		source: string;
		similarity: number;
	}>;
	unverifiedProposalMatches: number;
};

const ctx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

function runCheck(
	description = "Rate limit the export endpoint",
	options: { verifyProposalMatches?: boolean; signal?: AbortSignal } = {},
) {
	return handlers.checkDuplicate({
		input: {
			projectId: "proj-1",
			organizationId: null,
			description,
			verifyProposalMatches: options.verifyProposalMatches,
		},
		context: ctx,
		signal: options.signal,
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

/** A resolved model, as `getAIModelWithMetadata` returns it. */
const TEST_MODEL = {
	model: { id: "test-model" },
	metadata: { provider: "VERCEL_GATEWAY", modelString: "test-model" },
	trackUsage: vi.fn(),
};

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
	mockGetAIModelWithMetadata.mockResolvedValue(TEST_MODEL);
	mockGenerateObject.mockResolvedValue({ output: verdict });
}

function arrangeDecision(answers: Record<string, unknown>) {
	mockGetDecisionModel.mockResolvedValue({
		model: { modelId: "typesafe-ai/jev" },
		metadata: { provider: "VERCEL_GATEWAY" },
		trackUsage: vi.fn(),
	});
	mockDecide.mockResolvedValue({ answers });
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
	// An empty Proposal Inbox by default, so the inbox scan embeds nothing.
	mockListInboxItems.mockResolvedValue([]);
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
		mockGetAIModelWithMetadata.mockResolvedValue(TEST_MODEL);

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
			output: { decision: "create", confidence: 1 },
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
		mockDecide.mockRejectedValue(new AiUsageLimitExceededError());

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
		mockDecide.mockImplementation(() => new Promise(() => {}));

		const startedAt = Date.now();
		const result = await runCheck();

		expect(Date.now() - startedAt).toBeLessThan(2_000);
		expect(result.decision).toBe("create");
		expect(result.error).toBeTruthy();
	});
});

it("keeps the manual-create fallback and explains an incompatible embedding model", async () => {
	const error = new UnsupportedEmbeddingModelError("databricks-gte-large-en");
	mockListActiveStories.mockResolvedValue([TICKET]);
	mockGenerateEmbeddings.mockRejectedValue(error);
	const result = await runCheck();
	expect(result.decision).toBe("create");
	expect(result.error).toBe(error.message);
});

describe("checkDuplicateProcedure — Proposal Inbox matches", () => {
	const inboxItem = (
		proposalId: string,
		changeIndex: number,
		title: string,
		focusTexts: Record<string, string> | null = null,
	) => ({
		proposalId,
		changeIndex,
		source: "SLACK_CHANNEL",
		proposalSummary: `Summary of ${proposalId}`,
		title,
		description: "",
		focusTexts,
	});

	const VERIFIER_PROMPT = "de-duplicating a software project's backlog";

	/** The duplicate verifier answers `relationship` for every inbox
	 * candidate; any other model call (the ticket judge) answers `judge`. */
	function verifierSays(relationship: string, judge?: unknown) {
		mockGetAIModelWithMetadata.mockResolvedValue(TEST_MODEL);
		mockGenerateObject.mockImplementation(
			async ({ prompt }: { prompt?: string }) => ({
				output: prompt?.includes(VERIFIER_PROMPT)
					? { relationship, confidence: 0.95 }
					: judge,
			}),
		);
	}

	/** The model calls made to the duplicate verifier. */
	const verifierCalls = () =>
		mockGenerateObject.mock.calls.filter(([call]) =>
			call?.prompt?.includes(VERIFIER_PROMPT),
		);

	beforeEach(() => {
		verifierSays("same_work_item");
	});

	/** The description and "Queue exports" embed identically, "Throttle
	 * exports" at cosine 0.8, anything else orthogonally. */
	function arrangeInboxEmbeddings() {
		mockGenerateEmbeddings.mockImplementation(async (texts: string[]) => ({
			embeddings: texts.map((text) =>
				text.startsWith("Rate limit") ||
				text.startsWith("Queue exports")
					? [1, 0]
					: text.startsWith("Throttle exports")
						? [0.8, 0.6]
						: [0, 1],
			),
			model: "text-embedding-3-small",
		}));
	}

	it("lists unresolved inbox items at or above the duplicate bar, strongest first, with their score", async () => {
		mockListActiveStories.mockResolvedValue([]);
		mockListInboxItems.mockResolvedValue([
			inboxItem("p-old", 2, "Throttle exports"),
			inboxItem("p-new", 0, "Queue exports"),
			inboxItem("p-new", 1, "Dark mode"),
		]);
		arrangeInboxEmbeddings();

		const result = await runCheck();

		expect(result.decision).toBe("create");
		expect(result.proposalMatches).toEqual([
			{
				proposalId: "p-new",
				changeIndex: 0,
				title: "Queue exports",
				summary: "Summary of p-new",
				source: "SLACK_CHANNEL",
				similarity: expect.closeTo(1, 5),
			},
			expect.objectContaining({
				proposalId: "p-old",
				changeIndex: 2,
				similarity: expect.closeTo(0.8, 5),
			}),
		]);
		expect(mockListInboxItems).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				maxItems: 150,
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("embeds the description and the inbox items in one batched request", async () => {
		mockListActiveStories.mockResolvedValue([]);
		mockListInboxItems.mockResolvedValue([
			inboxItem("p-1", 0, "Queue exports"),
		]);
		arrangeInboxEmbeddings();

		await runCheck();

		expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1);
		const [texts] = mockGenerateEmbeddings.mock.calls[0] as [string[]];
		expect(texts).toHaveLength(2);
		expect(texts[0]).toContain("Rate limit the export endpoint");
		expect(texts[1]).toContain("Queue exports");
	});

	it("weighs a description with a Scope section against inbox features on their Scope, as the roadmap scan does", async () => {
		const queueScope = "In scope:\n- Queue large exports";
		const otherScope = "In scope:\n- Dark mode toggle";
		mockListActiveStories.mockResolvedValue([]);
		mockListInboxItems.mockResolvedValue([
			inboxItem("p-alike", 0, "Throttle exports", { scope: otherScope }),
			inboxItem("p-scope", 1, "Dark mode", { scope: queueScope }),
		]);
		// The description reads like "Throttle exports" (0.8) and apart from
		// "Dark mode" (0); its Scope matches only "Dark mode"'s.
		mockGenerateEmbeddings.mockImplementation(async (texts: string[]) => ({
			embeddings: texts.map((text) =>
				text.startsWith("Rate limit") || text === queueScope
					? [1, 0]
					: text.startsWith("Throttle exports")
						? [0.8, 0.6]
						: [0, 1],
			),
			model: "text-embedding-3-small",
		}));

		const result = await runCheck(
			"Rate limit the export endpoint\n\n## Scope\n### In Scope\n- Queue large exports",
		);

		expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1);
		const [texts] = mockGenerateEmbeddings.mock.calls[0] as [string[]];
		expect(texts.slice(1)).toEqual([
			"Throttle exports",
			"Dark mode",
			queueScope,
			otherScope,
			queueScope,
		]);
		// 0.75 × 1 + 0.25 × 0 = 0.75, on the threshold's scale.
		expect(result.proposalMatches).toEqual([
			expect.objectContaining({
				proposalId: "p-scope",
				changeIndex: 1,
				similarity: expect.closeTo(
					0.7 + ((0.75 - 0.62) * 0.3) / 0.38,
					10,
				),
			}),
		]);
	});

	it("lists only the inbox candidates the duplicate verifier confirms", async () => {
		mockListActiveStories.mockResolvedValue([]);
		mockListInboxItems.mockResolvedValue([
			inboxItem("p-new", 0, "Queue exports"),
		]);
		arrangeInboxEmbeddings();
		verifierSays("distinct");

		const result = await runCheck();

		expect(result.proposalMatches).toEqual([]);
		expect(verifierCalls()).toHaveLength(1);
		const prompt = verifierCalls()[0]?.[0]?.prompt;
		expect(prompt).toContain("Rate limit the export endpoint");
		expect(prompt).toContain("Queue exports");
	});

	it("lists no inbox candidate whose verification fails", async () => {
		mockListActiveStories.mockResolvedValue([]);
		mockListInboxItems.mockResolvedValue([
			inboxItem("p-new", 0, "Queue exports"),
		]);
		arrangeInboxEmbeddings();
		mockGenerateObject.mockRejectedValue(new Error("provider outage"));

		const result = await runCheck();

		expect(result.proposalMatches).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	it("bills no inbox verification on a typing prefetch, and counts what is left for the final check", async () => {
		mockListActiveStories.mockResolvedValue([]);
		mockListInboxItems.mockResolvedValue([
			inboxItem("p-new", 0, "Queue exports"),
		]);
		arrangeInboxEmbeddings();

		const result = await runCheck(undefined, {
			verifyProposalMatches: false,
		});

		expect(result.proposalMatches).toEqual([]);
		expect(result.unverifiedProposalMatches).toBe(1);
		expect(verifierCalls()).toHaveLength(0);
	});

	it("stops the inbox verifier when the caller abandons the request", async () => {
		mockListActiveStories.mockResolvedValue([]);
		mockListInboxItems.mockResolvedValue([
			inboxItem("p-new", 0, "Queue exports"),
		]);
		arrangeInboxEmbeddings();
		const request = new AbortController();

		const result = await runCheck(undefined, { signal: request.signal });

		expect(result.unverifiedProposalMatches).toBe(0);
		const signal = verifierCalls()[0]?.[0]?.abortSignal;
		expect(signal?.aborted).toBe(false);
		request.abort();
		expect(signal?.aborted).toBe(true);
	});

	it("embeds the description once, in the ticket corpus request, beside the inbox items", async () => {
		const judge = {
			decision: "enrich",
			targetIdentifier: "F-12",
			confidence: 0.92,
		} as const;
		arrange(judge);
		verifierSays("same_work_item", judge);
		mockListInboxItems.mockResolvedValue([
			inboxItem("p-1", 0, "Queue exports"),
		]);

		const result = await runCheck();

		expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1);
		const [texts] = mockGenerateEmbeddings.mock.calls[0] as [string[]];
		const containing = (needle: string) =>
			texts.filter((text) => text.includes(needle));
		expect(containing("Rate limit the export endpoint")).toHaveLength(1);
		expect(containing("Queue exports")).toHaveLength(1);
		expect(result.matchedIdentifier).toBe("F-12");
		expect(result.proposalMatches).toEqual([
			expect.objectContaining({ proposalId: "p-1", changeIndex: 0 }),
		]);
	});

	it("embeds nothing for an empty inbox", async () => {
		mockListActiveStories.mockResolvedValue([]);

		const result = await runCheck();

		expect(result.proposalMatches).toEqual([]);
		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
	});

	it("keeps the ticket result when the inbox scan fails", async () => {
		arrange({
			decision: "enrich",
			targetIdentifier: "F-12",
			confidence: 0.92,
		});
		mockListInboxItems.mockRejectedValue(new Error("db down"));

		const result = await runCheck();

		expect(result.decision).toBe("enrich");
		expect(result.matchedIdentifier).toBe("F-12");
		expect(result.error).toBeUndefined();
		expect(result.proposalMatches).toEqual([]);
	});

	it("returns an empty inbox list within the request deadline when the inbox embedding never resolves", async () => {
		process.env.DUPLICATE_CHECK_TIMEOUT_MS = "50";
		mockListActiveStories.mockResolvedValue([]);
		mockListInboxItems.mockResolvedValue([
			inboxItem("p-1", 0, "Queue exports"),
		]);
		mockGenerateEmbeddings.mockImplementation(() => new Promise(() => {}));

		const startedAt = Date.now();
		const result = await runCheck();

		expect(Date.now() - startedAt).toBeLessThan(2_000);
		expect(result.proposalMatches).toEqual([]);
	});
});
