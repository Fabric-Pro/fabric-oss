/**
 * Coding Instructions repository sync: the configuration row, the run
 * receipts, and the one writer of `project.instructionSettings`
 * (design 2026-09-23 §4, §5.1, §5.4, §5.6).
 *
 * Configuration identity is `(id, generation)`. Every change that alters
 * what a run would produce, or whom it acts as, bumps `generation`, and
 * every durable effect of a run is conditioned on the pair it captured in
 * `begin`: the publish fence below, and the scheduling write in
 * `completeInstructionRepositorySyncRun`. Snapshot cleanup is NOT fenced; it
 * is keyed on the snapshot.
 */
import { db, Prisma } from "../client";
import type { ProjectInstructionSyncTrigger } from "../generated/client";
import { recordAuditTx } from "./audit-log";
import { canCreateProjectInstructions } from "./projects/projects";
import type {
	ClaimedRepositorySyncRow,
	RepositorySyncCheckFailure,
	RepositorySyncFence,
	RepositorySyncPushRow,
} from "./repository-sync-subjects";

/**
 * What started a run: the run row's `trigger` enum
 * (`ProjectInstructionSyncTrigger` in schema.prisma). Derived rather than
 * restated, so a value a later migration adds reaches every starter's type
 * with no edit here. Not everything but MANUAL is automatic: `begin` and
 * `deriveSyncRunOutcome` test membership in the fixed
 * `AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS` constant, so a trigger a later
 * migration adds is typed here but stays MANUAL-like for eligibility until
 * it is added to that constant (Decision 47).
 */
export type InstructionSyncTrigger = ProjectInstructionSyncTrigger;
export type InstructionSyncRunStatus =
	| "SUCCEEDED"
	| "UNCHANGED"
	| "NOT_PUBLISHED"
	| "REJECTED"
	| "FAILED"
	| "SKIPPED";
export type InstructionSyncError =
	| "NOT_CONFIGURED"
	| "INTEGRATION_UNAVAILABLE"
	| "PERMISSION_DENIED"
	| "REF_MISSING"
	| "ROOT_MISSING"
	| "LIMITS_EXCEEDED"
	| "CLONE_FAILED"
	| "STORAGE_FAILED"
	| "CHILD_ABORTED"
	| "CONFIGURATION_CHANGED"
	| "TREE_REFUSED";
export type InstructionSyncPause = "PERMISSION_REVOKED" | "REF_MISSING";
type SourceOfTruth = "UPLOAD" | "REPOSITORY";

/**
 * What a finished run, or a poll check, does to the configuration's
 * automatic-run schedule (spec §5.4, §6.1). `reschedule` is the poll's
 * "started a run" outcome: it only moves `nextCheckAt` by `delayMs`, leaving
 * the failure count and both cursors to the run's own completion
 * (Decisions 14 and 34).
 */
export type InstructionSyncSchedulingEffect =
	| { kind: "none" }
	| { kind: "reschedule"; delayMs: number }
	| { kind: "success"; commitSha: string | null }
	| { kind: "suppress"; commitSha: string | null }
	| { kind: "backoff" }
	| { kind: "pause"; reason: InstructionSyncPause };

type InstructionSettingsRecord = {
	ignoreGlobs?: string[] | null;
	sourceOfTruth?: SourceOfTruth | null;
	[key: string]: unknown;
};

/** The freshness target a successful or suppressed run schedules the next automatic check for. */
const NEXT_CHECK_AFTER_MS = 15 * 60 * 1000;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

/** `min(5 min × 2^failureCount, 6 h)`, with the count AFTER this failure was added. */
export function instructionSyncBackoffMs(failureCount: number): number {
	return Math.min(BACKOFF_BASE_MS * 2 ** failureCount, BACKOFF_MAX_MS);
}

function sameGlobs(
	a: readonly string[] | null,
	b: readonly string[] | null,
): boolean {
	if (a === null || b === null) {
		return a === b;
	}
	return a.length === b.length && a.every((glob, i) => glob === b[i]);
}

/**
 * The ONE writer of `project.instructionSettings`.
 *
 * Takes the project row's write lock first, so a mode flip, an ignore-rule
 * change and the publish fence (which reads the same column under the same
 * lock) are serialized rather than interleaved. `sourceOfTruth` is written
 * only by the sync configuration functions in this module; the settings
 * procedure exposes `ignoreGlobs` alone. An `ignoreGlobs` change bumps the
 * sync generation, clears the poll cursor and makes the sync due now,
 * because it changes what the next run would produce (spec §4.4, Decision 9).
 */
