/**
 * `removeAllProjectInstructions` — every coding-instructions version of a
 * project removed in one transaction, so the project starts over with
 * nothing published.
 *
 * What this pins:
 *  - the project row is locked first and the snapshot rows next, both
 *    `FOR UPDATE`, before anything is decided;
 *  - the published pointer is cleared BEFORE any snapshot is deleted (its
 *    foreign key is `onDelete: Restrict`);
 *  - approvals, git intent entries and files go explicitly under the tenant
 *    filter, then the snapshots; one storage-cleanup receipt per snapshot;
 *    every member's digest seen marker cleared; ONE audit row with the count
 *    and the version that was published;
 *  - each refusal (repository mode, an open move, a RECEIVING or VALIDATING
 *    snapshot, an unresolved pull request, a pending proposal, a missing
 *    project) writes nothing at all;
 *  - nothing to remove writes nothing and records nothing;
 *  - a delete that does not account for every locked row throws, so the
 *    transaction rolls back rather than committing receipts and an audit row
 *    for rows it did not delete.
 *
 * The client is a recording fake: `$transaction` runs its callback against a
 * transaction client whose writes are appended, in order, to `writes`.
 *
 * Run with: pnpm --filter @repo/database test -- __tests__/instruction-remove-all.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => {
	const state = {
		project: null as null | {
			instructionSettings: unknown;
			publishedInstructionSnapshotId: string | null;
		},
		sync: null as null | { id: string },
		snapshots: [] as Row[],
		/** How many rows the snapshot DELETE reports; null = every one asked for. */
		deleteCount: null as number | null,
		raw: [] as Array<{ text: string; values: unknown[] }>,
		writes: [] as Array<{ op: string; args: Row }>,
		files: [] as Row[],
		entries: [] as Row[],
	};

	function write(op: string) {
		return vi.fn(async (args: Row) => {
			state.writes.push({ op, args });
			return { count: 0 };
		});
	}

	const snapshotDefaults: Row = {
		proposalStatus: null,
		pullRequestState: null,
		mergeSyncRequestedAt: null,
		pullRequestObligationOpen: false,
		proposalDestination: "FABRIC",
		commitOutcome: null,
		proposalBranch: null,
	};

	const tx = {
		$queryRaw: vi.fn(
			async (strings: TemplateStringsArray, ...values: unknown[]) => {
				const text = strings.join("?");
				state.raw.push({ text, values });
				if (text.includes('FROM "project" p')) {
					return state.project ? [state.project] : [];
				}
				if (text.includes('FROM "project_instruction_snapshot" s')) {
					return state.snapshots.map((s) => ({ id: s.id }));
				}
				throw new Error(`fake: unexpected raw query ${text}`);
			},
		),
		projectInstructionRepositorySync: {
			findFirst: vi.fn(async () => state.sync),
		},
		projectInstructionSnapshot: {
			findMany: vi.fn(async () =>
				state.snapshots.map((s) => ({ ...snapshotDefaults, ...s })),
			),
			deleteMany: vi.fn(
				async (args: { where: { id: { in: string[] } } }) => {
					state.writes.push({ op: "snapshot.deleteMany", args });
					return {
						count: state.deleteCount ?? args.where.id.in.length,
					};
				},
			),
		},
		project: { update: write("project.update") },
		projectInstructionProposalApproval: {
			deleteMany: write("approval.deleteMany"),
		},
		projectInstructionGitIntentEntry: {
			deleteMany: write("gitIntentEntry.deleteMany"),
		},
		projectInstructionFile: { deleteMany: write("file.deleteMany") },
		projectInstructionPendingStorageCleanup: {
			createMany: write("cleanupReceipt.createMany"),
		},
		projectUserPreference: { updateMany: write("preference.updateMany") },
		auditLog: { create: write("audit.create") },
	};

	const db = {
		$transaction: vi.fn(
			async (
				callback: (client: typeof tx) => Promise<unknown>,
				_options?: unknown,
			) => callback(tx),
		),
		projectInstructionFile: {
			findMany: vi.fn(async () => state.files),
		},
		projectInstructionGitIntentEntry: {
			findMany: vi.fn(async () => state.entries),
		},
		// The preview's unlocked reads see the same state as the transaction.
		project: { findFirst: vi.fn(async () => state.project) },
		projectInstructionRepositorySync: {
			findFirst: vi.fn(async () => state.sync),
		},
		projectInstructionSnapshot: {
			findMany: vi.fn(async () =>
				state.snapshots.map((s) => ({ ...snapshotDefaults, ...s })),
			),
		},
	};

	return { state, tx, db };
});

