/**
 * Publish first, scan afterwards (Fizzy #2737) — the query layer.
 *
 * The opt-in is frozen onto the snapshot at create time, READY carries the
 * PENDING scan in the same statement, the automatic publish re-checks the
 * acknowledging member's publish permission and writes its audit row in the
 * pointer's own transaction, History refuses to choose an unresolved
 * version, and the verdict moves PENDING -> outcome exactly once, whether the
 * workflow or the reaper writes it.
 *
 * Same mocked-client pattern as the other instruction query tests: the
 * assertions are about the STATEMENTS issued and the client they run on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { FakePrismaKnownRequestError } = vi.hoisted(() => ({
	FakePrismaKnownRequestError: class extends Error {
		code: string;
		constructor(code: string) {
			super(`prisma error ${code}`);
			this.code = code;
		}
	},
}));

const m = vi.hoisted(() => ({
	snapshot: {
		findFirst: vi.fn(),
		findMany: vi.fn(),
		create: vi.fn(),
		count: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
	},
	file: { createMany: vi.fn(), findMany: vi.fn() },
	project: { updateMany: vi.fn() },
	$queryRaw: vi.fn(),
	$transaction: vi.fn(),
	recordAuditTx: vi.fn(),
	canCreateProjectInstructions: vi.fn(),
	canUpdateProjectInstructions: vi.fn(),
}));

const tx = {
	projectInstructionSnapshot: m.snapshot,
	projectInstructionFile: m.file,
	project: m.project,
	$queryRaw: (...a: unknown[]) => m.$queryRaw(...a),
};

vi.mock("../prisma/client", async () => {
	const { empty, sqltag } = await vi.importActual<
		typeof import("@prisma/client/runtime/client")
	>("@prisma/client/runtime/client");
	return {
		db: {
			projectInstructionSnapshot: m.snapshot,
			projectInstructionFile: m.file,
			project: m.project,
			$transaction: m.$transaction,
			$queryRaw: (...a: unknown[]) => m.$queryRaw(...a),
		},
		Prisma: {
			PrismaClientKnownRequestError: FakePrismaKnownRequestError,
			JsonNull: "JsonNull",
			DbNull: "DbNull",
			empty,
			sql: sqltag,
		},
	};
});
vi.mock("../prisma/queries/audit-log", () => ({
	recordAuditTx: m.recordAuditTx,
}));
vi.mock("../prisma/queries/projects/projects", () => ({
	canCreateProjectInstructions: m.canCreateProjectInstructions,
	canUpdateProjectInstructions: m.canUpdateProjectInstructions,
}));

import {
	createDerivedInstructionSnapshot,
	createInstructionSnapshot,
	listStaleDeferredScanInstructionSnapshots,
	markInstructionSnapshotReady,
	markStaleDeferredScanIncomplete,
	publishInstructionSnapshot,
	recordInstructionDeferredScanOutcome,
} from "../prisma/queries/instructions";

const REF = {
	snapshotId: "snap_9",
	projectId: "proj_1",
	organizationId: "org_1",
};

const AUDIT = {
	action: "project.instructions.published_unscanned",
	category: "project",
	severity: "warning" as const,
	actor: { type: "user" as const, userId: "acknowledger_1" },
	organizationId: "org_1",
	projectId: "proj_1",
	resource: {
		type: "project_instruction_snapshot",
		id: "snap_9",
		name: "v9",
	},
	metadata: { version: 9, fileCount: 2, source: "auto_publish_before_scan" },
};

beforeEach(() => {
	for (const group of [m.snapshot, m.file, m.project]) {
		for (const fn of Object.values(group)) {
			fn.mockReset();
		}
	}
	for (const fn of [
		m.$queryRaw,
		m.$transaction,
		m.recordAuditTx,
		m.canCreateProjectInstructions,
		m.canUpdateProjectInstructions,
	]) {
		fn.mockReset();
	}
	m.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) =>
		cb(tx),
	);
	m.canCreateProjectInstructions.mockResolvedValue(true);
	m.canUpdateProjectInstructions.mockResolvedValue(true);
});

const UPLOAD_INPUT = {
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

describe("createInstructionSnapshot: the publish-first opt-in", () => {
	beforeEach(() => {
		m.snapshot.findFirst.mockResolvedValue({ version: 6 });
		m.snapshot.create.mockResolvedValue({ id: "snap_7", version: 7 });
		m.file.findMany.mockResolvedValue([
			{ id: "f1", path: "CLAUDE.md", storageKey: "k1" },
		]);
	});

	it("freezes publishBeforeScan onto the row when the member opted in", async () => {
		await createInstructionSnapshot({
			...UPLOAD_INPUT,
			publishBeforeScan: true,
		});

		expect(m.snapshot.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					publishOnReady: true,
					publishBeforeScan: true,
				}),
			}),
		);
	});

	it("writes no publishBeforeScan column at all for an ordinary upload", async () => {
		await createInstructionSnapshot(UPLOAD_INPUT);

		const data = (
			m.snapshot.create.mock.calls[0]?.[0] as {
				data: Record<string, unknown>;
			}
		).data;
		expect(data).not.toHaveProperty("publishBeforeScan");
	});

	it("refuses publishBeforeScan without publishOnReady before writing anything", async () => {
		await expect(
			createInstructionSnapshot({
				...UPLOAD_INPUT,
				publishOnReady: false,
				publishBeforeScan: true,
			}),
		).rejects.toThrow("publishBeforeScan requires publishOnReady");
		expect(m.snapshot.create).not.toHaveBeenCalled();
		expect(m.$transaction).not.toHaveBeenCalled();
	});
});

describe("createDerivedInstructionSnapshot: the publish-first opt-in", () => {
	const PREFIX = "projects/proj_1/instructions/snapshots/snap_base/";
	const derived = {
		projectId: "proj_1",
		organizationId: "org_1",
		userId: "user_1",
		baseSnapshotId: "snap_base",
		publishOnReady: true,
		proposal: false,
		changes: [
			{
				op: "put" as const,
				path: "README.md",
				size: 20,
				sha256: "f".repeat(64),
				mimeType: "text/markdown",
				isText: true,
				kind: "INSTRUCTIONS" as const,
				storageKey: "projects/proj_1/instructions/staging/pending/0",
			},
		],
		limits: { maxFiles: 5000, maxTotalBytes: 52_428_800 },
		baseKeyPrefix: PREFIX,
	};

	beforeEach(() => {
		m.$queryRaw.mockResolvedValue([
			{ publishedInstructionSnapshotId: "snap_base" },
		]);
		m.snapshot.count.mockResolvedValue(0);
		m.snapshot.findFirst.mockImplementation(async (args: unknown) => {
			const where =
				(args as { where?: Record<string, unknown> }).where ?? {};
			if ("id" in where) {
				return {
					id: "snap_base",
					status: "READY",
					source: "UPLOAD",
					version: 7,
					settingsFrozen: { layer: "default", ignoreGlobs: [] },
					excludedCount: 0,
				};
			}
			return { version: 7 };
		});
		m.snapshot.create.mockResolvedValue({ id: "snap_new", version: 8 });
		m.file.findMany
			.mockResolvedValueOnce([
				{
					id: "bf1",
					path: "CLAUDE.md",
					kind: "INSTRUCTIONS",
					name: null,
					description: null,
					storageKey: `${PREFIX}bf1`,
					sha256: "bf1-sha",
					size: 10,
					mimeType: "text/markdown",
					isText: true,
					mode: null,
				},
			])
			.mockResolvedValueOnce([{ id: "new_1", path: "README.md" }]);
	});

	it("freezes publishBeforeScan onto a direct, publishing derivation", async () => {
		const result = await createDerivedInstructionSnapshot({
			...derived,
			publishBeforeScan: true,
		});

		expect(result.ok).toBe(true);
		expect(m.snapshot.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					publishOnReady: true,
					publishBeforeScan: true,
				}),
			}),
		);
	});

	it("writes no publishBeforeScan column for an ordinary derivation", async () => {
		await createDerivedInstructionSnapshot(derived);

		const data = (
			m.snapshot.create.mock.calls[0]?.[0] as {
				data: Record<string, unknown>;
			}
		).data;
		expect(data).not.toHaveProperty("publishBeforeScan");
	});

	it.each([
		["a proposal", { proposal: true }],
		[
			"a derivation that does not publish itself",
			{ publishOnReady: false },
		],
	])(
		"refuses publishBeforeScan on %s before writing anything",
		async (_l, o) => {
			await expect(
				createDerivedInstructionSnapshot({
					...derived,
					...o,
					publishBeforeScan: true,
				}),
			).rejects.toThrow(
				"publishBeforeScan requires publishOnReady and no proposal",
			);
			expect(m.snapshot.create).not.toHaveBeenCalled();
		},
	);
});

describe("markInstructionSnapshotReady: deferredScan", () => {
	const input = {
		...REF,
		fileCount: 2,
		storedBytes: 42,
		digest: "d".repeat(64),
		readyAt: new Date("2026-09-26T00:00:00.000Z"),
	};

	it("writes READY and the PENDING scan in ONE conditional statement", async () => {
		m.$queryRaw.mockResolvedValue([{ updated: 1 }]);

		expect(
			await markInstructionSnapshotReady({
				...input,
				deferredScan: true,
			}),
		).toEqual({ changed: true });
		const [statement] = m.$queryRaw.mock.calls[0] as [
			{ sql: string; values: unknown[] },
		];
		expect(statement.sql).toContain("FOR UPDATE");
		expect(statement.sql).toContain("\"status\" = 'READY'");
		expect(statement.sql).toContain("\"deferredScanStatus\" = 'PENDING'");
	});

	it("leaves the scan column alone on the ordinary path", async () => {
		m.$queryRaw.mockResolvedValue([{ updated: 1 }]);

		await markInstructionSnapshotReady(input);

		const [statement] = m.$queryRaw.mock.calls[0] as [{ sql: string }];
		expect(statement.sql).not.toContain("deferredScanStatus");
	});
});

describe("publishInstructionSnapshot: publish-first rules", () => {
	function locked() {
		m.$queryRaw.mockResolvedValueOnce([
			{
				pointerId: "snap_8",
				pointerVersion: 8,
				instructionSettings: null,
			},
		]);
	}
	/**
	 * The project lock read, but with the pointer's settings marking the
	 * project repository-backed — what the `repository_backed`/
	 * `configuration_changed` fence reads.
	 */
	function lockedRepositoryBacked() {
		m.$queryRaw.mockResolvedValueOnce([
			{
				pointerId: "snap_8",
				pointerVersion: 8,
				instructionSettings: { sourceOfTruth: "REPOSITORY" },
			},
		]);
	}
	function snapshot(overrides: Record<string, unknown> = {}) {
		m.snapshot.findFirst.mockResolvedValue({
			id: "snap_9",
			status: "READY",
			proposalStatus: null,
			proposalDestination: null,
			version: 9,
			baseSnapshotId: null,
			baseVersion: null,
			publishedAt: null,
			source: "UPLOAD",
			userId: "acknowledger_1",
			settingsFrozen: { layer: "default" },
			deferredScanStatus: "PENDING",
			...overrides,
		});
	}

	beforeEach(() => {
		m.project.updateMany.mockResolvedValue({ count: 1 });
	});

	it("publishes a PENDING version automatically while its acknowledger can still publish, and audits in the same transaction", async () => {
		locked();
		snapshot();

		expect(
			await publishInstructionSnapshot({
				...REF,
				requireBaseUnmoved: true,
				audit: AUDIT,
			}),
		).toEqual({ published: true, changed: true });
		// The ACKNOWLEDGER's permission, on the transaction's client.
		expect(m.canUpdateProjectInstructions).toHaveBeenCalledWith(
			"proj_1",
			"acknowledger_1",
			tx,
		);
		expect(m.snapshot.update).toHaveBeenCalledWith({
			where: { id: "snap_9" },
			data: { publishedAt: expect.any(Date) },
		});
		expect(m.recordAuditTx).toHaveBeenCalledTimes(1);
		expect(m.recordAuditTx).toHaveBeenCalledWith(tx, AUDIT);
	});

	it("refuses as fast_path_not_authorized once the acknowledger lost the publish permission, and writes nothing", async () => {
		locked();
		snapshot();
		m.canUpdateProjectInstructions.mockResolvedValue(false);

		expect(
			await publishInstructionSnapshot({
				...REF,
				requireBaseUnmoved: true,
				audit: AUDIT,
			}),
		).toEqual({
			published: false,
			changed: false,
			reason: "fast_path_not_authorized",
		});
		expect(m.project.updateMany).not.toHaveBeenCalled();
		expect(m.snapshot.update).not.toHaveBeenCalled();
		expect(m.recordAuditTx).not.toHaveBeenCalled();
	});

	it("stays idempotent for an already-applied publication, even after the permission is gone", async () => {
		locked();
		snapshot({ publishedAt: new Date("2026-09-26T00:00:00.000Z") });
		m.canUpdateProjectInstructions.mockResolvedValue(false);

		expect(
			await publishInstructionSnapshot({
				...REF,
				requireBaseUnmoved: true,
				audit: AUDIT,
			}),
		).toEqual({ published: true, changed: false });
		expect(m.canUpdateProjectInstructions).not.toHaveBeenCalled();
		expect(m.recordAuditTx).not.toHaveBeenCalled();
	});

	it("writes no audit row when the pointer did not move", async () => {
		locked();
		snapshot();
		m.project.updateMany.mockResolvedValue({ count: 0 });

		const result = await publishInstructionSnapshot({
			...REF,
			requireBaseUnmoved: true,
			audit: AUDIT,
		});

		expect(result.changed).toBe(false);
		expect(m.recordAuditTx).not.toHaveBeenCalled();
	});

	it("never consults the publish permission for an ordinary snapshot", async () => {
		locked();
		snapshot({ deferredScanStatus: null });

		await publishInstructionSnapshot({ ...REF, requireBaseUnmoved: true });

		expect(m.canUpdateProjectInstructions).not.toHaveBeenCalled();
		expect(m.recordAuditTx).not.toHaveBeenCalled();
	});

	it.each(["PENDING", "ISSUES_FOUND", "INCOMPLETE"])(
		"History refuses a version whose deferred scan is %s, and writes nothing",
		async (status) => {
			locked();
			snapshot({ deferredScanStatus: status });

			expect(
				await publishInstructionSnapshot({
					...REF,
					allowRollback: true,
				}),
			).toEqual({
				published: false,
				changed: false,
				reason: "deferred_scan_unresolved",
			});
			expect(m.project.updateMany).not.toHaveBeenCalled();
		},
	);

	it.each([
		["PASSED", "PASSED"],
		["an ordinary snapshot", null],
	])("History may publish %s", async (_l, status) => {
		locked();
		snapshot({ deferredScanStatus: status });

		expect(
			await publishInstructionSnapshot({ ...REF, allowRollback: true }),
		).toMatchObject({ published: true, changed: true });
		// The manual path is a person choosing the version; the acknowledger's
		// permission is not its gate (the procedure's own is).
		expect(m.canUpdateProjectInstructions).not.toHaveBeenCalled();
	});

	// Fizzy #2760: History's own "publish anyway" acknowledgement skips the
	// refusal above for a scan that finished FLAGGED — ISSUES_FOUND or
	// INCOMPLETE, a terminal verdict no concurrent writer moves a snapshot out
	// of — and nothing else about the transaction changes.
	it.each(["ISSUES_FOUND", "INCOMPLETE"])(
		"publishes a version whose deferred scan is %s when the caller acknowledges it, and reports that status",
		async (status) => {
			locked();
			snapshot({ deferredScanStatus: status });

			expect(
				await publishInstructionSnapshot({
					...REF,
					allowRollback: true,
					acknowledgeDeferredScan: true,
				}),
			).toMatchObject({
				published: true,
				changed: true,
				deferredScanStatus: status,
			});
			expect(m.project.updateMany).toHaveBeenCalled();
			// The manual path's own permission check, not the automatic
			// path's acknowledger fence.
			expect(m.canUpdateProjectInstructions).not.toHaveBeenCalled();
		},
	);

	// Fizzy #2760 review: a PENDING target stays refused even with the
	// acknowledgement — waiting out the rest of a short-lived scan is the
	// only remedy, and publishing it anyway would race the outcome writers'
	// own snapshot-then-project locking, which is exactly what dropping the
	// snapshot lock here depends on PENDING never doing.
	it("still refuses a PENDING scan even when the caller acknowledges it, and writes nothing", async () => {
		locked();
		snapshot({ deferredScanStatus: "PENDING" });

		expect(
			await publishInstructionSnapshot({
				...REF,
				allowRollback: true,
				acknowledgeDeferredScan: true,
			}),
		).toEqual({
			published: false,
			changed: false,
			reason: "deferred_scan_unresolved",
		});
		expect(m.project.updateMany).not.toHaveBeenCalled();
	});

	// Reported for every manual publish, not only an acknowledged one — an
	// ordinary or already-passed target's row carries `deferredScanStatus`
	// too, and the procedure is what decides whether that is worth auditing.
	it.each([
		["PASSED", "PASSED"],
		["an ordinary snapshot", null],
	])(
		"reports %s's deferredScanStatus on an unflagged manual publish",
		async (_l, status) => {
			locked();
			snapshot({ deferredScanStatus: status });

			expect(
				await publishInstructionSnapshot({
					...REF,
					allowRollback: true,
				}),
			).toMatchObject({ deferredScanStatus: status });
		},
	);

	it("still refuses without the acknowledgement, exactly as before", async () => {
		locked();
		snapshot({ deferredScanStatus: "ISSUES_FOUND" });

		expect(
			await publishInstructionSnapshot({
				...REF,
				allowRollback: true,
				acknowledgeDeferredScan: false,
			}),
		).toEqual({
			published: false,
			changed: false,
			reason: "deferred_scan_unresolved",
		});
		expect(m.project.updateMany).not.toHaveBeenCalled();
	});

	// Fizzy #2760 review: the acknowledgement only ever answers the
	// `deferred_scan_unresolved` refusal. Every earlier refusal the query
	// already had — none of them specific to a deferred scan — still wins,
	// whether or not this target happens to have an unresolved one.
	describe("acknowledgeDeferredScan does not override an earlier refusal", () => {
		it("still refuses not_ready", async () => {
			locked();
			snapshot({
				status: "VALIDATING",
				deferredScanStatus: "PENDING",
			});

			expect(
				await publishInstructionSnapshot({
					...REF,
					allowRollback: true,
					acknowledgeDeferredScan: true,
				}),
			).toMatchObject({ published: false, reason: "not_ready" });
			expect(m.$queryRaw).toHaveBeenCalledTimes(1);
		});

		it.each(["PENDING", "REJECTED"])(
			"still refuses proposal_not_approved for a %s proposal",
			async (proposalStatus) => {
				locked();
				snapshot({
					proposalStatus,
					deferredScanStatus: "PENDING",
				});

				expect(
					await publishInstructionSnapshot({
						...REF,
						allowRollback: true,
						acknowledgeDeferredScan: true,
					}),
				).toMatchObject({
					published: false,
					reason: "proposal_not_approved",
				});
				expect(m.$queryRaw).toHaveBeenCalledTimes(1);
			},
		);

		it("still refuses repository_proposal", async () => {
			locked();
			snapshot({
				proposalDestination: "REPOSITORY",
				deferredScanStatus: "PENDING",
			});

			expect(
				await publishInstructionSnapshot({
					...REF,
					allowRollback: true,
					acknowledgeDeferredScan: true,
				}),
			).toMatchObject({
				published: false,
				reason: "repository_proposal",
			});
			expect(m.$queryRaw).toHaveBeenCalledTimes(1);
		});

		it("still refuses repository_backed for an uploaded snapshot", async () => {
			lockedRepositoryBacked();
			// ISSUES_FOUND, not PENDING: PENDING is refused unconditionally
			// before this fence is ever reached (tested above), so only a
			// terminal flagged verdict — the one the acknowledgement actually
			// skips — can show repository_backed still winning underneath it.
			snapshot({ source: "UPLOAD", deferredScanStatus: "ISSUES_FOUND" });

			expect(
				await publishInstructionSnapshot({
					...REF,
					allowRollback: true,
					acknowledgeDeferredScan: true,
				}),
			).toMatchObject({
				published: false,
				reason: "repository_backed",
			});
		});
	});

	// A programming error, not a runtime condition — like the
	// `requireBaseUnmoved`/`allowRollback` guard right above it in the
	// source. The acknowledgement means nothing outside the manual path's own
	// refusal, so honoring it silently there would let a caller believe it
	// did something it cannot do.
	it.each([
		["the automatic path", { requireBaseUnmoved: true }],
		["neither flag", {}],
	])(
		"throws when acknowledgeDeferredScan is passed without allowRollback (%s)",
		async (_l, extra) => {
			await expect(
				publishInstructionSnapshot({
					...REF,
					...extra,
					acknowledgeDeferredScan: true,
				}),
			).rejects.toThrow(
				"acknowledgeDeferredScan is meaningful only with allowRollback",
			);
			expect(m.$transaction).not.toHaveBeenCalled();
		},
	);
});

