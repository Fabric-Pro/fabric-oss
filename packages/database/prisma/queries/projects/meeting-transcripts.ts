/**
 * Database queries for ProjectLinkedMeeting and ProjectMeetingTranscript models
 * Handles meeting transcript sync tracking for projects
 *
 * NOTE: These queries are called from Temporal activities which handle
 * tenant context separately, so tenant filtering is not applied here.
 */

import { db } from "../../client";

// ---------------------------------------------------------------------------
// Linked Meetings (project settings)
// ---------------------------------------------------------------------------

/**
 * Link a meeting to a project (upsert by projectId + joinUrl)
 */
export async function linkMeetingToProject(params: {
	projectId: string;
	joinUrl: string;
	subject?: string;
	organizer?: string;
	userId?: string;
	organizationId?: string;
}) {
	return await db.projectLinkedMeeting.upsert({
		where: {
			projectId_joinUrl: {
				projectId: params.projectId,
				joinUrl: params.joinUrl,
			},
		},
		create: {
			projectId: params.projectId,
			joinUrl: params.joinUrl,
			subject: params.subject,
			organizer: params.organizer,
			userId: params.userId,
			organizationId: params.organizationId,
		},
		update: {
			subject: params.subject,
			organizer: params.organizer,
		},
	});
}

/**
 * Unlink a meeting from a project
 * Cascades to delete associated transcript records via DB relation
 */
export async function unlinkMeetingFromProject(
	projectId: string,
	linkedMeetingId: string,
) {
	return await db.projectLinkedMeeting.delete({
		where: {
			id: linkedMeetingId,
			projectId,
		},
	});
}

/**
 * List linked meetings for a project with transcript counts
 */
export async function getLinkedMeetings(projectId: string) {
	return await db.projectLinkedMeeting.findMany({
		where: { projectId },
		include: {
			_count: {
				select: { transcripts: true },
			},
		},
		orderBy: { linkedAt: "desc" },
	});
}

/**
 * Get just the join URLs for linked meetings (used by the sync workflow)
 *
 * Deactivated meetings are excluded here and ONLY here. "Stop syncing" means
 * exactly this query stops seeing the row — the meeting, its transcripts and
 * their context stay live and readable everywhere else, which is what makes it
 * the non-destructive alternative to unlinking (Fizzy #2355).
 *
 * `userId` — who linked the meeting — is returned because the sync now reads
 * each meeting under that person's own Microsoft account (Fizzy #2354). It was
 * written at link time and read by nothing, which is why a project could only
 * ever collect the meetings ONE account could see. Null on rows linked before
 * the column existed; the workflow falls back to the project-level account for
 * those.
 */
export async function getLinkedMeetingJoinUrls(projectId: string) {
	return await db.projectLinkedMeeting.findMany({
		where: { projectId, deactivatedAt: null },
		select: {
			id: true,
			joinUrl: true,
			subject: true,
			userId: true,
		},
	});
}

/**
 * Count the meetings a sync would actually pull from.
 *
 * Gates "is there anything to sync": a project whose only linked meeting is
 * deactivated must not be able to start a sync that would find nothing.
 */
export async function countSyncableLinkedMeetings(projectId: string) {
	return await db.projectLinkedMeeting.count({
		where: { projectId, deactivatedAt: null },
	});
}

/**
 * Stop syncing a meeting without touching anything it has already captured.
 *
 * Deliberately an `update` with a `projectId` guard rather than a bare update
 * by id: the id alone would let a caller in one project stop a meeting in
 * another.
 */
export async function deactivateLinkedMeeting(params: {
	projectId: string;
	linkedMeetingId: string;
	userId: string;
}) {
	return await db.projectLinkedMeeting.update({
		where: { id: params.linkedMeetingId, projectId: params.projectId },
		data: {
			deactivatedAt: new Date(),
			deactivatedById: params.userId,
		},
	});
}

/** Resume syncing a previously stopped meeting. */
export async function reactivateLinkedMeeting(params: {
	projectId: string;
	linkedMeetingId: string;
}) {
	return await db.projectLinkedMeeting.update({
		where: { id: params.linkedMeetingId, projectId: params.projectId },
		data: {
			deactivatedAt: null,
			deactivatedById: null,
		},
	});
}

/**
 * Record that a meeting sync could not reach Microsoft.
 *
 * Mirrors `recordTeamsChannelFailure`. `linkedMeetingIds` scopes the write to
 * the meetings the failed calendar read was actually responsible for — since
 * #2354 a project reads one calendar per linker, so a stamp across the whole
 * project would blame everybody else's meetings for one person's dead
 * connection. Omit it only for a genuinely project-wide failure.
 *
 * Scoped by id rather than by `userId` on purpose: the fallback group is "rows
 * with no linker OR rows linked by the project's bound account", which is not
 * expressible as one `userId` predicate, and a `userId` filter would silently
 * skip every null row.
 */
