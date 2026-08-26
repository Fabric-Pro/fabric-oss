/**
 * Temporal workflow for binding wizard embeddings to a project
 *
 * This workflow is a simple wrapper around the binding activity.
 * It's triggered when a project is created from the wizard to update
 * the Qdrant payloads with the new projectId.
 */

import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { bindWizardEmbeddingsToProjectActivity } = proxyActivities<
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

export interface WizardToProjectBindingInput {
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

export interface WizardToProjectBindingOutput {
	/** Number of embeddings successfully bound */
	boundCount: number;
	/** Any errors that occurred */
	errors: string[];
}

/**
 * Workflow for binding wizard embeddings to a project
 *
 * Updates Qdrant payloads to:
 * - Set projectId
 * - Update contextId to the new ProjectContext ID
 * - Set isWizardContext to false
 * - Clear sessionId (optional, for query optimization)
 */
export async function wizardToProjectBindingWorkflow(
	input: WizardToProjectBindingInput,
): Promise<WizardToProjectBindingOutput> {
	log.info("Starting wizard to project binding workflow", {
		sessionId: input.sessionId,
		projectId: input.projectId,
		contextCount: Object.keys(input.contextIdMapping).length,
	});

	try {
		const result = await bindWizardEmbeddingsToProjectActivity({
			sessionId: input.sessionId,
			projectId: input.projectId,
			contextIdMapping: input.contextIdMapping,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		log.info("Wizard to project binding completed", {
			boundCount: result.boundCount,
			errors: result.errors.length,
		});

		return result;
	} catch (error) {
		const errorMsg = `Workflow failed: ${error instanceof Error ? error.message : "Unknown error"}`;
		log.error(errorMsg);

		return {
			boundCount: 0,
			errors: [errorMsg],
		};
	}
}
