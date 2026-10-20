/**
 * AC7 — Test Cases as AI context.
 *
 * Cases are mirrored into ProjectContext rows (type TEST_CASE) and embedded via
 * contextEmbeddingWorkflow, reusing the context pipeline instead of building a
 * parallel one. Retrieval is type-agnostic, so these rows surface to the project
 * AI alongside other project context.
 *
 * Mirroring is best-effort: a failure must not block the write it accompanies.
 * The mapping, database sync and workflow-start helpers catch and log failures.
 *
 * This lives in @repo/temporal because API writes and the PM pull activity both
 * need it, and activities cannot import @repo/api. The API request-path delegate
 * supplies the request correlation memo; the shared helper forwards that memo
 * when starting the embedding workflow.
 */
import {
	createContext,
	getContextById,
	setTestCaseContextId,
	type TestCaseDetail,
	updateContext,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "../client";
import { buildTestCaseContextContent } from "./test-case-context-content";

export interface SyncParams {
	testCaseId: string;
	projectId: string;
	contextId: string | null;
	content: string;
	sourceTitle: string;
	userId: string;
	organizationId?: string | null;
	memo?: Record<string, unknown>;
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
				contextId = null; // Missing or outside this project — recreate below
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
				memo: params.memo,
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
	memo?: Record<string, unknown>;
}): Promise<void> {
	try {
		const client = await getTemporalClient();
		const workflowId = `context-embedding-${params.contextId}-${Date.now()}`;
		await client.workflow.start("contextEmbeddingWorkflow", {
			memo: params.memo,
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
		});
	} catch (error) {
		logger.error(
			`[TestCases] Failed to start embedding workflow for context ${params.contextId}: ${error}`,
		);
	}
}

/**
 * Mirror a persisted test case into its ProjectContext row and (re)embed it.
 * Callers await this so, on a successful sync, the context row and contextId
 * back-link are durable before the caller returns. The workflow start attempt
 * is awaited too; embedding itself runs asynchronously in that workflow.
 * Mapping and sync failures are logged and contained.
 */
export async function mirrorTestCaseToContext(
	detail: TestCaseDetail,
	ctx: {
		userId: string;
		organizationId?: string | null;
		memo?: Record<string, unknown>;
	},
): Promise<void> {
	try {
		const content = buildTestCaseContextContent({
			identifier: detail.identifier,
			title: detail.title,
			state: detail.state,
			priority: detail.priority,
			preconditions: detail.description,
			steps: detail.steps.map((s) => ({
				action: s.action,
				expected: s.expected,
			})),
			linkedFeatures: detail.workItemLinks.map((link) => ({
				identifier: link.userStory.identifier,
				title: link.userStory.title,
				acceptanceCriterionRefs: link.acceptanceCriterionRefs,
			})),
			tags: detail.tags,
		});

		await syncTestCaseContext({
			testCaseId: detail.id,
			projectId: detail.projectId,
			contextId: detail.contextId,
			content,
			sourceTitle: `${detail.identifier} ${detail.title}`.trim(),
			userId: ctx.userId,
			organizationId: ctx.organizationId,
			memo: ctx.memo,
		});
	} catch (error) {
		logger.error(
			`[TestCases] Failed to map RAG context for test case ${detail.id}: ${error}`,
		);
	}
}
