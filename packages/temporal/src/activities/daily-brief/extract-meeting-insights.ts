/**
 * Daily Brief — Meeting Insights Extractor
 *
 * For each ProjectMeetingTranscript in the brief window that does NOT already
 * have `insightsExtractedAt` set (or whose `insightsVersion` is stale), run a
 * single LLM call to extract decisions, action items, and open questions, and
 * cache them on the transcript row. Subsequent brief regenerations reuse the
 * cached values.
 *
 * Transcript text source:
 * ProjectMeetingTranscript has a `contextId` FK to ProjectContext but no named
 * Prisma relation. We fetch the ProjectContext rows separately (by contextId)
 * and use ProjectContext.content as the primary transcript text source, falling
 * back to the transcript's `summary` field when no contextId is present or the
 * context has no content.
 */
import {
	generateObject,
	getAIModelWithMetadata,
	getCurrentDateContext,
} from "@repo/ai";
// Imported from the SUBPATH (not @repo/ai root) so it stays UNMOCKED in tests
// that mock the @repo/ai root module (uniform rule across the budget sites).
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	db,
	type MeetingActionItem,
	type MeetingDecision,
	type MeetingOpenQuestion,
	normalizeItemText,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { z } from "zod";
import { attachAnchor } from "./anchor-resolver";

// v2: the same extraction call also produces a clean meeting summary that is
// persisted to `ProjectMeetingTranscript.summary` (the Meeting Digest reads
// it). Version-1 rows are treated as stale so summaries backfill lazily.
// v3 (#1896): each item also carries a verbatim sourceQuote resolved to an
// anchorLine into the transcript body. Bumping the version treats existing
// v2 caches as stale so anchors backfill lazily on the next brief run.
export const MEETING_INSIGHTS_VERSION = 3;
const PROMPT_CHAR_CAP = 60_000;

export interface ExtractMeetingInsightsInput {
	projectId: string;
	organizationId: string | null;
	userId: string;
	transcriptCuids: string[];
	// When true, an LLM failure rethrows instead of being recorded as empty
	// insights. The on-demand single-transcript workflow sets this so
	// Temporal's activity retry policy actually engages; the Daily Brief batch
	// keeps the swallow-and-continue behavior.
	failOnError?: boolean;
	// When true, skips the cache-hit guard below and re-extracts even for a
	// fresh cache — the "Regenerate summary" button's escape hatch.
	force?: boolean;
}

export interface ExtractedInsights {
	transcriptCuid: string;
	decisions: MeetingDecision[];
	actionItems: MeetingActionItem[];
	openQuestions: MeetingOpenQuestion[];
}

export interface ExtractMeetingInsightsOutput {
	insights: ExtractedInsights[];
	extractedCount: number;
	cachedCount: number;
}

const LlmInsightSchema = z.object({
	// Deliberately not .min(1): an empty summary must not invalidate the whole
	// response (the blank-summary guard below simply skips the write).
	summary: z.string(),
	decisions: z.array(
		z.object({
			text: z.string().min(1),
			relatedStoryIdentifier: z.string().optional(),
			sourceQuote: z.string().optional(),
		}),
	),
	actionItems: z.array(
		z.object({
			text: z.string().min(1),
			tentativeOwnerName: z.string().optional(),
			dueHint: z.string().optional(),
			sourceQuote: z.string().optional(),
		}),
	),
	openQuestions: z.array(
		z.object({
			text: z.string().min(1),
			sourceQuote: z.string().optional(),
		}),
	),
});

