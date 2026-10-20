/**
 * Terminal status writes for a PM-sync run, with or without an attempt id.
 *
 * Every enqueue stamps the row PENDING with a fresh `lastPmSyncAttemptId`
 * and passes that id to the run it starts (`pmSyncAttemptId`). A run's
 * status fields (`lastPmSyncStatus`, `lastPmSyncError`,
 * `lastPmSyncAttemptAt`) may change only while the row still names the
 * run's attempt: once a newer enqueue has stamped the row, the older run's
 * late SUCCESS / FAILED / CONFLICT is skipped rather than overwriting the
 * newer PENDING. The match is on the attempt id alone, not on PENDING, so a
 * run that finishes after the stuck-sync watchdog gave up on its attempt
 * still replaces that FAILED with its real outcome.
 *
 * Fields that record what already happened at the PM tool (the link and the
 * drift baseline) are not written here: callers write them unconditionally
 * first, because the push did happen.
 *
 * A run that carries no attempt id (a batch or auto sync, the backlog apply,
 * a history from before attempt ids were passed) goes through
 * `writePmSyncStatusUnattempted` instead. Its status write must not overwrite
 * a row that is PENDING for an attempt (`lastPmSyncStatus = PENDING` and
 * `lastPmSyncAttemptId` set): that PENDING belongs to an attempted run, which
 * records its own outcome, or the stuck-sync watchdog settles it. Such a
 * run's status write lands on any other row by id, including a PENDING with
 * no attempt id (stamped before attempt ids existed), which no attempted run
 * would ever settle.
 *
 * Callers pick between the two through `writePmSyncRunStatus`. Writes that
 * deliberately override any state (the orphaned- and unconfirmed-create
 * FAILED, user dismiss and unlink, the watchdog's give-up,
 * `compensatePmSyncStart`, the PENDING stamps themselves) do not come
 * through here.
 */

import { db, type Prisma } from "@repo/database";

/** The status value an enqueue stamps; a string so callers' mocks need no enum. */
const PENDING = "PENDING" as const;

/** Item types whose rows carry PM-sync state. */
export type PmSyncFencedItemType =
	| "epic"
	| "feature"
	| "story"
	| "bug"
	| "testCase";

export interface PmSyncStatusFields {
	lastPmSyncStatus?: "PENDING" | "SUCCESS" | "CONFLICT" | "FAILED" | null;
	lastPmSyncError?: string | null;
	lastPmSyncAttemptAt?: Date;
}

/**
 * Apply `data` to the row only while its attempt id is `attemptId`.
 * Resolves `true` when the row was written, `false` when a newer attempt (or
 * an unlink or dismiss that cleared the attempt) superseded it, or for the
 * legacy epic/feature types, which have no row. A database error propagates.
 */
export async function writePmSyncStatusForAttempt(input: {
	itemType: PmSyncFencedItemType;
	itemId: string;
	attemptId: string;
	/** Narrow a refusal to the link and attempt that were judged. */
	onlyIfRowUnchanged?: {
		externalId: string | null;
		externalUrl?: string | null;
		externalMcpServerId: string | null;
		externalPmTarget?: string | null;
		lastPmSyncAttemptId: string | null;
	};
	data: PmSyncStatusFields;
	/** Optional extra scope (the test-case writes also match the project). */
	projectId?: string;
	/**
	 * Optional extra scope for a failure about one PM create
	 * (`recordPmSyncFailure`'s `onlyWhileHoldingCreateClaim`): the write also
	 * requires the row unlinked and still holding this create claim, so a
	 * late outcome never lands on a row another create has claimed or linked
	 * since. It narrows the write and never widens it.
	 */
	onlyWhileHoldingCreateClaim?: string;
	/** The client to write through (a caller's transaction); default `db`. */
	client?: Prisma.TransactionClient;
}): Promise<boolean> {
	if (
		input.onlyIfRowUnchanged &&
		input.onlyIfRowUnchanged.lastPmSyncAttemptId !== input.attemptId
	) {
		return false;
	}
	const client: Prisma.TransactionClient = input.client ?? db;
	const where = {
		id: input.itemId,
		...(input.onlyIfRowUnchanged ?? {}),
		lastPmSyncAttemptId: input.attemptId,
		...(input.projectId ? { projectId: input.projectId } : {}),
		...holdingCreateClaim(input.onlyWhileHoldingCreateClaim),
	};
	if (input.itemType === "story" || input.itemType === "bug") {
		const { count } = await client.userStory.updateMany({
			where,
			data: input.data,
		});
		return count > 0;
	}
	if (input.itemType === "testCase") {
		const { count } = await client.testCase.updateMany({
			where,
			data: input.data,
		});
		return count > 0;
	}
	return false;
}

