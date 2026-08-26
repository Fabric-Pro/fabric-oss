/**
 * Temporal activity for binding wizard embeddings to a project
 *
 * When a project is created from the wizard, this activity updates
 * the Qdrant payloads to bind the embeddings to the new project.
 *
 * This is more efficient than re-embedding since the vectors don't change -
 * we just update the metadata to point to the project instead of the session.
 */

import { logger } from "@repo/logs";
import { bindWizardEmbeddingsToProject } from "@repo/rag";

export interface BindWizardEmbeddingsInput {
	/** Wizard session ID */
	sessionId: string;
	/** Newly created project ID */
	projectId: string;
	/** Map of WizardTempContext.id -> ProjectContext.id */
	contextIdMapping: Record<string, string>;
	/** User ID */
	userId: string;
	/** Organization ID (null for personal) */
	organizationId?: string;
}

export interface BindWizardEmbeddingsOutput {
	/** Number of embeddings successfully bound */
	boundCount: number;
	/** Any errors that occurred */
	errors: string[];
}

/**
 * Bind wizard embeddings to a project
 *
 * Updates Qdrant payloads to:
 * - Set projectId
 * - Update contextId to the new ProjectContext ID
 * - Set isWizardContext to false
 * - Clear sessionId
 */
export async function bindWizardEmbeddingsToProjectActivity(
	input: BindWizardEmbeddingsInput,
): Promise<BindWizardEmbeddingsOutput> {
	const { sessionId, projectId, contextIdMapping, userId, organizationId } =
		input;

	logger.info(
		`[WizardBinding] Binding ${Object.keys(contextIdMapping).length} wizard embeddings to project ${projectId}`,
	);

	try {
		// Convert object to Map
		const mapping = new Map(Object.entries(contextIdMapping));

		const result = await bindWizardEmbeddingsToProject({
			sessionId,
			projectId,
			contextIdMapping: mapping,
			userId,
			organizationId,
		});

		logger.info(
			`[WizardBinding] Successfully bound ${result.boundCount} embeddings to project ${projectId}`,
		);

		return {
			boundCount: result.boundCount,
			errors: result.errors,
		};
	} catch (error) {
		const errorMsg = `Failed to bind wizard embeddings: ${error instanceof Error ? error.message : "Unknown error"}`;
		logger.error(`[WizardBinding] ${errorMsg}`);

		return {
			boundCount: 0,
			errors: [errorMsg],
		};
	}
}
