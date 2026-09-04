/**
 * Context Embedding Activities
 *
 * Activities for embedding individual project contexts (Notion pages, uploaded files, etc.)
 * into Qdrant for RAG retrieval.
 */

import {
	AIProviderNotConfiguredError,
	getSystemRAGProviderConfig,
} from "@repo/ai";
import {
	db,
	recordContextIndexingFailure,
	updateContextExtractionStatus,
} from "@repo/database";
import { embedProjectContext } from "@repo/rag";
import { heartbeat } from "@temporalio/activity";
import { activityLogger } from "./lib/activity-logger";

export interface EmbedSingleContextInput {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	/** Omit to have the activity read the body back from `contextId`. */
	content?: string;
	type: string;
	metadata?: {
		filename?: string;
		sourceUrl?: string;
		sourceTitle?: string;
		[key: string]: unknown;
	};
}

export interface EmbedSingleContextOutput {
	success: boolean;
	qdrantId?: string;
	error?: string;
}

/**
 * Embed a single project context for RAG retrieval
 *
 * This activity wraps the embedProjectContext function with proper error handling
 * and logging. It's designed to be called from the contextEmbeddingWorkflow.
 */
export async function embedSingleContextActivity(
	input: EmbedSingleContextInput,
): Promise<EmbedSingleContextOutput> {
	const {
		contextId,
		projectId,
		userId,
		organizationId,
		content,
		type,
		metadata,
	} = input;

	activityLogger.info("Embedding project context", {
		contextId,
		projectId,
		type,
	});

	try {
		// A caller may omit the body and let us read it back instead, so that an
		// arbitrarily long context — a whole meeting transcript, since Fizzy
		// #2316 stores those unabridged — never has to fit inside a Temporal
		// payload. The row is the source of truth either way.
		const body =
			content ??
			(
				await db.projectContext.findUnique({
					where: { id: contextId },
					select: { content: true },
				})
			)?.content ??
			"";

		// Skip if no content
		if (body.trim().length === 0) {
			activityLogger.info(
				"Skipping embedding for empty content context",
				{
					contextId,
				},
			);
			// Pre-existing branch retained for Notion-resync flow: the row was
			// created with empty content and the user is expected to resync
			// from Integrations later. Leaving extractionStatus at PENDING.
			return { success: true };
		}

		// Get AI provider configuration
		const providerConfig = await getSystemRAGProviderConfig({
			userId,
			organizationId,
		});

		// Send periodic heartbeats so Temporal knows we're alive during
		// long-running embedding/enrichment calls (each can block for seconds).
		const heartbeatInterval = setInterval(() => heartbeat(), 10_000);
		try {
			// Embed the context
			const result = await embedProjectContext({
				contextId,
				projectId,
				userId,
				organizationId,
				content: body,
				type,
				apiKey: providerConfig,
				metadata,
			});

			// embedProjectContext swallows its own errors and *resolves* with
			// { success: false } instead of throwing (see
			// `@repo/rag` auto-embed.ts). This branch used to be ignored: the
			// activity unconditionally flipped the row to COMPLETED, logged
			// "Context embedded successfully", and returned { success: true }
			// even when no vector was ever stored (qdrantId stayed null and
			// Qdrant held 0 points for the context). That also defeated the
			// `maximumAttempts: 3` retry policy declared on this activity in
			// contextEmbeddingWorkflow — the activity never threw, so Temporal
			// never retried, and a *transient* provider blip (e.g. an Azure
			// embedding deployment briefly returning "deployment does not
			// exist") permanently lost the embedding.
			//
			// Throw so the failure is real: Temporal retries (transient blips
			// self-heal) and, once retries are exhausted, the catch below lands
			// the row in a truthful FAILED state. Qdrant writes are idempotent
			// (deterministic point id from contextId) so retries can't
			// duplicate vectors.
			if (!result.success) {
				throw new Error(result.error || "Embedding generation failed");
			}

			// Flip the parent ProjectContext row from PENDING to COMPLETED so
			// inline status pills (ContextPendingItemsList in the wizard +
			// ProjectContextsList in the post-creation surface) reflect the
			// real terminal state. Without this, TEXT and INTEGRATION rows
			// stayed PENDING forever even when refine could retrieve their
			// chunks from Qdrant (staging finding A-1, 2026-05-24). FILE +
			// LINK paths have their own dedicated finalize activities and
			// were already correct.
			//
			// Best-effort: swallow status-write errors so the embedding
			// outcome (which already succeeded) is the authoritative signal
			// returned to the caller. A failed status-write only delays the
			// UI flip; the data is already in Qdrant + retrievable.
			try {
				// Clear any message a previous attempt recorded. This activity
				// re-runs under Temporal's retry policy, so the common case for
				// a row that failed to index is that a later attempt fixes it —
				// and `extractionError` is what the contexts list reads to call
				// a COMPLETED row unsearchable. Leaving it set would strand a
				// fully embedded row on that badge with nothing able to undo it.
				await updateContextExtractionStatus(contextId, "COMPLETED", {
					extractionError: null,
				});
			} catch (writeError) {
				activityLogger.warn("Failed to flag context as COMPLETED", {
					contextId,
					writeError,
				});
			}

			activityLogger.info("Context embedded successfully", {
				contextId,
				qdrantId: result.qdrantId,
				chunksCreated: result.chunksCreated,
			});

			return {
				success: true,
				qdrantId: result.qdrantId,
			};
		} finally {
			clearInterval(heartbeatInterval);
		}
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			activityLogger.warn(
				"No AI provider configured, skipping context embedding",
				{
					contextId,
				},
			);
			// Flag the row as FAILED with a clear hint so the inline status
			// pill explains the deferred state to the user (instead of
			// hanging at "Pending" forever). The retry path lives in the
			// per-row UI (ContextPendingItemsList / ProjectContextsList) and
			// the user can configure the provider via Settings to re-trigger.
			//
			// Best-effort: swallow any error here so the activity itself
			// stays a success — the workflow caller is fire-and-forget.
			await recordContextIndexingFailure(
				contextId,
				"AI provider not configured. Configure an embedding provider in Settings → AI to enable retrieval for this context.",
			).catch((writeError) => {
				activityLogger.warn(
					"Failed to flag context as FAILED (AIProviderNotConfigured)",
					{ contextId, writeError },
				);
			});
			return { success: true };
		}

		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		activityLogger.error("Failed to embed context", error, {
			contextId,
		});

		// Mark the row FAILED so the UI shows the inline error pill +
		// retry/delete affordance. Same swallow-on-write-error discipline:
		// the embedding failure is the real error; logging issues with the
		// status write shouldn't mask it.
		//
		// Say WHICH step failed. This activity only ever indexes content that
		// extraction already produced, so an unqualified message here reads as
		// "we could not read your document" when the document is stored and
		// intact and the only casualty is search. `ProjectContextsList` narrows
		// the badge on the same evidence (a FAILED row that still has content);
		// this makes the detail text agree with it.
		await recordContextIndexingFailure(
			contextId,
			`Search indexing failed: ${errorMessage}`,
		).catch((writeError) => {
			activityLogger.warn("Failed to flag context as FAILED", {
				contextId,
				writeError,
			});
		});

		// Re-throw so Temporal applies the activity's retry policy
		// (maximumAttempts: 3) — a transient embedding/provider failure
		// self-heals on a later attempt. Previously this returned
		// { success: false }, which Temporal treats as a *successful*
		// activity completion, so no retry ever happened. Both callers are
		// resilient to the throw: contextEmbeddingWorkflow wraps it in
		// try/catch, and url-source-crawl treats a single-page embed as
		// best-effort (log + continue). AIProviderNotConfigured is handled
		// above and intentionally NOT re-thrown (a missing provider won't
		// fix itself on retry).
		throw error instanceof Error ? error : new Error(errorMessage);
	}
}
