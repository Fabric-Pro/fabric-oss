import { getDocumentById } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "../../../client";

/**
 * The side effects a document write owes the rest of the system.
 *
 * The interactive save routes through `applyDocumentUpdateSideEffects` in
 * @repo/api. The refresh cannot — @repo/temporal must not import @repo/api — and
 * for a while it simply skipped them. That was not a cosmetic gap: without the
 * re-embed, Qdrant keeps serving the PRE-refresh document forever, drifting
 * further from the live one on every cycle, while the chat assistant, Atlas, the
 * task agent and the knowledge API all keep answering from a document that no
 * longer exists.
 *
 * Realtime/activity-feed emission is NOT mirrored here — those emitters live in
 * @repo/api and are unreachable. An editor open on a document the sweep rewrites
 * will not learn about it until it reloads. That is a known gap, not an
 * oversight: see the refresh's collision guards, which are what keep it from
 * being a correctness problem.
 */
export async function applyDocumentRefreshSideEffects({
	documentId,
	projectId,
	userId,
	organizationId,
}: {
	documentId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
}): Promise<void> {
	try {
		const document = await getDocumentById(documentId);
		// Mirrors the interactive path: only a finished document is worth indexing.
		if (!document || document.status !== "COMPLETE") {
			return;
		}

		const client = await getTemporalClient();
		await client.workflow.start("documentEmbeddingWorkflow", {
			taskQueue: "project-documents",
			workflowId: `document-embedding-${documentId}`,
			// The pair matters and they are not redundant. REUSE governs a CLOSED
			// workflow of the same id (allow it — every save must be able to re-index);
			// CONFLICT governs a RUNNING one (terminate it — an in-flight embed of
			// superseded content is worthless, and the latest content must win the
			// index). Identical to the interactive save path.
			workflowIdReusePolicy: "ALLOW_DUPLICATE",
			workflowIdConflictPolicy: "TERMINATE_EXISTING",
			args: [{ documentId, userId, organizationId }],
		});
	} catch (error) {
		// Never fail a refresh that already committed. A stale index is bad; losing
		// the commit's record because the index dispatch hiccuped is worse.
		logger.error("[DocumentRefresh] Failed to dispatch re-embedding", {
			documentId,
			projectId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
