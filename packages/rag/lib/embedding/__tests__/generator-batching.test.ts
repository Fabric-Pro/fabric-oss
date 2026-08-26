/**
 * Batching in `generateEmbeddings`.
 *
 * The provider rejects a request over 300k tokens or 2048 inputs, and callers
 * hand this function whatever they have — a project's whole backlog, a repo's
 * worth of chunks. Before batching, one oversized input threw and callers that
 * read a single failure as "nothing could be evaluated" degraded far past what
 * the input warranted.
 *
 * The load-bearing assertion is ORDER. `routeActionItemsToExistingTickets`
 * indexes the returned array positionally against the texts it passed in
 * (`embeddings.slice(0, itemTexts.length)`, then `embeddings[itemTexts.length + i]`),
 * so embeddings arriving out of order would pair every story with the wrong
 * vector — silently wrong, where the old failure was at least loud.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	embedManyMock,
	countTokensBatchMock,
	countTokensMock,
	splitByTokensMock,
} = vi.hoisted(() => ({
	embedManyMock: vi.fn(),
	countTokensBatchMock: vi.fn(),
	countTokensMock: vi.fn(),
	splitByTokensMock: vi.fn(),
}));

vi.mock("ai", () => ({
	embed: vi.fn(),
	embedMany: embedManyMock,
}));

vi.mock("@repo/ai", () => ({
	getAIEmbeddingModelWithMetadata: vi.fn(async () => ({
		model: { id: "text-embedding-3-small" },
		metadata: {
			modelString: "openai/text-embedding-3-small",
			selectionSource: "test",
		},
		trackUsage: vi.fn(),
	})),
	logEmbeddingUsageAsync: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("../../chunking/tokenizer", () => ({
	countTokensBatch: countTokensBatchMock,
	countTokens: countTokensMock,
	splitByTokens: splitByTokensMock,
}));

import {
	generateEmbeddings,
	MAX_INPUTS_PER_REQUEST,
	MAX_TOKENS_PER_INPUT,
	MAX_TOKENS_PER_REQUEST,
	planEmbeddingBatches,
} from "../generator";

/**
 * A per-text count has to sit UNDER the per-input cap to be realistic: anything
 * above it is split into pieces of at most `MAX_TOKENS_PER_INPUT`, so no single
 * provider input ever exceeds that. Mocking one text at "half the request
 * ceiling" describes an input that cannot reach the batcher in that shape, and
 * the batcher rightly declines to split for it.
 */
const PER_TEXT_TOKENS = MAX_TOKENS_PER_INPUT - 192;
const TEXTS_PER_REQUEST = Math.floor(MAX_TOKENS_PER_REQUEST / PER_TEXT_TOKENS);
/** Comfortably more than one request's worth. */
const SPLITTING_TEXT_COUNT = TEXTS_PER_REQUEST * 2 + 1;

const TENANT = {
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project-1",
};

/** `text-<n>` embeds to `[n]`, so a result reveals its own input order. */
function markerTexts(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `text-${i}`);
}

function markerOf(text: string): number {
	return Number(text.split("-")[1]);
}

beforeEach(() => {
	vi.clearAllMocks();
	embedManyMock.mockImplementation(
		async ({ values }: { values: string[] }) => ({
			embeddings: values.map((value) => [markerOf(value)]),
			usage: { tokens: values.length * 10 },
		}),
	);
	// Default: nothing is oversized, so the splitter is a pass-through.
	splitByTokensMock.mockImplementation((text: string) => [text]);
	countTokensMock.mockReturnValue(1);
	// Default: every text is cheap, so only the input-count ceiling can bite.
	countTokensBatchMock.mockImplementation((texts: string[]) =>
		texts.map(() => 1),
	);
});

/** Pair each text with a uniform token cost. */
function counted(texts: string[], tokens: number) {
	return texts.map((text) => ({ text, tokens }));
}