export function buildExtractionPrompt(input: {
	meetingSubject: string | null;
	meetingDate: Date | null;
	speakerNames: string[];
	transcriptText: string;
}): string {
	const { meetingSubject, meetingDate, speakerNames, transcriptText } = input;
	const dateContext = getCurrentDateContext();
	const trimmed =
		transcriptText.length > PROMPT_CHAR_CAP
			? `${transcriptText.slice(0, PROMPT_CHAR_CAP)}\n[truncated at ${PROMPT_CHAR_CAP} chars]`
			: transcriptText;
	return `Extract structured insights from this meeting transcript. Return a summary and three arrays:

1. summary — a concise markdown summary of the meeting (3-8 bullet points covering what was discussed and concluded). No heading, no participant list, no date — just the substance.
2. decisions — explicit choices the group made. Cite only decisions that are stated. If the transcript is purely status, return [].
3. actionItems — commitments to do something after the meeting. Include tentative owner if named. Use free-text dueHint (e.g. "by Friday") only when stated; never invent one.
4. openQuestions — questions raised that were NOT resolved in the meeting.

Rules:
- Do not invent content. If unsure, omit.
- Each item is one short sentence.
- If you can identify a story/feature identifier (pattern F-### or S-###), include it as relatedStoryIdentifier on decisions.
- For every item, also return sourceQuote: a short (roughly 10-25 words) contiguous verbatim excerpt copied EXACTLY, character for character, from the transcript that best evidences the item. Omit sourceQuote when you cannot quote exactly.

${dateContext}

Meeting: ${meetingSubject ?? "(no subject)"}
Date: ${meetingDate ? meetingDate.toISOString() : "unknown"}
Speakers: ${speakerNames.join(", ") || "unknown"}

Transcript:
${trimmed}
`;
}

/**
 * #1814: shape extracted action items into ProjectMeetingActionItem create
 * data, carrying manual completion over from the previous rows by normalized
 * text match (re-extraction replaces rows; a checked-off item that survives
 * rewording loses its checkmark — acceptable, manual re-check).
 */
export function buildActionItemRows(params: {
	extracted: MeetingActionItem[];
	existing: Array<{
		text: string;
		completedAt: Date | null;
		completedById: string | null;
	}>;
}): Array<{
	orderIndex: number;
	text: string;
	tentativeOwnerName: string | null;
	dueHint: string | null;
	completedAt: Date | null;
	completedById: string | null;
	sourceQuote: string | null;
	anchorLine: number | null;
}> {
	const completionByText = new Map(
		params.existing
			.filter((e) => e.completedAt !== null)
			.map((e) => [
				normalizeItemText(e.text),
				{ completedAt: e.completedAt, completedById: e.completedById },
			]),
	);
	return params.extracted.map((item, orderIndex) => {
		const carried = completionByText.get(normalizeItemText(item.text));
		return {
			orderIndex,
			text: item.text,
			tentativeOwnerName: item.tentativeOwnerName ?? null,
			dueHint: item.dueHint ?? null,
			completedAt: carried?.completedAt ?? null,
			completedById: carried?.completedById ?? null,
			sourceQuote: item.sourceQuote ?? null,
			anchorLine: item.anchorLine ?? null,
		};
	});
}

