import { UnsupportedEmbeddingModelError } from "@repo/ai/lib/embedding-dimensions";
/**
 * `reembedProjectContext`: the new points are written before any old one is
 * removed.
 *
 * It used to delete the context's points and then embed, so a failed embed —
 * a provider outage, or a model whose vectors the collection cannot hold —
 * left the context with no vectors at all. Old points are now snapshotted,
 * the new ones written, and only the old ids the new embed did not overwrite
 * are deleted, and only once it succeeded.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	assertEmbeddingModelUsable: vi.fn(),
	storeProjectContext: vi.fn(),
	listProjectContextPointIds: vi.fn(),
	deleteProjectContextPoints: vi.fn(),
	deleteProjectContext: vi.fn(),
	generateEmbedding: vi.fn(),
	chunkText: vi.fn(),
	enrichChunksWithTenantContext: vi.fn(),
	routeContentForChunking: vi.fn(),
	getProjectRagSettings: vi.fn(),
	markContextAsEmbedded: vi.fn(),
	setContextEnrichmentRetryAt: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	assertEmbeddingModelUsable: mocks.assertEmbeddingModelUsable,
}));

vi.mock("../store", () => ({
	storeProjectContext: mocks.storeProjectContext,
	listProjectContextPointIds: mocks.listProjectContextPointIds,
	deleteProjectContextPoints: mocks.deleteProjectContextPoints,
	deleteProjectContext: mocks.deleteProjectContext,
}));

vi.mock("../../company-contexts/store", () => ({
	storeCompanyContextPoints: vi.fn(),
}));

vi.mock("../../embedding", () => ({
	generateEmbedding: mocks.generateEmbedding,
	generateEmbeddings: vi.fn(),
}));

vi.mock("../../chunking", () => ({
	chunkDescribedOpenApiSpec: vi.fn(),
	chunkText: mocks.chunkText,
	detectContentType: vi.fn(() => ({ type: "text" })),
	enrichChunksWithTenantContext: mocks.enrichChunksWithTenantContext,
	routeContentForChunking: mocks.routeContentForChunking,
}));

vi.mock("@repo/database", () => ({
	getOrganizationRagSettings: vi.fn(),
	getProjectRagSettings: mocks.getProjectRagSettings,
	getDefaultRagSettings: vi.fn(),
	markContextAsEmbedded: mocks.markContextAsEmbedded,
	setContextEnrichmentRetryAt: mocks.setContextEnrichmentRetryAt,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	batchEmbedContexts,
	embedProjectContext,
	reembedProjectContext,
} from "../auto-embed";

const ORG = "org-1";
const SHORT = "A short context.";
const LONG = "A long context paragraph. ".repeat(200);

function options(content: string) {
	return {
		contextId: "ctx-1",
		projectId: "proj-1",
		userId: "user-1",
		organizationId: ORG,
		content,
		type: "TEXT",
		apiKey: { apiKey: "test-key", provider: "OPENAI_DIRECT" },
	};
}

function chunks(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		index,
		content: `part ${index}`,
		metadata: { headings: [], section: undefined },
	}));
}

/** Point id the store would derive — one per stored `contextId`. */
function pointFor(storedContextId: string) {
	return `pt:${storedContextId}`;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.assertEmbeddingModelUsable.mockResolvedValue(undefined);
	mocks.routeContentForChunking.mockResolvedValue({ kind: "text" });
	mocks.getProjectRagSettings.mockResolvedValue({
		chunkSize: 3000,
		chunkOverlap: 500,
		splitMethod: "DOCUMENT",
	});
	mocks.enrichChunksWithTenantContext.mockImplementation(
		async (input: Array<{ index: number; content: string }>) =>
			input.map((chunk) => ({
				...chunk,
				enrichedContent: chunk.content,
				originalContent: chunk.content,
			})),
	);
	mocks.generateEmbedding.mockResolvedValue({
		embedding: [0.1, 0.2],
		model: "text-embedding-3-small",
		tokens: 4,
	});
	mocks.storeProjectContext.mockImplementation(
		async ({ contextId }: { contextId: string }) => pointFor(contextId),
	);
	mocks.deleteProjectContextPoints.mockResolvedValue(undefined);
});

