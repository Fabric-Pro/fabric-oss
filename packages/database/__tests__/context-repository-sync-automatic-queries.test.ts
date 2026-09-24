/**
 * The Living Memory subject's store for the shared repository-sync poll and
 * push webhook (design 2026-09-23 §11.1, Fizzy #2673), protocol tests: the
 * SQL each function sends, pinned the way
 * instruction-repository-sync-queries.test.ts pins its twin's. What the
 * fence does to a row, expiry by the database's clock included, is pinned
 * against the stateful row store in context-repository-sync-lease.test.ts.
 *
 * Run with: pnpm --filter @repo/database exec vitest run __tests__/context-repository-sync-automatic-queries.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "../prisma/client";

const m = vi.hoisted(() => ({
	sync: {
		findFirst: vi.fn(),
		findMany: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
	},
	run: { createMany: vi.fn(), findFirst: vi.fn() },
	integration: { findFirst: vi.fn() },
	$queryRaw: vi.fn(),
	$executeRaw: vi.fn(),
	$transaction: vi.fn(),
	recordAuditTx: vi.fn(),
}));

const client = vi.hoisted(() => ({
	projectContextRepositorySync: m.sync,
	projectContextRepositorySyncRun: m.run,
	projectRepositoryIntegration: m.integration,
	$queryRaw: (...a: unknown[]) => m.$queryRaw(...a),
	$executeRaw: (...a: unknown[]) => m.$executeRaw(...a),
}));

vi.mock("../prisma/client", async () => {
	// The real tagged-template builders (`Prisma.sql` is `sqltag`), so the
	// lease fence reaches the fake client exactly as Postgres would get it.
	const { join, sqltag } = await vi.importActual<
		typeof import("@prisma/client/runtime/client")
	>("@prisma/client/runtime/client");
	return {
		db: { ...client, $transaction: m.$transaction },
		Prisma: {
			PrismaClientKnownRequestError: class extends Error {},
			JsonNull: "JsonNull",
			join,
			sql: sqltag,
		},
	};
});
vi.mock("../prisma/queries/audit-log", () => ({
	recordAuditTx: m.recordAuditTx,
}));
vi.mock("../prisma/queries/projects/projects", () => ({
	canCreateProjectInstructions: vi.fn(),
	canCreateProjectContexts: vi.fn(),
}));

import {
	claimDueContextSyncRows,
	contextSyncLeaseHeld,
	findContextSyncsForPush,
	recordContextSyncCheckFailure,
	recordPendingContextSyncHead,
	settlePendingContextSyncHead,
	writeBackContextSync,
	writeContextRepositorySyncScheduling,
} from "../prisma/queries/projects/context-repository-sync-automatic";
import type { RepositorySyncTransactionRunner } from "../prisma/queries/repository-sync-subjects";

const tx = client as unknown as Prisma.TransactionClient;
const NOW = new Date("2026-09-24T12:00:00.000Z");
const MIN = 60 * 1000;
const HEAD = "a".repeat(40);
const REPO_URL = "https://github.com/example-org/handbook";

beforeEach(() => {
	for (const group of [m.sync, m.run, m.integration]) {
		for (const fn of Object.values(group)) {
			fn.mockReset();
		}
	}
	m.$queryRaw.mockReset();
	m.$executeRaw.mockReset();
	m.$transaction.mockReset();
	m.recordAuditTx.mockReset();
});

/** A row as the claim returns it (Decision 46). */
const ROW = {
	id: "sync_1",
	projectId: "proj_1",
	organizationId: "org_1",
	userId: "user_1",
	generation: 3,
	repositoryIntegrationId: "int_1",
	ref: "main",
	lastEvaluatedCommitSha: null,
	lastEvaluatedGeneration: null,
	suppressedCommitSha: null,
	suppressedGeneration: null,
	failureCount: 1,
	leaseUntil: new Date(NOW.getTime() + 2 * MIN),
};
const FENCE = { id: "sync_1", generation: 3, leaseUntil: ROW.leaseUntil };

/** The shared fence, with its first placeholder at `$first` (Decisions 31 and 48). */
function fenceSql(first: number): string {
	return `"id" = $${first} AND "generation" = $${first + 1} AND "nextCheckAt" = $${first + 2} AND "nextCheckAt" > (clock_timestamp() AT TIME ZONE 'UTC') AND "automatic" = true AND "automaticPausedReason" IS NULL`;
}
const FENCE_VALUES = ["sync_1", 3, ROW.leaseUntil];

