/**
 * The export scrubber for a client-document Proposal (Fizzy #2946).
 *
 * Main is written for the client, but a person editing it, or a model writing
 * it, can leave behind the citation apparatus the internal analysis works
 * from. Before Main leaves the app as a PDF, a Word file or a Markdown
 * download, this removes exactly two things:
 *
 * - citation markers (`[S3]`, `\[S2\]`, `[S1–S3]`, `**[S4]**`, `[cite]`),
 *   the same pattern Glossy cleanup removes, never inside code;
 * - Source Index sections: a section headed "Source Index" (numbered or
 *   not), or one headed "Sources" or "Source list" whose first entry is an
 *   `[S#]` label, together with its subsections.
 *
 * Everything else stays exactly as the page shows it: the document's own
 * Appendix, its TBD lines, its cover fields. Glossy's `cleanupDocument` is
 * deliberately not used, because it moves, rewrites and drops client
 * content. This catches markers, not leaked prose.
 *
 * Pure and browser-safe (no Node built-ins, no Markdown parser): the
 * Markdown download in the editor bundle runs it too.
 */

import { CITATION_MARKER } from "../citation-markers";
import { headingAnchor, parseOutline, scanFences } from "../glossy/outline";

export interface ExportScrubResult {
	/** The scrubbed Markdown, with LF line endings. */
	markdown: string;
	/** Citation markers removed. */
	removedMarkers: number;
	/** Source Index sections removed, subsections not counted. */
	removedSections: number;
}

/** Headings that always name a source index. */
const SOURCE_INDEX_ANCHORS: ReadonlySet<string> = new Set(["source index"]);

/**
 * Headings that name a source index only when their first entry is an
 * `[S#]` label; a "Sources" section of prose stays.
 */
const SOURCE_LIST_ANCHORS: ReadonlySet<string> = new Set([
	"sources",
	"source list",
]);

/** A source index entry: an optional list marker, then an `[S#]` label. */
const SOURCE_ENTRY =
	/^\s{0,3}(?:[-*+][ \t]+|\d{1,3}[.)][ \t]+)?(?:\*\*|__)?\\?\[S\d{1,4}\\?\]/;