describe("recordInstructionDeferredScanOutcome", () => {
	const findings = [
		{
			path: "CLAUDE.md",
			reason: "secret",
			detail: "aws-access-key",
			line: 3,
		},
	];

	it("moves READY + PENDING to the verdict and writes its audit row in the same transaction", async () => {
		m.snapshot.updateMany.mockResolvedValue({ count: 1 });
		const audit = {
			...AUDIT,
			action: "project.instructions.deferred_scan_issues_found",
		};

		expect(
			await recordInstructionDeferredScanOutcome({
				...REF,
				outcome: "ISSUES_FOUND",
				findings,
				audit,
			}),
		).toEqual({ changed: true });
		expect(m.snapshot.updateMany).toHaveBeenCalledWith({
			where: {
				id: "snap_9",
				projectId: "proj_1",
				organizationId: "org_1",
				status: "READY",
				deferredScanStatus: "PENDING",
			},
			data: {
				progressPhase: null,
				progressDone: null,
				progressTotal: null,
				progressUpdatedAt: null,
				deferredScanStatus: "ISSUES_FOUND",
				deferredScanFindings: findings,
				deferredScanCompletedAt: expect.any(Date),
			},
		});
		expect(m.recordAuditTx).toHaveBeenCalledWith(tx, audit);
	});

	it("stores a JSON null, not an empty list, when there are no findings", async () => {
		m.snapshot.updateMany.mockResolvedValue({ count: 1 });

		await recordInstructionDeferredScanOutcome({
			...REF,
			outcome: "PASSED",
			findings: [],
		});

		expect(m.snapshot.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					deferredScanStatus: "PASSED",
					deferredScanFindings: "JsonNull",
				}),
			}),
		);
		expect(m.recordAuditTx).not.toHaveBeenCalled();
	});

	it("stores an INCOMPLETE scan's findings when it established some", async () => {
		m.snapshot.updateMany.mockResolvedValue({ count: 1 });
		const findings = [
			{
				path: "A.md",
				reason: "secret",
				detail: "aws-access-key",
				line: 1,
			},
		];

		await recordInstructionDeferredScanOutcome({
			...REF,
			outcome: "INCOMPLETE",
			findings,
		});

		expect(m.snapshot.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					deferredScanStatus: "INCOMPLETE",
					deferredScanFindings: findings,
				}),
			}),
		);
	});

	it("is a no-op — no second audit row — once a verdict exists", async () => {
		m.snapshot.updateMany.mockResolvedValue({ count: 0 });

		expect(
			await recordInstructionDeferredScanOutcome({
				...REF,
				outcome: "INCOMPLETE",
				findings: [],
				audit: {
					...AUDIT,
					action: "project.instructions.deferred_scan_incomplete",
				},
			}),
		).toEqual({ changed: false });
		expect(m.recordAuditTx).not.toHaveBeenCalled();
	});
});

