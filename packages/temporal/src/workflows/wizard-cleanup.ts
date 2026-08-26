/**
 * Workflow for cleaning up expired wizard temp contexts
 *
 * This workflow is designed to be run on a schedule (hourly) to clean up
 * temporary file uploads from the project creation wizard that have expired.
 *
 * Schedule this workflow using Temporal's Schedule feature:
 * - Schedule ID: wizard-temp-cleanup
 * - Cron: 0 * * * * (every hour)
 */

import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { cleanupWizardTempContextsActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "5m",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface WizardCleanupWorkflowInput {
	/** Optional: batch size for deletion (default: 100) */
	batchSize?: number;
}

export interface WizardCleanupWorkflowOutput {
	deletedCount: number;
	deletedIds: string[];
	errors: string[];
}

/**
 * Cleanup workflow for expired wizard temp contexts
 *
 * This workflow:
 * 1. Queries for expired temp contexts (expiresAt < now)
 * 2. Deletes associated S3 files
 * 3. Removes database records
 *
 * The workflow is idempotent and safe to run multiple times.
 */
export async function wizardCleanupWorkflow(
	input: WizardCleanupWorkflowInput = {},
): Promise<WizardCleanupWorkflowOutput> {
	log.info("Starting wizard temp context cleanup", {
		batchSize: input.batchSize || 100,
	});

	const result = await cleanupWizardTempContextsActivity({
		batchSize: input.batchSize,
	});

	if (result.errors.length > 0) {
		log.warn("Wizard cleanup completed with errors", {
			deletedCount: result.deletedCount,
			errorCount: result.errors.length,
			errors: result.errors.slice(0, 5), // Log first 5 errors
		});
	} else {
		log.info("Wizard cleanup completed successfully", {
			deletedCount: result.deletedCount,
		});
	}

	return result;
}