/** One inline code span on a line; markers inside it are content. */
const INLINE_CODE = /`[^`\n]*`/g;

/** A line left holding only a list marker, or nothing, once its markers go. */
const EMPTY_AFTER_REMOVAL = /^\s*(?:[-*+]|\d{1,3}[.)])?\s*$/;

/**
 * Remove citation markers and Source Index sections from a client-document
 * Proposal's Main before it is exported. Line endings come back as LF.
 */
export function scrubProposalExport(markdown: string): ExportScrubResult {
	const normalized = markdown.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	const roles = scanFences(lines);

	const removed = new Array<boolean>(lines.length).fill(false);
	let removedSections = 0;
	for (const heading of parseOutline(normalized)) {
		const start = heading.startLine - 1;
		if (removed[start] || !isSourceIndex(heading, lines, roles)) {
			continue;
		}
		for (let index = start; index < heading.endLine; index++) {
			removed[index] = true;
		}
		removedSections++;
	}

	const out: string[] = [];
	let removedMarkers = 0;
	let afterRemoval = false;
	for (const [index, line] of lines.entries()) {
		if (removed[index]) {
			afterRemoval = true;
			continue;
		}
		// The blank line before a removed section already separates what
		// follows it, so a blank line right after one is not repeated.
		if (afterRemoval && line.trim() === "" && out.at(-1)?.trim() === "") {
			continue;
		}
		afterRemoval = false;
		if (roles[index] !== null) {
			out.push(line);
			continue;
		}
		const scrubbed = removeMarkers(line);
		if (scrubbed.count === 0) {
			out.push(line);
			continue;
		}
		removedMarkers += scrubbed.count;
		if (!EMPTY_AFTER_REMOVAL.test(scrubbed.text)) {
			out.push(scrubbed.text);
		}
	}

	return { markdown: out.join("\n"), removedMarkers, removedSections };
}

function isSourceIndex(
	heading: { text: string; startLine: number; endLine: number },
	lines: readonly string[],
	roles: readonly (string | null)[],
): boolean {
	// Lines are 1-based; the body starts on the line after the heading.
	let firstEntry: string | null = null;
	for (let index = heading.startLine; index < heading.endLine; index++) {
		const line = lines[index] ?? "";
		if (line.trim() === "") {
			continue;
		}
		firstEntry = roles[index] === null ? line : null;
		break;
	}
	return isSourceIndexHeading(heading.text, firstEntry);
}

/**
 * Whether a heading opens a Source Index section: it reads "Source Index"
 * (numbered or not), or "Sources" / "Source list" and its first entry, the
 * first non-blank line of its body, is an `[S#]` label. The export's parsed
 * tree applies the same rule.
 */
export function isSourceIndexHeading(
	headingText: string,
	firstEntry: string | null,
): boolean {
	const anchor = headingAnchor(headingText);
	if (SOURCE_INDEX_ANCHORS.has(anchor)) {
		return true;
	}
	return (
		SOURCE_LIST_ANCHORS.has(anchor) &&
		firstEntry !== null &&
		SOURCE_ENTRY.test(firstEntry)
	);
}

/**
 * One piece of text without its citation markers, by the same rule the line
 * scrubber applies (markers removed to a fixed point, the gaps tidied, never
 * inside inline code). For text already parsed out of Markdown.
 */
export function scrubCitationText(text: string): {
	text: string;
	count: number;
} {
	return removeMarkers(text);
}

/** Most removal passes one line gets; honest text needs one or two. */
const MAX_PASSES = 20;

/**
 * The line without its citation markers, never touching inline code. Only a
 * line that lost a marker is tidied: doubled spaces close up, an emptied
 * `()` goes and a space left before punctuation goes, but its indentation
 * and trailing spaces (a hard break) stay.
 *
 * Removing text can join what was around it into a new marker (`[S[S1]1]`
 * leaves `[S1]`, and so can a `()` the tidying removes), so removal and
 * tidying repeat until nothing changes. A line that still forms a marker
 * after {@link MAX_PASSES} passes is built to defeat the scrubber and is
 * dropped whole.
 */
function removeMarkers(line: string): { text: string; count: number } {
	// Indentation and trailing spaces are the original line's: a marker at
	// either end must not add a space there, or take a hard break away.
	const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
	const trailing = /[ \t]*$/.exec(line)?.[0] ?? "";
	let text = line;
	let count = 0;
	for (let pass = 0; pass < MAX_PASSES; pass++) {
		const step = stripOnce(text);
		if (step.count === 0) {
			return { text: count === 0 ? line : text, count };
		}
		count += step.count;
		text = indent + step.text.trim() + trailing;
	}
	return stripOnce(text).count === 0
		? { text, count }
		: { text: "", count: count + 1 };
}

/**
 * One pass of marker removal, and when it removed any, of tidying: both only
 * outside inline code, whose text is content and stays exactly as written.
 */
function stripOnce(line: string): { text: string; count: number } {
	const pieces: { text: string; code: boolean }[] = [];
	let cursor = 0;
	for (const code of line.matchAll(INLINE_CODE)) {
		const start = code.index ?? 0;
		pieces.push({ text: line.slice(cursor, start), code: false });
		pieces.push({ text: code[0], code: true });
		cursor = start + code[0].length;
	}
	pieces.push({ text: line.slice(cursor), code: false });

	let count = 0;
	const stripped = pieces.map((piece) =>
		piece.code
			? piece
			: {
					...piece,
					text: piece.text.replace(CITATION_MARKER, () => {
						count++;
						return "";
					}),
				},
	);
	if (count === 0) {
		return { text: line, count };
	}
	return {
		text: stripped
			.map((piece) => (piece.code ? piece.text : tidyGaps(piece.text)))
			.join(""),
		count,
	};
}

function tidyGaps(text: string): string {
	return (
		text
			.replace(/\(\s*(?:[,;]\s*)*\)/g, "")
			.replace(/(\S)[ \t]{2,}/g, "$1 ")
			// Anchored on the preceding character so a long run of spaces
			// stays linear.
			.replace(/(^|\S)[ \t]+(?=[.,;:!?])/g, "$1")
	);
}
