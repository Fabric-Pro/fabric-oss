/**
 * `throwOnRetrievalError` — telling an OUTAGE apart from an empty project.
 *
 * Retrieval degrades to an empty result when it cannot run: no embedding
 * provider, or an embedding service that returns no vectors. For a human that is
 * the right behavior — they see "no relevant context" and move on.
 *
 * It is the wrong behavior for an unattended, scheduled job. The Living Documents
 * auto-refresh cannot tell "this project has no context" from "the embedding
 * service is down", and if it guesses wrong it records the outage as a completed
 * no-change cycle, ADVANCES the document's cadence clock, and silences it for a
 * fortnight — across every tenant, in one sweep.
 *
 * So the two cases have to be distinguishable at this layer, and the DEFAULT must
 * not change: the interactive "Update using context" button shares this code path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getProviderConfigMock,
	generateEmbeddingsMock,
	searchMock,
	chunkTextMock,
	applySummaryMock,
} = vi.hoisted(() => ({
	getProviderConfigMock: vi.fn(),
	generateEmbeddingsMock: vi.fn(),
	searchMock: vi.fn(),
	chunkTextMock: vi.fn(),
	applySummaryMock: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getRAGProviderConfig: getProviderConfigMock,
}));

vi.mock("@repo/database", () => ({
	getRetrievableContextById: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../chunking", () => ({ chunkText: chunkTextMock }));
vi.mock("../../embedding", () => ({
	generateEmbeddings: generateEmbeddingsMock,
}));
vi.mock("../../embedding/sparse", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [], values: [] })),
}));
vi.mock("../store", () => ({ searchSimilarProjectContexts: searchMock }));
vi.mock("../summary-injection", () => ({
	applyContextSummary: applySummaryMock,
}));

import {
	RetrievalUnavailableError,
	retrieveRelevantContextsForSpec,
} from "../retrieve-for-spec";

const BASE = {
	projectId: "proj_1",
	userId: "user_1",
	specMarkdown: "# PRD\n\nThe rollout plan.",
	baselineDate: new Date("2026-06-01T00:00:00Z"),
};

beforeEach(() => {
	vi.clearAllMocks();
	getProviderConfigMock.mockResolvedValue({ provider: "openai" });
	chunkTextMock.mockReturnValue([{ content: "# PRD The rollout plan." }]);
	generateEmbeddingsMock.mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] });
	searchMock.mockResolvedValue([]);
	// Pass-through: every exit funnels through the summary injector.
	applySummaryMock.mockImplementation(async (list: unknown[]) => list);
});

describe("no embedding provider", () => {
	it("throws RetrievalUnavailableError when the caller asked to fail loudly", async () => {
		getProviderConfigMock.mockRejectedValue(
			new Error("no provider configured"),
		);

		await expect(
			retrieveRelevantContextsForSpec({
				...BASE,
				throwOnRetrievalError: true,
			}),
		).rejects.toBeInstanceOf(RetrievalUnavailableError);
	});

	it("degrades to an empty result by default — the interactive path is unchanged", async () => {
		getProviderConfigMock.mockRejectedValue(
			new Error("no provider configured"),
		);

		await expect(retrieveRelevantContextsForSpec(BASE)).resolves.toEqual(
			[],
		);
	});
});

describe("embedding service returned nothing", () => {
	it("throws RetrievalUnavailableError when the caller asked to fail loudly", async () => {
		generateEmbeddingsMock.mockResolvedValue({ embeddings: [] });

		await expect(
			retrieveRelevantContextsForSpec({
				...BASE,
				throwOnRetrievalError: true,
			}),
		).rejects.toBeInstanceOf(RetrievalUnavailableError);
	});

	it("degrades to an empty result by default", async () => {
		generateEmbeddingsMock.mockResolvedValue({ embeddings: [] });

		await expect(retrieveRelevantContextsForSpec(BASE)).resolves.toEqual(
			[],
		);
	});
});

describe("retrieval RAN and simply found nothing", () => {
	it("returns empty WITHOUT throwing, even when asked to fail loudly", async () => {
		// The distinction the whole option exists to make. A project with no context
		// is an ordinary empty result, not an outage — throwing here would make every
		// quiet project look like a broken one and retry it forever.
		searchMock.mockResolvedValue([]);

		await expect(
			retrieveRelevantContextsForSpec({
				...BASE,
				throwOnRetrievalError: true,
			}),
		).resolves.toEqual([]);
	});

	it("returns empty WITHOUT throwing for an empty spec, even when asked to fail loudly", async () => {
		// Nothing to query with is not an outage either.
		await expect(
			retrieveRelevantContextsForSpec({
				...BASE,
				specMarkdown: "   ",
				throwOnRetrievalError: true,
			}),
		).resolves.toEqual([]);
	});
});
