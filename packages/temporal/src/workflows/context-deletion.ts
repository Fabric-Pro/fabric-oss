/**
 * Context Deletion Workflow
 *
 * A durable workflow for deleting project contexts (Notion pages, uploaded files, etc.)
 * from Qdrant and database. This workflow is triggered when:
 * - A Notion page is removed from a project
 * - An uploaded file is deleted
 * - Any project context is deleted
 *
 * Benefits of using Temporal:
 * - Automatic retries on transient failures (network errors, rate limits)
 * - Durability (survives server restarts)
 * - Visibility and monitoring
 * - Consistent error handling
 * - Audit trail for deletions
 */

import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { deleteSingleContextActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface ContextDeletionWorkflowInput {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	qdrantId?: string;
	/** Optional metadata for audit trail */
	metadata?: {
		contextType?: string;
		contextName?: string;
		deletedBy?: string;
		reason?: string;
	};
}

export interface ContextDeletionWorkflowOutput {
	success: boolean;
	contextId: string;
	qdrantDeleted: boolean;
	dbDeleted: boolean;
	error?: string;
}

/**
 * Workflow: Delete a project context from Qdrant and database
 *
 * This workflow provides durability and retry logic around the deletion activity.
 * It's designed to be fire-and-forget from API procedures, with the option to
 * await completion if needed.
 */
export async function contextDeletionWorkflow(
	input: ContextDeletionWorkflowInput,
): Promise<ContextDeletionWorkflowOutput> {
	const { contextId, projectId, userId, organizationId, qdrantId, metadata } =
		input;

	console.log(
		`[ContextDeletion] Starting deletion for context ${contextId}`,
		{
			projectId,
			contextType: metadata?.contextType,
			contextName: metadata?.contextName,
		},
	);

	try {
		const result = await deleteSingleContextActivity({
			contextId,
			projectId,
			userId,
			organizationId,
			qdrantId,
		});

		if (result.success) {
			console.log(
				`[ContextDeletion] Successfully deleted context ${contextId}`,
				{
					qdrantDeleted: result.qdrantDeleted,
					dbDeleted: result.dbDeleted,
				},
			);
		} else {
			console.log(
				`[ContextDeletion] Deletion failed for context ${contextId}: ${result.error}`,
			);
		}

		return {
			success: result.success,
			contextId,
			qdrantDeleted: result.qdrantDeleted,
			dbDeleted: result.dbDeleted,
			error: result.error,
		};
	} catch (error: unknown) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error(
			`[ContextDeletion] Workflow failed for context ${contextId}: ${errorMessage}`,
		);

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"CONTEXT_DELETION_FAILED",
		);
	}
}
