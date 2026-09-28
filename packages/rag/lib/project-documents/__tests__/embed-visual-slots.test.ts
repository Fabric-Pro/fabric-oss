/**
 * Visual slots never reach retrieval (Fizzy #2589, KTD17, R6, R38).
 *
 * A `<visual-slot>` line is a placeholder marker, not prose. Embedding strips
 * it before chunking and before the content hash, so no chunk carries it and
 * a document hashes the same with or without a slot — placing one does not
 * re-embed an otherwise unchanged document.
 *
 * The real chunker and slot helper run; the database, embeddings API, and
 * Qdrant store are mocked, and the tokenizer is stubbed as in chunker.test.ts
 * to skip tiktoken's start-up.
 *
 * Run with: pnpm --filter @repo/rag test lib/project-documents/__tests__/embed-visual-slots
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	clearDocumentEmbedding: vi.fn(),
	getProjectRagSettings: vi.fn(),
	markDocumentAsEmbedded: vi.fn(),
	markDocumentAsEmbeddedIfVersionUnchanged: vi.fn(),
	generateEmbedding: vi.fn(),
	generateEmbeddings: vi.fn(),
	storeProjectContext: vi.fn(),
	deleteProjectContext: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	clearDocumentEmbedding: mocks.clearDocumentEmbedding,
	getProjectRagSettings: mocks.getProjectRagSettings,
	markDocumentAsEmbedded: mocks.markDocumentAsEmbedded,
	markDocumentAsEmbeddedIfVersionUnchanged:
		mocks.markDocumentAsEmbeddedIfVersionUnchanged,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The chunking index also re-exports the contextual-enrichment and semantic
// chunkers, which pull in `@repo/ai`; embed.ts uses only these two.
vi.mock("../../chunking", async () => {
	const chunker = await vi.importActual<
		typeof import("../../chunking/chunker")
	>("../../chunking/chunker");
	return {
		chunkText: chunker.chunkText,
		detectContentType: chunker.detectContentType,
	};
});

vi.mock("../../chunking/tokenizer", () => ({
	countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
	charsToTokensEstimate: vi.fn((chars: number) => Math.ceil(chars / 4)),
}));

vi.mock("../../embedding", () => ({
	generateEmbedding: mocks.generateEmbedding,
	generateEmbeddings: mocks.generateEmbeddings,
}));

vi.mock("../../project-contexts/store", () => ({
	storeProjectContext: mocks.storeProjectContext,
	deleteProjectContext: mocks.deleteProjectContext,
}));

import {
	embedProjectDocument,
	generateContentHash,
	reembedProjectDocument,
} from "../embed";

const SLOT =
	'<visual-slot data-slot-id="slot-1" data-kind="timeline" data-hint="Delivery phases"></visual-slot>';

function sectionBody(n: number): string {
	return Array.from(
		{ length: 6 },
		(_, i) =>
			`Paragraph ${i + 1} of section ${n} explains the delivery plan in enough detail to fill a chunk.`,
	).join("\n\n");
}

/** Long enough to take the chunked path (over 2048 characters). */
const LONG_WITHOUT_SLOT = [
	"# Proposal",
	...[1, 2, 3, 4].flatMap((n) => [`## Section ${n}`, sectionBody(n)]),
].join("\n\n");

const LONG_WITH_SLOT = LONG_WITHOUT_SLOT.replace(
	"## Section 2\n\n",
	`## Section 2\n\n${SLOT}\n\n`,
);

const SHORT_WITHOUT_SLOT =
	"# Proposal\n\n## Implementation Phases\n\nPhase one covers discovery.\n\nPhase two covers delivery.";

const SHORT_WITH_SLOT = SHORT_WITHOUT_SLOT.replace(
	"\n\nPhase two",
	`\n\n${SLOT}\n\nPhase two`,
);

function options(content: string) {
	return {
		documentId: "doc-1",
		projectId: "proj-1",
		userId: "user-1",
		organizationId: "org-1",
		content,
		documentType: "PROPOSAL",
		title: "Proposal",
		apiKey: "sk-example",
		expectedVersion: 3,
	};
}

/** Every chunk text handed to the embeddings API or stored in Qdrant. */
function embeddedTexts(): string[] {
	return [
		...mocks.generateEmbedding.mock.calls.map(([text]) => text as string),
		...mocks.generateEmbeddings.mock.calls.flatMap(
			([texts]) => texts as string[],
		),
		...mocks.storeProjectContext.mock.calls.map(
			([input]) => (input as { content: string }).content,
		),
	];
}

