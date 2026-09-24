/**
 * Living Memory repository sync, automatic half (design 2026-09-23 §11.1,
 * Fizzy #2673): the `context` subject's store for the shared repository-sync
 * poll and GitHub push webhook (`../repository-sync-subjects.ts`, Decision
 * 46), and the scheduling write a finished run applies.
 *
 * Every function mirrors its coding-instructions twin in
 * `../instruction-repository-sync.ts` against `project_context_repository_sync`
 * and `project_context_repository_sync_run`: the claim, the lease fence and
 * the fenced write send the same SQL (the fence and the `SET` list are the
 * shared builders, so the two cannot drift), and the scheduling patch is the
 * shared `computeSchedulingPatch`. Two differences follow from the Living
 * Memory tables themselves: a run receipt carries its frozen `context`, and
 * its completion audit is the `project.context.repository_sync_completed`
 * row `recordContextSyncCompletedAudit` writes in `@repo/temporal`.
 *
 * Lock order stays §4.5's: the configuration row first. The claim and the
 * fenced writes touch only that row; the check-failure receipt inserts its
 * run row after the pause has locked the configuration row, and the
 * re-check settle reads the run receipt after locking the configuration row.
 */
import { logger } from "@repo/logs";
import { db, Prisma } from "../../client";
import { recordAuditTx } from "../audit-log";
import {
	computeSchedulingPatch,
	type InstructionSyncSchedulingEffect,
	type RepositorySyncSchedulingPatch,
	repositorySyncLeaseFenceSql,
	repositorySyncPatchAssignments,
} from "../instruction-repository-sync";
import type {
	ClaimedRepositorySyncRow,
	RepositorySyncCheckFailure,
	RepositorySyncFence,
	RepositorySyncPendingHeadSettlement,
	RepositorySyncPushRow,
	RepositorySyncTransactionRunner,
} from "../repository-sync-subjects";

/**
 * The counts of a run that never reached its ledger: the same keys, all
 * zero, as `EMPTY_CONTEXT_SYNC_RUN_COUNTS` in `@repo/temporal`'s
 * `context-sync-record.ts`, which writes every other completion audit.
 */
const EMPTY_RUN_COUNTS = {
	created: 0,
	updated: 0,
	adopted: 0,
	unchanged: 0,
	conflict: 0,
	pathInUse: 0,
	removed: 0,
	pruneConflicts: 0,
	attention: 0,
} as const;

/**
 * The `context` subject's claim (spec §6.1; Decisions 31 and 46), the SQL of
 * `claimDueInstructionSyncRows` against this table. CROSS-TENANT by design:
 * the schedule has no tenant context, every row carries its own
 * `organizationId`, and every later read and write names that one row.
 *
 * One statement selects due rows (automatic on, not paused, `nextCheckAt`
 * reached, integration ACTIVE), oldest due first, and leases them by moving
 * `nextCheckAt` to the database's clock plus `leaseMs` (Fizzy #2683,
 * mirrored). Both the due predicate and the lease read `clock_timestamp()`,
 * the clock the shared fence judges the lease by, so a worker whose clock
 * drifts from the database's can neither shorten nor stretch it; the caller
 * passes a duration, never a date. `FOR UPDATE OF s2 SKIP LOCKED` makes two
 * overlapping claims take disjoint rows, and `RETURNING` reads the written
 * value back, rounded to the column's milliseconds, as the lease.
 */
export async function claimDueContextSyncRows(
	tx: Prisma.TransactionClient,
	input: { limit: number; leaseMs: number },
): Promise<ClaimedRepositorySyncRow[]> {
	return tx.$queryRaw<ClaimedRepositorySyncRow[]>`
		UPDATE "project_context_repository_sync" AS s
		SET "nextCheckAt" = (clock_timestamp() AT TIME ZONE 'UTC')
			+ make_interval(secs => ${input.leaseMs}::double precision / 1000)
		WHERE s."id" = ANY (ARRAY(
			SELECT s2."id"
			FROM "project_context_repository_sync" AS s2
			JOIN "project_repository_integration" AS i
				ON i."id" = s2."repositoryIntegrationId"
			WHERE s2."automatic" = true
				AND s2."automaticPausedReason" IS NULL
				AND s2."nextCheckAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
				AND i."status" = 'ACTIVE'
			ORDER BY s2."nextCheckAt" ASC, s2."id" ASC
			LIMIT ${input.limit}
			FOR UPDATE OF s2 SKIP LOCKED
		))
		RETURNING
			s."id",
			s."projectId",
			s."organizationId",
			s."userId",
			s."generation",
			s."repositoryIntegrationId",
			s."ref",
			s."lastEvaluatedCommitSha",
			s."lastEvaluatedGeneration",
			s."suppressedCommitSha",
			s."suppressedGeneration",
			s."failureCount",
			s."nextCheckAt" AS "leaseUntil"
	`;
}

