/**
 * Derive a human-readable title for an auto-created `Diagram` row from
 * the user's most recent chat prompt.
 *
 * Pure function. No React, no Date.now(), no side effects — the same
 * utility is reused by Playwright fixtures (spec § 6.3 / FR-3) so a
 * regression in the title-derivation rule is caught by both unit and
 * E2E tests.
 *
 * Rule (spec § 6.3 / FR-3):
 *   - If `userPromptText` is non-empty after `.trim()`, use the first
 *     60 characters of the trimmed text. No ellipsis suffix.
 *   - Otherwise (null / undefined / empty / whitespace-only), fall back
 *     to the literal `"Untitled diagram from chat"`.
 *
 * The 60-character cap matches the `Diagram.title` column's effective
 * display width in `DiagramsList.tsx` — anything longer is truncated by
 * the list UI anyway. The cap is applied with `String.prototype.slice`,
 * which is unicode-safe at the code-unit boundary but does NOT split
 * surrogate pairs at the BOUNDARY — that's a known limitation of slice
 * on code units. For the corpus of expected prompts (English /
 * European-locale) this is acceptable; emoji- or CJK-heavy prompts may
 * see one character clipped at the boundary, which is a UX-acceptable
 * outcome (the user can rename in the Diagrams tab).
 */

/** Hard cap on the derived title length. */
export const DERIVED_DIAGRAM_TITLE_MAX_LENGTH = 60;

/** Fallback title when the prompt is empty / whitespace / nullish. */
export const UNTITLED_DIAGRAM_TITLE = "Untitled diagram from chat";

/**
 * Derive the title for the new `Diagram` row from the user's prompt.
 *
 * @param input - The chat-scoped prompt text. `null` / `undefined` /
 *                whitespace-only all collapse to the fallback title.
 * @returns A string of length 1..60 inclusive — never empty.
 */
export function deriveDiagramTitle(input: {
	userPromptText?: string | null;
}): string {
	const raw = input.userPromptText;
	if (raw === undefined || raw === null) {
		return UNTITLED_DIAGRAM_TITLE;
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return UNTITLED_DIAGRAM_TITLE;
	}
	return trimmed.slice(0, DERIVED_DIAGRAM_TITLE_MAX_LENGTH);
}
