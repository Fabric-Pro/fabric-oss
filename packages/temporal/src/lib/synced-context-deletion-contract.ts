/**
 * The contract of `syncedContextDeletionWorkflow` (Fizzy #2636) with the API
 * that starts it and waits for its answer: its input, its answer, and the
 * failure types it fails with. The workflow, not the API, records the
 * deletion in the audit log, in the row delete's own transaction, and
 * publishes it to the realtime channels.
 *
 * Kept apart from the workflow module so the API can import the failure
 * types without loading workflow code. Types from the activities are
 * type-only imports and erase.
 */

import type { SyncedContextDeletionAuditContext } from "@repo/database";
import type {
	ClaimedSyncedContext,
	SyncedContextDeletionActivityInput,
	SyncedContextStoredVersion,
} from "../activities/synced-context-deletion";

/**
 * Where the API starts the workflow and where it starts the embedding that
 * rebuilds a survivor's index: the queue the Context tab's own deletion and
 * embedding workflows use.
 */
export const SYNCED_CONTEXT_DELETION_TASK_QUEUE = "project-documents";

/**
 * `ApplicationFailure.type` of each step's failure, once Temporal's retries
 * are spent, so the API can say what was and was not done:
 *  - `claim`: nothing was changed beyond, at most, the row being marked
 *    unindexed;
 *  - `indexCleanup`: the row was not deleted (its points may be partly
 *    gone; it is marked unindexed);
 *  - `rowDelete`: the points were removed and the row is still there,
 *    marked unindexed.
 */
export const SYNCED_CONTEXT_DELETION_FAILURE = {
	claim: "SYNCED_CONTEXT_CLAIM_FAILED",
	indexCleanup: "SYNCED_CONTEXT_INDEX_CLEANUP_FAILED",
	rowDelete: "SYNCED_CONTEXT_ROW_DELETE_FAILED",
} as const;

/**
 * The version to delete, plus what the audit row the delete commits with
 * records. Persisted in the workflow's history, so plain values only: never
 * headers, cookies or tokens.
 */
export interface SyncedContextDeletionWorkflowInput
	extends SyncedContextDeletionActivityInput {
	/**
	 * This delete's operation id: a UUID the API generates for each request.
	 * The workflow id is `synced-context-deletion-<contextId>-<operationId>`,
	 * so no two requests share a run. The audit row stores it as
	 * `metadata.operationId`, and a repeated row delete finds its own
	 * committed attempt by it; a concurrent delete of the same row by another
	 * request finds no receipt of ITS id and answers `absent`.
	 */
	operationId: string;
	/** The request the delete came from, sanitized for the audit row. */
	audit: SyncedContextDeletionAuditContext;
}

export type SyncedContextDeletionWorkflowOutput =
	| { status: "deleted"; context: ClaimedSyncedContext }
	| { status: "absent" }
	| { status: "conflict"; current: SyncedContextStoredVersion };
