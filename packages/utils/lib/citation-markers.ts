/**
 * Citation markers a model writes into a document: `[S1]`, `[cite]` and their
 * forms. One pattern, shared by Glossy cleanup and the export scrubber, so
 * both remove exactly the same markers.
 *
 * No Node built-ins and no imports: the editor bundle imports it.
 */

/**
 * `[S1]`, `\[S2\]` (escaped by the editor's serializer), `[S1, S3]`,
 * `[S1–S3]`, `[cite]`, `[cite if derived]`, optionally bolded or linked.
 * A pattern source, for composing larger patterns.
 */
export const CITATION_MARKER_CORE = String.raw`\\?\[(?:cite\b[^\]\n]{0,80}|S\d{1,4}(?:\s{0,2}[,;–—-]\s{0,2}S?\d{1,4}){0,20})\\?\](?:\([^()\s]{0,200}\))?`;
/** One marker, bolded or not. A pattern source. */
export const CITATION_MARKER_UNIT = String.raw`\*\*${CITATION_MARKER_CORE}\*\*|__${CITATION_MARKER_CORE}__|${CITATION_MARKER_CORE}`;

/**
 * A marker, or a range written as two markers joined by a dash, `[S1]–[S15]`,
 * which goes with its dash (Fizzy #2589 follow-up).
 *
 * Global: use it only through `replace`, `replaceAll` or `matchAll`, which
 * reset `lastIndex`, never through `test` or `exec`.
 */
export const CITATION_MARKER = new RegExp(
	String.raw`(?:${CITATION_MARKER_UNIT})(?:[ \t]{0,2}[–—-][ \t]{0,2}(?:${CITATION_MARKER_UNIT}))?`,
	"gi",
);