export async function extractMeetingInsightsActivity(
	input: ExtractMeetingInsightsInput,
): Promise<ExtractMeetingInsightsOutput> {
	const {
		projectId,
		organizationId,
		userId,
		transcriptCuids,
		failOnError,
		force,
	} = input;

	heartbeat("extractMeetingInsights: fetching transcripts");

	const transcripts = await db.projectMeetingTranscript.findMany({
		where: {
			id: { in: transcriptCuids },
			projectId,
			project: { organizationId },
		},
		select: {
			id: true,
			meetingSubject: true,
			meetingDate: true,
			speakerNames: true,
			summary: true,
			contextId: true,
			insightsExtractedAt: true,
			insightsVersion: true,
			extractedDecisions: true,
			extractedActionItems: true,
			extractedQuestions: true,
			userId: true,
			organizationId: true,
			actionItems: {
				select: { text: true, completedAt: true, completedById: true },
			},
		},
	});

	// Fetch ProjectContext content for transcripts that have a contextId.
	// ProjectMeetingTranscript.contextId is a bare FK — there is no named
	// Prisma relation — so we do a separate findMany and build a lookup map.
	const contextIds = transcripts
		.map((t) => t.contextId)
		.filter((id): id is string => id !== null && id !== undefined);

	const contextContentMap = new Map<string, string>();
	if (contextIds.length > 0) {
		const contexts = await db.projectContext.findMany({
			where: { id: { in: contextIds } },
			select: { id: true, content: true },
		});
		for (const ctx of contexts) {
			if (ctx.content) {
				contextContentMap.set(ctx.id, ctx.content);
			}
		}
	}

	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId,
			organizationId: organizationId ?? undefined,
			projectId,
			jobType: "daily-brief",
		},
	);

	const insights: ExtractedInsights[] = [];
	let cachedCount = 0;
	let extractedCount = 0;

	for (const t of transcripts) {
		heartbeat(`extractMeetingInsights: transcript ${t.id}`);

		if (
			!force &&
			t.insightsExtractedAt &&
			t.insightsVersion === MEETING_INSIGHTS_VERSION &&
			Array.isArray(t.extractedDecisions) &&
			Array.isArray(t.extractedActionItems) &&
			Array.isArray(t.extractedQuestions)
		) {
			cachedCount += 1;
			insights.push({
				transcriptCuid: t.id,
				decisions: t.extractedDecisions as unknown as MeetingDecision[],
				actionItems:
					t.extractedActionItems as unknown as MeetingActionItem[],
				openQuestions:
					t.extractedQuestions as unknown as MeetingOpenQuestion[],
			});
			continue;
		}

		// Primary source: ProjectContext.content (full transcript body).
		// Fallback: summary field (truncated but better than nothing).
		const contextText = t.contextId
			? (contextContentMap.get(t.contextId) ?? null)
			: null;
		const transcriptText = contextText ?? t.summary ?? "";

		if (!transcriptText) {
			// Don't persist an empty-cache sentinel. If the transcript is
			// re-synced with a body later, we want the next regenerate to
			// attempt extraction — a persisted insightsVersion would short-
			// circuit the cache-hit guard above and lock in the empty result.
			insights.push({
				transcriptCuid: t.id,
				decisions: [],
				actionItems: [],
				openQuestions: [],
			});
			continue;
		}

		const prompt = buildExtractionPrompt({
			meetingSubject: t.meetingSubject,
			meetingDate: t.meetingDate,
			speakerNames: t.speakerNames,
			transcriptText,
		});

		// Output (decision/action/question lists + summary) tracks the transcript
		// length — scaled mode. Recomputed per transcript since the prompt varies.
		// Without an explicit budget Databricks/Anthropic-direct truncate a long
		// meeting's extraction at their injected defaults (8,192 / 4,096), which
		// surfaced as 16 AI_NoObjectGeneratedError in staging on 2026-07-23.
		const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
			inputChars: transcriptText.length,
			promptChars: prompt.length,
		});

		try {
			const result = await generateObject({
				model,
				schema: LlmInsightSchema,
				prompt,
				...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			});

			trackUsage();

			// Anchors are only valid against the transcript body the reader page
			// displays (ProjectContext.content). When extraction fell back to the
			// truncated `summary` field, skip anchor resolution entirely.
			const anchorContent =
				t.contextId && contextContentMap.get(t.contextId)
					? transcriptText
					: null;

			const decisions: MeetingDecision[] = result.object.decisions.map(
				(d) =>
					attachAnchor(
						{
							text: d.text,
							...(d.relatedStoryIdentifier
								? {
										relatedStoryIdentifier:
											d.relatedStoryIdentifier,
									}
								: {}),
						},
						d.sourceQuote,
						anchorContent,
					),
			);
			const actionItems: MeetingActionItem[] =
				result.object.actionItems.map((a) =>
					attachAnchor(
						{
							text: a.text,
							...(a.tentativeOwnerName
								? { tentativeOwnerName: a.tentativeOwnerName }
								: {}),
							...(a.dueHint ? { dueHint: a.dueHint } : {}),
						},
						a.sourceQuote,
						anchorContent,
					),
				);
			const openQuestions: MeetingOpenQuestion[] =
				result.object.openQuestions.map((q) =>
					attachAnchor(
						{ text: q.text },
						q.sourceQuote,
						anchorContent,
					),
				);

			// Observability (card NFR): count quotes the resolver rejected.
			// Only meaningful when anchoring actually ran — on a summary-fallback
			// run (anchorContent === null) anchoring is skipped by design, so
			// every sourceQuote would count as "unmatched" and produce a false
			// alarm. Skip the count in that case.
			if (anchorContent !== null) {
				const unmatched =
					[
						...result.object.decisions,
						...result.object.actionItems,
						...result.object.openQuestions,
					].filter((i) => i.sourceQuote).length -
					[...decisions, ...actionItems, ...openQuestions].filter(
						(i) => i.anchorLine !== undefined,
					).length;
				if (unmatched > 0) {
					logger.warn(
						"[DailyBrief/extractMeetingInsights] anchor quotes unmatched",
						{ transcriptCuid: t.id, unmatched },
					);
				}
			}

			// The extracted summary replaces the sync-time preview (which for
			// legacy rows is a truncated header blob) — but only when it was
			// derived from the actual transcript body. When the stored summary
			// itself was the text source, overwriting it would destroy the only
			// remaining record with a summary-of-a-summary. A blank LLM summary
			// never wipes an existing one either.
			const extractedSummary = result.object.summary.trim();
			const summaryFromTranscriptBody = Boolean(contextText);

			const actionItemRows = buildActionItemRows({
				extracted: actionItems,
				existing: t.actionItems,
			});
			await db.$transaction([
				db.projectMeetingTranscript.update({
					where: { id: t.id },
					data: {
						extractedDecisions: decisions as unknown as object,
						extractedActionItems: actionItems as unknown as object,
						extractedQuestions: openQuestions as unknown as object,
						insightsExtractedAt: new Date(),
						insightsVersion: MEETING_INSIGHTS_VERSION,
						// #1902: this run just rewrote the action items the link matcher
						// keys on, so its cache is stale by definition — clear it so the
						// next digest open re-matches. Without this a meeting first
						// extracted with zero items stays stamped "matched" and never
						// gains links. Links themselves are NOT deleted: an unchanged item
						// keeps its links, which is the point of keying on text.
						actionItemsLinkedAt: null,
						actionItemsLinkVersion: null,
						...(extractedSummary && summaryFromTranscriptBody
							? { summary: extractedSummary }
							: {}),
					},
				}),
				db.projectMeetingActionItem.deleteMany({
					where: { transcriptId: t.id },
				}),
				db.projectMeetingActionItem.createMany({
					data: actionItemRows.map((row) => ({
						...row,
						transcriptId: t.id,
						userId: t.userId,
						organizationId: t.organizationId,
					})),
				}),
			]);

			extractedCount += 1;
			insights.push({
				transcriptCuid: t.id,
				decisions,
				actionItems,
				openQuestions,
			});
		} catch (err) {
			logger.warn("[DailyBrief/extractMeetingInsights] LLM failed", {
				transcriptCuid: t.id,
				error: err instanceof Error ? err.message : String(err),
			});
			if (failOnError) {
				throw err;
			}
			insights.push({
				transcriptCuid: t.id,
				decisions: [],
				actionItems: [],
				openQuestions: [],
			});
		}
	}

	logger.info("[DailyBrief/extractMeetingInsights] Complete", {
		projectId,
		totalRequested: transcriptCuids.length,
		extractedCount,
		cachedCount,
	});

	return { insights, extractedCount, cachedCount };
}
