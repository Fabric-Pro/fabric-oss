/**
 * Collapse tilde-prefixed typographic-quote artifacts in generated markdown.
 *
 * Stored documents were found where EVERY typographic quote carried a leading
 * tilde, in runs whose length doubled with each regeneration: `~"` then `~"~"`
 * then `~"~"~"~"`. Zero clean quotes remained (Fizzy #2210). An exhaustive search
 * found no code in this repository that produces the pattern, and the editor's
 * save round-trip is a fixed point, so this is content hygiene against a defect
 * whose origin is unproven, not a fix for a located bug. It sits beside
 * `repairMalformedMermaidFences` for the same reason that one exists: models emit
 * malformed output, and the stored document should be well-formed regardless.
 *
 * ## Why a document-level signature, not a local shape
 *
 * A lone `~` before a quote is NOT evidence of anything. `~'90s` means
 * "approximately the '90s", `Table~"A"` is a reference, and GFM accepts
 * single-tilde strikethrough. Inferring corruption from the local shape alone
 * would silently rewrite legitimate prose in documents that were never damaged —
 * and this runs at every seam that persists model output, so that edit would
 * reach text nobody approved.
 *
 * The observed corruption is systematic and DOUBLING: a damaged document carries
 * runs of two or more quotes throughout, never a single isolated pair. So a
 * doubled run is the signature. Where one exists, the document is known-damaged
 * and single pairs in it are collapsed too; where none does, single pairs are
 * left exactly as the author wrote them.
 *
 * A run collapses to ONE quote rather than having its tildes stripped —
 * stripping `~"~"` would leave `""`, doubling the very thing being repaired.
 *
 * A run repeats only for the SAME quote character, via a backreference. Matching
 * any tilde-quote pairs and keeping the last one loses content whenever two
 * DIFFERENT quotes abut: `~"~"` at a phrase boundary collapsed both into a single
 * character and left the quotation unbalanced.
 *
 * Idempotent by construction: the output of a repaired document contains no
 * doubled run, so a second application finds no signature and changes nothing.
 */
const QUOTE = "[\\u2018\\u2019\\u201C\\u201D]";
/** One or more tilde-quote pairs, all of the SAME quote character. */
const ARTIFACT_RUN = new RegExp(`~+(${QUOTE})(?:~+\\1)*`, "g");
/** The signature: a run carrying the same quote at least twice. */
const DOUBLED_RUN = new RegExp(`~+(${QUOTE})~+\\1`);
/** A single tilde before a single quote — corrupt only in a known-damaged document. */
const SINGLE_PAIR = new RegExp(`^~${QUOTE}$`);

export function normalizeQuoteArtifacts(source: string): string {
	// Establish the signature ONCE for the whole document, before rewriting
	// anything — a repair that consumed its own evidence as it went would treat
	// later runs differently from earlier ones.
	const documentIsDamaged = DOUBLED_RUN.test(source);

	return source.replace(ARTIFACT_RUN, (run, quote: string) => {
		const quoteCount = (run.match(new RegExp(QUOTE, "g")) ?? []).length;
		if (quoteCount >= 2) {
			// A doubled run is corruption on its own evidence.
			return quote;
		}
		if (documentIsDamaged && SINGLE_PAIR.test(run)) {
			return quote;
		}
		// A lone pair in an undamaged document, or a `~~` strikethrough opener.
		return run;
	});
}
