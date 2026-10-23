import type { AiJobKey } from "@repo/ai";
import { logger } from "@repo/logs";
import { Context } from "@temporalio/activity";
import { CHARS_PER_TOKEN } from "./analysis-budget";
import {
	MIN_TRANSCRIPT_SUMMARY_TARGET_CHARS,
	meetingSummaryHeading,
	summarizeTranscript,
	transcriptSummaryTargetChars,
} from "./summarize-transcript";
import { withTranscriptSummaryTimeout } from "./summary-call-timeout";
import {
	readTranscriptSummary,
	writeTranscriptSummary,
} from "./transcript-summary-cache";

export const MEETING_TRANSCRIPT_SEPARATOR = "\n\n---\n\n";
const TRANSCRIPT_SUMMARY_CONCURRENCY = 6;
// Starting timeout value, not a measured provider latency; tune from the summary event.
const SUMMARY_CALL_TIMEOUT_MS = 60_000;
// One 60s call plus two 2s cache waits and 1s scheduling overhead.
const SUMMARY_ROUND_RESERVE_MS = 65_000;
// Reserve for main generation, action-item routing, structure-preserving merges,
// decision precheck, bookkeeping/return, and the outer activity's own remaining
// work when analysis is called inline. Budget two minutes for generation and one
// for the remaining work; shorter enclosing deadlines may skip summaries.
const ANALYSIS_AND_MERGE_RESERVE_MS = 180_000;

type SummaryContext = {
	userId: string;
	organizationId?: string;
	projectId: string;
	jobType?: AiJobKey;
};

async function summarizeWithTimeout(
	transcript: string,
	targetChars: number,
	context: SummaryContext,
	cancellationSignal?: AbortSignal,
) {
	return withTranscriptSummaryTimeout(
		(abortSignal) =>
			summarizeTranscript(
				transcript,
				"Meeting",
				context.userId,
				context.organizationId,
				context.projectId,
				{
					targetChars,
					jobType: context.jobType,
					abortSignal,
				},
			),
		SUMMARY_CALL_TIMEOUT_MS,
		cancellationSignal,
	);
}

/** Recompute from actual outputs between rounds, retaining the original input order. */
export async function summarizeMeetingsToFit(
	transcripts: string[],
	grantedTokens: number,
	context: SummaryContext,
) {
	let deadlineMs: number | undefined;
	let cancellationSignal: AbortSignal | undefined;
	try {
		const activity = Context.current();
		const deadline =
			activity.info.currentAttemptScheduledTimestampMs +
			activity.info.startToCloseTimeoutMs;
		if (Number.isFinite(deadline)) {
			deadlineMs = deadline;
		}
		cancellationSignal = activity.cancellationSignal;
	} catch {
		/* Unit tests and non-activity callers have no activity deadline. */
	}
	const result = [...transcripts];
	const candidates = transcripts
		.map((text, index) => ({ index, length: text.length }))
		.sort((a, b) => b.length - a.length);
	let next = 0;
	let selectedCount = 0;
	let summarizedCount = 0;
	let partialCount = 0;
	let cacheHitCount = 0;
	let timedOutCount = 0;
	// Attempt latency includes model resolution and generation, excluding Redis and cache hits.
	const summaryCallLatenciesMs: number[] = [];
	let deadlineStopped = false;
	const joinedChars = () =>
		result.reduce((sum, text) => sum + text.length, 0) +
		Math.max(0, result.length - 1) * MEETING_TRANSCRIPT_SEPARATOR.length;
	const headingChars = meetingSummaryHeading("Meeting").length;
	while (
		Math.ceil(joinedChars() / CHARS_PER_TOKEN) > grantedTokens &&
		next < candidates.length
	) {
		const remainingMs =
			deadlineMs === undefined ? undefined : deadlineMs - Date.now();
		if (
			cancellationSignal?.aborted ||
			(remainingMs !== undefined &&
				remainingMs <=
					SUMMARY_ROUND_RESERVE_MS + ANALYSIS_AND_MERGE_RESERVE_MS)
		) {
			deadlineStopped = true;
			logger.info("[Backlog Analysis] meeting summary deadline reached", {
				event: "backlog.meeting_transcript_summary_deadline",
				projectId: context.projectId,
				remainingMs,
				roundReserveMs: SUMMARY_ROUND_RESERVE_MS,
				analysisReserveMs: ANALYSIS_AND_MERGE_RESERVE_MS,
				selectedCount,
			});
			break;
		}
		let estimatedChars = joinedChars();
		const round: { index: number; targetChars: number }[] = [];
		// Select enough candidates to fit at the extraction floor, then share the room.
		// Actual lengths decide whether another round runs.
		while (
			round.length < TRANSCRIPT_SUMMARY_CONCURRENCY &&
			next < candidates.length &&
			Math.ceil(estimatedChars / CHARS_PER_TOKEN) > grantedTokens
		) {
			const { index, length } = candidates[next++];
			if (
				length <= headingChars + MIN_TRANSCRIPT_SUMMARY_TARGET_CHARS ||
				transcriptSummaryTargetChars(
					Number.POSITIVE_INFINITY,
					length,
				) === 0
			) {
				continue;
			}
			round.push({ index, targetChars: 0 });
			const unchangedChars =
				joinedChars() -
				round.reduce((sum, item) => sum + result[item.index].length, 0);
			const roomPerMeeting = Math.floor(
				(grantedTokens * CHARS_PER_TOKEN - unchangedChars) /
					round.length,
			);
			for (const item of round) {
				item.targetChars = transcriptSummaryTargetChars(
					roomPerMeeting - headingChars,
					transcripts[item.index].length,
				);
			}
			estimatedChars =
				unchangedChars +
				round.reduce(
					(sum, item) => sum + item.targetChars + headingChars,
					0,
				);
		}
		if (round.length === 0) {
			break;
		}
		selectedCount += round.length;
		await Promise.all(
			round.map(async ({ index, targetChars }) => {
				const original = transcripts[index];
				const cached = await readTranscriptSummary(
					original,
					targetChars,
					context.organizationId,
					context.projectId,
				);
				if (typeof cached === "string" && cached.trim()) {
					result[index] = cached;
					cacheHitCount++;
					summarizedCount++;
					return;
				}
				const { summary, timedOut, latencyMs } =
					await summarizeWithTimeout(
						original,
						targetChars,
						context,
						cancellationSignal,
					);
				summaryCallLatenciesMs.push(latencyMs);
				if (timedOut) {
					timedOutCount++;
				}
				if (summary !== null) {
					result[index] = summary.text;
					summarizedCount++;
					if (summary.partial) {
						partialCount++;
					} else {
						// A complete provider-shortened extract fits the requested bucket.
						await writeTranscriptSummary(
							original,
							targetChars,
							summary.text,
							context.organizationId,
							context.projectId,
						);
					}
				}
			}),
		);
	}
	return {
		transcripts: result,
		selectedCount,
		summarizedCount,
		partialCount,
		cacheHitCount,
		timedOutCount,
		summaryCallLatenciesMs,
		deadlineStopped,
	};
}
