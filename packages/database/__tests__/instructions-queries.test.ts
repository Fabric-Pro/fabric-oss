import { sqltag } from "@prisma/client/runtime/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvedPullRequestOperation } from "../prisma/queries/instruction-proposal-pull-requests";

// Declared inside `vi.hoisted` because `vi.mock` factories are hoisted above
// the module body: a class declared at the top level of this file would not
// exist yet when the factory below runs.
const { FakePrismaKnownRequestError } = vi.hoisted(() => ({
	FakePrismaKnownRequestError: class extends Error {
		code: string;
		constructor(code: string) {
			super(`prisma error ${code}`);
			this.code = code;
		}
	},
}));

const mocks = vi.hoisted(() => ({
	snapshot: {
		findFirst: vi.fn(),
		create: vi.fn(),
		findUnique: vi.fn(),
		update: vi.fn(),
		findMany: vi.fn(),
		updateMany: vi.fn(),
		deleteMany: vi.fn(),
		// The derived-snapshot interlock's "is anything deriving from this?"
		// read, inside the delete transaction.
		count: vi.fn(),
	},
	file: {
		createMany: vi.fn(),
		findMany: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
		findFirst: vi.fn(),
		deleteMany: vi.fn(),
	},
	project: {
		findFirst: vi.fn(),
		findUnique: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
	},
	// `resolveInstructionSnapshotSource` / `resolveCurrentInstructionRepository`
	// read the project's repository-sync row through `getInstructionRepositorySync`
	// (Fizzy #2709), which selects the joined `repositoryIntegration` from the
	// SAME query — no separate integration table mock is needed.
	repositorySync: {
		findFirst: vi.fn(),
	},
	$transaction: vi.fn(),
	// The reaper's candidate query is raw SQL: one UNIONed relation, so the
	// page is a window of ONE order rather than two separately-skipped ones.
	$queryRaw: vi.fn(),
}));

const auditMocks = vi.hoisted(() => ({ recordAuditTx: vi.fn() }));

vi.mock("../prisma/client", async () => {
	// The real tagged-template builders, so a composed fragment (the
	// retention predicate's SQL form, Fizzy #2563) reaches the fake client
	// exactly as Postgres would get it.
	const { empty, join, raw, sqltag } = await vi.importActual<
		typeof import("@prisma/client/runtime/client")
	>("@prisma/client/runtime/client");
	return {
		db: {
			projectInstructionSnapshot: mocks.snapshot,
			projectInstructionFile: mocks.file,
			project: mocks.project,
			projectInstructionRepositorySync: mocks.repositorySync,
			$transaction: mocks.$transaction,
			$queryRaw: (...a: unknown[]) => mocks.$queryRaw(...a),
		},
		// The error class is used for the `instanceof` + `.code` check that
		// recognizes a version collision.
		Prisma: {
			PrismaClientKnownRequestError: FakePrismaKnownRequestError,
			JsonNull: "JsonNull",
			DbNull: "DbNull",
			AnyNull: "AnyNull",
			empty,
			join,
			raw,
			sql: sqltag,
		},
	};
});

// The rejection verdict and its audit row commit in ONE transaction, so the
// query module now reaches into `audit-log`. Mocked here to keep this a unit
// test of the transition itself: what matters is WHETHER the audit write is
// made and with which transaction client, not what it inserts.
vi.mock("../prisma/queries/audit-log", () => ({
	recordAuditTx: auditMocks.recordAuditTx,
}));

import {
	approveInstructionProposal,
	authorizeInstructionProposalUploadUrls,
	cancelInstructionProposal,
	claimInstructionFileStagingKey,
	claimInstructionSnapshotValidation,
	createInstructionSnapshot,
	deleteInstructionSnapshot,
	failInstructionSnapshot,
	failStaleValidatingInstructionSnapshot,
	getInstructionFileByPath,
	listAbandonedReceivingInstructionSnapshots,
	listInstructionFiles,
	listInstructionSnapshots,
	listPendingAbandonedInstructionSnapshots,
	listProjectsWithPrunableInstructionSnapshots,
	listPrunableInstructionSnapshots,
	listStaleValidatingInstructionSnapshots,
	markAbandonedInstructionSnapshotSwept,
	markInstructionSnapshotReady,
	markInstructionSnapshotRejected,
	publishInstructionSnapshot,
	rejectAbandonedInstructionSnapshot,
	rejectInstructionProposal,
	resolveCurrentInstructionRepository,
	resolveCurrentInstructionSource,
	resolveInstructionSnapshotSource,
	rotateAbandonedInstructionSnapshot,
	startInstructionSnapshotValidation,
	updateInstructionFileMetadata,
} from "../prisma/queries/instructions";

beforeEach(() => {
	for (const group of [
		mocks.snapshot,
		mocks.file,
		mocks.project,
		mocks.repositorySync,
	]) {
		for (const fn of Object.values(group)) fn.mockReset();
	}
	mocks.$transaction.mockReset();
	mocks.$queryRaw.mockReset();
	auditMocks.recordAuditTx.mockReset();
	// Run the transaction callback against the same mocks.
	mocks.$transaction.mockImplementation(
		async (cb: (tx: unknown) => unknown) =>
			cb({
				projectInstructionSnapshot: mocks.snapshot,
				projectInstructionFile: mocks.file,
				project: mocks.project,
				// `publishInstructionSnapshot` takes the project row's write
				// lock through raw SQL before it reads anything.
				$queryRaw: (...a: unknown[]) => mocks.$queryRaw(...a),
			}),
	);
});

describe("listInstructionSnapshots proposal visibility", () => {
	// Fizzy #2563: a REPOSITORY proposal ends MERGED or CLOSED on its pull
	// request, and its proposer follows it to that end in History; other
	// non-reviewers still see only direct and approved versions.
	it("limits non-reviewers to direct, approved, and their own proposals in every status", async () => {
		mocks.snapshot.findMany.mockResolvedValue([]);

		await listInstructionSnapshots("p", "org_1", {
			viewerUserId: "reader",
			canReviewProposals: false,
		});

		expect(mocks.snapshot.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "p",
					organizationId: "org_1",
					OR: [
						{ proposalStatus: null },
						{ proposalStatus: "APPROVED" },
						{ userId: "reader" },
					],
				},
			}),
		);
	});

	it("keeps the tenant-only query for reviewers", async () => {
		mocks.snapshot.findMany.mockResolvedValue([]);

		await listInstructionSnapshots("p", "org_1", {
			viewerUserId: "editor",
			canReviewProposals: true,
		});

		expect(mocks.snapshot.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "p", organizationId: "org_1" },
			}),
		);
	});
});

/**
 * The row `publishInstructionSnapshot`'s locking read returns: the project's
 * current pointer and that pointer's version, in one `SELECT … FOR UPDATE OF p`.
 *
 * Every publish test states it, because the whole transition is decided behind
 * that lock — an unmocked lock read is a test that proves nothing about the
 * ordering the query depends on.
 */
function lockedPointer(
	pointerId: string | null,
	pointerVersion: number | null = null,
) {
	mocks.$queryRaw.mockResolvedValue([{ pointerId, pointerVersion }]);
}

const proposalAudit = {
	action: "project.instructions.published",
	actor: { type: "user", userId: "reviewer" },
	organizationId: "o",
	projectId: "p",
} as const;

describe("instruction proposal decisions", () => {
	it("atomically approves and publishes only from the exact locked base", async () => {
		lockedPointer("base");
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "proposal",
			version: 9,
			status: "READY",
			proposalStatus: "PENDING",
			baseSnapshotId: "base",
		});
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });
		mocks.project.updateMany.mockResolvedValue({ count: 1 });

		expect(
			await approveInstructionProposal({
				snapshotId: "proposal",
				projectId: "p",
				organizationId: "o",
				reviewerUserId: "reviewer",
				audit: proposalAudit,
			}),
		).toEqual({ ok: true, changed: true, version: 9 });
		expect(mocks.snapshot.updateMany).toHaveBeenCalledWith({
			where: {
				id: "proposal",
				projectId: "p",
				organizationId: "o",
				status: "READY",
				proposalStatus: "PENDING",
			},
			data: {
				proposalStatus: "APPROVED",
				reviewerUserId: "reviewer",
				reviewedAt: expect.any(Date),
				publishedAt: expect.any(Date),
			},
		});
		expect(mocks.project.updateMany).toHaveBeenCalledWith({
			where: {
				id: "p",
				organizationId: "o",
				publishedInstructionSnapshotId: "base",
			},
			data: { publishedInstructionSnapshotId: "proposal" },
		});
		expect(
			mocks.snapshot.updateMany.mock.calls[0]![0].data,
		).not.toHaveProperty("rejection");
		expect(auditMocks.recordAuditTx).toHaveBeenCalledWith(
			expect.anything(),
			proposalAudit,
		);
	});

	it("refuses a pending proposal while the repository is the source of truth, and writes nothing", async () => {
		mocks.$queryRaw.mockResolvedValue([
			{
				pointerId: "base",
				pointerVersion: 8,
				instructionSettings: { sourceOfTruth: "REPOSITORY" },
			},
		]);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "proposal",
			version: 9,
			status: "READY",
			proposalStatus: "PENDING",
			baseSnapshotId: "base",
		});

		expect(
			await approveInstructionProposal({
				snapshotId: "proposal",
				projectId: "p",
				organizationId: "o",
				reviewerUserId: "reviewer",
				audit: proposalAudit,
			}),
		).toEqual({ ok: false, reason: "repository_backed" });
		expect(mocks.snapshot.updateMany).not.toHaveBeenCalled();
		expect(mocks.project.updateMany).not.toHaveBeenCalled();
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("leaves a stale proposal pending and writes no audit or pointer", async () => {
		lockedPointer("new-base");
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "proposal",
			version: 8,
			status: "READY",
			proposalStatus: "PENDING",
			baseSnapshotId: "old-base",
		});

		expect(
			await approveInstructionProposal({
				snapshotId: "proposal",
				projectId: "p",
				organizationId: "o",
				reviewerUserId: "reviewer",
				audit: proposalAudit,
			}),
		).toEqual({ ok: false, reason: "stale" });
		expect(mocks.snapshot.updateMany).not.toHaveBeenCalled();
		expect(mocks.project.updateMany).not.toHaveBeenCalled();
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("rejects without changing the published pointer and is retry-idempotent", async () => {
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "proposal",
			version: 8,
			status: "READY",
			proposalStatus: "PENDING",
		});
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });

		expect(
			await rejectInstructionProposal({
				snapshotId: "proposal",
				projectId: "p",
				organizationId: "o",
				reviewerUserId: "reviewer",
				audit: {
					...proposalAudit,
					action: "project.instructions.rejected",
				},
			}),
		).toEqual({ ok: true, changed: true, version: 8 });
		expect(mocks.project.updateMany).not.toHaveBeenCalled();
		expect(auditMocks.recordAuditTx).toHaveBeenCalledTimes(1);
		expect(
			mocks.snapshot.updateMany.mock.calls[0]![0].data,
		).not.toHaveProperty("rejection");

		mocks.snapshot.findFirst.mockResolvedValue({
			id: "proposal",
			version: 8,
			status: "READY",
			proposalStatus: "REJECTED",
		});
		expect(
			await rejectInstructionProposal({
				snapshotId: "proposal",
				projectId: "p",
				organizationId: "o",
				reviewerUserId: "reviewer",
				audit: {
					...proposalAudit,
					action: "project.instructions.rejected",
				},
			}),
		).toEqual({ ok: true, changed: false, version: 8 });
		expect(auditMocks.recordAuditTx).toHaveBeenCalledTimes(1);
	});

	it("rejects a failed proposal terminally so validation retry cannot revive it", async () => {
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "proposal",
			version: 8,
			status: "FAILED",
			proposalStatus: "PENDING",
		});
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });

		await expect(
			rejectInstructionProposal({
				snapshotId: "proposal",
				projectId: "p",
				organizationId: "o",
				reviewerUserId: "reviewer",
				audit: {
					...proposalAudit,
					action: "project.instructions.rejected",
				},
			}),
		).resolves.toEqual({ ok: true, changed: true, version: 8 });
		expect(mocks.snapshot.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ status: "FAILED" }),
				data: expect.objectContaining({
					status: "REJECTED",
					proposalStatus: "REJECTED",
				}),
			}),
		);
	});

	it("lets only the proposer cancel a stable proposal and refuses validating work", async () => {
		mocks.snapshot.findFirst.mockResolvedValueOnce({
			id: "proposal",
			version: 8,
			status: "VALIDATING",
			proposalStatus: "PENDING",
		});
		await expect(
			cancelInstructionProposal({
				snapshotId: "proposal",
				projectId: "p",
				organizationId: "o",
				proposerUserId: "author",
				audit: {
					...proposalAudit,
					action: "project.instructions.rejected",
				},
			}),
		).resolves.toEqual({ ok: false, reason: "in_progress" });
		expect(mocks.snapshot.updateMany).not.toHaveBeenCalled();

		mocks.snapshot.findFirst.mockResolvedValueOnce({
			id: "proposal",
			version: 8,
			status: "RECEIVING",
			proposalStatus: "PENDING",
		});
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });
		await expect(
			cancelInstructionProposal({
				snapshotId: "proposal",
				projectId: "p",
				organizationId: "o",
				proposerUserId: "author",
				audit: {
					...proposalAudit,
					action: "project.instructions.rejected",
				},
			}),
		).resolves.toEqual({
			ok: true,
			changed: true,
			version: 8,
			// A FABRIC proposal has no pull request (Fizzy #2563).
			pullRequest: null,
		});
		expect(mocks.snapshot.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "author",
					status: "RECEIVING",
				}),
				data: expect.objectContaining({
					status: "REJECTED",
					rejection: expect.arrayContaining([
						expect.objectContaining({
							path: "(proposal staging)",
							detail: "staging pending",
						}),
					]),
				}),
			}),
		);
	});

	it("preserves the READY transition's cleanup reservation when canceled", async () => {
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "proposal",
			version: 8,
			status: "READY",
			proposalStatus: "PENDING",
			rejection: [
				{
					path: "(proposal staging)",
					reason: "abandoned",
					detail: "staging pending",
				},
			],
		});
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });

		await cancelInstructionProposal({
			snapshotId: "proposal",
			projectId: "p",
			organizationId: "o",
			proposerUserId: "author",
			audit: {
				...proposalAudit,
				action: "project.instructions.rejected",
			},
		});

		expect(
			mocks.snapshot.updateMany.mock.calls[0]![0].data,
		).not.toHaveProperty("rejection");
	});
});

