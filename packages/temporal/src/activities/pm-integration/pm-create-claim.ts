/**
 * The PM create claim on a story (`UserStory.pmCreateClaimId`) or a test
 * case (`TestCase.pmCreateClaimId`).
 *
 * A PM create for a row is sent only after the caller has taken the row's
 * claim with `acquirePmCreateClaim`, a conditional UPDATE that succeeds for
 * one caller only. Taken immediately before the create request, it is
 * cleared only by:
 *
 * 1. the link write that sets `externalId` (`updateStory` with
 *    `settlesPmCreateClaim`, scoped to the same claim);
 * 2. a definite rejection of the create by the PM tool
 *    (`releasePmCreateClaim`). A timeout, a thrown transport error, a crash
 *    or an unreadable response keeps it;
 * 3. the user's Unlink & re-create (`applyPmUnlink` / `clearPmCreateClaim`,
 *    and for a test case `applyTestCasePmUnlink` /
 *    `clearTestCasePmCreateClaim`), which clears only the claim value that
 *    request read;
 * 4. the user's Link to existing item (`applyPmLink`, for a story or a test
 *    case), which links the unlinked row to the PM item the user named after
 *    Fabric read it, and clears only the claim value that request read (it
 *    creates nothing).
 *
 * Both user recoveries (3 and 4) clear a held claim only once it is older
 * than `PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS` by the database clock. The
 * holder starts its send deadline (`startPmCreateSendDeadline`) before it
 * asks for the claim, the claim is stamped with the database clock after
 * that, and no create is handed to `fetch` past the deadline, so by then the
 * holder can no longer send its create (the argument and its assumptions
 * are on `PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS`). Its link write is fenced on
 * its own claim, so it cannot land after a recovery cleared that claim. A
 * request the PM tool already received can still complete on the tool's
 * side after Fabric gave up on it, leaving an item nobody links.
 *
 * A caller that cannot take the claim does not create. When the claim is
 * held (by another run, or by an earlier create, an earlier Temporal attempt
 * of this run included, that may have reached the PM tool without being
 * linked), it records `create_unconfirmed` instead
 * (`recordCreateUnconfirmed`). When the row has been linked since the caller
 * read it, there is nothing to create and nothing to record.
 */

import { randomUUID } from "node:crypto";
import { db, readDatabaseClock } from "@repo/database";
import { logger } from "@repo/logs";
import { dispatchDeadlineIn } from "@repo/utils/dispatch-deadline";
import type { ExecuteMcpToolOutput } from "../orchestrator/types";

/**
 * The longest after it starts asking for a row's create claim that a PM
 * create may still be sent. Every create sent under a claim starts this
 * deadline (`startPmCreateSendDeadline`) before `acquirePmCreateClaim` and
 * carries it to the send: `executeMcpTool`'s `dispatchDeadline`, or, on the
 * GitLab REST path, `callPmToolWithFallback`'s. Immediately before the
 * request is handed to `fetch` the monotonic clock is compared with it, and
 * past it nothing is sent: the create is reported as not sent
 * (`isCreateSendDeadlinePassed`), the claim is released and the failure is
 * reported with a message that offers a retry (`createDeadlinePassedMessage`).
 * Fabric stops waiting for a request still in flight at the deadline, on a
 * timer; that outcome is unconfirmed (the claim is kept), never a definite
 * rejection. The abort reaches STDIO and GitLab REST requests; on the HTTP
 * and SSE MCP transports it does not reach the underlying fetch, so the
 * request is abandoned on Fabric's side, not torn down, and may still
 * complete in the PM tool.
 *
 * Under the start-to-close of every workflow activity that sends a create
 * (`pm-create-activity-options.ts`; a test keeps them apart). The activity's
 * work before it asks for the claim counts against that start-to-close too,
 * so this does not by itself guarantee the activity reports the outcome
 * before Temporal times the attempt out; an attempt timed out that way keeps
 * its claim, and its retry finds the claim held (or the row linked) and
 * sends nothing. A user's recovery clears a
 * held claim only once it is older than `PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS`
 * (`@repo/database`), which is derived from this ceiling; a test keeps the
 * two apart.
 */
export const PM_CREATE_SEND_TIMEOUT_MS = 50_000;

/**
 * Start a create's send deadline: call it before `acquirePmCreateClaim`, so
 * the claim's database-clock stamp is read after it. A reading of this
 * process's monotonic clock; see `PM_CREATE_SEND_TIMEOUT_MS`.
 */
export function startPmCreateSendDeadline(): number {
	return dispatchDeadlineIn(PM_CREATE_SEND_TIMEOUT_MS);
}

/**
 * The `errorClass` for a create Fabric did not send or could not confirm,
 * because a PM item may already exist for the row.
 */
export const CREATE_UNCONFIRMED_ERROR_CLASS = "create_unconfirmed";

