/**
 * Recording an orphaned create: the PM tool created the ticket, but Fabric
 * could not link the row to it (the create response carried no readable id,
 * or the link write failed). Also recording an unconfirmed create
 * (`create_unconfirmed`): a create Fabric did not send because the row's
 * create claim was held, or one it sent that got no definite answer. In
 * both cases the row keeps its create claim (`pm-create-claim.ts`), which is
 * what stops any later push from creating again.
 *
 * The sync activity must return its `create_orphan` FAILED result from here
 * on, whatever happens to the recording. A throw would be retried by
 * Temporal (the story workflow gives `syncWorkItemToPM` 5 attempts), and with
 * the row still unlinked every retry takes the CREATE branch again: one more
 * ticket each time. So the recording is best effort: both functions here
 * catch their own errors.
 */

import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { CREATE_UNCONFIRMED_ERROR_CLASS } from "./pm-create-claim";
import {
	describeOrphanCause,
	isDatabaseError,
	prismaErrorCode,
} from "./pm-sync-user-error";
import {
	type PmSyncItemType,
	recordPmSyncFailure,
	recordPmSyncFailureLog,
} from "./record-pm-sync-state";

export { describeOrphanCause, prismaErrorCode } from "./pm-sync-user-error";

/**
 * The failed link write's cause, for the user-visible message. Leaves out
 * message text for recognised Prisma client and driver adapter errors; other
 * errors contribute their first line only, capped at 200 characters.
 * The full error is for the log only.
 */
export function describeLinkWriteCause(
	error: unknown,
	itemNoun: string,
): string {
	const code = prismaErrorCode(error);
	if (code === "P2002") {
		return `another ${itemNoun} in this project is already linked to that item`;
	}
	if (code) {
		return `database error ${code}`;
	}
	if (isDatabaseError(error)) {
		return "database error";
	}
	return (
		describeOrphanCause(error)
			.trim()
			.split("\n")[0]
			?.trim()
			.slice(0, 200) || "unknown error"
	);
}

/**
 * Stamp FAILED (`create_orphan`) by id, with its audit row, best effort.
 *
 * By id (`overridePendingAttempt`), not scoped to the run's attempt and not
 * kept off a PENDING attempt: the FAILED records that an unlinked ticket
 * exists, and it is what keeps the stuck-sync watchdog from retrying the row
 * into a second ticket, so a newer attempt's PENDING must not make it skip.
 * Resolves in every case; a failed recording is logged.
 */
export async function recordCreateOrphan(
	input: RecordCreateFailureInput,
): Promise<void> {
	await recordCreateFailure(input, "create_orphan");
}

/**
 * Log a `create_orphan` to the sync log only, naming the orphaned item
 * (`link`), with no write to the row: the row's status is not this
 * create's (the row carries a link this create cannot prove is its own, or
 * no longer holds this create's claim). Resolves in every case
 * (`recordPmSyncFailureLog` catches its own errors).
 */
export async function logCreateOrphanBesideOtherLink(
	input: RecordCreateFailureInput & { link: CreatedItemRefs },
): Promise<void> {
	await recordPmSyncFailureLog({ ...input, errorClass: "create_orphan" });
}

/** A created item's refs, as far as the create response gave them. */
interface CreatedItemRefs {
	externalId: string | null;
	externalUrl: string | null;
}

/**
 * The bulk create's `create_orphan` (`createStoryInPmWithClaim`), which
 * knows the claim it took. FAILED is stamped, with its audit row, only
 * while the row is unlinked and still holds `claimId`, checked in the same
 * conditional UPDATE (`onlyIfCreateClaimHeld` with `onlyIfCreateClaimId`).
 * Otherwise (the row was linked, or Unlink & re-create cleared this claim,
 * or the write failed) the row's status is not this create's to stamp, and
 * the orphan goes to the sync log only, naming `link`. Resolves whether
 * the row was stamped, in every case.
 */
export async function recordClaimedCreateOrphan(
	input: RecordCreateFailureInput & {
		claimId: string;
		link: CreatedItemRefs;
	},
): Promise<boolean> {
	const { claimId, link, ...failure } = input;
	const stamped = await recordCreateFailure(failure, "create_orphan", {
		onlyIfCreateClaimHeld: true,
		onlyIfCreateClaimId: claimId,
	});
	if (!stamped) {
		await logCreateOrphanBesideOtherLink({ ...failure, link });
	}
	return stamped;
}

