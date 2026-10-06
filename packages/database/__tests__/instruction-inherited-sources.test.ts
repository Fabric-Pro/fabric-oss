/**
 * Inherited files and the scan rule-set version — the query layer.
 *
 * An inherited row stands on a file of another READY snapshot. What these
 * statements decide: which source rows are read and under which tenant, when
 * a create refuses a claimed source, how rows are moved onto their own keys
 * in bulk, and when a snapshot records that a rule-set version cleared it.
 *
 * Same mocked-client pattern as the other instruction query tests: the
 * assertions are about the STATEMENTS issued.
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
		create: vi.fn(),
		updateMany: vi.fn(),
	},
	file: { createMany: vi.fn(), findMany: vi.fn() },
	$transaction: vi.fn(),
	$executeRaw: vi.fn(),
	$queryRaw: vi.fn(),
	recordAuditTx: vi.fn(),
}));

vi.mock("../prisma/client", async () => {
	const { empty, sqltag } = await vi.importActual<
		typeof import("@prisma/client/runtime/client")
	>("@prisma/client/runtime/client");
	return {
		db: {
			projectInstructionSnapshot: m.snapshot,
			projectInstructionFile: m.file,
			$transaction: m.$transaction,
			$executeRaw: m.$executeRaw,
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
	canUpdateProjectInstructions: vi.fn(),
}));

import {
	createInstructionSnapshot,
	InstructionInheritedSourceError,
	listInheritedInstructionSources,
	markInstructionSnapshotReady,
	moveInheritedInstructionFileKeys,
	recordInstructionDeferredScanOutcome,
	recordInstructionSnapshotScanRulesVersion,
} from "../prisma/queries/instructions";

const PROJECT = "proj_1";
const ORG = "org_1";
const promotedKeyFor = (snapshotId: string, fileId: string) =>
	`projects/${PROJECT}/instructions/snapshots/${snapshotId}/${fileId}`;

/** The row a source file has in the database, with its snapshot. */
function sourceRow(
	overrides: Partial<{
		id: string;
		snapshotId: string;
		storageKey: string;
		sha256: string;
		size: number;
		status: string;
		scanRulesVersion: string | null;
		name: string | null;
		description: string | null;
	}> = {},
) {
	const id = overrides.id ?? "src_1";
	const snapshotId = overrides.snapshotId ?? "snap_pub";
	return {
		id,
		snapshotId,
		storageKey: overrides.storageKey ?? promotedKeyFor(snapshotId, id),
		sha256: overrides.sha256 ?? "a".repeat(64),
		size: overrides.size ?? 12,
		name: overrides.name ?? null,
		description: overrides.description ?? null,
		snapshot: {
			status: overrides.status ?? "READY",
			scanRulesVersion: overrides.scanRulesVersion ?? null,
		},
	};
}

function inheritedFile(overrides: Record<string, unknown> = {}) {
	return {
		path: "rules/a.md",
		size: 12,
		sha256: "a".repeat(64),
		mimeType: "text/markdown",
		isText: true,
		kind: "RULE" as const,
		storageKey: promotedKeyFor("snap_pub", "src_1"),
		inheritedFromFileId: "src_1",
		...overrides,
	};
}

function createInput(files: ReturnType<typeof inheritedFile>[]) {
	return {
		projectId: PROJECT,
		organizationId: ORG,
		userId: "user_1",
		source: "REPOSITORY" as const,
		settingsFrozen: {},
		publishOnReady: true,
		excludedCount: 0,
		files,
		promotedKeyFor,
	};
}

beforeEach(() => {
	for (const group of [m.snapshot, m.file]) {
		for (const fn of Object.values(group)) {
			fn.mockReset();
		}
	}
	m.$transaction.mockReset();
	m.$executeRaw.mockReset();
	m.$queryRaw.mockReset();
	m.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
		cb({
			projectInstructionSnapshot: m.snapshot,
			projectInstructionFile: m.file,
		}),
	);
	m.snapshot.findFirst.mockResolvedValue({ version: 7 });
	m.snapshot.create.mockResolvedValue({ id: "snap_new", version: 8 });
	m.snapshot.updateMany.mockResolvedValue({ count: 1 });
	m.file.findMany.mockResolvedValue([]);
});