describe("planEmbeddingBatches", () => {
	it("keeps an input that fits in a single request", () => {
		const texts = markerTexts(5);
		const batches = planEmbeddingBatches(counted(texts, 1));

		expect(batches).toHaveLength(1);
		expect(batches[0]).toEqual(texts);
	});

	it("splits on the token ceiling without losing or reordering anything", () => {
		const texts = markerTexts(4);
		const batches = planEmbeddingBatches(
			counted(texts, MAX_TOKENS_PER_REQUEST / 2),
		);

		expect(batches.length).toBeGreaterThan(1);
		expect(batches.flat()).toEqual(texts);
	});

	it("splits on the input-count ceiling", () => {
		const texts = markerTexts(MAX_INPUTS_PER_REQUEST + 1);
		const batches = planEmbeddingBatches(counted(texts, 1));

		expect(batches).toHaveLength(2);
		expect(batches[0]).toHaveLength(MAX_INPUTS_PER_REQUEST);
		expect(batches[1]).toHaveLength(1);
		expect(batches.flat()).toEqual(texts);
	});

	it("gives a single over-ceiling text its own request, never an empty one", () => {
		const texts = markerTexts(2);
		const batches = planEmbeddingBatches([
			{ text: texts[0], tokens: MAX_TOKENS_PER_REQUEST + 1 },
			{ text: texts[1], tokens: 1 },
		]);

		expect(batches.every((batch) => batch.length > 0)).toBe(true);
		expect(batches.flat()).toEqual(texts);
	});

	it("returns no batches for an empty input", () => {
		expect(planEmbeddingBatches([])).toEqual([]);
	});
});