/**
 * An unlocked read of the lease (Decisions 31 and 48), for a check's early
 * exits. The fence is the shared one: the claimed generation and lease,
 * the lease still ahead of the database's clock, automatic on, not paused.
 *
 * The same statement reads the database's clock as `dbNow`, whether or not
 * the lease holds (Fizzy #2683, mirrored from `instructionSyncLeaseHeld`):
 * the check calibrates its own worker's clock from it.
 */
export async function contextSyncLeaseHeld(
	tx: Prisma.TransactionClient,
	fence: RepositorySyncFence,
): Promise<{ held: boolean; dbNow: Date }> {
	const rows = await tx.$queryRaw<{ held: boolean; dbNow: Date }[]>(
		Prisma.sql`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS "dbNow", EXISTS (SELECT 1 FROM "project_context_repository_sync" WHERE ${repositorySyncLeaseFenceSql(fence)}) AS "held"`,
	);
	const [row] = rows;
	if (row === undefined) {
		// A SELECT without FROM always returns one row; none is a driver fault.
		throw new Error("the lease read returned no row");
	}
	return { held: row.held === true, dbNow: row.dbNow };
}

/**
 * The poll's fenced write (spec §6.1; Decisions 31, 46 and 48): one
 * conditional UPDATE that applies `patch` only while the check still holds
 * its lease, so a check that outlived it, or lost a race with a finishing
 * run, a re-configure, a pause or automatic sync turned off, writes nothing.
 */
export async function writeBackContextSync(
	tx: Prisma.TransactionClient,
	fence: RepositorySyncFence,
	patch: RepositorySyncSchedulingPatch,
): Promise<{ applied: boolean }> {
	const count = await tx.$executeRaw(
		Prisma.sql`UPDATE "project_context_repository_sync"
			SET ${Prisma.join(repositorySyncPatchAssignments(patch, "ProjectContextSyncPause"), ", ")}
			WHERE ${repositorySyncLeaseFenceSql(fence)}`,
	);
	return { applied: count > 0 };
}

/**
 * A poll check's terminal receipt (spec §6.1; Decisions 33, 35 and 46): a
 * deleted branch (REF_MISSING) or a delegate who lost `CONTEXT_CREATE`
 * (PERMISSION_DENIED). Call it inside a transaction: the pause, the FAILED
 * POLL run row and its `project.context.repository_sync_completed` audit row
 * commit together, so no receipt is left half recorded.
 *
 * The pause is the fenced write, and it goes first: a check that lost its
 * lease writes nothing, and once the pause lands the lease is gone, so a
 * retried call writes nothing either. The run key is
 * `<syncId>:<pollRunId>:<generation>`, as the instructions subject's is. The
 * receipt is inserted already finished, so no `begin` or reconciliation ever
 * reads it as a predecessor, and its frozen context is the configuration
 * the check claimed, its paths read under the lock the pause took.
 */
export async function recordContextSyncCheckFailure(
	tx: Prisma.TransactionClient,
	input: RepositorySyncCheckFailure,
): Promise<{ applied: boolean }> {
	const now = input.now ?? new Date();
	const { row } = input;
	const { applied } = await writeBackContextSync(
		tx,
		row,
		computeSchedulingPatch(
			{ kind: "pause", reason: input.pause },
			{ now, failureCount: row.failureCount, generation: row.generation },
		),
	);
	if (!applied) {
		return { applied: false };
	}
	const configuration = await tx.projectContextRepositorySync.findFirst({
		where: {
			id: row.id,
			projectId: row.projectId,
			organizationId: row.organizationId,
		},
		select: { paths: true },
	});
	if (!configuration) {
		// The pause just matched this row inside this transaction, so it
		// cannot be gone; refuse rather than write a receipt without it.
		throw new Error(`context sync ${row.id} vanished under its own pause`);
	}
	const runKey = `${row.id}:${input.pollRunId}:${row.generation}`;
	await tx.projectContextRepositorySyncRun.createMany({
		data: [
			{
				id: runKey,
				syncId: row.id,
				projectId: row.projectId,
				organizationId: row.organizationId,
				userId: row.userId,
				generation: row.generation,
				context: {
					ref: row.ref,
					paths: [...configuration.paths],
					repositoryIntegrationId: row.repositoryIntegrationId,
					actingUserId: row.userId,
				},
				trigger: "POLL",
				startedAt: now,
				finishedAt: now,
				status: "FAILED",
				error: input.error,
			},
		],
		// A repeated key would be this very receipt, already recorded.
		skipDuplicates: true,
	});
	const integration = await tx.projectRepositoryIntegration.findFirst({
		where: { id: row.repositoryIntegrationId, projectId: row.projectId },
		select: { repositoryOwner: true, repositoryName: true },
	});
	await recordAuditTx(tx, {
		action: "project.context.repository_sync_completed",
		category: "project",
		severity: "warning",
		outcome: "failure",
		actor: { type: "user", userId: row.userId },
		organizationId: row.organizationId,
		projectId: row.projectId,
		resource: {
			type: "project_context_repository_sync",
			id: row.id,
			name: integration
				? `${integration.repositoryOwner}/${integration.repositoryName}`
				: null,
		},
		metadata: {
			runId: runKey,
			trigger: "POLL",
			status: "FAILED",
			error: input.error,
			commitSha: null,
			counts: { ...EMPTY_RUN_COUNTS },
		},
	});
	return { applied: true };
}