describe("reembedProjectContext", () => {
	it("deletes nothing when every embed fails", async () => {
		mocks.listProjectContextPointIds.mockResolvedValue([
			pointFor("ctx-1-chunk-0"),
			pointFor("ctx-1-chunk-1"),
		]);
		mocks.chunkText.mockReturnValue(chunks(3));
		mocks.storeProjectContext.mockRejectedValue(
			new Error("Wrong input: Vector dimension error"),
		);

		const result = await reembedProjectContext(options(LONG));

		expect(result.success).toBe(false);
		expect(mocks.deleteProjectContextPoints).not.toHaveBeenCalled();
		expect(mocks.deleteProjectContext).not.toHaveBeenCalled();
	});

	it("deletes nothing when the single-chunk embed fails", async () => {
		mocks.listProjectContextPointIds.mockResolvedValue([pointFor("ctx-1")]);
		mocks.generateEmbedding.mockRejectedValue(new Error("provider outage"));

		const result = await reembedProjectContext(options(SHORT));

		expect(result).toEqual({ success: false, error: "provider outage" });
		expect(mocks.deleteProjectContextPoints).not.toHaveBeenCalled();
		expect(mocks.deleteProjectContext).not.toHaveBeenCalled();
	});

	it("does not embed when the old points cannot be listed", async () => {
		mocks.listProjectContextPointIds.mockRejectedValue(
			new Error("qdrant unavailable"),
		);

		const result = await reembedProjectContext(options(LONG));

		expect(result).toEqual({ success: false, error: "qdrant unavailable" });
		expect(mocks.storeProjectContext).not.toHaveBeenCalled();
		expect(mocks.deleteProjectContextPoints).not.toHaveBeenCalled();
	});

	it("removes only the old points the new embed did not overwrite", async () => {
		mocks.listProjectContextPointIds.mockResolvedValue(
			[0, 1, 2, 3, 4].map((i) => pointFor(`ctx-1-chunk-${i}`)),
		);
		mocks.chunkText.mockReturnValue(chunks(3));

		const result = await reembedProjectContext(options(LONG));

		expect(result.success).toBe(true);
		expect(result.pointIds).toEqual(
			[0, 1, 2].map((i) => pointFor(`ctx-1-chunk-${i}`)),
		);
		expect(mocks.deleteProjectContextPoints).toHaveBeenCalledTimes(1);
		expect(mocks.deleteProjectContextPoints).toHaveBeenCalledWith(
			[pointFor("ctx-1-chunk-3"), pointFor("ctx-1-chunk-4")],
			ORG,
		);
		// Snapshot before the first write; delete only after the last.
		expect(
			mocks.listProjectContextPointIds.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.storeProjectContext.mock.invocationCallOrder[0]);
		expect(
			mocks.storeProjectContext.mock.invocationCallOrder.at(-1),
		).toBeLessThan(
			mocks.deleteProjectContextPoints.mock.invocationCallOrder[0],
		);
	});

	it("removes the base point when a single-chunk context now chunks", async () => {
		mocks.listProjectContextPointIds.mockResolvedValue([pointFor("ctx-1")]);
		mocks.chunkText.mockReturnValue(chunks(2));

		await reembedProjectContext(options(LONG));

		expect(mocks.deleteProjectContextPoints).toHaveBeenCalledWith(
			[pointFor("ctx-1")],
			ORG,
		);
	});

	it("removes the stale chunks when a chunked context shrinks to one point", async () => {
		mocks.listProjectContextPointIds.mockResolvedValue([
			pointFor("ctx-1"),
			pointFor("ctx-1-chunk-0"),
			pointFor("ctx-1-chunk-1"),
		]);

		const result = await reembedProjectContext(options(SHORT));

		expect(result.pointIds).toEqual([pointFor("ctx-1")]);
		expect(mocks.deleteProjectContextPoints).toHaveBeenCalledWith(
			[pointFor("ctx-1-chunk-0"), pointFor("ctx-1-chunk-1")],
			ORG,
		);
	});
});

