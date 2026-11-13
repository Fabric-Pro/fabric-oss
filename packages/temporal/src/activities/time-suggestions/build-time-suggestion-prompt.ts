/**
 * The pure half of drafting time suggestions: the facts the model is shown
 * for each candidate, and how its answer is read back.
 *
 * The facts are a compact summary per candidate (project, work item, the
 * kinds of evidence with their counts and local times), never the content of
 * a meeting, a version or a test case. They are written into the untrusted
 * fence by the activity, because a project or work item name is text anyone
 * in the organization can write.
 */

import {
	describeEvidenceCount,
	fallbackTimeSuggestionDescription,
	localTimeOf,
	normalizeSuggestionDescription,
	summarizeTimeEvidence,
	type TimeEvidenceSummary,
} from "@repo/utils/time-suggestions";
import {
	TIME_ACTIVITIES,
	TIME_ACTIVITY_VALUES,
	type TimeActivity,
} from "@repo/utils/time-tracking";
import { z } from "zod";
import type { TimeSuggestionCandidate, TimeSuggestionDraft } from "./types";

/**
 * Lenient on purpose: a model that skips a block, numbers one wrongly or
 * names an unknown activity must not fail the whole run. Each block it gets
 * wrong takes the fallback instead.
 */
export const TimeSuggestionDraftSchema = z.object({
	suggestions: z.array(
		z.object({
			group: z.number(),
			description: z.string(),
			activity: z.string().optional(),
		}),
	),
});

export type TimeSuggestionModelOutput = z.infer<
	typeof TimeSuggestionDraftSchema
>;

export function candidateSummaries(
	candidate: TimeSuggestionCandidate,
): TimeEvidenceSummary[] {
	return summarizeTimeEvidence(
		candidate.evidence.map((item) => ({
			kind: item.kind,
			occurredAt: new Date(item.occurredAt),
			endAt: item.endAt ? new Date(item.endAt) : null,
		})),
	);
}

function describeSummary(
	summary: TimeEvidenceSummary,
	timeZone: string,
): string {
	const from = localTimeOf(summary.earliestAt, timeZone);
	const to = localTimeOf(summary.latestAt, timeZone);
	const times = from === to ? `at ${from}` : `between ${from} and ${to}`;
	return `${describeEvidenceCount(summary.kind, summary.count)} ${times}`;
}

/** The facts for every candidate, one numbered block each, from 1. */
export function timeSuggestionEvidenceText(
	candidates: readonly TimeSuggestionCandidate[],
	timeZone: string,
): string {
	return candidates
		.map((candidate, index) => {
			const workItem = [candidate.storyIdentifier, candidate.storyTitle]
				.filter((text): text is string => Boolean(text))
				.join(" ");
			const lines = [
				`Block ${index + 1}`,
				`Date: ${candidate.workDate}`,
				`Project: ${candidate.projectName}`,
				...(workItem ? [`Work item: ${workItem}`] : []),
				`Activity seen: ${candidate.activity}`,
				`Evidence: ${candidateSummaries(candidate)
					.map((summary) => describeSummary(summary, timeZone))
					.join("; ")}`,
			];
			return lines.join("\n");
		})
		.join("\n\n");
}

/** The activities the model may choose from, one per line, for the template. */
export function activityChoicesText(): string {
	return TIME_ACTIVITIES.map(
		(activity) => `  - ${activity.value} (${activity.label})`,
	).join("\n");
}

function isTimeActivity(value: string): value is TimeActivity {
	return TIME_ACTIVITY_VALUES.some((activity) => activity === value);
}

/** The description and activity a candidate gets when no model wrote one. */
export function fallbackTimeSuggestionDraft(
	candidate: TimeSuggestionCandidate,
): TimeSuggestionDraft {
	return {
		activity: candidate.activity,
		description: fallbackTimeSuggestionDescription({
			activity: candidate.activity,
			storyIdentifier: candidate.storyIdentifier,
			storyTitle: candidate.storyTitle,
			summaries: candidateSummaries(candidate),
		}),
	};
}

/**
 * One draft per candidate, in order: the model's where it gave a usable
 * description for that block number, the fallback everywhere else.
 */
export function readTimeSuggestionDrafts(
	candidates: readonly TimeSuggestionCandidate[],
	output: TimeSuggestionModelOutput | null,
): TimeSuggestionDraft[] {
	const byGroup = new Map(
		(output?.suggestions ?? []).map((item) => [item.group, item]),
	);
	return candidates.map((candidate, index) => {
		const fallback = fallbackTimeSuggestionDraft(candidate);
		const item = byGroup.get(index + 1);
		const description = item
			? normalizeSuggestionDescription(item.description)
			: null;
		if (!item || !description) {
			return fallback;
		}
		const activity = item.activity?.trim().toUpperCase() ?? "";
		return {
			description,
			activity: isTimeActivity(activity) ? activity : fallback.activity,
		};
	});
}
