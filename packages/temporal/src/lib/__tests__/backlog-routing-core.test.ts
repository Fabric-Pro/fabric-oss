/**
 * Tests for the shared Create-vs-Enrich routing core (Fizzy #2180), covering
 * what `route-action-items.test.ts` cannot exercise because the Temporal
 * activity never passes a stale-embed cap or a language-judge abort signal —
 * both are the interactive duplicate check's own additions to this shared
 * module. The rest of the core's behaviour (shortlist selection, decision
 * fast path, prompt binding, judge failure containment) is already pinned
 * end-to-end through `routeActionItemsToExistingTickets`; this file does not
 * re-derive it.
 *
 * Same mocking strategy as `route-action-items.test.ts`: mock the embedding
 * provider, the LLM SDK, and the DB query helpers, but run the REAL pure
 * lib (`action-item-link-core`, `duplicate-detection`) via `importActual`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGenerateEmbeddings,
	mockGenerateObject,
	mockTrackUsage,
	mockGetAIModelWithMetadata,
	mockListActiveStories,
	mockResolveModelWithProvider,
	mockListCacheMeta,
	mockListCacheRows,
	mockUpsertCache,
	mockGetBoundPrompt,
	mockEvaluate,
	mockGetDecisionModel,
	mockDecisionTrackUsage,
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
		mockTrackUsage: vi.fn(),
		mockGetAIModelWithMetadata: vi.fn(),
		mockListActiveStories: vi.fn(),
		mockResolveModelWithProvider: vi.fn(),
		mockListCacheMeta: vi.fn(),
		mockListCacheRows: vi.fn(),
		mockUpsertCache: vi.fn(),
		mockGetBoundPrompt: vi.fn(),
		mockEvaluate: vi.fn(),
		mockGetDecisionModel: vi.fn(),
		mockDecisionTrackUsage: vi.fn(),
	};
});

vi.mock("@repo/rag", () => ({ generateEmbeddings: mockGenerateEmbeddings }));

vi.mock("@repo/ai", () => ({
	generateObject: mockGenerateObject,
	getAIModelWithMetadata: mockGetAIModelWithMetadata,
	resolveModelWithProvider: mockResolveModelWithProvider,
	experimental_evaluate: mockEvaluate,
	getAIDecisionModelWithMetadata: mockGetDecisionModel,
}));

vi.mock("@repo/payments/lib/ai-usage-limit-error", () => ({
	AiUsageLimitExceededError,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", async () => {
	const pure = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/action-item-routing")
	>("@repo/database/prisma/queries/projects/action-item-routing");
	const detection = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/duplicate-detection")
	>("@repo/database/prisma/queries/projects/duplicate-detection");
	return {
		...detection,
		...pure,
		listActiveStoriesForDetection: mockListActiveStories,
		listStoryDuplicateEmbeddingMetadata: mockListCacheMeta,
		listStoryDuplicateEmbeddings: mockListCacheRows,
		upsertStoryDuplicateEmbeddings: mockUpsertCache,
		getBoundPromptForAgent: mockGetBoundPrompt,
	};
});

import {
	judgeRoutingItem,
	loadRoutingCorpus,
	type ReadyRoutingCorpus,
	resolveRoutingModels,
} from "../backlog-routing-core";

const BASE = {
	projectId: "proj-1",
	userId: "user-1",
	organizationId: "org-1",
	logPrefix: "[Test]",
};

const TICKET_A = {
	id: "story-a",
	identifier: "F-1",
	title: "Export throttling",
	description: "Exports need a queue.",
	acceptanceCriteria: null,
	createdAt: new Date("2026-01-01"),
	tasks: [],
};
const TICKET_B = {
	id: "story-b",
	identifier: "F-2",
	title: "Rate limit sign-in",
	description: "Sign-in needs a limiter.",
	acceptanceCriteria: null,
	createdAt: new Date("2026-01-01"),
	tasks: [],
};

beforeEach(() => {
	vi.clearAllMocks();
	mockResolveModelWithProvider.mockResolvedValue({
		modelString: "text-embedding-3-small",
	});
	mockListCacheMeta.mockResolvedValue([]);
	mockListCacheRows.mockResolvedValue([]);
	mockUpsertCache.mockResolvedValue(undefined);
	mockGetBoundPrompt.mockResolvedValue(null);
	mockGetDecisionModel.mockRejectedValue(
		new Error("no decision model configured"),
	);
});

describe("loadRoutingCorpus", () => {
	it("returns an empty marker without any embedding call when the project has no active tickets", async () => {
		mockListActiveStories.mockResolvedValue([]);

		const corpus = await loadRoutingCorpus({
			...BASE,
			itemTexts: ["Some new item text"],
		});

		expect(corpus).toEqual({ kind: "empty" });
		expect(mockResolveModelWithProvider).not.toHaveBeenCalled();
		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
	});

	it("embeds every stale candidate when no cap is given (unchanged Temporal-caller behaviour)", async () => {
		mockListActiveStories.mockResolvedValue([TICKET_A, TICKET_B]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 0, 0],
				[1, 0, 0],
				[0, 1, 0],
			],
			model: "text-embedding-3-small",
		});

		const corpus = (await loadRoutingCorpus({
			...BASE,
			itemTexts: ["item text"],
		})) as ReadyRoutingCorpus;

		expect(corpus.kind).toBe("ready");
		expect(corpus.candidateVectors).toHaveLength(2);
		expect(corpus.skippedStale).toBe(0);
		expect(mockGenerateEmbeddings.mock.calls[0][0]).toHaveLength(3);
	});

	it("caps inline stale re-embeds when maxStaleEmbeds is given, skipping the rest", async () => {
		mockListActiveStories.mockResolvedValue([TICKET_A, TICKET_B]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [
				[1, 0, 0],
				[1, 0, 0],
			],
			model: "text-embedding-3-small",
		});

		const corpus = (await loadRoutingCorpus({
			...BASE,
			itemTexts: ["item text"],
			maxStaleEmbeds: 1,
		})) as ReadyRoutingCorpus;

		expect(corpus.kind).toBe("ready");
		// One item + one candidate (the cap), not two candidates.
		expect(mockGenerateEmbeddings.mock.calls[0][0]).toHaveLength(2);
		expect(corpus.skippedStale).toBe(1);
		expect(corpus.candidateVectors).toHaveLength(1);
	});

	it("re-embeds nothing beyond the item when every candidate is already cached", async () => {
		mockListActiveStories.mockResolvedValue([TICKET_A]);
		const { buildDetectionText, hashDetectionText } = await vi.importActual<
			typeof import("@repo/database/prisma/queries/projects/duplicate-detection")
		>("@repo/database/prisma/queries/projects/duplicate-detection");
		const text = buildDetectionText(TICKET_A.title, TICKET_A.description);
		mockListCacheMeta.mockResolvedValue([
			{
				storyId: TICKET_A.id,
				contentHash: hashDetectionText(text),
				model: "text-embedding-3-small",
			},
		]);
		mockListCacheRows.mockResolvedValue([
			{
				storyId: TICKET_A.id,
				contentHash: hashDetectionText(text),
				model: "text-embedding-3-small",
				embedding: [1, 0, 0],
			},
		]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [[1, 0, 0]],
			model: "text-embedding-3-small",
		});

		const corpus = (await loadRoutingCorpus({
			...BASE,
			itemTexts: ["item text"],
			maxStaleEmbeds: 200,
		})) as ReadyRoutingCorpus;

		expect(mockGenerateEmbeddings.mock.calls[0][0]).toHaveLength(1);
		expect(corpus.skippedStale).toBe(0);
		expect(corpus.candidateVectors).toHaveLength(1);
	});

	it("rethrows when the candidate query fails, so a caller can treat this as a wholesale failure", async () => {
		mockListActiveStories.mockRejectedValue(new Error("db down"));

		await expect(
			loadRoutingCorpus({ ...BASE, itemTexts: ["x"] }),
		).rejects.toThrow("db down");
		expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
	});

	it("rethrows when the embedding call fails", async () => {
		mockListActiveStories.mockResolvedValue([TICKET_A]);
		mockGenerateEmbeddings.mockRejectedValue(new Error("embedding outage"));

		await expect(
			loadRoutingCorpus({ ...BASE, itemTexts: ["x"] }),
		).rejects.toThrow("embedding outage");
	});

	it("forwards abortSignal to generateEmbeddings", async () => {
		mockListActiveStories.mockResolvedValue([TICKET_A]);
		mockGenerateEmbeddings.mockResolvedValue({
			embeddings: [[1, 0, 0]],
			model: "text-embedding-3-small",
		});
		const controller = new AbortController();

		await loadRoutingCorpus({
			...BASE,
			itemTexts: ["x"],
			abortSignal: controller.signal,
		});

		expect(mockGenerateEmbeddings).toHaveBeenCalledWith(
			expect.any(Array),
			expect.objectContaining({ projectId: "proj-1" }),
			undefined,
			controller.signal,
			undefined,
		);
	});

	it("calls onEmbedProgress through to generateEmbeddings' batch callback", async () => {
		mockListActiveStories.mockResolvedValue([TICKET_A]);
		mockGenerateEmbeddings.mockImplementation(
			async (
				texts: string[],
				_ctx: unknown,
				_cfg: unknown,
				_signal: unknown,
				onBatch?: (done: number, total: number) => void,
			) => {
				onBatch?.(texts.length, texts.length);
				return { embeddings: texts.map(() => [1, 0, 0]), model: "m" };
			},
		);
		const onEmbedProgress = vi.fn();

		await loadRoutingCorpus({
			...BASE,
			itemTexts: ["x"],
			onEmbedProgress,
		});

		expect(onEmbedProgress).toHaveBeenCalledWith(2, 2);
	});
});

describe("resolveRoutingModels", () => {
	it("resolves the judge and a null decision model when none is configured", async () => {
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: { id: "judge-model" },
			metadata: { provider: "TEST" },
			trackUsage: mockTrackUsage,
		});

		const models = await resolveRoutingModels(BASE);

		expect(models.judge.model).toEqual({ id: "judge-model" });
		expect(models.decisionModel).toBeNull();
	});

	it("resolves a configured decision model", async () => {
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: { id: "judge-model" },
			trackUsage: mockTrackUsage,
		});
		mockGetDecisionModel.mockResolvedValue({
			model: { modelId: "typesafe-ai/jev" },
			trackUsage: mockDecisionTrackUsage,
		});

		const models = await resolveRoutingModels(BASE);

		expect(models.decisionModel).not.toBeNull();
	});

	it("rethrows when the judge model itself cannot be resolved", async () => {
		mockGetAIModelWithMetadata.mockRejectedValue(
			new Error("no COMPLEX model configured"),
		);

		await expect(resolveRoutingModels(BASE)).rejects.toThrow(
			"no COMPLEX model configured",
		);
	});
});

describe("judgeRoutingItem", () => {
	/**
	 * Resolved through the REAL `resolveRoutingModels` (over the mocked
	 * `@repo/ai`) rather than hand-built, so the value's static type is the
	 * real `RoutingModels["judge"]` regardless of the loose shape the mock
	 * actually returns at runtime — `judgeRoutingItem` only ever reads
	 * `.model` and `.trackUsage()` from it, matching every test below.
	 */
	async function getJudge() {
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: { id: "judge-model" },
			trackUsage: vi.fn(),
		});
		return (await resolveRoutingModels(BASE)).judge;
	}

	function corpusOf(vector: number[], stories = [TICKET_A]) {
		return {
			candidateVectors: stories.map((s) => ({
				id: s.id,
				identifier: s.identifier,
				embedding: vector,
			})),
			storyById: new Map(stories.map((s) => [s.id, s])),
			textByStoryId: new Map(
				stories.map((s) => [s.id, `${s.title}\n${s.description}`]),
			),
		};
	}

	it("returns a create judgement with no judge call when nothing clears the cosine floor", async () => {
		const judgement = await judgeRoutingItem({
			itemText: "Unrelated new work",
			itemEmbedding: [0, 1],
			...corpusOf([1, 0]),
			judge: await getJudge(),
			decisionModel: null,
			threshold: 0.7,
			...BASE,
		});

		expect(judgement.kind).toBe("create");
		if (judgement.kind === "create") {
			expect(judgement.confidence).toBe(1);
			expect(judgement.alternatives).toHaveLength(0);
		}
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("returns an enrich judgement from the language judge above threshold", async () => {
		mockGenerateObject.mockResolvedValue({
			object: {
				decision: "enrich",
				targetIdentifier: "F-1",
				confidence: 0.9,
				reasoning: "same work",
			},
		});

		const judge = await getJudge();
		const judgement = await judgeRoutingItem({
			itemText: "Export throttling detail",
			itemEmbedding: [1, 0],
			...corpusOf([1, 0]),
			judge,
			decisionModel: null,
			threshold: 0.7,
			...BASE,
		});

		expect(judgement.kind).toBe("enrich");
		if (judgement.kind === "enrich") {
			expect(judgement.target.identifier).toBe("F-1");
			expect(judgement.source).toBe("language_model");
		}
		expect(judge.trackUsage).toHaveBeenCalled();
	});

	it("degrades to create when the language judge names an identifier off the shortlist", async () => {
		mockGenerateObject.mockResolvedValue({
			object: {
				decision: "enrich",
				targetIdentifier: "F-999",
				confidence: 0.99,
			},
		});

		const judgement = await judgeRoutingItem({
			itemText: "Export throttling detail",
			itemEmbedding: [1, 0],
			...corpusOf([1, 0]),
			judge: await getJudge(),
			decisionModel: null,
			threshold: 0.7,
			...BASE,
		});

		expect(judgement.kind).toBe("create");
		if (judgement.kind === "create") {
			expect(judgement.unmatchedTarget).toBe("F-999");
		}
	});

	it("resolves to a failed judgement, never throwing, when the language judge errors", async () => {
		mockGenerateObject.mockRejectedValue(new Error("gateway timeout"));

		const judgement = await judgeRoutingItem({
			itemText: "Export throttling detail",
			itemEmbedding: [1, 0],
			...corpusOf([1, 0]),
			judge: await getJudge(),
			decisionModel: null,
			threshold: 0.7,
			...BASE,
		});

		expect(judgement.kind).toBe("failed");
		if (judgement.kind === "failed") {
			expect(judgement.error).toContain("gateway timeout");
		}
	});

	it("resolves to a failed judgement (not a fall-through retry) on a usage-limit rejection from the decision fast path", async () => {
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: { id: "judge-model" },
			trackUsage: vi.fn(),
		});
		mockGetDecisionModel.mockResolvedValue({
			model: { modelId: "typesafe-ai/jev" },
			trackUsage: mockDecisionTrackUsage,
		});
		mockEvaluate.mockRejectedValue(new AiUsageLimitExceededError());
		// Resolved through the real function rather than hand-built, so the
		// value's static type is the real `AIDecisionModelResult` regardless
		// of the loose shape the mock actually returns at runtime.
		const { decisionModel } = await resolveRoutingModels(BASE);

		const judgement = await judgeRoutingItem({
			itemText: "Export throttling detail",
			itemEmbedding: [1, 0],
			...corpusOf([1, 0]),
			judge: await getJudge(),
			decisionModel,
			threshold: 0.7,
			...BASE,
		});

		expect(judgement.kind).toBe("failed");
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("aborts the decision fast path when the caller's signal aborts, falling through to the language judge", async () => {
		mockGetDecisionModel.mockResolvedValue({
			model: { modelId: "typesafe-ai/jev" },
			trackUsage: mockDecisionTrackUsage,
		});
		let receivedSignal: AbortSignal | undefined;
		mockEvaluate.mockImplementation(
			(params: { abortSignal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					receivedSignal = params.abortSignal;
					const onAbort = () =>
						reject(
							new DOMException(
								"The operation was aborted.",
								"AbortError",
							),
						);
					if (params.abortSignal?.aborted) {
						onAbort();
					} else {
						params.abortSignal?.addEventListener("abort", onAbort);
					}
				}),
		);
		mockGenerateObject.mockResolvedValue({
			object: { decision: "create", confidence: 1 },
		});
		const { decisionModel } = await resolveRoutingModels(BASE);
		const controller = new AbortController();

		const judgementPromise = judgeRoutingItem({
			itemText: "Export throttling detail",
			itemEmbedding: [1, 0],
			...corpusOf([1, 0]),
			judge: await getJudge(),
			decisionModel,
			threshold: 0.7,
			...BASE,
			abortSignal: controller.signal,
		});
		controller.abort();
		const judgement = await judgementPromise;

		expect(receivedSignal?.aborted).toBe(true);
		// The aborted fast path falls through rather than failing the whole
		// judgement — the language judge still gets a chance to answer.
		expect(judgement.kind).toBe("create");
		expect(mockGenerateObject).toHaveBeenCalledOnce();
	});

	it("calls onBeforeLanguageJudge and forwards abortSignal to generateObject", async () => {
		mockGenerateObject.mockResolvedValue({
			object: { decision: "create", confidence: 1 },
		});
		const onBeforeLanguageJudge = vi.fn();
		const controller = new AbortController();

		await judgeRoutingItem({
			itemText: "Export throttling detail",
			itemEmbedding: [1, 0],
			...corpusOf([1, 0]),
			judge: await getJudge(),
			decisionModel: null,
			threshold: 0.7,
			...BASE,
			onBeforeLanguageJudge,
			abortSignal: controller.signal,
		});

		expect(onBeforeLanguageJudge).toHaveBeenCalledOnce();
		expect(mockGenerateObject.mock.calls[0][0].abortSignal).toBe(
			controller.signal,
		);
	});
});
