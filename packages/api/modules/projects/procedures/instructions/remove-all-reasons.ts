import type { RemoveAllInstructionsRefusal } from "@repo/database";

/**
 * The `data.reason` a refused "remove coding instructions" carries on the
 * wire, and the one its preview names as `blockedBy`, so the confirmation and
 * the refusal speak of the same state in the same words.
 */
export const REMOVAL_CONFLICT_REASON = {
	repository_mode: "REPOSITORY_MODE",
	migration_open: "MIGRATION_OPEN",
	active: "SNAPSHOT_ACTIVE",
	pull_request_unresolved: "PULL_REQUEST_UNRESOLVED",
	proposal_pending: "PROPOSAL_PENDING",
} as const satisfies Record<
	Exclude<RemoveAllInstructionsRefusal, "not_found">,
	string
>;