describe("createInstructionSnapshot", () => {
	it("allocates the next version per project and writes files with the same tenant columns", async () => {
		mocks.snapshot.findFirst.mockResolvedValue({ version: 6 });
		mocks.snapshot.create.mockResolvedValue({ id: "snap_7", version: 7 });
		mocks.file.findMany.mockResolvedValue([
			{ id: "f1", path: "CLAUDE.md", storageKey: "k1" },
		]);

		const result = await createInstructionSnapshot({
			projectId: "proj_1",
			organizationId: "org_1",
			userId: "user_1",
			source: "UPLOAD",
			settingsFrozen: { layer: "default" },
			publishOnReady: true,
			excludedCount: 3,
			files: [
				{
					path: "CLAUDE.md",
					size: 10,
					sha256: "ab",
					mimeType: "text/markdown",
					isText: true,
					kind: "INSTRUCTIONS",
					storageKey: "k1",
				},
			],
		});

		expect(mocks.snapshot.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					projectId: "proj_1",
					organizationId: "org_1",
					userId: "user_1",
					version: 7,
					status: "RECEIVING",
				}),
			}),
		);
		expect(mocks.file.createMany).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({
					snapshotId: "snap_7",
					projectId: "proj_1",
					organizationId: "org_1",
					userId: "user_1",
					path: "CLAUDE.md",
				}),
			],
		});
		expect(result).toEqual({
			id: "snap_7",
			version: 7,
			files: [{ id: "f1", path: "CLAUDE.md", storageKey: "k1" }],
		});
	});

	/**
	 * The version is allocated read-then-write inside the transaction, which
	 * READ COMMITTED does not serialize: two uploads starting on one project
	 * at the same moment both read version N and both insert N + 1, and
	 * `@@unique([projectId, version])` fails the loser with P2002. Without a
	 * retry that surfaced at `begin` as a raw Prisma error — a 500 with a
	 * driver message — for an ordinary "two people uploaded together".
	 */
	describe("concurrent version allocation", () => {
		const input = {
			projectId: "proj_1",
			organizationId: "org_1",
			userId: "user_1",
			source: "UPLOAD" as const,
			settingsFrozen: { layer: "default" },
			publishOnReady: true,
			excludedCount: 0,
			files: [
				{
					path: "CLAUDE.md",
					size: 10,
					sha256: "ab",
					mimeType: "text/markdown",
					isText: true,
					kind: "INSTRUCTIONS" as const,
					storageKey: "k1",
				},
			],
		};

		it("re-reads the winning version and retries after a P2002 collision", async () => {
			// First attempt sees version 6 and loses the insert; the retry
			// re-reads and finds the winner committed at 7.
			mocks.snapshot.findFirst
				.mockResolvedValueOnce({ version: 6 })
				.mockResolvedValueOnce({ version: 7 });
			mocks.snapshot.create
				.mockRejectedValueOnce(new FakePrismaKnownRequestError("P2002"))
				.mockResolvedValueOnce({ id: "snap_8", version: 8 });
			mocks.file.findMany.mockResolvedValue([
				{ id: "f1", path: "CLAUDE.md", storageKey: "k1" },
			]);

			const result = await createInstructionSnapshot(input);

			expect(mocks.snapshot.create).toHaveBeenCalledTimes(2);
			expect(mocks.snapshot.create.mock.calls[1]![0]).toMatchObject({
				data: expect.objectContaining({ version: 8 }),
			});
			expect(result.version).toBe(8);
		});

		it("gives up after the attempt budget and rethrows the collision", async () => {
			mocks.snapshot.findFirst.mockResolvedValue({ version: 6 });
			mocks.snapshot.create.mockRejectedValue(
				new FakePrismaKnownRequestError("P2002"),
			);

			await expect(createInstructionSnapshot(input)).rejects.toThrow(
				/P2002/,
			);
			expect(mocks.snapshot.create).toHaveBeenCalledTimes(3);
		});

		it("rethrows any other Prisma error immediately, without retrying", async () => {
			mocks.snapshot.findFirst.mockResolvedValue({ version: 6 });
			mocks.snapshot.create.mockRejectedValue(
				new FakePrismaKnownRequestError("P2003"),
			);

			await expect(createInstructionSnapshot(input)).rejects.toThrow(
				/P2003/,
			);
			expect(mocks.snapshot.create).toHaveBeenCalledTimes(1);
		});
	});

	describe("repository sync rows (spec §4.2)", () => {
		const syncInput = {
			projectId: "proj_1",
			organizationId: "org_1",
			userId: "user_1",
			source: "REPOSITORY" as const,
			settingsFrozen: {
				layer: "default",
				syncId: "sync_1",
				syncGeneration: 2,
			},
			publishOnReady: true,
			excludedCount: 0,
			repositoryIntegrationId: "int_1",
			sourceRef: "main",
			sourceCommitSha: "c0ffee",
			syncRunKey: "sync_1:run_a",
			files: [
				{
					path: "run.sh",
					size: 10,
					sha256: "ab",
					mimeType: "text/x-shellscript",
					isText: true,
					kind: "SCRIPT" as const,
					storageKey: "k1",
					mode: 0o755,
				},
			],
		};

		it("writes the repository columns, the run key and each file's git mode", async () => {
			mocks.snapshot.findFirst.mockResolvedValue({ version: 1 });
			mocks.snapshot.create.mockResolvedValue({
				id: "snap_2",
				version: 2,
			});
			mocks.file.findMany.mockResolvedValue([]);

			await createInstructionSnapshot(syncInput);

			expect(mocks.snapshot.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						source: "REPOSITORY",
						repositoryIntegrationId: "int_1",
						sourceRef: "main",
						sourceCommitSha: "c0ffee",
						syncRunKey: "sync_1:run_a",
					}),
				}),
			);
			expect(mocks.file.createMany).toHaveBeenCalledWith({
				data: [
					expect.objectContaining({ path: "run.sh", mode: 0o755 }),
				],
			});
		});

		it("returns the row a concurrent attempt of the SAME run created instead of allocating another version", async () => {
			mocks.snapshot.findFirst
				.mockResolvedValueOnce({ version: 1 }) // version read in the losing transaction
				.mockResolvedValueOnce({ id: "snap_winner", version: 2 }); // lookup by run key
			mocks.snapshot.create.mockRejectedValueOnce(
				new FakePrismaKnownRequestError("P2002"),
			);
			mocks.file.findMany.mockResolvedValueOnce([
				{ id: "f1", path: "run.sh", storageKey: "k1" },
			]);

			expect(await createInstructionSnapshot(syncInput)).toEqual({
				id: "snap_winner",
				version: 2,
				files: [{ id: "f1", path: "run.sh", storageKey: "k1" }],
				existing: true,
			});
			expect(mocks.snapshot.create).toHaveBeenCalledTimes(1);
			expect(mocks.snapshot.findFirst).toHaveBeenLastCalledWith({
				where: {
					syncRunKey: "sync_1:run_a",
					projectId: "proj_1",
					organizationId: "org_1",
				},
				select: { id: true, version: true },
			});
		});

		it("treats a P2002 with no row under the run key as an ordinary version collision and retries", async () => {
			mocks.snapshot.findFirst
				.mockResolvedValueOnce({ version: 1 })
				.mockResolvedValueOnce(null) // nothing under the run key
				.mockResolvedValueOnce({ version: 2 });
			mocks.snapshot.create
				.mockRejectedValueOnce(new FakePrismaKnownRequestError("P2002"))
				.mockResolvedValueOnce({ id: "snap_3", version: 3 });
			mocks.file.findMany.mockResolvedValue([]);

			expect(await createInstructionSnapshot(syncInput)).toEqual({
				id: "snap_3",
				version: 3,
				files: [],
			});
		});
	});
});

describe("publishInstructionSnapshot", () => {
	it("refuses pending and rejected proposals outside the approval transaction", async () => {
		for (const proposalStatus of ["PENDING", "REJECTED"] as const) {
			lockedPointer("base", 7);
			mocks.snapshot.findFirst.mockResolvedValueOnce({
				id: "proposal",
				status: "READY",
				proposalStatus,
				version: 8,
				baseSnapshotId: "base",
				baseVersion: 7,
				publishedAt: null,
			});
			expect(
				await publishInstructionSnapshot({
					snapshotId: "proposal",
					projectId: "p",
					organizationId: "o",
					allowRollback: true,
				}),
			).toEqual({
				published: false,
				changed: false,
				reason: "proposal_not_approved",
			});
		}
		expect(mocks.project.updateMany).not.toHaveBeenCalled();
	});

	it("refuses a snapshot that is not READY", async () => {
		lockedPointer(null);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "s",
			status: "VALIDATING",
			version: 8,
			publishedAt: null,
		});
		expect(
			await publishInstructionSnapshot({
				snapshotId: "s",
				projectId: "p",
				organizationId: "o",
			}),
		).toEqual({ published: false, changed: false, reason: "not_ready" });
		expect(mocks.project.updateMany).not.toHaveBeenCalled();
	});

	/**
	 * The transition is serialized on the PROJECT ROW, and the order is the
	 * point: lock, then read the snapshot, then write. The conditional write
	 * takes that lock anyway; taking it first is what makes the
	 * already-published marker and the reported previous version describe the
	 * same moment as the write instead of a `READ COMMITTED` snapshot from
	 * before someone else's commit.
	 */
	it("locks the project row before it reads anything, and reports not_found when there is no such project", async () => {
		mocks.$queryRaw.mockResolvedValue([]);

		expect(
			await publishInstructionSnapshot({
				snapshotId: "s",
				projectId: "p",
				organizationId: "o",
			}),
		).toEqual({ published: false, changed: false, reason: "not_found" });
		// Nothing was read or written on the back of a project row that does
		// not match this organization.
		expect(mocks.snapshot.findFirst).not.toHaveBeenCalled();
		expect(mocks.project.updateMany).not.toHaveBeenCalled();

		const sql = String(mocks.$queryRaw.mock.calls[0]?.[0]);
		expect(sql).toContain("FOR UPDATE OF p");
		expect(sql).toContain('FROM "project" p');
		expect(sql).toContain('p."organizationId"');
	});

	it("takes the lock first and the snapshot row second", async () => {
		const order: string[] = [];
		mocks.$queryRaw.mockImplementation(async () => {
			order.push("lock");
			return [{ pointerId: null, pointerVersion: null }];
		});
		mocks.snapshot.findFirst.mockImplementation(async () => {
			order.push("snapshot");
			return { id: "s", status: "READY", version: 8, publishedAt: null };
		});
		mocks.project.updateMany.mockImplementation(async () => {
			order.push("write");
			return { count: 1 };
		});

		await publishInstructionSnapshot({
			snapshotId: "s",
			projectId: "p",
			organizationId: "o",
		});

		expect(order).toEqual(["lock", "snapshot", "write"]);
	});

	// `changed` is what the publish ACTIVITY audits on: it distinguishes the
	// one call that actually moved the pointer from the idempotent retry
	// below, which also reports `published: true`. Auditing on `published`
	// would write a row per Temporal retry for a publication that happened
	// once.
	it("moves the pointer and stamps publishedAt via a single conditional write", async () => {
		lockedPointer("older-snap", 7);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "s",
			status: "READY",
			version: 8,
			publishedAt: null,
		});
		mocks.project.updateMany.mockResolvedValue({ count: 1 });
		expect(
			await publishInstructionSnapshot({
				snapshotId: "s",
				projectId: "p",
				organizationId: "o",
			}),
		).toEqual({ published: true, changed: true });
		expect(mocks.project.updateMany).toHaveBeenCalledWith({
			where: {
				id: "p",
				organizationId: "o",
				OR: [
					{ publishedInstructionSnapshotId: null },
					{ publishedInstructionSnapshot: { version: { lt: 8 } } },
				],
			},
			data: { publishedInstructionSnapshotId: "s" },
		});
		expect(mocks.snapshot.update).toHaveBeenCalledWith({
			where: { id: "s" },
			data: { publishedAt: expect.any(Date) },
		});
	});

	it("is idempotent: republishing the snapshot that is already the pointer returns published:true with no write", async () => {
		// Already the pointer, and `publishedAt` still null in this scenario
		// so the answer comes from the predicate rather than from the
		// already-published marker (which the suite below covers).
		lockedPointer("s", 8);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "s",
			status: "READY",
			version: 8,
			publishedAt: null,
		});
		// The conditional write matches nothing because publishedInstructionSnapshotId
		// is already "s" (not null, and not a lower version than itself).
		mocks.project.updateMany.mockResolvedValue({ count: 0 });
		expect(
			await publishInstructionSnapshot({
				snapshotId: "s",
				projectId: "p",
				organizationId: "o",
			}),
		).toEqual({ published: true, changed: false });
		expect(mocks.snapshot.update).not.toHaveBeenCalled();
		// Answered from the locked read, not from a second unlocked one that
		// could describe a later moment than the write.
		expect(mocks.project.findUnique).not.toHaveBeenCalled();
	});

	it("refuses when the conditional write matches nothing and the pointer belongs to a different, newer snapshot", async () => {
		lockedPointer("newer-snap", 9);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "s",
			status: "READY",
			version: 5,
			publishedAt: null,
		});
		mocks.project.updateMany.mockResolvedValue({ count: 0 });
		expect(
			await publishInstructionSnapshot({
				snapshotId: "s",
				projectId: "p",
				organizationId: "o",
			}),
		).toEqual({
			published: false,
			changed: false,
			reason: "older_than_current",
		});
		expect(mocks.snapshot.update).not.toHaveBeenCalled();
	});
});

/**
 * `allowRollback` — History's "Roll back to this version".
 *
 * The version rule above is a RACE GUARD: it stops a slow automatic
 * publish-on-ready from moving the pointer backwards behind someone's back.
 * It was also refusing the one act it was never written to refuse — a person
 * opening History, seeing what is published, and deliberately choosing an
 * earlier version — with "A newer version is already published", which reads
 * as a bug because it is one. This flag replaces the version predicate with
 * the only condition a deliberate publish needs: that this snapshot is not
 * already the pointer.
 */
describe("publishInstructionSnapshot with allowRollback", () => {
	const input = {
		projectId: "p",
		organizationId: "o",
		allowRollback: true,
	};

	it("moves the pointer back to an older READY version and reports both ends of the move", async () => {
		// v9 holds the pointer, and the audit row's `previousVersion` comes
		// from this locked read — not from a second, unlocked one.
		lockedPointer("v9", 9);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "v7",
			status: "READY",
			version: 7,
			baseSnapshotId: null,
			baseVersion: null,
			// Published before and rolled away from: the marker that stops an
			// automatic retry is deliberately ignored here.
			publishedAt: new Date("2026-09-01T00:00:00.000Z"),
		});
		mocks.project.updateMany.mockResolvedValue({ count: 1 });

		expect(
			await publishInstructionSnapshot({ ...input, snapshotId: "v7" }),
		).toEqual({
			published: true,
			changed: true,
			version: 7,
			previousVersion: 9,
		});
		// The predicate is "anything but this snapshot", still one conditional
		// write. The null arm is load-bearing: `{ not: id }` does not match a
		// NULL column, so a project publishing for the first time needs it.
		expect(mocks.project.updateMany).toHaveBeenCalledWith({
			where: {
				id: "p",
				organizationId: "o",
				OR: [
					{ publishedInstructionSnapshotId: null },
					{ publishedInstructionSnapshotId: { not: "v7" } },
				],
			},
			data: { publishedInstructionSnapshotId: "v7" },
		});
		expect(mocks.snapshot.update).toHaveBeenCalledWith({
			where: { id: "v7" },
			data: { publishedAt: expect.any(Date) },
		});
		// `previousVersion` came from the locked read and nowhere else. An
		// unlocked pre-read let two concurrent manual publishes both report
		// the version they saw first, which mislabelled the loser's audit row
		// — the one place this value is supposed to be authoritative.
		expect(mocks.project.findUnique).not.toHaveBeenCalled();
		expect(mocks.$queryRaw).toHaveBeenCalledTimes(1);
	});

	// `changed: false` is what keeps the procedure from writing a second audit
	// row for one pointer transition — a lost response plus a retry.
	it("is idempotent: publishing the version that is already the pointer writes nothing", async () => {
		lockedPointer("v7", 7);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "v7",
			status: "READY",
			version: 7,
			baseSnapshotId: null,
			baseVersion: null,
			publishedAt: new Date("2026-09-01T00:00:00.000Z"),
		});
		// Its own arm excludes it, so the write matches nothing.
		mocks.project.updateMany.mockResolvedValue({ count: 0 });

		expect(
			await publishInstructionSnapshot({ ...input, snapshotId: "v7" }),
		).toEqual({
			published: true,
			changed: false,
			version: 7,
			previousVersion: 7,
		});
		expect(mocks.snapshot.update).not.toHaveBeenCalled();
	});

	it("still refuses a snapshot that is not READY, and writes nothing", async () => {
		lockedPointer("v9", 9);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "v7",
			status: "REJECTED",
			version: 7,
			publishedAt: null,
		});

		expect(
			await publishInstructionSnapshot({ ...input, snapshotId: "v7" }),
		).toEqual({ published: false, changed: false, reason: "not_ready" });
		expect(mocks.project.updateMany).not.toHaveBeenCalled();
		expect(mocks.snapshot.update).not.toHaveBeenCalled();
	});

	it("publishes the first version of a project that has published nothing yet", async () => {
		lockedPointer(null, null);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "v1",
			status: "READY",
			version: 1,
			baseSnapshotId: null,
			baseVersion: null,
			publishedAt: null,
		});
		mocks.project.updateMany.mockResolvedValue({ count: 1 });

		expect(
			await publishInstructionSnapshot({ ...input, snapshotId: "v1" }),
		).toEqual({
			published: true,
			changed: true,
			version: 1,
			previousVersion: null,
		});
	});

	// The two flags are opposite instructions — refuse anything but a
	// fast-forward, accept anything at all — so silently letting one win would
	// mean an AUTOMATIC publish able to roll the pointer back.
	it("refuses to be combined with requireBaseUnmoved", async () => {
		await expect(
			publishInstructionSnapshot({
				...input,
				snapshotId: "v7",
				requireBaseUnmoved: true,
			}),
		).rejects.toThrow(/mutually exclusive/);
		expect(mocks.snapshot.findFirst).not.toHaveBeenCalled();
		// Refused before the transaction opens, so not even the lock is taken.
		expect(mocks.$queryRaw).not.toHaveBeenCalled();
	});

	// The automatic path is untouched: without the flag the version rule is
	// still the predicate and an older version is still refused.
	it("leaves the automatic path on the version rule when the flag is absent", async () => {
		lockedPointer("v9", 9);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "v7",
			status: "READY",
			version: 7,
			baseSnapshotId: null,
			baseVersion: null,
			publishedAt: null,
		});
		mocks.project.updateMany.mockResolvedValue({ count: 0 });

		expect(
			await publishInstructionSnapshot({
				snapshotId: "v7",
				projectId: "p",
				organizationId: "o",
			}),
		).toEqual({
			published: false,
			changed: false,
			reason: "older_than_current",
		});
		expect(mocks.project.updateMany).toHaveBeenCalledWith({
			where: {
				id: "p",
				organizationId: "o",
				OR: [
					{ publishedInstructionSnapshotId: null },
					{ publishedInstructionSnapshot: { version: { lt: 7 } } },
				],
			},
			data: { publishedInstructionSnapshotId: "v7" },
		});
	});
});

/**
 * BLOCKING (rollback review, round 1). A rollback has to survive an ordinary
 * at-least-once retry.
 *
 * The automatic publication of v9 commits; its Temporal completion
 * acknowledgement is lost; a person rolls the project back to v7; the activity
 * retries. Under the version rule alone the retry sees 7 < 9 and republishes
 * v9 — and a derived v9 does the same when the rollback happened to land on
 * its exact base. The rollback looked like it worked and then evaporated,
 * leaving a second automatic audit row for one publication.
 *
 * `publishedAt` is the durable marker that closes it: nothing clears it, so a
 * non-null value means this snapshot has held the pointer already and the
 * automatic path has nothing left to do. It is read behind the project row's
 * lock, so the answer cannot be stale. The manual path ignores it.
 */
