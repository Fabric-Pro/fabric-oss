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

vi.mock("../prisma/client", () => ({
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
	},
}));
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
		m.snapshot.findFirst.mockResolvedValue({ proposalStatus: null });
		m.snapshot.updateMany.mockResolvedValue({ count: 1 });

		expect(
			await markInstructionSnapshotReady({
				...input,
				deferredScan: true,
			}),
		).toEqual({ changed: true });
		expect(m.snapshot.updateMany).toHaveBeenCalledTimes(1);
		expect(m.snapshot.updateMany).toHaveBeenCalledWith({
			where: {
				id: "snap_9",
				projectId: "proj_1",
				organizationId: "org_1",
				status: { notIn: ["READY", "REJECTED"] },
			},
			data: expect.objectContaining({
				status: "READY",
				deferredScanStatus: "PENDING",
			}),
		});
	});

	it("leaves the scan column alone on the ordinary path", async () => {
		m.snapshot.findFirst.mockResolvedValue({ proposalStatus: null });
		m.snapshot.updateMany.mockResolvedValue({ count: 1 });

		await markInstructionSnapshotReady(input);

		const data = (
			m.snapshot.updateMany.mock.calls[0]?.[0] as {
				data: Record<string, unknown>;
			}
		).data;
		expect(data).not.toHaveProperty("deferredScanStatus");
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
