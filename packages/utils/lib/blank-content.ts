/**
 * Characters that occupy no visual space and carry no content on their own:
 * the soft hyphen, the Mongolian vowel separator, the zero-width family and the
 * directional marks, the word joiner and invisible math operators, and the BOM.
 *
 * These are all Unicode General_Category=Cf (Format). `\p{Cf}` would say that
 * in one token, but unicode property escapes require an ES2018 target and this
 * package compiles to ES6, so the set is spelled out. Written as escapes on
 * purpose — a literal zero-width character in source is invisible to the next
 * reader, which is the very problem this guard exists to catch.
 *
 * Anything added here must be genuinely invisible in isolation. A character a
 * reader would actually see is content, however unusual it looks.
 */
const INVISIBLE_FORMAT_CHARS =
	/[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g;

/**
 * True when `text` contains nothing a person or a model would actually read.
 *
 * `String.prototype.trim()` alone is not enough. It strips Unicode whitespace,
 * so a non-breaking space is caught — but it leaves zero-width characters
 * intact, and `"\u200B".trim().length` is 1. A body pasted out of a web page or
 * a word processor can consist entirely of such characters: non-empty to every
 * length check, blank to every reader.
 *
 * Found in QA (Fizzy #2178): a prompt body of a single U+200B passed the
 * save-time blank check, became the bound version, and produced an agenda
 * stored as a success that contained no agenda.
 */
export function isEffectivelyBlank(text: string): boolean {
	return text.replace(INVISIBLE_FORMAT_CHARS, "").trim().length === 0;
}