/** The one raw statement a client method received, whitespace squashed. */
function sent(method: ReturnType<typeof vi.fn>): {
	text: string;
	values: unknown[];
} {
	expect(method).toHaveBeenCalledTimes(1);
	const [query] = method.mock.calls[0] as [
		{ text: string; values: unknown[] },
	];
	return {
		text: query.text.replace(/\s+/g, " ").trim(),
		values: query.values,
	};
}

describe("claimDueContextSyncRows (spec §6.1)", () => {
	it("protocol: leases the oldest-due rows of active integrations of THIS table in one statement that skips locked rows, and returns each lease", async () => {
		m.$queryRaw.mockResolvedValueOnce([ROW]);

		expect(
			await claimDueContextSyncRows(tx, {
				limit: 4,
				leaseMs: 2 * MIN,
			}),
		).toEqual([ROW]);

		expect(m.$transaction).not.toHaveBeenCalled();
		expect(m.$queryRaw).toHaveBeenCalledTimes(1);
		const [strings, ...values] = m.$queryRaw.mock.calls[0] as [
			TemplateStringsArray,
			...unknown[],
		];
		const sql = strings.join("?").replace(/\s+/g, " ");
		// The lease is born on the database's clock, the clock the fence ends
		// it by, from a bound duration: no worker date reaches the row
		// (Fizzy #2683, mirrored).
		expect(sql).toContain(
			`UPDATE "project_context_repository_sync" AS s SET "nextCheckAt" = (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ?::double precision / 1000) WHERE`,
		);
		expect(sql).toContain('FROM "project_context_repository_sync" AS s2');
		expect(sql).not.toContain("project_instruction_repository_sync");
		expect(sql).toContain('WHERE s."id" = ANY (ARRAY(');
		expect(sql).toContain(
			'JOIN "project_repository_integration" AS i ON i."id" = s2."repositoryIntegrationId"',
		);
		expect(sql).toContain('s2."automatic" = true');
		expect(sql).toContain('s2."automaticPausedReason" IS NULL');
		expect(sql).toContain(
			`s2."nextCheckAt" <= (clock_timestamp() AT TIME ZONE 'UTC')`,
		);
		expect(sql).toContain(`i."status" = 'ACTIVE'`);
		expect(sql).toContain(
			'ORDER BY s2."nextCheckAt" ASC, s2."id" ASC LIMIT ?',
		);
		expect(sql).toContain("FOR UPDATE OF s2 SKIP LOCKED");
		for (const column of [
			'"id"',
			'"projectId"',
			'"organizationId"',
			'"userId"',
			'"generation"',
			'"repositoryIntegrationId"',
			'"ref"',
			'"lastEvaluatedCommitSha"',
			'"lastEvaluatedGeneration"',
			'"suppressedCommitSha"',
			'"suppressedGeneration"',
			'"failureCount"',
		]) {
			expect(sql).toContain(`s.${column}`);
		}
		expect(sql).toContain('s."nextCheckAt" AS "leaseUntil"');
		// Only the lease: the check measures its own clock offset from its
		// own lease read, on the worker that uses it (Fizzy #2683).
		expect(sql).not.toContain('AS "claimedAt"');
		// The lease's length and the limit, and nothing dated.
		expect(values).toEqual([2 * MIN, 4]);
		expect(values.some((value) => value instanceof Date)).toBe(false);
	});

	it("protocol: returns an empty batch when nothing is due", async () => {
		m.$queryRaw.mockResolvedValueOnce([]);
		expect(
			await claimDueContextSyncRows(tx, { limit: 4, leaseMs: 2 * MIN }),
		).toEqual([]);
	});
});

describe("contextSyncLeaseHeld (Decisions 31 and 48)", () => {
	const DB_NOW = new Date(NOW.getTime() + 60 * MIN);

	it("protocol: reads the lease and the database's clock in one raw SELECT on the shared fence, on the caller's client (Fizzy #2683)", async () => {
		m.$queryRaw.mockResolvedValueOnce([{ dbNow: DB_NOW, held: true }]);
		expect(await contextSyncLeaseHeld(tx, FENCE)).toEqual({
			held: true,
			dbNow: DB_NOW,
		});
		expect(sent(m.$queryRaw)).toEqual({
			text: `SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS "dbNow", EXISTS (SELECT 1 FROM "project_context_repository_sync" WHERE ${fenceSql(1)}) AS "held"`,
			values: FENCE_VALUES,
		});
	});

	it("protocol: a lost lease still reports the database's clock", async () => {
		m.$queryRaw.mockResolvedValueOnce([{ dbNow: DB_NOW, held: false }]);
		expect(await contextSyncLeaseHeld(tx, FENCE)).toEqual({
			held: false,
			dbNow: DB_NOW,
		});
	});
});