export async function writeProjectInstructionSettings(
	tx: Prisma.TransactionClient,
	projectId: string,
	organizationId: string,
	patch: { ignoreGlobs?: string[] | null; sourceOfTruth?: SourceOfTruth },
): Promise<{ written: boolean; syncGenerationBumped: boolean }> {
	const rows = await tx.$queryRaw<Array<{ instructionSettings: unknown }>>`
		SELECT "instructionSettings"
		FROM "project"
		WHERE "id" = ${projectId} AND "organizationId" = ${organizationId}
		FOR UPDATE
	`;
	const row = rows[0];
	if (row === undefined) {
		return { written: false, syncGenerationBumped: false };
	}
	const current: InstructionSettingsRecord =
		row.instructionSettings !== null &&
		typeof row.instructionSettings === "object" &&
		!Array.isArray(row.instructionSettings)
			? (row.instructionSettings as InstructionSettingsRecord)
			: {};
	await tx.project.update({
		where: { id: projectId, organizationId },
		data: {
			instructionSettings: {
				...current,
				...patch,
			} as Prisma.InputJsonValue,
		},
	});
	let syncGenerationBumped = false;
	if (
		patch.ignoreGlobs !== undefined &&
		!sameGlobs(current.ignoreGlobs ?? null, patch.ignoreGlobs)
	) {
		// Due now (Decision 9): a run in flight under the old generation will
		// land NOT_PUBLISHED, and the next poll tick must re-evaluate the head
		// under the new rules so its run replaces that line on the tab.
		const { count } = await tx.projectInstructionRepositorySync.updateMany({
			where: { projectId, organizationId },
			data: {
				generation: { increment: 1 },
				lastEvaluatedCommitSha: null,
				lastEvaluatedGeneration: null,
				nextCheckAt: new Date(),
			},
		});
		syncGenerationBumped = count > 0;
	}
	return { written: true, syncGenerationBumped };
}

/**
 * The publish fence for a snapshot a repository sync produced (spec §5.6),
 * evaluated inside `publishInstructionSnapshot`'s transaction, after it took
 * the project row lock. `null` means publish.
 *
 * Honest limit, as the spec states it: membership and role writes do not
 * take the project row lock, so a revocation that commits between this read
 * and the publish commit is not seen. The window is the transaction's.
 */
export async function repositorySyncPublishRefusal(
	tx: Prisma.TransactionClient,
	input: {
		projectId: string;
		organizationId: string;
		settingsFrozen: unknown;
		instructionSettings: unknown;
		actingUserId: string;
	},
): Promise<"configuration_changed" | "permission_revoked" | null> {
	const frozen =
		input.settingsFrozen !== null &&
		typeof input.settingsFrozen === "object"
			? (input.settingsFrozen as {
					syncId?: unknown;
					syncGeneration?: unknown;
				})
			: {};
	const settings =
		input.instructionSettings !== null &&
		typeof input.instructionSettings === "object"
			? (input.instructionSettings as { sourceOfTruth?: unknown })
			: {};
	if (
		typeof frozen.syncId !== "string" ||
		typeof frozen.syncGeneration !== "number" ||
		settings.sourceOfTruth !== "REPOSITORY"
	) {
		return "configuration_changed";
	}
	const sync = await tx.projectInstructionRepositorySync.findFirst({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId,
		},
		select: { id: true, generation: true },
	});
	if (
		!sync ||
		sync.id !== frozen.syncId ||
		sync.generation !== frozen.syncGeneration
	) {
		return "configuration_changed";
	}
	if (
		!(await canCreateProjectInstructions(
			input.projectId,
			input.actingUserId,
			tx,
		))
	) {
		return "permission_revoked";
	}
	return null;
}

const syncViewSelect = {
	id: true,
	projectId: true,
	organizationId: true,
	repositoryIntegrationId: true,
	ref: true,
	rootPath: true,
	automatic: true,
	generation: true,
	automaticPausedReason: true,
	automaticPausedAt: true,
	user: { select: { id: true, name: true } },
	repositoryIntegration: {
		select: {
			id: true,
			provider: true,
			repositoryOwner: true,
			repositoryName: true,
			defaultBranch: true,
			status: true,
		},
	},
} satisfies Prisma.ProjectInstructionRepositorySyncSelect;

/** Tenant-scoped read for the procedures. */
export function getInstructionRepositorySync(
	projectId: string,
	organizationId: string,
) {
	return db.projectInstructionRepositorySync.findFirst({
		where: { projectId, organizationId },
		select: syncViewSelect,
	});
}

