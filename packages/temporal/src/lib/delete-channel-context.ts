/**
 * Remove a monitored channel's captured context when the channel is unlinked
 * (Fizzy #2228, U7).
 *
 * This is the OTHER HALF of the unlink protocol whose first half lives in
 * `capture-conversation-bundle.ts`. Read the two together: the embedder there
 * checks `parentStillLinked` before its vector write and again after it, and
 * compensates by deleting the point it just wrote if the channel disappeared in
 * between. That guard is only worth anything if the unlink side establishes the
 * state it reads BEFORE it starts removing vectors, which is what this file
 * does.
 *
 * # Why it lives beside the capture helper rather than in the API package
 *
 * The two files are one protocol, and the ordering that makes them correct is
 * not visible from either one alone. Keeping them adjacent is also what lets a
 * single test drive both halves against one fake point store, which is the only
 * way to actually prove "an unlink concurrent with an in-flight embed leaves no
 * point behind" rather than asserting that each half calls the other's name.
 *
 * # The state an embedder observes is the parent row's absence
 *
 * `parentStillLinked` asks one question: does the parent `ProjectContext` row
 * still exist? So "mark the parent as deleting" is not a flag — deleting the
 * row IS the mark, and it must happen before the first Qdrant call. An embedder
 * that is mid-flight then either sees the row gone and abandons without
 * writing, or writes and immediately deletes its own point. Reverse the order
 * and there is a window in which an embedder writes a point AFTER the sweep has
 * passed and BEFORE the row disappears — it would then see a live parent, keep
 * the point, and leave conversation text in the vector store of a channel the
 * user has unlinked.
 *
 * # Bundle rows cascade; bundle vectors do not
 *
 * `ProjectContextConversationBundle` has `onDelete: Cascade` on its parent, so
 * deleting the `ProjectContext` takes every bundle row with it. Their vectors
 * are objects in a different system and cascade from nothing, so the ids have
 * to be read BEFORE the delete and handed to a filter afterwards. A bundle's
 * `qdrantId` is deliberately NOT the mechanism: U5 embeds asynchronously and
 * non-fatally, so a bundle that holds points but has never been stamped is an
 * ordinary state — a null-`qdrantId` fallback that deleted the row and logged
 * an orphan would be wrong most of the time it fired.
 *
 * # The ids outlive the rows, or the failure is unrecoverable
 *
 * The ordering above has one consequence that has to be paid for rather than
 * argued away: by the time a vector delete can fail, the rows that held the ids
 * are already gone. Left there, a Qdrant failure was UNRECOVERABLE — the user's
 * retry found no context row, took the `contextIds.length === 0` early return
 * and reported success while the conversation text stayed indexed forever. The
 * payload carries the message text, so that is retained third-party content
 * after the user was told it was removed.
 *
 * So the ids are written to `ProjectContextPendingVectorCleanup` in the SAME
 * transaction as the row delete, and the record is cleared only once the vector
 * store confirms. Every entry point drains the queue first: this unit, before
 * its own early return, so a plain retry finishes the job — and the scheduled
 * bundle-embedding sweep, so it finishes even if nobody retries.
 *
 * # Only indexed payload keys may appear in the filter
 *
 * Qdrant rejects delete-by-filter on an unindexed payload key with a 400. On
 * `project-contexts` the indexed keys this needs are `contextId`,
 * `originalContextId`, `projectId` and `organizationId`. Notably
 * `parentContextId` — which the bundle embedder writes into the payload as a
 * grouping key — is NOT indexed, so it cannot be filtered on here; the bundle
 * row ids are used instead, and they reach the payload through `contextId` /
 * `originalContextId` because `embedProjectContext` is called with the bundle's
 * own row id as its context id.
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import {
	clearPendingVectorCleanup,
	createPendingVectorCleanup,
	db,
	listPendingVectorCleanupsForProject,
	type PendingVectorCleanupRecord,
	slackChannelContextMatches,
	teamsChannelContextMatches,
	teamsChatContextMatches,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	collectionExistsUncached,
	getCollectionName,
	PROJECT_CONTEXTS_BASE_COLLECTION,
} from "@repo/rag/lib/collection-manager";

const qdrant = new QdrantClient({
	url: process.env.QDRANT_URL || "http://localhost:6333",
	apiKey: process.env.QDRANT_API_KEY,
});

/**
 * How many context ids go into one delete-by-filter request. A long-running
 * channel accumulates one bundle row per analyzer tick, so the id list is
 * unbounded in principle; Qdrant would eventually refuse an over-long filter.
 * Batching keeps every request small, and every batch is awaited together so a
 * failure in any of them fails the whole call.
 */