describe("writeBackContextSync (spec §6.1, Decisions 31, 46 and 48)", () => {
	it("protocol: sets every contract column a patch names, in a fixed order, casting the pause to THIS table's enum, on the fence", async () => {
		m.$executeRaw.mockResolvedValueOnce(1);
		const nextCheckAt = new Date(NOW.getTime() + 15 * MIN);
		expect(
			await writeBackContextSync(tx, FENCE, {
				nextCheckAt,
				failureCount: 0,
				automaticPausedReason: "REF_MISSING",
				automaticPausedAt: NOW,
				suppressedCommitSha: null,
				suppressedGeneration: 3,
				lastEvaluatedCommitSha: HEAD,
				lastEvaluatedGeneration: 3,
			}),
		).toEqual({ applied: true });
		expect(sent(m.$executeRaw)).toEqual({
			text: `UPDATE "project_context_repository_sync" SET "nextCheckAt" = $1, "failureCount" = $2, "automaticPausedReason" = $3::"ProjectContextSyncPause", "automaticPausedAt" = $4, "suppressedCommitSha" = $5, "suppressedGeneration" = $6, "lastEvaluatedCommitSha" = $7, "lastEvaluatedGeneration" = $8, "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC') WHERE ${fenceSql(9)}`,
			values: [
				nextCheckAt,
				0,
				"REF_MISSING",
				NOW,
				null,
				3,
				HEAD,
				3,
				...FENCE_VALUES,
			],
		});
		expect(m.$transaction).not.toHaveBeenCalled();
	});

	it("protocol: no row updated means nothing applied", async () => {
		m.$executeRaw.mockResolvedValueOnce(0);
		expect(
			await writeBackContextSync(tx, FENCE, { nextCheckAt: NOW }),
		).toEqual({ applied: false });
	});
});

describe("recordContextSyncCheckFailure (spec §6.1, Decision 35)", () => {
	const failure = {
		row: ROW,
		pollRunId: "poll_run_1",
		error: "REF_MISSING" as const,
		pause: "REF_MISSING" as const,
		now: NOW,
	};

	it("protocol: pauses on the fence first, then writes the FAILED POLL receipt with its frozen context and the completion audit, all on the caller's client", async () => {
		m.$executeRaw.mockResolvedValueOnce(1);
		m.sync.findFirst.mockResolvedValue({
			paths: ["docs", "notes/glossary.md"],
		});
		m.run.createMany.mockResolvedValue({ count: 1 });
		m.integration.findFirst.mockResolvedValue({
			repositoryOwner: "example-org",
			repositoryName: "handbook",
		});

		expect(await recordContextSyncCheckFailure(tx, failure)).toEqual({
			applied: true,
		});

		expect(m.$transaction).not.toHaveBeenCalled();
		expect(sent(m.$executeRaw)).toEqual({
			// The pause clears the schedule: the claim's lease must not be
			// left behind as an overdue `nextCheckAt` on a row nothing claims.
			text: `UPDATE "project_context_repository_sync" SET "nextCheckAt" = $1, "automaticPausedReason" = $2::"ProjectContextSyncPause", "automaticPausedAt" = $3, "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC') WHERE ${fenceSql(4)}`,
			values: [null, "REF_MISSING", NOW, ...FENCE_VALUES],
		});
		expect(m.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
			m.run.createMany.mock.invocationCallOrder[0] ?? 0,
		);
		// The paths are read tenant-bound, after the pause locked the row.
		expect(m.sync.findFirst).toHaveBeenCalledWith({
			where: {
				id: "sync_1",
				projectId: "proj_1",
				organizationId: "org_1",
			},
			select: { paths: true },
		});
		expect(m.run.createMany).toHaveBeenCalledWith({
			data: [
				{
					id: "sync_1:poll_run_1:3",
					syncId: "sync_1",
					projectId: "proj_1",
					organizationId: "org_1",
					userId: "user_1",
					generation: 3,
					context: {
						ref: "main",
						paths: ["docs", "notes/glossary.md"],
						repositoryIntegrationId: "int_1",
						actingUserId: "user_1",
					},
					trigger: "POLL",
					startedAt: NOW,
					finishedAt: NOW,
					status: "FAILED",
					error: "REF_MISSING",
				},
			],
			skipDuplicates: true,
		});
		expect(m.integration.findFirst).toHaveBeenCalledWith({
			where: { id: "int_1", projectId: "proj_1" },
			select: { repositoryOwner: true, repositoryName: true },
		});
		// The row `recordContextSyncCompletedAudit` writes for every other
		// completion, with the poll's trigger and no counts.
		expect(m.recordAuditTx).toHaveBeenCalledTimes(1);
		expect(m.recordAuditTx).toHaveBeenCalledWith(tx, {
			action: "project.context.repository_sync_completed",
			category: "project",
			severity: "warning",
			outcome: "failure",
			actor: { type: "user", userId: "user_1" },
			organizationId: "org_1",
			projectId: "proj_1",
			resource: {
				type: "project_context_repository_sync",
				id: "sync_1",
				name: "example-org/handbook",
			},
			metadata: {
				runId: "sync_1:poll_run_1:3",
				trigger: "POLL",
				status: "FAILED",
				error: "REF_MISSING",
				commitSha: null,
				counts: {
					created: 0,
					updated: 0,
					adopted: 0,
					unchanged: 0,
					conflict: 0,
					pathInUse: 0,
					removed: 0,
					pruneConflicts: 0,
					attention: 0,
				},
			},
		});
	});

	it("protocol: records a revoked delegate the same way, pausing with PERMISSION_REVOKED (Decision 33)", async () => {
		m.$executeRaw.mockResolvedValueOnce(1);
		m.sync.findFirst.mockResolvedValue({ paths: ["docs"] });
		m.run.createMany.mockResolvedValue({ count: 1 });
		m.integration.findFirst.mockResolvedValue(null);

		await recordContextSyncCheckFailure(tx, {
			...failure,
			error: "PERMISSION_DENIED",
			pause: "PERMISSION_REVOKED",
		});

		expect(sent(m.$executeRaw).values.slice(0, 3)).toEqual([
			null,
			"PERMISSION_REVOKED",
			NOW,
		]);
		expect(m.run.createMany.mock.calls[0]?.[0].data[0]).toMatchObject({
			status: "FAILED",
			error: "PERMISSION_DENIED",
		});
		expect(m.recordAuditTx).toHaveBeenCalledWith(
			tx,
			expect.objectContaining({
				resource: expect.objectContaining({ name: null }),
				metadata: expect.objectContaining({
					error: "PERMISSION_DENIED",
				}),
			}),
		);
	});

	it("protocol: stops after a pause that matched no row", async () => {
		m.$executeRaw.mockResolvedValueOnce(0);
		expect(await recordContextSyncCheckFailure(tx, failure)).toEqual({
			applied: false,
		});
		expect(m.sync.findFirst).not.toHaveBeenCalled();
		expect(m.run.createMany).not.toHaveBeenCalled();
		expect(m.recordAuditTx).not.toHaveBeenCalled();
	});
});

