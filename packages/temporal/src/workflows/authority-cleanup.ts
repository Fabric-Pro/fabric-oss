/**
 * Authority Cleanup Workflow
 *
 * Temporal scheduled workflow that periodically expires authority sessions
 * and grants that have passed their TTL. Should be registered as a
 * Temporal Schedule running every 1-2 minutes.
 *
 * Registration (via Temporal CLI or setup script):
 *   temporal schedule create \
 *     --schedule-id authority-cleanup \
 *     --workflow-id authority-cleanup \
 *     --task-queue workflow-builder \
 *     --workflow-type authorityCleanupWorkflow \
 *     --interval 60s
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/authority-cleanup";

const { expireAuthoritySessionsActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30 seconds",
	retry: {
		maximumAttempts: 2,
	},
});

/**
 * Cleanup workflow — expires stale authority sessions and grants.
 */
export async function authorityCleanupWorkflow(): Promise<{
	expiredSessions: number;
	expiredGrants: number;
}> {
	return await expireAuthoritySessionsActivity();
}
