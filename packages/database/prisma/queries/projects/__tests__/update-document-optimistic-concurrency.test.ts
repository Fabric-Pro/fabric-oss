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

import { contentIdentity } from "@repo/utils/content-identity";
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

import {
	DocumentGenerationInProgressError,
	DocumentVersionConflictError,
	restoreDocumentVersion,
	updateDocument,
} from "../documents";

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

/**
 * The body half of the base (Fizzy #2946). A save from a collaborative editor
 * room names the version AND the body identity its content descends from,
 * because the version alone does not name a body: a Proposal run's final save
 * writes its body at the old version, and a rejected regeneration rewinds it.
 *
 * These run against one in-memory document row behind a `$transaction` that
 * rolls back on throw, so "nothing written" is checked on state, not on mock
 * calls. `updateMany` applies its WHERE to the row, so a guard that leaves the
 * body out of the condition writes over the run's body and fails here.
 */
describe("with a body base (a save from a collaborative room)", () => {
	const ROOM_BODY = "# PRD\n\nOriginal.";
	const RUN_BODY = "# PRD\n\nRegenerated by the run.";
	const REVERT_BODY = "# PRD\n\nThe body from before the run.";
	const OTHER_SAVE_BODY = "# PRD\n\nSaved from another tab.";

	interface Row {
		id: string;
		content: string;
		version: number;
		lastEditedBy: string | null;
		[key: string]: unknown;
	}

	let row: Row;
	let versions: Array<Record<string, unknown>>;
	/** The condition of the last guarded update, to pin the mechanism. */
	let lastWhere: Record<string, unknown> | undefined;

	beforeEach(() => {
		row = { ...CURRENT, content: ROOM_BODY };
		versions = [];
		lastWhere = undefined;

		findUniqueMock.mockImplementation(async () => ({ ...row }));
		updateMock.mockImplementation(
			async ({ data }: { data: Record<string, unknown> }) => {
				row = { ...row, ...data };
				return { ...row };
			},
		);
		transactionMock.mockImplementation(
			async (fn: (tx: unknown) => unknown) => {
				const rowBefore = { ...row };
				const versionsBefore = [...versions];
				const tx = {
					projectDocument: {
						updateMany: async ({
							where,
							data,
						}: {
							where: Record<string, unknown>;
							data: Record<string, unknown>;
						}) => {
							lastWhere = where;
							const matches = Object.entries(where).every(
								([key, value]) => row[key] === value,
							);
							if (!matches) {
								return { count: 0 };
							}
							row = { ...row, ...data };
							return { count: 1 };
						},
						findUnique: async () => ({ version: row.version }),
						findUniqueOrThrow: async () => ({ ...row }),
					},
					documentVersion: {
						findFirst: async ({
							where,
						}: {
							where: { version: number };
						}) =>
							versions.find((v) => v.version === where.version) ??
							null,
						create: async ({
							data,
						}: {
							data: Record<string, unknown>;
						}) => {
							versions.push(data);
							return data;
						},
					},
				};
				try {
					return await fn(tx);
				} catch (error) {
					row = rowBefore;
					versions = versionsBefore;
					throw error;
				}
			},
		);
	});

	/** The read sees the room's body; a run then writes its own at the same version. */
	function runWritesBetweenReadAndUpdate() {
		findUniqueMock.mockImplementationOnce(async () => {
			const read = { ...row };
			row = { ...row, content: RUN_BODY };
			return read;
		});
	}

	it("writes when the version and the body are still the ones named", async () => {
		const saved = await updateDocument("doc_1", {
			...BASE,
			expectedVersion: 3,
			expectedContentHash: contentIdentity(ROOM_BODY),
		});

		expect(saved).toMatchObject({ content: BASE.content, version: 4 });
		expect(row).toMatchObject({ content: BASE.content, version: 4 });
		expect(versions).toEqual([
			expect.objectContaining({ version: 3, content: ROOM_BODY }),
		]);
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("refuses a stale version before any write", async () => {
		row = { ...row, version: 4 };

		const error = await updateDocument("doc_1", {
			...BASE,
			expectedVersion: 3,
			expectedContentHash: contentIdentity(ROOM_BODY),
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(DocumentVersionConflictError);
		expect(error).toMatchObject({ reason: "version" });
		expect(transactionMock).not.toHaveBeenCalled();
		expect(row).toMatchObject({ content: ROOM_BODY, version: 4 });
	});

	it("refuses a save whose body changed at the same version (the run's final save)", async () => {
		// The run wrote its body at version 3; the version moves only at its
		// next step. A version-only check passes here.
		row = { ...row, content: RUN_BODY };

		const error = await updateDocument("doc_1", {
			...BASE,
			expectedVersion: 3,
			expectedContentHash: contentIdentity(ROOM_BODY),
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(DocumentVersionConflictError);
		expect(error).toMatchObject({ reason: "content", actualVersion: 3 });
		expect(transactionMock).not.toHaveBeenCalled();
		expect(row).toMatchObject({ content: RUN_BODY, version: 3 });
		expect(versions).toEqual([]);
	});

	it("refuses a write that lands between the read and the update, and writes nothing", async () => {
		runWritesBetweenReadAndUpdate();

		const error = await updateDocument("doc_1", {
			...BASE,
			expectedVersion: 3,
			expectedContentHash: contentIdentity(ROOM_BODY),
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(DocumentVersionConflictError);
		expect(error).toMatchObject({ reason: "content" });
		// The run's body stands, and the snapshot rolled back with the write.
		expect(row).toMatchObject({ content: RUN_BODY, version: 3 });
		expect(versions).toEqual([]);
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("refuses a save that steps the version between the read and the update as a version conflict, and writes nothing", async () => {
		// Another save lands in the window and moves the version on. The
		// conditioned update matches nothing, and the re-read says which half
		// moved: the version, not only the body.
		findUniqueMock.mockImplementationOnce(async () => {
			const read = { ...row };
			row = { ...row, content: OTHER_SAVE_BODY, version: 4 };
			return read;
		});

		const error = await updateDocument("doc_1", {
			...BASE,
			expectedVersion: 3,
			expectedContentHash: contentIdentity(ROOM_BODY),
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(DocumentVersionConflictError);
		expect(error).toMatchObject({
			reason: "version",
			expectedVersion: 3,
			actualVersion: 4,
		});
		// The other save stands, and the snapshot rolled back with the write.
		expect(row).toMatchObject({ content: OTHER_SAVE_BODY, version: 4 });
		expect(versions).toEqual([]);
		expect(updateMock).not.toHaveBeenCalled();
	});

	describe("with the body half alone (no expectedVersion)", () => {
		it("refuses before any write when the stored body is not the one named", async () => {
			row = { ...row, content: RUN_BODY };

			const error = await updateDocument("doc_1", {
				...BASE,
				expectedContentHash: contentIdentity(ROOM_BODY),
			}).catch((e: unknown) => e);

			expect(error).toBeInstanceOf(DocumentVersionConflictError);
			// With no version named, the conflict reports the version it read.
			expect(error).toMatchObject({
				reason: "content",
				expectedVersion: 3,
				actualVersion: 3,
			});
			expect(transactionMock).not.toHaveBeenCalled();
			expect(updateMock).not.toHaveBeenCalled();
			expect(row).toMatchObject({ content: RUN_BODY, version: 3 });
			expect(versions).toEqual([]);
		});

		it("writes through the guarded transaction, conditioned on the version read and the body checked", async () => {
			const saved = await updateDocument("doc_1", {
				...BASE,
				expectedContentHash: contentIdentity(ROOM_BODY),
			});

			expect(saved).toMatchObject({ content: BASE.content, version: 4 });
			expect(row).toMatchObject({ content: BASE.content, version: 4 });
			expect(transactionMock).toHaveBeenCalledTimes(1);
			expect(updateMock).not.toHaveBeenCalled();
			// Not last-write-wins: the database refuses the write if either the
			// version or the body moved after the read.
			expect(lastWhere).toEqual({
				id: "doc_1",
				version: 3,
				content: ROOM_BODY,
			});
			expect(versions).toEqual([
				expect.objectContaining({ version: 3, content: ROOM_BODY }),
			]);
		});
	});

	it("guards the no-bump revert the same way when a base is given", async () => {
		const saved = await updateDocument("doc_1", {
			...BASE,
			content: REVERT_BODY,
			skipVersionBump: true,
			expectedVersion: 3,
			expectedContentHash: contentIdentity(ROOM_BODY),
		});

		expect(saved).toMatchObject({ content: REVERT_BODY, version: 3 });
		expect(row).toMatchObject({ content: REVERT_BODY, version: 3 });
		expect(versions).toEqual([]);
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("refuses a no-bump revert from a stale base, before any write", async () => {
		row = { ...row, content: RUN_BODY };

		const error = await updateDocument("doc_1", {
			...BASE,
			content: REVERT_BODY,
			skipVersionBump: true,
			expectedVersion: 3,
			expectedContentHash: contentIdentity(ROOM_BODY),
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(DocumentVersionConflictError);
		expect(row).toMatchObject({ content: RUN_BODY, version: 3 });
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("refuses a no-bump revert when a write lands between the read and the update", async () => {
		runWritesBetweenReadAndUpdate();

		const error = await updateDocument("doc_1", {
			...BASE,
			content: REVERT_BODY,
			skipVersionBump: true,
			expectedVersion: 3,
			expectedContentHash: contentIdentity(ROOM_BODY),
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(DocumentVersionConflictError);
		expect(row).toMatchObject({ content: RUN_BODY, version: 3 });
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("keeps the no-bump revert unguarded when no base is given", async () => {
		await updateDocument("doc_1", {
			...BASE,
			content: REVERT_BODY,
			skipVersionBump: true,
		});

		expect(transactionMock).not.toHaveBeenCalled();
		expect(updateMock).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "doc_1" } }),
		);
		expect(row).toMatchObject({ content: REVERT_BODY, version: 3 });
	});

	it("leaves a version-only caller's condition as it was, without the body", async () => {
		// The auto-refresh and the visual-slot splices name a version only.
		const updateMany = vi.fn(async () => ({ count: 1 }));
		transactionMock.mockImplementationOnce(
			async (fn: (tx: unknown) => unknown) =>
				fn({
					projectDocument: {
						updateMany,
						findUniqueOrThrow: async () => ({ ...row, version: 4 }),
						findUnique: async () => ({ version: 4 }),
					},
					documentVersion: {
						findFirst: async () => null,
						create: async () => ({}),
					},
				}),
		);

		await updateDocument("doc_1", { ...BASE, expectedVersion: 3 });

		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "doc_1", version: 3 } }),
		);
	});
});

describe("refusing to write under a live generation run (Fizzy #2946)", () => {
	const GUARDED_BASE = {
		...BASE,
		expectedVersion: 3,
		expectedContentHash: contentIdentity(CURRENT.content),
		refuseWhileGenerating: true,
	};

	it("puts the run statuses in the WHERE clause", async () => {
		await updateDocument("doc_1", GUARDED_BASE);

		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "doc_1",
					version: 3,
					content: CURRENT.content,
					status: { notIn: ["QUEUED", "GENERATING"] },
				},
			}),
		);
	});

	it.each(["QUEUED", "GENERATING"])(
		"refuses a document read as %s without writing",
		async (status) => {
			findUniqueMock.mockResolvedValue({ ...CURRENT, status });

			await expect(
				updateDocument("doc_1", GUARDED_BASE),
			).rejects.toBeInstanceOf(DocumentGenerationInProgressError);
			expect(transactionMock).not.toHaveBeenCalled();
			expect(updateMock).not.toHaveBeenCalled();
		},
	);

	it("refuses when a run queued the document between the read and the write", async () => {
		// The read saw a finished document; the row holds QUEUED by the time
		// the UPDATE runs. Queueing writes no version or body, so only the
		// status condition can catch it.
		findUniqueMock.mockResolvedValue({ ...CURRENT, status: "COMPLETE" });
		updateManyMock.mockResolvedValue({ count: 0 });
		txFindUniqueMock.mockResolvedValue({ version: 3, status: "QUEUED" });

		await expect(
			updateDocument("doc_1", GUARDED_BASE),
		).rejects.toBeInstanceOf(DocumentGenerationInProgressError);
	});

	it("still reports a body change as a version conflict when no run holds the row", async () => {
		findUniqueMock.mockResolvedValue({ ...CURRENT, status: "COMPLETE" });
		updateManyMock.mockResolvedValue({ count: 0 });
		txFindUniqueMock.mockResolvedValue({ version: 3, status: "COMPLETE" });

		await expect(
			updateDocument("doc_1", GUARDED_BASE),
		).rejects.toBeInstanceOf(DocumentVersionConflictError);
	});

	it("takes the guarded write even without a base", async () => {
		await updateDocument("doc_1", { ...BASE, refuseWhileGenerating: true });

		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "doc_1",
					version: 3,
					status: { notIn: ["QUEUED", "GENERATING"] },
				},
			}),
		);
	});

	it.each(["QUEUED", "GENERATING"])(
		"refuses a status-only write to a document read as %s without writing",
		async (status) => {
			findUniqueMock.mockResolvedValue({ ...CURRENT, status });

			await expect(
				updateDocument("doc_1", {
					status: "COMPLETE",
					userId: "user_1",
					refuseWhileGenerating: true,
				}),
			).rejects.toBeInstanceOf(DocumentGenerationInProgressError);
			expect(transactionMock).not.toHaveBeenCalled();
			expect(updateMock).not.toHaveBeenCalled();
		},
	);

	it("conditions a status-only write on no run holding the row", async () => {
		findUniqueMock.mockResolvedValue({ ...CURRENT, status: "REVIEW" });

		await updateDocument("doc_1", {
			status: "COMPLETE",
			userId: "user_1",
			refuseWhileGenerating: true,
		});

		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).toHaveBeenCalledWith({
			where: {
				id: "doc_1",
				version: 3,
				status: { notIn: ["QUEUED", "GENERATING"] },
			},
			data: { status: "COMPLETE" },
		});
	});

	it("leaves a write that does not ask for it free of the status condition", async () => {
		findUniqueMock.mockResolvedValue({ ...CURRENT, status: "GENERATING" });

		await updateDocument("doc_1", { ...BASE, expectedVersion: 3 });

		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "doc_1", version: 3 } }),
		);
	});
});

describe("restoreDocumentVersion", () => {
	const RESTORED = "# PRD\n\nThe body of version 2.";
	const TENANT = { userId: "user_1", organizationId: "org_1" };

	beforeEach(() => {
		// The first lookup is the version being restored; the second is the
		// guarded write's check for an existing snapshot row.
		versionFindFirstMock
			.mockResolvedValueOnce({
				documentId: "doc_1",
				version: 2,
				content: RESTORED,
			})
			.mockResolvedValue(null);
	});

	it("restores through the unguarded write when not asked to refuse a run", async () => {
		findUniqueMock.mockResolvedValue({ ...CURRENT, status: "GENERATING" });

		await restoreDocumentVersion("doc_1", 2, "user_1", TENANT);

		expect(transactionMock).not.toHaveBeenCalled();
		expect(updateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "doc_1" },
				data: expect.objectContaining({
					content: RESTORED,
					version: 4,
				}),
			}),
		);
	});

	it.each(["QUEUED", "GENERATING"])(
		"refuses a restore of a document read as %s without writing",
		async (status) => {
			findUniqueMock.mockResolvedValue({ ...CURRENT, status });

			await expect(
				restoreDocumentVersion("doc_1", 2, "user_1", TENANT, {
					refuseWhileGenerating: true,
				}),
			).rejects.toBeInstanceOf(DocumentGenerationInProgressError);
			expect(transactionMock).not.toHaveBeenCalled();
			expect(updateMock).not.toHaveBeenCalled();
			expect(versionCreateMock).not.toHaveBeenCalled();
		},
	);

	it("conditions the restore on no run holding the row", async () => {
		findUniqueMock.mockResolvedValue({ ...CURRENT, status: "COMPLETE" });

		await restoreDocumentVersion("doc_1", 2, "user_1", TENANT, {
			refuseWhileGenerating: true,
		});

		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "doc_1",
					version: 3,
					status: { notIn: ["QUEUED", "GENERATING"] },
				},
				data: expect.objectContaining({
					content: RESTORED,
					version: 4,
				}),
			}),
		);
	});

	it("refuses a restore when a run is queued between the read and the write", async () => {
		findUniqueMock.mockResolvedValue({ ...CURRENT, status: "COMPLETE" });
		updateManyMock.mockResolvedValue({ count: 0 });
		txFindUniqueMock.mockResolvedValue({ version: 3, status: "QUEUED" });

		await expect(
			restoreDocumentVersion("doc_1", 2, "user_1", TENANT, {
				refuseWhileGenerating: true,
			}),
		).rejects.toBeInstanceOf(DocumentGenerationInProgressError);
		expect(updateMock).not.toHaveBeenCalled();
		expect(txFindUniqueOrThrowMock).not.toHaveBeenCalled();
	});
});
