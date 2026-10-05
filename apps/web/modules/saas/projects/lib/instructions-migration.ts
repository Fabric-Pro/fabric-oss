/**
 * A move of a project's uploaded coding instructions into a repository (Fizzy
 * #2878 §9) as the tab reads it: one pull request carries the published files,
 * and the project switches to syncing from that folder once it merges. While a
 * move is open every other way of changing the instructions is paused.
 *
 * The shapes are declared here rather than inferred from the procedures, the
 * same way `RepositorySyncState` is: the states arrive as strings and the
 * components read them as the closed sets they are. Pure, so the tab, the
 * status line and the controls it pauses share one answer.
 */

import type { MigrationOpenRefusal } from "./instructions-action-error";

/**
 * Where a move stands. `PROPOSING` is the pull request being prepared and
 * opened; `OPEN` is it awaiting a merge; `BLOCKED` is a failure that needs
 * someone (a retry or a cancel); `MERGED` and `SWITCHING` are the project
 * switching over; `ABANDONED` is a pull request that ended without merging and
 * a move not yet cleaned up.
 */
type RepositoryMigrationState =
	| "PROPOSING"
	| "OPEN"
	| "BLOCKED"
	| "MERGED"
	| "SWITCHING"
	| "ABANDONED";

export type RepositoryMigrationView = {
	state: RepositoryMigrationState;
	/** The pull request is being closed (a cancel is settling); `state` stays `OPEN` until it has. */
	closing: boolean;
	startedAt: string;
	startedByUserId: string;
	snapshotId: string | null;
	branchId: string | null;
	syncId: string;
	pullRequest: {
		url: string;
		externalId: string;
		state: "OPEN" | "MERGED" | "CLOSED";
	} | null;
	/**
	 * The pull request merged into a branch other than the one the sync reads,
	 * so its files are not where the project will look. The move is then
	 * `ABANDONED`: nothing switches, whatever the pull request says.
	 */
	targetMismatch: boolean;
	/**
	 * Why it is `BLOCKED`: a typed code, never text, and whether a retry can
	 * help. `SOURCE_FLIPPED` (not retryable) is a project that something other
	 * than the move switched to the repository: Cancel and Retry are refused,
	 * and switching back to upload mode is the only way out.
	 */
	failure: { code: string; retryable: boolean } | null;
};

/** `repositorySync.getMigration`: the move, and the repository it moves into. */
export type RepositoryMigrationRead = {
	migration: RepositoryMigrationView | null;
	repository: {
		provider: string;
		owner: string;
		name: string;
		ref: string;
		folder: string;
	} | null;
};

/** While something is moving: the pull request being opened, a merge being settled, the project switching. */
export const MIGRATION_POLL_MS = 3_000;
/** While the move waits on a person: a pull request awaiting its merge, a failure awaiting a retry. */
export const MIGRATION_SETTLED_POLL_MS = 30_000;

/**
 * `refetchInterval` for `repositorySync.getMigration`: quickly while the move
 * is changing under the tab, slowly while it waits on someone, and not at all
 * once the read says no move is open (the tab re-reads the sync state then).
 */
export function migrationPollInterval(
	data: RepositoryMigrationRead | undefined,
): number | false {
	if (data === undefined) {
		return MIGRATION_POLL_MS;
	}
	const move = data.migration;
	if (move === null) {
		return false;
	}
	if (move.closing) {
		return MIGRATION_POLL_MS;
	}
	switch (move.state) {
		case "OPEN":
		case "BLOCKED":
			return MIGRATION_SETTLED_POLL_MS;
		case "PROPOSING":
		case "MERGED":
		case "SWITCHING":
		case "ABANDONED":
			return MIGRATION_POLL_MS;
		default: {
			const unreachable: never = move.state;
			return unreachable;
		}
	}
}

/**
 * The sentence that says why a change is paused, a key under
 * `projects.codingInstructions.actionErrors`; `number` is the pull request's,
 * for the one sentence that names it.
 */
export type MigrationPause = {
	key:
		| "migrationOpen"
		| "migrationPreparing"
		| "migrationSwitching"
		| "migrationBlocked"
		| "migrationFlipped"
		| "migrationEnded"
		| "migrationMismatch"
		| "migrationPaused";
	number?: string;
};