const VECTOR_DELETE_BATCH_SIZE = 200;

/**
 * Which monitored conversation was unlinked, in the terms its own
 * `ProjectContext.metadata` is written in.
 *
 * The three shapes mirror the three matching predicates exactly — Teams
 * channels are keyed on `(teamId, channelId)`, Teams chats on `chatId`, Slack
 * channels on `channelId` alone. The Slack asymmetry is not an oversight: the
 * Add-Context writers never persisted a workspace id, so keying on one would
 * fail to recognize the rows they created. See `slack-integration-context.ts`.
 */
export type UnlinkedConversationRef =
	| {
			provider: "MICROSOFT_TEAMS";
			kind: "channel";
			teamId: string;
			channelId: string;
	  }
	| { provider: "MICROSOFT_TEAMS"; kind: "chat"; chatId: string }
	| { provider: "SLACK"; kind: "channel"; channelId: string };

export interface DeleteMonitoredConversationContextParams {
	projectId: string;
	/**
	 * The person unlinking. Only ever used as the tenant a PERSONAL pending
	 * cleanup record is written and read under — an organization record carries
	 * the organization instead, under the XOR the table enforces.
	 */
	userId: string;
	/**
	 * Tenant, used to resolve the collection the vectors are actually in and to
	 * scope the delete filter. The caller has already verified the project
	 * belongs to this tenant.
	 */
	organizationId?: string | null;
	conversation: UnlinkedConversationRef;
}

export interface DeleteMonitoredConversationContextResult {
	/** Pointer rows removed. Empty means the channel had no context row. */
	contextIds: string[];
	/** Bundle rows that cascaded, whose vectors were deleted by filter. */
	bundleIds: string[];
	/**
	 * Stranded id lists this call finished on behalf of an earlier attempt.
	 * Non-zero means a previous unlink of THIS project failed at the vector
	 * store and the retry cleaned up after it — which is the whole point of the
	 * queue, and worth being visible in the caller's logs.
	 */
	drainedPendingCleanups: number;
}

/** Does this context row describe the conversation being unlinked? */
function metadataMatches(
	metadata: unknown,
	conversation: UnlinkedConversationRef,
): boolean {
	if (conversation.provider === "SLACK") {
		return slackChannelContextMatches(metadata, {
			channelId: conversation.channelId,
		});
	}
	if (conversation.kind === "chat") {
		return teamsChatContextMatches(metadata, {
			chatId: conversation.chatId,
		});
	}
	return teamsChannelContextMatches(metadata, {
		teamId: conversation.teamId,
		channelId: conversation.channelId,
	});
}

/**
 * Delete every point belonging to any of `contextIds`, in the collection that
 * actually holds this tenant's vectors.
 *
 * Chunked contexts store each chunk with `originalContextId` pointing back at
 * the base id and single-chunk ones carry `contextId`, so both keys are matched.
 * `projectId` narrows the delete to this project, and `organizationId` is added
 * as defense in depth on top of the physical isolation the per-organization
 * collection already provides.
 *
 * Exported for the OTHER half of the protocol: the embedder's compensating
 * delete in `capture-conversation-bundle.ts` removes the single point it just
 * wrote, and it has to reach it the same way — same resolver, same never-create
 * existence check, same throwing contract. A second implementation over there
 * is precisely the thing that would drift into aiming at another collection.
 * THROWS on a vector-store failure; both callers depend on that.
 */
