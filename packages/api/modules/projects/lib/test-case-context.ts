/** Request-path deletion cleanup for mirrored test-case context. */
import { deleteContext, getContextById } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

/**
 * Remove the mirrored ProjectContext + its embedding when a test case is
 * deleted, so a deleted case stops surfacing to the AI. Uses the durable
 * `contextDeletionWorkflow`; falls back to a direct row delete.
 */
export async function removeTestCaseContext(params: {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string | null;
}): Promise<void> {
	try {
		const existing = await getContextById(params.contextId);
		if (!existing || existing.projectId !== params.projectId) {
			return;
		}

		const client = await getTemporalClient();
		const workflowId = `context-deletion-${params.contextId}-${Date.now()}`;
		await client.workflow.start(
			"contextDeletionWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						contextId: params.contextId,
						projectId: params.projectId,
						userId: params.userId,
						organizationId: params.organizationId,
						qdrantId: existing.qdrantId ?? undefined,
						metadata: {
							contextType: "TEST_CASE",
							contextName: existing.sourceTitle ?? "Test case",
							deletedBy: params.userId,
						},
					},
				],
			}),
		);
	} catch (error) {
		logger.error(
			`[TestCases] Failed to remove RAG context ${params.contextId}: ${error}`,
		);
		try {
			await deleteContext(params.contextId);
		} catch {
			// already gone — nothing to clean up
		}
	}
}