describe("publishInstructionSnapshot: an automatic publish applies at most once", () => {
	it("writes nothing when a rolled-back full upload's automatic publish is retried", async () => {
		// v7 is published again after the rollback; v9 has already published.
		lockedPointer("v7", 7);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "v9",
			status: "READY",
			version: 9,
			baseSnapshotId: null,
			baseVersion: null,
			publishedAt: new Date("2026-09-17T10:00:00.000Z"),
		});

		expect(
			await publishInstructionSnapshot({
				snapshotId: "v9",
				projectId: "p",
				organizationId: "o",
			}),
		).toEqual({ published: true, changed: false });
		// The version rule would have matched here — 7 < 9 — which is exactly
		// the republication this refuses.
		expect(mocks.project.updateMany).not.toHaveBeenCalled();
		expect(mocks.snapshot.update).not.toHaveBeenCalled();
	});

	it("writes nothing when a rolled-back derived version's fast-forward is retried onto its own base", async () => {
		// The rollback landed on v8, which is v9's base, so the fast-forward
		// predicate would match again.
		lockedPointer("v8", 8);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "v9",
			status: "READY",
			version: 9,
			baseSnapshotId: "v8",
			baseVersion: 8,
			publishedAt: new Date("2026-09-17T10:00:00.000Z"),
		});

		expect(
			await publishInstructionSnapshot({
				snapshotId: "v9",
				projectId: "p",
				organizationId: "o",
				requireBaseUnmoved: true,
			}),
		).toEqual({ published: true, changed: false });
		expect(mocks.project.updateMany).not.toHaveBeenCalled();
		expect(mocks.snapshot.update).not.toHaveBeenCalled();
	});

	// The marker says "has published", not "may not publish": a snapshot that
	// never held the pointer publishes automatically exactly as before.
	it("still publishes a snapshot that has never held the pointer", async () => {
		lockedPointer("v8", 8);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "v9",
			status: "READY",
			version: 9,
			baseSnapshotId: null,
			baseVersion: null,
			publishedAt: null,
		});
		mocks.project.updateMany.mockResolvedValue({ count: 1 });

		expect(
			await publishInstructionSnapshot({
				snapshotId: "v9",
				projectId: "p",
				organizationId: "o",
			}),
		).toEqual({ published: true, changed: true });
		expect(mocks.snapshot.update).toHaveBeenCalledWith({
			where: { id: "v9" },
			data: { publishedAt: expect.any(Date) },
		});
	});

	// The manual act is the override, and it has to stay one: the version a
	// person picks in History is usually one that was published before.
	it("lets the manual path republish a version that has published before", async () => {
		lockedPointer("v9", 9);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "v7",
			status: "READY",
			version: 7,
			baseSnapshotId: null,
			baseVersion: null,
			publishedAt: new Date("2026-09-10T10:00:00.000Z"),
		});
		mocks.project.updateMany.mockResolvedValue({ count: 1 });

		expect(
			await publishInstructionSnapshot({
				snapshotId: "v7",
				projectId: "p",
				organizationId: "o",
				allowRollback: true,
			}),
		).toEqual({
			published: true,
			changed: true,
			version: 7,
			previousVersion: 9,
		});
	});
});

/**
 * BLOCKING (round 5). The version rule is not enough for a DERIVED snapshot.
 *
 * An edit is a base plus a change set: its unchanged files are the base's,
 * inherited by pointing at that version's promoted objects. Two people
 * editing published v7 therefore get v8 and v9, each holding v7's other
 * files. Under the version rule both publish in turn, and v9 — which never
 * saw the first edit — silently reverts it. The derive-time check cannot
 * close this: both derivations pass it, because at derive time v7 really is
 * published for both.
 *
 * So the AUTOMATIC publish is a fast-forward, in the conditional write
 * itself: the project's published pointer must still be the exact base this
 * snapshot was derived from. The base is read from the snapshot ROW, so a
 * retried Temporal activity cannot hand in a different one and the workflow
 * needs no new input.
 */
describe("publishInstructionSnapshot with requireBaseUnmoved", () => {
	const input = {
		projectId: "p",
		organizationId: "o",
		requireBaseUnmoved: true,
	};

	it("publishes two edits of the same base in version order, and only the first moves the pointer", async () => {
		// A derives v8 from the published v7; B derives v9 from the same v7.
		// Both are READY, both are publishOnReady, and they finish in version
		// order.
		lockedPointer("v7", 7);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "v8",
			status: "READY",
			version: 8,
			baseSnapshotId: "v7",
			baseVersion: 7,
			publishedAt: null,
		});
		mocks.project.updateMany.mockResolvedValue({ count: 1 });

		expect(
			await publishInstructionSnapshot({ ...input, snapshotId: "v8" }),
		).toEqual({ published: true, changed: true });
		// The CAS is on the BASE's id, not on the version — and it is the
		// whole predicate, so there is no `OR` arm left for a newer version
		// to satisfy.
		expect(mocks.project.updateMany).toHaveBeenCalledWith({
			where: {
				id: "p",
				organizationId: "o",
				publishedInstructionSnapshotId: "v7",
			},
			data: { publishedInstructionSnapshotId: "v8" },
		});

		mocks.snapshot.update.mockClear();
		// The pointer is v8 now, and B's lock read sees it.
		lockedPointer("v8", 8);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "v9",
			status: "READY",
			version: 9,
			baseSnapshotId: "v7",
			baseVersion: 7,
			publishedAt: null,
		});
		// B's write matches nothing — where the version rule would have
		// matched, 8 < 9.
		mocks.project.updateMany.mockResolvedValue({ count: 0 });

		expect(
			await publishInstructionSnapshot({ ...input, snapshotId: "v9" }),
		).toEqual({
			published: false,
			changed: false,
			// Distinct from `older_than_current`: v9 is NEWER, it is intact,
			// and it is still in History to be published deliberately.
			reason: "base_moved",
		});
		// Nothing was written: no pointer move, no publishedAt stamp.
		expect(mocks.snapshot.update).not.toHaveBeenCalled();
	});

	// The pointer-equality arm, reached with the already-published marker NOT
	// yet set on the row. A real Temporal retry of a completed publish carries
	// the marker and is answered earlier (see the at-most-once suite above);
	// this pins the fail-safe underneath it, which every predicate relies on:
	// once this snapshot holds the pointer, the fast-forward's own condition
	// is necessarily false and the call must not read as a conflict against
	// itself.
	it("answers a call for the snapshot that already holds the pointer as published, without writing", async () => {
		lockedPointer("v8", 8);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "v8",
			status: "READY",
			version: 8,
			baseSnapshotId: "v7",
			baseVersion: 7,
			publishedAt: null,
		});
		mocks.project.updateMany.mockResolvedValue({ count: 0 });

		expect(
			await publishInstructionSnapshot({ ...input, snapshotId: "v8" }),
		).toEqual({ published: true, changed: false });
		expect(mocks.snapshot.update).not.toHaveBeenCalled();
	});

	it("keeps the version rule for a full upload, which replaces the whole tree", async () => {
		lockedPointer("older-snap", 7);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "s",
			status: "READY",
			version: 8,
			baseSnapshotId: null,
			baseVersion: null,
			publishedAt: null,
		});
		mocks.project.updateMany.mockResolvedValue({ count: 1 });

		expect(
			await publishInstructionSnapshot({ ...input, snapshotId: "s" }),
		).toEqual({ published: true, changed: true });
		// An upload IS the whole tree — it inherits nothing — so replacing a
		// newer pointer loses nothing that was not being replaced anyway.
		expect(mocks.project.updateMany).toHaveBeenCalledWith({
			where: {
				id: "p",
				organizationId: "o",
				OR: [
					{ publishedInstructionSnapshotId: null },
					{ publishedInstructionSnapshot: { version: { lt: 8 } } },
				],
			},
			data: { publishedInstructionSnapshotId: "s" },
		});
	});

	/**
	 * BLOCKING, round two. `baseSnapshotId` is `ON DELETE SET NULL` and a
	 * READY derived snapshot does NOT pin its base — it stands on its own
	 * promoted objects — so the base can be deleted or pruned in the window
	 * between READY and the publish activity. Deciding "is this derived?" by
	 * the id there meant such a snapshot read itself as a full upload,
	 * published on the version rule, and reverted the edit that had taken the
	 * pointer in the meantime, with nothing in the tab to explain it.
	 */
	it("refuses a derived version whose base has been deleted, without writing anything", async () => {
		lockedPointer("v8", 8);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "v9",
			status: "READY",
			version: 9,
			// v7 was deleted or pruned after this row reached READY.
			baseSnapshotId: null,
			// The durable half. Nothing in the lifecycle clears it, so it
			// still says this version is an EDIT of v7 and not a tree of its
			// own.
			baseVersion: 7,
			publishedAt: null,
		});

		expect(
			await publishInstructionSnapshot({ ...input, snapshotId: "v9" }),
		).toEqual({
			published: false,
			changed: false,
			reason: "base_moved",
		});
		// No conditional write at all: a vanished base certainly is not the
		// published pointer, and there is no predicate that would make this
		// publication safe. Emphatically NOT the version rule, which 8 < 9
		// would have satisfied.
		expect(mocks.project.updateMany).not.toHaveBeenCalled();
		expect(mocks.snapshot.update).not.toHaveBeenCalled();
	});

	it("still reports the retry of a published edit whose base has since gone as published", async () => {
		// This snapshot IS the pointer: it published, and then its base aged
		// out of retention. A Temporal retry landing here must be idempotent
		// rather than reporting a conflict against itself — and it carries the
		// already-published marker, which answers it before the base-is-gone
		// arm is even reached.
		lockedPointer("v9", 9);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "v9",
			status: "READY",
			version: 9,
			baseSnapshotId: null,
			baseVersion: 7,
			publishedAt: new Date("2026-09-17T10:00:00.000Z"),
		});

		expect(
			await publishInstructionSnapshot({ ...input, snapshotId: "v9" }),
		).toEqual({ published: true, changed: false });
		expect(mocks.project.updateMany).not.toHaveBeenCalled();
		expect(mocks.snapshot.update).not.toHaveBeenCalled();
	});

	// The manual History publish no longer takes this path at all — it passes
	// `allowRollback` (suite above) — but a call with NEITHER flag still falls
	// back to the version rule, which is what a derived snapshot published by
	// anything other than the publish-on-ready activity would get.
	it("leaves a call with neither flag on the version rule", async () => {
		lockedPointer("v7", 7);
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "v9",
			status: "READY",
			version: 9,
			baseSnapshotId: "v7",
			baseVersion: 7,
			publishedAt: null,
		});
		mocks.project.updateMany.mockResolvedValue({ count: 1 });

		// No `requireBaseUnmoved`, so the fast-forward is not asked for and
		// the row's derived-ness changes nothing about the predicate.
		expect(
			await publishInstructionSnapshot({
				snapshotId: "v9",
				projectId: "p",
				organizationId: "o",
			}),
		).toEqual({ published: true, changed: true });
		expect(mocks.project.updateMany).toHaveBeenCalledWith({
			where: {
				id: "p",
				organizationId: "o",
				OR: [
					{ publishedInstructionSnapshotId: null },
					{ publishedInstructionSnapshot: { version: { lt: 9 } } },
				],
			},
			data: { publishedInstructionSnapshotId: "v9" },
		});
	});
});

/**
 * I3: the published pointer's foreign key is `onDelete: Restrict`, so the
 * database refuses to delete a published snapshot. It was `SetNull`, which
 * made the delete succeed and silently clear the pointer — leaving the project
 * with no published coding instructions at all — whenever a publish won the
 * race against the read-then-delete check the callers relied on.
 */
describe("deleteInstructionSnapshot", () => {
	/**
	 * LOCK ORDER, which is the reason this statement exists at all.
	 *
	 * A derivation that claims the published pointer locks the project row
	 * and then inserts a child that takes a key-share lock on the base
	 * snapshot. This transaction used to go the other way: delete the
	 * snapshot row first, at which point the `onDelete: Restrict` foreign key
	 * on `Project.publishedInstructionSnapshot` makes PostgreSQL lock the
	 * project row to decide whether the delete is allowed. Two transactions
	 * taking the same two rows in opposite orders deadlock, and the
	 * derivation's retry loop only understands version collisions, so it
	 * surfaces as a failed save rather than a retry.
	 */
	it("locks the project row BEFORE deleting anything", async () => {
		mocks.file.deleteMany.mockResolvedValue({ count: 0 });
		mocks.snapshot.deleteMany.mockResolvedValue({ count: 1 });
		mocks.$queryRaw.mockResolvedValue([{ id: "p" }]);

		await deleteInstructionSnapshot("s", "p", "org_1");

		expect(mocks.$queryRaw).toHaveBeenCalledTimes(1);
		const sql = (mocks.$queryRaw.mock.calls[0]![0] as string[]).join("?");
		expect(sql).toContain("FOR UPDATE OF p");
		// Both deletes come after it, so every path in this feature takes
		// project first, then snapshot.
		expect(mocks.$queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(
			mocks.file.deleteMany.mock.invocationCallOrder[0]!,
		);
		expect(mocks.$queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(
			mocks.snapshot.deleteMany.mock.invocationCallOrder[0]!,
		);
	});

	it("deletes the file rows and the snapshot row in one tenant-scoped transaction", async () => {
		mocks.file.deleteMany.mockResolvedValue({ count: 3 });
		mocks.snapshot.deleteMany.mockResolvedValue({ count: 1 });

		expect(await deleteInstructionSnapshot("s", "p", "org_1")).toEqual({
			deleted: true,
		});
		expect(mocks.file.deleteMany).toHaveBeenCalledWith({
			where: { snapshotId: "s", projectId: "p", organizationId: "org_1" },
		});
		expect(mocks.snapshot.deleteMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: "s",
				projectId: "p",
				organizationId: "org_1",
				// Important 3 (round 4): terminal only, enforced by the DELETE
				// itself rather than by a read above it or by the tab hiding
				// the button.
				status: { in: ["READY", "REJECTED", "FAILED"] },
				// A snapshot an in-flight EDIT is deriving from cannot go
				// either: that edit's inherited rows point at this snapshot's
				// promoted objects until its own promotion rewrites them, and
				// the storage delete after this transaction would take them.
				derivedSnapshots: {
					none: {
						status: { in: ["RECEIVING", "VALIDATING", "FAILED"] },
					},
				},
			}),
		});
		const deleteWhere = mocks.snapshot.deleteMany.mock.calls[0]![0].where;
		expect(JSON.stringify(deleteWhere.AND)).toContain("(proposal staging)");
	});

	it("refuses a snapshot whose workflow is still running, and undoes the file delete", async () => {
		mocks.file.deleteMany.mockResolvedValue({ count: 3 });
		// The status predicate matched nothing, but the row is still there.
		mocks.snapshot.deleteMany.mockResolvedValue({ count: 0 });
		mocks.snapshot.findFirst.mockResolvedValue({ id: "s" });

		expect(await deleteInstructionSnapshot("s", "p", "org_1")).toEqual({
			deleted: false,
			reason: "active",
		});
	});

	/**
	 * The derived-snapshot interlock. A READY snapshot an in-flight edit is
	 * deriving from survives the DELETE's relation filter, and the caller has
	 * to learn WHICH refusal it hit: the delete procedure says "an edit of
	 * this version is still being checked", which is actionable, where
	 * "still being checked" about the snapshot itself is not true and not
	 * actionable.
	 */
	// The set includes FAILED: a failed edit is retryable ("Try again" moves
	// it back to VALIDATING) and the retry reads the same inherited keys, so
	// the base stays pinned until that edit is itself deleted or pruned.
	it("refuses a snapshot an unfinished edit is deriving from, and says so", async () => {
		mocks.file.deleteMany.mockResolvedValue({ count: 3 });
		mocks.snapshot.deleteMany.mockResolvedValue({ count: 0 });
		// The row is there and IS in a deletable status — so the relation
		// filter is what matched nothing.
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "s",
			status: "READY",
		});
		mocks.snapshot.count.mockResolvedValue(1);

		expect(await deleteInstructionSnapshot("s", "p", "org_1")).toEqual({
			deleted: false,
			reason: "base_in_flight",
		});
		expect(mocks.snapshot.count).toHaveBeenCalledWith({
			where: {
				baseSnapshotId: "s",
				projectId: "p",
				organizationId: "org_1",
				OR: [
					{ status: { in: ["RECEIVING", "VALIDATING", "FAILED"] } },
					{ proposalStatus: "PENDING" },
					expect.objectContaining({ OR: expect.any(Array) }),
				],
			},
		});
	});

	it("still reports `active` for a deletable-looking row with no derivations", async () => {
		mocks.file.deleteMany.mockResolvedValue({ count: 3 });
		mocks.snapshot.deleteMany.mockResolvedValue({ count: 0 });
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "s",
			status: "READY",
		});
		mocks.snapshot.count.mockResolvedValue(0);

		expect(await deleteInstructionSnapshot("s", "p", "org_1")).toEqual({
			deleted: false,
			reason: "active",
		});
	});

	it("rolls the transaction back rather than committing the file delete of a surviving snapshot", async () => {
		mocks.file.deleteMany.mockResolvedValue({ count: 3 });
		mocks.snapshot.deleteMany.mockResolvedValue({ count: 0 });
		mocks.snapshot.findFirst.mockResolvedValue({ id: "s" });
		// The real `$transaction` rolls back when its callback throws; this
		// stand-in proves the callback DOES throw rather than returning, which
		// is what a real Postgres transaction needs in order to undo the file
		// deletion above.
		let threw = false;
		mocks.$transaction.mockImplementation(
			async (cb: (tx: unknown) => unknown) => {
				try {
					return await cb({
						projectInstructionSnapshot: mocks.snapshot,
						projectInstructionFile: mocks.file,
						project: mocks.project,
						$queryRaw: (...a: unknown[]) => mocks.$queryRaw(...a),
					});
				} catch (error) {
					threw = true;
					throw error;
				}
			},
		);

		await deleteInstructionSnapshot("s", "p", "org_1");

		expect(threw).toBe(true);
	});

	it("reports reason 'published' for a foreign-key violation instead of throwing", async () => {
		mocks.file.deleteMany.mockResolvedValue({ count: 0 });
		mocks.snapshot.deleteMany.mockRejectedValue(
			new FakePrismaKnownRequestError("P2003"),
		);

		expect(await deleteInstructionSnapshot("s", "p", "org_1")).toEqual({
			deleted: false,
			reason: "published",
		});
	});

	it("rethrows any other Prisma error", async () => {
		mocks.file.deleteMany.mockResolvedValue({ count: 0 });
		mocks.snapshot.deleteMany.mockRejectedValue(
			new FakePrismaKnownRequestError("P1001"),
		);

		await expect(
			deleteInstructionSnapshot("s", "p", "org_1"),
		).rejects.toMatchObject({ code: "P1001" });
	});

	it("reports deleted: false without a reason when no such row exists in this tenant", async () => {
		mocks.file.deleteMany.mockResolvedValue({ count: 0 });
		mocks.snapshot.deleteMany.mockResolvedValue({ count: 0 });
		mocks.snapshot.findFirst.mockResolvedValue(null);

		expect(await deleteInstructionSnapshot("s", "p", "other_org")).toEqual({
			deleted: false,
		});
	});
});

/**
 * I2: `finalize` starts the workflow before writing VALIDATING, so a small
 * upload can reach READY or REJECTED in between. The write used to be
 * unconditional and overwrote that terminal verdict.
 */
