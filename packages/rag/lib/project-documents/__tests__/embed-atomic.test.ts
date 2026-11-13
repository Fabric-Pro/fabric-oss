import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	clearDocumentEmbedding: vi.fn(),
	markProjectDocumentChunkingVersion: vi.fn(),
	chunkText: vi.fn(),
	isContentAwareChunkingActive: vi.fn(),
	chunkProjectContent: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	getProjectRagSettings: vi.fn(),
	markDocumentAsEmbedded: vi.fn(),
	markDocumentAsEmbeddedIfVersionUnchanged: vi.fn(),
	get generateQueryEmbedding() {
		return (this as { generateEmbedding: unknown }).generateEmbedding;
	},
	generateEmbedding: vi.fn(),
	generateEmbeddings: vi.fn(),
	storeProjectContext: vi.fn(),
	deleteProjectContext: vi.fn(),
	listProjectContextPointIds: vi.fn().mockResolvedValue(["old"]),
	deleteProjectContextPoints: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	clearDocumentEmbedding: mocks.clearDocumentEmbedding,
	markProjectDocumentChunkingVersion:
		mocks.markProjectDocumentChunkingVersion,
	getProjectRagSettings: mocks.getProjectRagSettings,
	markDocumentAsEmbedded: mocks.markDocumentAsEmbedded,
	markDocumentAsEmbeddedIfVersionUnchanged:
		mocks.markDocumentAsEmbeddedIfVersionUnchanged,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: mocks.warn,
		error: mocks.error,
		debug: vi.fn(),
	},
}));

// Keep chunk counts controllable without loading provider integrations.
vi.mock("../../chunking", () => ({
	CHUNKING_THRESHOLD: 2048,
	chunkText: mocks.chunkText,
	detectContentType: () => ({ type: "text" }),
	isContentAwareChunkingActive: mocks.isContentAwareChunkingActive,
	chunkProjectContent: mocks.chunkProjectContent,
	contentKindForDocumentType: () => "document",
	isChunkProfile: () => false,
	parseChunkProfilesConfig: () => ({}),
}));

vi.mock("../../chunking/tokenizer", () => ({
	countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
	charsToTokensEstimate: vi.fn((chars: number) => Math.ceil(chars / 4)),
}));

vi.mock("../../embedding", () => ({
	get generateQueryEmbedding() {
		return (this as { generateEmbedding: unknown }).generateEmbedding;
	},
	generateEmbedding: mocks.generateEmbedding,
	generateEmbeddings: mocks.generateEmbeddings,
}));

vi.mock("../../project-contexts/store", () => ({
	storeProjectContext: mocks.storeProjectContext,
	deleteProjectContext: mocks.deleteProjectContext,
	listProjectContextPointIds: mocks.listProjectContextPointIds,
	deleteProjectContextPoints: mocks.deleteProjectContextPoints,
}));

import { generatePointId } from "../../utils/point-id";
import { embedProjectDocument, reembedProjectDocument } from "../embed";