export async function deleteContextVectors(params: {
	contextIds: string[];
	projectId: string;
	organizationId?: string | null;
}): Promise<void> {
	const { contextIds, projectId, organizationId } = params;
	if (contextIds.length === 0) {
		return;
	}

	const collectionName = getCollectionName(
		PROJECT_CONTEXTS_BASE_COLLECTION,
		organizationId,
	);

	// A collection that was never created is a success, not a failure:
	// per-organization collections are created lazily on first write, so a
	// tenant that never embedded anything legitimately has none. Failing here
	// would make every unlink in such a tenant an error.
	if (!(await collectionExistsUncached(collectionName))) {
		logger.info(
			"[ChannelContextDeletion] Collection does not exist — no vectors to delete",
			{ collectionName, projectId },
		);
		return;
	}

	// The batches address DISJOINT id sets and nothing downstream reads a
	// partial result, so there is no ordering between them to preserve —
	// issuing them together just shortens the window in which the rows are
	// gone and their vectors are not. `Promise.all` still fails the whole call
	// on any rejection, which is the property the caller depends on.
	const batches: string[][] = [];
	for (let i = 0; i < contextIds.length; i += VECTOR_DELETE_BATCH_SIZE) {
		batches.push(contextIds.slice(i, i + VECTOR_DELETE_BATCH_SIZE));
	}

	await Promise.all(
		batches.map((batch) => {
			const must: Array<Record<string, unknown>> = [
				{ key: "projectId", match: { value: projectId } },
			];
			if (organizationId) {
				must.push({
					key: "organizationId",
					match: { value: organizationId },
				});
			}
			must.push({
				should: [
					{ key: "contextId", match: { any: batch } },
					{ key: "originalContextId", match: { any: batch } },
				],
			});

			return qdrant.delete(collectionName, {
				wait: true,
				filter: { must },
			});
		}),
	);

	logger.info(
		"[ChannelContextDeletion] Deleted vectors for unlinked channel",
		{
			collectionName,
			projectId,
			contextCount: contextIds.length,
		},
	);
}

/**
 * Finish one stranded id list: delete its vectors, then drop the record.
 *
 * THROWS on a vector-store failure, and the record is left standing when it
 * does — clearing it before the store confirms would reopen the exact window
 * the queue exists to close. Exported for the scheduled sweep, which is the
 * other drain; a second implementation over there is precisely the thing that
 * would drift into clearing a record whose points are still indexed.
 *
 * The collection is resolved from the RECORD'S own `organizationId`, never from
 * an ambient value: the sweep runs across tenants, and a delete aimed at
 * another tenant's collection matches nothing and looks like a clean pass.
 */
export async function drainPendingVectorCleanup(
	record: PendingVectorCleanupRecord,
): Promise<void> {
	await deleteContextVectors({
		contextIds: record.contextIds,
		projectId: record.projectId,
		organizationId: record.organizationId,
	});
	await clearPendingVectorCleanup(record.id);
}

/**
 * Delete the unlinked conversation's pointer row, everything captured under it,
 * and every vector either of them put in the store.
 *
 * Finding nothing is a NO-OP, not an error: a channel linked before capture
 * shipped, or one whose context row was already removed, has nothing to clean
 * up and must not fail the unlink.
 *
 * A vector-store failure THROWS, and leaves a `ProjectContextPendingVectorCleanup`
 * record holding the ids. The rows are already gone by then, which is the price
 * of the ordering that makes the concurrent-embed guard work — but reporting
 * success while conversation text stays searchable in the vector store is the
 * failure this unit exists to prevent, so the caller must see it AND the ids
 * have to survive the call, or the retry the caller is invited to make has
 * nothing left to work from.
 *
 * The queue is drained FIRST, before the "nothing matched" early return, which
 * is what makes a plain retry of the same unlink finish an earlier attempt's
 * job: by then the context row is gone, so every later attempt takes that
 * return. A drain failure propagates for the same reason the delete's does —
 * the vector store is evidently unwell, and this call would fail at its own
 * delete anyway.
 */
