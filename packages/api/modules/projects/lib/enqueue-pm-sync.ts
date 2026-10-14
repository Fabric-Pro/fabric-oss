import { getTemporalClient } from "@repo/temporal";
import {
	type EnqueuePmSyncInput,
	type EnqueuePmSyncResult,
	enqueuePmSyncCore,
} from "@repo/temporal/enqueue-pm-sync-core";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

export type { EnqueuePmSyncInput, EnqueuePmSyncResult };

/**
 * Mark the hierarchy item PENDING and start `pmSyncSingleStoryWorkflow`
 * fire-and-forget. Skips silently when the item has no `externalId` (unless
 * `forceInitialPush` is set) or the project has no PM integration configured.
 * Procedure callers must NOT await activity completion.
 *
 * The implementation lives in `@repo/temporal` (`enqueuePmSyncCore`) so the
 * stuck-sync watchdog, which runs on a Temporal worker, enqueues through the
 * same MCP-config resolution. This wrapper supplies the API's Temporal client
 * and the request's correlation memo.
 *
 * A start that throws is reconciled by describing its workflow id: no such
 * workflow (or a closed one) marks the item FAILED (`reason:
 * "temporal-error"`), a running one returns `enqueued: true`, and a describe
 * that cannot answer leaves the item PENDING (`reason: "start-uncertain"`) for
 * the stuck-sync watchdog. Only a client that could not be acquired marks
 * FAILED without a describe.
 */
export function enqueuePmSync(
	input: EnqueuePmSyncInput,
): Promise<EnqueuePmSyncResult> {
	return enqueuePmSyncCore({
		...input,
		getTemporalClient,
		decorateStartOptions: withCorrelationMemo,
	});
}