describe("listInheritedInstructionSources", () => {
	it("reads every source in ONE statement, bound to the project and organization", async () => {
		m.file.findMany.mockResolvedValue([
			sourceRow({ id: "a" }),
			sourceRow({ id: "b", scanRulesVersion: "v1" }),
		]);

		const sources = await listInheritedInstructionSources({
			projectId: PROJECT,
			organizationId: ORG,
			sourceFileIds: ["a", "b", "a"],
		});

		expect(m.file.findMany).toHaveBeenCalledTimes(1);
		expect(m.file.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: { in: ["a", "b"] },
					projectId: PROJECT,
					organizationId: ORG,
				},
			}),
		);
		expect(sources.get("b")).toMatchObject({
			snapshotId: "snap_pub",
			snapshotStatus: "READY",
			scanRulesVersion: "v1",
		});
	});

	it("makes no query when nothing is inherited", async () => {
		const sources = await listInheritedInstructionSources({
			projectId: PROJECT,
			organizationId: ORG,
			sourceFileIds: [],
		});

		expect(sources.size).toBe(0);
		expect(m.file.findMany).not.toHaveBeenCalled();
	});
});

describe("moveInheritedInstructionFileKeys", () => {
	it("writes the whole chunk in one statement that only matches a row still on its source key", async () => {
		m.$executeRaw.mockResolvedValue(2);

		const result = await moveInheritedInstructionFileKeys({
			snapshotId: "snap_new",
			projectId: PROJECT,
			organizationId: ORG,
			moves: [
				{ fileId: "f1", from: "k/src/f1", to: "k/new/f1" },
				{ fileId: "f2", from: "k/src/f2", to: "k/new/f2" },
			],
		});

		expect(result).toEqual({ moved: 2 });
		expect(m.$executeRaw).toHaveBeenCalledTimes(1);
		const [strings, ...values] = m.$executeRaw.mock.calls[0] as [
			readonly string[],
			...unknown[],
		];
		const sql = strings.join("?");
		// The compare half: a retry finds the row already moved and matches nothing.
		expect(sql).toContain('f."storageKey" = v."from"');
		expect(sql).toContain('f."snapshotId" =');
		expect(sql).toContain('f."projectId" =');
		expect(sql).toContain('f."organizationId" =');
		expect(values).toContainEqual(["f1", "f2"]);
		expect(values).toContainEqual(["k/src/f1", "k/src/f2"]);
		expect(values).toContainEqual(["k/new/f1", "k/new/f2"]);
		expect(values).toContain("snap_new");
		expect(values).toContain(ORG);
	});

	it("issues nothing for an empty chunk", async () => {
		expect(
			await moveInheritedInstructionFileKeys({
				snapshotId: "snap_new",
				projectId: PROJECT,
				organizationId: ORG,
				moves: [],
			}),
		).toEqual({ moved: 0 });
		expect(m.$executeRaw).not.toHaveBeenCalled();
	});
});

describe("createInstructionSnapshot with inherited files", () => {
	it("writes the inherited rows pointing at their source, and sets no base", async () => {
		m.file.findMany.mockResolvedValueOnce([sourceRow()]);
		m.file.findMany.mockResolvedValueOnce([
			{ id: "f1", path: "rules/a.md", storageKey: "k" },
		]);

		await createInstructionSnapshot(createInput([inheritedFile()]));

		const data = m.file.createMany.mock.calls[0]?.[0].data as Array<
			Record<string, unknown>
		>;
		expect(data[0]).toMatchObject({
			path: "rules/a.md",
			inheritedFromFileId: "src_1",
			storageKey: promotedKeyFor("snap_pub", "src_1"),
		});
		const snapshotData = m.snapshot.create.mock.calls[0]?.[0].data;
		expect(snapshotData).not.toHaveProperty("baseSnapshotId");
		expect(snapshotData).not.toHaveProperty("baseVersion");
	});

	it("copies the source's name and description onto an inherited row, which the gate never re-derives", async () => {
		m.file.findMany.mockResolvedValueOnce([
			sourceRow({ name: "review", description: "Reviews a diff" }),
		]);
		m.file.findMany.mockResolvedValueOnce([
			{ id: "f1", path: "rules/a.md", storageKey: "k" },
		]);

		await createInstructionSnapshot(
			createInput([
				inheritedFile({
					path: ".claude/skills/review/SKILL.md",
					kind: "SKILL",
				}),
				inheritedFile({
					path: "CLAUDE.md",
					kind: "INSTRUCTIONS",
					inheritedFromFileId: undefined,
					storageKey:
						"projects/proj_1/instructions/staging/pending/1",
				}),
			]),
		);

		const data = m.file.createMany.mock.calls[0]?.[0].data as Array<
			Record<string, unknown>
		>;
		expect(data[0]).toMatchObject({
			name: "review",
			description: "Reviews a diff",
		});
		// A staged row's metadata comes from the bytes the gate reads.
		expect(data[1]).toMatchObject({ name: null, description: null });
	});

	it("leaves an ordinary file's row exactly as before", async () => {
		m.file.findMany.mockResolvedValue([]);

		await createInstructionSnapshot(
			createInput([
				inheritedFile({
					inheritedFromFileId: undefined,
					storageKey:
						"projects/proj_1/instructions/staging/pending/0",
				}),
			]),
		);

		expect(m.file.createMany.mock.calls[0]?.[0].data[0]).toMatchObject({
			inheritedFromFileId: null,
		});
		// No source lookup for a tree with nothing inherited.
		expect(m.file.findMany).toHaveBeenCalledTimes(1);
	});

	it.each([
		["the source is not there (another project, or pruned)", null],
		[
			"the source's snapshot is not READY",
			sourceRow({ status: "REJECTED" }),
		],
		["the source holds other bytes", sourceRow({ sha256: "b".repeat(64) })],
		["the source has another size", sourceRow({ size: 99 })],
		[
			"the source is not at its own promoted key",
			sourceRow({
				storageKey: "projects/proj_1/instructions/staging/x/y",
			}),
		],
	])(
		"refuses the whole create when %s, writing nothing",
		async (_label, source) => {
			m.file.findMany.mockResolvedValueOnce(source ? [source] : []);

			await expect(
				createInstructionSnapshot(createInput([inheritedFile()])),
			).rejects.toBeInstanceOf(InstructionInheritedSourceError);

			expect(m.snapshot.create).not.toHaveBeenCalled();
			expect(m.file.createMany).not.toHaveBeenCalled();
		},
	);

	it("refuses a row whose own key is not the source's promoted key", async () => {
		m.file.findMany.mockResolvedValueOnce([sourceRow()]);

		await expect(
			createInstructionSnapshot(
				createInput([
					inheritedFile({
						storageKey: "projects/other/instructions/snapshots/x/y",
					}),
				]),
			),
		).rejects.toBeInstanceOf(InstructionInheritedSourceError);
	});

	it("requires the key builder when a file inherits", async () => {
		await expect(
			createInstructionSnapshot({
				...createInput([inheritedFile()]),
				promotedKeyFor: undefined,
			}),
		).rejects.toThrow("promotedKeyFor");
	});
});