describe("listStaleDeferredScanInstructionSnapshots", () => {
	const cutoff = new Date("2026-09-26T00:00:00.000Z");
	const where = {
		status: "READY",
		deferredScanStatus: "PENDING",
		readyAt: { lt: cutoff },
	};

	it("pages READY rows still PENDING past the cutoff in one total order, with updatedAt for the CAS", async () => {
		const row = {
			id: "s1",
			projectId: "p",
			organizationId: "o",
			updatedAt: new Date("2026-09-25T00:00:00.000Z"),
		};
		m.snapshot.findMany.mockResolvedValue([row]);
		m.snapshot.count.mockResolvedValue(250);

		expect(
			await listStaleDeferredScanInstructionSnapshots(cutoff, 100, 200),
		).toEqual({ candidates: [row], total: 250 });

		expect(m.snapshot.findMany).toHaveBeenCalledWith({
			where,
			// `id` breaks `readyAt` ties, so the order is total and a page
			// at an offset is a window of it — what the rotation walks.
			orderBy: [{ readyAt: "asc" }, { id: "asc" }],
			skip: 200,
			take: 100,
			select: {
				id: true,
				projectId: true,
				organizationId: true,
				updatedAt: true,
			},
		});
		// The population's size, over the SAME predicate, is what the reaper
		// wraps its offset at.
		expect(m.snapshot.count).toHaveBeenCalledWith({ where });
	});
});

