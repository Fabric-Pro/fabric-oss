/**
 * Who sees Parlume's unprompted suggestions and recap: MEETING posts them in
 * the meeting chat, where every participant (external guests included) reads
 * them; TEAM keeps them on the project's Parlume page, for its readers only.
 * Matches the `ParlumeSuggestionAudience` database enum.
 */
export const PARLUME_SUGGESTION_AUDIENCES = ["MEETING", "TEAM"] as const;

export type ParlumeSuggestionAudience =
	(typeof PARLUME_SUGGESTION_AUDIENCES)[number];
