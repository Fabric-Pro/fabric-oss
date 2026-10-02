import type { RepositorySyncFollowUpSubject } from "@repo/instructions/workflow-ids";

/**
 * What the follow-up workflow is started with: the repository sync it waits
 * on and then starts, and the member whose "Sync now" it stands for. Pure, so
 * the workflow sandbox can import it.
 */
export type RepositorySyncFollowUpInput = {
	subject: RepositorySyncFollowUpSubject;
	projectId: string;
	organizationId: string;
	/** The member whose configure queued it; the run acts as them. */
	requesterUserId: string;
};

/**
 * How the wait for the open run ended. `closed` is the only answer that
 * lets the follow-up start its run.
 */
export type RepositorySyncClosedResult = { closed: boolean };

/** What starting the queued run reached. */
export type RepositorySyncFollowUpOutcome =
	| "started"
	| "already_running"
	| "not_configured"
	| "integration_unavailable";

/**
 * How many waits of `REPOSITORY_SYNC_FOLLOW_UP_WAIT_MS` the follow-up spends
 * on an open run before it gives up: about forty minutes, which is longer than
 * the sync's own twenty-minute activity bound plus its retries. A run that is
 * still open after that is not one a configure fenced, and starting beside it
 * would only be refused.
 */
export const REPOSITORY_SYNC_FOLLOW_UP_MAX_WAITS = 40;

/** One wait of the follow-up's loop, inside a single activity attempt. */
export const REPOSITORY_SYNC_FOLLOW_UP_WAIT_MS = 55_000;
