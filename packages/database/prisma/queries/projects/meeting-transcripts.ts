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
 */
export async function getLinkedMeetingJoinUrls(projectId: string) {
	return await db.projectLinkedMeeting.findMany({
		where: { projectId },
		select: {
			id: true,
			joinUrl: true,
			subject: true,
		},
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