describe("startInstructionSnapshotValidation", () => {
	it("only moves a RECEIVING or FAILED row, and reports whether it did", async () => {
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });

		const r = await startInstructionSnapshotValidation({
			snapshotId: "s",
			projectId: "p",
			organizationId: "org_1",
		});

		expect(r).toEqual({ changed: true });
		expect(mocks.snapshot.updateMany).toHaveBeenCalledWith({
			where: {
				id: "s",
				projectId: "p",
				organizationId: "org_1",
				status: { in: ["RECEIVING", "FAILED"] },
			},
			data: { status: "VALIDATING" },
		});
	});

	it("reports changed: false when the conditional write matched nothing", async () => {
		mocks.snapshot.updateMany.mockResolvedValue({ count: 0 });

		expect(
			await startInstructionSnapshotValidation({
				snapshotId: "s",
				projectId: "p",
				organizationId: "org_1",
			}),
		).toEqual({ changed: false });
	});
});

/**
 * Round 6, finding 1: the activity gate gets its OWN claim, narrowed to
 * RECEIVING. A timed-out Temporal attempt can wake after the workflow's
 * boundary catch wrote FAILED and the workflow closed; a claim carrying the
 * API's FAILED arm would then move that terminal row back to VALIDATING with
 * nothing alive to finish it.
 */
describe("claimInstructionSnapshotValidation", () => {
	it("moves ONLY a RECEIVING row, tenant-bound", async () => {
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });

		expect(
			await claimInstructionSnapshotValidation({
				snapshotId: "s",
				projectId: "p",
				organizationId: "org_1",
			}),
		).toEqual({ changed: true });
		// Exactly this WHERE: no FAILED arm, and both tenant columns present.
		expect(mocks.snapshot.updateMany).toHaveBeenCalledWith({
			where: {
				id: "s",
				projectId: "p",
				organizationId: "org_1",
				status: "RECEIVING",
			},
			data: { status: "VALIDATING" },
		});
	});

	it("reports changed: false when the conditional write matched nothing", async () => {
		mocks.snapshot.updateMany.mockResolvedValue({ count: 0 });

		expect(
			await claimInstructionSnapshotValidation({
				snapshotId: "s",
				projectId: "p",
				organizationId: "org_1",
			}),
		).toEqual({ changed: false });
	});
});

/**
 * Round 3: Temporal delivers an activity AT LEAST ONCE, so a worker that
 * commits a verdict and then dies before its completion is acknowledged has
 * the whole activity re-run against a row that already holds that verdict.
 * Both transitions are therefore conditional on the row NOT already holding
 * one, and the rejection audit rides inside the same transaction so it cannot
 * be emitted a second time — or lost when the retry correctly declines to
 * re-write the status.
 */
describe("markInstructionSnapshotReady", () => {
	const input = {
		snapshotId: "s",
		projectId: "p",
		organizationId: "org_1",
		fileCount: 3,
		storedBytes: 42,
		digest: "d".repeat(64),
		readyAt: new Date("2026-09-17T00:00:00.000Z"),
	};

	it("writes READY only from a row that has not already reached a verdict", async () => {
		mocks.snapshot.findFirst.mockResolvedValue({ proposalStatus: null });
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });

		expect(await markInstructionSnapshotReady(input)).toEqual({
			changed: true,
		});
		expect(mocks.snapshot.updateMany).toHaveBeenCalledWith({
			where: {
				id: "s",
				projectId: "p",
				organizationId: "org_1",
				// An already-READY or already-REJECTED row does not match, so
				// the retry cannot restamp `readyAt`. FAILED is absent on
				// purpose: "Try again" re-runs the workflow from it, and that
				// run has to be able to write its verdict.
				status: { notIn: ["READY", "REJECTED"] },
			},
			data: {
				status: "READY",
				fileCount: 3,
				storedBytes: 42,
				digest: "d".repeat(64),
				readyAt: input.readyAt,
				rejection: "JsonNull",
			},
		});
	});

	it("reports changed: false — and writes nothing more — when the row is already READY", async () => {
		mocks.snapshot.findFirst.mockResolvedValue(null);

		expect(await markInstructionSnapshotReady(input)).toEqual({
			changed: false,
		});
		// No second pass, no read-then-write repair: the conditional write is
		// the whole transition, and `readyAt` keeps the first attempt's value.
		expect(mocks.snapshot.updateMany).not.toHaveBeenCalled();
		expect(mocks.snapshot.update).not.toHaveBeenCalled();
	});

	it("reserves proposal staging cleanup when validation succeeds", async () => {
		mocks.snapshot.findFirst.mockResolvedValue({
			proposalStatus: "PENDING",
		});
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });

		await markInstructionSnapshotReady(input);

		expect(mocks.snapshot.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "READY",
					rejection: [
						{
							path: "(proposal staging)",
							reason: "abandoned",
							detail: "staging pending",
						},
					],
				}),
			}),
		);
	});
});

describe("authorizeInstructionProposalUploadUrls", () => {
	it("holds a row lock and authorizes only a still-receiving proposal inside its lease", async () => {
		mocks.$queryRaw.mockResolvedValue([{ id: "proposal" }]);
		const createdAfter = new Date("2026-09-18T00:00:00Z");

		await expect(
			authorizeInstructionProposalUploadUrls({
				snapshotId: "proposal",
				projectId: "p",
				organizationId: "org_1",
				createdAfter,
			}),
		).resolves.toEqual({ authorized: true });
		expect(mocks.$queryRaw).toHaveBeenCalledOnce();
		const sql = String(mocks.$queryRaw.mock.calls[0]?.[0]);
		expect(sql).toContain("FOR UPDATE OF s");
		expect(sql).toContain("s.\"status\" = 'RECEIVING'");
		expect(sql).toContain('s."createdAt" >');
	});
});

describe("markInstructionSnapshotRejected", () => {
	const rejections = [{ path: "a", reason: "secret", detail: "jwt" }];
	const audit = {
		action: "project.instructions.rejected",
		category: "project" as const,
		actor: { type: "user" as const, userId: "u" },
		organizationId: "org_1",
		projectId: "p",
	};
	const input = {
		snapshotId: "s",
		projectId: "p",
		organizationId: "org_1",
		rejections,
		audit,
	};

	it("writes the verdict and its audit row in one transaction", async () => {
		mocks.snapshot.findFirst.mockResolvedValue({ proposalStatus: null });
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });

		expect(await markInstructionSnapshotRejected(input)).toEqual({
			changed: true,
		});
		expect(mocks.$transaction).toHaveBeenCalledTimes(1);
		expect(mocks.snapshot.updateMany).toHaveBeenCalledWith({
			where: {
				id: "s",
				projectId: "p",
				organizationId: "org_1",
				status: { notIn: ["READY", "REJECTED"] },
			},
			data: { status: "REJECTED", rejection: rejections },
		});
		expect(mocks.snapshot.updateMany).toHaveBeenCalledWith({
			where: {
				id: "s",
				projectId: "p",
				organizationId: "org_1",
				proposalStatus: "PENDING",
			},
			data: { proposalStatus: "REJECTED" },
		});
		// Through the transaction client, not a fresh connection: the row and
		// the verdict commit together or neither does.
		expect(auditMocks.recordAuditTx).toHaveBeenCalledWith(
			expect.objectContaining({
				projectInstructionSnapshot: mocks.snapshot,
			}),
			audit,
		);
	});

	it("emits no audit row when the snapshot had already been rejected", async () => {
		mocks.snapshot.findFirst.mockResolvedValue(null);

		expect(await markInstructionSnapshotRejected(input)).toEqual({
			changed: false,
		});
		// This is the retry after a lost completion: the verdict is already
		// there, so a second `project.instructions.rejected` row would be a
		// duplicate record of one refused upload.
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("keeps a validation-rejected proposal counted until its staging cleanup completes", async () => {
		mocks.snapshot.findFirst.mockResolvedValue({
			proposalStatus: "PENDING",
		});
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });

		await markInstructionSnapshotRejected(input);

		expect(mocks.snapshot.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					rejection: expect.arrayContaining([
						expect.objectContaining({
							path: "(proposal staging)",
							detail: "staging pending",
						}),
					]),
				}),
			}),
		);
	});
});

/**
 * I6: the child FK binds (snapshotId, projectId) only
 * (`project_instruction_file_snapshotId_projectId_fkey`), so a row carrying
 * the wrong `organizationId` still satisfies it. Checking only the parent
 * snapshot would then serve that row. Every child read and write filters the
 * column itself.
 */
describe("organization scoping on the child queries", () => {
	it("filters listInstructionFiles by organizationId as well as snapshotId", async () => {
		mocks.file.findMany.mockResolvedValue([]);

		await listInstructionFiles("s", "org_1", { kind: "SKILL" });

		expect(mocks.file.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					snapshotId: "s",
					organizationId: "org_1",
					kind: "SKILL",
				}),
			}),
		);
	});

	it("looks a file up by (snapshotId, path, organizationId), not by the unique pair alone", async () => {
		mocks.file.findFirst.mockResolvedValue(null);

		await getInstructionFileByPath("s", "org_1", "CLAUDE.md");

		expect(mocks.file.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					snapshotId: "s",
					path: "CLAUDE.md",
					organizationId: "org_1",
				},
			}),
		);
	});
});

/**
 * Critical 1 (round 4). `createUploadUrls` rewrote a file's storage key with a
 * write constrained by file id and organization alone, authorized by a
 * RECEIVING read taken minutes earlier. A stale page of that request could
 * therefore point a row that finalization had already promoted to its
 * IMMUTABLE snapshot key back at writable staging, and hand out a signed PUT
 * for it — so a published snapshot served bytes nothing had scanned, under a
 * digest describing the content that had been.
 */
describe("claimInstructionFileStagingKey", () => {
	const input = {
		fileId: "f1",
		snapshotId: "s",
		projectId: "p",
		organizationId: "org_1",
		from: "projects/p/instructions/staging/pending/0",
		to: "projects/p/instructions/staging/s/f1",
	};

	it("accepts the key it was given or the target key, with the parent's RECEIVING status, in the same statement", async () => {
		mocks.file.updateMany.mockResolvedValue({ count: 1 });

		expect(await claimInstructionFileStagingKey(input)).toEqual({
			moved: true,
		});
		expect(mocks.file.updateMany).toHaveBeenCalledWith({
			where: {
				id: "f1",
				snapshotId: "s",
				projectId: "p",
				organizationId: "org_1",
				// Either the provisional key the caller read or the target key
				// itself: two requests that both read the provisional key
				// (a retry of a lost response) must both succeed, and the
				// second finds the row already where it wants it. An
				// immutable snapshot key is neither, so it never matches.
				storageKey: {
					in: [
						"projects/p/instructions/staging/pending/0",
						"projects/p/instructions/staging/s/f1",
					],
				},
				// The relation filter is the point: the parent's state is
				// checked by the UPDATE, not by a read above it.
				snapshot: { status: "RECEIVING" },
			},
			data: { storageKey: "projects/p/instructions/staging/s/f1" },
		});
		expect(mocks.file.update).not.toHaveBeenCalled();
	});

	it("reports moved: false when the conditional write matched nothing", async () => {
		mocks.file.updateMany.mockResolvedValue({ count: 0 });

		expect(await claimInstructionFileStagingKey(input)).toEqual({
			moved: false,
		});
	});
});

/**
 * Important 2 (round 4). The workflow's failure marker read the status and
 * then wrote FAILED unconditionally. Temporal delivers activities at least
 * once, so a timed-out attempt runs on while its retries fail: the marker
 * could read VALIDATING, the original attempt could commit READY, and FAILED
 * would then land on a snapshot whose bytes were already promoted and whose id
 * the project's published pointer might already name.
 */
describe("failInstructionSnapshot", () => {
	const input = { snapshotId: "s", projectId: "p", organizationId: "org_1" };

	it("moves only a RECEIVING or VALIDATING row, in one conditional write", async () => {
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });

		expect(await failInstructionSnapshot(input)).toEqual({ changed: true });
		expect(mocks.snapshot.updateMany).toHaveBeenCalledWith({
			where: {
				id: "s",
				projectId: "p",
				organizationId: "org_1",
				status: { in: ["RECEIVING", "VALIDATING"] },
			},
			data: { status: "FAILED", rejection: "JsonNull" },
		});
		expect(mocks.snapshot.update).not.toHaveBeenCalled();
	});

	it("reports changed: false when the row already holds a verdict", async () => {
		mocks.snapshot.updateMany.mockResolvedValue({ count: 0 });

		expect(await failInstructionSnapshot(input)).toEqual({
			changed: false,
		});
	});
});

/**
 * Round 8, finding 1. The reaper's phase 0 decides a stranded VALIDATING row
 * is dead by describing its workflow, and the write that follows is a second
 * operation: a newer run — `finalize` starting a fresh execution, or a "Try
 * again" after an overlapping reaper attempt already wrote FAILED — can begin
 * in between. `failInstructionSnapshot`'s predicate would happily match that
 * newer generation. This transition carries the row version phase 0 actually
 * described, so anything that moved the row since makes it match nothing.
 */
describe("failStaleValidatingInstructionSnapshot", () => {
	const observedUpdatedAt = new Date("2026-09-17T10:00:00.000Z");
	const input = {
		snapshotId: "s",
		projectId: "p",
		organizationId: "org_1",
		observedUpdatedAt,
	};

	it("writes FAILED only for a VALIDATING row still at the observed updatedAt", async () => {
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });

		expect(await failStaleValidatingInstructionSnapshot(input)).toEqual({
			changed: true,
		});
		expect(mocks.snapshot.updateMany).toHaveBeenCalledWith({
			where: {
				id: "s",
				projectId: "p",
				organizationId: "org_1",
				// Only VALIDATING: a RECEIVING row is phase 1's business.
				status: "VALIDATING",
				// The compare half of the compare-and-set. Every write to the
				// row moves `updatedAt`, so a newer generation, an activity
				// claim or a real verdict all make this match zero rows.
				updatedAt: observedUpdatedAt,
			},
			// Byte-for-byte what `failInstructionSnapshot` writes: the row the
			// workflow's own boundary catch would have produced, which "Try
			// again" then reads.
			data: { status: "FAILED", rejection: "JsonNull" },
		});
		expect(mocks.snapshot.update).not.toHaveBeenCalled();
	});

	it("reports changed: false when the row moved since it was listed", async () => {
		mocks.snapshot.updateMany.mockResolvedValue({ count: 0 });

		expect(await failStaleValidatingInstructionSnapshot(input)).toEqual({
			changed: false,
		});
	});
});

describe("updateInstructionFileMetadata", () => {
	// I6: `updateMany`, not `update`, so the organization can live in the
	// WHERE clause. The child FK binds (snapshotId, projectId) only, so a row
	// tagged with the wrong organization satisfies it; a write that named the
	// row by id alone would happily cross that boundary.
	it("accepts a storageKey so staging keys can move to their snapshot key, scoped by organization", async () => {
		await updateInstructionFileMetadata("f1", "org_1", {
			kind: "INSTRUCTIONS",
			name: null,
			description: null,
			storageKey: "projects/p/instructions/snapshots/s/f1",
		});
		expect(mocks.file.updateMany).toHaveBeenCalledWith({
			where: { id: "f1", organizationId: "org_1" },
			data: {
				kind: "INSTRUCTIONS",
				name: null,
				description: null,
				storageKey: "projects/p/instructions/snapshots/s/f1",
			},
		});
		expect(mocks.file.update).not.toHaveBeenCalled();
	});
});

/**
 * M1: one shared window over READY + REJECTED + FAILED meant five rejected
 * uploads in a row pushed every READY snapshot past `skip` and deleted the
 * project's whole rollback history, which is the opposite of what spec
 * §6.3.6's "keep the last 5 READY snapshots" promises.
 */
