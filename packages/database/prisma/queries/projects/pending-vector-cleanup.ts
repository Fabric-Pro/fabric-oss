/**
 * The queue of ids whose VECTORS are still owed a delete, after the rows that
 * held them are already gone (Fizzy #2228).
 *
 * # The window this closes
 *
 * `deleteMonitoredConversationContext` deletes a monitored channel's pointer
 * `ProjectContext` row and the bundles that cascade from it BEFORE it deletes
 * their vectors. That ordering is load-bearing, not incidental: row absence is
 * the state a concurrent embedder reads to decide whether to abandon its write
 * or compensate for it (see `capture-conversation-bundle.ts`). Reversing it
 * opens a window in which an embedder writes a point after the delete filter
 * has passed and before the row disappears, sees a live parent, and keeps it.
 *
 * The cost of getting that right is that between the commit and the vector
 * delete, the ids exist only in one call's memory. A vector-store failure there
 * stranded the points where no retry could reach them: the retry found no
 * context row, took the "nothing to delete" early return, and reported SUCCESS
 * while the conversation text stayed indexed. The Qdrant payload carries the
 * message text, so a user was told their conversations were removed from a
 * third-party store that still held them.
 *
 * So the ordering stays and the IDS are made to survive instead. A record here
 * is written in the SAME transaction as the row delete — that is the whole
 * mechanism, and it is why `createPendingVectorCleanup` takes a transaction
 * client rather than opening its own — and it is cleared only once the vector
 * store has confirmed.
 *
 * # Two drains, one queue
 *
 * A retried unlink drains its own project's records before it looks for a
 * context row, so a plain retry of the same action finishes the job. The
 * scheduled bundle-embedding sweep drains the queue project-blind, so cleanup
 * completes even when the user never comes back. Neither is a fallback for the
 * other: the first makes the retry the doc comments promise actually work, the
 * second bounds how long a stranded point can live when nobody retries.
 *
 * # `ownerKey` is not written here — there is none
 *
 * Unlike the two capture tables, this one carries no generated `ownerKey`. That
 * column exists there to support an owner-inclusive composite foreign key back
 * to `project_context`; this table deliberately references no context row, so
 * there is nothing to compare an owner against.
 */
import { db } from "../../client";
import type { Prisma } from "../../generated/client";
import {
	type ConversationCaptureTenant,
	conversationTenantColumns,
	conversationTenantFilter,
} from "./conversation-bundles";

/**
 * One outstanding cleanup: the ids, and the tenant whose collection they are
 * in.
 *
 * `organizationId` is not only tenancy — it DECIDES WHICH COLLECTION the points
 * live in, so every drain resolves the collection from this field rather than
 * from an ambient value. A sweep that used a run-wide tenant would aim a delete
 * at a collection the points are not in and report a clean pass.
 */
export interface PendingVectorCleanupRecord {
	id: string;
	projectId: string;
	contextIds: string[];
	userId: string | null;
	organizationId: string | null;
}

const PENDING_CLEANUP_SELECT = {
	id: true,
	projectId: true,
	contextIds: true,
	userId: true,
	organizationId: true,
} as const;

/**
 * How many stranded id lists one sweep pass drains.
 *
 * Deliberately modest, and for the same reason as the bundle sweep's batch:
 * every record costs a round trip to the vector store, and this queue is
 * supposed to be EMPTY. A pass that regularly comes back full is a signal that
 * something is wrong with the vector store, not a capacity problem to solve by
 * raising the number.
 */
export const PENDING_VECTOR_CLEANUP_SWEEP_BATCH = 25;

/**
 * Record the ids an about-to-commit delete will strand.
 *
 * Takes a transaction client because it MUST share the transaction that removes
 * the rows. Written in a transaction of its own it would be a second thing that
 * can fail independently — and the failure mode it exists to prevent is exactly
 * "the rows are gone and the ids are not recorded".
 */
export async function createPendingVectorCleanup(
	client: Prisma.TransactionClient,
	params: {
		projectId: string;
		contextIds: string[];
		tenant: ConversationCaptureTenant;
	},
): Promise<string> {
	const record = await client.projectContextPendingVectorCleanup.create({
		data: {
			projectId: params.projectId,
			contextIds: params.contextIds,
			...conversationTenantColumns(params.tenant),
		},
		select: { id: true },
	});
	return record.id;
}

/**
 * Everything still owed for one project, under the caller's own tenant.
 *
 * The XOR filter is applied even though the caller has already resolved the
 * project under its tenant: a record is reached here by project id, and a
 * project id is not a permission. Same rule the bundle resolver follows.
 *
 * Oldest first so a retry drains in the order the failures happened.
 */
export async function listPendingVectorCleanupsForProject(params: {
	projectId: string;
	tenant: ConversationCaptureTenant;
}): Promise<PendingVectorCleanupRecord[]> {
	return await db.projectContextPendingVectorCleanup.findMany({
		where: {
			projectId: params.projectId,
			...conversationTenantFilter(params.tenant),
		},
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		select: PENDING_CLEANUP_SELECT,
	});
}

/**
 * The next records the scheduled sweep should attempt, across every tenant.
 *
 * Deliberately NOT tenant-filtered: this runs as the system, on behalf of
 * nobody, and the tenant it acts under is read off each record. That is the
 * same shape `listConversationBundlesAwaitingEmbedding` has, and for the same
 * reason — a run-wide tenant would send one tenant's delete at another's
 * collection.
 *
 * `attempts` leads the ordering so a record the vector store keeps refusing
 * cannot sit at the head of every bounded batch and starve records that would
 * succeed. `createdAt` breaks the tie, and `id` makes the order total so two
 * runs over an unchanged queue agree about the prefix they take.
 */
export async function listPendingVectorCleanups(
	params: { limit?: number } = {},
): Promise<PendingVectorCleanupRecord[]> {
	return await db.projectContextPendingVectorCleanup.findMany({
		orderBy: [{ attempts: "asc" }, { createdAt: "asc" }, { id: "asc" }],
		take: params.limit ?? PENDING_VECTOR_CLEANUP_SWEEP_BATCH,
		select: PENDING_CLEANUP_SELECT,
	});
}

/**
 * Drop a record whose vectors the store has confirmed gone.
 *
 * Called ONLY after the delete returns, never before — clearing it first would
 * reopen precisely the window this table exists to close.
 */
export async function clearPendingVectorCleanup(id: string): Promise<void> {
	await db.projectContextPendingVectorCleanup.deleteMany({ where: { id } });
}

/**
 * Note a drain that did not go through, so the sweep's ordering can move past
 * it and an operator can see why it keeps coming back.
 *
 * `updateMany` rather than `update`: the record may have been drained by the
 * other drain between the attempt and this write, and a missing row is not an
 * error worth failing a sweep for.
 */
export async function recordPendingVectorCleanupFailure(params: {
	id: string;
	error: string;
}): Promise<void> {
	await db.projectContextPendingVectorCleanup.updateMany({
		where: { id: params.id },
		data: {
			attempts: { increment: 1 },
			lastError: params.error,
		},
	});
}
