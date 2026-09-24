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
import {
	deleteProjectContext,
	type EmbedResult,
	embedProjectContext,
} from "@repo/rag";
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
	/**
	 * The row's content REPLACED an earlier version that was already embedded
	 * (a synced knowledge file's update, Fizzy #2616): delete every point for
	 * this context before embedding. Chunk points are keyed
	 * `<contextId>-chunk-N`, so without the delete a version with fewer chunks
	 * would leave the old version's tail in the index, still answering
	 * searches. Absent on every other caller, which embeds as before.
	 *
	 * A re-embed always reads the body from the row (with its `contentHash`),
	 * ignoring `content`: it has to know which version it embedded. See
	 * {@link reembedStoredVersion}.
	 */
	reembed?: boolean;
}

/**
 * How many delete-then-embed passes a re-embed makes while the row keeps
 * being replaced under it, before failing for Temporal to retry.
 */
const MAX_REEMBED_PASSES = 3;

interface StoredVersion {
	content: string;
	contentHash: string | null;
}

async function readStoredVersion(
	contextId: string,
): Promise<StoredVersion | null> {
	return db.projectContext.findUnique({
		where: { id: contextId },
		select: { content: true, contentHash: true },
	});
}

/**
 * Re-embed a context whose content was replaced, ending on the version the
 * row holds (Fizzy #2616).
 *
 * Every replace starts its own workflow and each activity reads the row when
 * it runs, so two replaces inside the embedding window can interleave — A
 * reads V2, B reads V3, B embeds V3, A embeds V2 — and leave the index on V2
 * while the row holds V3. This is decided here rather than by workflow ids,
 * so it holds whatever the worker deploy order and however many workflows
 * are in flight:
 *
 *  1. read the row's content AND its `contentHash`;
 *  2. delete every point for the context, strictly — a failed delete throws
 *     (Temporal retries) instead of leaving the old tail in place;
 *  3. embed that content, without letting the embed mark the row;
 *  4. re-read the `contentHash`. Unchanged: mark `embeddedAt` for that hash
 *     only (a conditional write, so a replace landing between the re-read
 *     and the mark is not marked as embedded) and stop. Changed: go round
 *     again with the new version, at most {@link MAX_REEMBED_PASSES} passes,
 *     then throw so Temporal retries once the row has settled.
 *  5. The mark itself matched no row (a replace landed between the re-read
 *     and the mark): nothing is stamped, so this is not a success. Re-read
 *     the row and go round again, within the same bound, and throw once it
 *     is spent (Living Memory design 2026-09-23 §5.3.1 step 9). Never
 *     return success after a mark that matched nothing: the index would be
 *     on an older version than the row, with nothing left to repair it.
 *
 * `progress.pointsRemoved` is set before the first delete of the row's
 * points, so a failure from then on — the delete's own included, which may
 * have removed some — is recorded as one that left the row unindexed.
 *
 * Returns `null` when there is nothing to index: the row is gone or empty.
 */
async function reembedStoredVersion(params: {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	type: string;
	apiKey: Parameters<typeof embedProjectContext>[0]["apiKey"];
	metadata?: EmbedSingleContextInput["metadata"];
	initial: StoredVersion | null;
	progress: ReembedProgress;
}): Promise<EmbedResult | null> {
	const { contextId, organizationId, initial, progress, ...embedOptions } =
		params;
	// Strict: a failed delete rejects instead of leaving old chunks behind.
	const deleteAllPoints = () => {
		progress.pointsRemoved = true;
		return deleteProjectContext(contextId, organizationId, undefined, {
			strict: true,
		});
	};
	let version = initial;

	for (let pass = 1; pass <= MAX_REEMBED_PASSES; pass++) {
		if (!version || version.content.trim().length === 0) {
			// Nothing to index. After an earlier pass this means the row was
			// emptied under us; that pass's points go too.
			if (pass > 1) {
				await deleteAllPoints();
			}
			return null;
		}

		await deleteAllPoints();

		const result = await embedProjectContext({
			...embedOptions,
			contextId,
			organizationId,
			content: version.content,
			skipDbUpdate: true,
		});
		if (!result.success) {
			return result;
		}

		const current = await db.projectContext.findUnique({
			where: { id: contextId },
			select: { contentHash: true },
		});
		if (!current) {
			// Deleted while we embedded: the points just written belong to
			// nothing, so remove them rather than leave them searchable.
			await deleteAllPoints();
			return null;
		}
		if (current.contentHash === version.contentHash) {
			if (!result.qdrantId) {
				return result;
			}
			const { count } = await db.projectContext.updateMany({
				where: { id: contextId, contentHash: version.contentHash },
				data: { qdrantId: result.qdrantId, embeddedAt: new Date() },
			});
			if (count > 0) {
				return result;
			}
			// Replaced (or deleted) between the re-read and the mark: this
			// pass embedded a version the row no longer holds.
			activityLogger.info(
				"Context changed before its re-embed could be marked; embedding again",
				{ contextId, pass },
			);
		} else {
			activityLogger.info(
				"Context content changed while it was being re-embedded",
				{ contextId, pass },
			);
		}
		if (pass < MAX_REEMBED_PASSES) {
			version = await readStoredVersion(contextId);
		}
	}

	throw new Error(
		`Context ${contextId} kept changing while it was being re-embedded (${MAX_REEMBED_PASSES} passes); retrying once it settles`,
	);
}