/** The hash written to the document row by the mark step. */
function markedHash(): string {
	expect(
		mocks.markDocumentAsEmbeddedIfVersionUnchanged,
	).toHaveBeenCalledTimes(1);
	return mocks.markDocumentAsEmbeddedIfVersionUnchanged.mock.calls[0][2];
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getProjectRagSettings.mockResolvedValue({
		chunkSize: 400,
		chunkOverlap: 0,
		splitMethod: "PARAGRAPH",
	});
	mocks.generateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2] });
	mocks.generateEmbeddings.mockImplementation(async (texts: string[]) => ({
		embeddings: texts.map(() => [0.1, 0.2]),
	}));
	mocks.storeProjectContext.mockImplementation(
		async ({ contextId }: { contextId: string }) => `point-${contextId}`,
	);
	mocks.markDocumentAsEmbeddedIfVersionUnchanged.mockResolvedValue({
		updated: true,
	});
});

describe("embedProjectDocument strips visual slots", () => {
	it("keeps the slot out of every chunk of a chunked document", async () => {
		expect(LONG_WITH_SLOT).toContain(SLOT);
		expect(LONG_WITH_SLOT.length).toBeGreaterThan(2048);

		const result = await embedProjectDocument(options(LONG_WITH_SLOT));

		expect(result.success).toBe(true);
		expect(result.chunksCreated).toBeGreaterThan(1);
		const texts = embeddedTexts();
		expect(texts.length).toBeGreaterThan(0);
		for (const text of texts) {
			expect(text).not.toContain("visual-slot");
		}
	});

	it("hashes a chunked document with a slot the same as without it", async () => {
		const withSlot = await embedProjectDocument(options(LONG_WITH_SLOT));
		const withoutSlot = await embedProjectDocument(
			options(LONG_WITHOUT_SLOT),
		);

		expect(withSlot.contentHash).toBe(
			generateContentHash(LONG_WITHOUT_SLOT),
		);
		expect(withSlot.contentHash).toBe(withoutSlot.contentHash);
		// The hash the mark step writes to the document row, run by run.
		const marked =
			mocks.markDocumentAsEmbeddedIfVersionUnchanged.mock.calls.map(
				(call) => call[2],
			);
		expect(marked).toEqual([
			generateContentHash(LONG_WITHOUT_SLOT),
			generateContentHash(LONG_WITHOUT_SLOT),
		]);
		expect(withSlot.chunksCreated).toBe(withoutSlot.chunksCreated);
	});

	it("keeps the slot out of a single-chunk document and its hash", async () => {
		const result = await embedProjectDocument(options(SHORT_WITH_SLOT));

		expect(result.success).toBe(true);
		expect(result.chunksCreated).toBe(1);
		for (const text of embeddedTexts()) {
			expect(text).not.toContain("visual-slot");
		}
		expect(mocks.generateEmbedding.mock.calls[0][0]).toBe(
			SHORT_WITHOUT_SLOT,
		);
		expect(result.contentHash).toBe(
			generateContentHash(SHORT_WITHOUT_SLOT),
		);
		expect(markedHash()).toBe(generateContentHash(SHORT_WITHOUT_SLOT));
	});

	it("embeds and hashes a slot-free document exactly as given", async () => {
		const result = await embedProjectDocument(options(SHORT_WITHOUT_SLOT));

		expect(mocks.generateEmbedding.mock.calls[0][0]).toBe(
			SHORT_WITHOUT_SLOT,
		);
		expect(result.contentHash).toBe(
			generateContentHash(SHORT_WITHOUT_SLOT),
		);
	});
});

describe("reembedProjectDocument compares the slot-free hash", () => {
	it("skips re-embedding when the only change is a placed slot", async () => {
		const result = await reembedProjectDocument(
			options(SHORT_WITH_SLOT),
			generateContentHash(SHORT_WITHOUT_SLOT),
		);

		expect(result).toEqual({
			success: true,
			contentHash: generateContentHash(SHORT_WITHOUT_SLOT),
			chunksCreated: 0,
		});
		expect(mocks.deleteProjectContext).not.toHaveBeenCalled();
		expect(mocks.clearDocumentEmbedding).not.toHaveBeenCalled();
		expect(mocks.generateEmbedding).not.toHaveBeenCalled();
	});

	it("still re-embeds, without the slot, when the prose changed", async () => {
		const result = await reembedProjectDocument(
			options(SHORT_WITH_SLOT.replace("discovery", "research")),
			generateContentHash(SHORT_WITHOUT_SLOT),
		);

		expect(result.success).toBe(true);
		expect(mocks.clearDocumentEmbedding).toHaveBeenCalledWith("doc-1");
		for (const text of embeddedTexts()) {
			expect(text).not.toContain("visual-slot");
		}
		expect(result.contentHash).toBe(
			generateContentHash(
				SHORT_WITHOUT_SLOT.replace("discovery", "research"),
			),
		);
	});
});