/**
 * The outcome of `acquirePmCreateClaim`: this caller took the claim, or it
 * did not, and why.
 *
 * - `linked`: the row's stored link is set (another run linked it since this
 *   one read the row). Nothing is to be created; this is not an unconfirmed
 *   create.
 * - `claimed`: the row is unlinked and its claim is held, by another run or
 *   by an earlier create whose outcome is unknown. A PM item may already
 *   exist; the caller records `create_unconfirmed`. `heldBy` is the claim
 *   read, so that record can be fenced on it (absent when the claim kept
 *   slipping between the UPDATE and the read).
 * - `missing`: the row is gone.
 */
export type PmCreateClaimAttempt =
	| { claimId: string }
	| {
			miss: "linked";
			externalId: string;
			externalUrl: string | null;
	  }
	| { miss: "claimed"; heldBy?: string }
	| { miss: "missing" };

/**
 * How many times a missed claim whose row reads as unlinked and unclaimed
 * (released between the conditional UPDATE and the read) is retried.
 */
const ACQUIRE_ATTEMPTS = 3;

/**
 * The row a claim is taken on: a story (`user_story`) or a test case
 * (`test_case`). The claim works the same way on both tables.
 */
export type PmCreateClaimRow = { storyId: string } | { testCaseId: string };

/** The claim columns and the link, as `acquirePmCreateClaim` reads them back. */
interface ClaimRowState {
	externalId: string | null;
	externalUrl: string | null;
	pmCreateClaimId: string | null;
	/** Test cases only: a soft-deleted case is never claimed. */
	deletedAt?: Date | null;
}

/**
 * The conditional claim UPDATE on the row's table. `pmCreateClaimedAt` is a
 * database-clock reading taken here, after the caller started its send
 * deadline, never this process's wall clock: a recovery compares it with the
 * same database clock (`PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS`).
 */
async function takeClaim(
	row: PmCreateClaimRow,
	claimId: string,
): Promise<number> {
	const data = {
		pmCreateClaimId: claimId,
		pmCreateClaimedAt: await readDatabaseClock(db),
	};
	if ("testCaseId" in row) {
		const { count } = await db.testCase.updateMany({
			where: {
				id: row.testCaseId,
				externalId: null,
				pmCreateClaimId: null,
				deletedAt: null,
			},
			data,
		});
		return count;
	}
	const { count } = await db.userStory.updateMany({
		where: { id: row.storyId, externalId: null, pmCreateClaimId: null },
		data,
	});
	return count;
}

async function readClaimRow(
	row: PmCreateClaimRow,
): Promise<ClaimRowState | null> {
	if ("testCaseId" in row) {
		return db.testCase.findUnique({
			where: { id: row.testCaseId },
			select: {
				externalId: true,
				externalUrl: true,
				pmCreateClaimId: true,
				deletedAt: true,
			},
		});
	}
	return db.userStory.findUnique({
		where: { id: row.storyId },
		select: { externalId: true, externalUrl: true, pmCreateClaimId: true },
	});
}

/** The row's id, for logs. */
function claimRowId(row: PmCreateClaimRow): string {
	return "testCaseId" in row ? row.testCaseId : row.storyId;
}

/**
 * Take the row's create claim. Resolves `{ claimId }` when this caller took
 * it, or the reason it did not (`PmCreateClaimAttempt`), read after the
 * UPDATE matched no row. Requires the stored `externalId` to be null, always
 * (and, on a test case, the case not to be soft-deleted: a deleted case
 * reads as `missing`). No automatic sync clears a link to reach this: only
 * the user's Unlink & re-create, or a "Push & relink" migration of a story
 * link stamped with another server (cleared only while the row still
 * carries that stamped link), does.
 *
 * The reason is read after the UPDATE, so it can be stale by the time the
 * caller acts on it; `claimed` is acted on only through
 * `recordCreateUnconfirmed`, whose write re-checks the row. A row read back
 * as unlinked and unclaimed (its claim released in between) is retried; if
 * it keeps slipping, `claimed` is returned and that write decides. A
 * database error propagates; no create has been sent then.
 */
export async function acquirePmCreateClaim(
	input: PmCreateClaimRow,
): Promise<PmCreateClaimAttempt> {
	for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
		const claimId = randomUUID();
		if ((await takeClaim(input, claimId)) === 1) {
			return { claimId };
		}
		const row = await readClaimRow(input);
		if (!row || (row.deletedAt ?? null) !== null) {
			return { miss: "missing" };
		}
		if (row.externalId !== null) {
			return {
				miss: "linked",
				externalId: row.externalId,
				externalUrl: row.externalUrl ?? null,
			};
		}
		if (row.pmCreateClaimId !== null) {
			return { miss: "claimed", heldBy: row.pmCreateClaimId };
		}
	}
	return { miss: "claimed" };
}

/**
 * Release this caller's claim after the PM tool definitely rejected the
 * create, or after the create was not sent because its send deadline had
 * passed, so a later push can create. Scoped to the claim id, so it never
 * clears a claim someone else has taken since. Best effort: a failed release
 * is logged and leaves the claim held (the user clears it with Unlink &
 * re-create, or with Link to existing item); it resolves `false` then, or
 * when the claim was no longer held.
 */
