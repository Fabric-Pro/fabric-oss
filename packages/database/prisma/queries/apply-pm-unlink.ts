import { db } from "../client";
import type { PmStateChangeEntityType, Prisma } from "../generated/client";
import {
	pmCreateClaimRecoverableAt,
	pmCreateClaimRecoveryCutoff,
	recoverableClaimWhere,
} from "./pm-create-claim-recovery";

type Tx = Prisma.TransactionClient;

/**
 * A recovery write's outcome when it matched nothing only because the held
 * claim it read is younger than `PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS`: its
 * holder may still be sending the create. `recoverableAt` is when that
 * claim becomes clearable (`null` when the claim has no timestamp).
 */
export interface PmRecoveryClaimTooRecent {
	recoverableAt: Date | null;
}

/**
 * After a recovery write on a held claim matched nothing: whether the row
 * still matches everything else the write required (`baseWhere`, the claim
 * read included) and so missed only on the claim's age.
 */
async function claimTooRecent(
	read: (where: Record<string, unknown>) => Promise<{
		pmCreateClaimedAt: Date | null;
	} | null>,
	baseWhere: Record<string, unknown>,
): Promise<PmRecoveryClaimTooRecent | undefined> {
	const row = await read(baseWhere);
	return row
		? { recoverableAt: pmCreateClaimRecoverableAt(row.pmCreateClaimedAt) }
		: undefined;
}

export interface ApplyPmUnlinkParams {
	projectId: string;
	entityType: PmStateChangeEntityType;
	entityId: string;
	expectedExternalId: string;
	expectedExternalMcpServerId: string | null;
	/**
	 * The PM create claim the caller read together with the link. When
	 * given, the unlink applies only while the row still holds exactly that
	 * claim (`null`: no claim), and clears it: a claim taken after the read
	 * belongs to a push that may already have sent a create, so it is kept
	 * and nothing is unlinked. A held claim is cleared only once it is older
	 * than `PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS` (database clock): before
	 * that, its holder may still be sending the create. When omitted, the
	 * claim is left as it is (the Review Center's unlink).
	 */
	expectedPmCreateClaimId?: string | null;
}

/**
 * Transaction-form unlink: severs an entity's external PM link on a caller-
 * provided tx client, so the Accept path can claim the pending row and unlink
 * atomically in one transaction (#1360). Same atomic externalId + projectId +
 * server guard (updateMany count === 1) as before; also deletes the entity's
 * missing-streak rows. Returns { applied:false } and clears nothing on count 0.
 * Clears the PM create claim only when the caller names the claim it read
 * (`expectedPmCreateClaimId`), and a held one only once it is old enough
 * (`recoverableClaimWhere`); a miss on its age alone is reported as
 * `claimTooRecent`.
 */
export async function applyPmUnlinkTx(
	tx: Tx,
	{
		projectId,
		entityType,
		entityId,
		expectedExternalId,
		expectedExternalMcpServerId,
		expectedPmCreateClaimId,
	}: ApplyPmUnlinkParams,
): Promise<{ applied: boolean; claimTooRecent?: PmRecoveryClaimTooRecent }> {
	const scopesClaim = expectedPmCreateClaimId !== undefined;
	const baseWhere = {
		id: entityId,
		projectId,
		externalId: expectedExternalId,
		externalMcpServerId: expectedExternalMcpServerId,
		...(scopesClaim ? { pmCreateClaimId: expectedPmCreateClaimId } : {}),
	};
	const agesClaim =
		expectedPmCreateClaimId !== undefined &&
		expectedPmCreateClaimId !== null;

	// Stories are the only work-item rows since the Epic/Feature folder tables
	// were dropped. Legacy EPIC/FEATURE pending rows can't match a user_story id,
	// so they naturally resolve to { applied: false } via count 0.
	if (entityType !== "STORY") {
		return { applied: false };
	}

	const where = agesClaim
		? {
				...baseWhere,
				...recoverableClaimWhere(
					expectedPmCreateClaimId,
					await pmCreateClaimRecoveryCutoff(tx),
				),
			}
		: baseWhere;
	const { count } = await tx.userStory.updateMany({
		where,
		data: {
			externalId: null,
			externalUrl: null,
			externalMcpServerId: null,
			externalPmTarget: null,
			pmTicketTerminal: false,
			pmTicketTerminalStatus: null,
			pmAutoHidden: false,
			lastSyncedPmHash: null,
			lastSyncedAt: null,
			lastPmSyncStatus: null,
			lastPmSyncError: null,
			lastPmSyncAttemptAt: null,
			lastPmSyncAttemptId: null,
			pmSyncPendingSince: null,
			lastSyncedStatusId: null,
			// Unlink & re-create is the user's decision to drop the PM link
			// and let the next push create afresh, so it also drops the claim
			// it read (the WHERE above requires that same claim).
			...(scopesClaim
				? { pmCreateClaimId: null, pmCreateClaimedAt: null }
				: {}),
		},
	});

	if (count !== 1) {
		const tooRecent = agesClaim
			? await claimTooRecent(
					(w) =>
						tx.userStory.findFirst({
							where: w,
							select: { pmCreateClaimedAt: true },
						}),
					baseWhere,
				)
			: undefined;
		return tooRecent
			? { applied: false, claimTooRecent: tooRecent }
			: { applied: false };
	}

	await tx.pmTicketMissingStreak.deleteMany({
		where: { projectId, entityType, entityId },
	});

	return { applied: true };
}

