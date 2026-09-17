import { beforeEach, describe, expect, it, vi } from "vitest";

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
	},
	file: {
		createMany: vi.fn(),
		findMany: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
		findFirst: vi.fn(),
		deleteMany: vi.fn(),
	},
	project: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
	$transaction: vi.fn(),
	// The reaper's candidate query is raw SQL: one UNIONed relation, so the
	// page is a window of ONE order rather than two separately-skipped ones.
	$queryRaw: vi.fn(),
}));

const auditMocks = vi.hoisted(() => ({ recordAuditTx: vi.fn() }));

vi.mock("../prisma/client", () => ({
	db: {
		projectInstructionSnapshot: mocks.snapshot,
		projectInstructionFile: mocks.file,
		project: mocks.project,
		$transaction: mocks.$transaction,
		$queryRaw: (...a: unknown[]) => mocks.$queryRaw(...a),
	},
	// Only the error class is used by the module under test, and only for
	// the `instanceof` + `.code` check that recognizes a version collision.
	Prisma: {
		PrismaClientKnownRequestError: FakePrismaKnownRequestError,
		JsonNull: "JsonNull",
	},
}));

// The rejection verdict and its audit row commit in ONE transaction, so the
// query module now reaches into `audit-log`. Mocked here to keep this a unit
// test of the transition itself: what matters is WHETHER the audit write is
// made and with which transaction client, not what it inserts.
vi.mock("../prisma/queries/audit-log", () => ({
	recordAuditTx: auditMocks.recordAuditTx,
}));

import {
	claimInstructionFileStagingKey,
	claimInstructionSnapshotValidation,
	createInstructionSnapshot,
	deleteInstructionSnapshot,
	failInstructionSnapshot,
	failStaleValidatingInstructionSnapshot,
	getInstructionFileByPath,
	listAbandonedReceivingInstructionSnapshots,
	listInstructionFiles,
	listPendingAbandonedInstructionSnapshots,
	listProjectsWithPrunableInstructionSnapshots,
	listPrunableInstructionSnapshots,
	listStaleValidatingInstructionSnapshots,
	markAbandonedInstructionSnapshotSwept,
	markInstructionSnapshotReady,
	markInstructionSnapshotRejected,
	publishInstructionSnapshot,
	rejectAbandonedInstructionSnapshot,
	rotateAbandonedInstructionSnapshot,
	startInstructionSnapshotValidation,
	updateInstructionFileMetadata,
} from "../prisma/queries/instructions";

beforeEach(() => {
	for (const group of [mocks.snapshot, mocks.file, mocks.project]) {
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
			}),
	);
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
});

