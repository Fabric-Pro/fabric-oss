/**
 * `retrieveProjectContexts` must be able to leave one context row out of a run.
 *
 * The document create flow stores a user's pasted source as a project context
 * AND hands its text straight to the same generation run — retrieval is
 * similarity-scoped and may not have indexed a row created seconds ago, so
 * waiting for it would mean silently ignoring the material the user just
 * supplied. The cost of delivering it directly is that a run which *does*
 * retrieve it puts the same words in front of the model twice (R29).
 *
 * The exclusion lives inside this activity rather than at its caller because
 * the activity returns `string[]`: no identifiers cross the boundary, so a
 * workflow-side post-filter would have nothing to match on.
 *
 * The interesting case is the chunked one. Qdrant payloads carry the CHUNK id
 * (`<contextId>-chunk-N`), not the row id, so the filter is applied after
 * `extractBaseContextId` normalizes them — which is why the real
 * implementation of that helper is deliberately kept in this test's partial
 * mock of `@repo/rag`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		findMany: vi.fn(),
		getProjectRagSettings: vi.fn(),
		searchSimilarProjectContexts: vi.fn(),
		applyContextSummary: vi.fn(),
		rerankContexts: vi.fn(),
		embed: vi.fn(),
		getAIEmbeddingModelWithMetadata: vi.fn(),
		logEmbeddingUsageAsync: vi.fn(),
	},
}));

// Partial mock (`importOriginal`): the activity module imports a wide surface
// from `@repo/database` at load time and transitive packages wire themselves up
// on import, so only the two calls this retrieval path makes are swapped.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		db: {
			projectContext: {
				findMany: (...args: unknown[]) => mocks.findMany(...args),
			},
		},
		getProjectRagSettings: (...args: unknown[]) =>
			mocks.getProjectRagSettings(...args),
	};
});

// `@repo/ai` is the one mock with NO `importOriginal`. Its barrel boots the
// whole provider registry (every SDK adapter, OAuth included) for the sake of
// three functions on this path, and nothing in a retrieval-exclusion test wants
// a provider registry. The subpath imports the activity module also uses
// (`@repo/ai/lib/output-token-budget`, `@repo/ai/skills`) do not re-enter this
// barrel, so they keep loading for real.
vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: {},
	embed: (...args: unknown[]) => mocks.embed(...args),
	getAIEmbeddingModelWithMetadata: (...args: unknown[]) =>
		mocks.getAIEmbeddingModelWithMetadata(...args),
	getAIModelWithMetadata: vi.fn(),
	getSystemRAGProviderConfig: vi.fn(),
	logEmbeddingUsageAsync: (...args: unknown[]) =>
		mocks.logEmbeddingUsageAsync(...args),
	logModelUsageAsync: vi.fn(),
	streamText: vi.fn(),
}));

vi.mock("@repo/rag", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/rag")>();
	return {
		...actual,
		// `extractBaseContextId` is intentionally NOT mocked — collapsing
		// `<id>-chunk-N` to `<id>` is the behavior the exclusion rides on.
		searchSimilarProjectContexts: (...args: unknown[]) =>
			mocks.searchSimilarProjectContexts(...args),
		applyContextSummary: (...args: unknown[]) =>
			mocks.applyContextSummary(...args),
		rerankContexts: (...args: unknown[]) => mocks.rerankContexts(...args),
	};
});

const { retrieveProjectContexts } = await import(
	"../project-document-generation"
);

const PARAMS = {
	projectId: "proj_1",
	userId: "user_1",
	organizationId: "org_1",
	documentType: "PRD",
};

/** The `where.id.in` list the database fetch was asked for. */
function requestedContextIds(): string[] {
	const call = mocks.findMany.mock.calls[0]?.[0] as
		| { where: { id: { in: string[] } } }
		| undefined;
	return call?.where.id.in ?? [];
}

