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
const docUpdateManyMock = vi.fn();
const docFindUniqueOrThrowMock = vi.fn();

// $transaction(callback) — invoke the callback synchronously with a tx
// shim that proxies to our mocks, mirroring how Prisma exposes the
// transactional client.
const transactionMock = vi.fn(async (callback: (tx: unknown) => unknown) => {
	const tx = {
		projectDocument: {
			findUnique: docFindUniqueMock,
			findUniqueOrThrow: docFindUniqueOrThrowMock,
			update: docUpdateMock,
			updateMany: docUpdateManyMock,
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

import { contentIdentity } from "@repo/utils/content-identity";
import {
	DocumentGenerationInProgressError,
	DocumentRegenerationReviewStaleError,
	DocumentVersionConflictError,
	rejectDocumentRegeneration,
} from "../prisma/queries/projects/documents";

describe("rejectDocumentRegeneration", () => {
	beforeEach(() => {
		docFindUniqueMock.mockReset();
		versionFindFirstMock.mockReset();
		versionDeleteMock.mockReset();
		docUpdateMock.mockReset();
		docUpdateManyMock.mockReset();
		docFindUniqueOrThrowMock.mockReset();
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
		docUpdateManyMock.mockResolvedValue({ count: 1 });
		docFindUniqueOrThrowMock.mockResolvedValue(updated);

		const result = await rejectDocumentRegeneration("doc-1", {
			userId: "user-1",
			organizationId: "org-1",
			expectedVersion: 2,
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
		expect(docUpdateManyMock).toHaveBeenCalledTimes(1);
		const updateArgs = docUpdateManyMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
			data: {
				content: string;
				version: number;
				wordCount: number;
				lastEditedBy: string;
			};
		};
		// Conditioned on the reviewed version and the body read.
		expect(updateArgs.where).toEqual({
			id: "doc-1",
			version: 2,
			content: newContent,
		});
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
			rejectDocumentRegeneration("doc-1", {
				userId: "user-1",
				expectedVersion: 1,
			}),
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
			rejectDocumentRegeneration("doc-1", {
				userId: "user-1",
				expectedVersion: 5,
			}),
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
			rejectDocumentRegeneration("doc-1", {
				userId: "user-1",
				expectedVersion: 2,
			}),
		).rejects.toThrow("NO_PRIOR_VERSION");

		expect(versionFindFirstMock).toHaveBeenCalledTimes(1);
		expect(versionDeleteMock).not.toHaveBeenCalled();
		expect(docUpdateMock).not.toHaveBeenCalled();
	});

	it("throws when the document does not exist", async () => {
		docFindUniqueMock.mockResolvedValue(null);

		await expect(
			rejectDocumentRegeneration("missing-doc", {
				userId: "user-1",
				expectedVersion: 2,
			}),
		).rejects.toThrow("Document not found");

		expect(versionFindFirstMock).not.toHaveBeenCalled();
		expect(versionDeleteMock).not.toHaveBeenCalled();
		expect(docUpdateMock).not.toHaveBeenCalled();
	});

	/**
	 * A Proposal's body belongs to its generation run while the run is queued
	 * or writing (Fizzy #2946). A Reject from a review dialog still open when
	 * a newer run starts must not rewind under it. The refusal is the
	 * helper's default for a Proposal; no caller has to ask for it.
	 */
	describe("refusing to rewind under a generation run", () => {
		const NEW = "NEW content from regeneration";
		const OLD = "OLD pre-regen content";
		const armRegenState = (status: string, type = "PROPOSAL") => {
			docFindUniqueMock.mockResolvedValueOnce({
				id: "doc-1",
				version: 2,
				content: NEW,
				status,
				type,
			});
			versionFindFirstMock
				.mockResolvedValueOnce({
					id: "ver-2",
					version: 2,
					content: NEW,
				})
				.mockResolvedValueOnce({
					id: "ver-1",
					version: 1,
					content: OLD,
				});
		};

		it("reads the document's type, which decides the refusal", async () => {
			armRegenState("COMPLETE");
			docUpdateManyMock.mockResolvedValue({ count: 1 });
			docFindUniqueOrThrowMock.mockResolvedValue({
				id: "doc-1",
				version: 1,
				content: OLD,
			});

			await rejectDocumentRegeneration("doc-1", {
				userId: "user-1",
				expectedVersion: 2,
			});

			expect(docFindUniqueMock).toHaveBeenCalledWith(
				expect.objectContaining({
					select: expect.objectContaining({
						type: true,
						status: true,
					}),
				}),
			);
		});

		it.each(["QUEUED", "GENERATING"])(
			"refuses a Proposal read as %s with no caller flag, deleting and writing nothing",
			async (status) => {
				armRegenState(status);

				await expect(
					rejectDocumentRegeneration("doc-1", {
						userId: "user-1",
						expectedVersion: 2,
					}),
				).rejects.toBeInstanceOf(DocumentGenerationInProgressError);
				expect(versionDeleteMock).not.toHaveBeenCalled();
				expect(docUpdateMock).not.toHaveBeenCalled();
				expect(docUpdateManyMock).not.toHaveBeenCalled();
			},
		);

		it("rewinds a finished Proposal conditioned on the version, body and no run", async () => {
			armRegenState("COMPLETE");
			docUpdateManyMock.mockResolvedValue({ count: 1 });
			docFindUniqueOrThrowMock.mockResolvedValue({
				id: "doc-1",
				version: 1,
				content: OLD,
			});

			const result = await rejectDocumentRegeneration("doc-1", {
				userId: "user-1",
				expectedVersion: 2,
			});

			expect(docUpdateMock).not.toHaveBeenCalled();
			expect(docUpdateManyMock).toHaveBeenCalledWith(
				expect.objectContaining({
					where: {
						id: "doc-1",
						version: 2,
						content: NEW,
						status: { notIn: ["QUEUED", "GENERATING"] },
					},
					data: expect.objectContaining({ content: OLD, version: 1 }),
				}),
			);
			expect(result).toEqual({ id: "doc-1", version: 1, content: OLD });
		});

		it("refuses when a run is queued between the read and the rewind", async () => {
			armRegenState("COMPLETE");
			docUpdateManyMock.mockResolvedValue({ count: 0 });
			docFindUniqueMock.mockResolvedValueOnce({
				version: 2,
				status: "QUEUED",
			});

			await expect(
				rejectDocumentRegeneration("doc-1", {
					userId: "user-1",
					expectedVersion: 2,
				}),
			).rejects.toBeInstanceOf(DocumentGenerationInProgressError);
			expect(docFindUniqueOrThrowMock).not.toHaveBeenCalled();
		});

		it("reports a body written in between as a conflict", async () => {
			armRegenState("COMPLETE");
			docUpdateManyMock.mockResolvedValue({ count: 0 });
			docFindUniqueMock.mockResolvedValueOnce({
				version: 2,
				status: "COMPLETE",
			});

			await expect(
				rejectDocumentRegeneration("doc-1", {
					userId: "user-1",
					expectedVersion: 2,
				}),
			).rejects.toBeInstanceOf(DocumentVersionConflictError);
		});

		it("does not refuse a non-Proposal document under a run, but still conditions its rewind on the reviewed version and body", async () => {
			armRegenState("GENERATING", "PRD");
			docUpdateManyMock.mockResolvedValue({ count: 1 });
			docFindUniqueOrThrowMock.mockResolvedValue({
				id: "doc-1",
				version: 1,
				content: OLD,
			});

			await rejectDocumentRegeneration("doc-1", {
				userId: "user-1",
				expectedVersion: 2,
			});

			expect(docUpdateMock).not.toHaveBeenCalled();
			expect(docUpdateManyMock).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { id: "doc-1", version: 2, content: NEW },
				}),
			);
		});
	});

	/**
	 * A review dialog can stay open while a newer run (or a save) writes the
	 * document. A Reject from that stale review must not rewind the newer
	 * write or delete its version row (Fizzy #2946).
	 */
	describe("refusing a Reject from a stale review", () => {
		const RUN_ONE = "Body from the first run";
		const RUN_TWO = "Body from the second run";
		// The first run produced v2; a second run has since written v3.
		const armNewerRun = () => {
			docFindUniqueMock.mockResolvedValueOnce({
				id: "doc-1",
				version: 3,
				content: RUN_TWO,
				status: "COMPLETE",
				type: "PROPOSAL",
			});
			versionFindFirstMock
				.mockResolvedValueOnce({
					id: "ver-3",
					version: 3,
					content: RUN_TWO,
				})
				.mockResolvedValueOnce({
					id: "ver-2",
					version: 2,
					content: RUN_ONE,
				});
		};

		it("refuses when the document moved past the reviewed version, deleting and writing nothing", async () => {
			armNewerRun();

			const attempt = rejectDocumentRegeneration("doc-1", {
				userId: "user-1",
				expectedVersion: 2,
			});

			await expect(attempt).rejects.toBeInstanceOf(
				DocumentRegenerationReviewStaleError,
			);
			await expect(attempt).rejects.toMatchObject({
				reviewedVersion: 2,
				actualVersion: 3,
			});
			expect(versionDeleteMock).not.toHaveBeenCalled();
			expect(docUpdateMock).not.toHaveBeenCalled();
			expect(docUpdateManyMock).not.toHaveBeenCalled();
		});

		it("refuses a non-Proposal document the same way", async () => {
			docFindUniqueMock.mockResolvedValueOnce({
				id: "doc-1",
				version: 3,
				content: RUN_TWO,
				status: "COMPLETE",
				type: "PRD",
			});

			await expect(
				rejectDocumentRegeneration("doc-1", {
					userId: "user-1",
					expectedVersion: 2,
				}),
			).rejects.toBeInstanceOf(DocumentRegenerationReviewStaleError);
			expect(versionDeleteMock).not.toHaveBeenCalled();
			expect(docUpdateManyMock).not.toHaveBeenCalled();
		});

		it("refuses when the body changed at the reviewed version", async () => {
			// A run's final save writes its body before the version moves.
			docFindUniqueMock.mockResolvedValueOnce({
				id: "doc-1",
				version: 2,
				content: RUN_TWO,
				status: "COMPLETE",
				type: "PROPOSAL",
			});

			await expect(
				rejectDocumentRegeneration("doc-1", {
					userId: "user-1",
					expectedVersion: 2,
					expectedContentHash: contentIdentity(RUN_ONE),
				}),
			).rejects.toBeInstanceOf(DocumentRegenerationReviewStaleError);
			expect(versionDeleteMock).not.toHaveBeenCalled();
			expect(docUpdateManyMock).not.toHaveBeenCalled();
		});

		it("rewinds the reviewed body after its version step landed", async () => {
			// The review opened between the run's final save (its body at the
			// old version 2) and the step to version 3.
			armNewerRun();
			docUpdateManyMock.mockResolvedValue({ count: 1 });
			docFindUniqueOrThrowMock.mockResolvedValue({
				id: "doc-1",
				version: 2,
				content: RUN_ONE,
			});

			await rejectDocumentRegeneration("doc-1", {
				userId: "user-1",
				expectedVersion: 2,
				expectedContentHash: contentIdentity(RUN_TWO),
			});

			expect(versionDeleteMock).toHaveBeenCalledWith({
				where: { id: "ver-3" },
			});
			expect(docUpdateManyMock).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						version: 3,
						content: RUN_TWO,
					}),
				}),
			);
		});

		it("refuses a newer body at a higher version even with the reviewed version's identity", async () => {
			armNewerRun();

			await expect(
				rejectDocumentRegeneration("doc-1", {
					userId: "user-1",
					expectedVersion: 2,
					expectedContentHash: contentIdentity(RUN_ONE),
				}),
			).rejects.toBeInstanceOf(DocumentRegenerationReviewStaleError);
			expect(versionDeleteMock).not.toHaveBeenCalled();
			expect(docUpdateManyMock).not.toHaveBeenCalled();
		});

		describe("binding the Reject to the reviewed run", () => {
			const REVIEWED_RUN = new Date("2026-10-01T09:00:00.000Z");
			const NEWER_RUN = new Date("2026-10-01T10:00:00.000Z");
			const armDocument = (row: {
				version: number;
				content: string;
				generationStartedAt: Date | null;
			}) => {
				docFindUniqueMock.mockResolvedValueOnce({
					id: "doc-1",
					status: "COMPLETE",
					type: "PROPOSAL",
					...row,
				});
				versionFindFirstMock
					.mockResolvedValueOnce({
						id: `ver-${row.version}`,
						version: row.version,
						content: row.content,
					})
					.mockResolvedValueOnce({
						id: "ver-prior",
						version: row.version - 1,
						content: "Body before the reviewed run",
					});
			};

			it("refuses a newer run that produced the same body, deleting nothing", async () => {
				// The reviewed run wrote RUN_ONE at v2; a second run produced
				// the very same body and stepped to v3 under its own identity.
				armDocument({
					version: 3,
					content: RUN_ONE,
					generationStartedAt: NEWER_RUN,
				});

				await expect(
					rejectDocumentRegeneration("doc-1", {
						userId: "user-1",
						expectedVersion: 2,
						expectedContentHash: contentIdentity(RUN_ONE),
						expectedGenerationStartedAt: REVIEWED_RUN,
					}),
				).rejects.toBeInstanceOf(DocumentRegenerationReviewStaleError);
				expect(versionDeleteMock).not.toHaveBeenCalled();
				expect(docUpdateManyMock).not.toHaveBeenCalled();
			});

			it("refuses a save followed by a restore of the reviewed body, deleting nothing", async () => {
				// Reviewed at v2; a colleague saved X (v3), then restored the
				// reviewed body (v4). Same body, same run, two steps on.
				armDocument({
					version: 4,
					content: RUN_ONE,
					generationStartedAt: REVIEWED_RUN,
				});

				await expect(
					rejectDocumentRegeneration("doc-1", {
						userId: "user-1",
						expectedVersion: 2,
						expectedContentHash: contentIdentity(RUN_ONE),
						expectedGenerationStartedAt: REVIEWED_RUN,
					}),
				).rejects.toBeInstanceOf(DocumentRegenerationReviewStaleError);
				expect(versionDeleteMock).not.toHaveBeenCalled();
				expect(docUpdateManyMock).not.toHaveBeenCalled();
			});

			it("refuses a version step without the body's identity", async () => {
				armDocument({
					version: 3,
					content: RUN_ONE,
					generationStartedAt: REVIEWED_RUN,
				});

				await expect(
					rejectDocumentRegeneration("doc-1", {
						userId: "user-1",
						expectedVersion: 2,
						expectedGenerationStartedAt: REVIEWED_RUN,
					}),
				).rejects.toBeInstanceOf(DocumentRegenerationReviewStaleError);
				expect(versionDeleteMock).not.toHaveBeenCalled();
			});

			it("rewinds after the reviewed run's own version step", async () => {
				armDocument({
					version: 3,
					content: RUN_ONE,
					generationStartedAt: new Date(REVIEWED_RUN.getTime()),
				});
				docUpdateManyMock.mockResolvedValue({ count: 1 });
				docFindUniqueOrThrowMock.mockResolvedValue({
					id: "doc-1",
					version: 2,
					content: "Body before the reviewed run",
				});

				await rejectDocumentRegeneration("doc-1", {
					userId: "user-1",
					expectedVersion: 2,
					expectedContentHash: contentIdentity(RUN_ONE),
					expectedGenerationStartedAt: REVIEWED_RUN,
				});

				expect(versionDeleteMock).toHaveBeenCalledWith({
					where: { id: "ver-3" },
				});
				expect(docUpdateManyMock).toHaveBeenCalledWith(
					expect.objectContaining({
						where: expect.objectContaining({
							version: 3,
							content: RUN_ONE,
						}),
					}),
				);
			});
		});

		it("rewinds when the document is still the reviewed version and body", async () => {
			armNewerRun();
			docUpdateManyMock.mockResolvedValue({ count: 1 });
			docFindUniqueOrThrowMock.mockResolvedValue({
				id: "doc-1",
				version: 2,
				content: RUN_ONE,
			});

			const result = await rejectDocumentRegeneration("doc-1", {
				userId: "user-1",
				expectedVersion: 3,
				expectedContentHash: contentIdentity(RUN_TWO),
			});

			expect(versionDeleteMock).toHaveBeenCalledWith({
				where: { id: "ver-3" },
			});
			expect(result).toEqual({
				id: "doc-1",
				version: 2,
				content: RUN_ONE,
			});
		});
	});
});
