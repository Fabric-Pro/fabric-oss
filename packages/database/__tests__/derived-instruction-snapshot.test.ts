/**
 * `createDerivedInstructionSnapshot` — a new version seeded from a READY one.
 *
 * The rule it implements is small and the consequences are not. An inherited
 * row is a POINTER into the base snapshot's immutable storage, so this query
 * decides three separable things at once: which rows carry the base's keys,
 * which rows are staged for upload, and whether the result is a coherent file
 * set at all. Getting the first one wrong publishes a version whose bytes
 * belong to another snapshot; getting the second wrong makes the client try to
 * PUT over an immutable object; getting the third wrong publishes a tree with
 * two files that are one file on a case-insensitive filesystem.
 *
 * Same mocked-client pattern as `instruction-manifest-diff.test.ts`: the
 * Prisma client is replaced so the assertions are about the STATEMENTS the
 * query issues — including that both tenant columns are in every WHERE clause.
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

const mocks = vi.hoisted(() => ({
	snapshot: {
		findFirst: vi.fn(),
		create: vi.fn(),
		count: vi.fn(),
	},
	file: {
		createMany: vi.fn(),
		findMany: vi.fn(),
	},
	$transaction: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		projectInstructionSnapshot: mocks.snapshot,
		projectInstructionFile: mocks.file,
		$transaction: mocks.$transaction,
	},
	Prisma: {
		PrismaClientKnownRequestError: FakePrismaKnownRequestError,
		JsonNull: "JsonNull",
	},
}));

import {
	countInFlightDerivedSnapshots,
	createDerivedInstructionSnapshot,
} from "../prisma/queries/instructions";

const PROJECT = "proj_1";
const ORG = "org_1";
const BASE = "snap_base";
/** `snapshotPrefix(PROJECT, BASE)`, as the procedure computes it. */
const BASE_PREFIX = `projects/${PROJECT}/instructions/snapshots/${BASE}/`;

/** A promoted file row of the base snapshot. */
function baseFile(id: string, path: string, size = 10) {
	return {
		id,
		path,
		kind: "INSTRUCTIONS",
		name: null,
		description: null,
		storageKey: `${BASE_PREFIX}${id}`,
		sha256: `${id}-sha`,
		size,
		mimeType: "text/markdown",
		isText: true,
		mode: null,
	};
}

function input(
	changes: Parameters<typeof createDerivedInstructionSnapshot>[0]["changes"],
	overrides: Partial<
		Parameters<typeof createDerivedInstructionSnapshot>[0]
	> = {},
) {
	return {
		projectId: PROJECT,
		organizationId: ORG,
		userId: "user_1",
		baseSnapshotId: BASE,
		publishOnReady: true,
		changes,
		limits: { maxFiles: 5000, maxTotalBytes: 52_428_800 },
		baseKeyPrefix: BASE_PREFIX,
		...overrides,
	};
}

/** A `put` change in the shape the procedure builds. */
function put(path: string, size = 20) {
	return {
		op: "put" as const,
		path,
		size,
		sha256: "f".repeat(64),
		mimeType: "text/markdown",
		isText: true,
		kind: "INSTRUCTIONS" as const,
		storageKey: `projects/${PROJECT}/instructions/staging/pending/0`,
	};
}

beforeEach(() => {
	for (const group of [mocks.snapshot, mocks.file]) {
		for (const fn of Object.values(group)) {
			fn.mockReset();
		}
	}
	mocks.$transaction.mockReset();
	mocks.$transaction.mockImplementation(
		async (cb: (tx: unknown) => unknown) =>
			cb({
				projectInstructionSnapshot: mocks.snapshot,
				projectInstructionFile: mocks.file,
			}),
	);
	// The base, then the version-allocation read. `findFirst` is called twice
	// per attempt, in that order.
	mocks.snapshot.findFirst
		.mockResolvedValueOnce({
			id: BASE,
			status: "READY",
			source: "UPLOAD",
			version: 7,
			settingsFrozen: { layer: "default", ignoreGlobs: ["**/tasks/**"] },
			excludedCount: 4,
		})
		.mockResolvedValueOnce({ version: 7 });
	mocks.snapshot.create.mockResolvedValue({ id: "snap_new", version: 8 });
	mocks.file.findMany.mockResolvedValue([]);
});

/** Replaces the default base with one holding `files`. */
function withBaseFiles(files: ReturnType<typeof baseFile>[]) {
	mocks.file.findMany.mockReset();
	// First call inside the transaction loads the base's rows; the second
	// reads back the staged rows of the snapshot just created.
	mocks.file.findMany
		.mockResolvedValueOnce(files)
		.mockResolvedValueOnce([{ id: "new_1", path: "staged" }]);
}