/**
 * UNSCOPED by design: the sync workflow's `begin` has only the ids its
 * starter passed, and must compare the row's own `organizationId` with them
 * before it trusts anything else on the row.
 */
export function getInstructionRepositorySyncForRun(projectId: string) {
	return db.projectInstructionRepositorySync.findUnique({
		where: { projectId },
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
			repositoryIntegrationId: true,
			ref: true,
			rootPath: true,
			automatic: true,
			generation: true,
			automaticPausedReason: true,
			repositoryIntegration: {
				select: { id: true, projectId: true, status: true },
			},
		},
	});
}

/**
 * `configure` (spec §5.1): one transaction under the project row lock
 * creates or re-points the configuration, makes the caller its delegate,
 * bumps the generation, clears pause, suppression, the poll cursor and the
 * failure count, and flips the project to REPOSITORY. Run history is kept.
 * `automatic` is kept when omitted, and `false` on insert.
 */
export async function upsertInstructionRepositorySync(input: {
	projectId: string;
	organizationId: string;
	userId: string;
	repositoryIntegrationId: string;
	ref: string;
	rootPath: string;
	automatic?: boolean;
}) {
	return db.$transaction(async (tx) => {
		const written = await writeProjectInstructionSettings(
			tx,
			input.projectId,
			input.organizationId,
			{ sourceOfTruth: "REPOSITORY" },
		);
		if (!written.written) {
			return null;
		}
		const existing = await tx.projectInstructionRepositorySync.findFirst({
			where: {
				projectId: input.projectId,
				organizationId: input.organizationId,
			},
			select: {
				id: true,
				ref: true,
				rootPath: true,
				repositoryIntegrationId: true,
				automatic: true,
			},
		});
		const reset = {
			automaticPausedReason: null,
			automaticPausedAt: null,
			suppressedCommitSha: null,
			suppressedGeneration: null,
			lastEvaluatedCommitSha: null,
			lastEvaluatedGeneration: null,
			failureCount: 0,
			nextCheckAt: new Date(),
		};
		const select = {
			id: true,
			generation: true,
			ref: true,
			rootPath: true,
			automatic: true,
		} as const;
		const sync = existing
			? await tx.projectInstructionRepositorySync.update({
					where: { id: existing.id },
					data: {
						userId: input.userId,
						repositoryIntegrationId: input.repositoryIntegrationId,
						ref: input.ref,
						rootPath: input.rootPath,
						automatic: input.automatic ?? existing.automatic,
						generation: { increment: 1 },
						...reset,
					},
					select,
				})
			: await tx.projectInstructionRepositorySync.create({
					data: {
						projectId: input.projectId,
						organizationId: input.organizationId,
						userId: input.userId,
						repositoryIntegrationId: input.repositoryIntegrationId,
						ref: input.ref,
						rootPath: input.rootPath,
						automatic: input.automatic ?? false,
						...reset,
					},
					select,
				});
		return {
			sync,
			previous: existing
				? {
						ref: existing.ref,
						rootPath: existing.rootPath,
						repositoryIntegrationId:
							existing.repositoryIntegrationId,
					}
				: null,
		};
	});
}

/**
 * `disable` / "Switch to upload mode" (spec §5.1, §7.4). Flips to UPLOAD even
 * when no row exists, which is the "Repository disconnected" recovery.
 * Not refused while a run is in flight: that run is fenced instead.
 */
export async function deleteInstructionRepositorySync(input: {
	projectId: string;
	organizationId: string;
}): Promise<{
	deleted: boolean;
	repositoryIntegrationId: string | null;
} | null> {
	return db.$transaction(async (tx) => {
		const written = await writeProjectInstructionSettings(
			tx,
			input.projectId,
			input.organizationId,
			{ sourceOfTruth: "UPLOAD" },
		);
		if (!written.written) {
			return null;
		}
		const existing = await tx.projectInstructionRepositorySync.findFirst({
			where: {
				projectId: input.projectId,
				organizationId: input.organizationId,
			},
			select: { id: true, repositoryIntegrationId: true },
		});
		if (existing) {
			await tx.projectInstructionRepositorySync.delete({
				where: { id: existing.id },
			});
		}
		return {
			deleted: existing !== null,
			repositoryIntegrationId: existing?.repositoryIntegrationId ?? null,
		};
	});
}

/**
 * The coding-instructions half of the repository-integration disconnect
 * (spec §5.1): when the integration being removed is the project's
 * instruction source, the sync row goes and the project flips to UPLOAD in
 * the caller's transaction, so both commit with the integration delete. The
 * FK cascade would remove the row anyway; doing it explicitly is what keeps
 * the mode flip atomic with it.
 *
 * ASSUMES the caller already holds the project row lock, so a concurrent
 * `configure` cannot attach the integration between the read below and the
 * delete. `deleteRepoIntegrationReleasingSyncs`
 * (`./projects/repository-integration-disconnect`) is the caller.
 */