describe("listPrunableInstructionSnapshots", () => {
	it("windows READY and REJECTED/FAILED separately", async () => {
		mocks.project.findUnique.mockResolvedValue({
			publishedInstructionSnapshotId: null,
		});
		mocks.snapshot.findMany
			.mockResolvedValueOnce([{ id: "old-ready", files: [] }])
			.mockResolvedValueOnce([{ id: "old-rejected", files: [] }]);

		const rows = await listPrunableInstructionSnapshots("p", "org_1", {
			ready: 5,
			rejected: 2,
		});

		const [readyQuery, rejectedQuery] = mocks.snapshot.findMany.mock.calls;
		expect(readyQuery![0]).toMatchObject({
			where: {
				projectId: "p",
				organizationId: "org_1",
				status: "READY",
				// In the WHERE, ahead of `skip`: the retention rule is "the
				// newest five UNPUBLISHED READY rows plus the published one",
				// so the published row never occupies a kept slot.
				publishedFor: null,
			},
			skip: 5,
			// Bounded per call: without it, one project's history was an
			// unbounded result set AND an unbounded number of nested storage
			// keys for the caller to delete. What is left over is the next
			// run's work.
			take: 50,
		});
		expect(rejectedQuery![0]).toMatchObject({
			where: {
				projectId: "p",
				organizationId: "org_1",
				status: { in: ["REJECTED", "FAILED"] },
			},
			skip: 2,
			take: 50,
		});
		expect(rows.map((r) => r.id)).toEqual(["old-ready", "old-rejected"]);
	});

	// I4 (round 2): the parent snapshots were scoped but the nested `files`
	// relation was not. The child's foreign key binds `(snapshotId, projectId)`
	// only, so a row whose own `organizationId` says another tenant satisfies
	// the constraint and still comes back through the relation — and these
	// selections feed a STORAGE DELETE, so an unscoped relation is how pruning
	// one organization's snapshot could delete another's object.
	it("scopes the nested file selection by organization in BOTH windows", async () => {
		mocks.project.findUnique.mockResolvedValue({
			publishedInstructionSnapshotId: null,
		});
		mocks.snapshot.findMany.mockResolvedValue([]);

		await listPrunableInstructionSnapshots("p", "org_1", {
			ready: 5,
			rejected: 2,
		});

		expect(mocks.snapshot.findMany).toHaveBeenCalledTimes(2);
		for (const call of mocks.snapshot.findMany.mock.calls) {
			expect(call[0]).toMatchObject({
				select: {
					files: {
						where: { organizationId: "org_1" },
						select: { storageKey: true },
					},
				},
			});
		}
	});

	it("leaves the published snapshot to the WHERE in the READY window and to the post-filter in the other", async () => {
		mocks.project.findUnique.mockResolvedValue({
			publishedInstructionSnapshotId: "published-snap",
		});
		mocks.snapshot.findMany
			// The READY window's own `publishedFor: null` already removed it,
			// so whatever comes back from that query is prunable as-is.
			.mockResolvedValueOnce([
				{ id: "prunable", files: [{ storageKey: "k2" }] },
			])
			// Only a READY snapshot can be the published pointer, so a
			// published row here is impossible; the post-filter is a
			// fail-closed backstop and this proves it still fires.
			.mockResolvedValueOnce([
				{ id: "published-snap", files: [{ storageKey: "k1" }] },
				{ id: "old-rejected", files: [{ storageKey: "k3" }] },
			]);

		const rows = await listPrunableInstructionSnapshots("p", "org_1", {
			ready: 5,
			rejected: 2,
		});

		expect(rows).toEqual([
			{ id: "prunable", storageKeys: ["k2"] },
			{ id: "old-rejected", storageKeys: ["k3"] },
		]);
	});

	it("leaves RECEIVING/VALIDATING rows out of both windows", async () => {
		mocks.project.findUnique.mockResolvedValue({
			publishedInstructionSnapshotId: null,
		});
		mocks.snapshot.findMany.mockResolvedValue([]);

		await listPrunableInstructionSnapshots("p", "org_1", {
			ready: 5,
			rejected: 2,
		});

		// The SNAPSHOT'S OWN status filter, not the whole serialized
		// argument: the derived-snapshot interlock added a RELATION filter
		// that names those two statuses on purpose (a base with an in-flight
		// edit is kept), and a string search over the argument cannot tell
		// the two apart.
		for (const call of mocks.snapshot.findMany.mock.calls) {
			const where = (call[0] as { where: Record<string, unknown> }).where;
			expect(JSON.stringify(where.status)).not.toContain("RECEIVING");
			expect(JSON.stringify(where.status)).not.toContain("VALIDATING");
			// And the interlock itself is on both windows.
			expect(where.derivedSnapshots).toEqual({
				none: { status: { in: ["RECEIVING", "VALIDATING", "FAILED"] } },
			});
			expect(JSON.stringify(where.AND)).toContain(
				'"proposalStatus":"PENDING"',
			);
			expect(JSON.stringify(where.AND)).toContain("(proposal staging)");
		}
	});
});

/**
 * Fizzy #2550. An upload whose dialog was closed before `finalize` stays
 * RECEIVING forever: no workflow exists, nothing else ever moves the row, the
 * tab reads it as work in progress, and its staged objects are referenced by a
 * row that will never reach a verdict.
 */
describe("listAbandonedReceivingInstructionSnapshots", () => {
	it("selects only RECEIVING rows created before the cutoff, oldest first", async () => {
		const cutoff = new Date("2026-09-17T06:00:00.000Z");
		mocks.snapshot.findMany.mockResolvedValue([]);

		await listAbandonedReceivingInstructionSnapshots(cutoff, 200);

		expect(mocks.snapshot.findMany).toHaveBeenCalledWith({
			// A system-wide sweep: no tenant is in scope, and the per-row
			// writes that follow are bound by the columns selected here.
			where: { status: "RECEIVING", createdAt: { lt: cutoff } },
			// Oldest first, so a backlog larger than one run's budget drains
			// in age order instead of re-scanning the same end every hour.
			orderBy: { createdAt: "asc" },
			take: 200,
			select: {
				id: true,
				projectId: true,
				organizationId: true,
				createdAt: true,
			},
		});
	});
});

/**
 * Round 7, finding 1. A row stranded in VALIDATING is the one state nothing
 * else in the feature will ever move: `finalize` starts the workflow BEFORE
 * it writes VALIDATING, so a status write that lands after the run has closed
 * leaves a row no execution stands behind, and a worker that dies mid-run
 * leaves the same. The reaper needs a bounded candidate population for it.
 */
describe("listStaleValidatingInstructionSnapshots", () => {
	it("selects only VALIDATING rows last touched before the cutoff, oldest first", async () => {
		const cutoff = new Date("2026-09-17T11:00:00.000Z");
		mocks.snapshot.findMany.mockResolvedValue([]);

		await listStaleValidatingInstructionSnapshots(cutoff, 100);

		expect(mocks.snapshot.findMany).toHaveBeenCalledWith({
			// `updatedAt`, not `createdAt`: the age that matters is how long
			// the row has been in VALIDATING, not how long ago its upload
			// began. A system-wide sweep, so no tenant is in scope, and the
			// per-row write that follows is bound by the columns selected
			// here.
			where: { status: "VALIDATING", updatedAt: { lt: cutoff } },
			orderBy: { updatedAt: "asc" },
			take: 100,
			select: {
				id: true,
				projectId: true,
				organizationId: true,
				// Round 8, finding 1: SELECTED, not just filtered on. It is
				// the row version the sweep inspects, and the compare-and-set
				// that heals the row puts it back in the WHERE clause.
				updatedAt: true,
			},
		});
	});
});

/**
 * The rediscovery half of the same fix. The abandonment verdict commits
 * before its objects are deleted, so an attempt that dies in the gap leaves
 * staged bytes under a row that is REJECTED by then — which the RECEIVING
 * candidate query can never return again.
 */
describe("listPendingAbandonedInstructionSnapshots", () => {
	it("selects REJECTED abandonments still carrying the pending mark, excluding the caller's ids", async () => {
		mocks.snapshot.findMany.mockResolvedValue([]);

		const cutoff = new Date("2026-09-18T01:00:00Z");
		await listPendingAbandonedInstructionSnapshots(
			200,
			["snap_1", "snap_2"],
			cutoff,
		);

		expect(mocks.snapshot.findMany).toHaveBeenCalledWith({
			where: {
				status: { in: ["READY", "REJECTED"] },
				createdAt: { lt: cutoff },
				OR: expect.arrayContaining([
					expect.objectContaining({
						rejection: expect.objectContaining({
							array_contains: expect.arrayContaining([
								expect.objectContaining({
									path: "(proposal staging)",
									detail: "staging pending",
								}),
							]),
						}),
					}),
				]),
				// Phase 1's rows are dropped IN the query, so a full page is
				// a real backlog rather than rows the caller will skip.
				id: { notIn: ["snap_1", "snap_2"] },
			},
			// Order only. There is no `updatedAt` window: using one timestamp
			// as both the cutoff and the cursor meant every successful sweep
			// renewed the eligibility it was supposed to end.
			orderBy: { updatedAt: "asc" },
			take: 200,
			// No tenant in scope: the per-row prefix the caller builds comes
			// from the columns selected here.
			select: { id: true, projectId: true, organizationId: true },
		});
	});

	it("passes an empty exclusion list through unchanged", async () => {
		mocks.snapshot.findMany.mockResolvedValue([]);

		await listPendingAbandonedInstructionSnapshots(
			200,
			[],
			new Date("2026-09-18T01:00:00Z"),
		);

		const [args] = mocks.snapshot.findMany.mock.calls[0]!;
		expect((args as { where: { id: unknown } }).where.id).toEqual({
			notIn: [],
		});
	});
});

/**
 * The completion mark. Clearing it is what takes a row out of the pending
 * population — permanently, and only once its prefix is actually gone.
 */
describe("markAbandonedInstructionSnapshotSwept", () => {
	const input = {
		snapshotId: "s",
		projectId: "p",
		organizationId: "org_1",
	};

	it("rewrites the mark with ONE conditional, tenant-bound statement and nothing else", async () => {
		mocks.snapshot.findFirst.mockResolvedValue({
			rejection: [
				{ path: "a.md", reason: "secret" },
				{
					path: "(proposal staging)",
					reason: "abandoned",
					detail: "staging pending",
				},
			],
		});
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });

		expect(await markAbandonedInstructionSnapshotSwept(input)).toEqual({
			changed: true,
		});
		expect(mocks.snapshot.findFirst).toHaveBeenCalledOnce();
		expect(mocks.snapshot.updateMany).toHaveBeenCalledTimes(1);
		const [args] = mocks.snapshot.updateMany.mock.calls[0]!;
		expect(args).toMatchObject({
			where: {
				id: "s",
				projectId: "p",
				organizationId: "org_1",
				status: { in: ["READY", "REJECTED"] },
				rejection: { equals: expect.any(Array) },
			},
			data: {
				rejection: [
					{ path: "a.md", reason: "secret" },
					{
						path: "(proposal staging)",
						reason: "abandoned",
						detail: "staging cleared",
					},
				],
			},
		});
		// The verdict was recorded once, by the attempt that made it.
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("reports a row the predicate did not match", async () => {
		mocks.snapshot.findFirst.mockResolvedValue(null);

		expect(await markAbandonedInstructionSnapshotSwept(input)).toEqual({
			changed: false,
		});
	});
});

/**
 * The rotation, which runs only when a sweep FAILED: the row stays pending,
 * but goes to the back of the oldest-first queue so one undeletable prefix
 * cannot sit at the front of every hourly run.
 */
describe("rotateAbandonedInstructionSnapshot", () => {
	const input = {
		snapshotId: "s",
		projectId: "p",
		organizationId: "org_1",
	};

	it("re-dates the row with ONE conditional, tenant-bound statement and leaves the mark alone", async () => {
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });

		expect(await rotateAbandonedInstructionSnapshot(input)).toEqual({
			rotated: true,
		});
		expect(mocks.snapshot.updateMany).toHaveBeenCalledTimes(1);
		const [args] = mocks.snapshot.updateMany.mock.calls[0]!;
		expect(args).toMatchObject({
			where: {
				id: "s",
				projectId: "p",
				organizationId: "org_1",
				// The full from-state, not status alone. Status alone would
				// re-date a row a concurrent attempt had already swept and
				// CLEARED, and — worse — an ordinary refused upload that this
				// sweep does not own at all.
				status: { in: ["READY", "REJECTED"] },
				OR: expect.any(Array),
			},
			// The explicit value Prisma writes in place of its own
			// `@updatedAt`. No `rejection`: the row is still pending, which
			// is the whole point of rotating rather than marking it.
			data: { updatedAt: expect.any(Date) },
		});
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("reports a row the predicate did not match", async () => {
		mocks.snapshot.updateMany.mockResolvedValue({ count: 0 });

		expect(await rotateAbandonedInstructionSnapshot(input)).toEqual({
			rotated: false,
		});
	});
});

describe("rejectAbandonedInstructionSnapshot", () => {
	const input = {
		snapshotId: "s",
		projectId: "p",
		organizationId: "org_1",
		cutoff: new Date("2026-09-17T06:00:00.000Z"),
	};

	it("writes REJECTED and its audit row in one transaction, on a predicate that still names RECEIVING and the cutoff", async () => {
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });
		mocks.snapshot.findFirst.mockResolvedValue({
			userId: "user_1",
			version: 4,
		});

		expect(await rejectAbandonedInstructionSnapshot(input)).toEqual({
			changed: true,
		});
		expect(mocks.$transaction).toHaveBeenCalledTimes(1);
		expect(mocks.snapshot.updateMany).toHaveBeenCalledWith({
			where: {
				id: "s",
				projectId: "p",
				organizationId: "org_1",
				// A `finalize` racing this call has already moved the row to
				// VALIDATING; that upload is alive and must be left alone.
				// The predicate is the WRITE's own, not a read above it.
				status: "RECEIVING",
				createdAt: { lt: input.cutoff },
			},
			data: {
				status: "REJECTED",
				rejection: [
					{
						path: "(upload)",
						reason: "abandoned",
						// PENDING, because this statement commits the verdict
						// and the staging objects are deleted afterwards. The
						// reaper's sweep is what clears it.
						detail: "staging pending",
					},
				],
			},
		});
		// The existing rejection action, not a new one: the audit taxonomy
		// gains nothing from a second way to say the same thing, and
		// `metadata.source` is what distinguishes the sweep.
		expect(auditMocks.recordAuditTx).toHaveBeenCalledWith(
			expect.objectContaining({
				projectInstructionSnapshot: mocks.snapshot,
			}),
			expect.objectContaining({
				action: "project.instructions.rejected",
				actor: { type: "user", userId: "user_1" },
				organizationId: "org_1",
				projectId: "p",
				resource: {
					type: "project_instruction_snapshot",
					id: "s",
					name: "v4",
				},
				metadata: expect.objectContaining({
					source: "abandoned_receiving_reaper",
				}),
			}),
		);
	});

	// A caller compensating for a row it created itself, in the same request,
	// has no stale candidate list to guard against: the row is seconds old by
	// construction, so an age predicate could only ever be wrong. The
	// RECEIVING compare-and-set is the guard that matters, and it is the same
	// one — a `finalize` that moved the row on still wins.
	it("drops the age predicate when no cutoff is given, keeping the RECEIVING guard", async () => {
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });
		mocks.snapshot.findFirst.mockResolvedValue({
			userId: "user_1",
			version: 4,
		});

		await rejectAbandonedInstructionSnapshot({
			snapshotId: "s",
			projectId: "p",
			organizationId: "org_1",
			source: "inline_submit_compensation",
		});

		const where = mocks.snapshot.updateMany.mock.calls[0]?.[0]
			.where as Record<string, unknown>;
		expect(where).not.toHaveProperty("createdAt");
		expect(where.status).toBe("RECEIVING");
		// What TRIGGERED the close-out, not whose upload it was.
		expect(auditMocks.recordAuditTx).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				metadata: expect.objectContaining({
					source: "inline_submit_compensation",
				}),
			}),
		);
	});

	/**
	 * A row that moved on between the caller's read and this write — a
	 * `finalize` landing, or another request closing it out first — matches
	 * nothing, and the caller is told so rather than being handed a verdict
	 * it never actually made.
	 */
	it("reports no change when the row moved on before the write", async () => {
		mocks.snapshot.updateMany.mockResolvedValue({ count: 0 });

		expect(
			await rejectAbandonedInstructionSnapshot({
				snapshotId: "s",
				projectId: "p",
				organizationId: "org_1",
				cutoff: new Date(),
			}),
		).toEqual({ changed: false });
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("writes no audit row when the conditional write matched nothing", async () => {
		mocks.snapshot.updateMany.mockResolvedValue({ count: 0 });

		expect(await rejectAbandonedInstructionSnapshot(input)).toEqual({
			changed: false,
		});
		// Temporal delivers activities AT LEAST ONCE, so the retry of a sweep
		// that already closed this row out must not emit a second row for it.
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
		expect(mocks.snapshot.findFirst).not.toHaveBeenCalled();
	});
});

/**
 * The reaper's candidate query: ONE ordered, deduplicated relation, a page of
 * it, and the size of the population that page came from.
 *
 * It is raw SQL because the shape is what makes the reaper's rotation honest.
 * Two Prisma `groupBy` calls cannot express it: skipping each retention window
 * separately rotates two different lists and then interleaves them, so a page
 * is not a window of one order — twenty-five sticky READY-only projects and
 * twenty-five sticky rejected-only ones left half of each starved at offset 0
 * and the whole population unvisited at offset 25, forever. The old count was
 * worse than approximate: it returned every candidate in the system to Node to
 * deduplicate them there, unbounded, before any per-run budget applied.
 */
describe("listProjectsWithPrunableInstructionSnapshots", () => {
	/**
	 * The one statement the query makes: its SQL text and its bound values,
	 * with composed fragments flattened the way Prisma flattens them.
	 */
	function lastStatement(): { sql: string; values: unknown[] } {
		const [strings, ...values] = mocks.$queryRaw.mock.calls.at(-1) as [
			TemplateStringsArray,
			...unknown[],
		];
		const statement = sqltag(strings, ...values);
		return {
			sql: statement.sql.replace(/\?/g, " ? ").replace(/\s+/g, " "),
			values: statement.values,
		};
	}

	it("binds the thresholds, the offset and the limit — it interpolates nothing", async () => {
		mocks.$queryRaw.mockResolvedValue([]);

		await listProjectsWithPrunableInstructionSnapshots(
			{ ready: 5, rejected: 2 },
			25,
			50,
		);

		expect(mocks.$queryRaw).toHaveBeenCalledTimes(1);
		const { sql, values } = lastStatement();
		expect(values).toEqual([5, 2, 50, 25]);
		// Every value arrives as a parameter. This query is system-wide, with
		// no tenant in scope, and its inputs come from a scheduled activity.
		for (const value of values) {
			expect(sql).not.toContain(String(value));
		}
	});

	it("unions the two retention windows into one ordered relation", async () => {
		mocks.$queryRaw.mockResolvedValue([]);

		await listProjectsWithPrunableInstructionSnapshots(
			{ ready: 5, rejected: 2 },
			25,
			0,
		);

		const { sql } = lastStatement();
		// The predicate, on BOTH arms: the row is not any project's published
		// pointer. On the READY side that IS the retention predicate — the
		// helper windows the unpublished rows by version — and on the
		// REJECTED/FAILED side it is a fail-closed no-op, since only a READY
		// snapshot can be the published pointer.
		expect(sql).toContain(
			'FROM "project_instruction_snapshot" s LEFT JOIN "project" p ON p."publishedInstructionSnapshotId" = s."id"',
		);
		expect(sql).toContain(
			'WHERE s."status" = \'READY\' AND p."id" IS NULL',
		);
		expect(sql).toContain(
			"WHERE s.\"status\" IN ('REJECTED', 'FAILED') AND p.\"id\" IS NULL",
		);
		// The derived-snapshot interlock, spelled the same way on BOTH arms:
		// a version something unfinished was edited FROM is not prunable,
		// because that edit's inherited rows still point at this version's
		// promoted objects. FAILED is in the list because a failed edit is
		// RETRYABLE — `finalize` moves it back to VALIDATING and the retry
		// reads the same keys.
		expect(
			sql.match(
				/NOT EXISTS \( SELECT 1 FROM "project_instruction_snapshot" d WHERE d\."baseSnapshotId" = s\."id" AND d\."status" IN \('RECEIVING', 'VALIDATING', 'FAILED'\) \)/g,
			),
		).toHaveLength(2);
		expect(
			sql.match(
				/NOT EXISTS \( SELECT 1 FROM "project_instruction_snapshot" d WHERE d\."baseSnapshotId" = s\."id" AND d\."proposalStatus" = 'PENDING'::"ProjectInstructionProposalStatus" \)/g,
			),
		).toHaveLength(2);
		// `UNION`, not `UNION ALL`: a project over both windows is ONE unit of
		// work, because the prune helper handles both windows in one pass.
		expect(sql).toContain("UNION SELECT");
		expect(sql).not.toContain("UNION ALL");
		// `HAVING count(*) > ?` on each arm: the thresholds are strict, and
		// they count the rows the WHERE already narrowed.
		expect(sql.match(/HAVING count\(\*\) > \?/g)).toHaveLength(2);
		// One canonical order for the offset to walk, and the population size
		// carried back with the page so the caller needs no second query.
		expect(sql).toContain('ORDER BY "projectId", "organizationId"');
		expect(sql).toContain("count(*) OVER () AS total");
	});

	it("returns the page and the population size the window column carries", async () => {
		mocks.$queryRaw.mockResolvedValue([
			{ projectId: "p1", organizationId: "o1", total: BigInt(7) },
			{ projectId: "p2", organizationId: "o2", total: BigInt(7) },
		]);

		expect(
			await listProjectsWithPrunableInstructionSnapshots(
				{ ready: 5, rejected: 2 },
				25,
				0,
			),
		).toEqual({
			candidates: [
				{ projectId: "p1", organizationId: "o1" },
				{ projectId: "p2", organizationId: "o2" },
			],
			// A bigint out of Postgres, a number to the caller: it is an
			// offset modulus, not a value anything stores.
			total: 7,
		});
	});

	it("reports an empty page as a population of zero", async () => {
		// The size rides on the rows, so a page with none — an empty
		// population, or an offset that ran past the end — reports zero. The
		// caller learns the real size from its head page.
		mocks.$queryRaw.mockResolvedValue([]);

		expect(
			await listProjectsWithPrunableInstructionSnapshots(
				{ ready: 5, rejected: 2 },
				25,
				900,
			),
		).toEqual({ candidates: [], total: 0 });
	});
});

