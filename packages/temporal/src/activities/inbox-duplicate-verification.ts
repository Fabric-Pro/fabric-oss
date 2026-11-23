/**
 * Temporal activity for the Proposal Inbox's duplicate verifier: a thin
 * wrapper over `verifyInboxDuplicatePairs`, run by the
 * `verifyInboxDuplicatesWorkflow`. The function throws when every pair it
 * tried failed, so the activity is retried with backoff.
 */

import {
	type VerifyInboxDuplicatesParams,
	type VerifyInboxDuplicatesResult,
	verifyInboxDuplicatePairs,
} from "../lib/inbox-duplicate-verification";

export type {
	VerifyInboxDuplicatesParams,
	VerifyInboxDuplicatesResult,
} from "../lib/inbox-duplicate-verification";

export async function verifyInboxDuplicatesActivity(
	params: VerifyInboxDuplicatesParams,
): Promise<VerifyInboxDuplicatesResult> {
	return verifyInboxDuplicatePairs(params);
}