export async function releaseInstructionRepositorySyncForIntegration(
	tx: Prisma.TransactionClient,
	input: { integrationId: string; projectId: string },
): Promise<{ organizationId: string } | null> {
	const sync = await tx.projectInstructionRepositorySync.findFirst({
		where: {
			projectId: input.projectId,
			repositoryIntegrationId: input.integrationId,
		},
		select: { id: true, organizationId: true },
	});
	if (!sync) {
		return null;
	}
	await writeProjectInstructionSettings(
		tx,
		input.projectId,
		sync.organizationId,
		{
			sourceOfTruth: "UPLOAD",
		},
	);
	await tx.projectInstructionRepositorySync.delete({
		where: { id: sync.id },
	});
	return { organizationId: sync.organizationId };
}

/**
 * `begin`'s receipt (spec §4.1a): inserted once per logical run, keyed by the
 * run key. A retried `begin` leaves the stored row alone and learns the
 * generation it was first inserted under.
 */
export async function insertInstructionRepositorySyncRun(input: {
	id: string;
	syncId: string;
	projectId: string;
	organizationId: string;
	userId: string;
	generation: number;
	trigger: InstructionSyncTrigger;
	startedAt: Date;
}): Promise<{ inserted: boolean; generation: number }> {
	const { count } = await db.projectInstructionRepositorySyncRun.createMany({
		data: [input],
		skipDuplicates: true,
	});
	if (count === 1) {
		return { inserted: true, generation: input.generation };
	}
	const existing = await db.projectInstructionRepositorySyncRun.findUnique({
		where: { id: input.id },
		select: { generation: true },
	});
	return {
		inserted: false,
		generation: existing?.generation ?? input.generation,
	};
}

/**
 * One run receipt by its run key, tenant-scoped. `record` reads it when the
 * workflow never learned `begin`'s context (begin failed or was cancelled
 * after inserting the receipt), to complete the receipt under the acting
 * user and generation it was inserted with rather than the configuration's
 * current ones.
 */
export function getInstructionRepositorySyncRunReceipt(
	runKey: string,
	projectId: string,
	organizationId: string,
) {
	return db.projectInstructionRepositorySyncRun.findFirst({
		where: { id: runKey, projectId, organizationId },
		select: {
			syncId: true,
			userId: true,
			generation: true,
			trigger: true,
			finishedAt: true,
		},
	});
}

/**
 * The columns a scheduling effect writes (Decision 46): only the column
 * contract every repository-sync subject's table carries, so any subject's
 * fenced writer can apply it.
 */
export type RepositorySyncSchedulingPatch = {
	/** Null clears the schedule: a paused row has no next check. */
	nextCheckAt?: Date | null;
	failureCount?: number;
	automaticPausedReason?: InstructionSyncPause;
	automaticPausedAt?: Date;
	suppressedCommitSha?: string | null;
	suppressedGeneration?: number;
	lastEvaluatedCommitSha?: string;
	lastEvaluatedGeneration?: number;
};

type SchedulingPatchInput = {
	now: Date;
	/** The failure count read under the same fence as the write. */
	failureCount: number;
	/** The generation the effect belongs to; the cursors record it. */
	generation: number;
};

/**
 * What one scheduling effect writes (spec §5.4, §6.1). Pure: no I/O. A
 * finishing run passes the failure count it read under the row lock; a poll
 * check passes the one its claim returned, which is the stored one while its
 * lease holds (Decision 31). Every effect but `none` writes something.
 */
