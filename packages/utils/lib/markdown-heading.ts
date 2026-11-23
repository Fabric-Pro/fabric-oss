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

// A fenced code block's opening fence: three or more backticks or tildes, then
// an info string, which for a backtick fence holds no backtick (CommonMark), so
// "```ts```" is inline code, not a fence. Any indentation is accepted: a fence
// inside a list item sits at the item's content column, four spaces or more in
// a nested list, and the heading matchers test trimmed lines, so a code block
// there must still hide its `# comment` lines.
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})(.*)$/;

// A closing fence: a run of one fence character, alone on its line.
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/;

/** `line` without the "\r" a CRLF document ends it with. */
function withoutCarriageReturn(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function fenceOpener(line: string): string | null {
	const match = FENCE_OPEN_RE.exec(withoutCarriageReturn(line));
	const marker = match?.[1];
	if (!marker) {
		return null;
	}
	return marker.startsWith("`") && (match?.[2] ?? "").includes("`")
		? null
		: marker;
}

/** The run of fence characters a closing fence on `line` is made of. */
function fenceCloser(line: string): string | undefined {
	return FENCE_CLOSE_RE.exec(withoutCarriageReturn(line))?.[1];
}

/** A fence closes on a run of the opener's character, at least as long. */
function closesFence(open: string, closer: string | undefined): boolean {
	return (
		closer !== undefined &&
		closer[0] === open[0] &&
		closer.length >= open.length
	);
}

/** Per line, the longest closing run of `char` on that line or after it. */
function longestCloserFrom(
	closers: readonly (string | undefined)[],
	char: string,
): number[] {
	const longest = closers.map(() => 0).concat(0);
	for (let i = closers.length - 1; i >= 0; i--) {
		const closer = closers[i];
		longest[i] = Math.max(
			longest[i + 1] ?? 0,
			closer?.[0] === char ? closer.length : 0,
		);
	}
	return longest;
}

/**
 * Which of `lines` are code: inside a fenced code block, fences included. A
 * heading-shaped line there is code, never a section boundary.
 *
 * A fence the document never closes runs to its end, as CommonMark has it,
 * unless that hides every line `isBoundary` matches. Such a fence is far more
 * likely a stray line than a code block holding the boundary, and taking it
 * for one folds the criteria into the description, where the editor shows
 * them beside the column's copy. Its opener is then read as text and the
 * scan goes on with the line after it.
 *
 * One pass: each line is classified once, and whether a fence ever closes,
 * or a boundary follows, is read from tables built back to front, so a
 * document of many stray openers still costs time linear in its lines.
 */
export function fencedCodeLines(
	lines: readonly string[],
	isBoundary: (line: string) => boolean,
): boolean[] {
	const code = lines.map(() => false);
	const boundary = lines.map((line) => isBoundary(line));
	const boundaryFrom = boundary.concat(false);
	for (let i = lines.length - 1; i >= 0; i--) {
		boundaryFrom[i] =
			(boundary[i] ?? false) || (boundaryFrom[i + 1] ?? false);
	}
	const closers = lines.map(fenceCloser);
	const longestBacktickFrom = longestCloserFrom(closers, "`");
	const longestTildeFrom = longestCloserFrom(closers, "~");

	let boundaryOutsideCode = false;
	for (let i = 0; i < lines.length; i++) {
		const open = fenceOpener(lines[i] ?? "");
		if (open === null) {
			boundaryOutsideCode ||= boundary[i] ?? false;
			continue;
		}
		const longestFrom = open.startsWith("`")
			? longestBacktickFrom
			: longestTildeFrom;
		if ((longestFrom[i + 1] ?? 0) >= open.length) {
			code[i] = true;
			do {
				i++;
				code[i] = true;
			} while (!closesFence(open, closers[i]));
			continue;
		}
		if (boundaryOutsideCode || !boundaryFrom[i + 1]) {
			code.fill(true, i);
			break;
		}
		boundaryOutsideCode ||= boundary[i] ?? false;
	}
	return code;
}

/**
 * Offsets, into the ORIGINAL text, of the first line outside code that
 * `matches`; null when there is none.
 *
 * The running offset over the original lines is the point: a normalized line
 * is shorter than the line, so an offset taken from a normalized copy would
 * not map back. A trailing "\r" stays part of its line, so CRLF documents keep
 * correct offsets.
 */
function findLineOutsideCode(
	text: string,
	matches: (line: string) => boolean,
): { start: number; length: number } | null {
	const lines = text.split("\n");
	const code = fencedCodeLines(lines, matches);
	let start = 0;
	for (const [i, line] of lines.entries()) {
		if (!code[i] && matches(line)) {
			return { start, length: line.length };
		}
		// + 1 for the "\n" that `split` consumed.
		start += line.length + 1;
	}
	return null;
}

/**
 * Offsets, into the ORIGINAL text, of the first line outside code whose
 * decoration-stripped form matches `pattern`; null when there is none.
 *
 * Shared so every surface that looks for a section heading skips the same
 * fenced lines the acceptance splits (`parseStoryContent`, `splitCleanSpec`)
 * skip.
 */
export function findHeadingLine(
	text: string,
	pattern: RegExp,
): { start: number; length: number } | null {
	return findLineOutsideCode(text, (line) =>
		pattern.test(stripInlineDecoration(line)),
	);
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
 * A line inside a fenced code block is code, never the heading, as for
 * `findHeadingLine`.
 *
 * Shared because both the server path that writes a section and the client path
 * that has to find the same section in a document about to be saved must agree
 * on where it is; two scanners would drift the moment one learned a new shape.
 */
export function findHeadingLineEnd(text: string, heading: string): number {
	const line = findLineOutsideCode(text, (candidate) =>
		stripInlineDecoration(candidate).includes(heading),
	);
	return line === null ? -1 : line.start + line.length;
}