function makeChunks(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		index,
		content: `chunk ${index}`,
		metadata: {},
	}));
}
const options = {
	documentId: "example-doc",
	projectId: "example-project",
	userId: "example-user",
	organizationId: "example-org",
	content: "a".repeat(3000),
	documentType: "PRD",
	title: "Example",
	apiKey: "example",
	expectedVersion: 2,
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.chunkText.mockReturnValue(makeChunks(26));
	mocks.isContentAwareChunkingActive.mockResolvedValue(false);
	mocks.listProjectContextPointIds.mockResolvedValue(["old"]);
	mocks.getProjectRagSettings.mockResolvedValue({
		chunkSize: 400,
		chunkOverlap: 0,
		splitMethod: "PARAGRAPH",
	});
	mocks.generateEmbeddings.mockImplementation(async (texts: string[]) => ({
		embeddings: texts.map(() => [1]),
	}));
	mocks.storeProjectContext.mockImplementation(
		async ({ contextId }: { contextId: string }) => contextId,
	);
	mocks.markDocumentAsEmbeddedIfVersionUnchanged.mockResolvedValue({
		updated: true,
	});
});
function untouched() {
	expect(mocks.storeProjectContext).not.toHaveBeenCalled();
	expect(mocks.deleteProjectContext).not.toHaveBeenCalled();
	expect(mocks.deleteProjectContextPoints).not.toHaveBeenCalled();
	expect(mocks.clearDocumentEmbedding).not.toHaveBeenCalled();
	expect(
		mocks.markDocumentAsEmbeddedIfVersionUnchanged,
	).not.toHaveBeenCalled();
}
describe("atomic document embedding", () => {
	for (const failure of ["later batch", "empty", "missing", "count"]) {
		it(`rejects ${failure} before writing`, async () => {
			if (failure === "later batch") {
				mocks.generateEmbeddings
					.mockImplementationOnce(async (texts: string[]) => ({
						embeddings: texts.map(() => [1]),
					}))
					.mockRejectedValueOnce(new Error("provider down"));
			} else {
				mocks.generateEmbeddings.mockImplementationOnce(
					async (texts: string[]) => ({
						embeddings:
							failure === "count"
								? [[1]]
								: texts.map((_, i) =>
										i === 0
											? failure === "empty"
												? []
												: undefined
											: [1],
									),
					}),
				);
			}
			expect((await embedProjectDocument(options)).success).toBe(false);
			untouched();
		});
	}
	it("preserves old points on reembed provider failure", async () => {
		mocks.generateEmbeddings
			.mockImplementationOnce(async (texts: string[]) => ({
				embeddings: texts.map(() => [1]),
			}))
			.mockRejectedValueOnce(new Error("down"));
		expect(
			(await reembedProjectDocument(options, "old-hash")).success,
		).toBe(false);
		untouched();
	});
	it("removes only stale points after success", async () => {
		const result = await reembedProjectDocument(options, "old-hash");
		expect(result.success).toBe(true);
		expect(mocks.deleteProjectContext).not.toHaveBeenCalled();
		expect(mocks.clearDocumentEmbedding).not.toHaveBeenCalled();
		expect(mocks.deleteProjectContextPoints).toHaveBeenCalledWith(
			["old"],
			"example-org",
		);
	});
	it("reports supersession without stale deletion", async () => {
		mocks.markDocumentAsEmbeddedIfVersionUnchanged.mockResolvedValueOnce({
			updated: false,
		});
		expect(await reembedProjectDocument(options, "old-hash")).toMatchObject(
			{ success: true, superseded: true },
		);
		expect(mocks.deleteProjectContextPoints).not.toHaveBeenCalled();
	});
	it("rolls back successful writes after a write failure", async () => {
		mocks.listProjectContextPointIds.mockResolvedValue([
			"doc-example-doc-v2-chunk-2",
		]);
		mocks.storeProjectContext.mockRejectedValueOnce(
			new Error("write down"),
		);
		expect(
			(await reembedProjectDocument(options, "old-hash")).success,
		).toBe(false);
		expect(mocks.deleteProjectContextPoints).toHaveBeenCalledWith(
			expect.arrayContaining(["doc-example-doc-v2-chunk-1"]),
			"example-org",
		);
		expect(mocks.deleteProjectContextPoints.mock.calls[0][0]).not.toContain(
			"doc-example-doc-v2-chunk-2",
		);
		expect(
			mocks.markDocumentAsEmbeddedIfVersionUnchanged,
		).not.toHaveBeenCalled();
	});
	it("fails closed when the snapshot fails", async () => {
		mocks.listProjectContextPointIds.mockRejectedValueOnce(
			new Error("snapshot down"),
		);
		expect((await reembedProjectDocument(options, "old")).success).toBe(
			false,
		);
		expect(mocks.generateEmbeddings).not.toHaveBeenCalled();
		untouched();
	});
	it("keeps success when final cleanup fails", async () => {
		mocks.deleteProjectContextPoints.mockRejectedValueOnce(
			new Error("delete down"),
		);
		expect((await reembedProjectDocument(options, "old")).success).toBe(
			true,
		);
		expect(
			mocks.markDocumentAsEmbeddedIfVersionUnchanged,
		).toHaveBeenCalled();
	});
	it("rolls back on cancellation at a write boundary", async () => {
		const controller = new AbortController();
		mocks.storeProjectContext.mockImplementation(
			async ({ contextId }: { contextId: string }) => {
				controller.abort();
				return contextId;
			},
		);
		expect(
			await embedProjectDocument({
				...options,
				abortSignal: controller.signal,
			}),
		).toMatchObject({ success: false, superseded: true });
		expect(mocks.storeProjectContext).toHaveBeenCalledTimes(5);
		expect(mocks.deleteProjectContextPoints).toHaveBeenCalledWith(
			expect.arrayContaining(["doc-example-doc-v2-chunk-0"]),
			"example-org",
		);
		expect(
			mocks.markDocumentAsEmbeddedIfVersionUnchanged,
		).not.toHaveBeenCalled();
	});
	it("does not delete preexisting unversioned ids during rollback", async () => {
		mocks.listProjectContextPointIds.mockResolvedValueOnce([
			"doc-example-doc-chunk-1",
		]);
		mocks.storeProjectContext.mockRejectedValueOnce(new Error("down"));
		expect(
			(
				await embedProjectDocument({
					...options,
					expectedVersion: undefined,
				})
			).success,
		).toBe(false);
		expect(mocks.deleteProjectContextPoints.mock.calls[0][0]).not.toContain(
			"doc-example-doc-chunk-1",
		);
		expect(mocks.deleteProjectContextPoints.mock.calls[0][0]).toContain(
			"doc-example-doc-chunk-2",
		);
	});
	it("rejects an empty single vector before writing", async () => {
		mocks.generateEmbedding.mockResolvedValueOnce({ embedding: [] });
		expect(
			(await embedProjectDocument({ ...options, content: "short" }))
				.success,
		).toBe(false);
		untouched();
	});
	it("reports single chunk version drift", async () => {
		mocks.generateEmbedding.mockResolvedValueOnce({ embedding: [1] });
		mocks.markDocumentAsEmbeddedIfVersionUnchanged.mockResolvedValueOnce({
			updated: false,
		});
		expect(
			await reembedProjectDocument(
				{ ...options, content: "short" },
				"old",
			),
		).toMatchObject({ success: true, superseded: true });
		expect(mocks.deleteProjectContextPoints).not.toHaveBeenCalled();
	});
	it("keeps a failed result when rollback also fails", async () => {
		mocks.storeProjectContext.mockRejectedValueOnce(
			new Error("write down"),
		);
		mocks.deleteProjectContextPoints.mockRejectedValueOnce(
			new Error("rollback down"),
		);
		expect(await embedProjectDocument(options)).toMatchObject({
			success: false,
			error: "Chunk 0: write down",
		});
		expect(mocks.warn).toHaveBeenCalledWith(
			"[DocumentEmbed] Failed to roll back new points",
			{ error: expect.objectContaining({ message: "rollback down" }) },
		);
		expect(
			mocks.markDocumentAsEmbeddedIfVersionUnchanged,
		).not.toHaveBeenCalled();
		expect(mocks.deleteProjectContextPoints).toHaveBeenCalled();
	});
	for (const mode of ["short", "one chunk", "multiple chunks"]) {
		it(`preserves independently computed written ids for ${mode}`, async () => {
			const count = mode === "multiple chunks" ? 3 : 1;
			mocks.chunkText.mockReturnValue(makeChunks(count));
			mocks.generateEmbedding.mockResolvedValue({ embedding: [1] });
			const contextIds =
				count === 1
					? ["doc-example-doc-v2"]
					: [
							"doc-example-doc-v2-chunk-0",
							"doc-example-doc-v2-chunk-1",
							"doc-example-doc-v2-chunk-2",
						];
			const expectedIds = contextIds.map((id) => generatePointId(id));
			mocks.listProjectContextPointIds.mockResolvedValue([
				...expectedIds,
				"stale-point",
			]);
			mocks.storeProjectContext.mockImplementation(
				async ({ contextId }: { contextId: string }) =>
					generatePointId(contextId),
			);
			const result = await reembedProjectDocument(
				{
					...options,
					content: mode === "short" ? "short" : options.content,
				},
				"old",
			);
			expect(result).toMatchObject({
				success: true,
				chunksCreated: count,
			});
			expect(
				mocks.storeProjectContext.mock.calls.map(
					([input]) => input.contextId,
				),
			).toEqual(contextIds);
			const written = await Promise.all(
				mocks.storeProjectContext.mock.results.map((r) => r.value),
			);
			expect(written).toEqual(expectedIds);
			expect(
				mocks.deleteProjectContextPoints,
			).toHaveBeenCalledExactlyOnceWith(["stale-point"], "example-org");
			for (const id of written) {
				expect(
					mocks.deleteProjectContextPoints.mock.calls[0][0],
				).not.toContain(id);
			}
		});
	}
	it("rolls back cancellation during the final write window without stale deletion", async () => {
		mocks.chunkText.mockReturnValue(makeChunks(6));
		const controller = new AbortController();
		mocks.storeProjectContext.mockImplementation(
			async ({ contextId }: { contextId: string }) => {
				if (contextId.endsWith("-5")) {
					controller.abort();
				}
				return contextId;
			},
		);
		expect(
			await reembedProjectDocument(
				{ ...options, abortSignal: controller.signal },
				"old",
			),
		).toMatchObject({ success: false, superseded: true });
		expect(mocks.storeProjectContext).toHaveBeenCalledTimes(6);
		expect(
			mocks.markDocumentAsEmbeddedIfVersionUnchanged,
		).not.toHaveBeenCalled();
		expect(mocks.markDocumentAsEmbedded).not.toHaveBeenCalled();
		expect(
			mocks.deleteProjectContextPoints,
		).toHaveBeenCalledExactlyOnceWith(
			Array.from(
				{ length: 6 },
				(_, i) => `doc-example-doc-v2-chunk-${i}`,
			),
			"example-org",
		);
	});
	it("does not stamp chunking version when content-aware embedding is superseded", async () => {
		mocks.isContentAwareChunkingActive.mockResolvedValue(true);
		mocks.chunkProjectContent.mockResolvedValue({
			chunks: makeChunks(1),
			chunkPayloads: [{}],
		});
		mocks.getProjectRagSettings.mockResolvedValue({
			chunkSize: 400,
			chunkOverlap: 0,
			splitMethod: "PARAGRAPH",
			chunkingVersion: 2,
		});
		mocks.markDocumentAsEmbeddedIfVersionUnchanged.mockResolvedValue({
			updated: false,
		});
		expect(await reembedProjectDocument(options, "old")).toMatchObject({
			success: true,
			superseded: true,
		});
		expect(mocks.markProjectDocumentChunkingVersion).not.toHaveBeenCalled();
		expect(mocks.deleteProjectContextPoints).not.toHaveBeenCalled();
	});
	it("skips the write snapshot after cancellation during embedding", async () => {
		const controller = new AbortController();
		mocks.generateEmbeddings.mockImplementation(async (texts: string[]) => {
			controller.abort();
			return { embeddings: texts.map(() => [1]) };
		});
		expect(
			await embedProjectDocument({
				...options,
				abortSignal: controller.signal,
			}),
		).toMatchObject({ success: false, superseded: true });
		expect(mocks.listProjectContextPointIds).not.toHaveBeenCalled();
		untouched();
	});
	for (const bad of ["count", "empty"]) {
		it(`reports detailed ${bad} failure`, async () => {
			mocks.generateEmbeddings.mockResolvedValue({
				embeddings:
					bad === "count"
						? [[1]]
						: Array.from({ length: 25 }, (_, i) =>
								i === 3 ? [] : [1],
							),
			});
			const detail =
				bad === "count"
					? "Embedding count mismatch: expected 25, got 1"
					: "Chunk 3: Empty embedding result";
			expect(await embedProjectDocument(options)).toMatchObject({
				success: false,
				error: detail,
			});
			expect(mocks.error).toHaveBeenCalledWith(
				`[DocumentEmbed] ${detail}`,
			);
			untouched();
		});
	}
});