export function computeSchedulingPatch(
	effect: Exclude<InstructionSyncSchedulingEffect, { kind: "none" }>,
	input: SchedulingPatchInput,
): RepositorySyncSchedulingPatch;
export function computeSchedulingPatch(
	effect: InstructionSyncSchedulingEffect,
	input: SchedulingPatchInput,
): RepositorySyncSchedulingPatch | null;
export function computeSchedulingPatch(
	effect: InstructionSyncSchedulingEffect,
	{ now, failureCount, generation }: SchedulingPatchInput,
): RepositorySyncSchedulingPatch | null {
	const nextCheckAt = new Date(now.getTime() + NEXT_CHECK_AFTER_MS);
	switch (effect.kind) {
		case "none":
			return null;
		case "reschedule":
			return { nextCheckAt: new Date(now.getTime() + effect.delayMs) };
		case "success":
			return {
				failureCount: 0,
				nextCheckAt,
				...(effect.commitSha
					? {
							lastEvaluatedCommitSha: effect.commitSha,
							lastEvaluatedGeneration: generation,
						}
					: {}),
			};
		case "suppress":
			return {
				failureCount: 0,
				nextCheckAt,
				suppressedCommitSha: effect.commitSha,
				suppressedGeneration: generation,
			};
		case "backoff": {
			const next = failureCount + 1;
			return {
				failureCount: next,
				nextCheckAt: new Date(
					now.getTime() + instructionSyncBackoffMs(next),
				),
			};
		}
		case "pause":
			// No next check while paused: the claim wrote its lease into
			// `nextCheckAt`, and leaving that behind reads as an overdue check
			// on a row nothing will claim. A re-configure sets it due again.
			return {
				nextCheckAt: null,
				automaticPausedReason: effect.reason,
				automaticPausedAt: now,
			};
	}
}

/**
 * The instructions subject's claim (spec §6.1; Decisions 31 and 46).
 * CROSS-TENANT by design, like the snapshot reaper: the schedule has no
 * tenant context. Every row it returns carries its own `organizationId`, and
 * every later read and write names that one row.
 *
 * One statement selects due rows (automatic on, not paused, `nextCheckAt`
 * reached, integration ACTIVE), oldest due first, and leases them by moving
 * `nextCheckAt` to the caller's `leaseUntil`. A lease that is never
 * processed (budget ran out, tick crashed) comes due again at the front of
 * the order, ahead of every row a finished check moved 15 minutes out.
 *
 * `FOR UPDATE OF s2 SKIP LOCKED` makes two overlapping claims take disjoint
 * rows rather than wait. `= ANY (ARRAY(subquery))` evaluates the locking
 * subquery once, as in `PUBLISHING_NULL_CLOCK_ENROL_SQL`
 * (projects/publishing-notification-reconcile.ts); an `IN (subquery)` may be
 * planned as a join that re-runs it. adapter-pg sends a Date as UTC, which
 * matches the TIMESTAMP(3) columns. `RETURNING` reads the written value back
 * as `leaseUntil`, the lease every later write compares with.
 */
export async function claimDueInstructionSyncRows(
	tx: Prisma.TransactionClient,
	input: { limit: number; leaseUntil: Date; now?: Date },
): Promise<ClaimedRepositorySyncRow[]> {
	const now = input.now ?? new Date();
	return tx.$queryRaw<ClaimedRepositorySyncRow[]>`
		UPDATE "project_instruction_repository_sync" AS s
		SET "nextCheckAt" = ${input.leaseUntil}
		WHERE s."id" = ANY (ARRAY(
			SELECT s2."id"
			FROM "project_instruction_repository_sync" AS s2
			JOIN "project_repository_integration" AS i
				ON i."id" = s2."repositoryIntegrationId"
			WHERE s2."automatic" = true
				AND s2."automaticPausedReason" IS NULL
				AND s2."nextCheckAt" <= ${now}
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
 * The lease a claim handed out, as one SQL condition (Decisions 31 and 48):
 * the row still carries the claimed generation and the `nextCheckAt` the
 * claim wrote, that `nextCheckAt` is still ahead of the database's clock,
 * and automatic sync is still on and unpaused.
 *
 * Every writer that competes with a check moves one of these: a later claim
 * and every finishing run move `nextCheckAt` to a value computed from their
 * own clock, a re-configure or settings change bumps the generation, a pause
 * sets `automaticPausedReason` and clears `nextCheckAt`, and turning
 * automatic sync off clears
 * `automatic`. A lease nobody else touched ends by the clock alone. Two
 * claims of one row never write the same lease: a row is re-claimable only
 * once its lease has passed, and the next claim's lease is its own `now`
 * plus two minutes.
 *
 * The clock is Postgres's, never a JS `Date`, so a worker whose clock runs
 * behind the database's cannot stretch a lease. `clock_timestamp()` rather
 * than `now()`, which is the transaction's start and would stand still
 * inside the receipt's transaction; `AT TIME ZONE 'UTC'` because the columns
 * are `timestamp without time zone` holding UTC. Both as in
 * `publishingEmailClaimableSql` (projects/publishing-notification-delivery.ts).
 *
 * No tenant arm: the id comes only from the server-side claim, never from a
 * request, and names exactly one row.
 */
function leaseFenceSql(fence: RepositorySyncFence): Prisma.Sql {
	return Prisma.sql`"id" = ${fence.id}
		AND "generation" = ${fence.generation}
		AND "nextCheckAt" = ${fence.leaseUntil}
		AND "nextCheckAt" > (clock_timestamp() AT TIME ZONE 'UTC')
		AND "automatic" = true
		AND "automaticPausedReason" IS NULL`;
}

/**
 * The columns a patch names, as `SET` assignments in a fixed order, then
 * `updatedAt` from the database's clock, because a raw UPDATE bypasses
 * Prisma's `@updatedAt`. Only the column contract (Decision 46) can appear.
 */
function patchAssignments(patch: RepositorySyncSchedulingPatch): Prisma.Sql[] {
	const set: Prisma.Sql[] = [];
	if (patch.nextCheckAt !== undefined) {
		set.push(Prisma.sql`"nextCheckAt" = ${patch.nextCheckAt}`);
	}
	if (patch.failureCount !== undefined) {
		set.push(Prisma.sql`"failureCount" = ${patch.failureCount}`);
	}
	if (patch.automaticPausedReason !== undefined) {
		set.push(
			Prisma.sql`"automaticPausedReason" = ${patch.automaticPausedReason}::"ProjectInstructionSyncPause"`,
		);
	}
	if (patch.automaticPausedAt !== undefined) {
		set.push(Prisma.sql`"automaticPausedAt" = ${patch.automaticPausedAt}`);
	}
	if (patch.suppressedCommitSha !== undefined) {
		set.push(
			Prisma.sql`"suppressedCommitSha" = ${patch.suppressedCommitSha}`,
		);
	}
	if (patch.suppressedGeneration !== undefined) {
		set.push(
			Prisma.sql`"suppressedGeneration" = ${patch.suppressedGeneration}`,
		);
	}
	if (patch.lastEvaluatedCommitSha !== undefined) {
		set.push(
			Prisma.sql`"lastEvaluatedCommitSha" = ${patch.lastEvaluatedCommitSha}`,
		);
	}
	if (patch.lastEvaluatedGeneration !== undefined) {
		set.push(
			Prisma.sql`"lastEvaluatedGeneration" = ${patch.lastEvaluatedGeneration}`,
		);
	}
	set.push(Prisma.sql`"updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')`);
	return set;
}

