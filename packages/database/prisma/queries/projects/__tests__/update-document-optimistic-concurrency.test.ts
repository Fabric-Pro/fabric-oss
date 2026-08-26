/**
 * `updateDocument`'s optimistic-concurrency guard.
 *
 * The auto-refresh reads a document, spends MINUTES in a model call, then
 * writes. A person can land a save inside that window, and nobody is watching
 * the refresh to notice their edit vanish — so the guarantee "a refresh never
 * overwrites live human work" has to be enforced by the database, not by a
 * read-then-write check that leaves the window open.
 *
 * These tests pin the mechanism, not just the outcome: the version has to be in
 * the WHERE clause. An implementation that merely compares versions in memory
 * and then writes unguarded passes a naive outcome test and still loses the
 * race.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	findUniqueMock,
	updateMock,
	updateManyMock,
	versionFindFirstMock,
	versionCreateMock,
	txFindUniqueOrThrowMock,
	txFindUniqueMock,
	transactionMock,
} = vi.hoisted(() => ({
	findUniqueMock: vi.fn(),
	updateMock: vi.fn(),
	updateManyMock: vi.fn(),
	versionFindFirstMock: vi.fn(),
	versionCreateMock: vi.fn(),
	txFindUniqueOrThrowMock: vi.fn(),
	txFindUniqueMock: vi.fn(),
	transactionMock: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		projectDocument: { findUnique: findUniqueMock, update: updateMock },
		documentVersion: {
			findFirst: versionFindFirstMock,
			create: versionCreateMock,
		},
		$transaction: transactionMock,
	},
}));

import { DocumentVersionConflictError, updateDocument } from "../documents";

const CURRENT = {
	id: "doc_1",
	content: "# PRD\n\nOriginal.",
	version: 3,
	// The author of the content that is ABOUT to be snapshotted — a person, who
	// wrote version 3. The agent is the one superseding it.
	lastEditedBy: "user_human",
};

const BASE = {
	content: "# PRD\n\nUpdated by the agent.",
	changeDescription: "Removed SSO from scope.",
	lastEditedBy: "agent:living-docs-refresh",
	userId: "user_1",
};

beforeEach(() => {
	vi.clearAllMocks();
	findUniqueMock.mockResolvedValue(CURRENT);
	versionFindFirstMock.mockResolvedValue(null);
	versionCreateMock.mockResolvedValue({});
	updateMock.mockResolvedValue({ ...CURRENT, version: 4 });
	txFindUniqueOrThrowMock.mockResolvedValue({ ...CURRENT, version: 4 });
	txFindUniqueMock.mockResolvedValue({ version: 4 });
	updateManyMock.mockResolvedValue({ count: 1 });

	// Run the transaction callback against a tx client wired to the same mocks.
	transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) =>
		fn({
			projectDocument: {
				updateMany: updateManyMock,
				findUniqueOrThrow: txFindUniqueOrThrowMock,
				findUnique: txFindUniqueMock,
			},
			documentVersion: {
				findFirst: versionFindFirstMock,
				create: versionCreateMock,
			},
		}),
	);
});

describe("with expectedVersion (the auto-refresh path)", () => {
	it("puts the version in the WHERE clause, so the database arbitrates", async () => {
		await updateDocument("doc_1", { ...BASE, expectedVersion: 3 });

		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "doc_1", version: 3 },
			}),
		);
	});

	it("runs the snapshot and the write in one transaction", async () => {
		await updateDocument("doc_1", { ...BASE, expectedVersion: 3 });

		// Otherwise a lost race leaves an orphaned version row behind.
		expect(transactionMock).toHaveBeenCalledTimes(1);
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("throws rather than clobbering when the row moved under it", async () => {
		// The guarded UPDATE matched nothing: someone else wrote in the window.
		updateManyMock.mockResolvedValue({ count: 0 });
		txFindUniqueMock.mockResolvedValue({ version: 4 });

		await expect(
			updateDocument("doc_1", { ...BASE, expectedVersion: 3 }),
		).rejects.toBeInstanceOf(DocumentVersionConflictError);
	});

	it("fails fast when the version already moved before the write", async () => {
		findUniqueMock.mockResolvedValue({ ...CURRENT, version: 5 });

		await expect(
			updateDocument("doc_1", { ...BASE, expectedVersion: 3 }),
		).rejects.toBeInstanceOf(DocumentVersionConflictError);
		expect(transactionMock).not.toHaveBeenCalled();
	});

	it("attributes the snapshot to the author of the content it SNAPSHOTS, not the incoming writer", async () => {
		// The authorship inversion. A version row holds the content that was live at
		// `currentDoc.version`, so its author is whoever wrote THAT content — the
		// human — not the agent that is superseding it now.
		//
		// This used to copy the incoming writer (`data.lastEditedBy`) onto the row.
		// Harmless while every writer was a person and nothing rendered the name; it
		// stopped being harmless the moment an AI became a writer and version
		// history started showing authors. The row containing the HUMAN's text would
		// be labelled with the agent — and the next human edit would snapshot the
		// AGENT's rewrite under that human's name. The ledger inverted exactly where
		// it matters most: after "the AI corrupted our document", the history would
		// say a person did it.
		await updateDocument("doc_1", { ...BASE, expectedVersion: 3 });

		expect(versionCreateMock).toHaveBeenCalledWith({
			data: expect.objectContaining({
				changedBy: "user_human",
				version: 3,
			}),
		});
		// Emphatically not the agent doing the superseding.
		expect(versionCreateMock.mock.calls[0]?.[0].data.changedBy).not.toBe(
			"agent:living-docs-refresh",
		);
	});

	it("still carries the incoming writer's change summary onto the snapshot", async () => {
		// `changeDescription` is NOT inverted with the author: it describes the
		// change that SUPERSEDED this row, which is what the version-history UI
		// renders beside it and what every existing row already means.
		await updateDocument("doc_1", { ...BASE, expectedVersion: 3 });

		expect(versionCreateMock).toHaveBeenCalledWith({
			data: expect.objectContaining({
				changeDescription: "Removed SSO from scope.",
			}),
		});
	});

	it("still records the agent as the document's current editor", async () => {
		// The inversion applies only to the SNAPSHOT. The live document must still
		// say the agent touched it last, or the next snapshot would misattribute the
		// agent's rewrite to whoever edited before it.
		await updateDocument("doc_1", { ...BASE, expectedVersion: 3 });

		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastEditedBy: "agent:living-docs-refresh",
				}),
			}),
		);
	});

	it("snapshots a null author for a legacy document that never recorded one", async () => {
		findUniqueMock.mockResolvedValue({ ...CURRENT, lastEditedBy: null });

		await updateDocument("doc_1", { ...BASE, expectedVersion: 3 });

		expect(versionCreateMock).toHaveBeenCalledWith({
			data: expect.objectContaining({ changedBy: null }),
		});
	});
});

describe("without expectedVersion (every interactive caller)", () => {
	it("takes the unguarded path, exactly as before", async () => {
		await updateDocument("doc_1", BASE);

		expect(transactionMock).not.toHaveBeenCalled();
		expect(updateManyMock).not.toHaveBeenCalled();
		expect(updateMock).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "doc_1" } }),
		);
	});

	it("never throws a conflict, however far the version has moved", async () => {
		findUniqueMock.mockResolvedValue({ ...CURRENT, version: 99 });

		await expect(updateDocument("doc_1", BASE)).resolves.toBeDefined();
	});
});