describe("the scan rule-set version", () => {
	const ready = {
		snapshotId: "snap_9",
		projectId: PROJECT,
		organizationId: ORG,
		fileCount: 3,
		storedBytes: 30,
		digest: "d".repeat(64),
		readyAt: new Date("2026-10-02T00:00:00Z"),
	};

	beforeEach(() => {
		m.$queryRaw.mockResolvedValue([{ updated: 1 }]);
	});

	it("is written by its own statement, bound to the statuses and the run's token", async () => {
		const result = await recordInstructionSnapshotScanRulesVersion({
			snapshotId: "snap_9",
			projectId: PROJECT,
			organizationId: ORG,
			scanRulesVersion: "rules-v1",
			statuses: ["RECEIVING", "VALIDATING"],
			validationAttemptId: "attempt-1",
		});

		expect(result).toEqual({ changed: true });
		expect(m.snapshot.updateMany).toHaveBeenCalledWith({
			where: {
				id: "snap_9",
				projectId: PROJECT,
				organizationId: ORG,
				status: { in: ["RECEIVING", "VALIDATING"] },
				validationAttemptId: "attempt-1",
			},
			data: { scanRulesVersion: "rules-v1" },
		});
	});

	it("matches a deferred scan's READY row without a token", async () => {
		await recordInstructionSnapshotScanRulesVersion({
			snapshotId: "snap_9",
			projectId: PROJECT,
			organizationId: ORG,
			scanRulesVersion: "rules-v1",
			statuses: ["READY"],
		});

		const where = m.snapshot.updateMany.mock.calls[0]?.[0].where;
		expect(where.status).toEqual({ in: ["READY"] });
		expect(where).not.toHaveProperty("validationAttemptId");
	});

	it("reports an unmatched row (superseded run, wrong status) as unchanged", async () => {
		m.snapshot.updateMany.mockResolvedValue({ count: 0 });

		expect(
			await recordInstructionSnapshotScanRulesVersion({
				snapshotId: "snap_9",
				projectId: PROJECT,
				organizationId: ORG,
				scanRulesVersion: "rules-v1",
				statuses: ["READY"],
			}),
		).toEqual({ changed: false });
	});

	it("is not part of the READY transition: no activity but the one that ran the rules claims it", async () => {
		await markInstructionSnapshotReady(ready);
		await markInstructionSnapshotReady({ ...ready, deferredScan: true });

		for (const [statement] of m.$queryRaw.mock.calls) {
			expect((statement as { sql: string }).sql).not.toContain(
				"scanRulesVersion",
			);
		}
	});

	it("is not part of the deferred verdict either", async () => {
		await recordInstructionDeferredScanOutcome({
			snapshotId: "snap_9",
			projectId: PROJECT,
			organizationId: ORG,
			findings: [],
			outcome: "PASSED",
		});

		expect(
			m.snapshot.updateMany.mock.calls[0]?.[0].data,
		).not.toHaveProperty("scanRulesVersion");
	});
});
