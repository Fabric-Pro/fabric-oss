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
	project: {},
	$queryRaw: vi.fn(),
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
		DbNull: "DbNull",
	},
}));

// A REPOSITORY proposal writes its `upload_started` row inside the create
// transaction (Fizzy #2563 Decision 11). Mocked so the assertions are about
// WHETHER it is written, with which client and naming which row.
const auditMocks = vi.hoisted(() => ({ recordAuditTx: vi.fn() }));
vi.mock("../prisma/queries/audit-log", () => ({
	recordAuditTx: auditMocks.recordAuditTx,
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
		proposal: false,
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
	auditMocks.recordAuditTx.mockReset();
	mocks.$transaction.mockReset();
	mocks.$transaction.mockImplementation(
		async (cb: (tx: unknown) => unknown) =>
			cb({
				projectInstructionSnapshot: mocks.snapshot,
				projectInstructionFile: mocks.file,
				project: mocks.project,
				$queryRaw: mocks.$queryRaw,
			}),
	);
	mocks.$queryRaw.mockReset();
	// The locked project row. The default says the base IS what the project
	// publishes, which is the only state in which a publishing derivation or a
	// proposal is allowed to be created.
	mocks.$queryRaw.mockResolvedValue([
		{ publishedInstructionSnapshotId: BASE },
	]);
	mocks.snapshot.count.mockResolvedValue(0);
	// Three different `findFirst` reads share one mock, and a proposal issues
	// one the other derivations do not (the duplicate lookup), so the default
	// answers by WHAT was asked rather than by call position: a lookup naming
	// `changeSetDigest` finds nothing, a lookup naming `id` is the base, and
	// anything else is the version-allocation read. Tests that care about the
	// sequence still reset and queue their own.
	mocks.snapshot.findFirst.mockImplementation(async (args: unknown) => {
		const where = (args as { where?: Record<string, unknown> }).where ?? {};
		if ("changeSetDigest" in where) {
			return null;
		}
		if ("id" in where) {
			return {
				id: BASE,
				status: "READY",
				source: "UPLOAD",
				version: 7,
				settingsFrozen: {
					layer: "default",
					ignoreGlobs: ["**/tasks/**"],
				},
				excludedCount: 4,
			};
		}
		return { version: 7 };
	});
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

	it("persists proposals as pending with automatic publication disabled", async () => {
		withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

		await createDerivedInstructionSnapshot(
			input([put("README.md")], { proposal: true, publishOnReady: true }),
		);

		expect(mocks.snapshot.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					proposalStatus: "PENDING",
					publishOnReady: false,
				}),
			}),
		);
	});

	it("locks admission and refuses a sixth active proposal from one proposer", async () => {
		mocks.snapshot.count.mockResolvedValueOnce(5);

		const result = await createDerivedInstructionSnapshot(
			input([put("README.md")], { proposal: true }),
		);

		expect(result).toEqual({
			ok: false,
			reason: "proposal_proposer_limit",
		});
		expect(mocks.$queryRaw).toHaveBeenCalledOnce();
		expect(mocks.snapshot.create).not.toHaveBeenCalled();
	});

	it("counts all pending proposals in the project under the same lock", async () => {
		mocks.snapshot.count.mockResolvedValueOnce(2).mockResolvedValueOnce(25);

		const result = await createDerivedInstructionSnapshot(
			input([put("README.md")], { proposal: true }),
		);

		expect(result).toEqual({
			ok: false,
			reason: "proposal_project_limit",
		});
		expect(mocks.snapshot.count).toHaveBeenNthCalledWith(2, {
			where: expect.objectContaining({
				projectId: PROJECT,
				organizationId: ORG,
				OR: expect.arrayContaining([
					{ proposalStatus: "PENDING" },
					expect.objectContaining({
						proposalStatus: { not: null },
					}),
				]),
			}),
		});
	});

	/**
	 * A retried proposal is the SAME proposal (Fizzy #2605).
	 *
	 * Every surface that opens one — the v1 change route, the MCP tool, the
	 * CLI push — can have its response lost after the row was written, and
	 * without a dedup rule the retry opened a second PENDING proposal holding
	 * a second admission slot. Five of those and the proposer is locked out
	 * of the feature with nothing in the tab that looks wrong.
	 *
	 * The identity is the CONTENT: the base it is stated against plus the
	 * set of (op, path, sha256) it applies, hashed here so both entry points
	 * share one formula rather than agreeing by coincidence.
	 */
	describe("duplicate proposals", () => {
		/** The staged rows the duplicate lookup reads back. */
		function duplicateStaged() {
			mocks.file.findMany.mockReset();
			mocks.file.findMany.mockResolvedValue([
				{ id: "existing_file", path: "README.md" },
			]);
		}

		/** Make the duplicate lookup find `row`. */
		function existingProposal(overrides: Record<string, unknown> = {}) {
			mocks.snapshot.findFirst.mockImplementation(
				async (args: unknown) => {
					const where =
						(args as { where?: Record<string, unknown> }).where ??
						{};
					if ("changeSetDigest" in where) {
						return {
							id: "snap_existing",
							version: 8,
							status: "RECEIVING",
							proposalStatus: "PENDING",
							fileCount: 3,
							...overrides,
						};
					}
					return { version: 7 };
				},
			);
		}

		it("looks the duplicate up under the lock, before the admission counts, scoped to both tenant columns", async () => {
			duplicateStaged();
			existingProposal();

			await createDerivedInstructionSnapshot(
				input([put("README.md")], { proposal: true }),
			);

			const lookup = mocks.snapshot.findFirst.mock.calls[0]![0] as {
				where: Record<string, unknown>;
			};
			expect(lookup.where).toMatchObject({
				projectId: PROJECT,
				organizationId: ORG,
				userId: "user_1",
				baseSnapshotId: BASE,
				changeSetDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
			});
			// After the project row lock, before either count.
			expect(
				mocks.snapshot.findFirst.mock.invocationCallOrder[0]!,
			).toBeGreaterThan(mocks.$queryRaw.mock.invocationCallOrder[0]!);
			expect(mocks.snapshot.count).not.toHaveBeenCalled();
		});

		it("returns the existing proposal and writes nothing", async () => {
			duplicateStaged();
			existingProposal();

			const result = await createDerivedInstructionSnapshot(
				input([put("README.md")], { proposal: true }),
			);

			expect(result).toEqual({
				ok: false,
				reason: "duplicate_proposal",
				// A duplicate writes nothing, its admission audit included
				// (Fizzy #2563 Decision 11).
				auditWritten: false,
				existing: {
					id: "snap_existing",
					version: 8,
					status: "RECEIVING",
					proposalStatus: "PENDING",
					fileCount: 3,
					// `fileCount` minus the rows still awaiting bytes.
					inheritedCount: 2,
					staged: [{ id: "existing_file", path: "README.md" }],
				},
			});
			expect(mocks.snapshot.create).not.toHaveBeenCalled();
			expect(mocks.file.createMany).not.toHaveBeenCalled();
		});

		/**
		 * The whole point of putting the lookup BEFORE the counts: a proposer
		 * at the cap who retries a push must get their own proposal back, not
		 * a refusal telling them to cancel one — the one they would cancel is
		 * the one they are retrying.
		 */
		it("answers a duplicate at the proposer cap with the existing row", async () => {
			duplicateStaged();
			existingProposal();
			mocks.snapshot.count.mockResolvedValue(5);

			const result = await createDerivedInstructionSnapshot(
				input([put("README.md")], { proposal: true }),
			);

			expect(result).toMatchObject({
				ok: false,
				reason: "duplicate_proposal",
			});
			expect(result).not.toMatchObject({
				reason: "proposal_proposer_limit",
			});
		});

		/**
		 * NARROWER than the admission filter the counts use, and that is the
		 * point.
		 *
		 * `activeProposalFilter`'s second arm matches a TERMINAL proposal
		 * whose staging prefix has not been swept yet — which is exactly what
		 * the inline entry point writes when its own upload fails, so that
		 * the proposer can push again. Matching it here would answer that
		 * retry with the closed-out row and leave the proposer unable to
		 * propose that edit at all until the hourly sweep ran.
		 */
		it("matches only a proposal still awaiting a decision, never a closed-out one", async () => {
			duplicateStaged();
			existingProposal();

			await createDerivedInstructionSnapshot(
				input([put("README.md")], { proposal: true }),
			);

			const lookup = mocks.snapshot.findFirst.mock.calls[0]![0] as {
				where: Record<string, unknown>;
			};
			expect(lookup.where.proposalStatus).toBe("PENDING");
			expect(lookup.where).not.toHaveProperty("OR");
		});

		it("never looks up for a derivation that is not a proposal", async () => {
			withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

			await createDerivedInstructionSnapshot(input([put("README.md")]));

			for (const call of mocks.snapshot.findFirst.mock.calls) {
				expect(
					(call[0] as { where: Record<string, unknown> }).where,
				).not.toHaveProperty("changeSetDigest");
			}
		});

		it("stores the digest on the row it creates", async () => {
			withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

			await createDerivedInstructionSnapshot(
				input([put("README.md")], { proposal: true }),
			);

			const lookup = mocks.snapshot.findFirst.mock.calls[0]![0] as {
				where: { changeSetDigest: string };
			};
			expect(mocks.snapshot.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						changeSetDigest: lookup.where.changeSetDigest,
					}),
				}),
			);
		});

		/** The digest of the change set the run was given. */
		async function digestOf(
			changes: Parameters<
				typeof createDerivedInstructionSnapshot
			>[0]["changes"],
			files = [baseFile("bf1", "CLAUDE.md")],
		) {
			mocks.snapshot.create.mockClear();
			withBaseFiles(files);
			await createDerivedInstructionSnapshot(
				input(changes, { proposal: true }),
			);
			return (
				mocks.snapshot.create.mock.calls[0]![0] as {
					data: { changeSetDigest: string };
				}
			).data.changeSetDigest;
		}

		it("hashes the change SET, so the order the caller sent it in is irrelevant", async () => {
			const forwards = await digestOf([
				put("README.md"),
				put("docs/one.md"),
			]);
			const backwards = await digestOf([
				put("docs/one.md"),
				put("README.md"),
			]);

			expect(forwards).toMatch(/^[0-9a-f]{64}$/);
			expect(forwards).toBe(backwards);
		});

		/**
		 * The CONTENT is in the digest, not just the shape of the edit. Two
		 * pushes that touch the same path with different bytes are different
		 * proposals, and answering the second with the first would silently
		 * drop the newer edit.
		 */
		it("changes when only a put's hash changes", async () => {
			const base = [baseFile("bf1", "CLAUDE.md")];
			const first = await digestOf([put("README.md")], base);
			const second = await digestOf(
				[{ ...put("README.md"), sha256: "e".repeat(64) }],
				base,
			);

			expect(first).toMatch(/^[0-9a-f]{64}$/);
			expect(first).not.toBe(second);
		});

		/** Same bytes, different file: still a different proposal. */
		it("changes when only a put's path changes", async () => {
			const base = [baseFile("bf1", "CLAUDE.md")];
			const here = await digestOf([put("README.md")], base);
			const there = await digestOf([put("docs/README.md")], base);

			expect(here).not.toBe(there);
		});

		/**
		 * Removing a file and rewriting it are opposite edits, and a digest
		 * that could not tell them apart would return one when the proposer
		 * asked for the other.
		 */
		it("distinguishes a put from a delete on the same path", async () => {
			const base = [
				baseFile("bf1", "CLAUDE.md"),
				baseFile("bf2", "x.md"),
			];
			const written = await digestOf([put("x.md")], base);
			const removed = await digestOf(
				[{ op: "delete", path: "x.md" }],
				base,
			);

			expect(written).not.toBe(removed);
		});
	});

	it("locks the project row for a publishing derivation, not just a proposal", async () => {
		withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

		// The default input is `publishOnReady: true, proposal: false` — the
		// browser tab's ordinary save. It claims the published pointer just as
		// a proposal does, so it takes the same lock.
		const result = await createDerivedInstructionSnapshot(
			input([put("README.md")]),
		);

		expect(result.ok).toBe(true);
		expect(mocks.$queryRaw).toHaveBeenCalledOnce();
		const sql = (mocks.$queryRaw.mock.calls[0]![0] as string[]).join("?");
		expect(sql).toContain('"publishedInstructionSnapshotId"');
		expect(sql).toContain("FOR UPDATE OF p");
	});

	it("refuses a publishing derivation whose base stopped being published mid-transaction", async () => {
		withBaseFiles([baseFile("bf1", "CLAUDE.md")]);
		// A publish landed between the caller's pre-read and this
		// transaction: the pointer now names a different snapshot. The base
		// row itself is untouched — still present, still READY — so nothing
		// else in this query would notice.
		mocks.$queryRaw.mockResolvedValue([
			{ publishedInstructionSnapshotId: "snap_other" },
		]);

		const result = await createDerivedInstructionSnapshot(
			input([put("README.md")]),
		);

		expect(result).toEqual({ ok: false, reason: "base_not_published" });
		expect(mocks.snapshot.create).not.toHaveBeenCalled();
	});

	it("refuses a proposal whose base stopped being published mid-transaction", async () => {
		withBaseFiles([baseFile("bf1", "CLAUDE.md")]);
		mocks.$queryRaw.mockResolvedValue([
			{ publishedInstructionSnapshotId: null },
		]);

		const result = await createDerivedInstructionSnapshot(
			input([put("README.md")], { proposal: true }),
		);

		expect(result).toEqual({ ok: false, reason: "base_not_published" });
		expect(mocks.snapshot.create).not.toHaveBeenCalled();
	});

	it("neither locks nor compares the pointer for a non-publishing derivation", async () => {
		withBaseFiles([baseFile("bf1", "CLAUDE.md")]);
		// "Save as a new version" is explicitly NOT a claim on the published
		// pointer (spec §6.12), so it may build on any READY snapshot —
		// including one that is not the published one.
		mocks.$queryRaw.mockResolvedValue([
			{ publishedInstructionSnapshotId: "snap_other" },
		]);

		const result = await createDerivedInstructionSnapshot(
			input([put("README.md")], { publishOnReady: false }),
		);

		expect(result.ok).toBe(true);
		expect(mocks.$queryRaw).not.toHaveBeenCalled();
	});

	/**
	 * The collision check spans the RESULT — the base's inherited rows plus
	 * the new puts — and it is the only place the two ever meet. The change
	 * set's own check sees one path and passes.
	 */
	describe("collisions between inherited rows and new puts", () => {
		const NFC = "caf\u00e9.md";
		const NFD = "cafe\u0301.md";

		it("refuses a put whose name differs from an inherited one only by Unicode normalisation", async () => {
			withBaseFiles([baseFile("bf1", NFC)]);

			const result = await createDerivedInstructionSnapshot(
				input([put(NFD)]),
			);

			expect(result).toMatchObject({
				ok: false,
				reason: "path_collision",
			});
			expect(mocks.snapshot.create).not.toHaveBeenCalled();
		});

		it("still refuses the ordinary case variant", async () => {
			withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

			const result = await createDerivedInstructionSnapshot(
				input([put("Claude.md")]),
			);

			expect(result).toMatchObject({
				ok: false,
				reason: "path_collision",
			});
		});

		// A base admitted before these rules existed may already hold such a
		// pair. Refusing the derivation would mean no version of that project
		// could ever be edited again — including the edit that removes one of
		// them — so an inherited pair is carried forward as it stands.
		it("carries a colliding pair of inherited rows forward rather than refusing", async () => {
			withBaseFiles([baseFile("bf1", NFC), baseFile("bf2", NFD)]);

			const result = await createDerivedInstructionSnapshot(
				input([put("README.md")]),
			);

			expect(result).toMatchObject({ ok: true });
			const rows = (
				mocks.file.createMany.mock.calls[0]![0] as {
					data: Array<Record<string, unknown>>;
				}
			).data;
			expect(rows.map((r) => r.path).sort()).toEqual(
				[NFC, NFD, "README.md"].sort(),
			);
		});

		// Which leaves the repair available: DELETE one of the pair. A put of
		// one spelling while the other is still inherited is still two rows
		// and one file, so it stays refused — the fix is to remove a row, not
		// to overwrite one.
		it("lets a grandfathered pair be repaired by deleting one of them", async () => {
			withBaseFiles([baseFile("bf1", NFC), baseFile("bf2", NFD)]);

			const result = await createDerivedInstructionSnapshot(
				input([{ op: "delete", path: NFD }, put(NFC)]),
			);

			expect(result).toMatchObject({ ok: true });
			const rows = (
				mocks.file.createMany.mock.calls[0]![0] as {
					data: Array<Record<string, unknown>>;
				}
			).data;
			expect(rows.map((r) => r.path)).toEqual([NFC]);
		});
	});

	/**
	 * A tree the CLI cannot write. `docs` beside `docs/a.md` is not two
	 * spellings of one file, it is a file and a directory with one name:
	 * whichever `fabric instructions sync` writes first makes the other
	 * fail, and the sync stops part-way. Both orders are refused because a
	 * base is allowed to hold either side.
	 */
	describe("file-and-directory collisions between inherited rows and new puts", () => {
		function stagedPaths(): string[] {
			return (
				mocks.file.createMany.mock.calls[0]![0] as {
					data: Array<Record<string, unknown>>;
				}
			).data.map((r) => r.path as string);
		}

		it("refuses a file named like a directory the base already has", async () => {
			withBaseFiles([baseFile("bf1", "docs/a.md")]);

			const result = await createDerivedInstructionSnapshot(
				input([put("docs")]),
			);

			expect(result).toEqual({
				ok: false,
				reason: "path_tree_collision",
				detail: "docs/a.md and docs",
			});
			expect(mocks.snapshot.create).not.toHaveBeenCalled();
		});

		it("refuses a file under a directory the base stores as a file", async () => {
			withBaseFiles([baseFile("bf1", "docs")]);

			const result = await createDerivedInstructionSnapshot(
				input([put("docs/a.md")]),
			);

			expect(result).toEqual({
				ok: false,
				reason: "path_tree_collision",
				detail: "docs and docs/a.md",
			});
			expect(mocks.snapshot.create).not.toHaveBeenCalled();
		});

		// The directory name is compared by the same key as a file name, so
		// a case or normalisation variant of the directory is the same
		// directory.
		it("compares directory names by the collision key, not byte equality", async () => {
			withBaseFiles([baseFile("bf1", "Docs/a.md")]);

			expect(
				await createDerivedInstructionSnapshot(input([put("docs")])),
			).toMatchObject({ ok: false, reason: "path_tree_collision" });
		});

		it("checks the deeper directories of a nested put, not only the first", async () => {
			withBaseFiles([baseFile("bf1", "docs/guides")]);

			expect(
				await createDerivedInstructionSnapshot(
					input([put("docs/guides/setup.md")]),
				),
			).toEqual({
				ok: false,
				reason: "path_tree_collision",
				detail: "docs/guides and docs/guides/setup.md",
			});
		});

		it("refuses the pair when both sides are new puts", async () => {
			withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

			expect(
				await createDerivedInstructionSnapshot(
					input([put("docs/a.md"), put("docs")]),
				),
			).toMatchObject({ ok: false, reason: "path_tree_collision" });
		});

		// Cut on segment boundaries only: a shared PREFIX of a name is not a
		// directory.
		it("does not mistake a name prefix for a directory", async () => {
			withBaseFiles([
				baseFile("bf1", "docs/a.md"),
				baseFile("bf2", "doc"),
			]);

			const result = await createDerivedInstructionSnapshot(
				input([put("docs.md"), put("do")]),
			);

			expect(result).toMatchObject({ ok: true });
			expect(stagedPaths().sort()).toEqual(
				["doc", "docs.md", "docs/a.md", "do"].sort(),
			);
		});

		// The same grandfathering as the case-insensitive pair: a base that
		// already holds both sides is carried forward, so it can still be
		// edited — including the edit that repairs it.
		it("carries an inherited file-and-directory pair forward rather than refusing", async () => {
			withBaseFiles([
				baseFile("bf1", "docs"),
				baseFile("bf2", "docs/a.md"),
			]);

			const result = await createDerivedInstructionSnapshot(
				input([put("README.md")]),
			);

			expect(result).toMatchObject({ ok: true });
			expect(stagedPaths().sort()).toEqual(
				["docs", "docs/a.md", "README.md"].sort(),
			);
		});

		it("lets the pair be repaired by deleting one side in the same change set", async () => {
			withBaseFiles([baseFile("bf1", "docs")]);

			const result = await createDerivedInstructionSnapshot(
				input([{ op: "delete", path: "docs" }, put("docs/a.md")]),
			);

			expect(result).toMatchObject({ ok: true, inheritedCount: 0 });
			expect(stagedPaths()).toEqual(["docs/a.md"]);
		});

		// Overwriting one side while the other is still inherited would
		// still publish the unwritable tree, so — like the case-variant
		// pair — the fix is to remove a row, not to overwrite one.
		it("still refuses an edit of one side while the other is inherited", async () => {
			withBaseFiles([
				baseFile("bf1", "docs"),
				baseFile("bf2", "docs/a.md"),
			]);

			expect(
				await createDerivedInstructionSnapshot(input([put("docs")])),
			).toMatchObject({ ok: false, reason: "path_tree_collision" });
		});
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

/**
 * Proposal destinations (Fizzy #2563 spec §5.1 steps 6 to 8).
 *
 * A REPOSITORY proposal is admitted in the same one transaction as any other
 * derivation, and three things are added to it: the frozen pull-request
 * state on the row, a dedup identity that includes the configuration the
 * proposal was frozen against, and the `upload_started` audit row, which for
 * this destination is written INSIDE the transaction because only the
 * transaction knows the id and version it allocated (Decision 11).
 */
describe("proposal destinations", () => {
	const NOTE = { title: "Tighten the review skill", body: "Why: flaky" };
	const CONTEXT = {
		v: 1,
		syncId: "sync_1",
		syncGeneration: 3,
		branch: "fabric/instructions/op_1",
	};

	function repository(
		overrides: Record<string, unknown> = {},
	): NonNullable<
		Parameters<typeof createDerivedInstructionSnapshot>[0]["destination"]
	> {
		return {
			kind: "REPOSITORY",
			operationId: "op_1",
			context: CONTEXT,
			syncId: "sync_1",
			syncGeneration: 3,
			branch: "fabric/instructions/op_1",
			uploadStartedAudit: {
				actor: { type: "user", userId: "user_1" },
				organizationId: ORG,
				projectId: PROJECT,
				requestId: "req_1",
				metadata: {
					mode: "proposal",
					baseSnapshotId: BASE,
					baseVersion: 7,
					putCount: 1,
					deleteCount: 0,
				},
			},
			...overrides,
		};
	}

	function createdData() {
		return (
			mocks.snapshot.create.mock.calls[0]![0] as {
				data: Record<string, unknown>;
			}
		).data;
	}

	it("writes the destination, note, operation, QUEUED state and frozen context on the row it creates", async () => {
		withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

		const result = await createDerivedInstructionSnapshot(
			input([put("README.md")], {
				proposal: true,
				note: NOTE,
				destination: repository(),
			}),
		);

		expect(result).toMatchObject({ ok: true, auditWritten: true });
		expect(createdData()).toMatchObject({
			proposalStatus: "PENDING",
			publishOnReady: false,
			proposalDestination: "REPOSITORY",
			proposalNote: NOTE,
			pullRequestOperationId: "op_1",
			pullRequestState: "QUEUED",
			pullRequestContext: CONTEXT,
			// The attempt-1 branch is the operation's current ref from the
			// moment it exists; nothing later has to infer it (Fizzy #2563).
			pullRequestRef: "fabric/instructions/op_1",
		});
		expect(createdData()).not.toHaveProperty("pullRequestFailure");
		// In the create transaction: the row and its files are written by
		// the transaction client the callback was handed.
		expect(mocks.$transaction).toHaveBeenCalledTimes(1);
	});

	it("admits an attribution-refused row as BLOCKED with its failure, still PENDING", async () => {
		withBaseFiles([baseFile("bf1", "CLAUDE.md")]);
		const blocked = {
			phase: "admission" as const,
			code: "ATTRIBUTION_REJECTED" as const,
			retryable: false,
			at: "2026-09-24T12:00:00.000Z",
			params: {},
		};

		await createDerivedInstructionSnapshot(
			input([put("README.md")], {
				proposal: true,
				destination: repository({ blocked }),
			}),
		);

		expect(createdData()).toMatchObject({
			proposalStatus: "PENDING",
			pullRequestState: "BLOCKED",
			pullRequestFailure: blocked,
		});
	});

	it("keeps the note on a FABRIC proposal, which gets no pull-request state", async () => {
		withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

		const result = await createDerivedInstructionSnapshot(
			input([put("README.md")], { proposal: true, note: NOTE }),
		);

		expect(result).toMatchObject({ ok: true, auditWritten: false });
		expect(createdData()).toMatchObject({
			proposalStatus: "PENDING",
			proposalDestination: "FABRIC",
			proposalNote: NOTE,
		});
		for (const column of [
			"pullRequestOperationId",
			"pullRequestState",
			"pullRequestContext",
			"pullRequestFailure",
			"pullRequestRef",
		]) {
			expect(createdData()).not.toHaveProperty(column);
		}
		// FABRIC keeps today's post-commit audit, written by the caller.
		expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("writes no note and no destination on a derivation that is not a proposal", async () => {
		withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

		await createDerivedInstructionSnapshot(
			input([put("README.md")], { note: NOTE }),
		);

		expect(createdData()).not.toHaveProperty("proposalNote");
		expect(createdData()).not.toHaveProperty("proposalDestination");
		expect(createdData()).toMatchObject({ proposalStatus: null });
	});

	it("refuses a REPOSITORY destination on a derivation that is not a proposal", async () => {
		await expect(
			createDerivedInstructionSnapshot(
				input([put("README.md")], { destination: repository() }),
			),
		).rejects.toThrow(/REPOSITORY/);
		expect(mocks.snapshot.create).not.toHaveBeenCalled();
	});

	it("writes exactly one upload_started row in the create transaction, naming the committed row and its counts", async () => {
		withBaseFiles([
			baseFile("bf1", "CLAUDE.md"),
			baseFile("bf2", "AGENTS.md"),
		]);

		const result = await createDerivedInstructionSnapshot(
			input([put("README.md")], {
				proposal: true,
				destination: repository(),
			}),
		);

		expect(result).toMatchObject({
			ok: true,
			id: "snap_new",
			version: 8,
			fileCount: 3,
			inheritedCount: 2,
			auditWritten: true,
		});
		expect(auditMocks.recordAuditTx).toHaveBeenCalledTimes(1);
		const [client, row] = auditMocks.recordAuditTx.mock.calls[0]!;
		// The transaction client, not a fresh connection.
		expect(client).toMatchObject({
			projectInstructionSnapshot: mocks.snapshot,
		});
		expect(row).toEqual({
			actor: { type: "user", userId: "user_1" },
			organizationId: ORG,
			projectId: PROJECT,
			requestId: "req_1",
			action: "project.instructions.upload_started",
			category: "project",
			resource: {
				type: "project_instruction_snapshot",
				id: "snap_new",
				name: "v8",
			},
			metadata: {
				mode: "proposal",
				baseSnapshotId: BASE,
				baseVersion: 7,
				putCount: 1,
				deleteCount: 0,
				// The authoritative creation counts, the fields
				// `derive-snapshot.ts` writes after commit for FABRIC.
				inheritedCount: 2,
				keptCount: 3,
			},
		});
		// After the row exists: the audit names an allocated id.
		expect(
			auditMocks.recordAuditTx.mock.invocationCallOrder[0]!,
		).toBeGreaterThan(mocks.snapshot.create.mock.invocationCallOrder[0]!);
	});

	// What this proves is that the audit failure is raised from inside the
	// one transaction callback and is not retried as a version collision.
	// That the rows then roll back is proven on Postgres by "admission
	// rollback" in instruction-proposal-pull-requests.integration.test.ts.
	it("raises an upload_started write failure from inside the one create transaction, without retrying the create", async () => {
		withBaseFiles([baseFile("bf1", "CLAUDE.md")]);
		auditMocks.recordAuditTx.mockRejectedValueOnce(new Error("audit down"));

		await expect(
			createDerivedInstructionSnapshot(
				input([put("README.md")], {
					proposal: true,
					destination: repository(),
				}),
			),
		).rejects.toThrow("audit down");
		// The error surfaced from INSIDE the one transaction callback, which
		// is what rolls its writes back; it is not a version collision, so
		// nothing retried the create.
		expect(mocks.$transaction).toHaveBeenCalledTimes(1);
		expect(mocks.snapshot.create).toHaveBeenCalledTimes(1);
	});

	describe("dedup", () => {
		function lookupWhere() {
			const call = mocks.snapshot.findFirst.mock.calls.find(
				(c) =>
					"changeSetDigest" in
					((c[0] as { where: Record<string, unknown> }).where ?? {}),
			);
			return (call![0] as { where: Record<string, unknown> }).where;
		}

		it("matches the destination and, for REPOSITORY, the frozen sync id and generation", async () => {
			withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

			await createDerivedInstructionSnapshot(
				input([put("README.md")], {
					proposal: true,
					destination: repository(),
				}),
			);

			expect(lookupWhere()).toMatchObject({
				projectId: PROJECT,
				organizationId: ORG,
				userId: "user_1",
				baseSnapshotId: BASE,
				proposalStatus: "PENDING",
				proposalDestination: "REPOSITORY",
				AND: [
					{
						pullRequestContext: {
							path: ["syncId"],
							equals: "sync_1",
						},
					},
					{
						pullRequestContext: {
							path: ["syncGeneration"],
							equals: 3,
						},
					},
				],
			});
		});

		it("matches a FABRIC proposal only against FABRIC rows, with no configuration filter", async () => {
			withBaseFiles([baseFile("bf1", "CLAUDE.md")]);

			await createDerivedInstructionSnapshot(
				input([put("README.md")], { proposal: true }),
			);

			expect(lookupWhere()).toMatchObject({
				proposalDestination: "FABRIC",
			});
			expect(lookupWhere()).not.toHaveProperty("AND");
		});

		/**
		 * The stored REPOSITORY proposal was frozen against generation 3. The
		 * fake answers the lookup the way Postgres would evaluate the JSON
		 * path filters, so the same change set is the same proposal under
		 * generation 3 and a new one after a re-configure moved it to 4.
		 */
		function storedRepositoryProposalAtGeneration(generation: number) {
			mocks.snapshot.findFirst.mockImplementation(
				async (args: unknown) => {
					const where =
						(args as { where?: Record<string, unknown> }).where ??
						{};
					if ("changeSetDigest" in where) {
						const and = (where.AND ?? []) as Array<{
							pullRequestContext: {
								path: string[];
								equals: unknown;
							};
						}>;
						const frozen: Record<string, unknown> = {
							syncId: "sync_1",
							syncGeneration: generation,
						};
						const matches =
							where.proposalDestination === "REPOSITORY" &&
							and.every(
								(c) =>
									frozen[c.pullRequestContext.path[0]!] ===
									c.pullRequestContext.equals,
							);
						return matches
							? {
									id: "snap_existing",
									version: 8,
									status: "READY",
									proposalStatus: "PENDING",
									fileCount: 1,
								}
							: null;
					}
					if ("id" in where) {
						return {
							id: BASE,
							status: "READY",
							source: "UPLOAD",
							version: 7,
							settingsFrozen: {
								layer: "default",
								ignoreGlobs: [],
							},
							excludedCount: 0,
						};
					}
					return { version: 8 };
				},
			);
		}

		it("answers a retry under the same generation with the existing row and writes no audit", async () => {
			storedRepositoryProposalAtGeneration(3);
			mocks.file.findMany.mockResolvedValue([]);

			const result = await createDerivedInstructionSnapshot(
				input([put("README.md")], {
					proposal: true,
					destination: repository(),
				}),
			);

			expect(result).toMatchObject({
				ok: false,
				reason: "duplicate_proposal",
				auditWritten: false,
				existing: { id: "snap_existing" },
			});
			expect(mocks.snapshot.create).not.toHaveBeenCalled();
			expect(auditMocks.recordAuditTx).not.toHaveBeenCalled();
		});

		it("dedup after re-configure: a new generation creates a new row", async () => {
			storedRepositoryProposalAtGeneration(3);
			mocks.file.findMany
				.mockResolvedValueOnce([baseFile("bf1", "CLAUDE.md")])
				.mockResolvedValueOnce([{ id: "new_1", path: "README.md" }]);

			const result = await createDerivedInstructionSnapshot(
				input([put("README.md")], {
					proposal: true,
					destination: repository({
						syncGeneration: 4,
						context: { ...CONTEXT, syncGeneration: 4 },
					}),
				}),
			);

			expect(result).toMatchObject({ ok: true, auditWritten: true });
			expect(mocks.snapshot.create).toHaveBeenCalledTimes(1);
		});
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
				OR: [
					{ status: { in: ["RECEIVING", "VALIDATING", "FAILED"] } },
					{ proposalStatus: "PENDING" },
					expect.objectContaining({ OR: expect.any(Array) }),
				],
			},
		});
	});
});
