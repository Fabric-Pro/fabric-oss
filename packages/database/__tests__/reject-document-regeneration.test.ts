/**
 * Tests for `rejectDocumentRegeneration`.
 *
 * Regression test for Fizzy #1155: regenerating a document was perceived as
 * silently deleting prior versions. The actual underlying defect was a
 * phantom `DocumentVersion` row left behind on Reject — this helper makes
 * Reject a true atomic rollback.
 *
 * Run with: pnpm --filter @repo/database test __tests__/reject-document-regeneration.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type DocRow = { id: string; version: number; content: string };
type VersionRow = { id: string; version: number; content: string };
type UpdatedDoc = { id: string; version: number; content: string };

const docFindUniqueMock = vi.fn();
const versionFindFirstMock = vi.fn();
const versionDeleteMock = vi.fn();
const docUpdateMock = vi.fn();

// $transaction(callback) — invoke the callback synchronously with a tx
// shim that proxies to our mocks, mirroring how Prisma exposes the
// transactional client.
const transactionMock = vi.fn(async (callback: (tx: unknown) => unknown) => {
	const tx = {
		projectDocument: {
			findUnique: docFindUniqueMock,
			update: docUpdateMock,
		},
		documentVersion: {
			findFirst: versionFindFirstMock,
			delete: versionDeleteMock,
		},
	};
	return await callback(tx);
});

vi.mock("../prisma/client", () => ({
	db: {
		$transaction: (callback: (tx: unknown) => unknown) =>
			transactionMock(callback),
	},
}));

import { rejectDocumentRegeneration } from "../prisma/queries/projects/documents";

describe("rejectDocumentRegeneration", () => {
	beforeEach(() => {
		docFindUniqueMock.mockReset();
		versionFindFirstMock.mockReset();
		versionDeleteMock.mockReset();
		docUpdateMock.mockReset();
		transactionMock.mockClear();
	});

	it("deletes the latest version row and rewinds the document to the prior snapshot", async () => {
		// State just after a regen: PD at v=2 with NEW content; DV has v=1
		// (OLD) and v=2 (NEW). Reject must remove the v=2 row and revert PD
		// to {v=1, content=OLD}. PD.content matches latest DV.content — that's
		// the post-success state where rollback is safe.
		const newContent = "NEW content from regeneration";
		const doc: DocRow = {
			id: "doc-1",
			version: 2,
			content: newContent,
		};
		const latest: VersionRow = {
			id: "ver-2",
			version: 2,
			content: newContent,
		};
		const previous: VersionRow = {
			id: "ver-1",
			version: 1,
			content: "OLD pre-regen content",
		};

		docFindUniqueMock.mockResolvedValue(doc);
		// First findFirst: latest (orderBy desc, no version filter).
		// Second findFirst: previous (orderBy desc, version < latest.version).
		versionFindFirstMock
			.mockResolvedValueOnce(latest)
			.mockResolvedValueOnce(previous);
		versionDeleteMock.mockResolvedValue(latest);
		const updated: UpdatedDoc = {
			id: doc.id,
			version: previous.version,
			content: previous.content,
		};
		docUpdateMock.mockResolvedValue(updated);

		const result = await rejectDocumentRegeneration("doc-1", {
			userId: "user-1",
			organizationId: "org-1",
		});

		// Phantom row removed.
		expect(versionDeleteMock).toHaveBeenCalledTimes(1);
		expect(versionDeleteMock).toHaveBeenCalledWith({
			where: { id: "ver-2" },
		});

		// Live doc rewound to prior content + version, with wordCount recomputed
		// from the reverted content (4 words: OLD pre-regen content → 3 tokens
		// after split, but the helper uses countDocumentWords which strips
		// fences/images and then counts whitespace tokens; here that's just
		// the plain split).
		expect(docUpdateMock).toHaveBeenCalledTimes(1);
		const updateArgs = docUpdateMock.mock.calls[0]?.[0] as {
			where: { id: string };
			data: {
				content: string;
				version: number;
				wordCount: number;
				lastEditedBy: string;
			};
		};
		expect(updateArgs.where).toEqual({ id: "doc-1" });
		expect(updateArgs.data.content).toBe(previous.content);
		expect(updateArgs.data.version).toBe(1);
		expect(updateArgs.data.lastEditedBy).toBe("user-1");
		expect(updateArgs.data.wordCount).toBe(
			previous.content.split(/\s+/).filter((w) => w.length > 0).length,
		);

		// All ops happen inside a single transaction.
		expect(transactionMock).toHaveBeenCalledTimes(1);

		expect(result).toEqual(updated);
	});

	it("throws NO_PRIOR_VERSION when only one version row exists (first-ever generation)", async () => {
		// First-ever generation has a single DV row at v=1 and PD at v=1.
		// There is no earlier snapshot to revert to.
		const onlyContent = "the only content";
		docFindUniqueMock.mockResolvedValue({
			id: "doc-1",
			version: 1,
			content: onlyContent,
		});
		versionFindFirstMock
			.mockResolvedValueOnce({
				id: "ver-1",
				version: 1,
				content: onlyContent,
			})
			.mockResolvedValueOnce(null); // no row with version < 1

		await expect(
			rejectDocumentRegeneration("doc-1", { userId: "user-1" }),
		).rejects.toThrow("NO_PRIOR_VERSION");

		// Nothing should have been deleted or updated.
		expect(versionDeleteMock).not.toHaveBeenCalled();
		expect(docUpdateMock).not.toHaveBeenCalled();
	});

	it("throws NO_PRIOR_VERSION when the latest snapshot does not match the live document version", async () => {
		// Defensive guard: if the doc's version has drifted from the latest
		// DV row (e.g. an inline edit happened after regeneration without
		// going through the standard save path), bail rather than guess
		// which row to delete.
		docFindUniqueMock.mockResolvedValue({
			id: "doc-1",
			version: 5,
			content: "live content",
		});
		versionFindFirstMock.mockResolvedValueOnce({
			id: "ver-3",
			version: 3,
			content: "stale snapshot",
		});

		await expect(
			rejectDocumentRegeneration("doc-1", { userId: "user-1" }),
		).rejects.toThrow("NO_PRIOR_VERSION");

		// We bail before looking up the previous row or mutating anything.
		expect(versionFindFirstMock).toHaveBeenCalledTimes(1);
		expect(versionDeleteMock).not.toHaveBeenCalled();
		expect(docUpdateMock).not.toHaveBeenCalled();
	});

	it("throws NO_PRIOR_VERSION when the latest snapshot is a pre-regen snapshot (createDocumentVersion failed/in-flight)", async () => {
		// Reproduces the gap the reviewer flagged: between
		// `saveProjectDocument` (which writes a pre-regen DV row at v=N
		// holding the OLD content + sets PD.content = NEW) and
		// `createDocumentVersion` (which would create v=N+1=NEW and bump
		// PD.version), the latest DV row has version === PD.version but
		// holds OLD content. Without comparing content we'd delete the
		// user's actual previous snapshot.
		docFindUniqueMock.mockResolvedValue({
			id: "doc-1",
			version: 2,
			content: "NEW (already on the doc, not yet versioned)",
		});
		versionFindFirstMock.mockResolvedValueOnce({
			id: "ver-2",
			version: 2,
			content: "OLD pre-regen snapshot",
		});

		await expect(
			rejectDocumentRegeneration("doc-1", { userId: "user-1" }),
		).rejects.toThrow("NO_PRIOR_VERSION");

		expect(versionFindFirstMock).toHaveBeenCalledTimes(1);
		expect(versionDeleteMock).not.toHaveBeenCalled();
		expect(docUpdateMock).not.toHaveBeenCalled();
	});

	it("throws when the document does not exist", async () => {
		docFindUniqueMock.mockResolvedValue(null);

		await expect(
			rejectDocumentRegeneration("missing-doc", { userId: "user-1" }),
		).rejects.toThrow("Document not found");

		expect(versionFindFirstMock).not.toHaveBeenCalled();
		expect(versionDeleteMock).not.toHaveBeenCalled();
		expect(docUpdateMock).not.toHaveBeenCalled();
	});
});
