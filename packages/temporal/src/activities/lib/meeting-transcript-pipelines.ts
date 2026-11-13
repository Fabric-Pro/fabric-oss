/**
 * What happens to a transcript once it is stored, whichever way it arrived: the
 * Teams sync and a file upload (Fizzy #1877) share this so that "the same as a
 * Teams transcript" stays true by construction rather than by two copies.
 */

import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "../../client";

/**
 * The auto-analyze workflow carries the transcript in its input, and Temporal
 * refuses a payload over 2 MB. A Teams meeting does not get near that, but an
 * uploaded file can, and a refused start would quietly skip the analysis. In
 * characters, with room for text that takes several bytes each.
 */
const MAX_ANALYZED_TRANSCRIPT_CHARS = 500_000;

/** The heading stored above a transcript body. */
export function formatTranscriptHeader(params: {
	meetingSubject: string;
	formattedDate: string;
	speakerNames: string[];
}): string {
	return [
		`## Meeting Transcript: ${params.meetingSubject}`,
		`**Date:** ${params.formattedDate}`,
		params.speakerNames.length > 0
			? `**Participants:** ${params.speakerNames.join(", ")}`
			: "",
		"---",
		"",
	]
		.filter(Boolean)
		.join("\n");
}

export interface StartTranscriptPipelinesInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	transcriptRecordId: string;
	contextId: string;
	linkedMeetingId: string;
	meetingId: string;
	transcriptId: string;
	meetingSubject: string;
	/** Absent when the meeting's date is not known (#3507). */
	meetingDate?: string;
	transcriptText: string;
	provider: string;
	/**
	 * A fixed id, for a caller that can run twice for the same transcript. The
	 * Teams sync does not: its dedupe stops it before it gets here.
	 */
	embeddingWorkflowId?: string;
}

/**
 * Embedding, auto-analysis and insights for one stored transcript. Each start
 * is non-fatal on its own: the transcript is already stored, and a start that
 * failed must not abort the others or fail the ingest.
 */
export async function startTranscriptPipelines(
	input: StartTranscriptPipelinesInput,
): Promise<void> {
	const {
		projectId,
		userId,
		organizationId,
		transcriptRecordId,
		contextId,
		linkedMeetingId,
		meetingId,
		transcriptId,
		meetingSubject,
		meetingDate,
		transcriptText,
		provider,
		embeddingWorkflowId,
	} = input;

	// Embed into Qdrant.
	try {
		const client = await getTemporalClient();
		await client.workflow.start("contextEmbeddingWorkflow", {
			taskQueue: "project-documents",
			workflowId:
				embeddingWorkflowId ??
				`context-embedding-${contextId}-${Date.now()}`,
			args: [
				{
					// Deliberately no `content`: a transcript is stored
					// whole now, and an inline body would put the
					// workflow input at the mercy of the meeting's
					// length. The activity reads it back by contextId.
					contextId,
					projectId,
					userId,
					organizationId,
					type: "MEETING_TRANSCRIPT",
					metadata: {
						sourceTitle: `Meeting Transcript: ${meetingSubject}`,
						provider,
						meetingId,
						transcriptId,
					},
				},
			],
		});
	} catch (embeddingError) {
		logger.error(
			"[MeetingTranscriptSync] Failed to start embedding workflow",
			{
				error:
					embeddingError instanceof Error
						? embeddingError.message
						: String(embeddingError),
				contextId,
			},
		);
		// Non-fatal: the context is stored, just not embedded yet
	}

	// Auto-analyze this fresh transcript for feature proposals when BOTH the
	// sync flag and the opt-in auto-analyze flag are ON. Fire-and-forget a
	// dedicated workflow (mirrors the embedding start above) so the ~300s LLM
	// analysis + retries are decoupled from the ingest activity's 10-min timeout
	// and `meetingTranscriptSyncWorkflow` stays untouched. A failed start is
	// NON-FATAL — it must not fail transcript ingest/embedding or abort the loop
	// / per-meeting fetch.
	try {
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				meetingTranscriptSyncEnabled: true,
				meetingTranscriptAutoAnalyzeEnabled: true,
			},
		});

		if (
			project?.meetingTranscriptSyncEnabled &&
			project?.meetingTranscriptAutoAnalyzeEnabled
		) {
			const client = await getTemporalClient();
			await client.workflow.start(
				"autoAnalyzeMeetingTranscriptWorkflow",
				{
					taskQueue: "ai-chat",
					// Deterministic, transcript-keyed id (no timestamp
					// suffix) paired with reject-duplicates so two starts
					// for the same transcript cannot both run.
					workflowId: `auto-analyze-meeting-transcript:${transcriptRecordId}`,
					workflowIdReusePolicy: "REJECT_DUPLICATE",
					workflowIdConflictPolicy: "FAIL",
					args: [
						{
							projectId,
							userId,
							organizationId,
							transcriptRecordId,
							contextId,
							meetingId,
							transcriptId,
							linkedMeetingId,
							meetingSubject,
							meetingDate,
							transcriptText: transcriptText.slice(
								0,
								MAX_ANALYZED_TRANSCRIPT_CHARS,
							),
						},
					],
				},
			);
		}
	} catch (autoAnalyzeError) {
		logger.error(
			"[MeetingTranscriptSync] Failed to start auto-analyze workflow",
			{
				error:
					autoAnalyzeError instanceof Error
						? autoAnalyzeError.message
						: String(autoAnalyzeError),
				transcriptRecordId,
			},
		);
		// Non-fatal: the transcript is stored + embedding kicked off;
		// auto-analysis simply did not start for this transcript.
	}

	// (#1814): fire-and-forget insights extraction so summaries/decisions/
	// actions/questions are ready before anyone opens the digest. Same
	// workflowId scheme as the sheet-open trigger (extract-insights procedure) —
	// ALLOW_DUPLICATE + FAIL collapses the race between ingest and a concurrent
	// open. Insights are core digest content, not proposal-gated. Non-fatal like
	// the starts above.
	try {
		const client = await getTemporalClient();
		await client.workflow.start("extractMeetingInsightsOnDemandWorkflow", {
			taskQueue: "project-documents",
			workflowId: `meeting-digest-insights:${transcriptRecordId}`,
			workflowIdReusePolicy: "ALLOW_DUPLICATE",
			workflowIdConflictPolicy: "FAIL",
			args: [
				{
					projectId,
					organizationId,
					userId,
					transcriptCuid: transcriptRecordId,
				},
			],
		});
	} catch (insightsError) {
		logger.error(
			"[MeetingTranscriptSync] Failed to start insights extraction workflow",
			{
				error:
					insightsError instanceof Error
						? insightsError.message
						: String(insightsError),
				transcriptRecordId,
			},
		);
		// Non-fatal: the sheet-open path self-populates as before.
	}
}