/** The sentence for a move as it stands; `null` is a move not read yet. */
export function migrationPause(
	move: RepositoryMigrationView | null,
): MigrationPause {
	if (move === null) {
		return { key: "migrationPaused" };
	}
	switch (move.state) {
		case "OPEN":
			return move.pullRequest === null
				? { key: "migrationPreparing" }
				: { key: "migrationOpen", number: move.pullRequest.externalId };
		case "PROPOSING":
			return { key: "migrationPreparing" };
		case "MERGED":
		case "SWITCHING":
			return { key: "migrationSwitching" };
		case "BLOCKED":
			return {
				key:
					move.failure?.code === "SOURCE_FLIPPED"
						? "migrationFlipped"
						: "migrationBlocked",
			};
		case "ABANDONED":
			return {
				key: move.targetMismatch
					? "migrationMismatch"
					: "migrationEnded",
			};
		default: {
			const unreachable: never = move.state;
			return unreachable;
		}
	}
}

/**
 * What a person may do about a move, in its own state. Cancel and Retry are
 * the move's own commands; switching the project back to upload mode is the
 * way out of the two states Cancel cannot end: a project that is switching
 * (the first sync from the repository may never succeed) and a blocked move,
 * which includes a project switched behind the move's back, where Cancel and
 * Retry are refused. `pointer` is the sync state's own, so a project that is
 * switching can leave before the move has been read.
 */
export function migrationActions(
	move: RepositoryMigrationView | null,
	pointer: "PROPOSING" | "SWITCHING",
): { cancel: boolean; retry: boolean; switchToUpload: boolean } {
	const switchToUpload = pointer === "SWITCHING" || move?.state === "BLOCKED";
	if (move === null) {
		return { cancel: false, retry: false, switchToUpload };
	}
	const flipped = move.failure?.code === "SOURCE_FLIPPED";
	const settling = move.state === "MERGED" || move.state === "SWITCHING";
	return {
		cancel: !move.closing && !settling && !flipped,
		retry: move.state === "BLOCKED" && move.failure?.retryable === true,
		switchToUpload,
	};
}

/** The sentence for a paused write the server refused (`MIGRATION_OPEN`). */
export function migrationRefusalPause(
	refusal: MigrationOpenRefusal,
): MigrationPause {
	if (refusal.state === "switching") {
		return { key: "migrationSwitching" };
	}
	return refusal.pullRequest === null
		? { key: "migrationPreparing" }
		: { key: "migrationOpen", number: refusal.pullRequest };
}

/** The sentence for a blocked move, a key under `repositorySync.migration.failures`. */
export type MigrationFailureKey =
	| "connection"
	| "refused"
	| "branchMissing"
	| "repositoryChanged"
	| "attribution"
	| "validation"
	| "temporary"
	| "sourceFlipped"
	| "generic";

const FAILURE_KEY_BY_CODE: ReadonlyMap<string, MigrationFailureKey> = new Map<
	string,
	MigrationFailureKey
>([
	["AUTHENTICATION_FAILED", "connection"],
	["PERMISSION_REVOKED", "connection"],
	["REPOSITORY_UNAVAILABLE", "connection"],
	["CLOSE_CREDENTIALS_UNAVAILABLE", "connection"],
	["BRANCH_WRITE_REFUSED", "refused"],
	["PR_CREATION_REFUSED", "refused"],
	["CLOSE_REFUSED", "refused"],
	["TARGET_BRANCH_MISSING", "branchMissing"],
	["CONFIGURATION_CHANGED", "repositoryChanged"],
	["REPOSITORY_CHANGED", "repositoryChanged"],
	["BASE_COMMIT_UNAVAILABLE", "repositoryChanged"],
	["SOURCE_FLIPPED", "sourceFlipped"],
	["TREE_CONFLICT", "repositoryChanged"],
	["REMOTE_REF_CONFLICT", "repositoryChanged"],
	["BRANCH_NAME_UNAVAILABLE", "repositoryChanged"],
	["ATTRIBUTION_REJECTED", "attribution"],
	["VALIDATION_REJECTED", "validation"],
	["VALIDATION_FAILED", "validation"],
	["VALIDATION_TIMEOUT", "validation"],
	["PROVIDER_RATE_LIMITED", "temporary"],
	["PROVIDER_TEMPORARY", "temporary"],
	["LOOKUP_INCONCLUSIVE", "temporary"],
	["CREATE_OUTCOME_UNKNOWN", "temporary"],
	["STORAGE_FAILED", "temporary"],
	["GIT_FAILED", "temporary"],
]);

/**
 * The sentence for the typed code a blocked move carries. A code this build
 * does not know is the generic sentence, never anything the server wrote.
 */
