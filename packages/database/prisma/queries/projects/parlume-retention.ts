/**
 * The end of life of what a Parlume meeting said (decision D5).
 *
 * A finished session's raw meeting content goes on a member's delete, or
 * from the retention sweep {@link PARLUME_TRANSCRIPT_RETENTION_DAYS} days
 * after the meeting. Both keep the session row, and the notes: they are on
 * the transcript context's metadata, so the context row stays with its text
 * emptied and its vectors queued for deletion in the same transaction
 * (`pending-vector-cleanup.ts`). The caller drains that record after the
 * commit; the pending-cleanup sweep finishes what it cannot.
 */
import { db, type Prisma } from "../../client";
import { conversationTenantColumns } from "./conversation-bundles";
import {
	createPendingVectorCleanup,
	type PendingVectorCleanupRecord,
} from "./pending-vector-cleanup";

export const PARLUME_TRANSCRIPT_RETENTION_DAYS = 90;

/**
 * A session nothing adds content to any more: ended, or failed with its
 * finalization done or with no bot that could still send anything.
 */
const SETTLED_SESSION: Prisma.ParlumeMeetingSessionWhereInput = {
	OR: [
		{ status: "ENDED" },
		{ status: "FAILED", finalizedAt: { not: null } },
		{ status: "FAILED", providerBotId: null },
	],
};

/**
 * - `SESSION`: a member's delete. The segments, the requests with their
 *   proposed changes, the suggestions and the webhook receipts go.
 * - `TRANSCRIPT`: the retention sweep. The segments and the receipts go; the
 *   requests and suggestions stay without the words the meeting said.
 *
 * Either way the transcript context keeps its notes and loses its text and
 * vectors.
 */
export type ParlumeContentPurge = "SESSION" | "TRANSCRIPT";

export interface ParlumeContentPurgeResult {
	/** False when the session is still live, or the sweep already purged it. */
	purged: boolean;
	/** The transcript's vectors, to drain after the commit. */
	vectorCleanup: PendingVectorCleanupRecord | null;
}

export async function purgeParlumeSessionContent(input: {
	sessionId: string;
	projectId: string;
	scope: ParlumeContentPurge;
	now?: Date;
}): Promise<ParlumeContentPurgeResult> {
	const now = input.now ?? new Date();
	return db.$transaction(async (tx) => {
		const session = await tx.parlumeMeetingSession.findFirst({
			where: {
				id: input.sessionId,
				projectId: input.projectId,
				...SETTLED_SESSION,
				...(input.scope === "TRANSCRIPT"
					? { transcriptDeletedAt: null }
					: {}),
			},
			select: {
				id: true,
				projectId: true,
				organizationId: true,
				userId: true,
				transcriptContextId: true,
				transcriptDeletedAt: true,
			},
		});
		if (!session) {
			return { purged: false, vectorCleanup: null };
		}
		const where = {
			sessionId: session.id,
			projectId: session.projectId,
			organizationId: session.organizationId,
		};
		await tx.parlumeMeetingSegment.deleteMany({ where });
		await tx.parlumeWebhookReceipt.deleteMany({ where });
		switch (input.scope) {
			case "SESSION":
				await tx.parlumeAction.deleteMany({ where });
				await tx.parlumeMeetingTurn.deleteMany({ where });
				await tx.parlumeSuggestion.deleteMany({ where });
				break;
			case "TRANSCRIPT":
				await tx.parlumeMeetingTurn.updateMany({
					where,
					data: { requestText: "", responseText: null },
				});
				await tx.parlumeSuggestion.updateMany({
					where,
					data: { quote: null },
				});
				break;
			default: {
				const unreachable: never = input.scope;
				throw new Error(`Unknown Parlume purge: ${unreachable}`);
			}
		}
		// The speaker marks name the participants by their Teams ids, so they
		// go with the segments they marked.
		await tx.parlumeMeetingSession.update({
			where: { id: session.id },
			data: {
				transcriptDeletedAt: session.transcriptDeletedAt ?? now,
				memberSpeakerIds: [],
				guestSpeakerIds: [],
			},
		});
		const contextId = session.transcriptContextId;
		if (!contextId) {
			return { purged: true, vectorCleanup: null };
		}
		const { count } = await tx.projectContext.updateMany({
			where: {
				id: contextId,
				projectId: session.projectId,
				organizationId: session.organizationId,
				NOT: { content: "", embeddedAt: null, qdrantId: null },
			},
			data: { content: "", embeddedAt: null, qdrantId: null },
		});
		return {
			purged: true,
			vectorCleanup:
				count > 0
					? await queueVectorCleanup(tx, {
							projectId: session.projectId,
							contextId,
							tenant: {
								userId: session.userId,
								organizationId: session.organizationId,
							},
						})
					: null,
		};
	});
}

async function queueVectorCleanup(
	tx: Prisma.TransactionClient,
	input: {
		projectId: string;
		contextId: string;
		tenant: { userId: string; organizationId: string };
	},
): Promise<PendingVectorCleanupRecord> {
	const id = await createPendingVectorCleanup(tx, {
		projectId: input.projectId,
		contextIds: [input.contextId],
		tenant: input.tenant,
	});
	return {
		id,
		projectId: input.projectId,
		contextIds: [input.contextId],
		...conversationTenantColumns(input.tenant),
	};
}

/** Settled sessions whose meeting is older than the retention period, oldest first. */
export async function listParlumeSessionsPastRetention(input: {
	now: Date;
	limit: number;
}): Promise<Array<{ id: string; projectId: string }>> {
	const cutoff = new Date(
		input.now.getTime() -
			PARLUME_TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
	);
	return db.parlumeMeetingSession.findMany({
		where: {
			...SETTLED_SESSION,
			transcriptDeletedAt: null,
			createdAt: { lt: cutoff },
		},
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		take: input.limit,
		select: { id: true, projectId: true },
	});
}

/**
 * Parlume transcripts are never embedded: retrieval reads their notes, not
 * what was said. A transcript embedded before that, or again by a project's
 * "embed all", has its index marks cleared here and its vectors queued for
 * deletion, at most `limit` at a time.
 */
export async function dropParlumeTranscriptVectors(input: {
	limit: number;
}): Promise<PendingVectorCleanupRecord[]> {
	const embedded = await db.$queryRaw<
		Array<{
			contextId: string;
			projectId: string;
			organizationId: string;
			userId: string;
		}>
	>`
		SELECT c.id AS "contextId", s."projectId", s."organizationId", s."userId"
		  FROM parlume_meeting_session s
		  JOIN project_context c
		    ON c.id = s."transcriptContextId"
		   AND c."projectId" = s."projectId"
		   AND c."organizationId" = s."organizationId"
		 WHERE c."embeddedAt" IS NOT NULL OR c."qdrantId" IS NOT NULL
		 ORDER BY c.id
		 LIMIT ${input.limit}::integer
	`;
	const cleanups: PendingVectorCleanupRecord[] = [];
	for (const row of embedded) {
		cleanups.push(
			await db.$transaction(async (tx) => {
				await tx.projectContext.updateMany({
					where: {
						id: row.contextId,
						projectId: row.projectId,
						organizationId: row.organizationId,
					},
					data: { embeddedAt: null, qdrantId: null },
				});
				return queueVectorCleanup(tx, {
					projectId: row.projectId,
					contextId: row.contextId,
					tenant: {
						userId: row.userId,
						organizationId: row.organizationId,
					},
				});
			}),
		);
	}
	return cleanups;
}
