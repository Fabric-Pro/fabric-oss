/**
 * Project Contexts Reprocess Workflow
 *
 * Re-processes all project contexts with updated RAG settings.
 * This workflow:
 * 1. Fetches all contexts for a project
 * 2. Validates RAG provider configuration (prevents data loss)
 * 3. Deletes existing embeddings from Qdrant
 * 4. Re-chunks and re-embeds using new RAG settings
 * 5. Updates database with new embedding info
 *
 * Use this when RAG settings (chunk size, overlap, strategy) change
 * and you want existing documents to use the new settings.
 */

import { ApplicationFailure, log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const {
	validateRAGProviderConfig,
	fetchProjectContextsForReprocess,
	deleteProjectContextsFromQdrant,
	reembedProjectContext,
	updateReprocessProgress,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "10 minutes", // Allow longer for large projects
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface ProjectContextsReprocessInput {
	projectId: string;
	userId: string;
	organizationId?: string;
}

export interface ProjectContextsReprocessOutput {
	success: boolean;
	totalContexts: number;
	processedCount: number;
	failedCount: number;
	error?: string;
}

/**
 * Workflow: Re-process all project contexts with new RAG settings
 *
 * This is a durable workflow that can handle large projects by:
 * - Processing contexts in batches
 * - Providing progress updates
 * - Resuming from failures
 */
export async function projectContextsReprocessWorkflow(
	input: ProjectContextsReprocessInput,
): Promise<ProjectContextsReprocessOutput> {
	const { projectId, userId, organizationId } = input;

	log.info("Starting project contexts reprocess workflow", {
		projectId,
		userId,
		organizationId,
	});

	try {
		// Step 1: Fetch all contexts for the project
		log.info("Fetching project contexts");
		const contexts = await fetchProjectContextsForReprocess({
			projectId,
			userId,
			organizationId,
		});

		if (contexts.length === 0) {
			log.info("No contexts to reprocess");
			return {
				success: true,
				totalContexts: 0,
				processedCount: 0,
				failedCount: 0,
			};
		}

		log.info(`Found ${contexts.length} contexts to reprocess`);

		// Step 2: Validate RAG provider config BEFORE deleting embeddings
		// This prevents data loss if AI provider is not configured
		log.info("Validating RAG provider configuration");
		await validateRAGProviderConfig({ userId, organizationId });

		// Step 3: Delete all existing embeddings from Qdrant
		// Safe to delete now that we've validated we can re-embed
		log.info("Deleting existing embeddings from Qdrant");
		await deleteProjectContextsFromQdrant({
			projectId,
			organizationId,
		});

		// Step 4: Re-embed each context with new RAG settings
		let processedCount = 0;
		let failedCount = 0;

		for (const context of contexts) {
			try {
				log.info(
					`Processing context ${context.id} (${processedCount + 1}/${contexts.length})`,
				);

				await reembedProjectContext({
					contextId: context.id,
					projectId,
					userId,
					organizationId,
					content: context.content,
					type: context.type,
					metadata: {
						originalFilename: context.originalFilename,
						sourceUrl: context.sourceUrl,
						sourceTitle: context.sourceTitle,
					},
				});

				processedCount++;

				// Update progress every 5 contexts
				if (processedCount % 5 === 0) {
					await updateReprocessProgress({
						projectId,
						totalContexts: contexts.length,
						processedCount,
						failedCount,
					});
				}
			} catch (error) {
				log.error(`Failed to process context ${context.id}`, { error });
				failedCount++;
			}
		}

		// Final progress update
		await updateReprocessProgress({
			projectId,
			totalContexts: contexts.length,
			processedCount,
			failedCount,
		});

		log.info("Reprocess workflow completed", {
			totalContexts: contexts.length,
			processedCount,
			failedCount,
		});

		return {
			success: failedCount === 0,
			totalContexts: contexts.length,
			processedCount,
			failedCount,
		};
	} catch (error: any) {
		log.error("Reprocess workflow failed", { error });
		const errorMessage = error.message || "Unknown error";
		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"PROJECT_CONTEXTS_REPROCESS_FAILED",
		);
	}
}