describe("publishInstructionSnapshot", () => {
	it("refuses a snapshot that is not READY", async () => {
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "s",
			status: "VALIDATING",
			version: 8,
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

	// `changed` is what the publish ACTIVITY audits on: it distinguishes the
	// one call that actually moved the pointer from the idempotent retry
	// below, which also reports `published: true`. Auditing on `published`
	// would write a row per Temporal retry for a publication that happened
	// once.
	it("moves the pointer and stamps publishedAt via a single conditional write", async () => {
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "s",
			status: "READY",
			version: 8,
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
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "s",
			status: "READY",
			version: 8,
		});
		// The conditional write matches nothing because publishedInstructionSnapshotId
		// is already "s" (not null, and not a lower version than itself).
		mocks.project.updateMany.mockResolvedValue({ count: 0 });
		mocks.project.findUnique.mockResolvedValue({
			publishedInstructionSnapshotId: "s",
		});
		expect(
			await publishInstructionSnapshot({
				snapshotId: "s",
				projectId: "p",
				organizationId: "o",
			}),
		).toEqual({ published: true, changed: false });
		expect(mocks.snapshot.update).not.toHaveBeenCalled();
	});

	it("refuses when the conditional write matches nothing and the pointer belongs to a different, newer snapshot", async () => {
		mocks.snapshot.findFirst.mockResolvedValue({
			id: "s",
			status: "READY",
			version: 5,
		});
		mocks.project.updateMany.mockResolvedValue({ count: 0 });
		mocks.project.findUnique.mockResolvedValue({
			publishedInstructionSnapshotId: "newer-snap",
		});
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
 * I3: the published pointer's foreign key is `onDelete: Restrict`, so the
 * database refuses to delete a published snapshot. It was `SetNull`, which
 * made the delete succeed and silently clear the pointer — leaving the project
 * with no published coding instructions at all — whenever a publish won the
 * race against the read-then-delete check the callers relied on.
 */
describe("deleteInstructionSnapshot", () => {
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
			where: {
				id: "s",
				projectId: "p",
				organizationId: "org_1",
				// Important 3 (round 4): terminal only, enforced by the DELETE
				// itself rather than by a read above it or by the tab hiding
				// the button.
				status: { in: ["READY", "REJECTED", "FAILED"] },
			},
		});
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
		mocks.snapshot.updateMany.mockResolvedValue({ count: 0 });

		expect(await markInstructionSnapshotReady(input)).toEqual({
			changed: false,
		});
		// No second pass, no read-then-write repair: the conditional write is
		// the whole transition, and `readyAt` keeps the first attempt's value.
		expect(mocks.snapshot.updateMany).toHaveBeenCalledTimes(1);
		expect(mocks.snapshot.update).not.toHaveBeenCalled();
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
		mocks.snapshot.updateMany.mockResolvedValue({ count: 0 });

		expect(await markInstructionSnapshotRejected(input)).toEqual({
			changed: false,
		});
		// This is the retry after a lost completion: the verdict is already
		// there, so a second `project.instructions.rejected` row would be a
		// duplicate record of one refused upload.
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
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

		for (const call of mocks.snapshot.findMany.mock.calls) {
			expect(JSON.stringify(call[0])).not.toContain("RECEIVING");
			expect(JSON.stringify(call[0])).not.toContain("VALIDATING");
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

		await listPendingAbandonedInstructionSnapshots(200, [
			"snap_1",
			"snap_2",
		]);

		expect(mocks.snapshot.findMany).toHaveBeenCalledWith({
			where: {
				status: "REJECTED",
				// A refused upload's first rejection is a `secret`,
				// `hash_mismatch` or `ignore_mismatch`; only the sweep writes
				// `abandoned`, so only its own rows are re-swept.
				rejection: { path: ["0", "reason"], equals: "abandoned" },
				// The completion mark, and the ONLY thing that decides
				// eligibility. It goes in `AND` because one object literal
				// cannot carry two filters on the same `rejection` field.
				AND: [
					{
						rejection: {
							path: ["0", "detail"],
							equals: "staging pending",
						},
					},
				],
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

		await listPendingAbandonedInstructionSnapshots(200, []);

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
		mocks.snapshot.updateMany.mockResolvedValue({ count: 1 });

		expect(await markAbandonedInstructionSnapshotSwept(input)).toEqual({
			changed: true,
		});
		expect(mocks.snapshot.updateMany).toHaveBeenCalledTimes(1);
		const [args] = mocks.snapshot.updateMany.mock.calls[0]!;
		expect(args).toEqual({
			where: {
				id: "s",
				projectId: "p",
				organizationId: "org_1",
				// In the predicate, not in a read above it. The `abandoned`
				// reason is in there too, so this can only ever rewrite the
				// single-element array the reaper itself wrote — never a
				// refused upload's list of per-file rejections.
				status: "REJECTED",
				rejection: { path: ["0", "reason"], equals: "abandoned" },
				// The FROM-state. Without it two at-least-once activity
				// attempts both "succeed" and the loser rewrites a mark the
				// winner already cleared.
				AND: [
					{
						rejection: {
							path: ["0", "detail"],
							equals: "staging pending",
						},
					},
				],
			},
			data: {
				rejection: [
					{
						path: "(upload)",
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
		mocks.snapshot.updateMany.mockResolvedValue({ count: 0 });

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
		expect(args).toEqual({
			where: {
				id: "s",
				projectId: "p",
				organizationId: "org_1",
				// The full from-state, not status alone. Status alone would
				// re-date a row a concurrent attempt had already swept and
				// CLEARED, and — worse — an ordinary refused upload that this
				// sweep does not own at all.
				status: "REJECTED",
				rejection: { path: ["0", "reason"], equals: "abandoned" },
				AND: [
					{
						rejection: {
							path: ["0", "detail"],
							equals: "staging pending",
						},
					},
				],
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
	/** The one statement the query makes: its SQL text and its bound values. */
	function lastStatement(): { sql: string; values: unknown[] } {
		const [strings, ...values] = mocks.$queryRaw.mock.calls.at(-1) as [
			TemplateStringsArray,
			...unknown[],
		];
		return { sql: strings.join(" ? ").replace(/\s+/g, " "), values };
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
type RetentionRow = { id: string; version: number; status: string };

type SnapshotWhere = {
	status?: string | { in: string[] };
	publishedFor?: null;
};

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
			async (_sql: TemplateStringsArray, ...values: unknown[]) => {
				const [keepReady, keepRejected, offset, limit] =
					values as number[];
				const window = (where: SnapshotWhere) =>
					rows.filter((r) => matchesWhere(r, where, publishedId))
						.length;
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