describe("findContextSyncsForPush (spec §6.2, Decision 46)", () => {
	function stored(overrides: Record<string, unknown> = {}) {
		return {
			id: "sync_1",
			projectId: "proj_1",
			organizationId: "org_1",
			generation: 3,
			ref: "main",
			automatic: true,
			automaticPausedReason: null,
			lastEvaluatedCommitSha: HEAD,
			lastEvaluatedGeneration: 3,
			suppressedCommitSha: null,
			suppressedGeneration: null,
			repositoryIntegration: {
				projectId: "proj_1",
				project: { organizationId: "org_1" },
			},
			...overrides,
		};
	}

	it("reads the Living Memory syncs that follow the pushed branch on the repository's ACTIVE integrations, oldest first", async () => {
		m.sync.findMany.mockResolvedValue([stored()]);

		expect(
			await findContextSyncsForPush({
				repositoryUrl: REPO_URL,
				ref: "main",
			}),
		).toEqual([
			{
				id: "sync_1",
				projectId: "proj_1",
				organizationId: "org_1",
				generation: 3,
				ref: "main",
				automatic: true,
				automaticPausedReason: null,
				lastEvaluatedCommitSha: HEAD,
				lastEvaluatedGeneration: 3,
				suppressedCommitSha: null,
				suppressedGeneration: null,
			},
		]);
		expect(m.sync.findMany).toHaveBeenCalledWith({
			where: {
				ref: "main",
				repositoryIntegration: {
					repositoryUrl: REPO_URL,
					status: "ACTIVE",
				},
			},
			orderBy: { createdAt: "asc" },
			select: expect.objectContaining({
				id: true,
				organizationId: true,
				automatic: true,
				automaticPausedReason: true,
				lastEvaluatedCommitSha: true,
				lastEvaluatedGeneration: true,
				suppressedCommitSha: true,
				suppressedGeneration: true,
				repositoryIntegration: {
					select: {
						projectId: true,
						project: { select: { organizationId: true } },
					},
				},
			}),
		});
	});

	it.each([
		[
			"a push naming another project's organization starts nothing (Review Focus 1)",
			{
				repositoryIntegration: {
					projectId: "proj_1",
					project: { organizationId: "org_2" },
				},
			},
		],
		[
			"a row whose integration belongs to another project is dropped",
			{
				repositoryIntegration: {
					projectId: "proj_2",
					project: { organizationId: "org_1" },
				},
			},
		],
		[
			"a row whose integration's project has no organization is dropped",
			{
				repositoryIntegration: {
					projectId: "proj_1",
					project: { organizationId: null },
				},
			},
		],
	])("%s", async (_label, overrides) => {
		m.sync.findMany.mockResolvedValue([
			stored(overrides),
			stored({
				id: "sync_2",
				projectId: "proj_2",
				repositoryIntegration: {
					projectId: "proj_2",
					project: { organizationId: "org_1" },
				},
			}),
		]);
		const rows = await findContextSyncsForPush({
			repositoryUrl: REPO_URL,
			ref: "main",
		});
		expect(rows.map((row) => row.id)).toEqual(["sync_2"]);
	});
});

