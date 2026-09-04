/**
 * Embed URL Page Activity (URL Context Sources)
 *
 * Calls `embedProjectContext` from `@repo/rag` to chunk + embed the page's
 * markdown and store the resulting vectors in Qdrant. Stamps the
 * chunk-metadata contract:
 *   - `sourceUrl`   = the actual indexed page URL (NOT the parent's URL)
 *   - `sourceTitle` = the user's parent label
 *   - `parentContextId` = parent ProjectContext.id (for chunk-delete grouping)
 *
 * The shared `embedProjectContext` already sets `originalContextId = contextId`
 * to drive filter-based chunk deletion; we pass the per-page id so cascade
 * cleanup on parent delete still finds every chunk.
 *
 * On success the activity bumps `embeddedAt`, `chunkCount`, `qdrantId`,
 * and flips `extractionStatus` to COMPLETED on the page row.
 */
import { getSystemRAGProviderConfig } from "@repo/ai";
import { db } from "@repo/database/prisma/client";
import { embedProjectContext } from "@repo/rag";
import { ApplicationFailure, heartbeat } from "@temporalio/activity";
import { activityLogger } from "../lib/activity-logger";

export interface EmbedUrlPageActivityInput {
	pageId: string;
	parentContextId: string;
	projectId: string;
	pageUrl: string;
	parentSourceTitle: string | null;
	content: string;
	userId: string;
	organizationId?: string;
}

export interface EmbedUrlPageActivityOutput {
	success: boolean;
	qdrantId?: string;
	chunkCount: number;
	error?: string;
}

export async function embedUrlPageActivity(
	input: EmbedUrlPageActivityInput,
): Promise<EmbedUrlPageActivityOutput> {
	const {
		pageId,
		parentContextId,
		projectId,
		pageUrl,
		parentSourceTitle,
		content,
		userId,
		organizationId,
	} = input;

	activityLogger.info("Embed url page activity start", {
		pageId,
		parentContextId,
		pageUrl,
	});

	if (!content || content.trim().length === 0) {
		activityLogger.warn("Skipping empty content", { pageId });
		await db.projectContextUrlPage.update({
			where: { id: pageId },
			data: { extractionStatus: "COMPLETED", chunkCount: 0 },
		});
		return { success: true, chunkCount: 0 };
	}

	const providerConfig = await getSystemRAGProviderConfig({
		userId,
		organizationId,
	});

	// Heartbeat every 10s so the 30s workflow heartbeatTimeout has headroom
	// during the embedding loop (each chunk = one provider HTTP call).
	const heartbeatInterval = setInterval(() => {
		try {
			heartbeat();
		} catch {
			// Outside an activity context (tests).
		}
	}, 10_000);

	try {
		const result = await embedProjectContext({
			contextId: pageId,
			projectId,
			userId,
			organizationId,
			content,
			type: "LINK",
			apiKey: providerConfig,
			metadata: {
				// Chunk-metadata contract — citations resolve via these
				// fields downstream.
				sourceUrl: pageUrl,
				sourceTitle: parentSourceTitle ?? undefined,
				parentContextId,
			},
			// URL pages live in `ProjectContextUrlPage`, not `ProjectContext`.
			// Without this opt-out, embedProjectContext tried
			// `markContextAsEmbedded(pageId, ...)` → `projectContext.update({
			// id: pageId })` → "No record was found for an update" failure
			// on every page, leaving chunks unmarked even though they were
			// successfully written to Qdrant. The follow-up
			// `projectContextUrlPage.update` below stamps qdrantId +
			// embeddedAt on the right row.
			skipDbUpdate: true,
		});

		if (!result.success) {
			activityLogger.error(
				"Embed url page activity failed",
				new Error(result.error ?? "unknown"),
				{ pageId, pageUrl },
			);
			await db.projectContextUrlPage.update({
				where: { id: pageId },
				data: {
					extractionStatus: "FAILED",
					extractionError: result.error ?? "Unknown embedding error",
				},
			});
			throw ApplicationFailure.retryable(
				result.error ?? "URL page embedding failed",
				"EMBED_URL_PAGE_FAILED",
			);
		}

		await db.projectContextUrlPage.update({
			where: { id: pageId },
			data: {
				qdrantId: result.qdrantId ?? null,
				embeddedAt: new Date(),
				chunkCount: result.chunksCreated ?? 0,
				extractionStatus: "COMPLETED",
				extractionError: null,
			},
		});

		activityLogger.info("Embed url page activity success", {
			pageId,
			pageUrl,
			chunkCount: result.chunksCreated ?? 0,
		});

		return {
			success: true,
			qdrantId: result.qdrantId,
			chunkCount: result.chunksCreated ?? 0,
		};
	} finally {
		clearInterval(heartbeatInterval);
	}
}
