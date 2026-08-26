import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { emitActivity, emitDocumentChange } from "./realtime";
import { withCorrelationMemo } from "./temporal-correlation";

interface DocumentSideEffectsArgs {
	projectId: string;
	document: {
		id: string;
		type: string;
		title: string;
		status: string;
	};
	user: { id: string; name: string | null };
	organizationId?: string;
	logScope: string;
	/**
	 * Set to true for metadata-only saves (title/status change, no content
	 * change). The embedding workflow is skipped because the indexed content
	 * is unchanged.
	 */
	skipEmbed?: boolean;
}

/**
 * Emit the realtime + activity events produced by a document save, then
 * fire-and-forget the embedding workflow (only when the document is COMPLETE).
 *
 * Awaits the emit pair so clients see the update before the handler returns,
 * but does not await the embedding workflow — it is durable and runs
 * independently on the Temporal side. The `logScope` prefixes log lines so
 * call sites remain distinguishable in operations dashboards.
 */
export async function applyDocumentUpdateSideEffects({
	projectId,
	document,
	user,
	organizationId,
	logScope,
	skipEmbed = false,
}: DocumentSideEffectsArgs): Promise<void> {
	await Promise.all([
		emitDocumentChange({
			projectId,
			documentId: document.id,
			action: "updated",
			userId: user.id,
			userName: user.name || "Anonymous",
			documentType: document.type,
			documentTitle: document.title,
		}),
		emitActivity({
			projectId,
			userId: user.id,
			userName: user.name || "Anonymous",
			activityType: "document_updated",
			resourceType: "document",
			resourceId: document.id,
			resourceName: document.title,
			timestamp: new Date().toISOString(),
		}),
	]);

	// Re-embed only when the document is in a final state. Uses a deterministic
	// workflow ID so concurrent saves collapse via TERMINATE_EXISTING — the
	// latest save always wins.
	if (skipEmbed || document.status !== "COMPLETE") {
		return;
	}

	(async () => {
		try {
			const client = await getTemporalClient();
			const workflowId = `document-embedding-${document.id}`;
			await client.workflow.start(
				"documentEmbeddingWorkflow",
				withCorrelationMemo({
					taskQueue: "project-documents",
					workflowId,
					workflowIdReusePolicy: "ALLOW_DUPLICATE",
					workflowIdConflictPolicy: "TERMINATE_EXISTING",
					args: [
						{
							documentId: document.id,
							userId: user.id,
							organizationId,
						},
					],
				}),
			);
			logger.info(
				`[${logScope}] Started document embedding workflow ${workflowId}`,
			);
		} catch (error) {
			logger.error(
				`[${logScope}] Failed to start document embedding workflow for ${document.id}: ${error}`,
			);
		}
	})();
}
