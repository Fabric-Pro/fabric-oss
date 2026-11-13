/**
 * What the time-suggestion activities pass to one another through the
 * workflow. Temporal serializes activity results as JSON, so instants travel
 * as ISO strings and are turned back into dates where they are used.
 */

import type { TimeEvidenceKind } from "@repo/utils/time-suggestions";
import type { TimeActivity } from "@repo/utils/time-tracking";

export interface TimeSuggestionCandidateEvidence {
	kind: TimeEvidenceKind;
	sourceId: string;
	occurredAt: string;
	startAt: string | null;
	endAt: string | null;
}

/** One block of time to suggest, before it is described. */
export interface TimeSuggestionCandidate {
	workDate: string;
	projectId: string;
	projectName: string;
	storyId: string | null;
	storyIdentifier: string | null;
	storyTitle: string | null;
	/** The activity the evidence suggests; the model may refine it. */
	activity: TimeActivity;
	durationMinutes: number | null;
	startAt: string | null;
	stopAt: string | null;
	evidence: TimeSuggestionCandidateEvidence[];
}

/** How one candidate is described, by the model or by the fallback. */
export interface TimeSuggestionDraft {
	description: string;
	activity: TimeActivity;
}
