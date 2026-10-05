/**
 * The writes of a move from uploads into a repository (Fizzy #2878 §9): start
 * it, attach its proposal, complete it when its pull request merged, abandon
 * it, and close it out once the first sync from the repository succeeded.
 *
 * Every one runs in a transaction that takes the project row's lock FIRST
 * (`FOR NO KEY UPDATE`, as `writeProjectInstructionSettings` does) and the sync
 * row's after it, the order `upsertInstructionRepositorySync` documents:
 * transactions that hold the sync row first and then insert a row carrying a
 * project foreign key (a finishing run's completion, a branch join) take only
 * `FOR KEY SHARE` on the project, which this lock does not conflict with, so
 * no cycle forms. They are also idempotent: a repeated call finds the pointer
 * already moved or gone and writes nothing, which is what lets the branch
 * settlement and the sync's `record` step retry them freely.
 *
 * The pointer itself and its states are in `./instruction-migration-pointer`.
 */
import { db, type Prisma } from "../client";
import { recordAuditTx } from "./audit-log";
import {
	type InstructionMigrationPointer,
	migrationOfSettings,
} from "./instruction-migration-pointer";
import { transitionBranch } from "./instruction-proposal-branches";
import {
	upsertInstructionRepositorySyncWithin,
	writeProjectInstructionSettings,
} from "./instruction-repository-sync";

type Tenant = { projectId: string; organizationId: string };

type LockedProject = {
	instructionSettings: unknown;
	publishedInstructionSnapshotId: string | null;
};

/** The project row under `FOR NO KEY UPDATE`, or null when it is not in this tenant. */
async function lockProject(
	tx: Prisma.TransactionClient,
	i: Tenant,
): Promise<LockedProject | null> {
	const [row] = await tx.$queryRaw<LockedProject[]>`
		SELECT "instructionSettings", "publishedInstructionSnapshotId"
		FROM "project"
		WHERE "id" = ${i.projectId} AND "organizationId" = ${i.organizationId}
		FOR NO KEY UPDATE
	`;
	return row ?? null;
}

/**
 * Whether the move's proposal is on `branchId`: the pointer's own `branchId`,
 * or, where the proposal has since moved to another branch (a start over
 * rehomes it) or the pointer has not recorded one yet, the branch the proposal
 * row says it is on now. The proposal row is the truth; the pointer's branch
 * is a note of where it started.
 */
async function moveIsOnBranch(
	client: Pick<Prisma.TransactionClient, "projectInstructionSnapshot">,
	pointer: InstructionMigrationPointer,
	i: Tenant & { branchId: string },
): Promise<boolean> {
	if (pointer.branchId === i.branchId) {
		return true;
	}
	if (pointer.snapshotId === null) {
		return false;
	}
	return (
		(await client.projectInstructionSnapshot.count({
			where: {
				id: pointer.snapshotId,
				projectId: i.projectId,
				organizationId: i.organizationId,
				proposalBranchId: i.branchId,
			},
		})) > 0
	);
}

/**
 * The pointer of the project's open move when its proposal is on `branchId`
 * (see `moveIsOnBranch`), else null. A read with no lock: the step that asks
 * is one of many that have nothing to do with a move.
 */
export async function getOpenMigrationOfBranch(
	i: Tenant & { branchId: string },
): Promise<InstructionMigrationPointer | null> {
	const project = await db.project.findFirst({
		where: { id: i.projectId, organizationId: i.organizationId },
		select: { instructionSettings: true },
	});
	const pointer = migrationOfSettings(project?.instructionSettings);
	if (pointer === null) {
		return null;
	}
	return (await moveIsOnBranch(db, pointer, i)) ? pointer : null;
}

/**
 * Makes a move's branch due now: a branch still opening whose last step failed
 * waits out a backoff before the workflow tries again, and a member who fixed
 * the cause (a permission, a protection rule) should not have to wait for it.
 * Only `PENDING` and `OPENING` at the attempt the caller read; `false` when
 * the branch moved first. The branch's failure and attempt are left alone: the
 * next step either clears the failure by succeeding or records the next one.
 */