describe("markStaleDeferredScanIncomplete", () => {
	const observedUpdatedAt = new Date("2026-09-25T00:00:00.000Z");

	it("compare-and-sets on the observed updatedAt and PENDING, then audits as the acknowledger", async () => {
		m.snapshot.updateMany.mockResolvedValue({ count: 1 });
		m.snapshot.findFirst.mockResolvedValue({
			userId: "acknowledger_1",
			version: 9,
		});

		expect(
			await markStaleDeferredScanIncomplete({
				...REF,
				observedUpdatedAt,
			}),
		).toEqual({ changed: true });
		expect(m.snapshot.updateMany).toHaveBeenCalledWith({
			where: {
				id: "snap_9",
				projectId: "proj_1",
				organizationId: "org_1",
				status: "READY",
				deferredScanStatus: "PENDING",
				updatedAt: observedUpdatedAt,
			},
			data: {
				progressPhase: null,
				progressDone: null,
				progressTotal: null,
				progressUpdatedAt: null,
				deferredScanStatus: "INCOMPLETE",
				deferredScanFindings: "JsonNull",
				deferredScanCompletedAt: expect.any(Date),
			},
		});
		expect(m.recordAuditTx).toHaveBeenCalledWith(
			tx,
			expect.objectContaining({
				action: "project.instructions.deferred_scan_incomplete",
				outcome: "failure",
				actor: { type: "user", userId: "acknowledger_1" },
				organizationId: "org_1",
				projectId: "proj_1",
				resource: {
					type: "project_instruction_snapshot",
					id: "snap_9",
					name: "v9",
				},
				metadata: {
					version: 9,
					reason: "workflow_not_running",
					source: "deferred_scan_reaper",
				},
			}),
		);
	});

	it("writes nothing more when the row moved after it was described", async () => {
		m.snapshot.updateMany.mockResolvedValue({ count: 0 });

		expect(
			await markStaleDeferredScanIncomplete({
				...REF,
				observedUpdatedAt,
			}),
		).toEqual({ changed: false });
		expect(m.snapshot.findFirst).not.toHaveBeenCalled();
		expect(m.recordAuditTx).not.toHaveBeenCalled();
	});
});