describe("createDerivedInstructionSnapshot", () => {
	it("inherits every unchanged file at the BASE's key and stages only the puts", async () => {
		withBaseFiles([
			baseFile("bf1", "CLAUDE.md"),
			baseFile("bf2", ".claude/skills/review/SKILL.md"),
		]);

		const result = await createDerivedInstructionSnapshot(
			input([put(".claude/skills/review/SKILL.md", 33)]),
		);

		expect(result.ok).toBe(true);
		const rows = (
			mocks.file.createMany.mock.calls[0]![0] as {
				data: Array<Record<string, unknown>>;
			}
		).data;
		// CLAUDE.md was untouched, so it is inherited: the BASE's key, and the
		// base row's id recorded as its source.
		const inherited = rows.find((r) => r.path === "CLAUDE.md");
		expect(inherited).toMatchObject({
			snapshotId: "snap_new",
			projectId: PROJECT,
			organizationId: ORG,
			storageKey: `${BASE_PREFIX}bf1`,
			inheritedFromFileId: "bf1",
			sha256: "bf1-sha",
		});
		// The edited path is a fresh staged row, NOT an inherited one: its key
		// is provisional staging and it carries no inheritance.
		const staged = rows.find(
			(r) => r.path === ".claude/skills/review/SKILL.md",
		);
		expect(staged).toMatchObject({
			storageKey: `projects/${PROJECT}/instructions/staging/pending/0`,
			inheritedFromFileId: null,
			size: 33,
		});
		expect(rows).toHaveLength(2);
	});

	it("copies settingsFrozen and excludedCount from the base verbatim", async () => {
		withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

		await createDerivedInstructionSnapshot(input([put("README.md")]));

		expect(mocks.snapshot.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					baseSnapshotId: BASE,
					status: "RECEIVING",
					version: 8,
					projectId: PROJECT,
					organizationId: ORG,
					// The inherited files were admitted under THESE rules, and
					// the gate checks the stored `.fabricignore` still parses
					// to exactly them.
					settingsFrozen: {
						layer: "default",
						ignoreGlobs: ["**/tasks/**"],
					},
					excludedCount: 4,
					fileCount: 2,
				}),
			}),
		);
	});

	/**
	 * BLOCKING, round two. `baseSnapshotId` is `ON DELETE SET NULL`, so it is
	 * gone the moment the base is deleted or pruned — which a READY derived
	 * snapshot no longer prevents. The publish fast-forward and the history
	 * line both still need to know the row is an EDIT after that, so the
	 * base's version number is stored alongside the id and never updated.
	 */
	it("records the base's version number, which no lifecycle can clear", async () => {
		withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

		await createDerivedInstructionSnapshot(input([put("README.md")]));

		expect(mocks.snapshot.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					baseSnapshotId: BASE,
					baseVersion: 7,
				}),
			}),
		);
	});

	it("drops a deleted path from the new file set", async () => {
		withBaseFiles([
			baseFile("bf1", "CLAUDE.md"),
			baseFile("bf2", "AGENTS.md"),
		]);

		const result = await createDerivedInstructionSnapshot(
			input([{ op: "delete", path: "AGENTS.md" }]),
		);

		expect(result).toMatchObject({
			ok: true,
			fileCount: 1,
			inheritedCount: 1,
		});
		const rows = (
			mocks.file.createMany.mock.calls[0]![0] as {
				data: Array<Record<string, unknown>>;
			}
		).data;
		expect(rows.map((r) => r.path)).toEqual(["CLAUDE.md"]);
	});

	it("reads back ONLY the staged rows, so the client never PUTs an inherited one", async () => {
		withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

		await createDerivedInstructionSnapshot(input([put("README.md")]));

		expect(mocks.file.findMany).toHaveBeenLastCalledWith({
			where: {
				snapshotId: "snap_new",
				projectId: PROJECT,
				organizationId: ORG,
				inheritedFromFileId: null,
			},
			select: { id: true, path: true },
		});
	});

	it("loads the base under BOTH tenant columns", async () => {
		withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

		await createDerivedInstructionSnapshot(input([put("README.md")]));

		expect(mocks.snapshot.findFirst).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: {
					id: BASE,
					projectId: PROJECT,
					organizationId: ORG,
				},
			}),
		);
		expect(mocks.file.findMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: {
					snapshotId: BASE,
					projectId: PROJECT,
					organizationId: ORG,
				},
			}),
		);
	});

	describe("refusals", () => {
		it("refuses a base in another tenant as not found", async () => {
			mocks.snapshot.findFirst.mockReset();
			mocks.snapshot.findFirst.mockResolvedValue(null);

			expect(
				await createDerivedInstructionSnapshot(input([put("a.md")])),
			).toEqual({ ok: false, reason: "base_not_found" });
			expect(mocks.snapshot.create).not.toHaveBeenCalled();
		});

		it("refuses a base that is not READY", async () => {
			mocks.snapshot.findFirst.mockReset();
			mocks.snapshot.findFirst.mockResolvedValue({
				id: BASE,
				status: "VALIDATING",
				source: "UPLOAD",
				settingsFrozen: {},
				excludedCount: 0,
			});

			expect(
				await createDerivedInstructionSnapshot(input([put("a.md")])),
			).toEqual({ ok: false, reason: "base_not_ready" });
			expect(mocks.snapshot.create).not.toHaveBeenCalled();
		});

		it("refuses a delete for a path the base does not have", async () => {
			withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

			expect(
				await createDerivedInstructionSnapshot(
					input([{ op: "delete", path: "GONE.md" }]),
				),
			).toEqual({
				ok: false,
				reason: "delete_path_missing",
				detail: "GONE.md",
			});
			expect(mocks.snapshot.create).not.toHaveBeenCalled();
		});

		/**
		 * The pointer-safety invariant. A base row sitting outside the base's
		 * own immutable prefix would make the derived snapshot point at
		 * storage no activity in this feature ever wrote.
		 */
		it("refuses a base row whose key is outside the base's own prefix", async () => {
			withBaseFiles([
				{
					...baseFile("bf1", "CLAUDE.md"),
					storageKey: `projects/${PROJECT}/instructions/snapshots/someone_else/bf1`,
				},
			]);

			expect(
				await createDerivedInstructionSnapshot(input([put("a.md")])),
			).toEqual({
				ok: false,
				reason: "base_key_unexpected",
				detail: "CLAUDE.md",
			});
			expect(mocks.snapshot.create).not.toHaveBeenCalled();
		});

		it("refuses a put that collides case-insensitively with an inherited path", async () => {
			withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

			const result = await createDerivedInstructionSnapshot(
				input([put("Claude.md")]),
			);

			expect(result).toMatchObject({
				ok: false,
				reason: "path_collision",
			});
			expect(mocks.snapshot.create).not.toHaveBeenCalled();
		});

		it("allows a put at exactly an inherited path — that is an EDIT, not a collision", async () => {
			withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

			const result = await createDerivedInstructionSnapshot(
				input([put("CLAUDE.md")]),
			);

			expect(result).toMatchObject({ ok: true, inheritedCount: 0 });
		});

		it("refuses a change set that would leave no files", async () => {
			withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

			expect(
				await createDerivedInstructionSnapshot(
					input([{ op: "delete", path: "CLAUDE.md" }]),
				),
			).toEqual({ ok: false, reason: "empty_result" });
		});

		it("refuses a result over the file-count cap", async () => {
			withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

			expect(
				await createDerivedInstructionSnapshot(
					input([put("a.md")], {
						limits: { maxFiles: 1, maxTotalBytes: 99 },
					}),
				),
			).toMatchObject({ ok: false, reason: "too_many_files" });
		});

		it("refuses a result over the total-bytes cap, counting inherited bytes", async () => {
			withBaseFiles([baseFile("bf1", "CLAUDE.md", 100)]);

			expect(
				await createDerivedInstructionSnapshot(
					input([put("a.md", 100)], {
						limits: { maxFiles: 10, maxTotalBytes: 150 },
					}),
				),
			).toMatchObject({ ok: false, reason: "too_large", detail: "200" });
		});
	});

	/**
	 * Same read-then-write version allocation as `createInstructionSnapshot`,
	 * so the same P2002 retry has to be around it: two edits started on one
	 * project at the same moment both read version N.
	 */
	it("retries the insert when two derivations collide on the same version", async () => {
		mocks.snapshot.findFirst.mockReset();
		mocks.snapshot.findFirst
			.mockResolvedValueOnce({
				id: BASE,
				status: "READY",
				source: "UPLOAD",
				settingsFrozen: {},
				excludedCount: 0,
			})
			.mockResolvedValueOnce({ version: 7 })
			.mockResolvedValueOnce({
				id: BASE,
				status: "READY",
				source: "UPLOAD",
				settingsFrozen: {},
				excludedCount: 0,
			})
			.mockResolvedValueOnce({ version: 8 });
		mocks.file.findMany.mockResolvedValue([baseFile("bf1", "CLAUDE.md")]);
		mocks.snapshot.create
			.mockRejectedValueOnce(new FakePrismaKnownRequestError("P2002"))
			.mockResolvedValueOnce({ id: "snap_new", version: 9 });

		const result = await createDerivedInstructionSnapshot(
			input([put("a.md")]),
		);

		expect(result).toMatchObject({ ok: true, version: 9 });
		expect(mocks.snapshot.create).toHaveBeenCalledTimes(2);
	});
});

describe("countInFlightDerivedSnapshots", () => {
	/**
	 * FAILED is in the set with the two in-flight statuses because it is the
	 * one terminal status the pipeline REOPENS: `finalizeInstructionSnapshot`
	 * moves FAILED back to VALIDATING for a retry, and that retry reads the
	 * same inherited keys. Releasing the base the moment a derived child
	 * failed made "Try again" reject every inherited file as missing.
	 */
	it("counts unfinished children — RECEIVING, VALIDATING and the retryable FAILED — under both tenant columns", async () => {
		mocks.snapshot.count.mockResolvedValue(1);

		expect(await countInFlightDerivedSnapshots(BASE, PROJECT, ORG)).toBe(1);
		expect(mocks.snapshot.count).toHaveBeenCalledWith({
			where: {
				baseSnapshotId: BASE,
				projectId: PROJECT,
				organizationId: ORG,
				status: { in: ["RECEIVING", "VALIDATING", "FAILED"] },
			},
		});
	});
});
