/**
 * Daily Brief — Meeting Transcripts Collector Activity
 *
 * Reads ProjectMeetingTranscript rows whose primary timestamp falls inside
 * the given time window. Returns lightweight `MeetingItem[]` — the full
 * transcript body is deliberately NOT included, only the summary, keywords,
 * speakers, and length.
 *
 * DB-local: no LLM, no external HTTP.
 */

import {
	db,
	type MeetingActionItem,
	type MeetingDecision,
	type MeetingItem,
	type MeetingOpenQuestion,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { MEETING_INSIGHTS_VERSION } from "./extract-meeting-insights";

// =============================================================================
// Types
// =============================================================================

export interface CollectMeetingTranscriptsInput {
	projectId: string;
	organizationId: string | null;
	timeWindowStart: Date | string;
	timeWindowEnd: Date | string;
}

export type CollectMeetingTranscriptsOutput = MeetingItem[];

// Keep each summary reasonable for the brief. Full transcripts should never
// appear in the Daily Brief payload — they live in ProjectContext / RAG.
/** Row cap — bounds what crosses the Temporal activity boundary (#1997).
 *  Ordered newest-first, so the cap keeps the most recent meetings. */
const MAX_TRANSCRIPT_ROWS = 100;
const MAX_SUMMARY_CHARS = 1_200;
const MAX_KEYWORDS = 20;
const MAX_SPEAKERS = 20;

// =============================================================================
// Activity
// =============================================================================

/**
 * Collect meeting transcripts for the Daily Brief.
 *
 * Window filter uses COALESCE(meetingDate, syncedAt) semantics: meetingDate
 * is nullable in the schema, so we OR across both columns and then pick the
 * most meaningful timestamp for `occurredAt` on each returned item.
 */
export async function collectMeetingTranscripts(
	input: CollectMeetingTranscriptsInput,
): Promise<CollectMeetingTranscriptsOutput> {
	const { projectId, organizationId } = input;
	const timeWindowStart = new Date(input.timeWindowStart);
	const timeWindowEnd = new Date(input.timeWindowEnd);

	heartbeat("collectMeetingTranscripts: starting");

	logger.info("[DailyBrief/collectMeetingTranscripts] Starting", {
		projectId,
		organizationId,
		timeWindowStart: timeWindowStart.toISOString(),
		timeWindowEnd: timeWindowEnd.toISOString(),
	});

	const transcripts = await db.projectMeetingTranscript.findMany({
		where: {
			projectId,
			project: { organizationId },
			OR: [
				{ meetingDate: { gte: timeWindowStart, lte: timeWindowEnd } },
				{ syncedAt: { gte: timeWindowStart, lte: timeWindowEnd } },
			],
		},
		select: {
			id: true,
			meetingSubject: true,
			meetingDate: true,
			syncedAt: true,
			summary: true,
			keywords: true,
			speakerNames: true,
			contentLength: true,
			extractedDecisions: true,
			extractedActionItems: true,
			extractedQuestions: true,
			insightsExtractedAt: true,
			insightsVersion: true,
		},
		orderBy: [{ meetingDate: "desc" }, { syncedAt: "desc" }],
		take: MAX_TRANSCRIPT_ROWS,
	});

	const items: MeetingItem[] = transcripts.map((t) => {
		// Prefer the real meeting timestamp; fall back to sync time if the
		// meeting date was never populated (older rows / Graph quirks).
		const occurredAt = t.meetingDate ?? t.syncedAt;
		const meetingDate = t.meetingDate ?? t.syncedAt;

		const summary = t.summary
			? t.summary.length > MAX_SUMMARY_CHARS
				? `${t.summary.slice(0, MAX_SUMMARY_CHARS)}…`
				: t.summary
			: undefined;

		const hasValidInsights =
			t.insightsVersion === MEETING_INSIGHTS_VERSION &&
			t.insightsExtractedAt != null &&
			Array.isArray(t.extractedDecisions) &&
			Array.isArray(t.extractedActionItems) &&
			Array.isArray(t.extractedQuestions);

		return {
			occurredAt,
			title: t.meetingSubject ?? "Meeting",
			transcriptCuid: t.id,
			meetingDate,
			summary,
			keywords:
				t.keywords && t.keywords.length > 0
					? t.keywords.slice(0, MAX_KEYWORDS)
					: undefined,
			speakerNames:
				t.speakerNames && t.speakerNames.length > 0
					? t.speakerNames.slice(0, MAX_SPEAKERS)
					: undefined,
			contentLength: t.contentLength ?? undefined,
			...(hasValidInsights
				? {
						decisions:
							t.extractedDecisions as unknown as MeetingDecision[],
						actionItems:
							t.extractedActionItems as unknown as MeetingActionItem[],
						openQuestions:
							t.extractedQuestions as unknown as MeetingOpenQuestion[],
					}
				: {}),
		};
	});

	logger.info("[DailyBrief/collectMeetingTranscripts] Complete", {
		projectId,
		meetingCount: items.length,
	});

	return items;
}