/**
 * THE RETENTION PREDICATE, exercised end to end across BOTH queries that
 * implement it — the candidate query the scheduled reaper picks projects
 * with, and the helper that then decides what to delete.
 *
 * They were tested separately, with a mock per query, and separate mocks
 * cannot catch the two sides disagreeing: counting ALL READY rows while the
 * helper dropped the published one only afterwards meant a project whose
 * oldest READY row was the published one was nominated on every run forever
 * and pruned nothing, and a hundred such projects filled the reaper's
 * per-run slice with permanent no-ops.
 *
 * So both run against the SAME in-memory rows here: the helper through a
 * stand-in that applies whatever `where`/`skip`/`take` it actually passed the
 * way Postgres would, and the candidate query — raw SQL now — through a
 * stand-in that evaluates the relation its statement describes, with the
 * thresholds read off that statement's own bound parameters. A threshold or a
 * retention window that drifts on one side shows up as the two sides
 * disagreeing rather than as two mocks that were updated together. The SQL
 * text itself is asserted by the candidate query's own describe above.
 */
type RetentionRow = {
	id: string;
	version: number;
	status: string;
	/**
	 * The statuses of the snapshots DERIVED from this one — the in-tab edits
	 * made from this version. Both queries have to exclude a row that an
	 * unfinished edit is still reading, so both sides of this harness model
	 * the relation.
	 */
	derivedStatuses?: string[];
};

type SnapshotWhere = {
	status?: string | { in: string[] };
	publishedFor?: null;
	derivedSnapshots?: { none: { status: { in: string[] } } };
};

/**
 * The statuses the CANDIDATE query's `NOT EXISTS` names, as its SQL text
 * spells them. The helper passes the same set as a Prisma relation filter and
 * this harness applies whichever the caller actually used, so the two drift
 * apart as a disagreement here rather than silently. The literal is asserted
 * against the statement text itself in the describe above.
 */
const DERIVING_IN_SQL = ["RECEIVING", "VALIDATING", "FAILED"];

type FindManyArgs = { where: SnapshotWhere; skip: number; take: number };

function matchesWhere(
	row: RetentionRow,
	where: SnapshotWhere,
	publishedId: string | null,
): boolean {
	const { status } = where;
	if (typeof status === "string" && row.status !== status) {
		return false;
	}
	if (
		typeof status === "object" &&
		status !== null &&
		!status.in.includes(row.status)
	) {
		return false;
	}
	// `publishedFor: null` is the relation back to `Project`: the row is NOT
	// any project's published pointer.
	if (where.publishedFor === null && row.id === publishedId) {
		return false;
	}
	// The derived-snapshot interlock, as the self-relation both sides carry.
	const unfinished = where.derivedSnapshots?.none.status.in;
	if (
		unfinished &&
		(row.derivedStatuses ?? []).some((s) => unfinished.includes(s))
	) {
		return false;
	}
	return true;
}

function readySnapshots(count: number): RetentionRow[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `v${i + 1}`,
		version: i + 1,
		status: "READY",
	}));
}

describe.each([
	{
		name: "six READY rows, the published one NEWEST",
		rows: readySnapshots(6),
		publishedId: "v6",
		// Five unpublished READY rows behind the pointer is exactly the
		// retention window: nothing to prune, and nothing to nominate.
		expected: [],
	},
	{
		name: "six READY rows, the published one OLDEST",
		rows: readySnapshots(6),
		publishedId: "v1",
		// The case that used to nominate this project forever while the
		// helper deleted nothing.
		expected: [],
	},
	{
		name: "seven READY rows, the published one OLDEST",
		rows: readySnapshots(7),
		publishedId: "v1",
		expected: ["v2"],
	},
	{
		name: "seven READY rows, the published one NEWEST",
		rows: readySnapshots(7),
		publishedId: "v7",
		expected: ["v1"],
	},
	{
		name: "seven READY rows, the published one in the MIDDLE",
		rows: readySnapshots(7),
		publishedId: "v4",
		expected: ["v1"],
	},
	{
		name: "six READY rows and nothing published",
		rows: readySnapshots(6),
		publishedId: null,
		expected: ["v1"],
	},
	{
		name: "seven READY rows, the oldest one the base of a FAILED edit",
		rows: readySnapshots(7).map((r) =>
			r.id === "v1" ? { ...r, derivedStatuses: ["FAILED"] } : r,
		),
		publishedId: "v7",
		// IMPORTANT (round 5). Without v1's edit, v1 is exactly what the
		// seven-row case above prunes. The edit FAILED before promotion, so
		// its inherited rows still point at v1's promoted objects and
		// "Try again" — which `finalize` serves by moving FAILED back to
		// VALIDATING — would find every one of them missing. Both queries
		// have to agree about that: the helper must not return v1, and the
		// candidate query must not nominate the project for work the helper
		// will not do.
		expected: [],
	},
	{
		name: "seven READY rows whose edit was REJECTED, which releases the base",
		rows: readySnapshots(7).map((r) =>
			r.id === "v1" ? { ...r, derivedStatuses: ["REJECTED"] } : r,
		),
		publishedId: "v7",
		// The other terminal status, and the one the pipeline never reopens:
		// a rejected edit will not read its base again, so it pins nothing.
		expected: ["v1"],
	},
	{
		name: "five READY rows and four REJECTED/FAILED ones",
		rows: [
			...readySnapshots(5),
			{ id: "r1", version: 11, status: "REJECTED" },
			{ id: "r2", version: 12, status: "FAILED" },
			{ id: "r3", version: 13, status: "REJECTED" },
			{ id: "r4", version: 14, status: "REJECTED" },
		],
		publishedId: "v5",
		// READY is inside its window; the shorter REJECTED/FAILED window is
		// over by two, oldest first.
		expected: ["r2", "r1"],
	},
])("the retention predicate: $name", ({ rows, publishedId, expected }) => {
	it("prunes exactly what the reaper's candidate query nominates the project for", async () => {
		mocks.project.findUnique.mockResolvedValue({
			publishedInstructionSnapshotId: publishedId,
		});
		mocks.snapshot.findMany.mockImplementation(async (args: FindManyArgs) =>
			rows
				.filter((r) => matchesWhere(r, args.where, publishedId))
				.sort((a, b) => b.version - a.version)
				.slice(args.skip, args.skip + args.take)
				.map((r) => ({
					id: r.id,
					files: [{ storageKey: `${r.id}/k` }],
				})),
		);
		// The `UNION`ed relation: a project is a candidate when EITHER arm's
		// unpublished row count is over its threshold, and it appears once.
		mocks.$queryRaw.mockImplementation(
			async (sql: TemplateStringsArray, ...fragments: unknown[]) => {
				// The bound values once composed fragments are flattened, as
				// Prisma binds them.
				const [keepReady, keepRejected, offset, limit] = sqltag(
					sql,
					...fragments,
				).values as number[];
				const window = (where: SnapshotWhere) =>
					rows.filter((r) =>
						matchesWhere(
							r,
							{
								...where,
								derivedSnapshots: {
									none: { status: { in: DERIVING_IN_SQL } },
								},
							},
							publishedId,
						),
					).length;
				const isCandidate =
					window({ status: "READY", publishedFor: null }) >
						(keepReady as number) ||
					window({
						status: { in: ["REJECTED", "FAILED"] },
						publishedFor: null,
					}) > (keepRejected as number);
				return (
					isCandidate
						? [
								{
									projectId: "p",
									organizationId: "org_1",
									total: BigInt(1),
								},
							]
						: []
				).slice(
					offset as number,
					(offset as number) + (limit as number),
				);
			},
		);

		const keep = { ready: 5, rejected: 2 };
		const prunable = await listPrunableInstructionSnapshots(
			"p",
			"org_1",
			keep,
		);
		const { candidates } =
			await listProjectsWithPrunableInstructionSnapshots(keep, 100, 0);

		expect(prunable.map((r) => r.id)).toEqual(expected);
		// The agreement itself: nominated if and only if there is something
		// to delete. Too strict and a prunable snapshot is never visited;
		// too loose and the project is a permanent no-op candidate.
		expect(candidates.length > 0).toBe(prunable.length > 0);
	});
});

/**
 * REPOSITORY proposals in the existing writers (Fizzy #2563 spec §2.5, §4.4).
 *
 * A REPOSITORY row's proposal status is derived from its delivery state, so
 * no writer here may set `proposalStatus` on one directly: every change goes
 * through the fenced `transitionPullRequest`, which writes both columns or
 * neither. The fake below evaluates each statement's WHERE against one row
 * and applies its data only when it matches, so "left alone" is observed on
 * the row rather than inferred from which mock was called.
 */
