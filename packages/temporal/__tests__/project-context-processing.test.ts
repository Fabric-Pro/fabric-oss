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
	// Content-type chunking off: the project default.
	getProjectChunkingSettings: vi.fn(async () => ({
		chunkByContentType: false,
		chunkProfiles: null,
		chunkingVersion: 0,
	})),
	markProjectContextChunkingVersion: vi.fn(),
}));

vi.mock("@repo/database/prisma/client", () => ({
	db: {
		projectContext: {
			findFirst: vi.fn(),
			update: vi.fn(),
		},
	},
}));

const getSystemEmbeddingRAGProviderConfigMock = vi.fn();
vi.mock("@repo/ai", () => ({
	getSystemEmbeddingRAGProviderConfig:
		getSystemEmbeddingRAGProviderConfigMock,
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
	usesPerTypeChunking: vi.fn(() => false),
}));

const downloadFileMock = vi.fn();
vi.mock("@repo/storage", () => ({
	downloadFile: downloadFileMock,
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

const { failGeneratingDocumentMock } = vi.hoisted(() => ({
	failGeneratingDocumentMock: vi.fn(),
}));
vi.mock("@repo/database/prisma/queries/projects/documents", () => ({
	failGeneratingDocument: failGeneratingDocumentMock,
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
	getSystemEmbeddingRAGProviderConfigMock.mockResolvedValue({
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

/**
 * The Documents-tab create flow records its pre-created document on the
 * context. When content is persisted and a later step throws, the activity
 * still returns a success, and that return must name the document like every
 * other success does, or the workflow creates a second one and leaves the
 * first on "generating". As-Is uploads return before any such step, so the
 * case is a tagged upload without that usage.
 */
describe("processProjectContext - post-extraction recovery keeps the target document", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns the target document and usage when embedding fails after the content is persisted", async () => {
		setupHappyContext();
		(
			db.projectContext.findFirst as ReturnType<typeof vi.fn>
		).mockResolvedValue({
			id: FAKE_CONTEXT_ID,
			projectId: FAKE_PROJECT_ID,
			s3Path: "s3://bucket/ctx-1039.csv",
			s3Bucket: "bucket",
			mimeType: "text/csv",
			originalFilename: "Accounting (Repossessed).csv",
			type: "SPREADSHEET",
			sourceTitle: null,
			metadata: {
				documentTag: "PRD",
				documentUsage: "CONTEXT",
				targetDocumentId: "doc-target",
			},
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
		expect(result.embeddingError).toContain("OpenAI");
		expect(result).toMatchObject({
			documentTag: "PRD",
			documentUsage: "CONTEXT",
			targetDocumentId: "doc-target",
		});
	});
});

describe("failContextTargetDocument", () => {
	const REASON =
		"The file could not be read, or contained no text. Try creating the document again with a different file.";
	const findContext = db.projectContext.findFirst as ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		failGeneratingDocumentMock.mockReset();
	});

	it("fails the context's pre-created document, held to the context's project", async () => {
		findContext
			.mockResolvedValueOnce({
				projectId: FAKE_PROJECT_ID,
				metadata: {
					documentTag: "PRD",
					targetDocumentId: "doc-target",
				},
			})
			// No other upload for the document is still running.
			.mockResolvedValueOnce(null);
		failGeneratingDocumentMock.mockResolvedValue(1);

		const { failContextTargetDocument } = await import(
			"../src/activities/project-context-processing"
		);
		const result = await failContextTargetDocument({
			contextId: FAKE_CONTEXT_ID,
			projectId: FAKE_PROJECT_ID,
			userId: FAKE_USER_ID,
			organizationId: FAKE_ORG_ID,
			reason: REASON,
		});

		expect(findContext).toHaveBeenCalledWith({
			where: {
				id: FAKE_CONTEXT_ID,
				projectId: FAKE_PROJECT_ID,
				organizationId: FAKE_ORG_ID,
			},
			select: { projectId: true, metadata: true },
		});
		expect(findContext).toHaveBeenLastCalledWith({
			where: {
				id: { not: FAKE_CONTEXT_ID },
				projectId: FAKE_PROJECT_ID,
				organizationId: FAKE_ORG_ID,
				extractionStatus: { in: ["PENDING", "EXTRACTING"] },
				metadata: { path: ["targetDocumentId"], equals: "doc-target" },
			},
			select: { id: true },
		});
		expect(failGeneratingDocumentMock).toHaveBeenCalledWith({
			documentId: "doc-target",
			reason: REASON,
			projectId: FAKE_PROJECT_ID,
		});
		expect(result).toEqual({ applied: true });
	});

	/**
	 * A second upload aimed at the same document is still running. Failing the
	 * row now would stop that upload's fill, so the row is left to it.
	 */
	it("leaves the document to another upload for it that is still running", async () => {
		findContext
			.mockResolvedValueOnce({
				projectId: FAKE_PROJECT_ID,
				metadata: {
					documentTag: "PRD",
					targetDocumentId: "doc-target",
				},
			})
			.mockResolvedValueOnce({ id: "ctx-newer-upload" });

		const { failContextTargetDocument } = await import(
			"../src/activities/project-context-processing"
		);
		const result = await failContextTargetDocument({
			contextId: FAKE_CONTEXT_ID,
			projectId: FAKE_PROJECT_ID,
			userId: FAKE_USER_ID,
			organizationId: FAKE_ORG_ID,
			reason: REASON,
		});

		expect(failGeneratingDocumentMock).not.toHaveBeenCalled();
		expect(result).toEqual({ applied: false });
	});

	/**
	 * Without an organization the lookup takes the other, exclusive tenant arm
	 * — no organization and the run's user — never both arms at once.
	 */
	it("looks a context up by its user when the run has no organization", async () => {
		findContext.mockResolvedValue(null);

		const { failContextTargetDocument } = await import(
			"../src/activities/project-context-processing"
		);
		const result = await failContextTargetDocument({
			contextId: FAKE_CONTEXT_ID,
			projectId: FAKE_PROJECT_ID,
			userId: FAKE_USER_ID,
			organizationId: undefined,
			reason: REASON,
		});

		expect(findContext).toHaveBeenCalledWith({
			where: {
				id: FAKE_CONTEXT_ID,
				projectId: FAKE_PROJECT_ID,
				organizationId: null,
				userId: FAKE_USER_ID,
			},
			select: { projectId: true, metadata: true },
		});
		expect(failGeneratingDocumentMock).not.toHaveBeenCalled();
		expect(result).toEqual({ applied: false });
	});

	/**
	 * The write only touches a GENERATING row, so a document that was filled,
	 * edited or already failed reports that nothing changed.
	 */
	it("reports nothing applied when the document is no longer generating", async () => {
		findContext
			.mockResolvedValueOnce({
				projectId: FAKE_PROJECT_ID,
				metadata: { targetDocumentId: "doc-target" },
			})
			.mockResolvedValueOnce(null);
		failGeneratingDocumentMock.mockResolvedValue(0);

		const { failContextTargetDocument } = await import(
			"../src/activities/project-context-processing"
		);
		const result = await failContextTargetDocument({
			contextId: FAKE_CONTEXT_ID,
			projectId: FAKE_PROJECT_ID,
			userId: FAKE_USER_ID,
			organizationId: FAKE_ORG_ID,
			reason: REASON,
		});

		expect(failGeneratingDocumentMock).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ applied: false });
	});

	it.each([
		["no metadata", null],
		["metadata without a target", { documentTag: "PRD" }],
		["an empty target", { targetDocumentId: "" }],
	])("writes nothing for a context with %s", async (_label, metadata) => {
		findContext.mockResolvedValue({ projectId: FAKE_PROJECT_ID, metadata });

		const { failContextTargetDocument } = await import(
			"../src/activities/project-context-processing"
		);
		const result = await failContextTargetDocument({
			contextId: FAKE_CONTEXT_ID,
			projectId: FAKE_PROJECT_ID,
			userId: FAKE_USER_ID,
			organizationId: FAKE_ORG_ID,
			reason: REASON,
		});

		expect(failGeneratingDocumentMock).not.toHaveBeenCalled();
		expect(result).toEqual({ applied: false });
	});

	/** A company source's id names no project context row. */
	it("writes nothing when no project context has the id", async () => {
		findContext.mockResolvedValue(null);

		const { failContextTargetDocument } = await import(
			"../src/activities/project-context-processing"
		);
		const result = await failContextTargetDocument({
			contextId: "company-source-1",
			projectId: FAKE_PROJECT_ID,
			userId: FAKE_USER_ID,
			organizationId: FAKE_ORG_ID,
			reason: REASON,
		});

		expect(failGeneratingDocumentMock).not.toHaveBeenCalled();
		expect(result).toEqual({ applied: false });
	});
});