export async function recordMeetingSyncFailure(params: {
	projectId: string;
	errorMessage: string;
	linkedMeetingIds?: string[];
}) {
	return await db.projectLinkedMeeting.updateMany({
		where: {
			projectId: params.projectId,
			deactivatedAt: null,
			...(params.linkedMeetingIds
				? { id: { in: params.linkedMeetingIds } }
				: {}),
		},
		data: {
			consecutiveFailures: { increment: 1 },
			lastErrorMessage: params.errorMessage.slice(0, 4000),
			lastErrorAt: new Date(),
		},
	});
}

/**
 * Clear the failure state after a pass that actually reached Microsoft.
 *
 * Without this a project that recovers while quiet keeps its banner forever —
 * the exact bug the channel monitors hit in #2311.
 *
 * Scoped the same way as `recordMeetingSyncFailure`, and for a sharper reason:
 * unscoped, one healthy linker's pass would clear a departed linker's failures
 * on every cycle, so the banner naming the connection that needs attention
 * would flicker off and the sync would go back to looking healthy (#2354).
 */
export async function clearMeetingSyncFailures(params: {
	projectId: string;
	linkedMeetingIds?: string[];
}) {
	return await db.projectLinkedMeeting.updateMany({
		where: {
			projectId: params.projectId,
			consecutiveFailures: { gt: 0 },
			...(params.linkedMeetingIds
				? { id: { in: params.linkedMeetingIds } }
				: {}),
		},
		data: {
			consecutiveFailures: 0,
			lastErrorMessage: null,
			lastErrorAt: null,
		},
	});
}

/**
 * Move a set of meetings onto the calling account, so the sync reads them
 * under a connection that works (Fizzy #2354).
 *
 * The workflow re-reads `userId` every cycle, so this write alone is the
 * takeover — no workflow restart is involved.
 */
export async function rebindLinkedMeetingsToUser(params: {
	projectId: string;
	linkedMeetingIds: string[];
	userId: string;
}) {
	return await db.projectLinkedMeeting.updateMany({
		where: {
			projectId: params.projectId,
			id: { in: params.linkedMeetingIds },
		},
		data: { userId: params.userId },
	});
}

// ---------------------------------------------------------------------------
// Transcript sync tracking
// ---------------------------------------------------------------------------

/**
 * Create a meeting transcript record after syncing
 */
export async function createMeetingTranscriptRecord(params: {
	projectId: string;
	linkedMeetingId: string;
	meetingId: string;
	transcriptId: string;
	meetingSubject?: string;
	meetingDate?: Date;
	contextId?: string;
	summary?: string;
	keywords?: string[];
	speakerNames?: string[];
	contentLength?: number;
	wasSummarized?: boolean;
	userId?: string;
	organizationId?: string;
}) {
	return await db.projectMeetingTranscript.create({
		data: {
			projectId: params.projectId,
			linkedMeetingId: params.linkedMeetingId,
			meetingId: params.meetingId,
			transcriptId: params.transcriptId,
			meetingSubject: params.meetingSubject,
			meetingDate: params.meetingDate,
			contextId: params.contextId,
			summary: params.summary,
			keywords: params.keywords ?? [],
			speakerNames: params.speakerNames ?? [],
			contentLength: params.contentLength,
			wasSummarized: params.wasSummarized ?? false,
			userId: params.userId,
			organizationId: params.organizationId,
		},
	});
}

/**
 * Check if a transcript has already been synced (deduplication)
 */
export async function isTranscriptAlreadySynced(
	projectId: string,
	meetingId: string,
	transcriptId: string,
): Promise<boolean> {
	const record = await db.projectMeetingTranscript.findUnique({
		where: {
			projectId_meetingId_transcriptId: {
				projectId,
				meetingId,
				transcriptId,
			},
		},
		select: { id: true },
	});

	return !!record;
}

export interface TranscriptNearOccurrenceInput {
	projectId: string;
	linkedMeetingId: string;
	occurrence: Date;
	toleranceMs: number;
}

