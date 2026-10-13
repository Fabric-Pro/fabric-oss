import { db } from "../client";
import type { Prisma } from "../generated/client";
import {
	pmCreateClaimRecoverableAt,
	pmCreateClaimRecoveryCutoff,
	recoverableClaimWhere,
} from "./pm-create-claim-recovery";

/**
 * The row is not PENDING, with or without an attempt id: a push may be
 * running on it. NULL-safe (`status <> x` is never true for NULL in SQL,
 * hence the explicit NULL arm). Stricter than the unlink helpers'
 * `NOT_PENDING_FOR_AN_ATTEMPT`, which lets a PENDING row with no attempt id
 * through.
 */
const NOT_PENDING = {
	OR: [
		{ lastPmSyncStatus: null },
		{ lastPmSyncStatus: { not: "PENDING" as const } },
	],
};

/** The row Link to existing item writes: a story or a test case. */
export type ApplyPmLinkRow = { storyId: string } | { testCaseId: string };

export type ApplyPmLinkParams = ApplyPmLinkRow & {
	projectId: string;
	/**
	 * The PM create claim the caller read with the row (`null`: none). The
	 * link applies only while the row still holds exactly this claim and, a
	 * held one, only once it is older than
	 * `PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS`.
	 */
	expectedPmCreateClaimId: string | null;
	/** The PM item's id, in the form the create path stores for the tool. */
	externalId: string;
	externalUrl: string | null;
	/** The server stamp the create path writes for this project and entity. */
	externalMcpServerId: string | null;
};

/**
 * Why a link write matched no row, read back after it:
 *
 * - `missing`: the row is gone (or, for a test case, soft-deleted).
 * - `linked`: the row has a PM link now.
 * - `pending`: the row is PENDING (a push may be running on it).
 * - `claim-changed`: the row holds another create claim than the one read
 *   (a push took one, or Unlink & re-create cleared it).
 * - `claim-too-recent`: the row still holds the claim read, but it is
 *   younger than `PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS` (or has no
 *   timestamp): its holder may still be sending the create. Carries
 *   `recoverableAt`.
 * - `changed`: none of the above any more; the row moved back between the
 *   write and this read. Nothing was written.
 */
export type ApplyPmLinkStaleReason =
	| "missing"
	| "linked"
	| "pending"
	| "claim-changed"
	| "claim-too-recent"
	| "changed";

export type ApplyPmLinkResult =
	| { status: "linked" }
	| {
			status: "stale";
			reason: Exclude<ApplyPmLinkStaleReason, "claim-too-recent">;
	  }
	| {
			status: "stale";
			reason: "claim-too-recent";
			/** When the claim becomes clearable; `null` when unknown. */
			recoverableAt: Date | null;
	  }
	/**
	 * Another row in the project is linked to this PM item (the partial
	 * unique index on `(projectId, externalId)`). `otherIdentifier` names it
	 * when it could be read; for a test case it may be a soft-deleted one,
	 * which the index still counts.
	 */
	| { status: "taken"; otherIdentifier: string | null };

/** Prisma's unique-violation code. */
function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "P2002"
	);
}

/**
 * "Link to existing item": link an unlinked story or test case to a PM item
 * that already exists (the one an unconfirmed create made), and drop the
 * create claim the caller read. Nothing is sent to the PM tool.
 *
 * One conditional UPDATE is the check-then-act guard: it applies only while
 * the row is in the project, unlinked, holds exactly the claim read (`null`
 * included: an unlinked, unclaimed row may be linked too) and old enough to
 * clear (below), is not PENDING (`NOT_PENDING`) and, for a test case, is
 * not soft-deleted. It sets the
 * link and its server stamp, clears the claim, the drift baseline (nothing
 * was pushed, so there is none) and the failure the unconfirmed create
 * left. `lastSyncedAt` and, for a story, its PM status merge base and
 * terminal/hidden flags keep their unlinked values.
 *
 * A held claim is cleared only once it is older than
 * `PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS` (database clock), past the latest a
 * create's holder can still send it (`PM_CREATE_SEND_TIMEOUT_MS`; the
 * argument, its assumptions and its limits are on the bound). A request the
 * PM tool already received can still complete on its side after Fabric gave
 * up on it; that item is not linked by anyone.
 *
 * The same transaction applies `updateStory`'s link-identity side effects:
 * the row's missing-streak rows are deleted and a PENDING FLAG_MISSING
 * proposal for it is dismissed, so no missing state from an earlier link
 * reaches the new one.
 *
 * Matching no row reads the row back for the reason (`stale`); another row
 * already linked to the item is `taken`. Neither writes anything.
 */