export async function deleteMonitoredConversationContext(
	params: DeleteMonitoredConversationContextParams,
): Promise<DeleteMonitoredConversationContextResult> {
	const { projectId, userId, organizationId, conversation } = params;
	const tenant = { userId, organizationId: organizationId ?? null };

	// BEFORE the early return below, not after it. An unlink that failed at the
	// vector store left the ids here and nothing else: its context row is gone,
	// so this call — and every later one — matches nothing and returns early.
	// Draining first is what turns "retry the unlink" from advice into a thing
	// that works.
	const pending = await listPendingVectorCleanupsForProject({
		projectId,
		tenant,
	});
	for (const record of pending) {
		await drainPendingVectorCleanup(record);
	}
	if (pending.length > 0) {
		logger.info(
			"[ChannelContextDeletion] Drained stranded vector cleanups before unlinking",
			{ projectId, drained: pending.length },
		);
	}

	// Located through the SAME predicate the capture path uses, and scoped the
	// same way — `projectId` plus `type: "INTEGRATION"`, with the tenant check
	// already done by the caller on the project. A narrower filter here than
	// `findParentContextId` uses would be a real bug: capture would keep
	// finding and reattaching to a row the unlink had skipped.
	const rows = await db.projectContext.findMany({
		where: { projectId, type: "INTEGRATION" },
		select: { id: true, metadata: true },
	});
	const contextIds = rows
		.filter((row) => metadataMatches(row.metadata, conversation))
		.map((row) => row.id);

	if (contextIds.length === 0) {
		logger.info(
			"[ChannelContextDeletion] No context row for unlinked conversation — nothing to delete",
			{ projectId, provider: conversation.provider },
		);
		return {
			contextIds: [],
			bundleIds: [],
			drainedPendingCleanups: pending.length,
		};
	}

	// Read BEFORE the delete below cascades these rows out of existence. Their
	// ids are the only way to reach their vectors afterwards.
	const bundles = await db.projectContextConversationBundle.findMany({
		where: { parentContextId: { in: contextIds }, projectId },
		select: { id: true },
	});
	const bundleIds = bundles.map((bundle) => bundle.id);
	const strandableIds = [...contextIds, ...bundleIds];

	// Mark the parent as deleting — by removing it. Row absence IS the state
	// `parentStillLinked` reads, and it has to be established before the first
	// Qdrant call so an embedder holding a lease either abandons or compensates
	// instead of leaving a point behind. Cascades the bundles and their claims.
	//
	// The ids go down in the SAME transaction, so there is no interleaving in
	// which the rows are gone and nothing remembers what their vectors were
	// called. Recording them first and deleting second would be two failures to
	// reason about; one transaction is none.
	const pendingId = await db.$transaction(async (tx) => {
		const recordId = await createPendingVectorCleanup(tx, {
			projectId,
			contextIds: strandableIds,
			tenant,
		});
		await tx.projectContext.deleteMany({
			where: { id: { in: contextIds }, projectId },
		});
		return recordId;
	});

	try {
		await deleteContextVectors({
			contextIds: strandableIds,
			projectId,
			organizationId,
		});
	} catch (error) {
		logger.error(
			"[ChannelContextDeletion] Failed to delete vectors for unlinked conversation — ids queued for retry",
			{
				projectId,
				provider: conversation.provider,
				contextIds,
				bundleIds,
				pendingCleanupId: pendingId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		throw error;
	}

	// Only now. The record is the ONLY remaining trace of these ids, so it is
	// dropped strictly after the store has confirmed the points are gone.
	await clearPendingVectorCleanup(pendingId);

	return {
		contextIds,
		bundleIds,
		drainedPendingCleanups: pending.length,
	};
}
