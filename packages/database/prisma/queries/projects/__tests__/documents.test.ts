/**
 * Tests for the document read path's `currentContentHash`.
 *
 * The document editor's decision-precheck banner shows only while
 * `precheck.checkedContentHash === currentContentHash`. `currentContentHash` is
 * recomputed from the LIVE content on every read (`computeDocumentContentHash`),
 * deliberately decoupled from the embed-owned `contentHash` column — so the
 * warning survives an embed that failed, was skipped, or has not run yet (the
 * column is null/stale in exactly those cases).
 *
 * Run with:
 *   pnpm --filter @repo/database test prisma/queries/projects/__tests__/documents.test.ts
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueMock = vi.fn();

vi.mock("../../../client", () => ({
	db: {
		projectDocument: {
			findUnique: (...args: unknown[]) => findUniqueMock(...args),
		},
	},
	// `Prisma` is referenced at runtime by other exports in the module (e.g.
	// `clearProjectDocumentDecisionPrecheck`), never at import time or by the
	// code under test here.
	Prisma: { DbNull: Symbol("DbNull") },
}));

const { computeDocumentContentHash, getDocumentById } = await import(
	"../documents"
);

// Independent reference implementation of the hash the pre-check activity uses
// (`@repo/rag`'s `generateContentHash`): sha256, first 16 hex chars.
const expectedHash = (content: string) =>
	createHash("sha256").update(content).digest("hex").substring(0, 16);

const CONTENT = "Adopt MongoDB as the primary datastore.";

const docRow = (overrides: Record<string, unknown> = {}) => ({
	id: "doc-1",
	projectId: "project-1",
	content: CONTENT,
	contentHash: null,
	decisionPrecheck: null,
	project: { id: "project-1", name: "P", userId: "u", organizationId: null },
	versions: [],
	...overrides,
});

beforeEach(() => {
	findUniqueMock.mockReset();
});

describe("computeDocumentContentHash", () => {
	it("matches the pre-check's sha256-substr(16) formula (stable + deterministic)", () => {
		expect(computeDocumentContentHash(CONTENT)).toBe(expectedHash(CONTENT));
		expect(computeDocumentContentHash(CONTENT)).toBe(
			computeDocumentContentHash(CONTENT),
		);
	});
});

describe("getDocumentById currentContentHash", () => {
	it("derives currentContentHash from the live content when contentHash is null (embed-failure / first-gen case)", async () => {
		findUniqueMock.mockResolvedValue(docRow({ contentHash: null }));

		const document = await getDocumentById("doc-1");

		// Even with the embed-owned column null, the banner has a hash to gate on
		// that equals what the pre-check judged the same content against.
		expect(document?.currentContentHash).toBe(expectedHash(CONTENT));
	});

	it("reflects the current content even when contentHash is stale (points at older content)", async () => {
		findUniqueMock.mockResolvedValue(
			docRow({ contentHash: expectedHash("older superseded content") }),
		);

		const document = await getDocumentById("doc-1");

		expect(document?.currentContentHash).toBe(expectedHash(CONTENT));
		expect(document?.currentContentHash).not.toBe(document?.contentHash);
	});

	it("returns null when the document does not exist", async () => {
		findUniqueMock.mockResolvedValue(null);

		expect(await getDocumentById("missing")).toBeNull();
	});
});
