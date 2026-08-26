import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const {
	generateContextEmbeddings,
	storeContextsInQdrant,
	updateContextEmbeddingStatus,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface ProjectContextEmbeddingInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	contexts: Array<{
		id: string;
		type: string;
		content: string;
	}>;
}

export interface ProjectContextEmbeddingOutput {
	success: boolean;
	embeddedCount: number;
	error?: string;
}

/**
 * Workflow: Embed project contexts into Qdrant for RAG retrieval
 *
 * This workflow:
 * 1. Filters out INTEGRATION type and empty content contexts
 * 2. Generates embeddings for valid project contexts
 * 3. Stores them in Qdrant with proper tenant isolation
 * 4. Updates database records with Qdrant IDs and timestamps
 */
export async function projectContextEmbeddingWorkflow(
	input: ProjectContextEmbeddingInput,
): Promise<ProjectContextEmbeddingOutput> {
	try {
		// Step 0: Filter out INTEGRATION type contexts (they have no content to embed)
		// and contexts with empty content
		const validContexts = input.contexts.filter(
			(c) =>
				c.type !== "INTEGRATION" &&
				c.content &&
				c.content.trim().length > 0,
		);

		if (validContexts.length === 0) {
			console.log(
				"[ProjectContextEmbedding] No valid contexts to embed after filtering",
			);
			return {
				success: true,
				embeddedCount: 0,
			};
		}

		if (validContexts.length !== input.contexts.length) {
			console.log(
				`[ProjectContextEmbedding] Filtered ${input.contexts.length - validContexts.length} contexts (INTEGRATION type or empty content)`,
			);
		}

		// Step 1: Generate embeddings for valid contexts
		const embeddings = await generateContextEmbeddings({
			contexts: validContexts,
			userId: input.userId,
			organizationId: input.organizationId,
			projectId: input.projectId,
		});

		// Step 2: Store in Qdrant with tenant isolation
		const qdrantIds = await storeContextsInQdrant({
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId,
			contexts: validContexts,
			embeddings,
		});

		// Step 3: Update database with Qdrant IDs and embeddedAt timestamp
		await updateContextEmbeddingStatus({
			contextIds: validContexts.map((c) => c.id),
			qdrantIds,
		});

		return {
			success: true,
			embeddedCount: validContexts.length,
		};
	} catch (error: any) {
		console.error("Project context embedding workflow failed:", error);
		const errorMessage = error.message || "Unknown error";
		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"PROJECT_CONTEXT_EMBEDDING_FAILED",
		);
	}
}
