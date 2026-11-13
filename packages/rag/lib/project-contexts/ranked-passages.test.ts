import { runWithDispatchGuard } from "@repo/utils/dispatch-guard";

vi.mock("../embedding", () => ({ generateQueryEmbedding: vi.fn() }));
vi.mock("./summary-injection", () => ({ applyContextSummary: vi.fn() }));
vi.mock("./search-hits", () => ({
	searchProjectContextHits: vi.fn(),
	hydrateProjectContextHits: vi.fn(),
}));
vi.mock("../reranking/select-project-contexts", () => ({
	selectProjectContexts: vi.fn(),
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RerankOptions, RerankResult } from "../reranking/types";
import type { RetrievedContext } from "./retrieval";

const mocks = vi.hoisted(() => ({
	retrieve: vi.fn(),
	settings: vi.fn(),
	config: vi.fn(),
	create: vi.fn(),
	available: vi.fn(),
	localAvailable: vi.fn(),
	rerank: vi.fn(),
	warn: vi.fn(),
}));
vi.mock("@repo/database", () => ({ getProjectRagSettings: mocks.settings }));
vi.mock("@repo/logs", () => ({ logger: { warn: mocks.warn } }));
vi.mock("../reranking", () => ({
	createReranker: mocks.create,
	getRerankerConfig: mocks.config,
	isCrossEncoderAvailable: mocks.localAvailable,
}));
vi.mock("./retrieval", async (importOriginal) => ({
	...(await importOriginal<typeof import("./retrieval")>()),
	retrieveProjectContexts: mocks.retrieve,
}));

import { retrieveRankedPassages } from "./ranked-passages";
import { formatContextsForPrompt } from "./retrieval";

const options = {
	projectId: "example-project",
	userId: "example-user",
	organizationId: "example-org",
	query: "Create an export story",
	topK: 5,
};
const source = (
	id: string,
	count = 15,
): RetrievedContext & {
	matchedPassages: NonNullable<RetrievedContext["matchedPassages"]>;
} => ({
	id,
	type: "TEXT",
	content: `WHOLE ${id}`,
	score: 0.5,
	matchedPassages: Array.from({ length: count }, (_, chunkIndex) => ({
		content: `${id}-${chunkIndex};`,
		chunkIndex,
		score: 1 - (id === "a" ? chunkIndex : chunkIndex + 15) / 100,
	})),
});
const contexts = [source("a"), source("b")];
const fallbackText = formatContextsForPrompt(
	contexts.map((c) => ({
		...c,
		content: c.matchedPassages
			.slice(0, 10)
			.map((p) => p.content)
			.join("\n\n"),
	})),
);
const providerConfig = {
	provider: "gateway",
	model: "configured-model",
	apiKey: "synthetic-key",
	timeout: 30000,
	tenant: {
		userId: options.userId,
		organizationId: options.organizationId,
		projectId: options.projectId,
	},
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.retrieve.mockResolvedValue(contexts);
	mocks.settings.mockResolvedValue({
		enableReranking: true,
		rerankerProvider: "gateway",
		chunkOverlap: 500,
	});
	mocks.config.mockResolvedValue(providerConfig);
	mocks.create.mockReturnValue({
		isAvailable: mocks.available,
		rerank: mocks.rerank,
	});
	mocks.available.mockResolvedValue(true);
	mocks.localAvailable.mockReturnValue(true);
	mocks.rerank.mockImplementation(
		async ({ documents }: RerankOptions): Promise<RerankResult[]> =>
			documents.map((document, originalIndex) => ({
				document,
				originalIndex,
				relevanceScore: originalIndex / 100,
			})),
	);
});
afterEach(() => vi.useRealTimers());

describe("retrieveRankedPassages", () => {
	it("keeps query and tenant, requests a diversified pool and reranks individual chunks with the organization's config", async () => {
		mocks.localAvailable.mockReturnValue(false);
		const text = await retrieveRankedPassages(options);
		expect(mocks.retrieve).toHaveBeenCalledWith({
			...options,
			topK: 50,
			diversify: true,
			maxContexts: 50,
			skipRerank: true,
			includeMatchedPassages: true,
		});
		expect(mocks.config).toHaveBeenCalledWith(
			"gateway",
			undefined,
			providerConfig.tenant,
		);
		expect(mocks.create).toHaveBeenCalledWith(providerConfig);
		expect(mocks.rerank).toHaveBeenCalledWith(
			expect.objectContaining({
				query: options.query,
				topK: 30,
				minRelevanceScore: 0,
			}),
		);
		const documents = mocks.rerank.mock.calls[0][0]
			.documents as RetrievedContext[];
		expect(documents).toHaveLength(30);
		expect(new Set(documents.map((d) => d.id)).size).toBe(30);
		expect(documents.map((d) => d.content)).toEqual(
			contexts.flatMap((c) => c.matchedPassages.map((p) => p.content)),
		);
		expect(text).toBe(
			formatContextsForPrompt(
				[...contexts].reverse().map((c) => ({
					...c,
					content: c.matchedPassages
						.slice(5)
						.map((p) => p.content)
						.join("\n\n"),
				})),
			),
		);
		expect(mocks.warn).not.toHaveBeenCalled();
	});
	it("reranks only the globally best 50 chunks and keeps 20 with 10 per source", async () => {
		mocks.retrieve.mockResolvedValue([source("a", 40), source("b", 30)]);
		const text = await retrieveRankedPassages(options);
		expect(mocks.rerank.mock.calls[0][0].documents).toHaveLength(50);
		expect(text.match(/a-\d+;/g)).toHaveLength(10);
		expect(text.match(/b-\d+;/g)).toHaveLength(10);
	});
	it("reranks even a single chunk", async () => {
		mocks.retrieve.mockResolvedValue([source("a", 1)]);
		await retrieveRankedPassages(options);
		expect(mocks.rerank).toHaveBeenCalledWith(
			expect.objectContaining({ topK: 1 }),
		);
	});
	it("returns empty text without reranking or warning when the pool is empty", async () => {
		mocks.retrieve.mockResolvedValue([]);
		expect(await retrieveRankedPassages(options)).toBe("");
		expect(mocks.config).not.toHaveBeenCalled();
		expect(mocks.warn).not.toHaveBeenCalled();
	});
	it("ignores non-summary whole documents without matched passages", async () => {
		mocks.retrieve.mockResolvedValue([
			{ ...source("a"), matchedPassages: undefined },
		]);
		expect(await retrieveRankedPassages(options)).toBe("");
	});
	it("uses the project's merge bound", async () => {
		const overlap = `X${"o".repeat(98)}Z`;
		const c = {
			...source("a"),
			matchedPassages: [
				{ content: `LEFT${overlap}`, chunkIndex: 0, score: 1 },
				{ content: `${overlap}RIGHT`, chunkIndex: 1, score: 1 },
			],
		};
		mocks.retrieve.mockResolvedValue([c]);
		mocks.settings.mockResolvedValue({
			enableReranking: true,
			chunkOverlap: 80,
		});
		expect(await retrieveRankedPassages(options)).toContain(
			`LEFT${overlap}\n\n${overlap}RIGHT`,
		);
	});
});

const failures: Array<[string, string, () => void]> = [
	[
		"disabled",
		"RANKED_PASSAGES_DISABLED",
		() => mocks.settings.mockResolvedValue({ enableReranking: false }),
	],
	[
		"no provider",
		"RANKED_PASSAGES_NO_PROVIDER",
		() => mocks.config.mockResolvedValue({}),
	],
	[
		"unavailable",
		"RANKED_PASSAGES_UNAVAILABLE",
		() => mocks.available.mockResolvedValue(false),
	],
	[
		"local provider unavailable on Vercel",
		"RANKED_PASSAGES_UNAVAILABLE",
		() => {
			mocks.config.mockResolvedValue({ provider: "cross-encoder" });
			mocks.localAvailable.mockReturnValue(false);
		},
	],
	[
		"settings error",
		"RANKED_PASSAGES_FAILED",
		() =>
			mocks.settings.mockRejectedValue(
				new Error("private upstream text"),
			),
	],
	[
		"credential resolution error",
		"RANKED_PASSAGES_FAILED",
		() =>
			mocks.config.mockRejectedValue(new Error("private upstream text")),
	],
	[
		"factory error",
		"RANKED_PASSAGES_FAILED",
		() =>
			mocks.create.mockImplementation(() => {
				throw new Error("private upstream text");
			}),
	],
	[
		"availability error",
		"RANKED_PASSAGES_FAILED",
		() =>
			mocks.available.mockRejectedValue(
				new Error("private upstream text"),
			),
	],
	[
		"provider error",
		"RANKED_PASSAGES_FAILED",
		() =>
			mocks.rerank.mockRejectedValue(new Error("private upstream text")),
	],
	[
		"missing scores",
		"RANKED_PASSAGES_INVALID_SCORES",
		() => mocks.rerank.mockResolvedValue([]),
	],
	[
		"non-array response",
		"RANKED_PASSAGES_INVALID_SCORES",
		() => mocks.rerank.mockResolvedValue(null),
	],
];
for (const score of [
	undefined,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
]) {
	failures.push([
		`nonfinite score ${score}`,
		"RANKED_PASSAGES_INVALID_SCORES",
		() =>
			mocks.rerank.mockImplementation(
				async ({ documents }: RerankOptions) =>
					documents.map((document, i) => ({
						document,
						relevanceScore: i === 0 ? score : 1,
						originalIndex: i,
					})),
			),
	]);
}
for (const [name, reason, setup] of failures) {
	it(`falls back to retrieval ranking with one safe warning: ${name}`, async () => {
		setup();
		expect(await retrieveRankedPassages(options)).toBe(fallbackText);
		expect(mocks.warn.mock.calls).toEqual([
			["[RankedPassages] Using retrieval scores", { reason }],
		]);
	});
}
for (const stage of ["settings", "config", "available", "rerank"] as const) {
	it(`times out a stalled ${stage} and uses retrieval ranking`, async () => {
		vi.useFakeTimers();
		mocks[stage].mockReturnValue(new Promise(() => {}));
		const pending = retrieveRankedPassages(options);
		await vi.advanceTimersByTimeAsync(30000);
		expect(await pending).toBe(fallbackText);
		expect(mocks.warn.mock.calls).toEqual([
			[
				"[RankedPassages] Using retrieval scores",
				{ reason: "RANKED_PASSAGES_TIMEOUT" },
			],
		]);
		expect(vi.getTimerCount()).toBe(0);
	});
}

for (const stage of ["settings", "config", "available"] as const) {
	it(`does not start downstream work when timed-out ${stage} eventually resolves`, async () => {
		vi.useFakeTimers();
		let resolveLate: (value: unknown) => void = () => {};
		mocks[stage].mockReturnValue(
			new Promise((resolve) => {
				resolveLate = resolve;
			}),
		);
		const pending = retrieveRankedPassages(options);
		await vi.advanceTimersByTimeAsync(30000);
		expect(await pending).toBe(fallbackText);
		resolveLate(
			stage === "settings"
				? { enableReranking: true }
				: stage === "config"
					? providerConfig
					: true,
		);
		await vi.runAllTimersAsync();
		expect(
			mocks[
				stage === "settings"
					? "config"
					: stage === "config"
						? "create"
						: "rerank"
			],
		).not.toHaveBeenCalled();
		expect(mocks.warn).toHaveBeenCalledTimes(1);
	});
}
it("preserves a dispatch stop rather than treating it as a rerank failure", async () => {
	const stop = new Error("synthetic stop");
	mocks.rerank.mockRejectedValue(stop);
	const pending = runWithDispatchGuard(
		{
			key: "example-turn",
			assertDispatchable: async () => {},
			abortSignal: () => undefined,
			rethrowIfStopped: (error) => {
				if (error === stop) {
					throw error;
				}
			},
		},
		() => retrieveRankedPassages(options),
	);
	await expect(pending).rejects.toBe(stop);
	expect(mocks.warn).not.toHaveBeenCalled();
});
it("keeps at most 20 when more than two sources have candidates", async () => {
	mocks.retrieve.mockResolvedValue([source("a"), source("b"), source("c")]);
	const text = await retrieveRankedPassages(options);
	expect(text.match(/[abc]-\d+;/g)).toHaveLength(20);
});

for (const marker of [
	{ type: "PROJECT_SUMMARY" },
	{ type: "TEXT", metadata: { isSummary: true } },
]) {
	for (const mode of ["ranked", "fallback", "summary-only"] as const) {
		it(`preserves the whole summary before ranked passages (${JSON.stringify(marker)}, ${mode})`, async () => {
			const summary: RetrievedContext = {
				id: "example-summary",
				score: 1,
				content: "Whole summary including source references.",
				sourceTitle: "Project summary",
				...marker,
			};
			mocks.retrieve.mockResolvedValue(
				mode === "summary-only" ? [summary] : [...contexts, summary],
			);
			if (mode === "fallback") {
				mocks.settings.mockResolvedValue({ enableReranking: false });
			}
			const text = await retrieveRankedPassages(options);
			const sources =
				mode === "summary-only"
					? []
					: (mode === "ranked"
							? [...contexts].reverse()
							: contexts
						).map((c) => ({
							...c,
							content: c.matchedPassages
								.slice(
									mode === "ranked" ? 5 : 0,
									mode === "ranked" ? undefined : 10,
								)
								.map((p) => p.content)
								.join("\n\n"),
						}));
			expect(text).toBe(formatContextsForPrompt([summary, ...sources]));
			if (mode === "ranked") {
				expect(mocks.rerank.mock.calls[0][0].documents).toHaveLength(
					30,
				);
			} else {
				expect(mocks.rerank).not.toHaveBeenCalled();
			}
		});
	}
}

for (const marker of [
	{ type: "TEXT", metadata: { isSummary: "true" } },
	{ type: "TEXT", metadata: { isSummary: false } },
	{ type: "project_summary" },
]) {
	it(`ignores non-summary markers without matched passages: ${JSON.stringify(marker)}`, async () => {
		mocks.retrieve.mockResolvedValue([
			{ ...source("a"), matchedPassages: undefined, ...marker },
		]);
		expect(await retrieveRankedPassages(options)).toBe("");
	});
}
