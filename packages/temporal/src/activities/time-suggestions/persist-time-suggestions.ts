/**
 * Store a generation's suggestions and finish its run, in one transaction
 * (`persistTimeSuggestions`). The explanation and the expiry are worked out
 * here from the evidence; the description and activity come from the drafts,
 * which are aligned with the candidates by position.
 */

import { persistTimeSuggestions } from "@repo/database";
import {
	timeSuggestionExpiry,
	timeSuggestionExplanation,
} from "@repo/utils/time-suggestions";
import { candidateSummaries } from "./build-time-suggestion-prompt";
import type { TimeSuggestionCandidate, TimeSuggestionDraft } from "./types";

export interface PersistTimeSuggestionsInput {
	runId: string;
	organizationId: string;
	userId: string;
	timezone: string;
	candidates: TimeSuggestionCandidate[];
	drafts: TimeSuggestionDraft[];
}

export interface PersistTimeSuggestionsOutput {
	/** False when the run was reclaimed as timed out: nothing was stored. */
	persisted: boolean;
	createdCount: number;
}

function toDate(value: string | null): Date | null {
	return value === null ? null : new Date(value);
}

export async function persistTimeSuggestionsActivity(
	input: PersistTimeSuggestionsInput,
): Promise<PersistTimeSuggestionsOutput> {
	if (input.drafts.length !== input.candidates.length) {
		throw new Error(
			`Expected ${input.candidates.length} drafts, got ${input.drafts.length}`,
		);
	}
	return persistTimeSuggestions({
		runId: input.runId,
		organizationId: input.organizationId,
		userId: input.userId,
		suggestions: input.candidates.map((candidate, index) => {
			const draft = input.drafts[index];
			return {
				projectId: candidate.projectId,
				workDate: candidate.workDate,
				timezone: input.timezone,
				activity: draft.activity,
				durationMinutes: candidate.durationMinutes,
				startAt: toDate(candidate.startAt),
				stopAt: toDate(candidate.stopAt),
				description: draft.description,
				explanation: timeSuggestionExplanation(
					candidateSummaries(candidate),
				),
				storyId: candidate.storyId,
				storyIdentifier: candidate.storyIdentifier,
				storyTitle: candidate.storyTitle,
				expiresAt: timeSuggestionExpiry(
					candidate.workDate,
					input.timezone,
				),
				evidence: candidate.evidence.map((item) => ({
					kind: item.kind,
					sourceId: item.sourceId,
					projectId: candidate.projectId,
					occurredAt: new Date(item.occurredAt),
					startAt: toDate(item.startAt),
					endAt: toDate(item.endAt),
				})),
			};
		}),
	});
}