/**
 * Is this occurrence already covered by a transcript, whatever produced it?
 *
 * `isTranscriptAlreadySynced` keys on the transcript id, which is source-specific: a transcript
 * recovered from a meeting recording is keyed on the recording's driveItem, and a transcript from
 * Graph on Graph's own id. The two never collide, so an occurrence already ingested from Graph does
 * not stop the recording fallback re-ingesting it — and since Graph now returns nothing for channel
 * meetings *retroactively*, that means re-fetching the entire lookback window rather than the gap.
 *
 * Matching on time instead of id closes that, because an occurrence is the thing we actually want
 * once. The window has to be generous: the stored `meetingDate` comes from the transcript's or
 * recording's own timestamp, which trails the calendar occurrence this is compared against, and
 * these values are currently written ~3h behind real UTC. Six hours absorbs both while staying well
 * inside the 24h that separates two occurrences of a daily meeting, so it cannot match a neighbour.
 *
 * Scoped by `linkedMeetingId` rather than `meetingId` because `meetingId` is not stable across
 * sources either: when Graph refuses to resolve a channel meeting, the transcript is filed under
 * the channel's thread id instead of Graph's online-meeting id. Keying coverage on the link — one
 * row per meeting per project, whatever Graph is willing to say about it — is what an occurrence
 * actually belongs to.
 */
export async function hasTranscriptNearOccurrence(
	input: TranscriptNearOccurrenceInput,
): Promise<boolean> {
	const { projectId, linkedMeetingId, occurrence, toleranceMs } = input;

	const record = await db.projectMeetingTranscript.findFirst({
		where: {
			projectId,
			linkedMeetingId,
			meetingDate: {
				gte: new Date(occurrence.getTime() - toleranceMs),
				lte: new Date(occurrence.getTime() + toleranceMs),
			},
		},
		select: { id: true },
	});

	return !!record;
}

/**
 * List synced transcripts for a project, optionally filtered by linked meeting
 */
export async function listSyncedTranscripts(
	projectId: string,
	linkedMeetingId?: string,
) {
	return await db.projectMeetingTranscript.findMany({
		where: {
			projectId,
			...(linkedMeetingId ? { linkedMeetingId } : {}),
		},
		orderBy: { syncedAt: "desc" },
	});
}

/**
 * Update the last sync run timestamp on the project
 */
export async function updateMeetingTranscriptSyncLastRun(projectId: string) {
	return await db.project.update({
		where: { id: projectId },
		data: {
			meetingTranscriptSyncLastRun: new Date(),
		},
	});
}

// ---------------------------------------------------------------------------
// Auto-analysis lifecycle (scan-status): claim → scanned | (release) | failed
// ---------------------------------------------------------------------------
//
// `analysisStatus` drives the auditable per-transcript scan-status view and is
// the dedup lock: the NOT_SCANNED → IN_PROGRESS compare-and-set claims a
// transcript for analysis exactly once. `analyzedAt` is the completion
// timestamp (set on SCANNED, including zero-change runs); `analysisError` /
// `analysisFailedAt` capture a terminal failure.

/**
 * Atomically claim a transcript for the auto-analysis pass.
 *
 * Compare-and-set NOT_SCANNED → IN_PROGRESS in a single conditional UPDATE.
 * `claimed: true` means this caller won the claim and should analyze. When the
 * row already left NOT_SCANNED (`claimed: false`) we read it back so the caller
 * can disambiguate: SCANNED (done — skip), IN_PROGRESS (a crashed prior attempt
 * of the same execution — see the activity's reconciliation), or gone.
 */
export async function claimMeetingTranscriptForAnalysis(
	transcriptRecordId: string,
) {
	const claim = await db.projectMeetingTranscript.updateMany({
		where: { id: transcriptRecordId, analysisStatus: "NOT_SCANNED" },
		data: { analysisStatus: "IN_PROGRESS", analysisStartedAt: new Date() },
	});
	if (claim.count === 1) {
		return { claimed: true as const };
	}
	const row = await db.projectMeetingTranscript.findUnique({
		where: { id: transcriptRecordId },
		select: { analysisStatus: true, analyzedAt: true },
	});
	return {
		claimed: false as const,
		status: row?.analysisStatus ?? null,
		analyzedAt: row?.analyzedAt ?? null,
	};
}

/**
 * Mark a transcript SCANNED (analysis finished). Sets `analyzedAt` and, when a
 * proposal was created (≥1 change), the `analyzedProposalId` deep-link. On a
 * zero-change run `proposalId` is omitted and the column stays NULL.
 *
 * Uses `updateMany` (not `update`) so a concurrently-deleted transcript row does
 * not throw.
 */
export async function markMeetingTranscriptScanned(
	transcriptRecordId: string,
	proposalId?: string,
) {
	return await db.projectMeetingTranscript.updateMany({
		where: { id: transcriptRecordId },
		data: {
			analysisStatus: "SCANNED",
			analyzedAt: new Date(),
			...(proposalId !== undefined
				? { analyzedProposalId: proposalId }
				: {}),
		},
	});
}