/**
 * The rows a status write without an attempt id may change: any row that is
 * not PENDING for an attempt. NULL is named explicitly in both arms, because
 * in SQL `status <> 'PENDING'` is never true for a NULL status, and a row the
 * stuck-sync watchdog or a leaked-PENDING clear set back to NULL keeps its
 * attempt id. `__tests__/pm-sync-unattempted-status.integration.test.ts` runs
 * this against Postgres.
 */
/** The `onlyWhileHoldingCreateClaim` scope: unlinked, holding this claim. */
function holdingCreateClaim(claimId: string | undefined) {
	return claimId === undefined
		? {}
		: { externalId: null, pmCreateClaimId: claimId };
}

function notPendingForAnAttempt() {
	return {
		OR: [
			{ lastPmSyncStatus: null },
			{ lastPmSyncStatus: { not: PENDING } },
			{ lastPmSyncAttemptId: null },
		],
	};
}

/**
 * Apply `data` from a run that carries no attempt id, unless the row is
 * PENDING for an attempt. Resolves `true` when the row was written, `false`
 * when an attempted run owns the row (or the row is gone), and for the
 * legacy epic/feature types, which have no row. A database error propagates.
 *
 * Fields that record what already happened at the PM tool (the link, the
 * drift baseline, `lastSyncedAt`) are not written here: callers write them by
 * id first, because the push happened whoever owns the status.
 */
export async function writePmSyncStatusUnattempted(input: {
	itemType: PmSyncFencedItemType;
	itemId: string;
	data: PmSyncStatusFields;
	/** Optional extra scope (the test-case writes also match the project). */
	projectId?: string;
	/**
	 * Optional extra scope for a failure that rests on the row as the caller
	 * read it (`recordPmSyncFailure`'s legacy-link guard): the write also
	 * requires this link and this attempt id. It narrows the write and never
	 * widens it: a row PENDING for an attempt is skipped even when its
	 * attempt id is the one read.
	 */
	onlyIfRowUnchanged?: {
		externalId: string | null;
		externalMcpServerId: string | null;
		externalPmTarget?: string | null;
		lastPmSyncAttemptId: string | null;
		/** Also required when given (unset: the URL is not checked). */
		externalUrl?: string | null;
	};
	/**
	 * Optional extra scope for a failure about one PM create
	 * (`recordPmSyncFailure`'s `onlyWhileHoldingCreateClaim`): the write also
	 * requires the row unlinked and still holding this create claim, so a
	 * late outcome never lands on a row another create has claimed or linked
	 * since. It narrows the write and never widens it.
	 */
	onlyWhileHoldingCreateClaim?: string;
	/** The client to write through (a caller's transaction); default `db`. */
	client?: Prisma.TransactionClient;
}): Promise<boolean> {
	const client: Prisma.TransactionClient = input.client ?? db;
	const snapshot = input.onlyIfRowUnchanged;
	const where = {
		id: input.itemId,
		...(input.projectId ? { projectId: input.projectId } : {}),
		...(snapshot
			? {
					externalId: snapshot.externalId,
					externalMcpServerId: snapshot.externalMcpServerId,
					...(snapshot.externalPmTarget !== undefined
						? { externalPmTarget: snapshot.externalPmTarget }
						: {}),
					lastPmSyncAttemptId: snapshot.lastPmSyncAttemptId,
					...(snapshot.externalUrl !== undefined
						? { externalUrl: snapshot.externalUrl }
						: {}),
				}
			: {}),
		...notPendingForAnAttempt(),
		...holdingCreateClaim(input.onlyWhileHoldingCreateClaim),
	};
	if (input.itemType === "story" || input.itemType === "bug") {
		const { count } = await client.userStory.updateMany({
			where,
			data: input.data,
		});
		return count > 0;
	}
	if (input.itemType === "testCase") {
		const { count } = await client.testCase.updateMany({
			where,
			data: input.data,
		});
		return count > 0;
	}
	return false;
}

/**
 * A sync run's terminal status write: scoped to `attemptId` when the run
 * carries one (`writePmSyncStatusForAttempt`), otherwise kept off a row that
 * is PENDING for an attempt (`writePmSyncStatusUnattempted`). Resolves
 * whether the row was written.
 */
export function writePmSyncRunStatus(input: {
	itemType: PmSyncFencedItemType;
	itemId: string;
	/** The run's attempt id; unset for a run that carries none. */
	attemptId: string | undefined;
	data: PmSyncStatusFields;
	/** Optional extra scope (the test-case writes also match the project). */
	projectId?: string;
	/** The client to write through (a caller's transaction); default `db`. */
	client?: Prisma.TransactionClient;
}): Promise<boolean> {
	const { attemptId, ...rest } = input;
	return attemptId === undefined
		? writePmSyncStatusUnattempted(rest)
		: writePmSyncStatusForAttempt({ ...rest, attemptId });
}