/**
 * Standalone unlink (own transaction). Thin wrapper over `applyPmUnlinkTx` so
 * existing direct callers / unit tests keep their contract.
 */
export async function applyPmUnlink(
	params: ApplyPmUnlinkParams,
): Promise<{ applied: boolean; claimTooRecent?: PmRecoveryClaimTooRecent }> {
	return await db.$transaction((tx) => applyPmUnlinkTx(tx, params));
}

/**
 * Clear the PM create claim on a story that has no PM link: the user's
 * "Unlink & re-create" on a row whose create may have reached the PM tool but
 * was never linked (a held claim with `externalId` null). Clears only the
 * claim the caller read (`claimId`): a claim taken since belongs to a push
 * that may already have sent a create, and is kept. Only an unlinked row in
 * the project is touched; a linked row is unlinked through `applyPmUnlink`.
 * The claim is cleared only once it is older than
 * `PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS`; a miss on its age alone is reported
 * as `claimTooRecent`. Returns whether that claim was cleared.
 */
export async function clearPmCreateClaim(params: {
	projectId: string;
	storyId: string;
	claimId: string;
}): Promise<{ cleared: boolean; claimTooRecent?: PmRecoveryClaimTooRecent }> {
	const baseWhere = {
		id: params.storyId,
		projectId: params.projectId,
		externalId: null,
		pmCreateClaimId: params.claimId,
	};
	const cutoff = await pmCreateClaimRecoveryCutoff(db);
	const { count } = await db.userStory.updateMany({
		where: {
			...baseWhere,
			...recoverableClaimWhere(params.claimId, cutoff),
		},
		data: { pmCreateClaimId: null, pmCreateClaimedAt: null },
	});
	if (count === 1) {
		return { cleared: true };
	}
	const tooRecent = await claimTooRecent(
		(w) =>
			db.userStory.findFirst({
				where: w,
				select: { pmCreateClaimedAt: true },
			}),
		baseWhere,
	);
	return tooRecent
		? { cleared: false, claimTooRecent: tooRecent }
		: { cleared: false };
}

/**
 * The case is not PENDING for an attempt: a retry's start (or its run) is in
 * flight, and clearing the case's state or claim under it would leave that
 * attempt's PENDING with nothing to settle it. NULL-safe (`status <> x` is
 * never true for NULL in SQL, hence the explicit NULL arm).
 */
const NOT_PENDING_FOR_AN_ATTEMPT = {
	OR: [
		{ lastPmSyncStatus: null },
		{ lastPmSyncStatus: { not: "PENDING" as const } },
		{ lastPmSyncAttemptId: null },
	],
};

export interface ApplyTestCasePmUnlinkParams {
	projectId: string;
	testCaseId: string;
	/** The link the caller read with the case: its id, URL and server. */
	expectedExternalId: string;
	expectedExternalUrl: string | null;
	expectedExternalMcpServerId: string | null;
	/** The PM create claim read with the link (`null`: no claim). */
	expectedPmCreateClaimId: string | null;
}

