/**
 * The 7-day recovery window for a destructively unlinked meeting (Fizzy #2355).
 *
 * Deleting a meeting stays exactly as destructive as it was — the row is really
 * deleted, the cascade really fires, the vectors are really purged. What changes
 * is that the rows are copied out first, so the action is recoverable for a week
 * without any live table ever holding a tombstone.
 *
 * NOTE: like its sibling `meeting-transcripts.ts`, these queries are called from
 * procedures and activities that handle tenant context separately.
 */

import { db } from "../../client";
import type { Prisma } from "../../generated/client";

/** Matches the `Project` soft-delete window, deliberately. */
const RECOVERY_WINDOW_DAYS = 7;

/**
 * Cap on the archived transcript bodies, in characters.
 *
 * A meeting with ~50 long transcripts is a couple of megabytes of JSON, which
 * Postgres TOASTs happily. Past this we archive metadata only and mark the row
 * rather than failing: a deletion the user asked for must never be blocked by
 * the size of what is being deleted.
 */
const MAX_ARCHIVED_CONTENT_CHARS = 8_000_000;

export type ArchivedTranscript = {
	meetingId: string;
	transcriptId: string;
	meetingSubject: string | null;
	meetingDate: Date | null;
	summary: string | null;
	keywords: string[];
	speakerNames: string[];
	contentLength: number | null;
	wasSummarized: boolean;
	syncedAt: Date;
	/** The context body, or null when the payload was truncated. */
	content: string | null;
	contextFilename: string | null;
};

export type MeetingArchivePayload = {
	version: 1;
	meeting: {
		joinUrl: string;
		subject: string | null;
		organizer: string | null;
		includedInDigest: boolean;
		linkedAt: Date;
		deactivatedAt: Date | null;
		/**
		 * Who linked the meeting. Optional because archives written before this
		 * field existed do not carry it — a restore from one of those cannot
		 * recover the attribution and must not invent it.
		 */
		linkedByUserId?: string | null;
	};
	transcripts: ArchivedTranscript[];
};

/**
 * Read everything worth keeping about a meeting, before it is deleted.
 *
 * Returns `null` when the meeting does not exist in this project, which the
 * caller must treat as "do not proceed with the delete" — archiving nothing and
 * deleting anyway is the one outcome this feature exists to prevent.
 */
export async function buildMeetingArchivePayload(params: {
	projectId: string;
	linkedMeetingId: string;
}): Promise<{
	payload: MeetingArchivePayload;
	transcriptCount: number;
	truncated: boolean;
	joinUrl: string;
	subject: string | null;
} | null> {
	const meeting = await db.projectLinkedMeeting.findFirst({
		where: { id: params.linkedMeetingId, projectId: params.projectId },
		select: {
			joinUrl: true,
			subject: true,
			organizer: true,
			includedInDigest: true,
			linkedAt: true,
			deactivatedAt: true,
			// On a linked meeting this is WHO LINKED IT, not the tenant: linking
			// writes the caller's id here whether the project is org-owned or
			// personal (the table's RLS is user_owned, and an org row carries
			// both columns). Archiving it is what lets a restore put it back.
			userId: true,
		},
	});

	if (!meeting) {
		return null;
	}

	const transcripts = await db.projectMeetingTranscript.findMany({
		where: {
			projectId: params.projectId,
			linkedMeetingId: params.linkedMeetingId,
		},
		select: {
			meetingId: true,
			transcriptId: true,
			meetingSubject: true,
			meetingDate: true,
			contextId: true,
			summary: true,
			keywords: true,
			speakerNames: true,
			contentLength: true,
			wasSummarized: true,
			syncedAt: true,
		},
		orderBy: { meetingDate: "asc" },
	});

	const contextIds = transcripts
		.map((t) => t.contextId)
		.filter((id): id is string => id !== null);

	const contexts =
		contextIds.length > 0
			? await db.projectContext.findMany({
					where: {
						id: { in: contextIds },
						projectId: params.projectId,
					},
					select: { id: true, originalFilename: true, content: true },
				})
			: [];

	const contextById = new Map(contexts.map((c) => [c.id, c]));

	// Decide truncation once, over the whole set: a payload that keeps some
	// bodies and drops others would restore a meeting with holes in it, which
	// is worse than one that restores metadata and says so.
	const totalChars = contexts.reduce(
		(sum, c) => sum + (c.content?.length ?? 0),
		0,
	);
	const truncated = totalChars > MAX_ARCHIVED_CONTENT_CHARS;

	return {
		payload: {
			version: 1,
			meeting: {
				joinUrl: meeting.joinUrl,
				subject: meeting.subject,
				organizer: meeting.organizer,
				includedInDigest: meeting.includedInDigest,
				linkedAt: meeting.linkedAt,
				deactivatedAt: meeting.deactivatedAt,
				linkedByUserId: meeting.userId,
			},
			transcripts: transcripts.map((t) => {
				const ctx = t.contextId
					? contextById.get(t.contextId)
					: undefined;
				return {
					meetingId: t.meetingId,
					transcriptId: t.transcriptId,
					meetingSubject: t.meetingSubject,
					meetingDate: t.meetingDate,
					summary: t.summary,
					keywords: t.keywords,
					speakerNames: t.speakerNames,
					contentLength: t.contentLength,
					wasSummarized: t.wasSummarized,
					syncedAt: t.syncedAt,
					content: truncated ? null : (ctx?.content ?? null),
					contextFilename: ctx?.originalFilename ?? null,
				};
			}),
		},
		transcriptCount: transcripts.length,
		truncated,
		joinUrl: meeting.joinUrl,
		subject: meeting.subject,
	};
}