/**
 * What `recordCreateUnconfirmed` found: `recorded` (FAILED stamped, or the
 * recording threw and was logged), or `linked` (the row has been linked since
 * the caller's claim attempt, so nothing was written: there is no
 * unconfirmed create to report), or `not-recorded` (the row is unlinked but
 * its claim is no longer held, or is gone).
 */
export type CreateUnconfirmedRecording =
	| { outcome: "recorded" }
	| { outcome: "linked"; externalId: string; externalUrl: string | null }
	| { outcome: "not-recorded" };

/**
 * Stamp FAILED (`create_unconfirmed`), with its audit row, best effort.
 * The write applies only while the row is unlinked and its create claim is
 * held (`onlyIfCreateClaimHeld`, in the same conditional UPDATE): the stamp
 * says a ticket may already exist, which is true only then. Within that,
 * it is by id (`overridePendingAttempt`) for the same reason as
 * `recordCreateOrphan`: a ticket may already exist, so a newer attempt's
 * PENDING must not hide the failure. Unlike after an orphan, the story
 * workflow then clears only this run's own PENDING: a PENDING stamped after
 * this write belongs to a newer push and is kept. When the write did not
 * apply, the row is read once to tell a linked row (a benign outcome for
 * the caller) from the rest. Resolves in every case.
 */
export async function recordCreateUnconfirmed(
	input: RecordCreateFailureInput & {
		/**
		 * Narrows the fence to this claim (`onlyIfCreateClaimId`): the claim
		 * the caller took, or the one it saw held. A claim another create
		 * took since is not stamped. Unset: any held claim.
		 */
		claimId?: string;
	},
): Promise<CreateUnconfirmedRecording> {
	const { claimId, ...failure } = input;
	const wrote = await recordCreateFailure(
		failure,
		CREATE_UNCONFIRMED_ERROR_CLASS,
		{
			onlyIfCreateClaimHeld: true,
			...(claimId !== undefined ? { onlyIfCreateClaimId: claimId } : {}),
		},
	);
	if (wrote) {
		return { outcome: "recorded" };
	}
	try {
		const row =
			input.itemType === "story" || input.itemType === "bug"
				? await db.userStory.findUnique({
						where: { id: input.itemId },
						select: { externalId: true, externalUrl: true },
					})
				: input.itemType === "testCase"
					? await db.testCase.findUnique({
							where: { id: input.itemId },
							select: { externalId: true, externalUrl: true },
						})
					: null;
		if (row?.externalId) {
			logger.info("pm.sync.create_unconfirmed.skipped", {
				itemId: input.itemId,
				itemType: input.itemType,
				reason: "linked",
			});
			return {
				outcome: "linked",
				externalId: row.externalId,
				externalUrl: row.externalUrl ?? null,
			};
		}
	} catch (error) {
		logger.warn("pm.sync.create_unconfirmed.read_failed", {
			itemId: input.itemId,
			itemType: input.itemType,
			error: describeOrphanCause(error),
		});
	}
	return { outcome: "not-recorded" };
}

interface RecordCreateFailureInput {
	itemId: string;
	itemType: PmSyncItemType;
	errorMessage: string;
	triggerSource: "ai-update" | "manual-edit" | "retry";
	pmTool?: string;
	actorUserId?: string | null;
}

/**
 * Resolves `false` only when a fence kept the write off the row (the
 * recording resolved `false`); a failed recording is logged and counts as
 * attempted.
 */
async function recordCreateFailure(
	input: RecordCreateFailureInput,
	errorClass: string,
	fence: {
		onlyIfCreateClaimHeld?: boolean;
		onlyIfCreateClaimId?: string;
	} = {},
): Promise<boolean> {
	try {
		const wrote = await recordPmSyncFailure({
			...input,
			errorClass,
			overridePendingAttempt: true,
			...fence,
		});
		return wrote !== false;
	} catch (error) {
		logger.warn(`pm.sync.${errorClass}.record_failed`, {
			itemId: input.itemId,
			itemType: input.itemType,
			error: describeOrphanCause(error),
		});
		return true;
	}
}
