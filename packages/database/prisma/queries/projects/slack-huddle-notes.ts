/**
 * Database queries for ProjectSlackHuddleNote (Slack huddle AI-notes ingestion).
 *
 * Mirrors meeting-transcripts.ts. These queries are called from Temporal
 * activities which own tenant context separately, so a project's single-tenant
 * `projectId` is the isolation anchor for reads; tenant columns (userId /
 * organizationId) are written into create-data and copied from the parent
 * Project, exactly like createMeetingTranscriptRecord. The dedup unique key is
 * (projectId, canvasId) — tenant columns are NOT part of the unique selector.
 */

import { db } from "../../client";

// ---------------------------------------------------------------------------
// Linked channels (huddle ingestion rides the same linked Slack channels)
// ---------------------------------------------------------------------------

export interface LinkedSlackHuddleChannel {
	id: string;
	channelId: string;
	slackTeamId: string;
	channelName: string | null;
}

/**
 * Linked Slack channels for a project, scoped to the fields the huddle-ingest
 * workflow needs. A project is single-tenant, so projectId is the isolation
 * anchor (matches getLinkedMeetingJoinUrls).
 */
export async function getLinkedSlackHuddleChannels(
	projectId: string,
): Promise<LinkedSlackHuddleChannel[]> {
	return await db.projectLinkedSlackChannel.findMany({
		where: { projectId },
		select: {
			id: true,
			channelId: true,
			slackTeamId: true,
			channelName: true,
		},
	});
}

// ---------------------------------------------------------------------------
// Huddle note tracking (create-or-update keyed on canvas id)
// ---------------------------------------------------------------------------

export interface UpsertSlackHuddleNoteParams {
	projectId: string;
	linkedChannelId: string;
	canvasId: string;
	channelId: string;
	slackTeamId: string;
	contentHash: string;
	huddleTranscriptFileId?: string;
	huddleSummaryId?: string;
	huddleDateStart?: Date;
	huddleDateEnd?: Date;
	title?: string;
	contextId?: string;
	contentLength?: number;
	wasSummarized?: boolean;
	speakerNames?: string[];
	userId?: string;
	organizationId?: string;
}

export interface UpsertSlackHuddleNoteResult {
	record: Awaited<ReturnType<typeof db.projectSlackHuddleNote.upsert>>;
	/**
	 * True when this is a brand-new row, or an existing row whose contentHash
	 * changed (empty→populated or a later human edit). False when the prior row
	 * already had the same contentHash (a no-op re-poll).
	 */
	didChange: boolean;
	/** The prior row (null when this is the first time we see this canvas). */
	prior: Awaited<
		ReturnType<typeof db.projectSlackHuddleNote.findUnique>
	> | null;
}

/**
 * Create-or-update a huddle note tracking row keyed on (projectId, canvasId).
 *
 * Returns `didChange` so the caller can decide whether to (re)embed:
 *  - no prior row              → create, didChange = true
 *  - prior.contentHash differs → update, didChange = true (update-in-place)
 *  - prior.contentHash same    → update timestamps only, didChange = false
 */
export async function upsertSlackHuddleNoteRecord(
	params: UpsertSlackHuddleNoteParams,
): Promise<UpsertSlackHuddleNoteResult> {
	const prior = await db.projectSlackHuddleNote.findUnique({
		where: {
			projectId_canvasId: {
				projectId: params.projectId,
				canvasId: params.canvasId,
			},
		},
	});

	const didChange = !prior || prior.contentHash !== params.contentHash;

	const record = await db.projectSlackHuddleNote.upsert({
		where: {
			projectId_canvasId: {
				projectId: params.projectId,
				canvasId: params.canvasId,
			},
		},
		create: {
			projectId: params.projectId,
			linkedChannelId: params.linkedChannelId,
			canvasId: params.canvasId,
			channelId: params.channelId,
			slackTeamId: params.slackTeamId,
			contentHash: params.contentHash,
			huddleTranscriptFileId: params.huddleTranscriptFileId,
			huddleSummaryId: params.huddleSummaryId,
			huddleDateStart: params.huddleDateStart,
			huddleDateEnd: params.huddleDateEnd,
			title: params.title,
			contextId: params.contextId,
			contentLength: params.contentLength,
			wasSummarized: params.wasSummarized ?? false,
			speakerNames: params.speakerNames ?? [],
			userId: params.userId,
			organizationId: params.organizationId,
		},
		update: {
			contentHash: params.contentHash,
			huddleTranscriptFileId: params.huddleTranscriptFileId,
			huddleSummaryId: params.huddleSummaryId,
			huddleDateStart: params.huddleDateStart,
			huddleDateEnd: params.huddleDateEnd,
			title: params.title,
			contextId: params.contextId,
			contentLength: params.contentLength,
			wasSummarized: params.wasSummarized ?? false,
			speakerNames: params.speakerNames ?? [],
		},
	});

	return { record, didChange, prior };
}

/**
 * Update the last huddle-ingest run timestamp on the project.
 */
export async function updateSlackHuddleIngestLastRun(projectId: string) {
	return await db.project.update({
		where: { id: projectId },
		data: {
			slackHuddleIngestLastRun: new Date(),
		},
	});
}