/**
 * An unlocked read of the lease (Decisions 31 and 48), for a check's early
 * exits: before it touches the repository, and again just before it starts
 * a run. The writes below send the same fence in their own `WHERE`.
 */
export async function instructionSyncLeaseHeld(
	tx: Prisma.TransactionClient,
	fence: RepositorySyncFence,
): Promise<boolean> {
	const rows = await tx.$queryRaw<{ id: string }[]>(
		Prisma.sql`SELECT "id" FROM "project_instruction_repository_sync" WHERE ${leaseFenceSql(fence)}`,
	);
	return rows.length > 0;
}

/**
 * The poll's fenced write (spec §6.1; Decisions 2, 31, 46 and 48): one
 * conditional UPDATE that applies `patch` only while the check still holds
 * its lease. A check that outlived its lease (by the database's clock,
 * whether or not anything else touched the row), lost a race with a
 * finishing run, or finished after a re-configure, a pause or turning
 * automatic sync off writes nothing. A finishing run that holds the row
 * lock makes this wait, and Postgres then re-checks the `WHERE` against the
 * row that run left, so the two serialise on the row.
 *
 * Backoff counts from the failure count the claim returned. While the lease
 * holds that is the stored count, because every writer of `failureCount`
 * also moves `nextCheckAt` or the generation.
 */
export async function writeBackInstructionSync(
	tx: Prisma.TransactionClient,
	fence: RepositorySyncFence,
	patch: RepositorySyncSchedulingPatch,
): Promise<{ applied: boolean }> {
	const count = await tx.$executeRaw(
		Prisma.sql`UPDATE "project_instruction_repository_sync"
			SET ${Prisma.join(patchAssignments(patch), ", ")}
			WHERE ${leaseFenceSql(fence)}`,
	);
	return { applied: count > 0 };
}

/**
 * A poll check's terminal receipt (spec §6.1; Decisions 33, 35 and 46): a
 * deleted branch (REF_MISSING) or a delegate who lost `INSTRUCTION_CREATE`
 * (PERMISSION_DENIED). Call it inside a transaction: the pause, the FAILED
 * POLL run row and the same `repository_sync_completed` audit row
 * `completeInstructionRepositorySyncRun` writes then commit together, so no
 * receipt is left half recorded.
 *
 * The pause is the fenced write, and it goes first. A check that lost its
 * lease writes nothing, and once the pause lands the lease is gone, so a
 * retried call writes nothing either. The run key is
 * `<syncId>:<pollRunId>:<generation>`, not PR 1's `<syncId>:<workflow run id>`:
 * one poll run can claim the same sync again after a re-configure within its
 * budget, and each claim's receipt must be its own row.
 */