describe("generateEmbeddings", () => {
	/**
	 * Guards the two tests below. They claim to exercise the TOKEN ceiling, but
	 * a large enough text count would split on the input-count ceiling instead
	 * and they would keep passing while token batching was broken — which is
	 * exactly what happened the first time this suite was checked by disabling
	 * the fix. If this fails, those tests are no longer testing what they say.
	 */
	it("drives its split from the token ceiling, not the input-count ceiling", () => {
		expect(SPLITTING_TEXT_COUNT).toBeLessThan(MAX_INPUTS_PER_REQUEST);
	});

	it("splits a too-large input across requests and returns them in input order", async () => {
		const texts = markerTexts(SPLITTING_TEXT_COUNT);
		countTokensBatchMock.mockReturnValue(texts.map(() => PER_TEXT_TOKENS));

		const result = await generateEmbeddings(texts, TENANT);

		expect(embedManyMock.mock.calls.length).toBeGreaterThan(1);
		// Order is the property callers index against.
		expect(result.embeddings.map((e) => e[0])).toEqual(
			texts.map((_, i) => i),
		);
		expect(result.embeddings).toHaveLength(texts.length);
	});

	it("keeps every issued request within the token ceiling", async () => {
		const texts = markerTexts(SPLITTING_TEXT_COUNT);
		countTokensBatchMock.mockReturnValue(texts.map(() => PER_TEXT_TOKENS));

		await generateEmbeddings(texts, TENANT);

		expect(embedManyMock.mock.calls.length).toBeGreaterThan(1);
		for (const call of embedManyMock.mock.calls) {
			const values = call[0].values as string[];
			expect(values.length * PER_TEXT_TOKENS).toBeLessThanOrEqual(
				MAX_TOKENS_PER_REQUEST,
			);
			// Strictly less: at this size the count cap must not be what is
			// closing the batches, or the token assertion above proves nothing.
			expect(values.length).toBeLessThan(MAX_INPUTS_PER_REQUEST);
		}
	});

	it("sums usage and cost across every request", async () => {
		const texts = markerTexts(SPLITTING_TEXT_COUNT);
		countTokensBatchMock.mockReturnValue(texts.map(() => PER_TEXT_TOKENS));

		const result = await generateEmbeddings(texts, TENANT);

		// The mock bills 10 tokens per input, so a total matching every input
		// proves the count spans all requests, not just the last one.
		expect(embedManyMock.mock.calls.length).toBeGreaterThan(1);
		expect(result.totalTokens).toBe(texts.length * 10);
		expect(result.cost).toBeGreaterThan(0);
	});

	it("still issues exactly one request when the input fits", async () => {
		const result = await generateEmbeddings(markerTexts(3), TENANT);

		expect(embedManyMock).toHaveBeenCalledTimes(1);
		expect(result.embeddings.map((e) => e[0])).toEqual([0, 1, 2]);
	});

	describe("an input over the per-input cap", () => {
		/**
		 * Splitting rather than truncating is the point. Truncation discards
		 * text the caller believed was embedded, and duplicate detection is
		 * where that bites: two long stories sharing an opening truncate to
		 * near-identical vectors and read as duplicates of each other.
		 */
		beforeEach(() => {
			countTokensBatchMock.mockReturnValue([10_000]);
			splitByTokensMock.mockReturnValue(["head", "tail"]);
			// head is 4x the size of tail, so it must dominate the result.
			countTokensMock.mockImplementation((text: string) =>
				text === "head" ? 8000 : 2000,
			);
			embedManyMock.mockImplementation(
				async ({ values }: { values: string[] }) => ({
					embeddings: values.map((value) =>
						value === "head" ? [1, 0] : [0, 1],
					),
					usage: { tokens: values.length * 10 },
				}),
			);
		});

		it("is split rather than truncated", async () => {
			await generateEmbeddings(["long"], TENANT);

			expect(splitByTokensMock).toHaveBeenCalledTimes(1);
			expect(embedManyMock.mock.calls[0][0].values).toEqual([
				"head",
				"tail",
			]);
		});

		it("still yields exactly one embedding, so positional indexing holds", async () => {
			const result = await generateEmbeddings(["long"], TENANT);

			expect(result.embeddings).toHaveLength(1);
		});

		it("combines its chunks weighted by token count", async () => {
			const result = await generateEmbeddings(["long"], TENANT);
			const [x, y] = result.embeddings[0];

			// head carries 4x the tokens, so it pulls the vector its way.
			expect(x).toBeGreaterThan(y);
			expect(y).toBeGreaterThan(0);
		});

		it("returns a unit vector, which cosine similarity assumes", async () => {
			const result = await generateEmbeddings(["long"], TENANT);
			const magnitude = Math.hypot(...result.embeddings[0]);

			expect(magnitude).toBeCloseTo(1, 10);
		});

		it("keeps unsplit inputs aligned alongside a split one", async () => {
			countTokensBatchMock.mockReturnValue([10_000, 5]);
			splitByTokensMock.mockReturnValue(["head", "tail"]);
			embedManyMock.mockImplementation(
				async ({ values }: { values: string[] }) => ({
					embeddings: values.map((value) =>
						value === "head"
							? [1, 0]
							: value === "tail"
								? [0, 1]
								: [9, 9],
					),
					usage: { tokens: values.length * 10 },
				}),
			);

			const result = await generateEmbeddings(["long", "short"], TENANT);

			expect(result.embeddings).toHaveLength(2);
			// The unsplit second input must come back untouched, not averaged.
			expect(result.embeddings[1]).toEqual([9, 9]);
		});
	});

	it("reports each completed request so a caller can heartbeat between them", async () => {
		const texts = markerTexts(SPLITTING_TEXT_COUNT);
		countTokensBatchMock.mockReturnValue(texts.map(() => PER_TEXT_TOKENS));
		const onBatch = vi.fn();

		await generateEmbeddings(texts, TENANT, undefined, undefined, onBatch);

		// One callback per provider request, or a caller inside a Temporal
		// activity cannot keep its heartbeat alive across a long split.
		expect(onBatch).toHaveBeenCalledTimes(embedManyMock.mock.calls.length);
		expect(embedManyMock.mock.calls.length).toBeGreaterThan(1);
		const total = embedManyMock.mock.calls.length;
		expect(onBatch).toHaveBeenLastCalledWith(total, total);
	});

	it("does not call the provider for an empty input", async () => {
		const result = await generateEmbeddings([], TENANT);

		expect(embedManyMock).not.toHaveBeenCalled();
		expect(result.embeddings).toEqual([]);
		expect(result.totalTokens).toBe(0);
	});
});
