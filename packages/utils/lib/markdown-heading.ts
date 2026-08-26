/**
 * Make a Markdown line's TEXT visible to a structural matcher, whatever inline
 * decoration the editor wrapped it in.
 *
 * Several places in this codebase find a section by matching a heading line —
 * the acceptance-criteria split, the "does this document already have an
 * `## Attachments` section" checks, the pending-decisions count. They all match
 * against the raw line, so the moment a user highlights a heading in the editor
 * (TipTap emits `## <mark data-color="…">Acceptance Criteria</mark>`) or bolds
 * it (`## **Acceptance Criteria**`), the heading stops matching and the feature
 * page silently splits wrong or appends a duplicate section. This helper is the
 * one place that erases decoration so those matchers keep seeing the heading.
 *
 * ## The output is MATCH-ONLY — never store it
 *
 * The transform is deliberately lossy: it deletes `*`, `_`, backtick and `~`
 * characters wherever they appear, so `## 5 * 3 rules` normalizes to
 * `## 5 3 rules`. That is harmless when comparing against a fixed target string
 * and destructive if it ever reaches the database. Normalize for the comparison;
 * write back the ORIGINAL line.
 *
 * ## Why character-level, not pair-matching
 *
 * The obvious implementation unwraps delimiter pairs — `(\*\*|\*)(.+?)\1`. Do
 * not write that. `docs/solutions/security-issues/redos-in-preview-markdown-strip.md`
 * documents a ReDoS in this repo's other inline-decoration stripper, where
 * `(___|__|_)(?=\S)(.*?\S)\1(?![\w])` went quadratic on a single long line of
 * unpaired tokens (`_a _a _a …`): every opener rescans its whole line and never
 * pairs. A lazy quantifier followed by a can-fail closer is the smell, and it is
 * exactly the shape a pair-unwrapping version of this helper would have.
 *
 * These matchers only need the KEYWORD to become visible, so the helper never
 * has to correctly unwrap emphasis. Both passes are strictly linear — a negated
 * character class with a literal terminator, then a bare character class. No
 * lazy quantifiers, no backreferences, no lookarounds, no backtracking. The
 * 4000-character cap (matching `apps/web/modules/ui/lib/strip-markdown.ts`) is
 * belt-and-braces on top of that: it bounds cost to a constant even if a future
 * edit reintroduces an unsafe pattern. The cap is per LINE, which is this
 * helper's argument unit, so scanning a whole document line by line stays linear
 * in document length.
 *
 * ## Why a single pass, never a fixpoint
 *
 * Deleting tags once turns `<ma<mark>rk>` into `rk>` — mangled, which is the
 * point. Re-running the pass until nothing changes is what would reassemble a
 * hidden `<mark>` out of the debris ("mangle, don't delete" in `CONCEPTS.md`).
 * Single-pass is only safe because this output is never re-parsed and never
 * persisted; that rationale does not transfer to code that writes its result.
 *
 * ## The heading-forgery guard
 *
 * Stripping decoration anywhere in the line means a BODY line can be promoted
 * into heading shape: `` `## Acceptance Criteria` `` (inline code) and
 * `<span>## Original Description from User (Do Not Modify)` both normalize to
 * real headings. A crafted body line could then move a section boundary — the
 * verbatim-preserve markers included. So the guard is the last thing applied: if
 * the trimmed input does not begin with `#` but the normalized result does, the
 * input comes back untouched. Decoration stripping fixes headings that are
 * already headings; it must never move a line INTO heading shape.
 *
 * The guard is only needed in that one direction. A line like
 * `**Acceptance Criteria:**` with no `#` at all normalizes to
 * `Acceptance Criteria:`, which still fails the `/^#{1,6}\s+acceptance/i`
 * matchers, so nothing is gained by guarding it.
 *
 * Lives in `@repo/utils` behind its own subpath rather than the barrel: it is
 * pure, total string work with no dependencies, and it is imported by CLIENT
 * components as well as by server code, so it must not drag the barrel's Node
 * built-ins into the browser bundle.
 */