/**
 * The `context` subject's push lookup (spec §6.2; Decisions 22 and 46):
 * every sync that follows `ref` on an ACTIVE integration of the pushed
 * repository, oldest first. UNSCOPED by design, like the webhook itself:
 * tenant context comes only from rows. A row counts only when its
 * integration belongs to the row's own project and organization
 * (Review Focus 1), so no push reaches a sync through another tenant's
 * integration of the same repository.
 */
export async function findContextSyncsForPush(input: {
	repositoryUrl: string;
	ref: string;
}): Promise<RepositorySyncPushRow[]> {
	const rows = await db.projectContextRepositorySync.findMany({
		where: {
			ref: input.ref,
			repositoryIntegration: {
				repositoryUrl: input.repositoryUrl,
				status: "ACTIVE",
			},
		},
		orderBy: { createdAt: "asc" },
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			generation: true,
			ref: true,
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
		},
	});
	return rows
		.filter(
			(row) =>
				row.repositoryIntegration.projectId === row.projectId &&
				row.repositoryIntegration.project.organizationId ===
					row.organizationId,
		)
		.map((row) => ({
			id: row.id,
			projectId: row.projectId,
			organizationId: row.organizationId,
			generation: row.generation,
			ref: row.ref,
			automatic: row.automatic,
			automaticPausedReason: row.automaticPausedReason,
			lastEvaluatedCommitSha: row.lastEvaluatedCommitSha,
			lastEvaluatedGeneration: row.lastEvaluatedGeneration,
			suppressedCommitSha: row.suppressedCommitSha,
			suppressedGeneration: row.suppressedGeneration,
		}));
}

/**
 * Asks the open run's completion for a re-check (Fizzy #2673, the Living
 * Memory twin of `recordPendingInstructionSyncHead`, Fizzy #2682; see
 * `writeContextRepositorySyncScheduling`), when a push or a poll check found
 * a run already open on the row. The open run may have read the branch
 * before the head moved, and its completion would otherwise schedule the
 * next check 15 minutes out. The caller then settles the marker against
 * that run's receipt (`settlePendingContextSyncHead`): `already_running`
 * says only that the workflow has not closed, and its completion may
 * already have committed.
 *
 * The marker is a re-check flag. `pendingCommitSha` holds the last head
 * observed, for diagnostics only; the completion never compares it with the
 * run's commit. Webhook deliveries are unordered hints (a delayed or
 * redelivered push can land after a newer one), and one slot cannot keep two
 * observations, so "the run covered this head" is not something the marker
 * can prove. The last write wins, and any marker makes the row due.
 *
 * The marker, not a `nextCheckAt` write, because the completion overwrites
 * `nextCheckAt` moments later, and because a write to `nextCheckAt` from
 * outside the writers the lease fence names would end a poll check's lease.
 * This write never touches `nextCheckAt`, so a held lease stays held.
 *
 * Fenced on the configuration's identity and tenant, `(id, generation)` plus
 * `projectId` and `organizationId`, and NOT on a lease: the webhook holds
 * none, and the marker changes nothing a lease protects. A re-configure bumps
 * the generation and clears the marker, so a head seen under the old
 * configuration writes nothing.
 */