describe("writeContextRepositorySyncScheduling (§5.4, §11.1)", () => {
	const SYNC = {
		id: "sync_1",
		projectId: "proj_1",
		organizationId: "org_1",
		generation: 3,
		failureCount: 2,
		automaticPausedReason: null,
		pendingCommitSha: null,
	};

	it("writes the effect's patch, counting backoff from the failure count read under the lock, tenant-bound", async () => {
		m.sync.update.mockResolvedValue({});

		expect(
			await writeContextRepositorySyncScheduling(tx, {
				sync: SYNC,
				generation: 3,
				effect: { kind: "backoff" },
				now: NOW,
			}),
		).toEqual({ applied: true });

		expect(m.sync.update).toHaveBeenCalledWith({
			where: {
				id: "sync_1",
				projectId: "proj_1",
				organizationId: "org_1",
			},
			// min(5 min × 2^3, 6 h) after the third failure.
			data: {
				failureCount: 3,
				nextCheckAt: new Date(NOW.getTime() + 40 * MIN),
			},
		});
	});

	it("marks the applied head evaluated under the run's generation", async () => {
		m.sync.update.mockResolvedValue({});

		await writeContextRepositorySyncScheduling(tx, {
			sync: SYNC,
			generation: 3,
			effect: { kind: "success", commitSha: HEAD },
			now: NOW,
		});

		expect(m.sync.update.mock.calls[0]?.[0].data).toEqual({
			failureCount: 0,
			nextCheckAt: new Date(NOW.getTime() + 15 * MIN),
			lastEvaluatedCommitSha: HEAD,
			lastEvaluatedGeneration: 3,
		});
	});

	it("dates the next check on the database's clock the lock read when the caller passes no time (Fizzy #2683)", async () => {
		const dbNow = new Date(NOW.getTime() + 60 * MIN);
		m.sync.update.mockResolvedValue({});

		await writeContextRepositorySyncScheduling(tx, {
			sync: { ...SYNC, now: dbNow },
			generation: 3,
			effect: { kind: "success", commitSha: HEAD },
		});

		expect(m.sync.update.mock.calls[0]?.[0].data).toMatchObject({
			nextCheckAt: new Date(dbNow.getTime() + 15 * MIN),
		});
	});

	it("writes nothing for a run of an older generation: the re-configure reset the schedule", async () => {
		expect(
			await writeContextRepositorySyncScheduling(tx, {
				sync: { ...SYNC, generation: 4 },
				generation: 3,
				effect: { kind: "success", commitSha: HEAD },
				now: NOW,
			}),
		).toEqual({ applied: false });
		expect(m.sync.update).not.toHaveBeenCalled();
	});

	it("writes nothing for the none effect", async () => {
		expect(
			await writeContextRepositorySyncScheduling(tx, {
				sync: SYNC,
				generation: 3,
				effect: { kind: "none" },
			}),
		).toEqual({ applied: false });
		expect(m.sync.update).not.toHaveBeenCalled();
	});

	it("still applies a backoff on an unknown effect, and logs it, so the completion transaction commits (Fizzy #2687)", async () => {
		const { logger } = await import("@repo/logs");
		const error = vi.spyOn(logger, "error").mockImplementation(() => {});
		m.sync.update.mockResolvedValue({});

		expect(
			await writeContextRepositorySyncScheduling(tx, {
				sync: SYNC,
				generation: 3,
				effect: { kind: "retry_later" } as unknown as Parameters<
					typeof writeContextRepositorySyncScheduling
				>[1]["effect"],
				now: NOW,
			}),
		).toEqual({ applied: true });

		// The throw never escaped: the row backed off as a failed check would.
		expect(m.sync.update.mock.calls[0]?.[0].data).toEqual({
			failureCount: 3,
			nextCheckAt: new Date(NOW.getTime() + 40 * MIN),
		});
		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "contexts.sync.unknown_scheduling_effect",
				syncId: "sync_1",
				projectId: "proj_1",
				organizationId: "org_1",
				kind: "retry_later",
			}),
			expect.any(String),
		);
		error.mockRestore();
	});

	describe("the re-check request a push or a poll left while the run was open (Fizzy #2673, the twin of #2682)", () => {
		const PUSHED = "d".repeat(40);
		const WHERE = {
			id: "sync_1",
			projectId: "proj_1",
			organizationId: "org_1",
		};

		/** The locked sync row, carrying `pendingCommitSha`. */
		function lockedWith(row: {
			pendingCommitSha: string;
			automaticPausedReason?: string;
			generation?: number;
			failureCount?: number;
		}) {
			m.sync.update.mockResolvedValue({});
			return { ...SYNC, failureCount: 0, ...row };
		}

		it("makes the row due now instead of in 15 minutes, and clears the marker", async () => {
			const sync = lockedWith({ pendingCommitSha: PUSHED });
			expect(
				await writeContextRepositorySyncScheduling(tx, {
					sync,
					generation: 3,
					effect: { kind: "success", commitSha: HEAD },
					now: NOW,
				}),
			).toEqual({ applied: true });
			expect(m.sync.update).toHaveBeenCalledWith({
				where: WHERE,
				data: {
					failureCount: 0,
					nextCheckAt: NOW,
					lastEvaluatedCommitSha: HEAD,
					lastEvaluatedGeneration: 3,
					pendingCommitSha: null,
				},
			});
		});

		it("still makes the row due when the marker names the run's own commit: an older head delivered after a newer one must not stand for both", async () => {
			// The run read HEAD. Push PUSHED recorded its head, then a
			// delayed delivery of the older push overwrote it with HEAD. The
			// one slot kept only the older observation, so equality proves
			// nothing about PUSHED.
			const sync = lockedWith({ pendingCommitSha: HEAD });
			await writeContextRepositorySyncScheduling(tx, {
				sync,
				generation: 3,
				effect: { kind: "success", commitSha: HEAD },
				now: NOW,
			});
			expect(m.sync.update).toHaveBeenCalledWith({
				where: WHERE,
				data: {
					failureCount: 0,
					nextCheckAt: NOW,
					lastEvaluatedCommitSha: HEAD,
					lastEvaluatedGeneration: 3,
					pendingCommitSha: null,
				},
			});
		});

		it("makes the row due over a failed run's backoff", async () => {
			const sync = lockedWith({ pendingCommitSha: PUSHED });
			await writeContextRepositorySyncScheduling(tx, {
				sync,
				generation: 3,
				effect: { kind: "backoff" },
				now: NOW,
			});
			expect(m.sync.update).toHaveBeenCalledWith({
				where: WHERE,
				data: {
					failureCount: 1,
					nextCheckAt: NOW,
					pendingCommitSha: null,
				},
			});
		});

		it("the none effect, which schedules nothing, still makes the row due now and clears the marker", async () => {
			const sync = lockedWith({ pendingCommitSha: PUSHED });
			expect(
				await writeContextRepositorySyncScheduling(tx, {
					sync,
					generation: 3,
					effect: { kind: "none" },
					now: NOW,
				}),
			).toEqual({ applied: true });
			expect(m.sync.update).toHaveBeenCalledWith({
				where: WHERE,
				data: { nextCheckAt: NOW, pendingCommitSha: null },
			});
		});

		it("a pause wins: the schedule stays cleared and the marker goes", async () => {
			const sync = lockedWith({ pendingCommitSha: PUSHED });
			await writeContextRepositorySyncScheduling(tx, {
				sync,
				generation: 3,
				effect: { kind: "pause", reason: "REF_MISSING" },
				now: NOW,
			});
			expect(m.sync.update).toHaveBeenCalledWith({
				where: WHERE,
				data: {
					nextCheckAt: null,
					automaticPausedReason: "REF_MISSING",
					automaticPausedAt: NOW,
					pendingCommitSha: null,
				},
			});
		});

		it.each([
			[
				"success",
				{ kind: "success", commitSha: HEAD },
				{
					failureCount: 0,
					nextCheckAt: null,
					lastEvaluatedCommitSha: HEAD,
					lastEvaluatedGeneration: 3,
					pendingCommitSha: null,
				},
			],
			[
				"backoff",
				{ kind: "backoff" },
				{
					failureCount: 3,
					nextCheckAt: null,
					pendingCommitSha: null,
				},
			],
			[
				"none",
				{ kind: "none" },
				{ nextCheckAt: null, pendingCommitSha: null },
			],
		] as const)(
			"a row already paused keeps no next check under the %s effect, and the marker goes",
			async (_label, effect, expected) => {
				const sync = lockedWith({
					pendingCommitSha: PUSHED,
					automaticPausedReason: "REF_MISSING",
					failureCount: 2,
				});
				await writeContextRepositorySyncScheduling(tx, {
					sync,
					generation: 3,
					effect,
					now: NOW,
				});
				expect(m.sync.update).toHaveBeenCalledWith({
					where: WHERE,
					data: expected,
				});
			},
		);

		it("a run of an older generation leaves the marker to the current configuration's runs", async () => {
			const sync = lockedWith({
				pendingCommitSha: PUSHED,
				generation: 4,
			});
			expect(
				await writeContextRepositorySyncScheduling(tx, {
					sync,
					generation: 3,
					effect: { kind: "success", commitSha: HEAD },
					now: NOW,
				}),
			).toEqual({ applied: false });
			expect(m.sync.update).not.toHaveBeenCalled();
		});
	});
});