export async function recordInstructionSyncCheckFailure(
	tx: Prisma.TransactionClient,
	input: RepositorySyncCheckFailure,
): Promise<{ applied: boolean }> {
	const now = input.now ?? new Date();
	const { row } = input;
	const { applied } = await writeBackInstructionSync(
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
	await tx.projectInstructionRepositorySyncRun.createMany({
		data: [
			{
				id: `${row.id}:${input.pollRunId}:${row.generation}`,
				syncId: row.id,
				projectId: row.projectId,
				organizationId: row.organizationId,
				userId: row.userId,
				generation: row.generation,
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
	await recordAuditTx(tx, {
		action: "project.instructions.repository_sync_completed",
		category: "project",
		severity: "warning",
		outcome: "failure",
		actor: { type: "user", userId: row.userId },
		organizationId: row.organizationId,
		projectId: row.projectId,
		resource: {
			type: "project_instruction_repository_sync",
			id: row.id,
		},
		metadata: {
			trigger: "POLL",
			status: "FAILED",
			error: input.error,
			note: null,
			commitSha: null,
			snapshotId: null,
			generation: row.generation,
		},
	});
	return { applied: true };
}

/**
 * The instructions subject's push lookup (spec §6.2; Decisions 22 and 46):
 * every sync that follows `ref` on an ACTIVE integration of the pushed
 * repository, oldest first. UNSCOPED by design, like the webhook itself:
 * tenant context comes only from rows. A row counts only when its
 * integration belongs to the row's own project and organization
 * (Review Focus 1), so no push reaches a sync through another tenant's
 * integration of the same repository.
 */
export async function findInstructionSyncsForPush(input: {
	repositoryUrl: string;
	ref: string;
}): Promise<RepositorySyncPushRow[]> {
	const rows = await db.projectInstructionRepositorySync.findMany({
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
 * `record`'s Part B (spec §5.4): locks the sync row FIRST, tenant-scoped,
 * before touching the run row — the same order `deleteInstructionRepositorySync`
 * and `releaseInstructionRepositorySyncForIntegration` use when they lock the
 * sync row and then cascade-delete its run rows. Locking the run row first
 * (as this used to) is the opposite order: a disable or disconnect racing a
 * completion can then deadlock, Postgres aborting one side with `40P01`
 * (design review B1). The lock query carries no generation predicate — the
 * row is locked whether or not its generation still matches — so the
 * `(syncId, generation)` fence is a comparison in code once the row (and its
 * `failureCount`) is in hand, and it is tenant-scoped: the caller's `syncId`
 * alone does not prove it belongs to this project and organization (design
 * review B2).
 *
 * Completes the run row once (`WHERE finishedAt IS NULL`); only the call
 * that completed it applies the scheduling effect and writes the audit row,
 * all in one transaction. A second delivery, or a late attempt of a
 * terminated workflow, matches nothing on the run row and writes nothing
 * beyond the sync-row lock.
 */
export async function completeInstructionRepositorySyncRun(input: {
	runKey: string;
	syncId: string;
	generation: number;
	projectId: string;
	organizationId: string;
	userId: string;
	trigger: InstructionSyncTrigger;
	status: InstructionSyncRunStatus;
	error: InstructionSyncError | null;
	note: "superseded" | null;
	commitSha: string | null;
	snapshotId: string | null;
	scheduling: InstructionSyncSchedulingEffect;
	now?: Date;
}): Promise<{ completed: boolean; configurationCurrent: boolean }> {
	const now = input.now ?? new Date();
	return db.$transaction(async (tx) => {
		const locked = await tx.$queryRaw<
			Array<{ generation: number; failureCount: number }>
		>`
			SELECT "generation", "failureCount"
			FROM "project_instruction_repository_sync"
			WHERE "id" = ${input.syncId}
				AND "projectId" = ${input.projectId}
				AND "organizationId" = ${input.organizationId}
			FOR UPDATE
		`;
		const { count } =
			await tx.projectInstructionRepositorySyncRun.updateMany({
				where: {
					id: input.runKey,
					projectId: input.projectId,
					organizationId: input.organizationId,
					finishedAt: null,
				},
				data: {
					finishedAt: now,
					status: input.status,
					error: input.error,
					note: input.note,
					commitSha: input.commitSha,
					snapshotId: input.snapshotId,
				},
			});
		if (count === 0) {
			return { completed: false, configurationCurrent: false };
		}
		const current = locked[0];
		const configurationCurrent =
			current !== undefined && current.generation === input.generation;
		if (configurationCurrent && current !== undefined) {
			const data = computeSchedulingPatch(input.scheduling, {
				now,
				failureCount: current.failureCount,
				generation: input.generation,
			});
			if (data) {
				await tx.projectInstructionRepositorySync.update({
					where: {
						id: input.syncId,
						projectId: input.projectId,
						organizationId: input.organizationId,
					},
					data,
				});
			}
		}
		const failed = input.status === "FAILED" || input.status === "REJECTED";
		await recordAuditTx(tx, {
			action: "project.instructions.repository_sync_completed",
			category: "project",
			severity: failed ? "warning" : "info",
			outcome: failed ? "failure" : "success",
			actor: { type: "user", userId: input.userId },
			organizationId: input.organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_repository_sync",
				id: input.syncId,
			},
			metadata: {
				trigger: input.trigger,
				status: input.status,
				error: input.error,
				note: input.note,
				commitSha: input.commitSha,
				snapshotId: input.snapshotId,
				generation: input.generation,
			},
		});
		return { completed: true, configurationCurrent };
	});
}

const runSelect = {
	id: true,
	trigger: true,
	generation: true,
	startedAt: true,
	finishedAt: true,
	status: true,
	error: true,
	note: true,
	commitSha: true,
	snapshotId: true,
	user: { select: { id: true, name: true } },
} satisfies Prisma.ProjectInstructionRepositorySyncRunSelect;

/** History's "Sync runs" list, newest first, each with the version it produced (null when pruned or none). */
export async function listInstructionRepositorySyncRuns(
	projectId: string,
	organizationId: string,
	limit: number,
) {
	const runs = await db.projectInstructionRepositorySyncRun.findMany({
		where: { projectId, organizationId },
		orderBy: { startedAt: "desc" },
		take: limit,
		select: runSelect,
	});
	const ids = [
		...new Set(
			runs
				.map((r) => r.snapshotId)
				.filter((id): id is string => id !== null),
		),
	];
	const versions =
		ids.length === 0
			? []
			: await db.projectInstructionSnapshot.findMany({
					where: { id: { in: ids }, projectId, organizationId },
					select: { id: true, version: true },
				});
	const byId = new Map(versions.map((v) => [v.id, v.version]));
	return runs.map((run) => ({
		...run,
		snapshotVersion: run.snapshotId
			? (byId.get(run.snapshotId) ?? null)
			: null,
	}));
}

/** The tab's "last run": the newest row by `startedAt`, so a late old attempt never masks a newer run. */
export async function getLatestInstructionRepositorySyncRun(
	projectId: string,
	organizationId: string,
) {
	const [latest] = await listInstructionRepositorySyncRuns(
		projectId,
		organizationId,
		1,
	);
	return latest ?? null;
}

/** The published tree, for the unchanged-by-SHA and tree-equality checks (spec §5.3.2 steps 4, 10). */
export async function getPublishedInstructionTree(
	projectId: string,
	organizationId: string,
) {
	const project = await db.project.findFirst({
		where: { id: projectId, organizationId },
		select: {
			publishedInstructionSnapshot: {
				select: {
					id: true,
					projectId: true,
					organizationId: true,
					sourceCommitSha: true,
					settingsFrozen: true,
					files: { select: { path: true, sha256: true, mode: true } },
				},
			},
		},
	});
	const snapshot = project?.publishedInstructionSnapshot;
	// The pointer is an FK to a snapshot id alone; bind it back to this tenant.
	if (
		!snapshot ||
		snapshot.projectId !== projectId ||
		snapshot.organizationId !== organizationId
	) {
		return null;
	}
	return {
		snapshotId: snapshot.id,
		sourceCommitSha: snapshot.sourceCommitSha,
		settingsFrozen: snapshot.settingsFrozen,
		files: snapshot.files,
	};
}

/** The one snapshot a logical sync run may own (spec §5.3.2 step 1). */
export function getInstructionSnapshotBySyncRunKey(
	syncRunKey: string,
	projectId: string,
	organizationId: string,
) {
	return db.projectInstructionSnapshot.findFirst({
		where: { syncRunKey, projectId, organizationId },
		select: {
			id: true,
			version: true,
			status: true,
			sourceCommitSha: true,
			files: {
				select: {
					id: true,
					path: true,
					sha256: true,
					mode: true,
					size: true,
					storageKey: true,
					mimeType: true,
				},
			},
		},
	});
}