vi.mock("../prisma/client", () => ({
	db: fake.db,
	Prisma: {
		sql: vi.fn(),
		join: vi.fn(),
		raw: vi.fn(),
		AnyNull: Symbol.for("test.AnyNull"),
	},
}));

import {
	INSTRUCTIONS_REMOVED_AUDIT_ACTION,
	listProjectInstructionStorageKeys,
	previewRemoveAllProjectInstructions,
	removeAllProjectInstructions,
} from "../prisma/queries/instruction-remove-all";

const AUDIT = {
	actor: {
		type: "user" as const,
		userId: "user-1",
		emailSnapshot: "dev@example.com",
		nameSnapshot: "Example Dev",
		impersonatedById: null,
	},
	ipAddress: "203.0.113.7",
	userAgent: "Mozilla/5.0",
	requestId: "req-1",
	sessionId: "sess-1",
	correlationId: "corr-1",
};

function remove() {
	return removeAllProjectInstructions({
		projectId: "proj-1",
		organizationId: "org-1",
		audit: AUDIT,
	});
}

function snapshot(id: string, version: number, overrides: Row = {}): Row {
	return { id, version, status: "READY", ...overrides };
}

const ops = () => fake.state.writes.map((w) => w.op);
const writesOf = (op: string) =>
	fake.state.writes.filter((w) => w.op === op).map((w) => w.args);

beforeEach(() => {
	fake.state.project = {
		instructionSettings: { sourceOfTruth: "UPLOAD" },
		publishedInstructionSnapshotId: "snap-3",
	};
	fake.state.sync = null;
	fake.state.snapshots = [
		snapshot("snap-1", 1, { status: "REJECTED" }),
		snapshot("snap-2", 2, { status: "FAILED" }),
		snapshot("snap-3", 3),
	];
	fake.state.deleteCount = null;
	fake.state.raw = [];
	fake.state.writes = [];
	fake.state.files = [];
	fake.state.entries = [];
	fake.db.$transaction.mockClear();
});