export async function expediteMigrationBranch(i: {
	branchId: string;
	organizationId: string;
	expectedAttempt: number;
}): Promise<boolean> {
	const [clock] = await db.$queryRaw<Array<{ now: Date }>>`
		SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS "now"
	`;
	const moved = await transitionBranch({
		branchId: i.branchId,
		organizationId: i.organizationId,
		from: ["PENDING", "OPENING"],
		expectedAttempt: i.expectedAttempt,
		to: "unchanged",
		bumpAttempt: false,
		data: { nextAttemptAt: clock?.now ?? new Date() },
	});
	return moved.ok;
}

function sourceOfTruthOf(settings: unknown): unknown {
	return settings !== null &&
		typeof settings === "object" &&
		!Array.isArray(settings)
		? (settings as { sourceOfTruth?: unknown }).sourceOfTruth
		: null;
}

export type StartInstructionMigrationRefusal =
	| "project_not_found"
	/** `sourceOfTruth` is REPOSITORY already. */
	| "not_upload_sourced"
	/** A move is already open for this project. */
	| "migration_open"
	/** Nothing is published, so there is nothing to move. */
	| "nothing_published"
	/** A sync row exists although the project is not repository-backed. */
	| "sync_exists";

/**
 * Starts a move: under the project's lock, refuses unless the project is
 * upload-backed with something published and no move open, then creates the
 * repository sync row for the destination (`keepSourceOfTruth`: uploads stay
 * the source; `automatic` on; paused `MIGRATING` so nothing syncs from the
 * folder until the pull request merges) and the `PROPOSING` pointer, in one
 * transaction. The caller becomes the sync's delegate.
 */
export async function startInstructionMigration(
	input: Tenant & {
		userId: string;
		repositoryIntegrationId: string;
		ref: string;
		rootPath: string;
	},
): Promise<
	| {
			ok: true;
			sync: { id: string; generation: number };
			pointer: InstructionMigrationPointer;
			publishedSnapshotId: string;
	  }
	| { ok: false; reason: StartInstructionMigrationRefusal }
> {
	return db.$transaction(async (tx) => {
		const locked = await lockProject(tx, input);
		if (locked === null) {
			return { ok: false, reason: "project_not_found" } as const;
		}
		if (migrationOfSettings(locked.instructionSettings) !== null) {
			return { ok: false, reason: "migration_open" } as const;
		}
		if (sourceOfTruthOf(locked.instructionSettings) === "REPOSITORY") {
			return { ok: false, reason: "not_upload_sourced" } as const;
		}
		if (locked.publishedInstructionSnapshotId === null) {
			return { ok: false, reason: "nothing_published" } as const;
		}
		const existing = await tx.projectInstructionRepositorySync.count({
			where: {
				projectId: input.projectId,
				organizationId: input.organizationId,
			},
		});
		if (existing > 0) {
			return { ok: false, reason: "sync_exists" } as const;
		}
		const upserted = await upsertInstructionRepositorySyncWithin(tx, {
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			repositoryIntegrationId: input.repositoryIntegrationId,
			ref: input.ref,
			rootPath: input.rootPath,
			automatic: true,
			keepSourceOfTruth: true,
			automaticPausedReason: "MIGRATING",
		});
		if (upserted === null) {
			return { ok: false, reason: "project_not_found" } as const;
		}
		const pointer: InstructionMigrationPointer = {
			v: 1,
			state: "PROPOSING",
			branchId: null,
			snapshotId: null,
			syncId: upserted.sync.id,
			pullRequestUrl: null,
			startedAt: new Date().toISOString(),
			userId: input.userId,
		};
		await writeProjectInstructionSettings(
			tx,
			input.projectId,
			input.organizationId,
			{ migration: pointer },
		);
		return {
			ok: true,
			sync: {
				id: upserted.sync.id,
				generation: upserted.sync.generation,
			},
			pointer,
			publishedSnapshotId: locked.publishedInstructionSnapshotId,
		} as const;
	});
}

/**
 * Records the move's proposal snapshot and, once it has joined one, its
 * member branch on the pointer. Only a `PROPOSING` pointer for `syncId` is
 * written; anything else (the move was abandoned meanwhile) is `false`, and
 * the caller closes out what it created.
 */