describe("recordPendingContextSyncHead (Fizzy #2673, the twin of #2682)", () => {
	const input = {
		syncId: "sync_1",
		projectId: "proj_1",
		organizationId: "org_1",
		generation: 3,
		commitSha: HEAD,
	};

	it("protocol: one update of THIS table on the caller's client, fenced on the row's id, tenant and generation, writing only the marker", async () => {
		m.sync.updateMany.mockResolvedValueOnce({ count: 1 });

		expect(await recordPendingContextSyncHead(tx, input)).toEqual({
			applied: true,
		});
		expect(m.sync.updateMany).toHaveBeenCalledTimes(1);
		expect(m.sync.updateMany).toHaveBeenCalledWith({
			where: {
				id: "sync_1",
				projectId: "proj_1",
				organizationId: "org_1",
				generation: 3,
			},
			// No `nextCheckAt`: a poll check's lease stays held, and the open
			// run's completion is what schedules the row.
			data: { pendingCommitSha: HEAD },
		});
		// Not the lease fence: no raw statement, and no transaction of its own.
		expect(m.$executeRaw).not.toHaveBeenCalled();
		expect(m.$queryRaw).not.toHaveBeenCalled();
		expect(m.$transaction).not.toHaveBeenCalled();
	});

	it("protocol: a row whose generation moved on, or that is gone, applies nothing", async () => {
		m.sync.updateMany.mockResolvedValueOnce({ count: 0 });
		expect(await recordPendingContextSyncHead(tx, input)).toEqual({
			applied: false,
		});
	});
});