describe("removeAllProjectInstructions", () => {
	it("removes every version, clearing the published pointer first", async () => {
		const result = await remove();

		expect(result).toEqual({
			status: "removed",
			snapshotIds: ["snap-1", "snap-2", "snap-3"],
			publishedVersion: 3,
		});
		expect(ops()).toEqual([
			"project.update",
			"approval.deleteMany",
			"gitIntentEntry.deleteMany",
			"file.deleteMany",
			"snapshot.deleteMany",
			"cleanupReceipt.createMany",
			"preference.updateMany",
			"audit.create",
		]);
		expect(writesOf("project.update")).toEqual([
			{
				where: { id: "proj-1", organizationId: "org-1" },
				data: { publishedInstructionSnapshotId: null },
			},
		]);
		const scope = {
			projectId: "proj-1",
			organizationId: "org-1",
			snapshotId: { in: ["snap-1", "snap-2", "snap-3"] },
		};
		for (const op of [
			"approval.deleteMany",
			"gitIntentEntry.deleteMany",
			"file.deleteMany",
		]) {
			expect(writesOf(op), op).toEqual([{ where: scope }]);
		}
		expect(writesOf("snapshot.deleteMany")).toEqual([
			{
				where: {
					projectId: "proj-1",
					organizationId: "org-1",
					id: { in: ["snap-1", "snap-2", "snap-3"] },
				},
			},
		]);
	});

	it("locks the project row, then the snapshot rows, before deciding anything", async () => {
		await remove();

		expect(fake.state.raw).toHaveLength(2);
		const [projectLock, snapshotLock] = fake.state.raw;
		expect(projectLock?.text).toMatch(
			/FROM "project" p[\s\S]*FOR UPDATE OF p/,
		);
		expect(projectLock?.values).toEqual(["proj-1", "org-1"]);
		expect(snapshotLock?.text).toMatch(
			/FROM "project_instruction_snapshot" s[\s\S]*FOR UPDATE OF s/,
		);
		expect(snapshotLock?.values).toEqual(["proj-1", "org-1"]);
	});

	it("queues one storage-cleanup receipt per removed snapshot, after the grace period", async () => {
		const before = Date.now();
		await remove();

		const [receipts] = writesOf("cleanupReceipt.createMany") as Array<{
			data: Array<{
				snapshotId: string;
				projectId: string;
				organizationId: string;
				notBefore: Date;
				nextAttemptAt: Date;
			}>;
		}>;
		expect(receipts?.data.map((r) => r.snapshotId)).toEqual([
			"snap-1",
			"snap-2",
			"snap-3",
		]);
		for (const receipt of receipts?.data ?? []) {
			expect(receipt.projectId).toBe("proj-1");
			expect(receipt.organizationId).toBe("org-1");
			expect(receipt.notBefore.getTime()).toBeGreaterThanOrEqual(
				before + 60 * 60 * 1000,
			);
			expect(receipt.nextAttemptAt).toEqual(receipt.notBefore);
		}
	});

	it("clears every member's digest seen marker, so the next visit is a first visit", async () => {
		await remove();

		expect(writesOf("preference.updateMany")).toEqual([
			{
				where: {
					projectId: "proj-1",
					organizationId: "org-1",
					instructionsSeenAt: { not: null },
				},
				data: {
					instructionsSeenSnapshotId: null,
					instructionsSeenVersion: null,
					instructionsSeenAt: null,
				},
			},
		]);
	});

	it("writes one audit row with the count and the version that was published", async () => {
		await remove();

		const rows = writesOf("audit.create") as Array<{ data: Row }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.data).toMatchObject({
			action: INSTRUCTIONS_REMOVED_AUDIT_ACTION,
			category: "project",
			severity: "warning",
			metadata: expect.objectContaining({
				removedSnapshotCount: 3,
				publishedVersion: 3,
			}),
		});
		expect(INSTRUCTIONS_REMOVED_AUDIT_ACTION).toBe(
			"project.instructions.removed",
		);
	});

	it("leaves the pointer alone and records a null version when nothing was published", async () => {
		fake.state.project = {
			instructionSettings: {},
			publishedInstructionSnapshotId: null,
		};

		const result = await remove();

		expect(result).toMatchObject({
			status: "removed",
			publishedVersion: null,
		});
		expect(ops()).not.toContain("project.update");
		const rows = writesOf("audit.create") as Array<{ data: Row }>;
		expect(rows[0]?.data).toMatchObject({
			metadata: expect.objectContaining({ publishedVersion: null }),
		});
	});

	it("writes nothing and records nothing when there is nothing to remove", async () => {
		fake.state.project = {
			instructionSettings: {},
			publishedInstructionSnapshotId: null,
		};
		fake.state.snapshots = [];

		await expect(remove()).resolves.toEqual({
			status: "removed",
			snapshotIds: [],
			publishedVersion: null,
		});
		expect(fake.state.writes).toEqual([]);
	});

	describe("refusals write nothing", () => {
		it.each<[string, () => void, string]>([
			[
				"a missing project",
				() => {
					fake.state.project = null;
				},
				"not_found",
			],
			...refusalCases(),
		])("refuses %s", async (_name, arrange, reason) => {
			arrange();

			await expect(remove()).resolves.toEqual({
				status: "refused",
				reason,
			});
			expect(fake.state.writes).toEqual([]);
		});
	});

	it("throws, rolling the transaction back, when the delete does not account for every locked row", async () => {
		fake.state.deleteCount = 2;

		await expect(remove()).rejects.toThrow(/Removed 2 of 3/);
		expect(ops()).not.toContain("cleanupReceipt.createMany");
		expect(ops()).not.toContain("audit.create");
	});

	it("gives the transaction a timeout long enough for a large project", async () => {
		await remove();

		expect(fake.db.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{
				timeout: 30_000,
			},
		);
	});
});

describe("previewRemoveAllProjectInstructions", () => {
	const preview = () =>
		previewRemoveAllProjectInstructions("proj-1", "org-1");

	it("counts every version the removal deletes and names the published one", async () => {
		await expect(preview()).resolves.toEqual({
			snapshotCount: 3,
			publishedVersion: 3,
			blockedBy: null,
		});
	});

	// History hides other members' proposals and every git intent row, so a
	// count taken from it would say fewer versions than the removal deletes.
	it("reads every snapshot of the project, unfiltered, under the tenant scope", async () => {
		await preview();

		expect(
			fake.db.projectInstructionSnapshot.findMany,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "proj-1", organizationId: "org-1" },
			}),
		);
		expect(fake.db.project.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "proj-1", organizationId: "org-1" },
			}),
		);
	});

	it("reports no published version when nothing is published", async () => {
		fake.state.project = {
			instructionSettings: { sourceOfTruth: "UPLOAD" },
			publishedInstructionSnapshotId: null,
		};

		await expect(preview()).resolves.toMatchObject({
			snapshotCount: 3,
			publishedVersion: null,
		});
	});

	it("is null for a project outside the organization", async () => {
		fake.state.project = null;

		await expect(preview()).resolves.toBeNull();
	});

	it.each(refusalCases())(
		"names the refusal the removal would meet for %s, writing nothing",
		async (_name, arrange, reason) => {
			arrange();

			await expect(preview()).resolves.toMatchObject({
				blockedBy: reason,
			});
			expect(fake.state.writes).toEqual([]);
			expect(fake.db.$transaction).not.toHaveBeenCalled();
		},
	);
});