describe("embedProjectContext — enrichment owed after a spent ChatGPT plan (Fizzy #2770)", () => {
	beforeEach(() => {
		mocks.listProjectContextPointIds.mockResolvedValue([]);
		mocks.chunkText.mockReturnValue(chunks(3));
	});

	it("records the plan's reset on the row when chunks were stored unenriched", async () => {
		const resetAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
		mocks.enrichChunksWithTenantContext.mockImplementation(
			async (
				input: Array<{ index: number; content: string }>,
				opts: {
					onEnrichmentDeferred?: (d: {
						resetAt: Date | null;
						unenrichedCount: number;
					}) => void;
				},
			) => {
				opts.onEnrichmentDeferred?.({
					resetAt,
					unenrichedCount: input.length,
				});
				return input.map((chunk) => ({
					...chunk,
					enrichedContent: chunk.content,
					originalContent: chunk.content,
				}));
			},
		);

		const result = await reembedProjectContext(options(LONG));

		expect(result.success).toBe(true);
		expect(mocks.setContextEnrichmentRetryAt).toHaveBeenCalledWith(
			"ctx-1",
			resetAt,
		);
	});

	it("falls back to a backoff when the plan named no reset", async () => {
		mocks.enrichChunksWithTenantContext.mockImplementation(
			async (
				input: Array<{ index: number; content: string }>,
				opts: {
					onEnrichmentDeferred?: (d: {
						resetAt: Date | null;
						unenrichedCount: number;
					}) => void;
				},
			) => {
				opts.onEnrichmentDeferred?.({
					resetAt: null,
					unenrichedCount: input.length,
				});
				return input.map((chunk) => ({
					...chunk,
					enrichedContent: chunk.content,
					originalContent: chunk.content,
				}));
			},
		);
		const before = Date.now();

		await reembedProjectContext(options(LONG));

		const retryAt = mocks.setContextEnrichmentRetryAt.mock
			.calls[0][1] as Date;
		expect(retryAt.getTime()).toBeGreaterThan(before + 30 * 60 * 1000);
	});

	it("clears the marker when every chunk was enriched", async () => {
		await reembedProjectContext(options(LONG));

		expect(mocks.setContextEnrichmentRetryAt).toHaveBeenCalledWith(
			"ctx-1",
			null,
		);
	});

	it("records nothing when the embed fails", async () => {
		mocks.storeProjectContext.mockRejectedValue(new Error("qdrant down"));

		await reembedProjectContext(options(LONG));

		expect(mocks.setContextEnrichmentRetryAt).not.toHaveBeenCalled();
	});
});

it.each([
	["single", SHORT],
	["chunked", LONG],
])("preserves a refusal through %s re-embedding", async (_label, content) => {
	const error = new UnsupportedEmbeddingModelError("databricks-gte-large-en");
	mocks.generateEmbedding.mockRejectedValue(error);
	await expect(reembedProjectContext(options(content))).resolves.toEqual({
		success: false,
		error: error.message,
		refusal: error,
	});
	expect(mocks.deleteProjectContextPoints).not.toHaveBeenCalled();
});

it.each([
	["single", SHORT],
	["chunked", LONG],
])(
	"returns a typed refusal from %s embedding without throwing",
	async (_label, content) => {
		const error = new UnsupportedEmbeddingModelError(
			"databricks-gte-large-en",
		);
		mocks.generateEmbedding.mockRejectedValue(error);
		const result = await embedProjectContext(options(content));
		expect(result).toEqual({
			success: false,
			error: error.message,
			refusal: error,
		});
		expect(result.refusal).toBe(error);
		expect(mocks.storeProjectContext).not.toHaveBeenCalled();
	},
);
it("returns refusal results from a batch without rejecting the batch", async () => {
	const error = new UnsupportedEmbeddingModelError("unknown-embedding");
	mocks.generateEmbedding.mockRejectedValue(error);
	await expect(
		batchEmbedContexts([options(SHORT), options(SHORT)]),
	).resolves.toEqual([
		{ success: false, error: error.message, refusal: error },
		{ success: false, error: error.message, refusal: error },
	]);
});

it("a refused chunked re-embed returns refusal and preserves previous points without enrichment", async () => {
	const refusal = new UnsupportedEmbeddingModelError(
		"text-embedding-3-large",
	);
	mocks.assertEmbeddingModelUsable.mockRejectedValue(refusal);
	mocks.generateEmbedding.mockRejectedValue(refusal);
	mocks.listProjectContextPointIds.mockResolvedValue([pointFor("ctx-1")]);
	mocks.chunkText.mockReturnValue(chunks(2));
	const result = await reembedProjectContext(options(LONG));
	expect(result).toEqual({ success: false, error: refusal.message, refusal });
	expect(mocks.enrichChunksWithTenantContext).not.toHaveBeenCalled();
	expect(mocks.deleteProjectContextPoints).not.toHaveBeenCalled();
});
