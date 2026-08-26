/**
 * Unit tests for processProjectContext activity (bug #1039)
 *
 * Verifies that post-extraction failures (chunking, embedding, Qdrant upsert)
 * do NOT flip the DB extractionStatus from COMPLETED back to FAILED.
 *
 * Run with: pnpm --filter @repo/temporal test
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Track all calls to updateContextExtractionStatus so we can assert on them.
// vi.hoisted is required because the vi.mock factories below are themselves
// hoisted above module-level `const` declarations.
const { updateContextExtractionStatusMock, markContextAsEmbeddedMock } =
	vi.hoisted(() => ({
		updateContextExtractionStatusMock: vi.fn(),
		markContextAsEmbeddedMock: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		projectContext: {
			findFirst: vi.fn(),
			update: vi.fn(),
		},
	},
	updateContextExtractionStatus: updateContextExtractionStatusMock,
	markContextAsEmbedded: markContextAsEmbeddedMock,
}));

vi.mock("@repo/database/prisma/client", () => ({
	db: {
		projectContext: {
			findFirst: vi.fn(),
			update: vi.fn(),
		},
	},
}));

const getRAGProviderConfigMock = vi.fn();
vi.mock("@repo/ai", () => ({
	getRAGProviderConfig: getRAGProviderConfigMock,
}));

const extractMock = vi.fn();
const chunkProjectContentMock = vi.fn();
const generateEmbeddingsMock = vi.fn();
const storeProjectContextMock = vi.fn();
vi.mock("@repo/rag", () => ({
	extractionFactory: { extract: extractMock },
	chunkProjectContent: chunkProjectContentMock,
	generateEmbeddings: generateEmbeddingsMock,
	storeProjectContext: storeProjectContextMock,
}));

const downloadFileMock = vi.fn();
vi.mock("@repo/storage", () => ({
	downloadFile: downloadFileMock,
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

import { db } from "@repo/database";

const FAKE_CONTEXT_ID = "ctx-1039";
const FAKE_PROJECT_ID = "proj-1039";
const FAKE_USER_ID = "user-1039";
const FAKE_ORG_ID = "org-1039";

function setupHappyContext(mimeType = "text/csv") {
	(db.projectContext.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
		{
			id: FAKE_CONTEXT_ID,
			projectId: FAKE_PROJECT_ID,
			s3Path: "s3://bucket/ctx-1039.csv",
			s3Bucket: "bucket",
			mimeType,
			originalFilename: "Accounting (Repossessed).csv",
			type: "SPREADSHEET",
			sourceTitle: null,
			metadata: null,
		},
	);
	downloadFileMock.mockResolvedValue({ data: Buffer.from("a,b,c\n1,2,3\n") });
	extractMock.mockResolvedValue({
		text: "a,b,c\n1,2,3\n",
		extractorUsed: "local-text",
	});
	getRAGProviderConfigMock.mockResolvedValue({
		apiKey: "test-key",
		provider: "OPENAI_DIRECT",
		baseUrl: null,
	});
	// The activity now asks one shared router how to chunk rather than calling
	// `chunkText` itself, so the mock returns that router's shape. The status
	// transitions under test are unchanged by which chunker runs.
	chunkProjectContentMock.mockReturnValue({
		route: { kind: "text", strategy: "RECURSIVE" },
		chunks: [
			{
				content: "a,b,c\n1,2,3\n",
				index: 0,
				metadata: { filename: "x", startOffset: 0, endOffset: 11 },
			},
		],
		chunkPayloads: [{}],
	});
	generateEmbeddingsMock.mockResolvedValue({
		embeddings: [[0.1, 0.2, 0.3]],
	});
}

describe("processProjectContext - status transition correctness (bug #1039)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("preserves COMPLETED status when Qdrant store fails after extraction", async () => {
		setupHappyContext();
		// Qdrant upsert blows up (post-extraction failure)
		storeProjectContextMock.mockRejectedValue(
			new Error("Qdrant connection refused"),
		);

		const { processProjectContext } = await import(
			"../src/activities/project-context-processing"
		);

		const result = await processProjectContext(
			FAKE_CONTEXT_ID,
			FAKE_PROJECT_ID,
			FAKE_USER_ID,
			FAKE_ORG_ID,
		);

		// Activity must NOT throw — extraction succeeded, embedding is best-effort
		expect(result.success).toBe(true);
		expect(result.embedded).toBe(false);
		expect(result.embeddingError).toContain("Qdrant");

		// Confirm DB transitions: EXTRACTING (step 2) → COMPLETED (step 5).
		// Crucially, we must NEVER call with "FAILED" — that's the bug.
		const statusCalls = updateContextExtractionStatusMock.mock.calls.map(
			(call: unknown[]) => call[1],
		);
		expect(statusCalls).toContain("EXTRACTING");
		expect(statusCalls).toContain("COMPLETED");
		expect(statusCalls).not.toContain("FAILED");
	});

	it("preserves COMPLETED status when embedding generation fails", async () => {
		setupHappyContext();
		// Make the file big enough to trigger chunking + embedding path
		const bigText = "x,y,z\n".repeat(500);
		downloadFileMock.mockResolvedValue({ data: Buffer.from(bigText) });
		extractMock.mockResolvedValue({
			text: bigText,
			extractorUsed: "local-text",
		});
		chunkProjectContentMock.mockReturnValue({
			route: { kind: "text", strategy: "RECURSIVE" },
			chunks: Array.from({ length: 3 }, (_, i) => ({
				content: bigText.slice(i * 100, (i + 1) * 100),
				index: i,
				metadata: { filename: "x", startOffset: 0, endOffset: 100 },
			})),
			chunkPayloads: [{}, {}, {}],
		});
		generateEmbeddingsMock.mockRejectedValue(
			new Error("OpenAI rate limit exceeded"),
		);

		const { processProjectContext } = await import(
			"../src/activities/project-context-processing"
		);

		const result = await processProjectContext(
			FAKE_CONTEXT_ID,
			FAKE_PROJECT_ID,
			FAKE_USER_ID,
			FAKE_ORG_ID,
		);

		expect(result.success).toBe(true);
		expect(result.embedded).toBe(false);
		expect(result.embeddingError).toContain("OpenAI");

		const statusCalls = updateContextExtractionStatusMock.mock.calls.map(
			(call: unknown[]) => call[1],
		);
		expect(statusCalls).toContain("COMPLETED");
		expect(statusCalls).not.toContain("FAILED");
	});

	it("flips status to FAILED and rethrows when extraction itself fails", async () => {
		setupHappyContext("application/pdf");
		extractMock.mockRejectedValue(new Error("PDF parse error: bad header"));

		const { processProjectContext } = await import(
			"../src/activities/project-context-processing"
		);

		await expect(
			processProjectContext(
				FAKE_CONTEXT_ID,
				FAKE_PROJECT_ID,
				FAKE_USER_ID,
				FAKE_ORG_ID,
			),
		).rejects.toThrow();

		const statusCalls = updateContextExtractionStatusMock.mock.calls.map(
			(call: unknown[]) => call[1],
		);
		// FAILED is correct here — extraction never produced content
		expect(statusCalls).toContain("FAILED");
		// COMPLETED must NOT have been set, because extraction failed
		expect(statusCalls).not.toContain("COMPLETED");
	});

	it("partial Qdrant failures do not flip status to FAILED", async () => {
		setupHappyContext();
		// Force chunking path with multiple chunks
		const bigText = "x,y,z\n".repeat(500);
		downloadFileMock.mockResolvedValue({ data: Buffer.from(bigText) });
		extractMock.mockResolvedValue({
			text: bigText,
			extractorUsed: "local-text",
		});
		chunkProjectContentMock.mockReturnValue({
			route: { kind: "text", strategy: "RECURSIVE" },
			chunks: [
				{
					content: "chunk1",
					index: 0,
					metadata: { filename: "x", startOffset: 0, endOffset: 6 },
				},
				{
					content: "chunk2",
					index: 1,
					metadata: { filename: "x", startOffset: 6, endOffset: 12 },
				},
			],
			chunkPayloads: [{}, {}],
		});
		generateEmbeddingsMock.mockResolvedValue({
			embeddings: [
				[0.1, 0.2],
				[0.3, 0.4],
			],
		});
		// First chunk OK, second fails
		storeProjectContextMock
			.mockResolvedValueOnce("qdrant-id-1")
			.mockRejectedValueOnce(new Error("Qdrant transient error"));

		const { processProjectContext } = await import(
			"../src/activities/project-context-processing"
		);

		const result = await processProjectContext(
			FAKE_CONTEXT_ID,
			FAKE_PROJECT_ID,
			FAKE_USER_ID,
			FAKE_ORG_ID,
		);

		// Even with partial Qdrant failure, content is persisted → status stays COMPLETED
		expect(result.success).toBe(true);
		expect(result.embedded).toBe(false);

		const statusCalls = updateContextExtractionStatusMock.mock.calls.map(
			(call: unknown[]) => call[1],
		);
		expect(statusCalls).toContain("COMPLETED");
		expect(statusCalls).not.toContain("FAILED");
	});
});

describe("processProjectContext - empty extraction (#1684)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each([
		["empty string", ""],
		["whitespace only", "  \n\t \r\n "],
	])(
		"fails instead of completing when extraction yields %s",
		async (_label, text) => {
			setupHappyContext("text/html");
			// An SPA export is all <script>/<style>: it parses cleanly and
			// yields nothing.
			extractMock.mockResolvedValue({
				text,
				extractorUsed: "local-html",
			});

			const { processProjectContext } = await import(
				"../src/activities/project-context-processing"
			);

			const result = await processProjectContext(
				FAKE_CONTEXT_ID,
				FAKE_PROJECT_ID,
				FAKE_USER_ID,
				FAKE_ORG_ID,
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain("No readable text");

			const statusCalls =
				updateContextExtractionStatusMock.mock.calls.map(
					(call: unknown[]) => call[1],
				);
			expect(statusCalls).toContain("FAILED");
			// The whole point: an unretrievable row must never read COMPLETED.
			expect(statusCalls).not.toContain("COMPLETED");

			// Chunking and embedding must never run on empty text — the
			// embedding provider rejects [""] and that rejection is swallowed.
			expect(generateEmbeddingsMock).not.toHaveBeenCalled();
			expect(storeProjectContextMock).not.toHaveBeenCalled();
			expect(markContextAsEmbeddedMock).not.toHaveBeenCalled();
		},
	);
});
