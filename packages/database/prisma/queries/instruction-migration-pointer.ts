/**
 * The pointer a project carries while its uploaded coding instructions are
 * being moved into a repository (Fizzy #2878 §9): `instructionSettings.migration`.
 *
 * Only a pointer. The move itself is a member branch proposal whose rows
 * (branch, proposal, journal) already carry the state with row locks; the
 * pointer names them, remembers who asked and when, and is what the rest of
 * the system reads to know a move is open. Present means open: it is written
 * when the move starts and cleared when the move ends (its first sync from
 * the repository succeeded, or it was canceled), so "a move is open" is one
 * check everywhere, including the freeze that refuses uploads and edits.
 *
 * Two states are stored; the others a person sees (OPEN, BLOCKED, MERGED) are
 * read from the branch and the proposal each time, never copied here where
 * they could go stale:
 *
 *  - `PROPOSING`: the repository sync row exists (paused `MIGRATING`) and the
 *    project's `sourceOfTruth` is still UPLOAD. The pull request is being
 *    opened, is open, is blocked, or is merged and not yet settled.
 *  - `SWITCHING`: the pull request merged and settlement flipped
 *    `sourceOfTruth` to REPOSITORY and cleared the pause; the first sync from
 *    the repository has not yet succeeded.
 *
 * Pure: no database access, so the readers that only decide from a settings
 * value can import it without a client.
 */

export type InstructionMigrationState = "PROPOSING" | "SWITCHING";

export type InstructionMigrationPointer = {
	v: 1;
	state: InstructionMigrationState;
	/** The member branch the move's proposal joined; null until it has. */
	branchId: string | null;
	/** The move's proposal snapshot; null until it is created. */
	snapshotId: string | null;
	/** The repository sync row created for the move. */
	syncId: string;
	/** The pull request's address, recorded when it merged. */
	pullRequestUrl: string | null;
	/** ISO 8601. */
	startedAt: string;
	/** Who started it: the member the sync acts as once it is over. */
	userId: string;
};

/**
 * A write that the open move refuses, thrown by the writers that decide it
 * under the project row's lock (the settings and configuration writers): the
 * check an API procedure made before calling them describes a moment before
 * the lock, and a move that started in between would otherwise be overwritten
 * (a configure replacing the sync row the move created, new ignore rules
 * bumping its generation). Carries the pointer it found so the caller can say
 * what the move is waiting for.
 */
export class InstructionMigrationOpenError extends Error {
	readonly pointer: InstructionMigrationPointer;

	constructor(pointer: InstructionMigrationPointer) {
		super("A move of the project's coding instructions is open");
		this.name = "InstructionMigrationOpenError";
		this.pointer = pointer;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null | undefined {
	return value === null || typeof value === "string" ? value : undefined;
}

/** The pointer a settings value holds, or null when it holds none or a shape this code does not know. */
export function parseInstructionMigrationPointer(
	raw: unknown,
): InstructionMigrationPointer | null {
	if (!isRecord(raw) || raw.v !== 1) {
		return null;
	}
	const branchId = nullableString(raw.branchId);
	const snapshotId = nullableString(raw.snapshotId);
	const pullRequestUrl = nullableString(raw.pullRequestUrl);
	if (
		(raw.state !== "PROPOSING" && raw.state !== "SWITCHING") ||
		branchId === undefined ||
		snapshotId === undefined ||
		pullRequestUrl === undefined ||
		typeof raw.syncId !== "string" ||
		typeof raw.startedAt !== "string" ||
		typeof raw.userId !== "string"
	) {
		return null;
	}
	return {
		v: 1,
		state: raw.state,
		branchId,
		snapshotId,
		syncId: raw.syncId,
		pullRequestUrl,
		startedAt: raw.startedAt,
		userId: raw.userId,
	};
}

/** The pointer in a project's `instructionSettings` value, if it carries one. */
export function migrationOfSettings(
	settings: unknown,
): InstructionMigrationPointer | null {
	return isRecord(settings)
		? parseInstructionMigrationPointer(settings.migration)
		: null;
}

/** Ordinary repository reads use Git; only an open migration still imports. */
export function instructionRepositoryImportAllowed(
	settings: unknown,
	syncId: string,
): boolean {
	if (!isRecord(settings) || settings.sourceOfTruth !== "REPOSITORY") {
		return false;
	}
	const migration = migrationOfSettings(settings);
	return migration?.state === "SWITCHING" && migration.syncId === syncId;
}

/**
 * Whether a pull request's recorded observation says it merged into a branch
 * other than the one the sync reads (`targetMismatch`, set by the branch
 * classification). Such a merge put the move's files somewhere the sync never
 * looks, so it ends the move (nothing switches) instead of completing it; the
 * settlement hook and the retry that repeats it both decide by this one
 * reading.
 */
export function mergedElsewhere(observation: unknown): boolean {
	return (
		isRecord(observation) &&
		(observation as { targetMismatch?: unknown }).targetMismatch === true
	);
}

/**
 * `sourceOfTruth` as the member branch machinery's destination checks read it
 * (`currentDestination`, `assertBranchCreationAllowed`): `REPOSITORY` when the
 * project is repository-backed, and also while a move from uploads is
 * `PROPOSING` for the sync row `syncId`, whose row then stands in for a
 * destination so the move's pull request flows through the machinery while
 * uploads remain the source of truth. Anything else is the stored value.
 * The pointer must name this very row, so a stale pointer never lends a
 * destination to another one.
 */
export function destinationSourceOfTruth(
	settings: unknown,
	syncId: string | null,
): unknown {
	if (!isRecord(settings)) {
		return null;
	}
	const migration = migrationOfSettings(settings);
	if (
		migration !== null &&
		migration.state === "PROPOSING" &&
		syncId !== null &&
		migration.syncId === syncId
	) {
		return "REPOSITORY";
	}
	return settings.sourceOfTruth ?? null;
}
