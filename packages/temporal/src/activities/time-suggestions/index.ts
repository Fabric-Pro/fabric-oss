/**
 * Time-suggestion activities: collect and group a member's evidence, describe
 * each block, store the result, and mark a failed run.
 *
 * Only the activity entry points are re-exported. The prompt builder is the
 * pure half of this slice, imported directly by its tests and by the
 * activities, and must never be scheduled by Temporal.
 */

export {
	type CollectTimeSuggestionCandidatesInput,
	collectTimeSuggestionCandidatesActivity,
} from "./collect-time-suggestion-candidates";
export {
	type DraftTimeSuggestionsInput,
	draftTimeSuggestionsActivity,
} from "./draft-time-suggestions";
export {
	type MarkTimeSuggestionRunFailedInput,
	markTimeSuggestionRunFailedActivity,
} from "./mark-time-suggestion-run-failed";
export {
	type PersistTimeSuggestionsInput,
	type PersistTimeSuggestionsOutput,
	persistTimeSuggestionsActivity,
} from "./persist-time-suggestions";
export type {
	TimeSuggestionCandidate,
	TimeSuggestionDraft,
} from "./types";