export function migrationFailureKey(code: string): MigrationFailureKey {
	return FAILURE_KEY_BY_CODE.get(code) ?? "generic";
}

/**
 * Why canceling or retrying a move was refused: a key under
 * `repositorySync.migration.commandErrors`, chosen by `data.reason`. `null` for
 * any other error (the shared error map then speaks).
 */
export type MigrationCommandRefusal =
	| "MIGRATION_MERGED"
	| "MIGRATION_PREPARING"
	| "MIGRATION_CHANGED"
	| "MIGRATION_NOT_OPEN"
	| "MIGRATION_NOT_RETRYABLE"
	| "MIGRATION_SOURCE_FLIPPED";

const COMMAND_REFUSALS: ReadonlySet<string> = new Set<MigrationCommandRefusal>([
	"MIGRATION_MERGED",
	"MIGRATION_PREPARING",
	"MIGRATION_CHANGED",
	"MIGRATION_NOT_OPEN",
	"MIGRATION_NOT_RETRYABLE",
	"MIGRATION_SOURCE_FLIPPED",
]);

export function migrationCommandRefusal(
	error: unknown,
): MigrationCommandRefusal | null {
	const data =
		error && typeof error === "object" && "data" in error
			? error.data
			: undefined;
	if (!data || typeof data !== "object" || !("reason" in data)) {
		return null;
	}
	const reason = data.reason;
	return typeof reason === "string" && COMMAND_REFUSALS.has(reason)
		? (reason as MigrationCommandRefusal)
		: null;
}

/**
 * Why `migrate` itself was refused, before any pull request existed: a key
 * under `projects.codingInstructions.repositorySync.moveDialog.refusals` and
 * the field the person should look at when the refusal is about one. Chosen by
 * the refusal's `data.reason`, never by the server's own text. `null` when the
 * error is not one of these (the dialog then words it as the configure dialog
 * words the same repository and branch failures).
 */
export type MoveRefusal = {
	key:
		| "folderNotEmpty"
		| "folderNotEmptyRoot"
		| "syncConfigured"
		| "nothingPublished"
		| "notUploadSourced"
		| "canceled"
		| "attribution";
	field: "folder" | null;
};

export function moveRefusal(
	error: unknown,
	rootPath: string,
): MoveRefusal | null {
	const data =
		error && typeof error === "object" && "data" in error
			? error.data
			: undefined;
	if (!data || typeof data !== "object" || !("reason" in data)) {
		return null;
	}
	switch (data.reason) {
		case "FOLDER_NOT_EMPTY":
			return {
				key: rootPath === "" ? "folderNotEmptyRoot" : "folderNotEmpty",
				field: "folder",
			};
		case "SYNC_CONFIGURED":
			return { key: "syncConfigured", field: null };
		case "NOTHING_PUBLISHED":
			return { key: "nothingPublished", field: null };
		case "NOT_UPLOAD_SOURCED":
			return { key: "notUploadSourced", field: null };
		case "MIGRATION_CANCELED":
			return { key: "canceled", field: null };
		case "ATTRIBUTION_REJECTED":
			return { key: "attribution", field: null };
		default:
			return null;
	}
}

/**
 * What a move that did not complete leaves behind once it is gone: its pull
 * request ended without merging (or was being closed), and the instructions
 * stay as published. `previous` is the move the tab last saw, `current` the
 * one it sees now; a notice is given only when a move that was going nowhere
 * has disappeared, never for one that completed (it merged and the project
 * switched) and never while the move is still there.
 */
export function migrationEndedNotice(
	previous: RepositoryMigrationView | null,
	current: RepositoryMigrationView | null,
	repository: string | null,
): MigrationEndedNotice | null {
	if (previous === null || current !== null) {
		return null;
	}
	const ended =
		previous.state === "ABANDONED" ||
		(previous.state === "OPEN" && previous.closing);
	return ended
		? {
				pullRequest: previous.pullRequest?.externalId ?? null,
				repository,
				...(previous.targetMismatch
					? { mergedElsewhere: true as const }
					: {}),
			}
		: null;
}

/**
 * What the tab says about a move that ended without its files landing: the
 * pull request, if one was opened, and the repository, as `owner/name`.
 * `mergedElsewhere` is a pull request that merged, into a branch the sync does
 * not read.
 */
export type MigrationEndedNotice = {
	pullRequest: string | null;
	repository: string | null;
	mergedElsewhere?: true;
};
