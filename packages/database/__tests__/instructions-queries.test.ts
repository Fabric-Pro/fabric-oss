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
}));

const auditMocks = vi.hoisted(() => ({ recordAuditTx: vi.fn() }));

vi.mock("../prisma/client", () => ({
	db: {
		projectInstructionSnapshot: mocks.snapshot,
		projectInstructionFile: mocks.file,
		project: mocks.project,
		$transaction: mocks.$transaction,
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
	createInstructionSnapshot,
	deleteInstructionSnapshot,
	failInstructionSnapshot,
	getInstructionFileByPath,
	listInstructionFiles,
	listPrunableInstructionSnapshots,
	markInstructionSnapshotReady,
	markInstructionSnapshotRejected,
	publishInstructionSnapshot,
	startInstructionSnapshotValidation,
	updateInstructionFileMetadata,
} from "../prisma/queries/instructions";

beforeEach(() => {
	for (const group of [mocks.snapshot, mocks.file, mocks.project]) {
		for (const fn of Object.values(group)) fn.mockReset();
	}
	mocks.$transaction.mockReset();
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
			},
			skip: 5,
		});
		expect(rejectedQuery![0]).toMatchObject({
			where: {
				projectId: "p",
				organizationId: "org_1",
				status: { in: ["REJECTED", "FAILED"] },
			},
			skip: 2,
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

	it("never returns the published snapshot, whichever window it falls in", async () => {
		mocks.project.findUnique.mockResolvedValue({
			publishedInstructionSnapshotId: "published-snap",
		});
		mocks.snapshot.findMany
			.mockResolvedValueOnce([
				{ id: "published-snap", files: [{ storageKey: "k1" }] },
				{ id: "prunable", files: [{ storageKey: "k2" }] },
			])
			.mockResolvedValueOnce([]);

		const rows = await listPrunableInstructionSnapshots("p", "org_1", {
			ready: 5,
			rejected: 2,
		});

		expect(rows).toEqual([{ id: "prunable", storageKeys: ["k2"] }]);
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