/**
 * Every state the removal refuses for a project that exists, with the reason.
 * The removal and its preview are both held to it, so the confirmation can
 * never offer a removal the server refuses, nor hold back one it allows.
 * A function, so it is hoisted above the describes that use it.
 */
function refusalCases(): Array<[string, () => void, string]> {
	const migration = {
		v: 1,
		state: "PROPOSING",
		branchId: null,
		snapshotId: "snap-3",
		syncId: "sync-1",
		pullRequestUrl: null,
		startedAt: "2026-11-01T00:00:00.000Z",
		userId: "user-1",
	};
	return [
		[
			"a repository source of truth",
			() => {
				fake.state.project = {
					instructionSettings: { sourceOfTruth: "REPOSITORY" },
					publishedInstructionSnapshotId: "snap-3",
				};
			},
			"repository_mode",
		],
		[
			"a configured repository sync",
			() => {
				fake.state.sync = { id: "sync-1" };
			},
			"repository_mode",
		],
		[
			"an open move into a repository",
			() => {
				fake.state.project = {
					instructionSettings: {
						sourceOfTruth: "UPLOAD",
						migration,
					},
					publishedInstructionSnapshotId: "snap-3",
				};
			},
			"migration_open",
		],
		[
			"a RECEIVING snapshot",
			() => {
				fake.state.snapshots.push(
					snapshot("snap-4", 4, { status: "RECEIVING" }),
				);
			},
			"active",
		],
		[
			"a VALIDATING snapshot",
			() => {
				fake.state.snapshots.push(
					snapshot("snap-4", 4, { status: "VALIDATING" }),
				);
			},
			"active",
		],
		[
			"an open proposal pull request",
			() => {
				fake.state.snapshots.push(
					snapshot("snap-4", 4, {
						proposalStatus: "REJECTED",
						proposalDestination: "REPOSITORY",
						pullRequestState: "CLOSE_REQUESTED",
					}),
				);
			},
			"pull_request_unresolved",
		],
		[
			"a member proposal branch that still owes work",
			() => {
				fake.state.snapshots.push(
					snapshot("snap-4", 4, {
						proposalStatus: "CLOSED",
						proposalDestination: "REPOSITORY",
						pullRequestState: "CLOSED",
						proposalBranch: {
							state: "OPEN",
							untracked: false,
							membership: null,
							mergeSyncRequestedAt: null,
							createIssuedAt: null,
							confirmationDueAt: null,
						},
					}),
				);
			},
			"pull_request_unresolved",
		],
		[
			"a direct commit whose push outcome is unknown",
			() => {
				fake.state.snapshots.push(
					snapshot("snap-4", 4, {
						proposalDestination: "REPOSITORY_COMMIT",
						commitOutcome: null,
					}),
				);
			},
			"pull_request_unresolved",
		],
		[
			"a proposal waiting for review",
			() => {
				fake.state.snapshots.push(
					snapshot("snap-4", 4, { proposalStatus: "PENDING" }),
				);
			},
			"proposal_pending",
		],
	];
}

describe("listProjectInstructionStorageKeys", () => {
	it("returns each file row's key and each staged intent blob, with the snapshot that names it", async () => {
		fake.state.files = [{ snapshotId: "snap-1", storageKey: "k-file" }];
		fake.state.entries = [
			{ snapshotId: "snap-2", storageKey: "k-entry" },
			// A DELETE entry stores no blob.
			{ snapshotId: "snap-2", storageKey: null },
		];

		await expect(
			listProjectInstructionStorageKeys("proj-1", "org-1"),
		).resolves.toEqual([
			{ snapshotId: "snap-1", storageKey: "k-file" },
			{ snapshotId: "snap-2", storageKey: "k-entry" },
		]);
		expect(fake.db.projectInstructionFile.findMany).toHaveBeenCalledWith({
			where: { projectId: "proj-1", organizationId: "org-1" },
			select: { snapshotId: true, storageKey: true },
		});
		expect(
			fake.db.projectInstructionGitIntentEntry.findMany,
		).toHaveBeenCalledWith({
			where: {
				projectId: "proj-1",
				organizationId: "org-1",
				storageKey: { not: null },
			},
			select: { snapshotId: true, storageKey: true },
		});
	});
});
