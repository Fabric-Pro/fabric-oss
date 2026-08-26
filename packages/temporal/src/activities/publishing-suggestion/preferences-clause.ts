/**
 * Publishing Suggestion — recommendation-preferences clause (1C-1b part 2,
 * §7.1(a) / FR8–FR10).
 *
 * Sibling of `buildTopicSuggestionPrompt` in `./prompt.ts`, kept in its own
 * file because that one promises in its header to have no imports at all — it
 * is a pure `unknown -> string` transform and its contract is worth keeping.
 * This one needs the post-type label map, so it lives next door instead.
 *
 * Imported only by `summarize-topic-suggestions.ts` (an ACTIVITY). Never by the
 * workflow: nothing here may end up inside the Temporal sandbox.
 *
 * Composition follows `getFunctionTagContextClause` exactly — an UPPERCASE
 * scope marker rather than a markdown heading (models honour the former and
 * drift on the latter), and the caller appends the return value verbatim, only
 * when it is non-empty.
 */

import {
	type PublishingPreferencesSnapshot,
	postTypeEnumToLabel,
} from "@repo/database";

/**
 * Turns the preferences snapshot this cycle was fingerprinted with into
 * guidance for topic summarization.
 *
 * Returns the EMPTY STRING when nothing is configured, so an unconfigured
 * project's prompt is byte-identical to what it was before this feature
 * existed. That is FR10 ("default recommendation behavior" when no preferences
 * are set) satisfied by construction rather than by a branch somewhere
 * downstream that a later edit could get wrong.
 *
 * `lookbackDays` is deliberately NOT mentioned. It is already applied by the
 * collectors before the model sees anything, so telling the model about a
 * window it cannot influence invites it to reason about the absence of older
 * material instead of about the material present.
 *
 * The snapshot arrives already trimmed, de-duped, sorted, and case-folded where
 * folding was right. Nothing here normalizes again: a second normalization is a
 * second place for these rules to drift from the ones the HASH used, and the
 * whole point of passing the snapshot rather than re-reading settings is that
 * what ran and what was recorded cannot disagree.
 */
export function buildPublishingPreferencesClause(
	snapshot: PublishingPreferencesSnapshot,
): string {
	const parts: string[] = [];

	if (snapshot.preferredThemes.length > 0) {
		parts.push(
			`Themes this project wants covered, when the CONTEXT genuinely supports them: ${snapshot.preferredThemes.join(", ")}. Do not invent coverage of a theme the context does not support — a preference is not evidence.`,
		);
	}

	// Mapped to human labels, and an unmapped value is DROPPED rather than
	// printed raw. A value the map does not know is one a later migration added
	// and this map has not caught up with; putting `SOME_NEW_TYPE` in front of
	// the model would look deliberate.
	const postTypeLabels = snapshot.preferredPostTypes
		.map((value) => postTypeEnumToLabel(value))
		.filter((label): label is NonNullable<typeof label> => label !== null);
	if (postTypeLabels.length > 0) {
		parts.push(
			`Post types this project prefers: ${postTypeLabels.join(", ")}. Favour them in postTypeRecommendations where a topic suits them; still recommend another type when it plainly fits the topic better.`,
		);
	}

	if (snapshot.strategicPriorities) {
		// Verbatim, including line breaks — the line structure is part of the
		// instruction, and a reflowed list of priorities says something different
		// from the list that was written.
		parts.push(
			`This project's stated publishing priorities, in its own words:\n${snapshot.strategicPriorities}`,
		);
	}

	if (snapshot.excludedKeywords.length > 0) {
		// Framed as a prohibition, never as a bare list. A list of keywords reads
		// to a model as a set of topics to cover, which is the exact opposite of
		// what it is for.
		parts.push(
			`Avoid topics about the following subjects entirely; do not propose them even if the CONTEXT contains material about them: ${snapshot.excludedKeywords.join(", ")}.`,
		);
	}

	if (parts.length === 0) {
		return "";
	}

	return `PUBLISHING PREFERENCES — TOPIC SELECTION GUIDANCE
This project has configured how it wants topics chosen. Treat the following as
guidance on SELECTION and FRAMING only. It does not change the output schema, does
not license inventing material, and never overrides the provenance rules above.

${parts.join("\n\n")}`;
}