describe("REPOSITORY proposals in the existing writers", () => {
	type Row = Record<string, unknown>;
	const HEAD = "a".repeat(40);

	function matches(row: Row, where: Record<string, unknown>): boolean {
		return Object.entries(where).every(([key, cond]) => {
			if (key === "AND") {
				return (cond as Row[]).every((w) => matches(row, w));
			}
			if (key === "OR") {
				return (cond as Row[]).some((w) => matches(row, w));
			}
			const value = row[key];
			if (
				cond !== null &&
				typeof cond === "object" &&
				!(cond instanceof Date)
			) {
				const c = cond as Record<string, unknown>;
				if ("path" in c) {
					const json = value as Record<string, unknown> | null;
					return (
						json !== null &&
						json !== undefined &&
						json[(c.path as string[])[0]!] === c.equals
					);
				}
				if ("not" in c) {
					return c.not === null
						? value !== null && value !== undefined
						: value !== c.not;
				}
				if ("in" in c) {
					return (c.in as unknown[]).includes(value);
				}
				if ("notIn" in c) {
					return !(c.notIn as unknown[]).includes(value);
				}
				if ("lt" in c) {
					return (value as Date) < (c.lt as Date);
				}
				throw new Error(`Unsupported filter on ${key}`);
			}
			return value === cond;
		});
	}

	function apply(row: Row, data: Record<string, unknown>) {
		for (const [key, value] of Object.entries(data)) {
			if (
				value !== null &&
				typeof value === "object" &&
				"increment" in (value as object)
			) {
				row[key] =
					(row[key] as number) +
					(value as { increment: number }).increment;
			} else if (value !== undefined) {
				row[key] = value;
			}
		}
	}

	/** Serves every read and conditional write from `row`, which it mutates. */
	function fakeRow(overrides: Row = {}): Row {
		const row: Row = {
			id: "s",
			projectId: "p",
			organizationId: "org_1",
			userId: "author",
			version: 8,
			status: "VALIDATING",
			rejection: null,
			createdAt: new Date("2026-09-17T05:00:00.000Z"),
			proposalStatus: "PENDING",
			proposalDestination: "REPOSITORY",
			pullRequestOperationId: "op_1",
			pullRequestState: "QUEUED",
			pullRequestAttempt: 2,
			pullRequestHeadSha: null,
			pullRequestObligationOpen: false,
			pullRequestFailure: null,
			pullRequestNextAttemptAt: null,
			...overrides,
		};
		mocks.snapshot.findFirst.mockImplementation(
			async (args: { where: Record<string, unknown> }) =>
				matches(row, args.where) ? { ...row } : null,
		);
		mocks.snapshot.updateMany.mockImplementation(
			async (args: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				if (!matches(row, args.where)) {
					return { count: 0 };
				}
				apply(row, args.data);
				return { count: 1 };
			},
		);
		// The row lock a REPOSITORY cancel or verdict takes before it reads;
		// the verdict fences on the attempt this returns.
		mocks.$queryRaw.mockImplementation(async () => [
			{ id: row.id, attempt: row.pullRequestAttempt },
		]);
		return row;
	}

	function failure(phase: string, code = "VALIDATION_FAILED") {
		return {
			phase,
			code,
			retryable: true,
			at: "2026-09-24T10:00:00.000Z",
			params: {},
		};
	}

	function auditActions(): string[] {
		return auditMocks.recordAuditTx.mock.calls.map(
			(call) => (call[1] as { action: string }).action,
		);
	}

	function auditRow(action: string) {
		return auditMocks.recordAuditTx.mock.calls.find(
			(call) => (call[1] as { action: string }).action === action,
		)?.[1] as Record<string, unknown> | undefined;
	}

	/** Spec §4.4: the pre-create states a verdict or abandonment cancels. */
	const CANCELED_BY_VERDICT: Array<[string, Row]> = [
		["QUEUED", {}],
		["OPENING with no head SHA", { pullRequestState: "OPENING" }],
		[
			"BLOCKED in validation",
			{
				pullRequestState: "BLOCKED",
				pullRequestFailure: failure("validation"),
			},
		],
		[
			"BLOCKED at admission",
			{
				pullRequestState: "BLOCKED",
				pullRequestFailure: failure(
					"admission",
					"ATTRIBUTION_REJECTED",
				),
			},
		],
	];
	/** Every other state a PENDING REPOSITORY row can be in. */
	const LEFT_ALONE_BY_VERDICT: Array<[string, Row]> = [
		["OPEN", { pullRequestState: "OPEN", pullRequestHeadSha: HEAD }],
		[
			"OPENING with a head SHA",
			{ pullRequestState: "OPENING", pullRequestHeadSha: HEAD },
		],
		[
			"BLOCKED in push",
			{
				pullRequestState: "BLOCKED",
				pullRequestHeadSha: HEAD,
				pullRequestFailure: failure("push", "BRANCH_WRITE_REFUSED"),
			},
		],
		["CLOSE_REQUESTED", { pullRequestState: "CLOSE_REQUESTED" }],
	];

	describe("gate rejection (markInstructionSnapshotRejected)", () => {
		const rejections = [{ path: "a", reason: "secret", detail: "jwt" }];
		const audit = {
			action: "project.instructions.rejected",
			category: "project" as const,
			actor: { type: "user" as const, userId: "author" },
			organizationId: "org_1",
			projectId: "p",
		};
		const input = {
			snapshotId: "s",
			projectId: "p",
			organizationId: "org_1",
			rejections,
			audit,
		};

		it.each(CANCELED_BY_VERDICT)(
			"moves %s to CANCELED with VALIDATION_REJECTED and a reconciled audit row",
			async (_, overrides) => {
				const row = fakeRow(overrides);

				expect(await markInstructionSnapshotRejected(input)).toEqual({
					changed: true,
				});

				expect(row).toMatchObject({
					status: "REJECTED",
					pullRequestState: "CANCELED",
					proposalStatus: "REJECTED",
					pullRequestAttempt: 3,
					pullRequestNextAttemptAt: null,
					pullRequestFailure: {
						phase: "validation",
						code: "VALIDATION_REJECTED",
						retryable: false,
						at: expect.any(String),
						params: {},
					},
				});
				expect(auditActions()).toEqual([
					"project.instructions.pull_request_reconciled",
					"project.instructions.rejected",
				]);
				expect(
					auditRow("project.instructions.pull_request_reconciled"),
				).toMatchObject({
					organizationId: "org_1",
					projectId: "p",
					resource: {
						type: "project_instruction_snapshot",
						id: "s",
						name: "v8",
					},
					metadata: {
						outcome: "canceled",
						operationId: "op_1",
						code: "VALIDATION_REJECTED",
						targetMismatch: false,
					},
				});
			},
		);

		it.each(LEFT_ALONE_BY_VERDICT)(
			"leaves %s alone: both status columns unchanged, the verdict still written",
			async (_, overrides) => {
				const row = fakeRow(overrides);
				const before = {
					pullRequestState: row.pullRequestState,
					pullRequestAttempt: row.pullRequestAttempt,
				};

				expect(await markInstructionSnapshotRejected(input)).toEqual({
					changed: true,
				});

				expect(row).toMatchObject({
					...before,
					status: "REJECTED",
					proposalStatus: "PENDING",
				});
				expect(auditActions()).toEqual([
					"project.instructions.rejected",
				]);
			},
		);

		it("fences the cancel on the attempt it reads under the row lock", async () => {
			fakeRow({ pullRequestAttempt: 6 });

			await markInstructionSnapshotRejected(input);

			const lock = mocks.$queryRaw.mock.calls
				.map((call) => (call[0] as string[]).join("?"))
				.find((sql) => sql.includes("FOR UPDATE"));
			expect(lock).toContain('"pullRequestAttempt"');
			const transition = mocks.snapshot.updateMany.mock.calls
				.map(
					([args]) =>
						args as {
							where: Record<string, unknown>;
							data: Record<string, unknown>;
						},
				)
				.find((args) => "pullRequestState" in args.data);
			expect(JSON.stringify(transition?.where)).toContain(
				'"pullRequestAttempt":6',
			);
		});

		it("never writes proposalStatus on a REPOSITORY row outside the transition", async () => {
			fakeRow();

			await markInstructionSnapshotRejected(input);

			// The FABRIC statement (`proposalStatus: PENDING` → REJECTED with
			// nothing else in its data) is not issued for this destination.
			for (const [args] of mocks.snapshot.updateMany.mock.calls) {
				const data = (args as { data: Record<string, unknown> }).data;
				if ("proposalStatus" in data) {
					expect(data).toHaveProperty("pullRequestState");
				}
			}
		});
	});

	describe("abandonment (rejectAbandonedInstructionSnapshot)", () => {
		const input = {
			snapshotId: "s",
			projectId: "p",
			organizationId: "org_1",
			cutoff: new Date("2026-09-17T06:00:00.000Z"),
		};

		it.each(CANCELED_BY_VERDICT)(
			"moves %s to CANCELED with params { reason: abandoned }",
			async (_, overrides) => {
				const row = fakeRow({ status: "RECEIVING", ...overrides });

				expect(await rejectAbandonedInstructionSnapshot(input)).toEqual(
					{
						changed: true,
					},
				);

				expect(row).toMatchObject({
					status: "REJECTED",
					pullRequestState: "CANCELED",
					proposalStatus: "REJECTED",
					pullRequestAttempt: 3,
					pullRequestFailure: {
						phase: "validation",
						code: "VALIDATION_REJECTED",
						retryable: false,
						params: { reason: "abandoned" },
					},
				});
				expect(auditActions()).toEqual([
					"project.instructions.pull_request_reconciled",
					"project.instructions.rejected",
				]);
				expect(
					auditRow("project.instructions.pull_request_reconciled"),
				).toMatchObject({
					actor: { type: "user", userId: "author" },
					metadata: {
						outcome: "canceled",
						operationId: "op_1",
						code: "VALIDATION_REJECTED",
						targetMismatch: false,
					},
				});
			},
		);

		it.each(LEFT_ALONE_BY_VERDICT)(
			"leaves %s alone while still closing out the upload",
			async (_, overrides) => {
				const row = fakeRow({ status: "RECEIVING", ...overrides });
				const state = row.pullRequestState;

				expect(await rejectAbandonedInstructionSnapshot(input)).toEqual(
					{
						changed: true,
					},
				);

				expect(row).toMatchObject({
					status: "REJECTED",
					pullRequestState: state,
					proposalStatus: "PENDING",
					pullRequestAttempt: 2,
				});
				expect(auditActions()).toEqual([
					"project.instructions.rejected",
				]);
			},
		);
	});

	describe("review decisions", () => {
		const audit = {
			...proposalAudit,
			action: "project.instructions.rejected",
		};

		for (const [label, settings] of [
			[
				"while the repository is the source of truth",
				{ sourceOfTruth: "REPOSITORY" },
			],
			[
				"after the project flipped to UPLOAD",
				{ sourceOfTruth: "UPLOAD" },
			],
		] as const) {
			it(`approve refuses a REPOSITORY proposal ${label}`, async () => {
				mocks.$queryRaw.mockResolvedValue([
					{ pointerId: "base", instructionSettings: settings },
				]);
				mocks.snapshot.findFirst.mockResolvedValue({
					id: "proposal",
					version: 9,
					status: "READY",
					proposalStatus: "PENDING",
					proposalDestination: "REPOSITORY",
					baseSnapshotId: "base",
				});

				expect(
					await approveInstructionProposal({
						snapshotId: "proposal",
						projectId: "p",
						organizationId: "o",
						reviewerUserId: "reviewer",
						audit: proposalAudit,
					}),
				).toEqual({ ok: false, reason: "repository_proposal" });
				expect(mocks.snapshot.updateMany).not.toHaveBeenCalled();
				expect(mocks.project.updateMany).not.toHaveBeenCalled();
				expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
			});
		}

		it("reject refuses a REPOSITORY proposal", async () => {
			mocks.snapshot.findFirst.mockResolvedValue({
				id: "proposal",
				version: 9,
				status: "READY",
				proposalStatus: "PENDING",
				proposalDestination: "REPOSITORY",
			});

			expect(
				await rejectInstructionProposal({
					snapshotId: "proposal",
					projectId: "p",
					organizationId: "o",
					reviewerUserId: "reviewer",
					audit,
				}),
			).toEqual({ ok: false, reason: "repository_proposal" });
			expect(mocks.snapshot.updateMany).not.toHaveBeenCalled();
			expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
		});
	});

	describe("publishInstructionSnapshot", () => {
		it.each(["PENDING", "APPROVED", "REJECTED", "MERGED", "CLOSED"])(
			"refuses a REPOSITORY proposal in status %s on both paths",
			async (proposalStatus) => {
				for (const allowRollback of [true, false]) {
					lockedPointer("base", 7);
					mocks.snapshot.findFirst.mockResolvedValueOnce({
						id: "proposal",
						status: "READY",
						proposalStatus,
						proposalDestination: "REPOSITORY",
						version: 8,
						baseSnapshotId: "base",
						baseVersion: 7,
						publishedAt: null,
						source: "UPLOAD",
					});
					expect(
						await publishInstructionSnapshot({
							snapshotId: "proposal",
							projectId: "p",
							organizationId: "o",
							allowRollback,
						}),
					).toEqual({
						published: false,
						changed: false,
						reason: "repository_proposal",
					});
				}
				expect(mocks.project.updateMany).not.toHaveBeenCalled();
			},
		);

		// R14: the check was a denylist of PENDING and REJECTED, which the two
		// new statuses would have slipped through.
		it.each(["MERGED", "CLOSED"])(
			"refuses any proposal status that is not APPROVED, including %s",
			async (proposalStatus) => {
				lockedPointer("base", 7);
				mocks.snapshot.findFirst.mockResolvedValueOnce({
					id: "proposal",
					status: "READY",
					proposalStatus,
					version: 8,
					baseSnapshotId: "base",
					baseVersion: 7,
					publishedAt: null,
				});
				expect(
					await publishInstructionSnapshot({
						snapshotId: "proposal",
						projectId: "p",
						organizationId: "o",
						allowRollback: true,
					}),
				).toEqual({
					published: false,
					changed: false,
					reason: "proposal_not_approved",
				});
				expect(mocks.project.updateMany).not.toHaveBeenCalled();
			},
		);
	});

	describe("cancelInstructionProposal", () => {
		const audit = {
			...proposalAudit,
			action: "project.instructions.rejected",
			actor: { type: "user" as const, userId: "author" },
		};
		const input = {
			snapshotId: "s",
			projectId: "p",
			organizationId: "org_1",
			proposerUserId: "author",
			audit,
		};

		it.each<[string, Row]>([
			["QUEUED while uploading", { status: "RECEIVING" }],
			["QUEUED once validated", { status: "READY" }],
			[
				"BLOCKED at admission",
				{
					status: "READY",
					pullRequestState: "BLOCKED",
					pullRequestFailure: failure(
						"admission",
						"ATTRIBUTION_REJECTED",
					),
				},
			],
			[
				"BLOCKED in validation",
				{
					status: "FAILED",
					pullRequestState: "BLOCKED",
					pullRequestFailure: failure(
						"validation",
						"VALIDATION_TIMEOUT",
					),
				},
			],
		])(
			"cancels %s before anything was created, in the existing transaction",
			async (_, overrides) => {
				const row = fakeRow(overrides);
				const stateBefore = row.pullRequestState;
				const statusBefore = row.status;

				expect(await cancelInstructionProposal(input)).toEqual({
					ok: true,
					changed: true,
					version: 8,
					pullRequest: "canceled",
				});

				expect(row).toMatchObject({
					pullRequestState: "CANCELED",
					proposalStatus: "REJECTED",
					pullRequestAttempt: 3,
					pullRequestNextAttemptAt: null,
					// The existing cancellation's own writes.
					status: statusBefore === "READY" ? "READY" : "REJECTED",
					reviewedAt: expect.any(Date),
				});
				if (statusBefore !== "READY") {
					expect(row.rejection).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								path: "(proposal staging)",
								detail: "staging pending",
							}),
						]),
					);
				}
				expect(
					auditRow(
						"project.instructions.pull_request_close_requested",
					),
				).toMatchObject({
					actor: { type: "user", userId: "author" },
					metadata: { operationId: "op_1", stateBefore },
				});
				// The withdrawal itself is recorded as today's cancel is.
				expect(auditRow("project.instructions.rejected")).toEqual(
					audit,
				);
			},
		);

		it.each<[string, Row]>([
			["OPENING", { status: "READY", pullRequestState: "OPENING" }],
			[
				"OPEN",
				{
					status: "READY",
					pullRequestState: "OPEN",
					pullRequestHeadSha: HEAD,
				},
			],
			[
				"BLOCKED in push",
				{
					status: "READY",
					pullRequestState: "BLOCKED",
					pullRequestHeadSha: HEAD,
					pullRequestFailure: failure("push", "BRANCH_WRITE_REFUSED"),
				},
			],
			[
				"BLOCKED in validation after a push",
				{
					status: "READY",
					pullRequestState: "BLOCKED",
					pullRequestObligationOpen: true,
					pullRequestFailure: failure("validation"),
				},
			],
		])(
			"asks settlement to close %s: CLOSE_REQUESTED, attempt + 1, failure cleared",
			async (_, overrides) => {
				const row = fakeRow(overrides);
				const stateBefore = row.pullRequestState;

				expect(await cancelInstructionProposal(input)).toEqual({
					ok: true,
					changed: true,
					version: 8,
					pullRequest: "close_requested",
				});

				expect(row).toMatchObject({
					pullRequestState: "CLOSE_REQUESTED",
					proposalStatus: "PENDING",
					pullRequestAttempt: 3,
					pullRequestFailure: "DbNull",
					pullRequestNextAttemptAt: null,
					status: "READY",
				});
				expect(row).not.toHaveProperty("reviewedAt");
				expect(auditActions()).toEqual([
					"project.instructions.pull_request_close_requested",
				]);
				expect(
					auditRow(
						"project.instructions.pull_request_close_requested",
					),
				).toMatchObject({
					metadata: { operationId: "op_1", stateBefore },
				});
			},
		);

		it("refuses validating work as today, and writes nothing", async () => {
			const row = fakeRow({ status: "VALIDATING" });

			expect(await cancelInstructionProposal(input)).toEqual({
				ok: false,
				reason: "in_progress",
			});
			expect(row).toMatchObject({
				pullRequestState: "QUEUED",
				pullRequestAttempt: 2,
			});
			expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
		});

		it("answers a repeated cancel idempotently from CLOSE_REQUESTED and CANCELED", async () => {
			fakeRow({ status: "READY", pullRequestState: "CLOSE_REQUESTED" });
			expect(await cancelInstructionProposal(input)).toEqual({
				ok: true,
				changed: false,
				version: 8,
				pullRequest: "close_requested",
			});

			fakeRow({
				status: "READY",
				pullRequestState: "CANCELED",
				proposalStatus: "REJECTED",
			});
			expect(await cancelInstructionProposal(input)).toEqual({
				ok: true,
				changed: false,
				version: 8,
				pullRequest: "canceled",
			});
			expect(mocks.snapshot.updateMany).not.toHaveBeenCalled();
			expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
		});

		it.each(["MERGED", "CLOSED"])(
			"refuses a proposal whose pull request is already %s",
			async (state) => {
				fakeRow({
					status: "READY",
					pullRequestState: state,
					proposalStatus: state,
				});
				expect(await cancelInstructionProposal(input)).toEqual({
					ok: false,
					reason: "already_decided",
				});
				expect(mocks.snapshot.updateMany).not.toHaveBeenCalled();
			},
		);

		it("only the proposer may cancel", async () => {
			fakeRow({ status: "READY", userId: "someone-else" });
			mocks.$queryRaw.mockResolvedValue([]);

			expect(await cancelInstructionProposal(input)).toEqual({
				ok: false,
				reason: "not_found",
			});
			expect(mocks.snapshot.updateMany).not.toHaveBeenCalled();
		});
	});
});

/**
 * Retention never deletes an unresolved pull-request operation (Fizzy #2563
 * spec §4.3). The predicate is added to all five sites, in their WHERE and
 * ahead of `skip`, and the decided-status filters gain MERGED and CLOSED.
 * `instruction-proposal-retention.integration.test.ts` runs the same
 * predicate on Postgres; these pin that every site carries it.
 */
describe("retention of pull-request operations", () => {
	const RESOLVED_SQL =
		'(s."pullRequestState" IS NULL OR s."pullRequestState" IN (\'MERGED\', \'CLOSED\', \'CANCELED\')) AND s."mergeSyncRequestedAt" IS NULL AND NOT s."pullRequestObligationOpen"';
	const DECIDED = {
		OR: [
			{ proposalStatus: null },
			{
				proposalStatus: {
					in: ["APPROVED", "REJECTED", "MERGED", "CLOSED"],
				},
			},
		],
	};

	it("both selection windows exclude unresolved operations ahead of skip, and admit MERGED and CLOSED", async () => {
		mocks.project.findUnique.mockResolvedValue({
			publishedInstructionSnapshotId: null,
		});
		mocks.snapshot.findMany.mockResolvedValue([]);

		await listPrunableInstructionSnapshots("p", "org_1", {
			ready: 5,
			rejected: 2,
		});

		expect(mocks.snapshot.findMany).toHaveBeenCalledTimes(2);
		for (const [args] of mocks.snapshot.findMany.mock.calls) {
			const where = (args as { where: { AND: unknown[] } }).where;
			expect(where.AND).toContainEqual(resolvedPullRequestOperation());
			expect(where.AND).toContainEqual(DECIDED);
			// The PENDING-base and cleanup-marker clauses stay.
			expect(where.AND).toContainEqual({
				derivedSnapshots: { none: { proposalStatus: "PENDING" } },
			});
			expect(JSON.stringify(where.AND)).toContain("(proposal staging)");
			// Null-safe: a row with no `rejection` (JSON null or SQL NULL)
			// carries no marker and stays prunable.
			expect(where.AND).toContainEqual({
				OR: [
					{ rejection: { equals: "AnyNull" } },
					{ NOT: expect.objectContaining({ OR: expect.any(Array) }) },
				],
			});
		}
	});

	it("both candidate windows exclude unresolved operations, with every value still bound", async () => {
		mocks.$queryRaw.mockResolvedValue([]);

		await listProjectsWithPrunableInstructionSnapshots(
			{ ready: 5, rejected: 2 },
			25,
			0,
		);

		const [strings, ...values] = mocks.$queryRaw.mock.calls.at(-1) as [
			TemplateStringsArray,
			...unknown[],
		];
		const statement = sqltag(strings, ...values);
		const sql = statement.sql.replace(/\s+/g, " ");
		expect(sql.split(`AND ${RESOLVED_SQL}`)).toHaveLength(3);
		// The fragment adds text, never a parameter.
		expect(statement.values).toEqual([5, 2, 0, 25]);
	});

	it("the DELETE refuses unresolved operations and admits MERGED and CLOSED", async () => {
		mocks.file.deleteMany.mockResolvedValue({ count: 1 });
		mocks.snapshot.deleteMany.mockResolvedValue({ count: 1 });

		await deleteInstructionSnapshot("s", "p", "org_1");

		const where = mocks.snapshot.deleteMany.mock.calls[0]![0].where as {
			AND: unknown[];
		};
		expect(where.AND).toContainEqual(resolvedPullRequestOperation());
		expect(where.AND).toContainEqual(DECIDED);
		expect(where.AND).toContainEqual({
			derivedSnapshots: { none: { proposalStatus: "PENDING" } },
		});
		expect(where.AND).toContainEqual({
			OR: [
				{ rejection: { equals: "AnyNull" } },
				{ NOT: expect.objectContaining({ OR: expect.any(Array) }) },
			],
		});
	});

	it.each([
		["an OPEN pull request", { pullRequestState: "OPEN" }],
		[
			"a merge sync still owed",
			{
				pullRequestState: "MERGED",
				mergeSyncRequestedAt: new Date("2026-09-24T10:00:00.000Z"),
			},
		],
		[
			"a record obligation",
			{ pullRequestState: "CANCELED", pullRequestObligationOpen: true },
		],
	])(
		"a manual delete of %s is refused as pull_request_unresolved and undoes the file delete",
		async (_, columns) => {
			mocks.file.deleteMany.mockResolvedValue({ count: 2 });
			mocks.snapshot.deleteMany.mockResolvedValue({ count: 0 });
			mocks.snapshot.findFirst.mockResolvedValue({
				id: "s",
				status: "READY",
				pullRequestObligationOpen: false,
				mergeSyncRequestedAt: null,
				...columns,
			});
			mocks.snapshot.count.mockResolvedValue(0);

			expect(await deleteInstructionSnapshot("s", "p", "org_1")).toEqual({
				deleted: false,
				reason: "pull_request_unresolved",
			});
			// Thrown inside the transaction, so the file delete rolled back.
			expect(mocks.$transaction).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps answering active for a FABRIC row with no operation", async () => {
		mocks.file.deleteMany.mockResolvedValue({ count: 2 });
		mocks.snapshot.deleteMany.mockResolvedValue({ count: 0 });
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "s",
			status: "READY",
			pullRequestState: null,
			pullRequestObligationOpen: false,
			mergeSyncRequestedAt: null,
		});
		mocks.snapshot.count.mockResolvedValue(0);

		expect(await deleteInstructionSnapshot("s", "p", "org_1")).toEqual({
			deleted: false,
			reason: "active",
		});
	});
});

