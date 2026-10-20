/**
 * Proposal export cleanup (Fizzy #2946), scheduled daily from
 * `schedules.ts`. Delegates to `cleanupExpiredProposalExportsActivity`; the
 * body does no I/O, reads no clock and no environment, so replay stays
 * deterministic.
 *
 * `maximumAttempts: 1`: the daily schedule is the retry, and a single
 * attempt keeps each sweep's deletion budget a real bound.
 *
 * A sweep that stops at its deletion cap is followed by another, up to
 * `MAX_SWEEPS` a day. Each lists the prefix from its start again, past the
 * objects the sweep before it deleted, so a day with more expired exports
 * than one sweep deletes never leaves later projects' files behind.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/proposal-export/cleanup-exports";

const { cleanupExpiredProposalExportsActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "30 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		maximumAttempts: 1,
	},
});

/** Sweeps one daily run makes at most. */
const MAX_SWEEPS = 20;

export async function proposalExportCleanupWorkflow(): Promise<
	activities.CleanupProposalExportsResult[]
> {
	const sweeps: activities.CleanupProposalExportsResult[] = [];
	for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
		const result = await cleanupExpiredProposalExportsActivity();
		sweeps.push(result);
		if (!result.hitDeletionCap) {
			break;
		}
	}
	return sweeps;
}