/**
 * Back-compat alias used by the auto-analyze activity: mark SCANNED and attach
 * the created proposal (if any). Kept so existing call sites read naturally.
 */
export async function attachProposalToMeetingTranscript(
	transcriptRecordId: string,
	proposalId?: string,
) {
	return await markMeetingTranscriptScanned(transcriptRecordId, proposalId);
}

/**
 * Release a claim back to NOT_SCANNED so a RETRYABLE failure (e.g. a transient
 * LLM error) is re-attempted by Temporal. Only called when NO proposal was
 * created yet — once a proposal exists the claim is held so a retry skips.
 */
export async function releaseMeetingTranscriptAnalysisClaim(
	transcriptRecordId: string,
) {
	return await db.projectMeetingTranscript.updateMany({
		where: { id: transcriptRecordId },
		data: {
			analysisStatus: "NOT_SCANNED",
			analysisStartedAt: null,
			analyzedAt: null,
		},
	});
}

/**
 * Mark a transcript's analysis as terminally FAILED (retries exhausted),
 * surfaced as "Failed" in the scan-status view. Called by the workflow after
 * the analyze activity gives up, so the failure is observable instead of
 * silently looking unscanned.
 */
export async function markMeetingTranscriptAnalysisFailed(
	transcriptRecordId: string,
	errorMessage: string,
) {
	return await db.projectMeetingTranscript.updateMany({
		where: { id: transcriptRecordId },
		data: {
			analysisStatus: "FAILED",
			analysisError: errorMessage.slice(0, 2000),
			analysisFailedAt: new Date(),
		},
	});
}

/** Filters for {@link listMeetingTranscriptsByDate}. */
export interface MeetingTranscriptDateQuery {
	projectId: string;
	/** Inclusive lower bound on the meeting's own occurrence date. */
	from?: Date;
	/** Inclusive upper bound on the meeting's own occurrence date. */
	to?: Date;
	/** Case-insensitive substring match on the meeting series subject. */
	subjectContains?: string;
	/** Rows to return (1-200, default 50). */
	limit?: number;
}

export interface MeetingTranscriptDateResult {
	items: {
		id: string;
		meetingSubject: string | null;
		meetingDate: Date | null;
		speakerNames: string[];
		summary: string | null;
		contentLength: number | null;
		contextId: string | null;
		wasSummarized: boolean;
	}[];
	/** Total matching the filters, so a caller can tell it was truncated. */
	total: number;
}

/**
 * List a project's synced meeting transcripts by the meeting's OWN date.
 *
 * Deliberately distinct from {@link listSyncedTranscripts}, which orders by
 * `syncedAt` — the ingest timestamp. Those are not the same thing, and the
 * difference is what made Fizzy #2473 possible: a bulk backfill can stamp
 * hundreds of meetings spanning months with the same `syncedAt` minute, so
 * ingest order says nothing about when anything actually happened.
 *
 * `meetingDate` is the occurrence date carried from the calendar event, and it
 * is indexed (`@@index([meetingDate])`). This is the query that lets "what did
 * we discuss on the 10th" be answered by a lookup instead of by semantic
 * similarity over hundreds of near-identical standups.
 *
 * Tenancy: filtered by `projectId` only, matching the other project-scoped read
 * helpers — callers verify access with `hasProjectAccess` first. Rows predating
 * the tenant columns carry NULL there, so filtering on them here would silently
 * hide real transcripts.
 */
export async function listMeetingTranscriptsByDate(
	params: MeetingTranscriptDateQuery,
): Promise<MeetingTranscriptDateResult> {
	const { projectId, from, to, subjectContains } = params;
	const take = Math.min(Math.max(1, params.limit ?? 50), 200);

	const where = {
		projectId,
		...(from || to
			? {
					meetingDate: {
						...(from ? { gte: from } : {}),
						...(to ? { lte: to } : {}),
					},
				}
			: {}),
		...(subjectContains
			? {
					meetingSubject: {
						contains: subjectContains,
						mode: "insensitive" as const,
					},
				}
			: {}),
	};

	const [items, total] = await Promise.all([
		db.projectMeetingTranscript.findMany({
			where,
			// NULLs last: a row with no occurrence date is the least useful
			// answer to a date question, never the headline.
			orderBy: [{ meetingDate: { sort: "desc", nulls: "last" } }],
			take,
			select: {
				id: true,
				meetingSubject: true,
				meetingDate: true,
				speakerNames: true,
				summary: true,
				contentLength: true,
				contextId: true,
				wasSummarized: true,
			},
		}),
		db.projectMeetingTranscript.count({ where }),
	]);

	return { items, total };
}