/** What a re-embed did before it returned or threw. */
interface ReembedProgress {
	/** The row's points were (or may have been) deleted by this pass. */
	pointsRemoved: boolean;
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
		reembed,
	} = input;

	activityLogger.info("Embedding project context", {
		contextId,
		projectId,
		type,
	});

	const progress: ReembedProgress = { pointsRemoved: false };
	// A failure after this pass deleted the row's points also clears
	// `embeddedAt`, so the row reads as awaiting indexing rather than
	// claiming an index it no longer has (Living Memory design 2026-09-23
	// §5.3.1 step 9). Every other failure is recorded exactly as before.
	const recordFailure = (message: string) =>
		progress.pointsRemoved
			? recordContextIndexingFailure(contextId, message, {
					pointsRemoved: true,
				})
			: recordContextIndexingFailure(contextId, message);

	try {
		// A caller may omit the body and let us read it back instead, so that an
		// arbitrarily long context — a whole meeting transcript, since Fizzy
		// #2316 stores those unabridged — never has to fit inside a Temporal
		// payload. The row is the source of truth either way. A re-embed
		// always reads it, with the version's hash (see reembedStoredVersion).
		const stored = reembed ? await readStoredVersion(contextId) : null;
		const body = reembed
			? (stored?.content ?? "")
			: (content ??
				(
					await db.projectContext.findUnique({
						where: { id: contextId },
						select: { content: true },
					})
				)?.content ??
				"");

		// Skip if no content
		if (body.trim().length === 0) {
			activityLogger.info(
				"Skipping embedding for empty content context",
				{
					contextId,
				},
			);
			if (reembed) {
				// A re-embed of a row that is gone or empty: an earlier
				// attempt may have written points for it before the row
				// disappeared (a retry after the missing-row cleanup itself
				// failed lands here), so remove them rather than leave them
				// searchable. Strict, so a failed delete is retried.
				await deleteProjectContext(
					contextId,
					organizationId,
					undefined,
					{
						strict: true,
					},
				);
			}
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
			// Embed the context. A replace deletes the previous version's
			// points first (strict delete-by-filter, then the same embed) and
			// ends on the version the row holds.
			let result: EmbedResult;
			if (reembed) {
				const reembedded = await reembedStoredVersion({
					contextId,
					projectId,
					userId,
					organizationId,
					type,
					apiKey: providerConfig,
					metadata,
					initial: stored,
					progress,
				});
				if (!reembedded) {
					activityLogger.info(
						"Context was deleted or emptied during re-embed; nothing to index",
						{ contextId },
					);
					return { success: true };
				}
				result = reembedded;
			} else {
				result = await embedProjectContext({
					contextId,
					projectId,
					userId,
					organizationId,
					content: body,
					type,
					apiKey: providerConfig,
					metadata,
				});
			}

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
			await recordFailure(
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
		await recordFailure(`Search indexing failed: ${errorMessage}`).catch(
			(writeError) => {
				activityLogger.warn("Failed to flag context as FAILED", {
					contextId,
					writeError,
				});
			},
		);

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