describe("settlePendingContextSyncHead (Fizzy #2673, the twin of #2682)", () => {
	/** Stands for `db`: its transaction hands the callback the fake client. */
	const runner: RepositorySyncTransactionRunner = {
		$transaction: (fn) => m.$transaction(fn),
	};
	const input = {
		syncId: "sync_1",
		projectId: "proj_1",
		organizationId: "org_1",
		generation: 3,
		runId: "run_open",
		now: NOW,
	};
	const FENCE_WHERE = {
		id: "sync_1",
		projectId: "proj_1",
		organizationId: "org_1",
		generation: 3,
	};

	beforeEach(() => {
		m.$transaction.mockImplementation(
			(fn: (client: Prisma.TransactionClient) => unknown) => fn(tx),
		);
	});

	/** The sync row the settle locks, with the database's clock it read. */
	function lockedRow(row: {
		automaticPausedReason: string | null;
		pendingCommitSha: string | null;
		now?: Date;
	}) {
		m.$queryRaw.mockResolvedValueOnce([{ now: NOW, ...row }]);
	}

	it("protocol: locks THIS table's sync row FIRST, fenced on its id, tenant and generation, then reads the run's receipt, in one transaction", async () => {
		lockedRow({ automaticPausedReason: null, pendingCommitSha: HEAD });
		m.run.findFirst.mockResolvedValueOnce({ finishedAt: null });

		await settlePendingContextSyncHead(runner, input);

		expect(m.$transaction).toHaveBeenCalledTimes(1);
		const [strings, ...values] = m.$queryRaw.mock.calls[0] as [
			TemplateStringsArray,
			...unknown[],
		];
		const sql = strings.join("?").replace(/\s+/g, " ");
		// The database's clock is read under the same lock (Fizzy #2683).
		expect(sql).toContain(
			`SELECT "automaticPausedReason", "pendingCommitSha", (clock_timestamp() AT TIME ZONE 'UTC') AS "now" FROM "project_context_repository_sync"`,
		);
		expect(sql).toContain(
			'WHERE "id" = ? AND "projectId" = ? AND "organizationId" = ? AND "generation" = ? FOR UPDATE',
		);
		expect(values).toEqual(["sync_1", "proj_1", "org_1", 3]);
		// The receipt is the one `begin` keys `<syncId>:<workflow run id>`
		// (`contextSyncRunKey`), in this tenant.
		expect(m.run.findFirst).toHaveBeenCalledWith({
			where: {
				id: "sync_1:run_open",
				syncId: "sync_1",
				projectId: "proj_1",
				organizationId: "org_1",
			},
			select: { finishedAt: true },
		});
		expect(m.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
			m.run.findFirst.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("an unfinished receipt writes nothing: its completion takes this lock later and consumes the marker", async () => {
		lockedRow({ automaticPausedReason: null, pendingCommitSha: HEAD });
		m.run.findFirst.mockResolvedValueOnce({ finishedAt: null });
		expect(await settlePendingContextSyncHead(runner, input)).toEqual({
			applied: false,
			settled: "consumer_pending",
		});
		expect(m.sync.updateMany).not.toHaveBeenCalled();
	});

	it("a receipt `begin` has not inserted yet writes nothing either", async () => {
		lockedRow({ automaticPausedReason: null, pendingCommitSha: HEAD });
		m.run.findFirst.mockResolvedValueOnce(null);
		expect(await settlePendingContextSyncHead(runner, input)).toEqual({
			applied: false,
			settled: "consumer_pending",
		});
		expect(m.sync.updateMany).not.toHaveBeenCalled();
	});

	it("makes the row due at the database's clock read under the lock when the caller passes no time (Fizzy #2683)", async () => {
		const dbNow = new Date(NOW.getTime() + 60 * MIN);
		lockedRow({
			automaticPausedReason: null,
			pendingCommitSha: HEAD,
			now: dbNow,
		});
		m.run.findFirst.mockResolvedValueOnce({ finishedAt: NOW });
		m.sync.updateMany.mockResolvedValueOnce({ count: 1 });
		const { now: _callerNow, ...withoutNow } = input;
		expect(await settlePendingContextSyncHead(runner, withoutNow)).toEqual({
			applied: true,
			settled: "made_due",
		});
		expect(m.sync.updateMany).toHaveBeenCalledWith({
			where: FENCE_WHERE,
			data: { nextCheckAt: dbNow, pendingCommitSha: null },
		});
	});

	it("a finished receipt means the completion already committed without the marker: the row is due now and the marker cleared", async () => {
		lockedRow({ automaticPausedReason: null, pendingCommitSha: HEAD });
		m.run.findFirst.mockResolvedValueOnce({ finishedAt: NOW });
		m.sync.updateMany.mockResolvedValueOnce({ count: 1 });
		expect(await settlePendingContextSyncHead(runner, input)).toEqual({
			applied: true,
			settled: "made_due",
		});
		expect(m.sync.updateMany).toHaveBeenCalledWith({
			where: FENCE_WHERE,
			data: { nextCheckAt: NOW, pendingCommitSha: null },
		});
	});

	it("a finished receipt on a paused row clears the marker and keeps no next check", async () => {
		lockedRow({
			automaticPausedReason: "REF_MISSING",
			pendingCommitSha: HEAD,
		});
		m.run.findFirst.mockResolvedValueOnce({ finishedAt: NOW });
		m.sync.updateMany.mockResolvedValueOnce({ count: 1 });
		expect(await settlePendingContextSyncHead(runner, input)).toEqual({
			applied: true,
			settled: "made_due",
		});
		expect(m.sync.updateMany).toHaveBeenCalledWith({
			where: FENCE_WHERE,
			data: { nextCheckAt: null, pendingCommitSha: null },
		});
	});

	it("a finished receipt with no marker left writes nothing: that completion already consumed it", async () => {
		lockedRow({ automaticPausedReason: null, pendingCommitSha: null });
		m.run.findFirst.mockResolvedValueOnce({ finishedAt: NOW });
		expect(await settlePendingContextSyncHead(runner, input)).toEqual({
			applied: false,
			settled: "made_due",
		});
		expect(m.sync.updateMany).not.toHaveBeenCalled();
	});

	it("a row whose generation moved on, or that is gone, is stale: no receipt read and nothing written", async () => {
		m.$queryRaw.mockResolvedValueOnce([]);
		expect(await settlePendingContextSyncHead(runner, input)).toEqual({
			applied: false,
			settled: "stale",
		});
		expect(m.run.findFirst).not.toHaveBeenCalled();
		expect(m.sync.updateMany).not.toHaveBeenCalled();
	});
});