export async function attachInstructionMigrationProposal(
	input: Tenant & {
		syncId: string;
		snapshotId?: string;
		branchId?: string;
	},
): Promise<boolean> {
	return db.$transaction(async (tx) => {
		const locked = await lockProject(tx, input);
		const pointer = migrationOfSettings(locked?.instructionSettings);
		if (
			pointer === null ||
			pointer.syncId !== input.syncId ||
			pointer.state !== "PROPOSING"
		) {
			return false;
		}
		await writeProjectInstructionSettings(
			tx,
			input.projectId,
			input.organizationId,
			{
				migration: {
					...pointer,
					snapshotId: input.snapshotId ?? pointer.snapshotId,
					branchId: input.branchId ?? pointer.branchId,
				},
			},
		);
		return true;
	});
}

export type InstructionMigrationAbandonReason =
	/** The admin canceled it. */
	| "canceled"
	/** Its pull request was closed without merging, or merged elsewhere. */
	| "pull_request_closed"
	/** It could not get as far as a proposal: nothing to report. */
	| "start_failed";

export type AbandonInstructionMigrationResult =
	/** The move was ended by this call. */
	| "abandoned"
	/** No open move names this sync row (ended already, or never opened): nothing to do. */
	| "not_applicable"
	/**
	 * The project is repository-backed although its move is still `PROPOSING`
	 * (something flipped it behind the move's back). The sync row now belongs
	 * to whatever flipped it, so it is NOT deleted and the pointer is left in
	 * place: the move reads `BLOCKED` (`SOURCE_FLIPPED`) and "switch to upload
	 * mode" is the way out.
	 */
	| "source_flipped";

/**
 * Ends a move that did not happen: under the project's lock, for a
 * `PROPOSING` pointer naming `syncId`, deletes the sync row WITHOUT the
 * UPLOAD write (uploads never stopped being the source), clears the pointer
 * and records `repository_migration_canceled`. Run history is kept, as
 * `deleteInstructionRepositorySync` keeps it. `not_applicable` when there is
 * no such open move, which makes every caller safe to repeat. A
 * `start_failed` end writes no audit row: the move never opened.
 *
 * It asserts that uploads are still the source of truth before it deletes
 * anything: a move that is `PROPOSING` has never flipped the project, so a
 * project that is repository-backed now was flipped by something else, and
 * its sync row is that something's, not the move's. Deleting it would leave a
 * repository-backed project with nothing to sync from.
 */
export async function abandonInstructionMigration(
	input: Tenant & {
		syncId: string;
		reason: InstructionMigrationAbandonReason;
		/** Who asked, when a person did; the system otherwise. */
		actorUserId?: string | null;
	},
): Promise<AbandonInstructionMigrationResult> {
	return db.$transaction(async (tx) => {
		const locked = await lockProject(tx, input);
		const pointer = migrationOfSettings(locked?.instructionSettings);
		if (
			pointer === null ||
			pointer.syncId !== input.syncId ||
			pointer.state !== "PROPOSING"
		) {
			return "not_applicable" as const;
		}
		if (sourceOfTruthOf(locked?.instructionSettings) === "REPOSITORY") {
			return "source_flipped" as const;
		}
		await writeProjectInstructionSettings(
			tx,
			input.projectId,
			input.organizationId,
			{ migration: null },
		);
		await tx.projectInstructionRepositorySync.deleteMany({
			where: {
				id: input.syncId,
				projectId: input.projectId,
				organizationId: input.organizationId,
			},
		});
		if (input.reason !== "start_failed") {
			await recordAuditTx(tx, {
				action: "project.instructions.repository_migration_canceled",
				category: "project",
				actor: input.actorUserId
					? { type: "user", userId: input.actorUserId }
					: { type: "system" },
				organizationId: input.organizationId,
				projectId: input.projectId,
				resource: {
					type: "project_instruction_repository_sync",
					id: input.syncId,
				},
				metadata: { reason: input.reason },
			});
		}
		return "abandoned" as const;
	});
}