/** Write the archive row. Returns its id so a failed delete can undo it. */
export async function createMeetingArchive(params: {
	projectId: string;
	joinUrl: string;
	subject: string | null;
	transcriptCount: number;
	payloadTruncated: boolean;
	payload: MeetingArchivePayload;
	deletedById: string;
	userId?: string | null;
	organizationId?: string | null;
}) {
	const scheduledPurgeAt = new Date(
		Date.now() + RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
	);

	return await db.deletedMeetingArchive.create({
		data: {
			projectId: params.projectId,
			joinUrl: params.joinUrl,
			subject: params.subject,
			transcriptCount: params.transcriptCount,
			payloadTruncated: params.payloadTruncated,
			payload: params.payload as unknown as Prisma.InputJsonValue,
			deletedById: params.deletedById,
			scheduledPurgeAt,
			userId: params.userId ?? null,
			organizationId: params.organizationId ?? null,
		},
		select: { id: true, scheduledPurgeAt: true },
	});
}

/** The recently-deleted list. Ordered newest first, expired rows excluded. */
export async function listMeetingArchives(projectId: string) {
	return await db.deletedMeetingArchive.findMany({
		where: { projectId, scheduledPurgeAt: { gt: new Date() } },
		select: {
			id: true,
			joinUrl: true,
			subject: true,
			transcriptCount: true,
			deletedAt: true,
			deletedById: true,
			scheduledPurgeAt: true,
			payloadTruncated: true,
		},
		orderBy: { deletedAt: "desc" },
	});
}

export async function getMeetingArchive(params: {
	projectId: string;
	archiveId: string;
}) {
	return await db.deletedMeetingArchive.findFirst({
		where: { id: params.archiveId, projectId: params.projectId },
	});
}

export async function deleteMeetingArchive(params: {
	projectId: string;
	archiveId: string;
}) {
	return await db.deletedMeetingArchive.deleteMany({
		where: { id: params.archiveId, projectId: params.projectId },
	});
}

/**
 * Purge expired archives.
 *
 * Re-queries from the top each pass rather than walking a cursor — safe because
 * purged rows drop out of the predicate — and is bounded by `maxBatches` so a
 * pathological backlog cannot run forever. Mirrors `purgeExpiredBackgroundJobs`.
 */
export async function purgeExpiredMeetingArchives(args: {
	batchSize?: number;
	maxBatches?: number;
}): Promise<{ deleted: number; batches: number }> {
	const batchSize = args.batchSize ?? 500;
	const maxBatches = args.maxBatches ?? 100;
	const now = new Date();

	let deleted = 0;
	let batches = 0;

	while (batches < maxBatches) {
		const doomed = await db.deletedMeetingArchive.findMany({
			where: { scheduledPurgeAt: { lte: now } },
			select: { id: true },
			take: batchSize,
		});

		if (doomed.length === 0) {
			break;
		}

		const result = await db.deletedMeetingArchive.deleteMany({
			where: { id: { in: doomed.map((row) => row.id) } },
		});

		deleted += result.count;
		batches++;

		if (doomed.length < batchSize) {
			break;
		}
	}

	return { deleted, batches };
}