beforeEach(() => {
	vi.clearAllMocks();

	mocks.getProjectRagSettings.mockResolvedValue({
		topK: 10,
		similarityThreshold: 0.5,
		// Off so the ranked list reaches the assertions unshuffled; reranking
		// is orthogonal to the exclusion.
		enableReranking: false,
		rerankTopK: 10,
		rerankerProvider: "cross-encoder",
	});
	mocks.getAIEmbeddingModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { modelString: "test-embedding", provider: "test" },
		trackUsage: vi.fn(),
	});
	mocks.embed.mockResolvedValue({
		embedding: [0.1, 0.2, 0.3],
		usage: { tokens: 7 },
	});
	// Context summarization is a separate feature; pass the list through.
	mocks.applyContextSummary.mockImplementation(
		async (contexts: unknown) => contexts,
	);
	mocks.findMany.mockImplementation(
		async ({ where }: { where: { id: { in: string[] } } }) =>
			where.id.in.map((id) => ({
				id,
				content: `content of ${id}`,
				type: "TEXT",
				metadata: null,
				originalFilename: null,
				sourceUrl: null,
				sourceTitle: null,
			})),
	);
});

describe("retrieveProjectContexts exclusion", () => {
	it("drops every chunk of the excluded context and keeps the rest", async () => {
		mocks.searchSimilarProjectContexts.mockResolvedValue([
			{ contextId: "ctx_just_created-chunk-0", score: 0.94 },
			{ contextId: "ctx_older-chunk-0", score: 0.81 },
			// A second chunk of the same excluded row: an exclusion matched
			// against the raw payload id would let this one straight through.
			{ contextId: "ctx_just_created-chunk-7", score: 0.77 },
		]);

		const contexts = await retrieveProjectContexts({
			...PARAMS,
			excludeContextId: "ctx_just_created",
		});

		expect(requestedContextIds()).toEqual(["ctx_older"]);
		expect(contexts).toEqual(["content of ctx_older"]);
	});

	it("excludes an unchunked row by its own id", async () => {
		mocks.searchSimilarProjectContexts.mockResolvedValue([
			{ contextId: "ctx_just_created", score: 0.9 },
			{ contextId: "ctx_older", score: 0.6 },
		]);

		const contexts = await retrieveProjectContexts({
			...PARAMS,
			excludeContextId: "ctx_just_created",
		});

		expect(contexts).toEqual(["content of ctx_older"]);
	});

	it("returns nothing rather than the excluded row when it was the only hit", async () => {
		mocks.searchSimilarProjectContexts.mockResolvedValue([
			{ contextId: "ctx_just_created-chunk-0", score: 0.99 },
		]);

		const contexts = await retrieveProjectContexts({
			...PARAMS,
			excludeContextId: "ctx_just_created",
		});

		// The run is not left context-less in practice — the same text is being
		// delivered to it directly, which is why it was excluded here.
		expect(contexts).toEqual([]);
		expect(mocks.findMany).not.toHaveBeenCalled();
	});

	it("retrieves everything when no exclusion is asked for", async () => {
		mocks.searchSimilarProjectContexts.mockResolvedValue([
			{ contextId: "ctx_a-chunk-0", score: 0.9 },
			{ contextId: "ctx_b-chunk-0", score: 0.8 },
		]);

		const contexts = await retrieveProjectContexts(PARAMS);

		expect(requestedContextIds()).toEqual(["ctx_a", "ctx_b"]);
		expect(contexts).toEqual(["content of ctx_a", "content of ctx_b"]);
	});

	it("excludes nothing when the id matches no retrieved context", async () => {
		mocks.searchSimilarProjectContexts.mockResolvedValue([
			{ contextId: "ctx_a-chunk-0", score: 0.9 },
			{ contextId: "ctx_b-chunk-0", score: 0.8 },
		]);

		const contexts = await retrieveProjectContexts({
			...PARAMS,
			excludeContextId: "ctx_not_retrieved",
		});

		expect(contexts).toEqual(["content of ctx_a", "content of ctx_b"]);
	});
});
