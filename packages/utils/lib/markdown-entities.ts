/**
 * Undo HTML-entity escaping that a model emitted into a MARKDOWN body.
 *
 * Work-item descriptions and acceptance criteria are markdown, rendered through
 * a markdown component. An HTML entity in markdown is not an escape — it is
 * literal text, so `it&#x27;s` renders to the reader as `it&#x27;s`.
 *
 * WHY THIS EXISTS: the structure-preserving re-analysis is handed the existing
 * body and asked to return the merged one. Models routinely return apostrophes
 * and quotes HTML-escaped, and — worse — escape the ampersand of an entity they
 * were *shown*, so the damage compounds once per pass:
 *
 *     it's  →  it&#x27;s  →  it&amp;#x27;s  →  it&amp;amp;#x27;s
 *
 * Observed on staging: a ticket enriched twice went from 0 to 15 to 27
 * occurrences, having never contained an entity to begin with. Enriching the
 * same ticket repeatedly is the normal case for Create-vs-Enrich routing, so
 * the compounding is not hypothetical.
 *
 * SCOPE — deliberately narrow. Only entities whose literal form is unambiguous
 * in markdown are decoded:
 *   - the apostrophe and quote forms a model reaches for when escaping prose,
 *   - `&amp;` LAST and only to unwind the compounding, so `&amp;#x27;` collapses
 *     to `'` in one call rather than needing one call per pass.
 *
 * `&lt;` and `&gt;` are NOT decoded: a body legitimately showing `<div>` as
 * literal text needs them, and turning those into real angle brackets is the
 * one change here that could alter meaning rather than restore it.
 */

/**
 * How many levels of `&amp;`-compounding are unwound. Each enrichment adds at
 * most one level, so this covers a ticket enriched a dozen times; the loop
 * exits early the moment a pass changes nothing.
 */
const MAX_UNWIND_PASSES = 12;

/**
 * Entity forms for a single quote / apostrophe and a double quote, in both the
 * numeric and named spellings models actually emit.
 *
 * The numeric forms tolerate leading zeros: `&#039;` is what
 * `htmlspecialchars`-style escapers emit and is at least as common in model
 * output as the unpadded `&#39;`. Missing it left a body escaped that way
 * compounding forever, and left `&amp;#039;` half-processed — the `&amp;`
 * unwound, the entity itself untouched.
 */
const QUOTE_ENTITIES: ReadonlyArray<[RegExp, string]> = [
	[/&#x0*27;/gi, "'"],
	[/&#0*39;/g, "'"],
	[/&apos;/gi, "'"],
	[/&quot;/gi, '"'],
	[/&#x0*22;/gi, '"'],
	[/&#0*34;/g, '"'],
];

/**
 * Decode quote entities in a markdown body, unwinding any depth of
 * `&amp;`-compounding first.
 *
 * Idempotent: running it on already-clean text changes nothing, so it is safe
 * to apply on every pass.
 */
export function decodeMarkdownQuoteEntities(text: string): string {
	if (!text || !text.includes("&")) {
		return text;
	}

	// Unwind compounding one level per pass: `&amp;amp;#x27;` → `&amp;#x27;` →
	// `&#x27;`. Bounded so a pathological input cannot spin, and only applied
	// where another `amp;` or a real entity follows, so a lone `&amp;` meaning a
	// literal ampersand survives.
	//
	// The lookahead is fixed-width on purpose. A nested quantifier
	// (`(?:amp;)*`) would express the same thing in one pass, but this input
	// derives from ingested meeting and chat content, and a fixed-width
	// lookahead cannot backtrack at all — so the bound holds by construction
	// rather than by trusting the engine's optimiser. (Measured: V8 handles
	// both shapes in ~0ms at 40k characters, so this is defence in depth, not
	// a fix for an observed slowdown.)
	let out = text;
	for (let pass = 0; pass < MAX_UNWIND_PASSES; pass++) {
		const next = out.replace(
			/&amp;(?=amp;|#x?[0-9a-f]+;|apos;|quot;)/gi,
			"&",
		);
		if (next === out) {
			break;
		}
		out = next;
	}

	for (const [pattern, replacement] of QUOTE_ENTITIES) {
		out = out.replace(pattern, replacement);
	}
	return out;
}
