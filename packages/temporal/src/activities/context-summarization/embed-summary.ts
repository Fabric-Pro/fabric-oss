import { getSystemRAGProviderConfig } from "@repo/ai";
import {
	type SummaryTenancy,
	setContextSummaryEmbedding,
} from "@repo/database";
import { logger } from "@repo/logs";
import { embedProjectContext } from "@repo/rag";

/**
 * Best-effort embed of a finished summary into the project's Qdrant collection
 * so an agent can retrieve it. STRICTLY non-fatal: any failure (no provider
 * configured, embedding API down, org with no key) is logged and swallowed —
 * the DB summary row is the primary retrieval surface, so a missing embedding
 * never fails the run.
 *
 * Reuses `embedProjectContext` with `skipDbUpdate: true` because the summary
 * lives in `project_context_summary`, not `project_context`; we own the DB link
 * via `setContextSummaryEmbedding`. The summary is tagged `CONTEXT_SUMMARY` in
 * the payload so the read path can tell it apart from raw context.
 */
export async function embedSummaryActivity(input: {
	summaryId: string;
	projectId: string;
	tenancy: SummaryTenancy;
	content: string;
}): Promise<{ embedded: boolean }> {
	const userId = input.tenancy.userId ?? "";
	const organizationId = input.tenancy.organizationId ?? undefined;
	try {
		const providerConfig = await getSystemRAGProviderConfig({
			userId,
			organizationId,
			projectId: input.projectId,
		});

		const result = await embedProjectContext({
			contextId: input.summaryId,
			projectId: input.projectId,
			userId,
			organizationId,
			content: input.content,
			type: "CONTEXT_SUMMARY",
			apiKey: {
				apiKey: providerConfig.apiKey,
				provider: providerConfig.provider,
				baseUrl: providerConfig.baseUrl,
			},
			// The summary is not a ProjectContext row — skip the built-in
			// markContextAsEmbedded and record the link ourselves below.
			skipDbUpdate: true,
		});

		if (result.success && result.qdrantId) {
			await setContextSummaryEmbedding({
				id: input.summaryId,
				qdrantId: result.qdrantId,
			});
			return { embedded: true };
		}

		logger.warn("[Context Summarization] summary embed skipped", {
			summaryId: input.summaryId,
			reason: result.error ?? "no qdrantId returned",
		});
		return { embedded: false };
	} catch (error) {
		logger.warn(
			"[Context Summarization] summary embed failed (non-fatal)",
			{
				summaryId: input.summaryId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return { embedded: false };
	}
}