export async function recordPendingContextSyncHead(
	tx: Prisma.TransactionClient,
	input: {
		syncId: string;
		projectId: string;
		organizationId: string;
		generation: number;
		commitSha: string;
	},
): Promise<{ applied: boolean }> {
	const { count } = await tx.projectContextRepositorySync.updateMany({
		where: {
			id: input.syncId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			generation: input.generation,
		},
		data: { pendingCommitSha: input.commitSha },
	});
	return { applied: count > 0 };
}

/**
 * Settles a re-check request against the run it was left for (Fizzy #2673,
 * the twin of `settlePendingInstructionSyncHead`), right after
 * `recordPendingContextSyncHead` applied. An `already_running` answer proves
 * only that the workflow has not closed: its completion activity commits
 * before the workflow returns, so a marker written in between would wait for
 * a completion that already happened.
 *
 * One transaction. It locks the sync row first, fenced on the
 * configuration's identity, tenant and generation, the same lock (§4.5 lock
 * 1) and order the completion and a `begin` refusal take before they finish
 * the receipt `<syncId>:<runId>` (`contextSyncRunKey`, the key `begin`
 * inserts). Under that lock the receipt is either finished, and that
 * completion committed before this read, or it is not, and that completion
 * will take this lock after this commits and read the marker:
 *
 * - no row at this generation: `stale`, nothing written (a re-configure
 *   made the row due now and cleared the marker);
 * - receipt unfinished, or not inserted yet (`begin` has not run):
 *   `consumer_pending`, nothing written;
 * - receipt finished and the marker still there: the completion missed it,
 *   so it is applied here as the completion would (due now, or no next
 *   check on a paused row) and cleared: `made_due`;
 * - receipt finished and no marker: that completion, or another settle,
 *   already applied it: `made_due`, nothing written.
 *
 * Making the row due moves `nextCheckAt`, so it ends any lease a poll check
 * holds, as a finishing run does; the check that called this then
 * reschedules nothing, and the next tick re-checks.
 */
export async function settlePendingContextSyncHead(
	client: RepositorySyncTransactionRunner,
	input: {
		syncId: string;
		projectId: string;
		organizationId: string;
		generation: number;
		runId: string;
		now?: Date;
	},
): Promise<{
	applied: boolean;
	settled: RepositorySyncPendingHeadSettlement;
}> {
	return client.$transaction(async (tx) => {
		const locked = await tx.$queryRaw<
			Array<{
				automaticPausedReason: string | null;
				pendingCommitSha: string | null;
				now: Date;
			}>
		>`
			SELECT "automaticPausedReason", "pendingCommitSha", (clock_timestamp() AT TIME ZONE 'UTC') AS "now"
			FROM "project_context_repository_sync"
			WHERE "id" = ${input.syncId}
				AND "projectId" = ${input.projectId}
				AND "organizationId" = ${input.organizationId}
				AND "generation" = ${input.generation}
			FOR UPDATE
		`;
		const row = locked[0];
		if (row === undefined) {
			return { applied: false, settled: "stale" as const };
		}
		// Due now on the database's clock, read under the lock, so a caller
		// whose clock runs ahead cannot push the re-check out (Fizzy #2683).
		const now = input.now ?? row.now ?? new Date();
		const receipt = await tx.projectContextRepositorySyncRun.findFirst({
			where: {
				id: `${input.syncId}:${input.runId}`,
				syncId: input.syncId,
				projectId: input.projectId,
				organizationId: input.organizationId,
			},
			select: { finishedAt: true },
		});
		if (receipt === null || receipt.finishedAt === null) {
			return { applied: false, settled: "consumer_pending" as const };
		}
		if (row.pendingCommitSha === null) {
			return { applied: false, settled: "made_due" as const };
		}
		const { count } = await tx.projectContextRepositorySync.updateMany({
			where: {
				id: input.syncId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				generation: input.generation,
			},
			data: {
				nextCheckAt: row.automaticPausedReason === null ? now : null,
				pendingCommitSha: null,
			},
		});
		return { applied: count > 0, settled: "made_due" as const };
	});
}

/**
 * The scheduling patch for a finishing run, or a backoff when the effect is
 * one the shared module does not know (Fizzy #2687, mirrored from the
 * coding-instructions completion). `computeSchedulingPatch` throws on an
 * unknown kind so the mistake is never a silent no-op; but this runs inside
 * the completion transaction, and letting the throw escape would roll back
 * the receipt and fail every retry of the completion activity, leaving the
 * run unfinished. So the receipt still commits: the error is logged with
 * the kind, and the row backs off as a failed check would, which is the
 * safe side (a later check re-evaluates the head).
 */