export async function applyPmLink(
	params: ApplyPmLinkParams,
): Promise<ApplyPmLinkResult> {
	const isTestCase = "testCaseId" in params;
	const entityId = isTestCase ? params.testCaseId : params.storyId;
	const entityType = isTestCase ? "TEST_CASE" : "STORY";
	const data = {
		externalId: params.externalId,
		externalUrl: params.externalUrl,
		externalMcpServerId: params.externalMcpServerId,
		pmCreateClaimId: null,
		pmCreateClaimedAt: null,
		lastSyncedPmHash: null,
		lastPmSyncStatus: null,
		lastPmSyncError: null,
	};
	const where = {
		id: entityId,
		projectId: params.projectId,
		externalId: null,
		pmCreateClaimId: params.expectedPmCreateClaimId,
		...NOT_PENDING,
	};

	let applied: boolean;
	try {
		applied = await db.$transaction(
			async (tx: Prisma.TransactionClient) => {
				const aged =
					params.expectedPmCreateClaimId === null
						? where
						: {
								...where,
								...recoverableClaimWhere(
									params.expectedPmCreateClaimId,
									await pmCreateClaimRecoveryCutoff(tx),
								),
							};
				const { count } = isTestCase
					? await tx.testCase.updateMany({
							where: { ...aged, deletedAt: null },
							data,
						})
					: await tx.userStory.updateMany({ where: aged, data });
				if (count !== 1) {
					return false;
				}
				await tx.pmTicketMissingStreak.deleteMany({
					where: {
						projectId: params.projectId,
						entityType,
						entityId,
					},
				});
				await tx.pendingPmStateChange.updateMany({
					where: {
						projectId: params.projectId,
						entityType,
						entityId,
						status: "PENDING",
						proposedAction: "FLAG_MISSING",
					},
					data: { status: "DISMISSED" },
				});
				return true;
			},
		);
	} catch (error) {
		// The only unique index the write can hit is the partial
		// `(projectId, externalId)` one: the item is linked to another row.
		if (!isUniqueViolation(error)) {
			throw error;
		}
		return {
			status: "taken",
			otherIdentifier: await readOtherIdentifier(params, isTestCase),
		};
	}
	if (applied) {
		return { status: "linked" };
	}
	return { status: "stale", ...(await readStaleReason(params)) };
}

async function readOtherIdentifier(
	params: ApplyPmLinkParams,
	isTestCase: boolean,
): Promise<string | null> {
	const where = {
		projectId: params.projectId,
		externalId: params.externalId,
	};
	const other = isTestCase
		? await db.testCase.findFirst({ where, select: { identifier: true } })
		: await db.userStory.findFirst({
				where,
				select: { identifier: true },
			});
	return other?.identifier ?? null;
}

async function readStaleReason(
	params: ApplyPmLinkParams,
): Promise<
	| { reason: Exclude<ApplyPmLinkStaleReason, "claim-too-recent"> }
	| { reason: "claim-too-recent"; recoverableAt: Date | null }
> {
	const select = {
		externalId: true,
		pmCreateClaimId: true,
		pmCreateClaimedAt: true,
		lastPmSyncStatus: true,
	};
	const row =
		"testCaseId" in params
			? await db.testCase.findFirst({
					where: {
						id: params.testCaseId,
						projectId: params.projectId,
					},
					select: { ...select, deletedAt: true },
				})
			: await db.userStory.findFirst({
					where: { id: params.storyId, projectId: params.projectId },
					select,
				});
	if (!row || ("deletedAt" in row && row.deletedAt !== null)) {
		return { reason: "missing" };
	}
	if (row.externalId !== null) {
		return { reason: "linked" };
	}
	if (row.lastPmSyncStatus === "PENDING") {
		return { reason: "pending" };
	}
	if (row.pmCreateClaimId !== params.expectedPmCreateClaimId) {
		return { reason: "claim-changed" };
	}
	// The claim read is still held and nothing else stood in the way: the
	// write missed on its age (it can also have aged past the bound since).
	if (row.pmCreateClaimId !== null) {
		return {
			reason: "claim-too-recent",
			recoverableAt: pmCreateClaimRecoverableAt(row.pmCreateClaimedAt),
		};
	}
	return { reason: "changed" };
}
