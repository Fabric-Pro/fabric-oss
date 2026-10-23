import {
	AIProviderNotConfiguredError,
	assertEmbeddingModelUsable,
	getSystemEmbeddingRAGProviderConfig,
} from "@repo/ai";
import { UnsupportedEmbeddingModelError } from "@repo/ai/lib/embedding-dimensions";
import {
	db,
	getOrCreateRagSettings,
	updateWorkspaceDocument,
} from "@repo/database";
import {
	chunkText,
	deleteWorkspaceDocumentChunks,
	enrichChunksWithTenantContext,
	extractionFactory,
	generateEmbeddings,
} from "@repo/rag";
import { downloadFile } from "@repo/storage";
import {
	ApplicationFailure,
	ensureApplicationFailure,
} from "@temporalio/common";
import { beforeEach, expect, it, vi } from "vitest";
import {
	processWorkspaceDocument,
	reprocessWorkspaceDocument,
} from "../src/activities/workspace-document-activities";

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {
		name = "AIProviderNotConfiguredError";
	},
	assertEmbeddingModelUsable: vi.fn(),
	getSystemEmbeddingRAGProviderConfig: vi
		.fn()
		.mockResolvedValue({ apiKey: "example-key" }),
}));
vi.mock("@repo/database", () => ({
	db: {
		workspaceDocument: { findFirst: vi.fn(), update: vi.fn() },
		workspaceDocumentChunk: { deleteMany: vi.fn() },
	},
	getOrCreateRagSettings: vi.fn(),
	updateWorkspaceDocument: vi.fn(),
	createDocumentChunks: vi.fn(),
	tenantWhere: vi.fn(() => ({ organizationId: "org-1" })),
}));
vi.mock("@repo/rag", () => ({
	chunkText: vi.fn(),
	enrichChunksWithTenantContext: vi.fn(
		async (chunks: Array<{ content: string }>) =>
			chunks.map((chunk) => ({
				...chunk,
				enrichedContent: chunk.content,
				originalContent: chunk.content,
			})),
	),
	extractionFactory: { extract: vi.fn() },
	generateEmbeddings: vi.fn(),
	storeWorkspaceChunksBatch: vi.fn(),
	deleteWorkspaceDocumentChunks: vi.fn(),
}));
vi.mock("@repo/storage", () => ({ downloadFile: vi.fn() }));

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(assertEmbeddingModelUsable)
		.mockReset()
		.mockResolvedValue(undefined);
	vi.mocked(generateEmbeddings).mockReset();
	vi.mocked(getSystemEmbeddingRAGProviderConfig)
		.mockReset()
		.mockResolvedValue({ apiKey: "example-key" } as never);
	vi.mocked(db.workspaceDocument.findFirst).mockResolvedValue({
		id: "doc-1",
		originalFilename: "example.txt",
		s3Path: "example.txt",
		s3Bucket: "example",
		mimeType: "text/plain",
	} as never);
	vi.mocked(getOrCreateRagSettings).mockResolvedValue({
		chunkSize: 512,
		chunkOverlap: 50,
	} as never);
	vi.mocked(downloadFile).mockResolvedValue({
		data: Buffer.from("Example content"),
	} as never);
	vi.mocked(extractionFactory.extract).mockResolvedValue({
		text: "Example content",
		extractorUsed: "local",
	} as never);
	vi.mocked(chunkText).mockReturnValue([
		{ index: 0, content: "Example content", metadata: {} },
	] as never);
});

const activities = [
	["process", processWorkspaceDocument],
	["reprocess", reprocessWorkspaceDocument],
] as const;
const refusals = [
	new UnsupportedEmbeddingModelError("text-embedding-3-large"),
	new AIProviderNotConfiguredError(
		"Configure an embedding provider in Settings.",
	),
];
for (const [label, activity] of activities) {
	for (const stage of ["precheck", "provider", "embed"] as const) {
		it.each(refusals)(
			`${label} preserves $name from ${stage} as a non-retryable configuration verdict`,
			async (refusal) => {
				const target =
					stage === "precheck"
						? assertEmbeddingModelUsable
						: stage === "provider"
							? getSystemEmbeddingRAGProviderConfig
							: generateEmbeddings;
				vi.mocked(target).mockRejectedValueOnce(refusal);
				const error = await activity(
					"doc-1",
					"workspace-1",
					"user-1",
					"org-1",
				).catch((error: unknown) => error);
				expect(error).toBeInstanceOf(ApplicationFailure);
				expect(error).toMatchObject({
					nonRetryable: true,
					type: refusal.name,
					message: refusal.message,
				});
				if (stage === "precheck") {
					expect(
						enrichChunksWithTenantContext,
					).not.toHaveBeenCalled();
					expect(assertEmbeddingModelUsable).toHaveBeenCalledWith({
						userId: "user-1",
						organizationId: "org-1",
					});
				}
				expect(updateWorkspaceDocument).not.toHaveBeenCalledWith(
					"doc-1",
					expect.objectContaining({ status: "FAILED" }),
				);
			},
		);
	}
	it(`keeps an ordinary ${label} embedding failure retryable`, async () => {
		vi.mocked(generateEmbeddings).mockRejectedValueOnce(
			new Error("Provider temporarily unavailable"),
		);
		const error = await activity(
			"doc-1",
			"workspace-1",
			"user-1",
			"org-1",
		).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(Error);
		expect(ensureApplicationFailure(error)).toMatchObject({
			nonRetryable: false,
			type: "Error",
			message: expect.stringContaining(
				"Provider temporarily unavailable",
			),
		});
	});
}

for (const [label, activity] of activities) {
	it.each(refusals)(
		`${label} refuses $name before download, extraction or document mutation`,
		async (refusal) => {
			vi.mocked(assertEmbeddingModelUsable).mockRejectedValueOnce(
				refusal,
			);
			const error = await activity(
				"doc-1",
				"workspace-1",
				"user-1",
				"org-1",
			).catch((error: unknown) => error);
			expect(error).toBeInstanceOf(ApplicationFailure);
			expect(error).toMatchObject({
				nonRetryable: true,
				type: refusal.name,
				message: refusal.message,
			});
			expect(downloadFile).not.toHaveBeenCalled();
			expect(extractionFactory.extract).not.toHaveBeenCalled();
			expect(getOrCreateRagSettings).not.toHaveBeenCalled();
			expect(deleteWorkspaceDocumentChunks).not.toHaveBeenCalled();
			expect(db.workspaceDocumentChunk.deleteMany).not.toHaveBeenCalled();
			expect(db.workspaceDocument.update).not.toHaveBeenCalled();
			expect(updateWorkspaceDocument).not.toHaveBeenCalled();
		},
	);
}