export async function releasePmCreateClaim(
	input: PmCreateClaimRow & { claimId: string },
): Promise<boolean> {
	const data = { pmCreateClaimId: null, pmCreateClaimedAt: null };
	try {
		const { count } =
			"testCaseId" in input
				? await db.testCase.updateMany({
						where: {
							id: input.testCaseId,
							pmCreateClaimId: input.claimId,
						},
						data,
					})
				: await db.userStory.updateMany({
						where: {
							id: input.storyId,
							pmCreateClaimId: input.claimId,
						},
						data,
					});
		return count === 1;
	} catch (error) {
		logger.warn("pm.sync.create_claim.release_failed", {
			itemId: claimRowId(input),
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

/**
 * Whether a failed MCP create was definitely not carried out, so its claim
 * may be released. Only a call refused before it was sent (`rejected`)
 * qualifies. An error result from the server does not: it says the server
 * reports a failure, not that nothing was created (a wrapper can report an
 * upstream timeout or 5xx this way, and its text carries no reliable status).
 * A held claim is recoverable (Unlink & re-create, or Link to existing
 * item); a duplicate is not.
 */
export function isDefiniteMcpCreateRejection(
	result: Pick<ExecuteMcpToolOutput, "success" | "failureKind">,
): boolean {
	return !result.success && result.failureKind === "rejected";
}

/**
 * Whether an MCP create was not sent because its send deadline
 * (`dispatchDeadline`) had passed: nothing was created, so its claim may be
 * released. A timeout of a request already sent is `indeterminate`, not
 * this.
 */
export function isCreateSendDeadlinePassed(
	result: Pick<ExecuteMcpToolOutput, "success" | "failureKind">,
): boolean {
	return !result.success && result.failureKind === "deadline_passed";
}

/** Errors the GitLab REST path raises before any request is sent. */
const GITLAB_NOT_SENT_ERROR_NAMES = new Set([
	"GitLabReauthRequiredError",
	"GitLabOriginNotAllowedError",
	"GitLabPmOriginMismatchError",
	"GitLabConnectionOriginChangedError",
]);

/** Messages `executeGitLabTool` throws when it has no usable token. */
const GITLAB_NO_TOKEN_MESSAGE =
	/^GitLab not connected\.|^GitLab access token expired and refresh failed\./;

/**
 * Whether a thrown GitLab REST create was definitely not carried out, so its
 * claim may be released: a 4xx answer from GitLab other than 408 (validation,
 * permission, not found, rate limit), or a refusal raised before any request
 * was sent (no token, origin checks, Read-only mode). A 5xx, a 408, a network
 * error and anything unrecognised keep the claim.
 */
export function isDefiniteGitLabCreateRejection(
	error: unknown,
	readOnlyMessage: string,
): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const status = (error as { status?: unknown }).status;
	if (error.name === "GitLabApiError" && typeof status === "number") {
		return status >= 400 && status < 500 && status !== 408;
	}
	if (GITLAB_NOT_SENT_ERROR_NAMES.has(error.name)) {
		return true;
	}
	// `callPmToolWithFallback` refuses before sending, as non-retryable
	// ApplicationFailures: an origin mismatch, or Read-only mode.
	const failureType = (error as { type?: unknown }).type;
	if (failureType === "GitLabPmOriginMismatch") {
		return true;
	}
	if (error.message === readOnlyMessage) {
		return true;
	}
	return GITLAB_NO_TOKEN_MESSAGE.test(error.message);
}

/**
 * The FAILED message for a create Fabric did not send because the row's
 * claim is held: an earlier create may have reached the PM tool.
 */
export function claimHeldMessage(toolLabel: string): string {
	return `Fabric did not create this item in ${toolLabel}: an earlier push sent a create that Fabric could not confirm or link, so a ${toolLabel} item may already exist for it. Check ${toolLabel}; if there is none, use Unlink & re-create.`;
}

/**
 * The FAILED message for a create Fabric did not send because its send
 * deadline (`PM_CREATE_SEND_TIMEOUT_MS`) passed before the request went out:
 * nothing was created and the claim was released, so a retry may create.
 * It names no recovery action: the failure panel offers a retry for it.
 */
export function createDeadlinePassedMessage(toolLabel: string): string {
	return `Fabric did not send the create to ${toolLabel}: getting ready to send it took longer than Fabric allows, so it stopped before sending anything, and nothing was created in ${toolLabel}. Sync again to retry.`;
}

/**
 * The FAILED message for a create that was sent but did not confirm the
 * outcome: no answer, or an error answer that does not prove nothing was
 * created.
 */
export function createIndeterminateMessage(
	toolLabel: string,
	detail: string,
): string {
	const trimmed = detail.trim().slice(0, 200);
	return `The create request to ${toolLabel} failed${
		trimmed ? ` (${trimmed})` : ""
	}, and Fabric cannot tell whether ${toolLabel} created the item anyway, so a ${toolLabel} item may already exist for it. Check ${toolLabel}; if there is none, fix the cause if needed and use Unlink & re-create.`;
}
