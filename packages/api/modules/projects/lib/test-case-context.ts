/**
 * AC7 — Test Cases as AI context.
 *
 * Rather than build a parallel embedding pipeline, each test case is mirrored
 * into a `ProjectContext` row (type `TEST_CASE`) and embedded via the existing
 * `contextEmbeddingWorkflow`. Retrieval is already type-agnostic, so cases
 * surface to the project AI exactly like every other project context.
 *
 * All embedding work is best-effort and fire-and-forget — a failure here must
 * never block the create/update/clone/delete it accompanies.
 */

import {
	createContext,
	deleteContext,
	getContextById,
	setTestCaseContextId,
	updateContext,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

// The body itself is composed in @repo/temporal so the background drafting
// activity — which cannot import @repo/api — embeds cases exactly as this path
// does. Re-exported here so callers and this module's tests keep one import
// site, and so "what the AI reads about a case" has a single definition.
export { buildTestCaseContextContent } from "@repo/temporal/test-case-context";

interface SyncParams {
	testCaseId: string;
	projectId: string;
	contextId: string | null;
	content: string;
	sourceTitle: string;
	userId: string;
	organizationId?: string | null;
}

/**
 * Mirror a test case into a ProjectContext and (re)embed it. Creates the
 * context on first sync and stores its id back on the case; updates the content
 * on subsequent syncs. Returns the context id (or the prior value on failure).
 */
export async function syncTestCaseContext(
	params: SyncParams,
): Promise<string | null> {
	try {
		let contextId = params.contextId;

		if (contextId) {
			const existing = await getContextById(contextId);
			if (existing && existing.projectId === params.projectId) {
				await updateContext(contextId, {
					content: params.content,
					metadata: {
						testCaseId: params.testCaseId,
						sourceTitle: params.sourceTitle,
					},
				});
			} else {
				contextId = null; // row vanished — recreate below
			}
		}

		if (!contextId) {
			const created = await createContext({
				projectId: params.projectId,
				type: "TEST_CASE",
				content: params.content,
				sourceTitle: params.sourceTitle,
				metadata: {
					testCaseId: params.testCaseId,
					sourceTitle: params.sourceTitle,
				},
				userId: params.userId,
				organizationId: params.organizationId ?? undefined,
			});
			contextId = created?.id ?? null;
			if (contextId) {
				await setTestCaseContextId({
					id: params.testCaseId,
					contextId,
				});
			}
		}

		if (contextId && params.content.trim().length > 0) {
			await startEmbeddingWorkflow({
				contextId,
				projectId: params.projectId,
				content: params.content,
				sourceTitle: params.sourceTitle,
				userId: params.userId,
				organizationId: params.organizationId,
			});
		}

		return contextId;
	} catch (error) {
		logger.error(
			`[TestCases] Failed to sync RAG context for test case ${params.testCaseId}: ${error}`,
		);
		return params.contextId;
	}
}

async function startEmbeddingWorkflow(params: {
	contextId: string;
	projectId: string;
	content: string;
	sourceTitle: string;
	userId: string;
	organizationId?: string | null;
}): Promise<void> {
	try {
		const client = await getTemporalClient();
		const workflowId = `context-embedding-${params.contextId}-${Date.now()}`;
		await client.workflow.start(
			"contextEmbeddingWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						contextId: params.contextId,
						projectId: params.projectId,
						userId: params.userId,
						organizationId: params.organizationId,
						content: params.content,
						type: "TEST_CASE",
						metadata: { sourceTitle: params.sourceTitle },
					},
				],
			}),
		);
	} catch (error) {
		logger.error(
			`[TestCases] Failed to start embedding workflow for context ${params.contextId}: ${error}`,
		);
	}
}

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