function schedulingPatchOrBackoff(
	sync: { id: string; projectId: string; organizationId: string },
	effect: InstructionSyncSchedulingEffect,
	patchInput: Parameters<typeof computeSchedulingPatch>[1],
): RepositorySyncSchedulingPatch | null {
	try {
		return computeSchedulingPatch(effect, patchInput);
	} catch (error) {
		logger.error(
			{
				event: "contexts.sync.unknown_scheduling_effect",
				syncId: sync.id,
				projectId: sync.projectId,
				organizationId: sync.organizationId,
				kind: String((effect as { kind?: unknown }).kind),
				error: error instanceof Error ? error.message : String(error),
			},
			"[ContextSync] unknown scheduling effect at completion; backing off",
		);
		return computeSchedulingPatch({ kind: "backoff" }, patchInput);
	}
}

/**
 * Folds the row's re-check request (Fizzy #2673, the twin of the
 * coding-instructions `withPendingHead`) into a finishing run's scheduling
 * patch, under the row lock the caller already holds.
 *
 * - No marker: the patch as it is.
 * - A marker: the row is due now, whatever the effect scheduled (the `none`
 *   effect included), so the next poll tick checks the branch rather than
 *   the 15-minute schedule. Even when the marker's SHA equals this run's
 *   commit: deliveries are unordered, so an older head recorded after a
 *   newer one must not stand for both (see `recordPendingContextSyncHead`).
 * - A paused row, or a patch that pauses it: no next check at all, whatever
 *   the effect wrote. The poll never claims a paused row, and a paused row
 *   keeps no schedule.
 *
 * Every case with a marker clears it; the rest of the effect's patch stands.
 */
function withPendingHead(
	patch: RepositorySyncSchedulingPatch | null,
	row: {
		pendingCommitSha: string | null;
		automaticPausedReason: string | null;
	},
	now: Date,
): (RepositorySyncSchedulingPatch & { pendingCommitSha?: null }) | null {
	if (row.pendingCommitSha === null) {
		return patch;
	}
	const paused =
		row.automaticPausedReason !== null ||
		patch?.automaticPausedReason !== undefined;
	return {
		...patch,
		nextCheckAt: paused ? null : now,
		pendingCommitSha: null,
	};
}

/**
 * The scheduling effect of a finished run, or of a `begin` refusal (§5.4,
 * §11.1): the write `completeInstructionRepositorySyncRun` makes, without a
 * lease. The caller holds lock 1 (`sync` is the row it locked, with the
 * failure count, the pause and the re-check request read under that lock),
 * so nothing moves between the read and the write. Applied only while the
 * configuration is still at the run's `generation`: a re-configure reset the
 * schedule for the new one, which an older run must not overwrite. `none`
 * writes nothing unless a re-check request is there to fold.
 *
 * The re-check request a push or a poll left while this run was open
 * (`recordPendingContextSyncHead`) is applied and cleared here
 * (`withPendingHead`). A request written after this commits is applied by
 * `settlePendingContextSyncHead`, which finds this receipt finished. A run of
 * an older generation leaves it alone, like the rest of the schedule.
 *
 * The next check is dated on the database's clock the lock read returned
 * (`sync.now`, Fizzy #2683), so a worker whose clock drifts cannot schedule
 * a check that is already due or far out; a caller's `now` wins.
 *
 * Tenant-bound: the update names the locked row's project and organization
 * as well as its id.
 */
export async function writeContextRepositorySyncScheduling(
	tx: Prisma.TransactionClient,
	input: {
		sync: {
			id: string;
			projectId: string;
			organizationId: string;
			generation: number;
			failureCount: number;
			automaticPausedReason: string | null;
			pendingCommitSha: string | null;
			/** The database's clock, read under the lock. */
			now?: Date;
		};
		/** The run's generation, which the configuration must still carry. */
		generation: number;
		effect: InstructionSyncSchedulingEffect;
		now?: Date;
	},
): Promise<{ applied: boolean }> {
	if (input.sync.generation !== input.generation) {
		return { applied: false };
	}
	const now = input.now ?? input.sync.now ?? new Date();
	const data = withPendingHead(
		schedulingPatchOrBackoff(input.sync, input.effect, {
			now,
			failureCount: input.sync.failureCount,
			generation: input.generation,
		}),
		input.sync,
		now,
	);
	if (!data) {
		return { applied: false };
	}
	await tx.projectContextRepositorySync.update({
		where: {
			id: input.sync.id,
			projectId: input.sync.projectId,
			organizationId: input.sync.organizationId,
		},
		data,
	});
	return { applied: true };
}
