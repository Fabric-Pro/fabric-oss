/**
 * Which heading opens a Proposal's cover letter (Fizzy #2946).
 *
 * A cover letter is Main's first `##` section when its heading, a typed
 * number aside, reads "Cover letter" or "Anschreiben". The PDF and the Word
 * file print that section as a letter, on its own page before the contents,
 * and the visuals step gives it no diagram. Both read the heading with this
 * one rule, so a heading is never a letter to one and a section to the
 * other.
 *
 * Pure functions and data only: client components may import this module,
 * so it must not pull in anything the browser bundle cannot carry.
 */

/**
 * A number typed before a heading's own words, such as "1. ", "2) ", "1: "
 * or "0.1 ". The editor escapes an ordered-looking heading when it saves
 * (`## 1\. Cover letter`), and a reader of the raw line sees that backslash,
 * so the separator may carry one.
 */
const LETTER_HEADING_NUMBER = /^\d{1,2}(?:\.\d{1,2})*\\?[.):]?\s+/;

/**
 * A cover letter's heading, in English or German, once its number is gone:
 * the whole heading, in any case, with at most a trailing colon or full
 * stop.
 */
const COVER_LETTER_HEADING = /^(?:cover\s+letter|anschreiben)\s*[:.]?$/iu;

/** A cover letter's trailing colon or full stop, which its label leaves out. */
const LETTER_HEADING_END = /\s*[:.]$/;

/**
 * The heading as the letter's label shows it, when it names a cover letter:
 * "Cover letter" for "1. Cover letter:", or null for any other heading.
 * Takes the heading's plain text, without its `#` marks or inline markup.
 * Whether the heading is the first `##` of Main is the caller's to check.
 */
export function coverLetterLabel(title: string): string | null {
	const text = title.trim().replace(LETTER_HEADING_NUMBER, "").trim();
	return COVER_LETTER_HEADING.test(text)
		? text.replace(LETTER_HEADING_END, "")
		: null;
}