export type CompleteInstructionMigrationResult =
	| "completed"
	/** The flip was made by an earlier call. */
	| "already_completed"
	/** No open move names this branch: nothing to complete. */
	| "not_applicable";

/**
 * The settlement step for a move whose pull request merged (Fizzy #2878 §9):
 * under the project's lock, for a `PROPOSING` pointer whose branch is
 * `branchId`, writes `sourceOfTruth: REPOSITORY` and the `SWITCHING` pointer,
 * and on the sync row (locked after it) clears the `MIGRATING` pause, makes
 * the move's author the delegate, keeps `automatic` on and makes it due now.
 * The generation is NOT bumped: the move's proposal froze it, and the merge
 * sync that follows is requested against the current pair.
 *
 * The caller runs this before the branch's classification requests the merge
 * sync (`commitBranchClassification`), so by the time that run starts the
 * project is repository-backed.
 */
export async function completeInstructionMigration(
	input: Tenant & { branchId: string; pullRequestUrl: string | null },
): Promise<CompleteInstructionMigrationResult> {
	return db.$transaction(async (tx) => {
		const locked = await lockProject(tx, input);
		const pointer = migrationOfSettings(locked?.instructionSettings);
		if (pointer === null) {
			return "not_applicable";
		}
		if (!(await moveIsOnBranch(tx, pointer, input))) {
			return "not_applicable";
		}
		if (pointer.state === "SWITCHING") {
			return "already_completed";
		}
		const [sync] = await tx.$queryRaw<Array<{ id: string; now: Date }>>`
			SELECT "id", (clock_timestamp() AT TIME ZONE 'UTC') AS "now"
			FROM "project_instruction_repository_sync"
			WHERE "id" = ${pointer.syncId}
				AND "projectId" = ${input.projectId}
				AND "organizationId" = ${input.organizationId}
			FOR UPDATE
		`;
		if (sync === undefined) {
			return "not_applicable";
		}
		await writeProjectInstructionSettings(
			tx,
			input.projectId,
			input.organizationId,
			{
				sourceOfTruth: "REPOSITORY",
				migration: {
					...pointer,
					state: "SWITCHING",
					branchId: input.branchId,
					pullRequestUrl: input.pullRequestUrl,
				},
			},
		);
		await tx.projectInstructionRepositorySync.update({
			where: { id: sync.id },
			data: {
				userId: pointer.userId,
				automatic: true,
				automaticPausedReason: null,
				automaticPausedAt: null,
				failureCount: 0,
				nextCheckAt: sync.now,
			},
		});
		await recordAuditTx(tx, {
			action: "project.instructions.repository_migration_completed",
			category: "project",
			actor: { type: "user", userId: pointer.userId },
			organizationId: input.organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_repository_sync",
				id: pointer.syncId,
			},
			metadata: { stage: "switched", startedAt: pointer.startedAt },
		});
		return "completed";
	});
}

/**
 * Closes the move out once the first sync from the repository succeeded: for
 * a `SWITCHING` pointer naming `syncId`, clears the pointer and records
 * `repository_migration_completed`. `false` when no move is waiting on that
 * sync, so a later successful run does nothing.
 */
export async function settleInstructionMigrationAfterSync(
	input: Tenant & { syncId: string; snapshotId: string | null },
): Promise<boolean> {
	return db.$transaction(async (tx) => {
		const locked = await lockProject(tx, input);
		const pointer = migrationOfSettings(locked?.instructionSettings);
		if (
			pointer === null ||
			pointer.syncId !== input.syncId ||
			pointer.state !== "SWITCHING"
		) {
			return false;
		}
		await writeProjectInstructionSettings(
			tx,
			input.projectId,
			input.organizationId,
			{ migration: null },
		);
		await recordAuditTx(tx, {
			action: "project.instructions.repository_migration_completed",
			category: "project",
			actor: { type: "user", userId: pointer.userId },
			organizationId: input.organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_repository_sync",
				id: input.syncId,
			},
			metadata: {
				stage: "synced",
				startedAt: pointer.startedAt,
				...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
			},
		});
		return true;
	});
}