/** Longest line this helper will look at. See the ReDoS note above. */
const MAX_LINE_LENGTH = 4000;

/** An HTML tag: negated class with a literal terminator — linear, no backtracking. */
const HTML_TAG = /<[^>]*>/g;

/** Emphasis punctuation: a bare character class — no quantifier, no backreference. */
const EMPHASIS_CHARS = /[*_`~]/g;

/**
 * Strip inline decoration from a single Markdown line so a structural matcher
 * can see its text.
 *
 * Pure and total: never throws, returns `""` for nullish, empty or
 * whitespace-only input. The result is for COMPARISON ONLY — see the module
 * docstring; storing it corrupts the document.
 */
export function stripInlineDecoration(line: string | null | undefined): string {
	if (!line?.trim()) {
		return "";
	}

	const capped =
		line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line;

	const normalized = capped
		.replace(HTML_TAG, "")
		.replace(EMPHASIS_CHARS, "")
		.replace(/\s+/g, " ")
		.trim();

	// Heading-forgery guard, applied last: never promote a body line into a
	// heading. A line that was ALREADY a heading is still normalized.
	if (!line.trim().startsWith("#") && normalized.startsWith("#")) {
		return line;
	}

	return normalized;
}

/**
 * Index of the line that ends the section opened at `headerIdx` — the next
 * `#`/`##` heading, or the end of the array.
 *
 * Deliberately tested against the RAW line — do NOT normalize here. `/^##? \S/`
 * only requires a non-whitespace character after the hashes, and `<`, `*`, `~`
 * and a backtick all satisfy it, so a decorated FOLLOWING heading already
 * terminates the section correctly today. Normalizing first could only lose the
 * match: a heading whose entire visible text sits inside the stripped tag
 * collapses to a bare `##`, which fails `\S`, and the section would then
 * over-read to EOF — swallowing every later section into the extracted body.
 *
 * Shared because the two copies of the "Do Not Modify" verbatim-preserve guard
 * (`reevaluate-bug` and the generalized `structure-guards`) are mirrors of each
 * other and must terminate sections identically.
 */
export function findSectionEndIdx(lines: string[], headerIdx: number): number {
	for (let i = headerIdx + 1; i < lines.length; i++) {
		if (/^##? \S/.test(lines[i] ?? "")) {
			return i;
		}
	}
	return lines.length;
}

/**
 * Offset just PAST the line carrying `heading`, or `-1` when the document has no
 * such heading.
 *
 * A whole-document `text.indexOf(heading)` stops matching the moment a user
 * decorates the heading in the editor — highlighting it emits
 * `## <mark data-color="…">Resolved Decisions (pending integration)</mark>`,
 * bolding it emits `## **Resolved Decisions (pending integration)**` — so the
 * section goes invisible and every "does this document already have one?" check
 * answers wrong: the pending-decisions appendix gained a duplicate heading on
 * every further answer while its "X New Decisions" count read 0. Scan line by
 * line and normalize each line before comparing.
 *
 * `stripInlineDecoration` is MATCH-ONLY and lossy, so the returned offset is
 * measured against the ORIGINAL text (running length of the untouched lines) —
 * callers slice the real document, never a normalized copy.
 *
 * The predicate is `includes`, not equality, matching the raw `indexOf` it
 * replaces: a demoted `### Resolved Decisions (pending integration)` still
 * contains the heading and still counts as the section.
 *
 * Shared because both the server path that writes a section and the client path
 * that has to find the same section in a document about to be saved must agree
 * on where it is; two scanners would drift the moment one learned a new shape.
 */
export function findHeadingLineEnd(text: string, heading: string): number {
	let offset = 0;
	for (const line of text.split("\n")) {
		if (stripInlineDecoration(line).includes(heading)) {
			return offset + line.length;
		}
		// + 1 for the "\n" that `split` consumed.
		offset += line.length + 1;
	}
	return -1;
}
