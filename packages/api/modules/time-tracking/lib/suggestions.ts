/**
 * What the suggestion procedures share: loading the caller's own suggestion,
 * and the wire shape of one.
 *
 * A suggestion is personal. Someone else's answers NOT_FOUND exactly as a
 * missing one does, whatever the caller's role; each procedure then checks
 * the suggestion's project like the entry procedures do.
 */

import { ORPCError } from "@orpc/server";
import {
	findTimeSuggestionForOwner,
	type TimeSuggestionRow,
} from "@repo/database";
import { summarizeTimeEvidence } from "@repo/utils/time-suggestions";
import type { EffectiveTimePolicy } from "@repo/utils/time-tracking";

const SUGGESTION_NOT_FOUND_MESSAGE = "Time suggestion not found";

/** The caller's own suggestion, or NOT_FOUND. */
export async function requireOwnSuggestion(params: {
	suggestionId: string;
	userId: string;
}): Promise<TimeSuggestionRow> {
	const suggestion = await findTimeSuggestionForOwner({
		id: params.suggestionId,
		userId: params.userId,
	});
	if (!suggestion) {
		throw new ORPCError("NOT_FOUND", {
			message: SUGGESTION_NOT_FOUND_MESSAGE,
		});
	}
	return suggestion;
}

/**
 * A suggestion as every suggestion procedure returns it, with the policy a
 * confirmed entry on its project would be saved under now, and its evidence
 * as counts and times per kind: never the content it came from.
 */
export function serializeTimeSuggestion(
	suggestion: TimeSuggestionRow,
	policy: EffectiveTimePolicy,
) {
	return {
		id: suggestion.id,
		projectId: suggestion.projectId,
		projectName: suggestion.projectName,
		workDate: suggestion.workDate,
		timezone: suggestion.timezone,
		activity: suggestion.activity,
		billable: suggestion.billable,
		durationMinutes: suggestion.durationMinutes,
		startAt: suggestion.startAt?.toISOString() ?? null,
		stopAt: suggestion.stopAt?.toISOString() ?? null,
		description: suggestion.description,
		explanation: suggestion.explanation,
		storyId: suggestion.storyId,
		storyIdentifier: suggestion.storyIdentifier,
		storyTitle: suggestion.storyTitle,
		status: suggestion.status,
		expiresAt: suggestion.expiresAt.toISOString(),
		createdAt: suggestion.createdAt.toISOString(),
		startStopRequired: policy.startStopRequired,
		defaultBillable: policy.defaultBillable,
		evidence: summarizeTimeEvidence(suggestion.evidence).map((summary) => ({
			kind: summary.kind,
			count: summary.count,
			earliestAt: summary.earliestAt.toISOString(),
			latestAt: summary.latestAt.toISOString(),
		})),
	};
}