/**
 * `resolveInstructionSnapshotSource` / `resolveCurrentInstructionRepository`
 * (Fizzy #2709): the shared resolver the REST route and the MCP gateway both
 * call for a published snapshot's `source` and the project's top-level
 * `repository`, so the two surfaces cannot disagree.
 */
describe("resolveInstructionSnapshotSource and resolveCurrentInstructionRepository", () => {
	function settingsOf(sourceOfTruth: "UPLOAD" | "REPOSITORY" | null) {
		return { instructionSettings: { sourceOfTruth } };
	}

	function syncRowOf(overrides: Record<string, unknown> = {}) {
		return {
			id: "sync_1",
			projectId: "p",
			organizationId: "org_1",
			repositoryIntegrationId: "int_1",
			ref: "main",
			rootPath: "",
			automatic: false,
			generation: 1,
			automaticPausedReason: null,
			automaticPausedAt: null,
			user: { id: "u1", name: "Example Developer" },
			repositoryIntegration: {
				id: "int_1",
				provider: "GITHUB",
				repositoryUrl:
					"https://github.com/example-org/example-repo.git",
				repositoryOwner: "example-org",
				repositoryName: "example-repo",
				defaultBranch: "main",
				status: "ACTIVE",
			},
			...overrides,
		};
	}

	function snapshotOf(overrides: Record<string, unknown> = {}) {
		return {
			source: "UPLOAD",
			repositoryIntegrationId: null,
			sourceRef: null,
			sourceCommitSha: null,
			...overrides,
		} as {
			source: "UPLOAD" | "REPOSITORY";
			repositoryIntegrationId: string | null;
			sourceRef: string | null;
			sourceCommitSha: string | null;
		};
	}

	// Fizzy #2709 review: provenance is discriminated on the snapshot's own
	// `source` column, so every REPOSITORY-provenance fixture below carries
	// `source: "REPOSITORY"` explicitly rather than relying on the receipt
	// fields' mere presence.
	const REPO_SNAPSHOT_FIELDS = {
		source: "REPOSITORY",
		repositoryIntegrationId: "int_1",
		sourceRef: "main",
		sourceCommitSha: "a".repeat(40),
	};

	describe("resolveInstructionSnapshotSource", () => {
		it("resolves REPOSITORY with current: true when the integration and ref match the current sync row", async () => {
			mocks.project.findFirst.mockResolvedValue(settingsOf("REPOSITORY"));
			mocks.repositorySync.findFirst.mockResolvedValue(syncRowOf());

			const result = await resolveInstructionSnapshotSource(
				"p",
				"org_1",
				snapshotOf(REPO_SNAPSHOT_FIELDS),
			);

			expect(result.source).toEqual({
				kind: "REPOSITORY",
				ref: "main",
				commitSha: "a".repeat(40),
				current: true,
			});
			expect(result.repository).toEqual({
				provider: "GITHUB",
				host: "github.com",
				path: "example-org/example-repo",
				ref: "main",
				rootPath: "",
				generation: 1,
			});
			expect(mocks.project.findFirst).toHaveBeenCalledExactlyOnceWith({
				where: { id: "p", organizationId: "org_1" },
				select: { instructionSettings: true },
			});
			expect(
				mocks.repositorySync.findFirst,
			).toHaveBeenCalledExactlyOnceWith({
				where: { projectId: "p", organizationId: "org_1" },
				select: expect.any(Object),
			});
		});

		it("never puts the repository URL in the resolved config, only its bare lowercased hostname", async () => {
			mocks.project.findFirst.mockResolvedValue(settingsOf("REPOSITORY"));
			// Assembled at runtime, never a contiguous userinfo literal in
			// source, so the OSS relay's publication scan does not read this
			// fixture as a leaked credential.
			const withUserinfo = new URL(
				"https://GitHub.com/example-org/example-repo.git",
			);
			withUserinfo.username = "x-access-token";
			withUserinfo.password = "secret";
			mocks.repositorySync.findFirst.mockResolvedValue(
				syncRowOf({
					repositoryIntegration: {
						...syncRowOf().repositoryIntegration,
						repositoryUrl: withUserinfo.toString(),
					},
				}),
			);

			const result = await resolveInstructionSnapshotSource(
				"p",
				"org_1",
				snapshotOf(REPO_SNAPSHOT_FIELDS),
			);

			expect(result.repository?.host).toBe("github.com");
			expect(JSON.stringify(result)).not.toContain("secret");
			expect(JSON.stringify(result)).not.toContain("x-access-token");
		});

		it("resolves current: false when the sync has moved to a different branch", async () => {
			mocks.project.findFirst.mockResolvedValue(settingsOf("REPOSITORY"));
			mocks.repositorySync.findFirst.mockResolvedValue(
				syncRowOf({ ref: "develop" }),
			);

			const result = await resolveInstructionSnapshotSource(
				"p",
				"org_1",
				snapshotOf(REPO_SNAPSHOT_FIELDS),
			);

			expect(result.source).toMatchObject({ current: false });
		});

		it("resolves current: false when the sync has moved to a different repository", async () => {
			mocks.project.findFirst.mockResolvedValue(settingsOf("REPOSITORY"));
			mocks.repositorySync.findFirst.mockResolvedValue(
				syncRowOf({ repositoryIntegrationId: "int_2" }),
			);

			const result = await resolveInstructionSnapshotSource(
				"p",
				"org_1",
				snapshotOf(REPO_SNAPSHOT_FIELDS),
			);

			expect(result.source).toMatchObject({ current: false });
		});

		it("resolves current: false when there is no sync row at all (disconnected)", async () => {
			mocks.project.findFirst.mockResolvedValue(settingsOf("UPLOAD"));
			mocks.repositorySync.findFirst.mockResolvedValue(null);

			const result = await resolveInstructionSnapshotSource(
				"p",
				"org_1",
				snapshotOf(REPO_SNAPSHOT_FIELDS),
			);

			expect(result.source).toMatchObject({ current: false });
			expect(result.repository).toBeNull();
		});

		// The refinement that matters: a reconfigure that bumps the sync's
		// generation without changing the integration or the branch (for
		// example, flipping `automatic`) does not publish a new snapshot, so an
		// older snapshot from before that reconfigure must still read current.
		it("stays current: true across a generation bump when the integration and ref are unchanged", async () => {
			mocks.project.findFirst.mockResolvedValue(settingsOf("REPOSITORY"));
			mocks.repositorySync.findFirst.mockResolvedValue(
				syncRowOf({ generation: 5, automatic: true }),
			);

			const result = await resolveInstructionSnapshotSource(
				"p",
				"org_1",
				snapshotOf(REPO_SNAPSHOT_FIELDS),
			);

			expect(result.source).toMatchObject({ current: true });
		});

		// Fizzy #2709 review: provenance is discriminated on the snapshot's own
		// `source` column, never on whether the three receipt fields happen to
		// be populated — those are a snapshot's own history and can legitimately
		// stay populated (or partially populated, from data before this design)
		// on a row the writer marked UPLOAD.
		it.each([
			["nothing set", snapshotOf({ source: "UPLOAD" })],
			[
				"a stale, fully-populated receipt left from before this design",
				snapshotOf({ ...REPO_SNAPSHOT_FIELDS, source: "UPLOAD" }),
			],
			[
				"one stale receipt field set",
				snapshotOf({
					source: "UPLOAD",
					repositoryIntegrationId: "int_1",
				}),
			],
		])(
			"resolves UPLOAD when source is UPLOAD and %s",
			async (_label, snapshot) => {
				mocks.project.findFirst.mockResolvedValue(settingsOf("UPLOAD"));

				const result = await resolveInstructionSnapshotSource(
					"p",
					"org_1",
					snapshot,
				);

				expect(result.source).toEqual({ kind: "UPLOAD" });
				expect(mocks.repositorySync.findFirst).not.toHaveBeenCalled();
			},
		);

		// The invariant every repository-sync write upholds (design 2026-09-23
		// §4.2): a REPOSITORY-sourced snapshot always has all three receipt
		// fields together. A row that violates it is a data-integrity failure,
		// reported as one — never silently relabeled UPLOAD, which would tell a
		// caller a repository-published snapshot has no known repository, ref
		// or commit.
		it.each([
			[
				"repositoryIntegrationId missing",
				snapshotOf({
					source: "REPOSITORY",
					sourceRef: "main",
					sourceCommitSha: "a".repeat(40),
				}),
			],
			[
				"sourceRef missing",
				snapshotOf({
					source: "REPOSITORY",
					repositoryIntegrationId: "int_1",
					sourceCommitSha: "a".repeat(40),
				}),
			],
			[
				"sourceCommitSha missing",
				snapshotOf({
					source: "REPOSITORY",
					repositoryIntegrationId: "int_1",
					sourceRef: "main",
				}),
			],
			["nothing set", snapshotOf({ source: "REPOSITORY" })],
		])(
			"throws when source is REPOSITORY but %s, rather than relabeling UPLOAD",
			async (_label, snapshot) => {
				mocks.project.findFirst.mockResolvedValue(
					settingsOf("REPOSITORY"),
				);
				mocks.repositorySync.findFirst.mockResolvedValue(syncRowOf());

				await expect(
					resolveInstructionSnapshotSource("p", "org_1", snapshot),
				).rejects.toThrow(
					/REPOSITORY-sourced snapshot is missing its repository receipt fields/,
				);
			},
		);

		it("still resolves the top-level repository for an UPLOAD snapshot in a REPOSITORY-backed project", async () => {
			mocks.project.findFirst.mockResolvedValue(settingsOf("REPOSITORY"));
			mocks.repositorySync.findFirst.mockResolvedValue(syncRowOf());

			const result = await resolveInstructionSnapshotSource(
				"p",
				"org_1",
				snapshotOf(),
			);

			expect(result.source).toEqual({ kind: "UPLOAD" });
			expect(result.repository).toEqual({
				provider: "GITHUB",
				host: "github.com",
				path: "example-org/example-repo",
				ref: "main",
				rootPath: "",
				generation: 1,
			});
		});

		it("resolves repository: null for an UPLOAD project without ever reading the sync row", async () => {
			mocks.project.findFirst.mockResolvedValue(settingsOf("UPLOAD"));

			const result = await resolveInstructionSnapshotSource(
				"p",
				"org_1",
				snapshotOf(),
			);

			expect(result.repository).toBeNull();
			expect(mocks.repositorySync.findFirst).not.toHaveBeenCalled();
		});

		it("scopes both reads by the caller's own project and organization, not the snapshot's", async () => {
			mocks.project.findFirst.mockResolvedValue(settingsOf("REPOSITORY"));
			mocks.repositorySync.findFirst.mockResolvedValue(syncRowOf());

			await resolveInstructionSnapshotSource(
				"other-project",
				"other-org",
				snapshotOf(REPO_SNAPSHOT_FIELDS),
			);

			expect(mocks.project.findFirst).toHaveBeenCalledExactlyOnceWith({
				where: { id: "other-project", organizationId: "other-org" },
				select: { instructionSettings: true },
			});
			expect(
				mocks.repositorySync.findFirst,
			).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					where: {
						projectId: "other-project",
						organizationId: "other-org",
					},
				}),
			);
		});
	});

	/**
	 * Fizzy #2708 review: one settings read decides both `sourceOfTruth` and
	 * `repository`. The settings mock flips on every read; each resolver must
	 * read it once and answer consistently from that one read, so no result
	 * pairs `UPLOAD` with a repository (or `REPOSITORY` from a later read).
	 */
	describe("a settings flip between reads", () => {
		it.each([
			["REPOSITORY", "UPLOAD"],
			["UPLOAD", "REPOSITORY"],
		] as const)(
			"resolveCurrentInstructionSource answers from its one read (%s, then %s)",
			async (first, second) => {
				mocks.project.findFirst
					.mockResolvedValueOnce(settingsOf(first))
					.mockResolvedValue(settingsOf(second));
				mocks.repositorySync.findFirst.mockResolvedValue(syncRowOf());

				const result = await resolveCurrentInstructionSource(
					"p",
					"org_1",
				);

				expect(result.sourceOfTruth).toBe(first);
				expect(result.repository === null).toBe(first === "UPLOAD");
				expect(mocks.project.findFirst).toHaveBeenCalledTimes(1);
			},
		);

		it.each([
			["REPOSITORY", "UPLOAD"],
			["UPLOAD", "REPOSITORY"],
		] as const)(
			"resolveInstructionSnapshotSource answers from its one read (%s, then %s)",
			async (first, second) => {
				mocks.project.findFirst
					.mockResolvedValueOnce(settingsOf(first))
					.mockResolvedValue(settingsOf(second));
				mocks.repositorySync.findFirst.mockResolvedValue(syncRowOf());

				const result = await resolveInstructionSnapshotSource(
					"p",
					"org_1",
					snapshotOf(REPO_SNAPSHOT_FIELDS),
				);

				expect(result.sourceOfTruth).toBe(first);
				expect(result.repository === null).toBe(first === "UPLOAD");
				expect(mocks.project.findFirst).toHaveBeenCalledTimes(1);
			},
		);

		it("reports an absent setting as UPLOAD, with no repository", async () => {
			mocks.project.findFirst.mockResolvedValue(settingsOf(null));

			await expect(
				resolveCurrentInstructionSource("p", "org_1"),
			).resolves.toEqual({ sourceOfTruth: "UPLOAD", repository: null });
		});
	});

	describe("resolveCurrentInstructionRepository", () => {
		it("returns null without reading the sync row when the project is not repository-backed", async () => {
			mocks.project.findFirst.mockResolvedValue(settingsOf("UPLOAD"));

			const repository = await resolveCurrentInstructionRepository(
				"p",
				"org_1",
			);

			expect(repository).toBeNull();
			expect(mocks.repositorySync.findFirst).not.toHaveBeenCalled();
		});

		it("returns null when sourceOfTruth is REPOSITORY but the sync row is gone", async () => {
			mocks.project.findFirst.mockResolvedValue(settingsOf("REPOSITORY"));
			mocks.repositorySync.findFirst.mockResolvedValue(null);

			const repository = await resolveCurrentInstructionRepository(
				"p",
				"org_1",
			);

			expect(repository).toBeNull();
		});

		it("returns the current configuration when repository-backed", async () => {
			mocks.project.findFirst.mockResolvedValue(settingsOf("REPOSITORY"));
			mocks.repositorySync.findFirst.mockResolvedValue(
				syncRowOf({ rootPath: "services/api", generation: 4 }),
			);

			const repository = await resolveCurrentInstructionRepository(
				"p",
				"org_1",
			);

			expect(repository).toEqual({
				provider: "GITHUB",
				host: "github.com",
				path: "example-org/example-repo",
				ref: "main",
				rootPath: "services/api",
				generation: 4,
			});
		});

		// Fizzy #2709 review: `new URL(repositoryUrl)` throws on a scp-style or
		// malformed stored value, which would fail this read outright. The host
		// extraction handles every shape a stored `repositoryUrl` legitimately
		// takes, and degrades to `repository: null` — never a thrown error —
		// for anything it cannot read as one.
		//
		// The ssh-URL fixture below is assembled at runtime (joined, not one
		// literal) so its user-and-host shape never appears contiguous in
		// source, which is what the OSS relay's publication scan would
		// otherwise read as a leaked credential.
		const sshUrlWithUserinfo = [
			"ssh://git",
			"git.example.com/example-org/example-repo.git",
		].join("@");

		it.each([
			[
				"a plain https URL",
				"https://github.com/example-org/example-repo.git",
				"github.com",
			],
			[
				"a self-hosted https URL",
				"https://git.example.com/example-org/example-repo.git",
				"git.example.com",
			],
			["an ssh URL", sshUrlWithUserinfo, "git.example.com"],
			["an ssh URL with a port", "ssh://user@host:2222/path", "host"],
			[
				"scp-style shorthand",
				"git@github.com:example-org/example-repo.git",
				"github.com",
			],
			["userless scp-style shorthand", "host:path", "host"],
		])(
			"reads the host from %s",
			async (_label, repositoryUrl, expectedHost) => {
				mocks.project.findFirst.mockResolvedValue(
					settingsOf("REPOSITORY"),
				);
				mocks.repositorySync.findFirst.mockResolvedValue(
					syncRowOf({
						repositoryIntegration: {
							...syncRowOf().repositoryIntegration,
							repositoryUrl,
						},
					}),
				);

				const repository = await resolveCurrentInstructionRepository(
					"p",
					"org_1",
				);

				expect(repository?.host).toBe(expectedHost);
			},
		);

		// Fizzy #2709 review: `repositoryHost` must reject every scheme besides
		// `https:`/`ssh:` (a `file:` URL must never report its host), and must
		// never misread a Windows drive-letter path or a plain filesystem path
		// as scp-style `host:path` shorthand.
		it.each([
			["a value with no colon at all", "not a url at all"],
			["a Windows drive path with a backslash", "C:\\path"],
			["a Windows drive path with a forward slash", "C:/path"],
			["a local filesystem path", "/local/path"],
			["a file:// URL with an empty authority", "file:///local/path"],
			["a file:// URL with a host", "file://server/share"],
		])(
			"resolves repository: null, never a thrown error, for %s",
			async (_label, repositoryUrl) => {
				mocks.project.findFirst.mockResolvedValue(
					settingsOf("REPOSITORY"),
				);
				mocks.repositorySync.findFirst.mockResolvedValue(
					syncRowOf({
						repositoryIntegration: {
							...syncRowOf().repositoryIntegration,
							repositoryUrl,
						},
					}),
				);

				await expect(
					resolveCurrentInstructionRepository("p", "org_1"),
				).resolves.toBeNull();
			},
		);
	});
});