/**
 * "Unlink & re-create" for a test case: drop its PM link, its sync state and
 * the create claim it held, so the push that follows creates afresh. The
 * test-case counterpart of `applyPmUnlinkTx`, which serves only stories.
 *
 * Applies only while the case still carries exactly what the caller read:
 * the same link id, URL and server, and the same create claim. A relink, or
 * a claim taken after the read (a push that may already have sent a create),
 * leaves the case alone and resolves `{ applied: false }`; so does a case
 * PENDING for a retry attempt (`NOT_PENDING_FOR_AN_ATTEMPT`), and a held
 * claim younger than `PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS` (reported as
 * `claimTooRecent` when that is the only miss). Also deletes the case's
 * missing-streak rows. Its own transaction.
 */
export async function applyTestCasePmUnlink(
	params: ApplyTestCasePmUnlinkParams,
): Promise<{ applied: boolean; claimTooRecent?: PmRecoveryClaimTooRecent }> {
	return await db.$transaction(async (tx) => {
		const baseWhere = {
			id: params.testCaseId,
			projectId: params.projectId,
			externalId: params.expectedExternalId,
			externalUrl: params.expectedExternalUrl,
			externalMcpServerId: params.expectedExternalMcpServerId,
			pmCreateClaimId: params.expectedPmCreateClaimId,
			...NOT_PENDING_FOR_AN_ATTEMPT,
		};
		const where =
			params.expectedPmCreateClaimId === null
				? baseWhere
				: {
						...baseWhere,
						...recoverableClaimWhere(
							params.expectedPmCreateClaimId,
							await pmCreateClaimRecoveryCutoff(tx),
						),
					};
		const { count } = await tx.testCase.updateMany({
			where,
			data: {
				externalId: null,
				externalUrl: null,
				externalMcpServerId: null,
				externalPmTarget: null,
				lastSyncedPmHash: null,
				lastSyncedAt: null,
				lastPmSyncStatus: null,
				lastPmSyncError: null,
				lastPmSyncAttemptAt: null,
				lastPmSyncAttemptId: null,
				pmSyncPendingSince: null,
				pmCreateClaimId: null,
				pmCreateClaimedAt: null,
			},
		});
		if (count !== 1) {
			const tooRecent =
				params.expectedPmCreateClaimId === null
					? undefined
					: await claimTooRecent(
							(w) =>
								tx.testCase.findFirst({
									where: w,
									select: { pmCreateClaimedAt: true },
								}),
							baseWhere,
						);
			return tooRecent
				? { applied: false, claimTooRecent: tooRecent }
				: { applied: false };
		}
		await tx.pmTicketMissingStreak.deleteMany({
			where: {
				projectId: params.projectId,
				entityType: "TEST_CASE",
				entityId: params.testCaseId,
			},
		});
		return { applied: true };
	});
}

/**
 * `clearPmCreateClaim` for a test case with no PM link: Unlink & re-create on
 * a case whose create may have reached the PM tool but was never linked.
 * Clears only the claim the caller read; a claim taken since is kept. Only an
 * unlinked case in the project, not PENDING for a retry attempt, is touched,
 * and only once the claim is older than `PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS`
 * (a miss on its age alone is reported as `claimTooRecent`). Returns whether
 * it was cleared.
 */
export async function clearTestCasePmCreateClaim(params: {
	projectId: string;
	testCaseId: string;
	claimId: string;
}): Promise<{ cleared: boolean; claimTooRecent?: PmRecoveryClaimTooRecent }> {
	const baseWhere = {
		id: params.testCaseId,
		projectId: params.projectId,
		externalId: null,
		pmCreateClaimId: params.claimId,
		...NOT_PENDING_FOR_AN_ATTEMPT,
	};
	const cutoff = await pmCreateClaimRecoveryCutoff(db);
	const { count } = await db.testCase.updateMany({
		where: {
			...baseWhere,
			...recoverableClaimWhere(params.claimId, cutoff),
		},
		data: { pmCreateClaimId: null, pmCreateClaimedAt: null },
	});
	if (count === 1) {
		return { cleared: true };
	}
	const tooRecent = await claimTooRecent(
		(w) =>
			db.testCase.findFirst({
				where: w,
				select: { pmCreateClaimedAt: true },
			}),
		baseWhere,
	);
	return tooRecent
		? { cleared: false, claimTooRecent: tooRecent }
		: { cleared: false };
}
