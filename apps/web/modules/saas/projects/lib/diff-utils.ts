import { repairDegradedMarkdown } from "@repo/agent-prompts/markdown-repair";
import {
	FENCE_MARKER,
	type FenceRole,
	scanFences,
	VISUAL_SLOT_TAG,
} from "@repo/utils/glossy/outline";
import { normalizeQuoteArtifacts } from "@repo/utils/quote-artifacts";
import { type ArrayChange, diffArrays, diffWords } from "diff";
import MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import { mentionSpanInlinePlugin } from "./mention-markdown-plugin";

// ============================================
// Constants - Diff Markers
// ============================================

/**
 * Unique placeholder tokens that won't be affected by markdown processing.
 * The interior chars are zero-width spaces; the chars adjacent to inline
 * content are `\u00A0` (non-breaking space) so MarkdownIt's emphasis
 * left/right-flanking sees whitespace context and parses constructs like
 * `**[Label]**` immediately after `<ADD_START>` correctly. `\u00A0` is in
 * the Zs Unicode category and is treated as whitespace by markdown-it; the
 * diff plugin consumes the whole marker before render so this never
 * surfaces as visible text.
 */
const DIFF_ADD_START = "\u200B\u200BADD_START\u200B\u00A0";
const DIFF_ADD_END = "\u00A0\u200BADD_END\u200B\u200B";
const DIFF_DEL_START = "\u200B\u200BDEL_START\u200B\u00A0";
const DIFF_DEL_END = "\u00A0\u200BDEL_END\u200B\u200B";

// ============================================
// Helper Functions
// ============================================

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex alternation matching any of the four diff markers, derived from the
 * constants themselves. Hand-spelled copies of these tokens have silently
 * drifted from the real bytes before — matching ZWSP where the constant
 * carries an NBSP — which disabled the table repairs that depended on them
 * without any test noticing.
 */
const ANY_MARKER_SOURCE = [
	DIFF_ADD_START,
	DIFF_ADD_END,
	DIFF_DEL_START,
	DIFF_DEL_END,
]
	.map((marker) => escapeRegExp(marker))
	.join("|");

/** Every diff marker, for `String.replace` only (it resets `lastIndex`). */
const ANY_MARKER_RE = new RegExp(ANY_MARKER_SOURCE, "g");

/**
 * Merge adjacent ADD or DEL diff blocks that are separated only by short
 * runs of unchanged punctuation/whitespace.
 *
 * Background: `diffWords` is a word-level diff. When the baseline ends with
 * `work.` and the new text has a list like `... routine tasks\n3. Context`,
 * the lone `.` gets matched as an unchanged token BETWEEN two ADD spans —
 * even though it's semantically "end of sentence" in the baseline and "list
 * marker" in the new text. Result: the list item `3.` gets split across the
 * fragment boundary and `splitMultilineDiffBlocks` can't reconstruct it.
 *
 * Fusing these fragments into one contiguous ADD block preserves the
 * block structure (lists, headings) in the merged content so the split
 * helper can do its job.
 */
function mergeAdjacentDiffBlocks(text: string): string {
	// Only merge when the separator is whitespace or trivial punctuation.
	// Keep the separator length small to avoid over-merging.
	const SEPARATOR_RE = /[\s.,;:!?]{0,6}/.source;
	let merged = text.replace(
		new RegExp(
			escapeRegExp(DIFF_ADD_END) +
				`(${SEPARATOR_RE})` +
				escapeRegExp(DIFF_ADD_START),
			"g",
		),
		"$1",
	);
	merged = merged.replace(
		new RegExp(
			escapeRegExp(DIFF_DEL_END) +
				`(${SEPARATOR_RE})` +
				escapeRegExp(DIFF_DEL_START),
			"g",
		),
		"$1",
	);

	// Emphasis-pair handling is ADD-only by design. ADD blocks have their
	// content KEPT after stripDiffTags (only the wrapper is removed), so
	// fusing `<ADD>**<END>text<ADD>**<END>` → `<ADD>**text**<END>` is
	// safe — the unchanged "text" stays in the saved output. DEL blocks
	// have their content REMOVED entirely on accept; fusing across an
	// unchanged middle would silently delete that text. Leave DEL-side
	// blocks unfused so each `**` is wrapped in its own DEL and only the
	// asterisks are stripped on accept, preserving the surrounding text.
	const EMPHASIS = "(\\*{1,2}|_{1,2}|~~)";

	// Pre-split middle emphasis-only ADD blocks. When two bold spans are
	// added on the same line (`**a** **b**`), diffWords emits the closing
	// `**` of the first bold + the space + the opening `**` of the second
	// bold as a SINGLE middle ADD block (`<ADD>** **<END>`). Splitting it
	// into `<ADD>**<END> <ADD>**<END>` lets each emphasis pair fuse
	// independently below.
	merged = merged.replace(
		new RegExp(
			escapeRegExp(DIFF_ADD_START) +
				EMPHASIS +
				"(\\s+)" +
				EMPHASIS +
				escapeRegExp(DIFF_ADD_END),
			"g",
		),
		`${DIFF_ADD_START}$1${DIFF_ADD_END}$2${DIFF_ADD_START}$3${DIFF_ADD_END}`,
	);

	// Fuse split-emphasis ADD pairs: `<ADD>**<END>text<ADD>**<END>` →
	// `<ADD>**text**<END>`. The gap excludes marker chars (`​`) so the
	// fusion can't cross another ADD/DEL block.
	merged = merged.replace(
		new RegExp(
			escapeRegExp(DIFF_ADD_START) +
				EMPHASIS +
				escapeRegExp(DIFF_ADD_END) +
				"([^\\n\\u200B]{1,200}?)" +
				escapeRegExp(DIFF_ADD_START) +
				"\\1" +
				escapeRegExp(DIFF_ADD_END),
			"g",
		),
		`${DIFF_ADD_START}$1$2$1${DIFF_ADD_END}`,
	);

	return merged;
}

/**
 * Whether an offset in diff-marked text sits inside a fenced code block, for
 * a text that does not change while it is asked. The fences are scanned once,
 * with the markers taken out (they hold no line break, so the lines are the
 * same), and each lookup is a binary search over the line starts.
 */
function fenceContextOf(text: string): (offset: number) => boolean {
	const lines = text.split("\n");
	const roles = scanFences(
		lines.map((line) => line.replace(ANY_MARKER_RE, "")),
	);
	const starts: number[] = [];
	let start = 0;
	for (const line of lines) {
		starts.push(start);
		start += line.length + 1;
	}
	return (offset) => {
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if (starts[mid] <= offset) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		// A fence was open before this line.
		return roles[low] === "inside" || roles[low] === "close";
	};
}

/**
 * Split multi-line diff blocks into per-line diff runs so MarkdownIt's
 * BLOCK parser can still recognize lists, headings, and paragraphs.
 *
 * Background: `diffMarkerPlugin` is an INLINE rule. When an entire numbered
 * list (or any multi-line block) gets wrapped in a single ADD_START…ADD_END
 * pair, MarkdownIt's block parser sees the leading ADD_START as non-block
 * content and consumes everything as one paragraph. The inline parser then
 * runs on the paragraph body, so the ADD markers get handled but the
 * underlying list/heading structure is already lost. Turndown later sees a
 * flat `1. First\n2. Second` text node and escapes `1.` as `1\.`.
 *
 * Fix: rewrite multi-line ADD/DEL blocks so each non-empty line carries its
 * own inline ADD_START/ADD_END pair INSIDE the block marker (list `1.`,
 * heading `#`, etc.). The block parser then sees a normal list/heading and
 * the inline parser handles the diff markers within each item.
 *
 * Fenced code blocks inside an ADD body are preserved ATOMICALLY — every
 * line from the opening ` ``` ` to the closing ` ``` ` passes through
 * unwrapped. Wrapping the fence lines themselves would turn them into
 * `ADD_START```bashADD_END`, which MarkdownIt no longer recognizes as a
 * fence opener. The trade-off: a code block inside a mixed-content added
 * region loses its "added" highlight, but it still renders as a proper
 * `<pre><code>` block instead of getting smashed into inline prose. (Pure
 * fence ADD/DEL blocks are pulled out earlier by `extractDiffWrappedFences`
 * and reinjected as a code block inside one diff mark.)
 *
 * Single-line DEL bodies are NOT relocated. A DEL body matching a prefix
 * (e.g. `<DEL>- </DEL>Item`) represents the prefix being REMOVED — the
 * new line is a paragraph, not a list item. Relocating to `- <DEL></DEL>
 * Item` would still parse as a list item and `stripDiffTags` (which
 * strips just the markers, not surrounding text) would leave a phantom
 * `<li>` after accept.
 */
function splitMultilineDiffBlocks(text: string): string {
	let result = text;
	const transform = (
		startMarker: string,
		endMarker: string,
		isAddSide: boolean,
	) => {
		const re = new RegExp(
			`${escapeRegExp(startMarker)}([\\s\\S]*?)${escapeRegExp(endMarker)}`,
			"g",
		);
		const wrapLineContent = (
			line: string,
			inListContext: boolean,
		): string => {
			if (line.trim().length === 0) {
				return "";
			}
			const listMatch = line.match(/^(\s*(?:\d+[.)]|[-*+]))(\s+)(.*)$/);
			if (listMatch) {
				// A deleted item comes from the old text, whose marker padding
				// (`-   `) can be wider than the new text's child indent. One
				// space keeps the children that follow it nested under it, so
				// accepting can hand them to the item before it.
				const padding = isAddSide ? listMatch[2] : " ";
				return `${listMatch[1]}${padding}${startMarker}${listMatch[3]}${endMarker}`;
			}
			const headingMatch = line.match(/^(\s*#{1,6}\s+)(.*)$/);
			if (headingMatch) {
				return `${headingMatch[1]}${startMarker}${headingMatch[2]}${endMarker}`;
			}
			const quoteMatch = line.match(/^(\s*>\s*)(.*)$/);
			if (quoteMatch) {
				return `${quoteMatch[1]}${startMarker}${quoteMatch[2]}${endMarker}`;
			}
			// A separator row carries no diffable content, and a marker in it
			// stops MarkdownIt from recognising the table at all. Leave it bare.
			if (GFM_SEPARATOR_ROW.test(line) && line.includes("|")) {
				return line;
			}
			// Table rows keep their pipes outside the markers, and each cell is
			// wrapped on its own: MarkdownIt parses every cell as a separate
			// inline context, so a marker pair spanning a `|` gets split and
			// leaks as literal text.
			if (GFM_TABLE_ROW.test(line)) {
				const cells = line.split("|");
				return cells
					.map((cell, index) => {
						// First and last are the remainders outside the pipes.
						if (index === 0 || index === cells.length - 1) {
							return cell;
						}
						const content = cell.trim();
						if (!content) {
							return cell;
						}
						const lead = cell.slice(0, cell.indexOf(content));
						const trail = cell.slice(lead.length + content.length);
						return `${lead}${startMarker}${content}${endMarker}${trail}`;
					})
					.join("|");
			}
			// An indented line inside a list is a continuation of its item.
			// Putting the marker in front of the indent makes the line start
			// with marker characters, so MarkdownIt computes indent 0 and
			// hoists the paragraph out of its item; the save then writes it at
			// column zero, permanently detached. Same reasoning as the list,
			// heading and blockquote branches above — the block role lives in
			// the prefix, so the prefix stays outside.
			//
			// Gated on list context on purpose: at top level a four-space
			// indent is an INDENTED CODE BLOCK, so hoisting it there would
			// seal prose in a fence on the next save — the very artifact this
			// repair exists to remove. Outside a list the marker keeps
			// swallowing the indent, which is the pre-existing behaviour.
			const indentMatch = inListContext
				? line.match(/^([ \t]+)(\S.*)$/)
				: null;
			if (indentMatch) {
				return `${indentMatch[1]}${startMarker}${indentMatch[2]}${endMarker}`;
			}
			return `${startMarker}${line}${endMarker}`;
		};
		// A two-space hard break must stay at the very end of the line, after
		// the end marker; inside it MarkdownIt no longer sees the break.
		const wrapLine = (line: string, inListContext = false): string => {
			const hardBreak = /\S {2,}$/.test(line)
				? line.slice(line.trimEnd().length)
				: "";
			return `${wrapLineContent(line.slice(0, line.length - hardBreak.length), inListContext)}${hardBreak}`;
		};

		const insideFenceAt = fenceContextOf(result);
		result = result.replace(re, (match, body: string, offset: number) => {
			// Inside a code block whitespace is content. An added indent
			// (`\n  ` before YAML nesting) is emitted as plain text: wrapped, it
			// is a whitespace-only node TipTap drops, and dropped, the indent is
			// gone from the accepted code.
			const inCode = insideFenceAt(offset);
			const keepCodeWhitespace = (line: string): string | null =>
				inCode && line.trim() === "" ? (isAddSide ? line : "") : null;
			const whitespace = keepCodeWhitespace(body);
			if (whitespace !== null) {
				return whitespace;
			}
			// A fence is not parsed into blocks, so a body inside one needs no
			// per-line split. Splitting it would move each line's newline out
			// of the marker, where it becomes a bare text node the editor's
			// HTML parser drops, joining two lines of code; split deleted
			// lines would also leave their breaks behind as blank lines, and a
			// hoisted `- ` with them.
			if (
				inCode &&
				!body.split("\n").some((line) => FENCE_MARKER.test(line))
			) {
				return match;
			}
			// A continuation only belongs to a list item when a list is
			// actually open — the item may sit before this block or in it.
			const opensList = (candidate: string | undefined): boolean =>
				!!candidate && /^\s*(?:\d+[.)]|[-*+])\s+\S/.test(candidate);
			const continuesBlock = (candidate: string | undefined): boolean =>
				!!candidate && /^[ \t]+\S/.test(candidate);
			const precedingLine = result
				.slice(0, offset)
				.split("\n")
				.reverse()
				.find((candidate) => candidate.trim().length > 0);
			let inListContext =
				opensList(precedingLine) || continuesBlock(precedingLine);

			if (!body.includes("\n")) {
				// A single-line ADD that is nothing but a block prefix
				// (`<ADD>- </ADD>Text`) is the AI changing the line's block role,
				// e.g. paragraph → list item. Hoisting it would leave an empty
				// marker, so the review would show no change while accepting it
				// silently turned the paragraph into a bullet. Leave it wrapped;
				// reconstructBrokenStructureLines then splits the line into a
				// visible old/new pair. Multi-line bodies keep hoisting: there a
				// lone prefix line is usually the word diff re-aligning the
				// prefix of the next, unchanged block.
				if (
					isAddSide &&
					BLOCK_PREFIX_RE.test(body) &&
					body.replace(BLOCK_PREFIX_RE, "").trim() === ""
				) {
					return match;
				}
				return isAddSide ? wrapLine(body, inListContext) : match;
			}

			const lines = body.split("\n");
			const output: string[] = [];
			let inFence = false;
			for (const line of lines) {
				const trimmed = line.trim();
				const whitespace = keepCodeWhitespace(line);
				if (whitespace !== null) {
					output.push(whitespace);
					continue;
				}
				if (trimmed.length > 0) {
					// A list item opens the context; any other unindented
					// line closes it.
					if (opensList(line)) {
						inListContext = true;
					} else if (!continuesBlock(line)) {
						inListContext = false;
					}
				}
				if (isAddSide && inFence) {
					output.push(line);
					if (trimmed === "```") {
						inFence = false;
					}
					continue;
				}
				if (isAddSide && trimmed.startsWith("```")) {
					output.push(line);
					inFence = true;
					continue;
				}
				// A fence delimiter is never wrapped, on either side.
				//
				// The add side skips whole fences above. The delete side has to
				// keep marking the content — that is how an in-fence deletion
				// gets its highlight — but wrapping the ``` line itself puts the
				// marker's zero-width characters in front of the backticks, so
				// the line no longer starts with ``` and MarkdownIt stops
				// recognising it as a fence at all. The block then renders with
				// the opening <del> in one element and its closing tag in the
				// next, and since TipTap parses with the browser's own parser, a
				// block-level tag implicitly closes the open paragraph and pops
				// the unclosed <del> with it. The stray </del> matches nothing,
				// the deleted text ends up carrying no mark, and the accept path
				// has nothing left to strip — so it keeps it, concatenated onto
				// the replacement.
				//
				// Passing the delimiter through leaves the fence intact while
				// the lines inside it still get marked.
				if (trimmed.startsWith("```")) {
					output.push(line);
					continue;
				}
				output.push(wrapLine(line, inListContext));
			}
			return output.join("\n");
		});
	};
	transform(DIFF_ADD_START, DIFF_ADD_END, true);
	transform(DIFF_DEL_START, DIFF_DEL_END, false);
	return result;
}

type LineBlockKind =
	| { kind: "blank" }
	| { kind: "heading"; level: number }
	| { kind: "list"; ordered: boolean }
	| { kind: "blockquote" }
	| { kind: "hr" }
	| { kind: "fence" }
	| { kind: "paragraph" };

function classifyLineBlock(line: string): LineBlockKind {
	const trimmed = line.trim();
	if (trimmed.length === 0) {
		return { kind: "blank" };
	}
	if (
		/^(?:-[ \t]*){3,}$|^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$/.test(trimmed)
	) {
		return { kind: "hr" };
	}
	if (/^(?:```|~~~)/.test(trimmed)) {
		return { kind: "fence" };
	}
	const heading = line.match(/^\s*(#{1,6})\s+\S/);
	if (heading) {
		return { kind: "heading", level: heading[1].length };
	}
	const orderedList = line.match(/^\s*\d+[.)]\s+\S/);
	if (orderedList) {
		return { kind: "list", ordered: true };
	}
	const unorderedList = line.match(/^\s*[-*+]\s+\S/);
	if (unorderedList) {
		return { kind: "list", ordered: false };
	}
	if (/^\s*>\s*/.test(line)) {
		return { kind: "blockquote" };
	}
	return { kind: "paragraph" };
}

function blockKindsEqual(a: LineBlockKind, b: LineBlockKind): boolean {
	if (a.kind !== b.kind) {
		return false;
	}
	if (a.kind === "heading" && b.kind === "heading") {
		return a.level === b.level;
	}
	if (a.kind === "list" && b.kind === "list") {
		return a.ordered === b.ordered;
	}
	return true;
}

const DIFF_ADD_BLOCK_RE = new RegExp(
	`${escapeRegExp(DIFF_ADD_START)}[\\s\\S]*?${escapeRegExp(DIFF_ADD_END)}`,
	"g",
);
const DIFF_DEL_BLOCK_RE = new RegExp(
	`${escapeRegExp(DIFF_DEL_START)}[\\s\\S]*?${escapeRegExp(DIFF_DEL_END)}`,
	"g",
);

function getOldVersionOfLine(line: string): string {
	return line
		.replace(DIFF_ADD_BLOCK_RE, "")
		.replaceAll(DIFF_DEL_START, "")
		.replaceAll(DIFF_DEL_END, "");
}

function getNewVersionOfLine(line: string): string {
	return line
		.replace(DIFF_DEL_BLOCK_RE, "")
		.replaceAll(DIFF_ADD_START, "")
		.replaceAll(DIFF_ADD_END, "");
}

// Without this guard, an inline-only edit like `# <ADD>Title</ADD>` would
// collapse to a bare `# ` on the old side and look like paragraph→heading,
// triggering a needless split that wipes out the inline diff highlight.
function hasContentBeyondPrefix(line: string): boolean {
	const stripped = line
		.replace(/^\s+/, "")
		.replace(/^#{1,6}\s*/, "")
		.replace(/^[-*+]\s*/, "")
		.replace(/^\d+[.)]\s*/, "")
		.replace(/^>\s*/, "");
	return /\S/.test(stripped);
}

/**
 * Block prefixes that carry a line's block role: ordered/unordered list
 * markers, ATX headings and blockquote markers.
 */
const BLOCK_PREFIX_RE = /^(?:\s*(?:\d+[.)]|[-*+])\s+|\s*#{1,6}\s+|\s*>\s*)/;

/**
 * Rebuild `line` so `prefix` sits OUTSIDE any diff marker.
 *
 * A word diff cuts at character level, so renumbering a list item emits
 * `3<DEL>7</DEL><ADD>8</ADD>.  Item` — the marker's digits are split across
 * both bodies and `.` plus its spaces sit outside either one. The raw line
 * then starts with marker characters, MarkdownIt cannot see `NN. `, and the
 * item is parsed as a paragraph; Turndown's defensive ordered-marker escape
 * then saves it as `38\. Item` and the item's indented continuations become
 * a code block.
 *
 * The prefix is emitted plain, so a pure renumber carries no highlight. That
 * is deliberate and costs nothing: a list marker is not content — it is
 * re-derived from `<ol start>` and item position on every serialization, so
 * marking it changed is meaningless, while leaving it split costs the line
 * its block role. Same trade-off the HR branch makes.
 *
 * Returns `null` whenever the two sides disagree about the prefix, so the
 * caller falls back to today's behaviour rather than guessing.
 */
function hoistBlockPrefixOutOfMarkers(
	line: string,
	prefix: string,
): string | null {
	const markers = [
		DIFF_ADD_START,
		DIFF_ADD_END,
		DIFF_DEL_START,
		DIFF_DEL_END,
	];
	let index = 0;
	let consumed = 0;
	let inDel = false;
	let openAdd = false;
	let skippedDel = "";

	while (index < line.length && consumed < prefix.length) {
		const marker = markers.find((candidate) =>
			line.startsWith(candidate, index),
		);
		if (marker) {
			if (marker === DIFF_DEL_START) {
				inDel = true;
			} else if (marker === DIFF_DEL_END) {
				inDel = false;
			} else if (marker === DIFF_ADD_START) {
				openAdd = true;
			} else {
				openAdd = false;
			}
			index += marker.length;
			continue;
		}
		if (inDel) {
			// Deleted text is not part of the new version of the line,
			// but remember it: dropping the OLD marker is intended, while
			// dropping a deleted WORD would erase it from the review view.
			skippedDel += line[index];
			index += 1;
			continue;
		}
		if (line[index] !== prefix[consumed]) {
			return null;
		}
		index += 1;
		consumed += 1;
	}

	if (consumed < prefix.length || inDel) {
		return null;
	}
	// Only marker-shaped debris may be dropped. Anything else means the
	// deletion spans real content (e.g. `37) Old` -> `38. New`), so bail
	// out and let the caller fall back to a whole-line DEL/ADD split
	// that keeps the removed words visible.
	if (/[^\d.)\s\-*+#>]/.test(skippedDel)) {
		return null;
	}
	// Re-open a still-open ADD span on the tail so it is not orphaned.
	return `${prefix}${openAdd ? DIFF_ADD_START : ""}${line.slice(index)}`;
}

/**
 * Repair lines where DIFF markers leave the line in a shape MarkdownIt
 * misparses. Two patterns:
 *
 * 1. Markers split a block prefix across DEL+ADD bodies — e.g. `## Title`
 *    → `### Title` produces `<DEL>##</DEL><ADD>###</ADD> Title`, which
 *    `wrapLine` can't fix because neither marker's body holds a complete
 *    prefix.
 *
 * 2. DEL and ADD on one line cross a block boundary — e.g. an AI replacing
 *    a paragraph with a heading produces `<DEL>old para</DEL># <ADD>title</ADD>`
 *    after `splitMultilineDiffBlocks`. The line begins with marker chars,
 *    not `# `, so MarkdownIt parses it as a paragraph and Turndown's
 *    defensive `^# ` escape demotes the heading to `\#` on save.
 *
 * Both patterns are split into a whole-line `<DEL>old</DEL>\n<ADD>new</ADD>`
 * pair so a follow-up `splitMultilineDiffBlocks` pass can wrap each side as
 * the right block element.
 *
 * HRs are special-cased: they have no inline content to host diff markers,
 * so the new HR is emitted plain (no highlight) and the removed HR is
 * dropped. Less visual fidelity, but better than a literal `---` paragraph.
 */
function reconstructBrokenStructureLines(text: string): string {
	if (!text.includes(DIFF_ADD_START) && !text.includes(DIFF_DEL_START)) {
		return text;
	}
	const stripAllMarkers = (line: string): string =>
		line
			.replaceAll(DIFF_ADD_START, "")
			.replaceAll(DIFF_ADD_END, "")
			.replaceAll(DIFF_DEL_START, "")
			.replaceAll(DIFF_DEL_END, "");

	const output: string[] = [];
	// Consecutive split lines are emitted as one run — every old line, then
	// every new line. Interleaving them would put an old line straight after
	// a new list item, where MarkdownIt reads it as a lazy continuation of
	// that item instead of part of the deleted paragraph.
	const splitOld: string[] = [];
	const splitNew: string[] = [];
	const flushSplit = () => {
		if (splitOld.length === 0) {
			return;
		}
		output.push(
			...splitOld.map((old) => `${DIFF_DEL_START}${old}${DIFF_DEL_END}`),
		);
		// Only `1.` may interrupt a paragraph in CommonMark, so an ordered
		// item numbered anything else would be absorbed into the preceding
		// DEL line and lose its list role. A blank line keeps the two sides
		// as separate blocks. Headings need no such break.
		if (/^\s*(?:0|[2-9]|\d{2,})[.)]\s/.test(splitNew[0])) {
			output.push("");
		}
		output.push(
			...splitNew.map(
				(next) => `${DIFF_ADD_START}${next}${DIFF_ADD_END}`,
			),
		);
		splitOld.length = 0;
		splitNew.length = 0;
	};
	const emit = (...lines: string[]) => {
		flushSplit();
		output.push(...lines);
	};
	// Inside a fence every line is code: a `- ` the AI added there is text,
	// not a paragraph turning into a list item.
	let inFence = false;
	for (const line of text.split("\n")) {
		if (/^\s*(?:```|~~~)/.test(stripAllMarkers(line))) {
			inFence = !inFence;
			emit(line);
			continue;
		}
		const hasAdd = line.includes(DIFF_ADD_START);
		const hasDel = line.includes(DIFF_DEL_START);
		if (inFence || (!hasAdd && !hasDel)) {
			emit(line);
			continue;
		}
		// Fast path: markers sit inline within an already-recognised block
		// (`Hello <ADD>world</ADD>`, `### <ADD>title</ADD>`). Skip when DEL
		// and ADD coexist on one line — that shape often crosses a block
		// boundary (pattern 2 in docstring), and stripping markers
		// concatenates DEL into the new prefix, masking the kind change.
		const lineHasBothMarkers = hasAdd && hasDel;
		if (
			!lineHasBothMarkers &&
			blockKindsEqual(
				classifyLineBlock(stripAllMarkers(line)),
				classifyLineBlock(line),
			)
		) {
			emit(line);
			continue;
		}
		const oldLine = getOldVersionOfLine(line);
		const newLine = getNewVersionOfLine(line);
		if (oldLine === newLine) {
			emit(line);
			continue;
		}
		const oldKind = classifyLineBlock(oldLine);
		const newKind = classifyLineBlock(newLine);
		if (newKind.kind === "hr" || oldKind.kind === "hr") {
			flushSplit();
			if (oldKind.kind !== "hr" && hasContentBeyondPrefix(oldLine)) {
				output.push(`${DIFF_DEL_START}${oldLine}${DIFF_DEL_END}`);
			}
			if (newKind.kind === "hr") {
				output.push(newLine);
			} else if (hasContentBeyondPrefix(newLine)) {
				output.push(`${DIFF_ADD_START}${newLine}${DIFF_ADD_END}`);
			}
			continue;
		}
		if (blockKindsEqual(oldKind, newKind)) {
			// Both sides agree on the block kind, but the RAW line can still
			// have lost its block shape to the markers themselves — a
			// renumbered list item arrives as `3<DEL>7</DEL><ADD>8</ADD>.
			// Item`, which MarkdownIt parses as a paragraph. Lift the prefix
			// out of the markers so the block survives the round trip.
			if (
				classifyLineBlock(line).kind === "paragraph" &&
				newKind.kind !== "paragraph"
			) {
				const prefix = newLine.match(BLOCK_PREFIX_RE)?.[0];
				const hoisted = prefix
					? hoistBlockPrefixOutOfMarkers(line, prefix)
					: null;
				if (hoisted !== null) {
					emit(hoisted);
					continue;
				}
				// Not hoistable — fall through to the whole-line split
				// below, which renders both sides without losing the
				// deleted text.
			} else {
				emit(line);
				continue;
			}
		}
		// Skip when only inline content changed inside an unchanged prefix —
		// stripping ADD content leaves a bare `# ` that misclassifies as
		// paragraph and would trigger a useless split.
		if (
			!hasContentBeyondPrefix(oldLine) ||
			!hasContentBeyondPrefix(newLine)
		) {
			emit(line);
			continue;
		}
		splitOld.push(oldLine);
		splitNew.push(newLine);
	}
	flushSplit();
	return output.join("\n");
}

/**
 * Normalize HTML tables for TipTap compatibility
 *
 * MarkdownIt produces tables with <thead> and <tbody> wrapper elements:
 * <table><thead><tr><th>...</th></tr></thead><tbody><tr><td>...</td></tr></tbody></table>
 *
 * But TipTap's Table extension expects a flat structure:
 * <table><tr><th>...</th></tr><tr><td>...</td></tr></table>
 *
 * This function strips the wrapper elements while preserving the table content.
 */
function normalizeTables(html: string): string {
	// Remove <thead> and </thead> tags but keep content
	let result = html.replace(/<thead[^>]*>/gi, "");
	result = result.replace(/<\/thead>/gi, "");

	// Remove <tbody> and </tbody> tags but keep content
	result = result.replace(/<tbody[^>]*>/gi, "");
	result = result.replace(/<\/tbody>/gi, "");

	return result;
}

// ============================================
// Markdown Processing Functions
// ============================================

const ESCAPED_BULLET_LINE = /^(\s*)\\([-*+])(\s+)/;
const LIST_ITEM_LINE = /^\s*(?:[-*+]|\d{1,9}[.)])\s/;
const ATX_HEADING_LINE = /^ {0,3}#{1,6}(?:\s|$)/;
// A backslash hard break is an odd run of trailing backslashes; an even run
// is escaped literal backslashes.
const HARD_BREAK_LINE_END = /(?:^|[^\\])(?:\\\\)*\\$| {2,}$/;

/**
 * Turn an escaped bullet (`\- Item`) that AI output produced back into a list
 * marker, but only where a list can start: the top of the document, after a
 * blank line or heading, or after a list item that does not end in a hard
 * break. A `\- ` line that continues a paragraph is literal text after a hard
 * break, which the editor's serializer escapes on purpose; unescaping it there
 * turned the user's hyphen into a bullet on every load.
 */
function unescapeBlockStartBullets(text: string): string {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const previous = i === 0 ? "" : lines[i - 1].replace(/\r$/, "");
		const startsBlock =
			previous.trim() === "" ||
			ATX_HEADING_LINE.test(previous) ||
			(LIST_ITEM_LINE.test(previous) &&
				!HARD_BREAK_LINE_END.test(previous));
		if (startsBlock) {
			lines[i] = lines[i].replace(ESCAPED_BULLET_LINE, "$1$2$3");
		}
	}
	return lines.join("\n");
}

/**
 * Fix common markdown issues from AI generation.
 *
 * AI models sometimes escape backticks incorrectly or have formatting issues.
 * This preprocessor fixes common problems before passing to MarkdownIt.
 *
 * Also handles diff markers that can break block-level structures like tables.
 */
/** `>` markers and spaces only: the start of a line inside a blockquote. */
const BLOCKQUOTE_LINE_PREFIX = /^[ \t]*>[ \t>]*$/;

/**
 * Whether the ``` fence at `fenceIndex` of `text` sits inside a blockquote —
 * only `>` markers and spaces before it on its line. The fence opens or
 * closes a code block in the quote; moving it to a line of its own took it
 * out of the quote, and the quoted block loaded as a code block whose lines
 * began with `>` (Fizzy #2946).
 */
function fenceIsInBlockquote(text: string, fenceIndex: number): boolean {
	const lineStart = text.lastIndexOf("\n", fenceIndex - 1) + 1;
	return BLOCKQUOTE_LINE_PREFIX.test(text.slice(lineStart, fenceIndex));
}

function fixAIMarkdownIssues(text: string): string {
	let fixed = text;

	// Legacy bug bodies used bare ``` or ```text fences for CI output. The
	// generic document repair below intentionally unwraps text fences that hold
	// document structure, which makes CI lines such as `# heading` and `![…]`
	// live editor content. Convert only the known bug-body section to a tilde
	// fence before those repairs; MarkdownIt treats it as code and the generic
	// backtick-fence heuristics leave it alone. The closing fence must precede
	// the bug footer or the document end; CI output may contain fence lines.
	fixed = fixed.replace(
		/(^[ \t]*What CI reported:[ \t]*\r?\n(?:[ \t]*\r?\n)?)(`{3,})(?:(?:plaintext|text|txt)[ \t]*)?\r?\n([\s\S]*)\r?\n\2[ \t]*(?=\r?\n(?:[ \t]*\r?\n)?[ \t]*(?:Promoted from QA finding\b|Opened automatically from a pipeline result\b)|(?:\r?\n[ \t]*)*(?![\s\S]))/gim,
		(_match, prefix: string, _delimiter: string, content: string) => {
			const longestTildeRun = Math.max(
				0,
				...Array.from(content.matchAll(/~+/g), (run) => run[0].length),
			);
			const fence = "~".repeat(Math.max(3, longestTildeRun + 1));
			return `${prefix}${fence}text\n${content}\n${fence}`;
		},
	);

	const looksLikeStructuredMarkdown = (content: string): boolean => {
		const trimmed = content.trim();
		if (!trimmed) {
			return false;
		}

		return /^(#{1,6}\s|\*\*[^*]+\*\*|-\s|\d+\.\s|[A-Z][A-Za-z /-]+:)/m.test(
			trimmed,
		);
	};

	const looksLikeStructuredLine = (line: string | undefined): boolean => {
		if (!line) {
			return false;
		}
		const trimmed = line.trim();
		if (!trimmed) {
			return false;
		}

		return /^(#{1,6}\s|-\s|`(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+\/|\*\*[^*]+\*\*|[A-Z][A-Za-z /-]+:)/.test(
			trimmed,
		);
	};

	// Signals that a line belongs to real code rather than prose. Used only by
	// the spurious-fence-pair classifier below: a single hit anywhere in a
	// fence body vetoes unwrapping the whole block, so a genuine code fence is
	// never turned back into paragraphs.
	const CODE_LINE_SIGNALS = [
		/^\s{2,}\S/,
		/[{};=<>|\\]/,
		/^\s*(?:\/\/|\/\*|#|--|<!--|\?>|<\?)/,
		/\w+\s*\(/,
		/^\s*[\w.$-]+\s*:\s*\S/,
		/^\s*[-+]{3}|^\s*@@/,
		/https?:\/\//,
		/\|/,
		/`/,
		/\b(?:function|const|let|var|import|export|class|def|return|SELECT|FROM|WHERE|INSERT|npm|pnpm|yarn|git|curl|docker)\b/,
	];

	// Sentence-shaped prose that a prior save sealed into a bare fence — e.g.
	// the WHEN/THEN half of an acceptance criterion whose list item lost its
	// marker, leaving its indented continuation to parse as a code block.
	const looksLikeReclaimableProse = (line: string): boolean => {
		const trimmed = line.trim();
		if (!trimmed || !/^[A-Za-z]/.test(trimmed)) {
			return false;
		}
		if (CODE_LINE_SIGNALS.some((signal) => signal.test(line))) {
			return false;
		}
		return trimmed.split(/\s+/).length >= 5;
	};

	const normalizeMalformedCodeFences = (source: string): string => {
		const lines = source.split("\n");
		const output: string[] = [];
		let inFence = false;
		let fenceDelimiter = "```";
		let fenceLanguage = "";
		let fenceBody: string[] = [];

		/**
		 * `isTrailing` marks the final flush after the loop, i.e. a fence the
		 * document never closed. Only there is dropping the block correct: a
		 * bare opener with nothing after it carries no content, and emitting
		 * the pair anyway manufactures an empty ``` ``` block that renders as
		 * a stray grey box and that the spurious-pair pass cannot remove.
		 *
		 * A CLOSED empty fence is left alone here — a language-tagged one is
		 * author intent, and the classifier below removes a closed empty BARE
		 * pair. The `fenceLanguage` guard also matters for the bare case: the
		 * language-sniff branch moves a single-token body into `fenceLanguage`,
		 * so dropping on an empty `fenceBody` alone would delete that token.
		 */
		const flushFence = (isTrailing = false) => {
			if (!inFence) {
				return;
			}
			if (
				isTrailing &&
				!fenceLanguage &&
				fenceBody.every((bodyLine) => bodyLine.trim().length === 0)
			) {
				inFence = false;
				fenceDelimiter = "```";
				fenceLanguage = "";
				fenceBody = [];
				return;
			}
			output.push(`${fenceDelimiter}${fenceLanguage}`.trimEnd());
			output.push(...fenceBody);
			output.push(fenceDelimiter);
			inFence = false;
			fenceDelimiter = "```";
			fenceLanguage = "";
			fenceBody = [];
		};

		for (const line of lines) {
			const trimmed = line.trim();

			const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
			if (!inFence && fenceMatch) {
				inFence = true;
				fenceDelimiter = fenceMatch[1];
				// Written back as spelled: a lowercased ```Cards loaded as
				// ```cards, and the next save changed the body unedited
				// (Fizzy #2946). Compared lowercased below.
				fenceLanguage = fenceMatch[2].trim();
				fenceBody = [];
				continue;
			}

			if (inFence && trimmed === fenceDelimiter) {
				flushFence();
				continue;
			}

			if (inFence) {
				if (
					!fenceLanguage &&
					fenceBody.length === 0 &&
					/^[a-z0-9_+-]+$/i.test(trimmed)
				) {
					fenceLanguage = trimmed;
					continue;
				}

				const languageKey = fenceLanguage.toLowerCase();
				const jsonLikeFence =
					languageKey === "json" ||
					languageKey === "plaintext" ||
					languageKey === "text" ||
					languageKey === "txt";
				const lastNonEmptyFenceLine = [...fenceBody]
					.reverse()
					.find((candidate) => candidate.trim().length > 0);
				const fenceContainsStructuredPayload = fenceBody.some(
					(candidate) =>
						/^(\{.*\}|\[.*\]|[A-Za-z0-9_-]+:\s+.+|https?:\/\/\S+|Authorization:)/.test(
							candidate.trim(),
						),
				);
				const previousLooksLikePayload =
					!!lastNonEmptyFenceLine &&
					/^(\{.*\}|\[.*\]|[A-Za-z0-9_-]+:\s+.+|https?:\/\/\S+|Authorization:)/.test(
						lastNonEmptyFenceLine.trim(),
					);

				if (
					fenceDelimiter === "```" &&
					jsonLikeFence &&
					looksLikeStructuredLine(line) &&
					(previousLooksLikePayload || fenceContainsStructuredPayload)
				) {
					flushFence();
					output.push(line);
					continue;
				}

				fenceBody.push(line);
				continue;
			}

			output.push(line);
		}

		flushFence(true);
		return output.join("\n");
	};

	const normalizeCollapsedTables = (source: string): string => {
		const lines = source.split("\n");
		let inFence = false;

		return lines
			.map((line) => {
				const trimmed = line.trim();

				if (trimmed.startsWith("```")) {
					inFence = !inFence;
					return line;
				}

				if (inFence) {
					return line;
				}

				if (!/\|\s*:?-{3,}/.test(trimmed) || !/\|\s*\|/.test(trimmed)) {
					return line;
				}

				// A collapsed table often arrives glued to the prose that
				// preceded it in the same paragraph. Split the prose back onto
				// its own line and reconstruct only the table part.
				const tableStart = trimmed.indexOf("|");
				if (tableStart === -1) {
					return line;
				}
				const prose = trimmed.slice(0, tableStart).trim();
				const tablePart = trimmed.slice(tableStart);

				// The separator run is the anchor: it tells us how many columns
				// the table has, which is the only reliable way to split the
				// cell stream back into rows. Counting empty tokens as row
				// boundaries (the previous approach) mis-splits any table with
				// an empty cell — exactly what a half-filled matrix looks like.
				const separatorRun = tablePart.match(
					/\|(?:\s*:?-{3,}:?\s*\|)+/,
				)?.[0];
				if (!separatorRun) {
					return line;
				}
				const columnCount = separatorRun.split("|").slice(1, -1).length;
				if (columnCount < 1) {
					return line;
				}

				// Splitting the whole run on `|` yields the cells plus exactly
				// one empty token where each row abuts the next. Walking it
				// column-count cells at a time keeps empty cells (which look
				// identical to a row boundary) in the row they belong to.
				const tokens = tablePart
					.split("|")
					.map((token) => token.trim());
				if (tokens[0] === "") {
					tokens.shift();
				}
				if (tokens.at(-1) === "") {
					tokens.pop();
				}

				const rows: string[][] = [];
				let cursor = 0;
				while (cursor < tokens.length) {
					const row = tokens.slice(cursor, cursor + columnCount);
					if (row.length !== columnCount) {
						return line;
					}
					rows.push(row);
					cursor += columnCount;
					if (cursor < tokens.length) {
						// The token between two rows must be the empty remainder
						// of the row boundary. Anything else means our column
						// count is wrong and rebuilding would scramble the data.
						if (tokens[cursor] !== "") {
							return line;
						}
						cursor += 1;
					}
				}

				// Header + separator; body rows optional. A header-only table is
				// valid GFM, and the separator run we anchored on above is
				// enough evidence to rebuild it safely.
				if (rows.length < 2) {
					return line;
				}

				const isSeparatorRow = rows[1].every((cell) =>
					/^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")),
				);
				if (!isSeparatorRow) {
					return line;
				}

				const rebuilt = rows
					.map((row) => `| ${row.join(" | ")} |`)
					.join("\n");

				return prose ? `${prose}\n\n${rebuilt}` : rebuilt;
			})
			.join("\n");
	};

	// Unwrap fenced markdown blocks so document structure renders as headings/lists
	// instead of nested code blocks. This is common when the model returns
	// sections like ```markdown ... ``` inside an otherwise markdown document.
	fixed = fixed.replace(
		/(?<!`)```(?!`)(?:md|markdown|mdx)\s*\n([\s\S]*?)\n```/gi,
		(_match, content: string) => `\n${content.trim()}\n`,
	);

	// Some documents wrap ordinary prose or headings in ```plaintext fences.
	// If the content clearly looks like document structure rather than literal code,
	// unwrap it so existing documents render as content instead of blue code panels.
	fixed = fixed.replace(
		/(?<!`)```(?!`)(?:plaintext|text|txt)\s*\n([\s\S]*?)\n```/gi,
		(match: string, content: string) =>
			looksLikeStructuredMarkdown(content)
				? `\n${content.trim()}\n`
				: match,
	);

	// Fix escaped backticks in code fences
	// Pattern: \`\`\` or \` followed by language -> should be ```
	// This handles cases where AI escapes backticks unnecessarily
	fixed = fixed.replace(/\\`\\`\\`/g, "```");
	fixed = fixed.replace(/\\`/g, "`");

	fixed = unescapeBlockStartBullets(fixed);

	// Fix mermaid code blocks that might have issues
	// Some AI models output "```mermaid" without proper spacing
	fixed = fixed.replace(
		/```(mermaid|c4context|c4container|c4component|c4deployment|flowchart|sequenceDiagram|classDiagram|erDiagram|gantt|pie|mindmap|graph\s+[TL][BDRB])/gi,
		(match: string, _language: string, offset: number, whole: string) =>
			fenceIsInBlockquote(whole, offset) ? match : `\n${match}`,
	);

	// Ensure code blocks have newlines before them
	fixed = fixed.replace(
		/([^\n`])```(?!`)/g,
		(match: string, before: string, offset: number, whole: string) =>
			fenceIsInBlockquote(whole, offset + 1)
				? match
				: `${before}\n\`\`\``,
	);

	// Ensure code blocks have newlines after closing fence
	fixed = fixed.replace(
		/(?<!`)```(?!`)(?![a-zA-Z0-9_+-]*\r?\n)([^\n])/g,
		"```\n$1",
	);

	// Repair malformed fenced blocks where the model starts a code block but then
	// continues with ordinary document structure without closing it.
	fixed = normalizeMalformedCodeFences(fixed);

	// Close unclosed payload fences when normal markdown structure resumes.
	// This catches cases like:
	// ```json
	// { ... }
	// Descriptive prose
	//
	// ## Next Section
	//
	// The body uses a negative lookahead `(?!```)` so we only match fences that
	// are still UNCLOSED. Without this, the regex would re-close fences that
	// `normalizeMalformedCodeFences` already handled, injecting a spurious opening
	// fence before the heading and swallowing the rest of the document into a new
	// (unclosed) code block.
	fixed = fixed.replace(
		/(?<!`)```(?!`)(?:\s*\n)?(json|plaintext|text|txt)\s*\n((?:(?!```)[\s\S])*?)(\n(?:#{1,6}\s|[-*+]\s|\d+\.\s))/gi,
		(_match, language: string, body: string, nextBlockStart: string) =>
			`\`\`\`${language}\n${body.trimEnd()}\n\`\`\`\n${nextBlockStart.trimStart()}`,
	);

	// Repair tables that were collapsed onto a single line by the model or a prior save.
	fixed = normalizeCollapsedTables(fixed);

	// Repair table separator rows corrupted by typographer or Turndown escaping.
	// Em-dashes (—) and en-dashes (–) in separator rows break MarkdownIt table parsing.
	// Backslash-escaped dashes (\-) from Turndown also break separator recognition.
	fixed = fixed
		.split("\n")
		.map((line) => {
			const trimmed = line.trim();
			// Match lines that look like table separators: only pipes, dashes, colons,
			// spaces, em-dashes, en-dashes, and optional backslash escapes
			if (
				/^\|[\s:|\-\u2013\u2014\\]+\|?\s*$/.test(trimmed) &&
				/[-\u2013\u2014]/.test(trimmed)
			) {
				return line
					.replace(/\u2014/g, "-")
					.replace(/\u2013/g, "-")
					.replace(/\\-/g, "-");
			}
			return line;
		})
		.join("\n");

	// Normalize inline JSON examples like:
	// json {"field":"value"}
	// into proper fenced code blocks so they render cleanly.
	fixed = fixed.replace(
		/^(json)\s+(\{.*\}|\[.*\])\s*$/gim,
		(_match, _label, body: string) =>
			`\n\`\`\`json\n${body.trim()}\n\`\`\`\n`,
	);

	// Normalize collapsed endpoint summaries like:
	// plaintext GET /api/users POST /api/auth/login PUT /api/user/:id
	// into a readable list for previously generated documents.
	fixed = fixed.replace(
		/^(?:plaintext\s+)?((?:(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+\/\S+\s*){2,})$/gim,
		(_match, endpoints: string) => {
			const items = Array.from(
				endpoints.matchAll(
					/\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\/\S+)/g,
				),
			).map(([, method, path]) => `- \`${method} ${path}\``);

			return `\n${items.join("\n")}\n`;
		},
	);

	// Normalize endpoint bullets so they render as normal text rather than inline-code chips.
	fixed = fixed.replace(
		/^(\s*[-*+]\s+)`((?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+\/[^`]+)`$/gim,
		"$1$2",
	);

	// Drop the backslash from an escaped numbered marker at the start of a
	// line — both `## 4\. API Specifications` and a bare `38\. GIVEN …`.
	// Turndown only escapes at the START of a text node, so this shape at
	// line start is always a heading or list item that lost its block role
	// upstream, never a sentence a user meant to begin with `2024\. `.
	// Fenced blocks are skipped: there the backslash is literal text.
	if (fixed.includes("\\.")) {
		// Track WHICH delimiter opened the fence: a ``` block is only
		// closed by ```, so a ~~~ line inside it is content, not a toggle.
		let openFenceDelimiter: string | null = null;
		fixed = fixed
			.split("\n")
			.map((line) => {
				const trimmed = line.trim();
				const delimiter = trimmed.startsWith("```")
					? "```"
					: trimmed.startsWith("~~~")
						? "~~~"
						: null;
				if (delimiter) {
					if (openFenceDelimiter === null) {
						openFenceDelimiter = delimiter;
					} else if (openFenceDelimiter === delimiter) {
						openFenceDelimiter = null;
					}
					return line;
				}
				if (openFenceDelimiter !== null) {
					return line;
				}
				// The heading group is optional-but-anchored rather than
				// `#{0,6}\\s*`, which would let the trailing `\\s*` swallow
				// unlimited indent and defeat the three-space cap that keeps
				// indented code blocks out of scope.
				return line.replace(
					/^(\s{0,3})((?:#{1,6}\s+)?)(\d{1,9})\\\.(\s+)/,
					"$1$2$3.$4",
				);
			})
			.join("\n");
	}

	// Remove stray fence markers left behind between normal markdown blocks, and
	// strip "spurious pairs" where a prior save wrapped pure markdown structure
	// in `` ``` ``. Genuine code blocks (JSON, shell, etc.) are preserved.
	// Skipped entirely for documents that contain no fences.
	if (fixed.includes("```")) {
		const lines = fixed.split("\n");

		// Single walk: pair openers with bare closers and classify each pair as
		// spurious (body is mostly markdown structure) or genuine in one pass.
		// `spuriousFenceIndices` collects both opener and closer indices that
		// should be dropped; `pairedFenceIndices` collects every fence line that
		// belongs to ANY completed pair, so the orphan-neighbor check below can
		// skip them.
		const spuriousFenceIndices = new Set<number>();
		const pairedFenceIndices = new Set<number>();
		let pendingOpener: number | null = null;
		let pendingDelimiter: string | null = null;
		// Only bare ``` openers are subject to the spurious-pair heuristic.
		// Language-tagged fences (```bash, ```json, etc.) are explicit author
		// intent that the body is code, regardless of how the lines look. The
		// filter pass below only drops bare ``` lines, so misclassifying a
		// language opener as spurious would silently drop the closer and leave
		// the opener behind, swallowing the rest of the document.
		let pendingOpenerIsBare = false;
		let bodyNonEmpty = 0;
		let bodyStructured = 0;
		let bodyProse = 0;
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			const fenceMatch = trimmed.match(/^(`{3,})(.*)$/);
			if (!fenceMatch) {
				if (pendingOpener !== null && trimmed.length > 0) {
					bodyNonEmpty++;
					if (looksLikeStructuredLine(lines[i])) {
						bodyStructured++;
					}
					if (looksLikeReclaimableProse(lines[i])) {
						bodyProse++;
					}
				}
				continue;
			}
			if (pendingOpener === null) {
				pendingOpener = i;
				pendingDelimiter = fenceMatch[1];
				pendingOpenerIsBare = trimmed === pendingDelimiter;
				bodyNonEmpty = 0;
				bodyStructured = 0;
				bodyProse = 0;
				continue;
			}
			if (
				fenceMatch[1] === pendingDelimiter &&
				fenceMatch[2].length === 0
			) {
				pairedFenceIndices.add(pendingOpener);
				pairedFenceIndices.add(i);
				if (
					pendingOpenerIsBare &&
					// A CLOSED empty bare pair carries no information at
					// all. (Unclosed ones never reach here — flushFence drops
					// them — so do not delete this as unreachable.)
					(bodyNonEmpty === 0 ||
						(bodyNonEmpty > 0 &&
							// Mostly markdown structure — the original rule.
							(bodyStructured * 2 > bodyNonEmpty ||
								// Or every single line is plain prose. Requiring
								// ALL lines (not a majority) is what makes
								// reclaiming sentences safe: one code-shaped line
								// keeps the whole fence.
								bodyProse === bodyNonEmpty)))
				) {
					spuriousFenceIndices.add(pendingOpener);
					spuriousFenceIndices.add(i);
				}
				pendingOpener = null;
				pendingDelimiter = null;
			}
			// A second opener while one is pending is ignored (malformed input —
			// the old opener stays pending until a bare ``` closer arrives).
		}

		fixed = lines
			.filter((line, index) => {
				if (line.trim() !== "```") {
					return true;
				}
				// Spurious pair: drop both opener and closer.
				if (spuriousFenceIndices.has(index)) {
					return false;
				}
				// Genuine pair: keep, even if surrounded by structured content
				// (code blocks legitimately sit between headings and lists).
				if (pairedFenceIndices.has(index)) {
					return true;
				}
				// Orphan ``` line: drop only if a neighbor looks like markdown
				// structure (the code block was already normalized away).
				const prevNonEmpty = [...lines.slice(0, index)]
					.reverse()
					.find((candidate) => candidate.trim().length > 0);
				const nextNonEmpty = lines
					.slice(index + 1)
					.find((candidate) => candidate.trim().length > 0);
				return !(
					looksLikeStructuredLine(prevNonEmpty) ||
					looksLikeStructuredLine(nextNonEmpty)
				);
			})
			.join("\n");
	}

	// Lift diff markers back out of table rows: off the leading pipe (MarkdownIt
	// needs `|` to start the line to see a row) and out of separator rows
	// entirely. This used to be two regexes spelled out inline here; both were
	// dead \u2014 they matched a ZWSP where the marker constants carry an NBSP, so
	// neither ever fired. `fromMarkdown` needs the same repair several phases
	// earlier anyway, so there is one implementation now and no copy to drift.
	fixed = sanitizeTableMarkerPlacement(fixed);

	return fixed;
}

const BULLET_PATTERN = /^(\s*)([-*+]|\d+\.)\s+(\S.*)$/;
// Detects any of the 4 diff marker tokens (DIFF_ADD_START / _END /
// DIFF_DEL_START / _END). All four are wrapped by U+200B (ZWSP) on both
// sides of the inner ADD_/DEL_ token, so a single regex anchored by ZWSP
// catches all of them in one scan.
const ANY_DIFF_MARKER = /\u200B(?:ADD|DEL)_(?:START|END)\u200B/;

const startsWithStructuralBlock = (line: string): boolean =>
	/^#{1,6}\s|^>\s?|^```/.test(line.trimStart());

const looksLikeContinuation = (s: string): boolean =>
	/^[a-z(["'.,;:?!\]]/.test(s);

const endsSentence = (s: string): boolean => /[.!?]["')\]]?$/.test(s.trimEnd());

const endsEnumeration = (s: string): boolean =>
	/[,;]["')\]]?$/.test(s.trimEnd());

const countDoubleStars = (s: string): number => (s.match(/\*\*/g) || []).length;

// Count UNESCAPED backticks. `\\\`` is a literal backtick character
// (turndown's escape) and isn't an inline-code delimiter, so it shouldn't
// count toward the balance check.
const countSingleBackticks = (s: string): number => {
	let count = 0;
	for (let k = 0; k < s.length; k++) {
		if (s[k] === "`" && (k === 0 || s[k - 1] !== "\\")) {
			count++;
		}
	}
	return count;
};

type SplitMarkupKind = "bold" | "code" | null;

const detectSplitMarkup = (a: string, b: string): SplitMarkupKind => {
	if (countDoubleStars(a) % 2 === 1 && countDoubleStars(b) % 2 === 1) {
		return "bold";
	}
	if (
		countSingleBackticks(a) % 2 === 1 &&
		countSingleBackticks(b) % 2 === 1
	) {
		return "code";
	}
	return null;
};

const wordCount = (s: string): number =>
	s
		.trim()
		.split(/\s+/)
		.filter((w) => w.length > 0).length;

// When rejoining a split markup span, pick " " for a genuine word boundary
// and "" for a mid-token split. Mid-token is signaled by the fragment starting
// with a non-word char (`/file`, `).`) OR the body ending with a "sticky" char
// that binds to the next token: path separators (`/`, `\`), hyphenated/snake
// words (`-`, `_`), or opening brackets. Sentence punctuation (`,`, `;`, `:`,
// `.`) is NOT sticky — `important,` + `and urgent` rejoins with a space.
//
// Inline-code spans add an identifier heuristic: when both adjacent chars are
// word chars, an UPPERCASE or DIGIT fragment start is treated as an identifier
// boundary (`getUser` + `ById` → `getUserById`; `sha` + `256` → `sha256`;
// `gpt` + `4o` → `gpt4o`), and a lowercase fragment start is treated as a
// multi-word command (`pnpm` + `install` → `pnpm install`, with space). Code
// spans also preserve the space before CLI flags:
//   - GNU long flags (`--filter`, `--save-dev`) → always space.
//   - Short flags `-X` where X is one alnum char terminated by end of string
//     or a non-word non-`-` char like space or `` ` `` (`node` + `-v`,
//     `git` + `-C repo`) → space.
//   - Combined short flags `-XYZ` followed by INTERNAL whitespace, signaling
//     an argument follows (`git` + `-am msg`, `tar` + `-rf archive`) → space.
// Multi-char `-XYZ` with no internal whitespace is left to concat because
// that's the shape of hyphenated package names (`tailwind-merge`, `date-fns`,
// `package-json`, `lodash-es`) — exact install strings that must be
// preserved. Bold prose always inserts a space at word-word boundaries since
// natural language doesn't use camelCase.
const STICKY_BODY_END = /[/_\-\\([{]/;
const SHORT_CLI_FLAG = /^-(?:[a-zA-Z0-9](?:$|[^\w-])|[a-zA-Z0-9]+\s)/;
const joinSepForSplitMarkup = (
	kind: SplitMarkupKind,
	body: string,
	fragment: string,
): string => {
	const fragStart = fragment.charAt(0);
	const bodyEnd = body.slice(-1);
	if (kind === "code" && /\w/.test(bodyEnd)) {
		if (fragment.startsWith("--")) {
			return " ";
		}
		if (SHORT_CLI_FLAG.test(fragment)) {
			return " ";
		}
	}
	if (!/\w/.test(fragStart)) {
		return "";
	}
	if (STICKY_BODY_END.test(bodyEnd)) {
		return "";
	}
	if (kind === "code") {
		// Identifier split (camelCase or digit suffix like `sha256`, `h1`,
		// `gpt4o`) — no space.
		if (/[A-Z0-9]/.test(fragStart)) {
			return "";
		}
		// Lowercase fragment after a word-char body end → multi-word command.
		// Anything else (e.g. body ends with sentence punct) → no space, since
		// punctuation inside code spans is unusual and concat is the safer
		// default for unknown patterns.
		if (/\w/.test(bodyEnd)) {
			return " ";
		}
		return "";
	}
	return " ";
};

/**
 * Merge fragmented bullet continuations back into the parent bullet.
 *
 * Background (issue #737): LLM-emitted markdown sometimes splits a single
 * sentence into multiple list items or into a bullet plus an orphan
 * column-0 paragraph. Once that broken structure round-trips through TipTap
 * and saves, every subsequent load reproduces the split bullets. Two shapes
 * surface:
 *
 *   1. **Orphan paragraph** — a column-0 line directly after a bullet, with
 *      a leading lowercase letter, opening punctuation, or fragment punct.
 *      CommonMark parses it as a sibling paragraph that terminates the list.
 *   2. **Continuation bullet** — a sibling `<li>` whose body itself starts
 *      with a lowercase letter / fragment punct. The user perceives a single
 *      bullet split into multiple bullets at column boundaries.
 *
 * Both shapes are handled here. The walk is greedy: while the running bullet
 * body has no sentence terminator, we consume continuation candidates
 * (orphan paragraph or continuation bullet) subject to the guards below.
 *
 * Conservative heuristics on what counts as a continuation:
 *   - leading `[a-z(["',;:.?!\]]` only — capital-letter starts read as
 *     intentional new sentences and are left alone.
 *   - the parent bullet must not already end with `.`, `?`, or `!` (allowing
 *     a trailing closing quote or bracket).
 *
 *   - for sibling list items without split bold/inline-code markup, an ordered
 *     marker (`\d+.`) on either line or a parent body ending in `,` or `;`
 *     (allowing a trailing closing quote or bracket) stops the walk. These
 *     guards preserve user-authored enumerated lists (Fizzy #3397).
 *   - sibling list items need at least three words in each body, unless
 *     split markup provides the repair signal.
 *
 * Runs at LOAD time only (inside `fromMarkdown`), not in the save pipeline,
 * because save-time editor content reflects user intent that we shouldn't
 * silently rewrite.
 */
export function mergeOrphanBulletContinuations(text: string): string {
	// Diff render path: fromMarkdown is also called with text that contains
	// ADD_START / DEL_START marker tokens (zero-width-wrapped). Merging across
	// those boundaries would corrupt the diff structure and break the
	// downstream Accept flow. Skip the pass entirely if any marker is present.
	if (ANY_DIFF_MARKER.test(text)) {
		return text;
	}

	const lines = text.split("\n");
	// A numbered or bulleted line inside fenced code is code, not a list item.
	const fenceRoles = scanFences(lines);
	const out: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const bulletMatch =
			fenceRoles[i] === null ? line.match(BULLET_PATTERN) : null;
		if (!bulletMatch) {
			out.push(line);
			i++;
			continue;
		}

		// Greedy walk: consume continuation fragments into this bullet.
		let merged = line.trimEnd();
		let body = bulletMatch[3];
		let cursor = i + 1;

		while (cursor < lines.length && !endsSentence(body)) {
			// Skip blank lines (orphan-paragraph form may have them).
			let j = cursor;
			while (j < lines.length && lines[j].trim() === "") {
				j++;
			}
			if (j >= lines.length) {
				break;
			}

			const candidate = lines[j];

			// Heading / blockquote / fence terminates merging.
			if (startsWithStructuralBlock(candidate)) {
				break;
			}

			// Strong signal of a wrongly-split bold or inline-code span:
			// the parent bullet has unbalanced `**` (or unescaped `` ` ``),
			// and the candidate has matching unbalance. Merging restores the
			// pair. Capital-letter starts are intentionally allowed here
			// because the markup mismatch overrides the usual continuation
			// heuristic. `kind` tells joinSepForSplitMarkup whether to treat
			// the rejoin as prose (bold) or an identifier (code).
			const splitMarkup = detectSplitMarkup(body, candidate);

			const candidateBullet = candidate.match(BULLET_PATTERN);
			if (candidateBullet) {
				// Continuation bullet: merge if its body starts with a
				// continuation marker, OR if we're rejoining split markup.
				// Otherwise treat as a sibling list item and stop.
				const isFragment =
					looksLikeContinuation(candidateBullet[3]) || !!splitMarkup;
				if (!isFragment) {
					break;
				}
				// Word-count guard for the bullet-after-bullet case:
				// short consecutive lowercase bullets are usually intentional
				// (command lists like `- npm install` / `- yarn add`) rather
				// than fragmented sentences. Require both the parent bullet
				// and the candidate to have a few words before merging.
				// Skip this guard for split-markup repairs — the markup
				// mismatch is unambiguous.
				if (!splitMarkup) {
					// Explicit numbering and enumerating punctuation indicate
					// separate items, even when the next body starts lowercase.
					if (
						/^\d+\.$/.test(bulletMatch[2]) ||
						/^\d+\.$/.test(candidateBullet[2]) ||
						endsEnumeration(body)
					) {
						break;
					}
					if (
						wordCount(body) < 3 ||
						wordCount(candidateBullet[3]) < 3
					) {
						break;
					}
				}
				const fragment = candidateBullet[3].trim();
				const sep = splitMarkup
					? joinSepForSplitMarkup(splitMarkup, body, fragment)
					: " ";
				merged = `${merged}${sep}${fragment}`;
				body = `${body}${sep}${fragment}`;
				cursor = j + 1;
				continue;
			}

			// Orphan paragraph: must be at column 0. Continuation if it looks
			// like a fragment OR if we're rejoining split markup.
			if (/^\s/.test(candidate)) {
				break;
			}
			if (!looksLikeContinuation(candidate) && !splitMarkup) {
				break;
			}
			const fragment = candidate.trim();
			const sep = splitMarkup
				? joinSepForSplitMarkup(splitMarkup, body, fragment)
				: " ";
			merged = `${merged}${sep}${fragment}`;
			body = `${body}${sep}${fragment}`;
			cursor = j + 1;
		}

		out.push(merged);
		i = cursor;
	}

	return out.join("\n");
}

/**
 * Normalize markdown into a cleaner canonical form for raw editing and saving.
 *
 * This shares the same cleanup rules used by the render pipeline so raw mode
 * doesn't keep showing escaped headings or artifact-like wrappers that rich mode
 * already knows how to repair.
 */
export function normalizeMarkdownContent(text: string | undefined): string {
	if (!text) {
		return "";
	}

	return fixAIMarkdownIssues(text).trim();
}

/**
 * Canonical repair pipeline for AI/generated markdown documents.
 *
 * Use this at document boundaries:
 * - when hydrating stored/generated markdown into the editor
 * - when switching between raw and rich editing modes
 *
 * `repairDegradedMarkdown` runs first to rejoin the two structural breakages
 * that survive the editor's TipTap round-trip and defeat a parser — a bold
 * marker split across a bullet boundary (`**X*` + `*: …`) and an Open Question
 * split across two bullets (`- Q: What` + `- <lowercase …?>`).
 *
 * As of Fizzy #1987, this is NO LONGER used on the write/save path: the save
 * must be byte-faithful to what the user typed, and silently rewriting their
 * text here (even to "repair" it) was itself a source of edit loss. It
 * remains in use on the load path only — hydrating stored/generated markdown
 * into the editor and raw/rich mode switches — where repairing known
 * AI/generated breakage before display is still desirable. Do not re-add a
 * call to this from `getEditorMarkdownForSave` or any other save-path code.
 */
export function repairMarkdownDocument(text: string | undefined): string {
	// Collapse tilde-prefixed quote artifacts FIRST, and outside the diff-marker
	// guard below.
	//
	// Outside, because the guard exists to stop `repairDegradedMarkdown` from
	// merging bullets across a marker pair; this repair rewrites no structure at
	// all — it only shortens contiguous `~"~"` runs to the single quote they
	// should have been — so a diff-marked document is no reason to leave the
	// damage on screen. A marker sitting between the tilde and the quote simply
	// breaks the run's contiguity, and the run stops matching.
	//
	// First, because everything downstream reads the text as prose: the parser
	// sees a lone `~` as literal output, and nothing else in this pipeline knows
	// the artifact exists.
	//
	// This is the LOAD half of the repair. The write half is `sanitizeContent`
	// in `@repo/database`. Both are needed: without this one a damaged document
	// keeps rendering damaged until someone saves it, and the round trip is a
	// fixed point, so a reader who never edits would wait forever.
	const input = normalizeQuoteArtifacts(text ?? "");
	// Never restructure diff-marked text: `repairDegradedMarkdown` merges
	// bullets, which would split an ADD/DEL marker from its pair and corrupt the
	// diff. Same guard `mergeOrphanBulletContinuations` uses. Diff-marked text is
	// stripped before save (`getEditorMarkdownForSave`), so this only bites if a
	// future caller passes markers through.
	const repaired = ANY_DIFF_MARKER.test(input)
		? input
		: repairDegradedMarkdown(input);
	return normalizeMarkdownContent(repaired);
}

/**
 * Storage for extracted diff-wrapped tables
 * Tables wrapped in diff markers break MarkdownIt's block-level parsing,
 * so we extract them first, render separately, then reinsert with highlighting
 */
interface ExtractedTable {
	markdown: string;
	type: "added" | "deleted";
}

interface ExtractedHtmlTable {
	html: string;
	type: "added" | "deleted";
}

/**
 * Extract entire `<table>…</table>` HTML blocks that are wrapped in DIFF
 * markers (i.e. the table content changed in-place and `diffPartialText`
 * marked the whole table as deleted-then-added). Returns positional
 * placeholders so `splitMultilineDiffBlocks` does not shred the table's
 * multi-line HTML. Reinjected as `<div class="diff-table-{type}">…</div>`
 * in phase 3.
 *
 * Why this is needed: `diffPartialText` substitutes HTML tables with atomic
 * placeholder tokens before `diffWords` so markers can never land inside an
 * attribute value (issue #714). When the table is *unchanged*, the table
 * survives the diff pass intact and renders normally as `html_block`. When
 * the table *changed*, the placeholder is wrapped by DIFF markers and the
 * restored HTML lands inside `DEL…END` / `ADD…END`. This function is the
 * cleanup for that latter case.
 */
function extractDiffWrappedHtmlTables(text: string): {
	processed: string;
	htmlTables: ExtractedHtmlTable[];
} {
	const htmlTables: ExtractedHtmlTable[] = [];

	const addPattern = new RegExp(
		escapeRegExp(DIFF_ADD_START) +
			"\\s*" +
			"(<table\\b[^>]*>[\\s\\S]*?<\\/table>)" +
			"\\s*" +
			escapeRegExp(DIFF_ADD_END),
		"gi",
	);
	const delPattern = new RegExp(
		escapeRegExp(DIFF_DEL_START) +
			"\\s*" +
			"(<table\\b[^>]*>[\\s\\S]*?<\\/table>)" +
			"\\s*" +
			escapeRegExp(DIFF_DEL_END),
		"gi",
	);

	let processed = text;
	processed = processed.replace(addPattern, (_match, tableHtml) => {
		const index = htmlTables.length;
		htmlTables.push({ html: tableHtml, type: "added" });
		return `\n\n<!--DIFF_HTML_TABLE_${index}-->\n\n`;
	});
	processed = processed.replace(delPattern, (_match, tableHtml) => {
		const index = htmlTables.length;
		htmlTables.push({ html: tableHtml, type: "deleted" });
		return `\n\n<!--DIFF_HTML_TABLE_${index}-->\n\n`;
	});

	return { processed, htmlTables };
}

/**
 * Phase 1: Extract ALL GFM tables from markdown
 *
 * Tables can break MarkdownIt parsing when:
 * 1. They're inside a diff block (DIFF_ADD_START at document start)
 * 2. Diff markers appear at the start of table rows (breaks | detection)
 * 3. Diff markers appear inside table cells
 *
 * This function extracts ALL tables (regardless of diff markers),
 * determines if they're inside a diff block for highlighting,
 * and replaces them with placeholders for separate rendering.
 */
function extractDiffWrappedTables(
	text: string,
	/**
	 * Placeholder numbering offset. `fromMarkdown` extracts twice — once on the
	 * raw text, once after marker sanitization rescues tables the first pass
	 * could not see — and the two runs must not mint colliding placeholders.
	 */
	startIndex = 0,
): {
	processed: string;
	tables: ExtractedTable[];
} {
	const tables: ExtractedTable[] = [];
	const placeholderFor = (localIndex: number) =>
		`\n\n<!--DIFF_TABLE_${startIndex + localIndex}-->\n\n`;

	// First, try to extract tables that are specifically wrapped in diff markers
	// Pattern: DIFF_START ... table ... DIFF_END
	// Note: Use [^\\n\\r] and \\r?\\n to handle both Unix and Windows line endings
	const addTablePattern = new RegExp(
		escapeRegExp(DIFF_ADD_START) +
			"\\s*" +
			"(\\|[^\\n\\r]+\\|\\s*\\r?\\n" + // Header row: | ... |
			"\\|[\\s\\-:]+\\|[^\\n\\r]*\\r?\\n" + // Separator row: | --- |
			"(?:\\|[^\\n\\r]+\\|\\s*(?:\\r?\\n)?)*)" + // Body rows: | ... |
			"\\s*" +
			escapeRegExp(DIFF_ADD_END),
		"g",
	);

	const delTablePattern = new RegExp(
		escapeRegExp(DIFF_DEL_START) +
			"\\s*" +
			"(\\|[^\\n\\r]+\\|\\s*\\r?\\n" +
			"\\|[\\s\\-:]+\\|[^\\n\\r]*\\r?\\n" +
			"(?:\\|[^\\n\\r]+\\|\\s*(?:\\r?\\n)?)*)" +
			"\\s*" +
			escapeRegExp(DIFF_DEL_END),
		"g",
	);

	let processed = text;

	// Extract specifically wrapped added tables
	processed = processed.replace(addTablePattern, (_match, tableContent) => {
		const index = tables.length;
		tables.push({
			markdown: tableContent.trim(),
			type: "added",
		});
		return placeholderFor(index);
	});

	// Extract specifically wrapped deleted tables
	processed = processed.replace(delTablePattern, (_match, tableContent) => {
		const index = tables.length;
		tables.push({
			markdown: tableContent.trim(),
			type: "deleted",
		});
		return placeholderFor(index);
	});

	// Now handle tables that are INSIDE a larger diff block
	// These tables have diff markers somewhere around them but not specifically wrapping just the table
	// Pattern: Find any GFM table (| header |\n|---|\n| row |)
	// Note: Use \r?\n to handle both Unix (\n) and Windows (\r\n) line endings
	const gfmTablePattern =
		/(\|[^\n\r]+\|\s*\r?\n\|[\s\-:]+\|[^\n\r]*\r?\n(?:\|[^\n\r]+\|\s*\r?\n?)*)/g;

	// Extract remaining tables that weren't caught by the specific patterns
	processed = processed.replace(
		gfmTablePattern,
		(match, _tableContent, offset) => {
			// Skip if this is already a placeholder
			if (match.includes("<!--DIFF_TABLE_")) {
				return match;
			}

			// Determine if THIS SPECIFIC table is inside a diff block
			// by checking the text BEFORE this table's position for unclosed diff markers
			const textBeforeTable = processed.slice(0, offset);

			// Count unclosed ADD markers before this table
			const addStartsBefore = (
				textBeforeTable.match(
					new RegExp(escapeRegExp(DIFF_ADD_START), "g"),
				) || []
			).length;
			const addEndsBefore = (
				textBeforeTable.match(
					new RegExp(escapeRegExp(DIFF_ADD_END), "g"),
				) || []
			).length;
			const isInsideAddBlock = addStartsBefore > addEndsBefore;

			// Count unclosed DEL markers before this table
			const delStartsBefore = (
				textBeforeTable.match(
					new RegExp(escapeRegExp(DIFF_DEL_START), "g"),
				) || []
			).length;
			const delEndsBefore = (
				textBeforeTable.match(
					new RegExp(escapeRegExp(DIFF_DEL_END), "g"),
				) || []
			).length;
			const isInsideDelBlock = delStartsBefore > delEndsBefore;

			// Clean the table content - remove any diff markers from inside the table
			const cleanTable = match
				.replace(new RegExp(escapeRegExp(DIFF_ADD_START), "g"), "")
				.replace(new RegExp(escapeRegExp(DIFF_ADD_END), "g"), "")
				.replace(new RegExp(escapeRegExp(DIFF_DEL_START), "g"), "")
				.replace(new RegExp(escapeRegExp(DIFF_DEL_END), "g"), "");

			// Determine if this table should be highlighted
			// Only mark as added/deleted if THIS table is actually inside a diff block
			let tableType: "added" | "deleted" | null = null;
			if (isInsideAddBlock) {
				tableType = "added";
			} else if (isInsideDelBlock) {
				tableType = "deleted";
			}

			// If tableType is null (plain table, not in diff), don't extract it
			// Let MarkdownIt handle it normally so it renders without a wrapper div
			// This is critical because the wrapper div breaks TipTap's table parsing
			if (tableType === null) {
				return match; // Return original table unchanged
			}

			const index = tables.length;
			tables.push({
				markdown: cleanTable.trim(),
				type: tableType,
			});

			return placeholderFor(index);
		},
	);

	return { processed, tables };
}

/**
 * Extracted fenced code block wrapped entirely in ADD/DEL diff markers.
 * Pulled out before MarkdownIt parses because diff markers at a fence's
 * opening line prevent MarkdownIt from recognising the fence at all, and
 * per-line wrapping breaks fence parsing too.
 */
interface ExtractedFence {
	language: string;
	code: string;
	type: "added" | "deleted";
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Pull out fenced code blocks that sit inside an ADD or DEL diff block.
 *
 * Phase A (pure): the entire diff body is just a fence with optional
 * surrounding whitespace. Extract and reinject as a `<pre><code>` whose
 * content is one `<ins>` (ADD) or `<del>` (DEL).
 *
 * Phase B (mixed DEL only): the diff body is a mix of prose and one or more
 * fences. Walk the body, extract each fence, and split the surrounding
 * prose into its own DEL_START/DEL_END sub-regions. Without this, a DEL
 * body like `DEL_START prose ```bash\ncode\n``` more prose DEL_END` would
 * be fed to `splitMultilineDiffBlocks` (preserveFences=false for DEL), which
 * wraps every line — including fence openers — in DEL markers, producing
 * malformed HTML where `<del>` tags cross `<p>` and `<pre><code>` boundaries
 * on render.
 *
 * Mixed ADD bodies (prose + fence) are NOT handled here — they're left to
 * splitMultilineDiffBlocks with preserveFences=true, which passes fence
 * lines through unwrapped. The code block survives rendering as a real
 * `<pre><code>` (losing its "added" highlight, an acceptable trade-off).
 * The equivalent for DEL would leave a deleted code block as a normal code
 * block that survives `stripDiffTags` — dropping the deletion entirely and
 * silently keeping unwanted content in the saved document.
 */
function extractDiffWrappedFences(text: string): {
	processed: string;
	fences: ExtractedFence[];
} {
	const fences: ExtractedFence[] = [];
	let processed = text;

	// Phase A: pure fence-only diff blocks.
	// Match DIFF_xxx_START (whitespace) ```lang\n...\n``` (whitespace) DIFF_xxx_END
	const makePattern = (start: string, end: string) =>
		new RegExp(
			escapeRegExp(start) +
				"\\s*```([a-zA-Z0-9+_-]*)\\s*\\n([\\s\\S]*?)\\n```\\s*" +
				escapeRegExp(end),
			"g",
		);

	// A marker that opens inside a fence cannot wrap a whole fence: its first
	// backtick line is that fence's closer, not an opener. Extracting it would
	// take the closer and the next opener for one empty fence and leave the
	// placeholder in the code; leave it to the per-line handling instead.
	let insideFenceAt = fenceContextOf(processed);
	processed = processed.replace(
		makePattern(DIFF_ADD_START, DIFF_ADD_END),
		(match, language: string, code: string, offset: number) => {
			if (insideFenceAt(offset)) {
				return match;
			}
			const index = fences.length;
			fences.push({
				language: language.trim(),
				code,
				type: "added",
			});
			return `\n\n<!--DIFF_FENCE_${index}-->\n\n`;
		},
	);

	insideFenceAt = fenceContextOf(processed);
	processed = processed.replace(
		makePattern(DIFF_DEL_START, DIFF_DEL_END),
		(match, language: string, code: string, offset: number) => {
			if (insideFenceAt(offset)) {
				return match;
			}
			const index = fences.length;
			fences.push({
				language: language.trim(),
				code,
				type: "deleted",
			});
			return `\n\n<!--DIFF_FENCE_${index}-->\n\n`;
		},
	);

	// Phase B: mixed DEL regions (prose + fence in one DEL body).
	const delRegionRe = new RegExp(
		`${escapeRegExp(DIFF_DEL_START)}([\\s\\S]*?)${escapeRegExp(DIFF_DEL_END)}`,
		"g",
	);
	const fenceRe = /```([a-zA-Z0-9+_-]*)\s*\n([\s\S]*?)\n```/g;
	insideFenceAt = fenceContextOf(processed);
	processed = processed.replace(
		delRegionRe,
		(match, body: string, offset: number) => {
			if (!body.includes("```") || insideFenceAt(offset)) {
				return match;
			}
			const fenceMatches = Array.from(body.matchAll(fenceRe));
			if (fenceMatches.length === 0) {
				// Body contains ``` but no complete fence pair — let the
				// downstream per-line wrapper handle it (best-effort).
				return match;
			}
			const parts: string[] = [];
			let lastIndex = 0;
			for (const fenceMatch of fenceMatches) {
				const matchIndex = fenceMatch.index ?? 0;
				const prose = body.slice(lastIndex, matchIndex).trim();
				if (prose.length > 0) {
					parts.push(`${DIFF_DEL_START}${prose}${DIFF_DEL_END}`);
				}
				const index = fences.length;
				fences.push({
					language: fenceMatch[1].trim(),
					code: fenceMatch[2],
					type: "deleted",
				});
				parts.push(`\n\n<!--DIFF_FENCE_${index}-->\n\n`);
				lastIndex = matchIndex + fenceMatch[0].length;
			}
			const trailing = body.slice(lastIndex).trim();
			if (trailing.length > 0) {
				parts.push(`${DIFF_DEL_START}${trailing}${DIFF_DEL_END}`);
			}
			return parts.join("");
		},
	);

	return { processed, fences };
}

/**
 * MarkdownIt plugin for handling diff markers as inline tokens
 *
 * This is safer than post-render regex replacement because:
 * 1. Markers are recognized as proper tokens within the Markdown structure
 * 2. They won't accidentally match literal text that looks like markers
 * 3. Tags are guaranteed to be properly nested
 */
function diffMarkerPlugin(md: MarkdownIt): void {
	// Add inline rule for ADD_START marker
	md.inline.ruler.before(
		"emphasis",
		"diff_add_start",
		(state: StateInline) => {
			const marker = DIFF_ADD_START;
			if (
				state.src.slice(state.pos, state.pos + marker.length) !== marker
			) {
				return false;
			}

			const token = state.push("diff_add_open", "ins", 1);
			token.markup = marker;
			token.attrSet("class", "diff-ins");
			state.pos += marker.length;
			return true;
		},
	);

	// Add inline rule for ADD_END marker
	md.inline.ruler.before("emphasis", "diff_add_end", (state: StateInline) => {
		const marker = DIFF_ADD_END;
		if (state.src.slice(state.pos, state.pos + marker.length) !== marker) {
			return false;
		}

		const token = state.push("diff_add_close", "ins", -1);
		token.markup = marker;
		state.pos += marker.length;
		return true;
	});

	// Add inline rule for DEL_START marker
	md.inline.ruler.before(
		"emphasis",
		"diff_del_start",
		(state: StateInline) => {
			const marker = DIFF_DEL_START;
			if (
				state.src.slice(state.pos, state.pos + marker.length) !== marker
			) {
				return false;
			}

			const token = state.push("diff_del_open", "del", 1);
			token.markup = marker;
			token.attrSet("class", "diff-del");
			state.pos += marker.length;
			return true;
		},
	);

	// Add inline rule for DEL_END marker
	md.inline.ruler.before("emphasis", "diff_del_end", (state: StateInline) => {
		const marker = DIFF_DEL_END;
		if (state.src.slice(state.pos, state.pos + marker.length) !== marker) {
			return false;
		}

		const token = state.push("diff_del_close", "del", -1);
		token.markup = marker;
		state.pos += marker.length;
		return true;
	});
}

/**
 * Create a configured MarkdownIt instance with diff marker plugin
 */
function createMarkdownIt(): MarkdownIt {
	const md = new MarkdownIt({
		typographer: false,
		html: true,
	});

	// Use plugin for safer marker-to-tag conversion
	md.use(diffMarkerPlugin);
	md.use(mentionSpanInlinePlugin);

	return md;
}

/**
 * Normalize markdown text before diffing to reduce false-positive differences
 * caused by formatting variations that don't affect the rendered output.
 *
 * Common artifacts from TipTap serialization:
 * - Table separator rows with varying dash counts or whitespace
 * - Horizontal rules in different syntax (***, * * *, ---, etc.)
 * - Backslash escapes added inconsistently (\*, \_, etc.)
 * - Trailing whitespace and extra blank lines
 * - Inconsistent table cell padding
 */
function normalizeMarkdownForDiff(text: string): string {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const normalized: string[] = [];
	let inCodeBlock = false;

	for (const line of lines) {
		// Track fenced code blocks — don't normalize inside them
		if (line.trimStart().startsWith("```")) {
			inCodeBlock = !inCodeBlock;
			normalized.push(line.trimEnd());
			continue;
		}

		if (inCodeBlock) {
			normalized.push(line);
			continue;
		}

		let n = line;

		// Remove trailing whitespace, except a two-space hard break after
		// content: trimming it turned the break into a soft break on accept.
		n = /\S {2,}$/.test(n) ? `${n.trimEnd()}  ` : n.trimEnd();

		// Normalize table separator rows: |---|---| with varying dashes/spaces → consistent
		if (/^\|[\s:]*-+[\s:]*(\|[\s:]*-+[\s:]*)*\|?\s*$/.test(n)) {
			const cols = n.split("|").filter((s) => s.trim().length > 0);
			n = `| ${cols.map(() => "---").join(" | ")} |`;
		}

		// Normalize horizontal rules: * * *, ***, ---, - - -, ___, _ _ _ → ---
		else if (
			/^[ \t]*(\*[\s*]*\*[\s*]*\*[\s*]*|-[\s-]*-[\s-]*-[\s-]*|_[\s_]*_[\s_]*_[\s_]*)$/.test(
				n,
			)
		) {
			n = "---";
		}

		// Backslash escapes (`\#`, `\-`, `\>`, …) are preserved here. Stripping
		// them in the unchanged regions of the diff would emit `# heading` for a
		// line the user authored as `\# literal`, silently rewriting their
		// intent. mergePhantomEscapeDiffs (called after diffWords) collapses
		// the rare `\X` ↔ `X` phantom pair without touching unchanged content.

		// Normalize table cell padding: |  content  | → | content |
		n = n.replace(/\|\s{2,}/g, "| ");
		n = n.replace(/\s{2,}\|/g, " |");

		normalized.push(n);
	}

	// Collapse multiple blank lines to a single blank line
	let result = normalized.join("\n");
	result = result.replace(/\n{3,}/g, "\n\n");

	return result;
}

// Chars Turndown defensively escapes at line start. `\X` and `X` render
// identically when the escape is at the head of an inline run, so a diff
// pair where the only difference is a leading `\` is a phantom diff.
const TURNDOWN_ESCAPABLE = new Set([
	"*",
	"_",
	"~",
	"|",
	".",
	"-",
	"[",
	"]",
	"(",
	")",
	"{",
	"}",
	"#",
	"+",
	"!",
	">",
]);

type DiffPart = { added?: boolean; removed?: boolean; value: string };

/**
 * Collapse `\X` vs `X` escape-only diffs into unchanged segments using the
 * escaped form. Turndown writes paragraph-leading prefix chars escaped on
 * the editor baseline; the AI emits clean output. Without this pass each
 * escape shows up as a struck-through `\` in the diff. We keep the escaped
 * form so the streaming preview matches the user's editor (escaped `\#`
 * renders as a literal `#`, not a heading) and intentional escapes on
 * unchanged lines survive.
 *
 * `diffWords` typically splits the backslash off as its own token, so the
 * common shape is `[removed: "\\"][unchanged: "X..."]`, or a longer removal
 * ending in that `\`. The rarer paired shape `[removed: "\\X"][added: "X"]`
 * is also handled.
 */
function mergePhantomEscapeDiffs(parts: DiffPart[]): DiffPart[] {
	const isPairedEscape = (
		removed: string | undefined,
		added: string | undefined,
	): boolean =>
		removed != null &&
		added != null &&
		removed.length === added.length + 1 &&
		removed[0] === "\\" &&
		TURNDOWN_ESCAPABLE.has(removed[1]) &&
		removed.slice(1) === added;

	// A removed run ending in an escape for the unchanged char after it: the
	// lone `\` token, or the tail of a longer removal (`Reference: \` before
	// an unchanged `[S1]`). An even run of trailing backslashes ends in an
	// escaped backslash, not an escape.
	const endsWithEscapeBeforeEscapable = (
		cur: DiffPart,
		next: DiffPart | undefined,
	): boolean =>
		(cur.value.match(/\\+$/)?.[0].length ?? 0) % 2 === 1 &&
		next != null &&
		!next.added &&
		!next.removed &&
		next.value.length > 0 &&
		TURNDOWN_ESCAPABLE.has(next.value[0]);

	// Phantom merging is directional. Removing a Turndown escape from the
	// baseline (`\X` → `X`) is invisible — the rendered output is unchanged
	// — so we collapse it. Adding an escape (`X` → `\X`) is a real semantic
	// change (heading → literal-text paragraph) and must surface as a diff.
	const merged: DiffPart[] = [];
	let i = 0;
	while (i < parts.length) {
		const cur = parts[i];
		const next = parts[i + 1];
		if (cur.removed && endsWithEscapeBeforeEscapable(cur, next)) {
			if (cur.value.length > 1) {
				merged.push({ removed: true, value: cur.value.slice(0, -1) });
			}
			merged.push({ value: "\\" });
			i += 1;
			continue;
		}
		// The same escape when a rewrite inserts text before the unchanged char:
		// `[removed "…\\"][added "…"][unchanged "X…"]`. The escape moves after
		// the insertion, where it still escapes `X`.
		if (
			cur.removed &&
			next?.added &&
			endsWithEscapeBeforeEscapable(cur, parts[i + 2])
		) {
			if (cur.value.length > 1) {
				merged.push({ removed: true, value: cur.value.slice(0, -1) });
			}
			merged.push(next, { value: "\\" });
			i += 2;
			continue;
		}
		if (
			next &&
			cur.removed &&
			next.added &&
			isPairedEscape(cur.value, next.value)
		) {
			merged.push({ value: cur.value });
			i += 2;
			continue;
		}
		if (
			next &&
			cur.added &&
			next.removed &&
			isPairedEscape(next.value, cur.value)
		) {
			merged.push({ value: next.value });
			i += 2;
			continue;
		}
		merged.push(cur);
		i += 1;
	}
	return merged;
}

// An inline code span is matched whole and kept. So is `\\`, so an escaped
// backslash is never split. The other characters are the Turndown escapes
// `mergePhantomEscapeDiffs` collapses back to the baseline's escaped form.
const AGENT_UNESCAPE_RE = /(`+)[^`]*?\1|\\([\\[\]\-+#>.])/g;

function unescapeAgentLine(line: string): string {
	return line.replace(
		AGENT_UNESCAPE_RE,
		(match, _codeTicks: string | undefined, char: string | undefined) =>
			char && char !== "\\" ? char : match,
	);
}

/**
 * The document as the AI Assistant should read it: the editor's Turndown
 * output without the defensive escapes (`\[`, `\]`, `\-`, `\+`, `\#`, `\>`,
 * `\.`) that `mergePhantomEscapeDiffs` collapses on the way back.
 *
 * The agent edits the text it is given. Handed `\[S1\]`, models echo the
 * escapes into their rewrites, doubled (`\\[`) or copied onto real links
 * (`\[Docs\](…)`). An added backslash is a real diff, so every accepted edit
 * saved one more visible layer. With the escapes removed there is nothing to
 * echo, and an untouched region still diffs as unchanged because the merge
 * restores the baseline's escaped form.
 *
 * `\\` and `` \` `` stay, because the merge does not collapse them. Code
 * fences, inline code and tables stay byte-identical: their content is
 * literal, and tables are diffed as whole blocks, so a single changed byte
 * would show an untouched table as replaced. Visual slot tags stay too: their
 * attributes are HTML, not markdown.
 */
export function toAgentDocument(markdown: string): string {
	let inFence = false;
	let inHtmlTable = false;
	return markdown
		.split("\n")
		.map((line) => {
			const trimmed = line.trimStart();
			if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
				inFence = !inFence;
				return line;
			}
			if (inFence) {
				return line;
			}
			if (inHtmlTable || /<table\b/i.test(line)) {
				inHtmlTable = !/<\/table>/i.test(line);
				return line;
			}
			if (
				GFM_TABLE_ROW.test(line) ||
				line.includes(`<${VISUAL_SLOT_TAG}`)
			) {
				return line;
			}
			return unescapeAgentLine(line);
		})
		.join("\n");
}

/**
 * Replace `<table>…</table>` HTML blocks in BOTH texts with shared, content-keyed
 * placeholder tokens before word-level diffing. Identical tables in old and new
 * map to the SAME placeholder so `diffWords` treats them as unchanged. Different
 * tables map to distinct placeholders so the whole table is marked as
 * removed/added atomically — never mid-attribute.
 *
 * Why: TipTap's serialized tables (`<table class="tiptap-table">…`) survive in
 * the saved markdown as HTML pass-through. Without this extraction, `diffWords`
 * happily places markers at character positions inside `<th colspan="…">` tag
 * soup. Those markers later get blanket-replaced with `<ins class="diff-ins">`
 * by the fallback at `fromMarkdown` line 1874-1884, producing literal `<ins`
 * substrings inside attribute values that the browser parser cannot recover.
 * Issue #714 (comment).
 *
 * The placeholder format is a single ASCII word so `diffWords`'s default
 * tokenizer keeps it as one token.
 */
function extractHtmlTablesForDiff(
	oldText: string,
	newText: string,
): {
	oldProcessed: string;
	newProcessed: string;
	blocks: Map<string, string>;
} {
	const HTML_TABLE_RE = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
	const htmlToPlaceholder = new Map<string, string>();
	const placeholderToHtml = new Map<string, string>();
	let nextIdx = 0;

	const substitute = (text: string): string =>
		text.replace(HTML_TABLE_RE, (match) => {
			let placeholder = htmlToPlaceholder.get(match);
			if (!placeholder) {
				placeholder = `xHTMLBLOCKx${nextIdx++}xENDx`;
				htmlToPlaceholder.set(match, placeholder);
				placeholderToHtml.set(placeholder, match);
			}
			return placeholder;
		});

	return {
		oldProcessed: substitute(oldText),
		newProcessed: substitute(newText),
		blocks: placeholderToHtml,
	};
}

/**
 * Pull diff markers back out of table rows before anything tries to parse them.
 *
 * `fixAIMarkdownIssues` also repairs marker placement, but it runs AFTER phase
 * 1 extraction — too late for `extractDiffWrappedTables`, which only
 * recognises a table when its separator row is clean. A marker there (the
 * shape word-level diffing used to produce, and the shape stored documents can
 * still arrive in) makes the whole table fall through to per-line wrapping and
 * render as a paragraph of literal pipes.
 *
 * Deliberately narrow: a line is only touched when it is part of a pipe table
 * — never prose that happens to contain a pipe.
 */
function sanitizeTableMarkerPlacement(text: string): string {
	if (!text.includes("_START") && !text.includes("_END")) {
		return text;
	}

	const markerRe = new RegExp(ANY_MARKER_SOURCE, "g");
	const lines = text.split("\n");
	let inFence = false;
	let previousWasTableRow = false;
	const cleanedSeparatorLines: number[] = [];

	const sanitized = lines.map((line, index) => {
		if (line.trimStart().startsWith("```")) {
			inFence = !inFence;
			previousWasTableRow = false;
			return line;
		}
		if (inFence) {
			return line;
		}

		const bare = line.replace(markerRe, "");

		// A separator row belongs to the table above it. It holds no prose, so
		// any marker in it is pure damage — drop them all.
		if (
			previousWasTableRow &&
			GFM_SEPARATOR_ROW.test(bare) &&
			bare.includes("|")
		) {
			previousWasTableRow = true;
			if (bare !== line) {
				cleanedSeparatorLines.push(index);
			}
			return bare;
		}

		if (!GFM_TABLE_ROW.test(bare)) {
			previousWasTableRow = false;
			return line;
		}

		previousWasTableRow = true;
		// Row content is diffable, but the leading pipe must start the line for
		// MarkdownIt to see a row at all — move any marker in front of it after.
		return line.replace(
			new RegExp(
				`^([^\\S\\r\\n]*)(${ANY_MARKER_SOURCE})([^\\S\\r\\n]*)\\|`,
				"",
			),
			"$1|$2",
		);
	});

	// A marker dropped from a separator row may have had its partner elsewhere
	// in the same table — that partner is now unpaired and would render as an
	// unclosed <ins>/<del> swallowing cell content (which the accept-time strip
	// then deletes as if it were a real removal). Rebalance each affected table
	// block, stripping only markers that no longer have a partner.
	for (const separatorLine of cleanedSeparatorLines) {
		let start = separatorLine;
		while (start > 0 && isTableLine(sanitized[start - 1] ?? "")) {
			start--;
		}
		let end = separatorLine;
		while (
			end < sanitized.length - 1 &&
			isTableLine(sanitized[end + 1] ?? "")
		) {
			end++;
		}
		const block = sanitized.slice(start, end + 1).join("\n");
		const rebalanced = stripUnpairedMarkers(block);
		if (rebalanced !== block) {
			sanitized.splice(start, end - start + 1, ...rebalanced.split("\n"));
		}
	}

	return sanitized.join("\n");
}

/** A line that reads as a table row or separator once markers are removed. */
function isTableLine(line: string): boolean {
	const bare = line.replace(new RegExp(ANY_MARKER_SOURCE, "g"), "");
	return (
		GFM_TABLE_ROW.test(bare) ||
		(GFM_SEPARATOR_ROW.test(bare) && bare.includes("|"))
	);
}

/**
 * Remove diff markers that have no partner in `segment`: an END with no prior
 * unmatched START, and any START left open at the end. Balanced pairs are left
 * exactly where they are.
 */
function stripUnpairedMarkers(segment: string): string {
	const tokenRe = new RegExp(
		`(${escapeRegExp(DIFF_ADD_START)})|(${escapeRegExp(DIFF_ADD_END)})|(${escapeRegExp(DIFF_DEL_START)})|(${escapeRegExp(DIFF_DEL_END)})`,
		"g",
	);
	interface MarkerToken {
		index: number;
		length: number;
		kind: "addStart" | "addEnd" | "delStart" | "delEnd";
	}
	const tokens: MarkerToken[] = [];
	for (const match of segment.matchAll(tokenRe)) {
		tokens.push({
			index: match.index,
			length: match[0].length,
			kind: match[1]
				? "addStart"
				: match[2]
					? "addEnd"
					: match[3]
						? "delStart"
						: "delEnd",
		});
	}

	const orphans: MarkerToken[] = [];
	const collectOrphans = (
		startKind: MarkerToken["kind"],
		endKind: MarkerToken["kind"],
	) => {
		const open: MarkerToken[] = [];
		for (const token of tokens) {
			if (token.kind === startKind) {
				open.push(token);
			} else if (token.kind === endKind) {
				if (open.length > 0) {
					open.pop();
				} else {
					orphans.push(token);
				}
			}
		}
		orphans.push(...open);
	};
	collectOrphans("addStart", "addEnd");
	collectOrphans("delStart", "delEnd");

	if (orphans.length === 0) {
		return segment;
	}
	orphans.sort((a, b) => b.index - a.index);
	let result = segment;
	for (const token of orphans) {
		result =
			result.slice(0, token.index) +
			result.slice(token.index + token.length);
	}
	return result;
}

/**
 * Stamp `data-diff="added" | "deleted"` onto a rendered table.
 *
 * The `<div class="diff-table-…">` wrapper is enough for read-only surfaces
 * (the preview panes render the HTML straight to the DOM), but the editable
 * editor parses this HTML into ProseMirror, which has no node for a bare div
 * and silently drops it. The save path would then see two indistinguishable
 * tables and keep both. The Table node carries a `diff` attribute that
 * round-trips, so mark the element itself as well.
 */
function markTableWithDiffType(
	tableHtml: string,
	type: "added" | "deleted",
): string {
	return tableHtml.replace(/<table\b/i, `<table data-diff="${type}"`);
}

/** Matches a GFM table separator row, with or without alignment colons. */
const GFM_SEPARATOR_ROW = /^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/;
/** Matches any pipe-delimited table row. */
const GFM_TABLE_ROW = /^\s*\|.*\|\s*$/;
/** Placeholder token for a substituted GFM table (one `diffWords` token). */
const GFM_TABLE_PLACEHOLDER = /xGFMTABLEx\d+xENDx/;
const GFM_TABLE_PLACEHOLDER_SPLIT = /(xGFMTABLEx\d+xENDx)/g;

/**
 * Substitute whole GFM pipe tables with atomic placeholder tokens so
 * `diffWords` can only add/remove a table wholesale — never mid-row.
 *
 * Why: this is the markdown twin of `extractHtmlTablesForDiff` (issue #714).
 * GFM pipe tables are what `getEditorMarkdownForSave` actually persists, so
 * they are what the diff sees on nearly every AI edit. Without substitution,
 * `diffWords` places markers inside table rows — including the `| --- | --- |`
 * separator row — which stops MarkdownIt from recognising the table at all.
 * It then renders a paragraph of literal pipes, ProseMirror collapses the
 * newlines, and Turndown writes that pipe blob back to the database on accept.
 *
 * Scanning is line-based and fence-aware: a pipe table inside a ``` fence is
 * sample content, not a table, and must survive byte-identical.
 *
 * The placeholder format is a single ASCII word so `diffWords`'s default
 * tokenizer keeps it as one token. Identical tables in old and new text share
 * a placeholder, so an unchanged table produces no diff parts at all.
 */
function extractGfmTablesForDiff(
	oldText: string,
	newText: string,
): {
	oldProcessed: string;
	newProcessed: string;
	blocks: Map<string, string>;
} {
	const tableToPlaceholder = new Map<string, string>();
	const placeholderToTable = new Map<string, string>();
	let nextIdx = 0;

	const substitute = (text: string): string => {
		const lines = text.split("\n");
		const output: string[] = [];
		let inFence = false;
		let i = 0;

		while (i < lines.length) {
			const line = lines[i];

			if (line.trimStart().startsWith("```")) {
				inFence = !inFence;
				output.push(line);
				i++;
				continue;
			}

			// A table needs a header row followed immediately by a separator row.
			if (
				inFence ||
				!GFM_TABLE_ROW.test(line) ||
				i + 1 >= lines.length ||
				!GFM_SEPARATOR_ROW.test(lines[i + 1]) ||
				!lines[i + 1].includes("|")
			) {
				output.push(line);
				i++;
				continue;
			}

			const block = [line, lines[i + 1]];
			let end = i + 2;
			while (end < lines.length && GFM_TABLE_ROW.test(lines[end])) {
				block.push(lines[end]);
				end++;
			}

			const tableText = block.join("\n");
			let placeholder = tableToPlaceholder.get(tableText);
			if (!placeholder) {
				placeholder = `xGFMTABLEx${nextIdx++}xENDx`;
				tableToPlaceholder.set(tableText, placeholder);
				placeholderToTable.set(placeholder, tableText);
			}
			output.push(placeholder);
			i = end;
		}

		return output.join("\n");
	};

	return {
		oldProcessed: substitute(oldText),
		newProcessed: substitute(newText),
		blocks: placeholderToTable,
	};
}

/**
 * Restore HTML table placeholders inserted by `extractHtmlTablesForDiff`.
 * No-op when the block map is empty (the common case for docs with no tables).
 */
function restoreHtmlTables(value: string, blocks: Map<string, string>): string {
	if (blocks.size === 0 || !value) {
		return value;
	}
	let restored = value;
	for (const [placeholder, html] of blocks) {
		if (restored.includes(placeholder)) {
			restored = restored.split(placeholder).join(html);
		}
	}
	return restored;
}

/**
 * Slide a pure removal or insertion of whole lines so it starts and ends on a
 * fence boundary when it can. Two diagrams in a row share their opener and
 * marker line, so removing the first one lines up equally well as "the first
 * fence" or as "the end of the first fence plus the start of the second"; the
 * second crosses a closer and an opener, and no mark can span two code blocks.
 * Sliding moves the run up over the equal lines it repeats, which keeps the
 * same alignment cost. `oldRoles`/`newRoles` are the fence roles of the keyed
 * (non-blank) lines.
 */
function alignRunsWithFences(
	chunks: ArrayChange<string>[],
	oldRoles: FenceRole[],
	newRoles: FenceRole[],
): ArrayChange<string>[] {
	// A run is aligned when it neither starts inside a fence nor ends inside
	// one it did not open, i.e. its fence roles balance on their own.
	const aligned = (roles: FenceRole[], from: number, count: number) => {
		let open = false;
		for (let k = from; k < from + count; k++) {
			const role = roles[k];
			if (role === "open") {
				open = true;
			} else if (role === "close") {
				if (!open) {
					return false;
				}
				open = false;
			} else if (role === "inside" && !open) {
				return false;
			}
		}
		return !open;
	};
	// Without a fence on either side every run is aligned already.
	if (
		oldRoles.every((role) => role === null) &&
		newRoles.every((role) => role === null)
	) {
		return chunks;
	}
	const result = chunks.map((chunk) => ({
		...chunk,
		value: [...chunk.value],
	}));
	let oldPos = 0;
	let newPos = 0;
	for (let i = 0; i < result.length; i++) {
		const chunk = result[i];
		const prev = result[i - 1];
		const count = chunk.value.length;
		// A removal followed by an insertion is a replacement, not a pure run.
		const paired = chunk.removed && result[i + 1]?.added;
		const roles = chunk.removed ? oldRoles : newRoles;
		const pos = chunk.removed ? oldPos : newPos;
		if (
			(chunk.removed || chunk.added) &&
			!paired &&
			prev &&
			!prev.added &&
			!prev.removed &&
			!aligned(roles, pos, count)
		) {
			// Each step moves the run up one line over an equal line that
			// repeats its last one.
			let shift = 0;
			while (
				shift < Math.min(prev.value.length, count) &&
				prev.value[prev.value.length - 1 - shift] ===
					chunk.value[count - 1 - shift] &&
				!aligned(roles, pos - shift, count)
			) {
				shift += 1;
			}
			if (shift > 0 && aligned(roles, pos - shift, count)) {
				const moved = prev.value.splice(
					prev.value.length - shift,
					shift,
				);
				const tail = chunk.value.splice(count - shift, shift);
				chunk.value.unshift(...moved);
				prev.count = prev.value.length;
				const next = result[i + 1];
				if (next && !next.added && !next.removed) {
					next.value.unshift(...tail);
					next.count = next.value.length;
				} else {
					result.splice(i + 1, 0, {
						value: tail,
						count: tail.length,
						added: false,
						removed: false,
					});
				}
				// The equal run before gave up `shift` lines on both sides.
				oldPos -= shift;
				newPos -= shift;
			}
		}
		if (!chunk.added) {
			oldPos += chunk.value.length;
		}
		if (!chunk.removed) {
			newPos += chunk.value.length;
		}
	}
	return result.filter((chunk) => chunk.value.length > 0);
}

// Line identity for alignment: indentation, list-marker padding and the
// marker character are formatting the serializer and the model write
// differently, so they never decide whether a line changed.
function lineKey(line: string): string {
	return line
		.trim()
		.replace(/^(?:[-*+]|(\d+)[.)])\s+/, (_match, number?: string) =>
			number ? `${number}. ` : "- ",
		)
		.replace(/\s+/g, " ");
}

const BLOCK_START_RE =
	/^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|```|~~~|\||[-*_]{3,}\s*$)/;

type LineUnit = { first: number; last: number };

/**
 * Group lines into the units the diff aligns: a block's first line plus the
 * wrapped lines that continue it (no blank line, no block prefix of their
 * own), so a bullet the model re-wraps onto two lines is still one unit.
 * Inside a fence every line is its own unit. A line `scanFences` gives a
 * role (`roles`) is a fence line too, so a fence unit is always one line
 * even where the two rules disagree (a ``` line inside a ~~~ fence).
 */
function lineUnits(lines: string[], roles: FenceRole[]): LineUnit[] {
	const units: LineUnit[] = [];
	let inFence = false;
	let open: LineUnit | null = null;
	lines.forEach((line, index) => {
		if (!line.trim()) {
			open = null;
			return;
		}
		const isFence = /^\s*(?:```|~~~)/.test(line);
		if (isFence) {
			inFence = !inFence;
		}
		const code = inFence || isFence || roles[index] !== null;
		if (open && !code && !BLOCK_START_RE.test(line)) {
			open.last = index;
			return;
		}
		open = { first: index, last: index };
		units.push(open);
		if (code) {
			open = null;
		}
	});
	return units;
}

/** The same lines, one unit per non-blank line. */
function singleLineUnits(lines: string[], units: LineUnit[]): LineUnit[] {
	return units.flatMap((unit) =>
		lines.slice(unit.first, unit.last + 1).flatMap((line, offset) =>
			line.trim()
				? [
						{
							first: unit.first + offset,
							last: unit.first + offset,
						},
					]
				: [],
		),
	);
}

function unitWords(text: string): Set<string> {
	return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function wordOverlap(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) {
		return 0;
	}
	let shared = 0;
	for (const word of a) {
		if (b.has(word)) {
			shared++;
		}
	}
	return (2 * shared) / (a.size + b.size);
}

type HunkStep = { oldUnit?: number; newUnit?: number };

/**
 * Pair the old and new blocks of one changed run in order, by shared words:
 * an edited block pairs with its new version, and a block added or removed
 * next to it stays unpaired instead of dragging its neighbour's words along.
 */
function alignHunkUnits(oldHunk: string[], newHunk: string[]): HunkStep[] {
	const minOverlap = 0.3;
	const oldWords = oldHunk.map(unitWords);
	const newWords = newHunk.map(unitWords);
	const overlap = (i: number, j: number) =>
		wordOverlap(oldWords[i], newWords[j]);
	const score = Array.from({ length: oldHunk.length + 1 }, () =>
		new Array<number>(newHunk.length + 1).fill(0),
	);
	for (let i = 1; i <= oldHunk.length; i++) {
		for (let j = 1; j <= newHunk.length; j++) {
			const pair = overlap(i - 1, j - 1);
			score[i][j] = Math.max(
				score[i - 1][j],
				score[i][j - 1],
				pair >= minOverlap ? score[i - 1][j - 1] + pair : 0,
			);
		}
	}
	const steps: HunkStep[] = [];
	let i = oldHunk.length;
	let j = newHunk.length;
	while (i > 0 || j > 0) {
		const pair = i > 0 && j > 0 ? overlap(i - 1, j - 1) : 0;
		if (pair >= minOverlap && score[i][j] === score[i - 1][j - 1] + pair) {
			steps.push({ oldUnit: i - 1, newUnit: j - 1 });
			i--;
			j--;
		} else if (i > 0 && (j === 0 || score[i][j] === score[i - 1][j])) {
			steps.push({ oldUnit: i - 1 });
			i--;
		} else {
			steps.push({ newUnit: j - 1 });
			j--;
		}
	}
	return steps.reverse();
}

/**
 * Diff a complete document line by line, then word by word only inside the
 * lines that changed. A whole-document `diffWords` aligns punctuation tokens
 * across lines: the `-` of a new bullet pairs with a dash of the `---` below
 * it, or with the hyphen in `up-to-date` on the line above, and a newline plus
 * indent is pulled into an insertion. Accepting such a diff drops the rule,
 * leaves a dangling `-`, or un-nests the next list item.
 *
 * Blank lines are left out of the alignment (the serializer writes loose
 * lists, the model usually tight ones) and are emitted from the new text.
 */
function diffByLines(oldText: string, newText: string): DiffPart[] {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const oldRoles = scanFences(oldLines);
	const newRoles = scanFences(newLines);
	const oldRefs = lineUnits(oldLines, oldRoles);
	const newRefs = lineUnits(newLines, newRoles);
	const unitText = (lines: string[], unit: LineUnit) =>
		lines.slice(unit.first, unit.last + 1).join("\n");
	// A unit with a fence role is one line, so its first line's role is its own.
	const allInside = (
		roles: FenceRole[],
		refs: LineUnit[],
		from: number,
		count: number,
	) => {
		for (let k = 0; k < count; k++) {
			if (roles[refs[from + k].first] !== "inside") {
				return false;
			}
		}
		return true;
	};
	const chunks = alignRunsWithFences(
		diffArrays(
			oldRefs.map((unit) => lineKey(unitText(oldLines, unit))),
			newRefs.map((unit) => lineKey(unitText(newLines, unit))),
		),
		oldRefs.map((unit) => oldRoles[unit.first]),
		newRefs.map((unit) => newRoles[unit.first]),
	);

	const parts: DiffPart[] = [];
	let oldPos = 0;
	let newPos = 0;
	let newCursor = 0;
	const lastNewLine = newLines.length - 1;
	const emitNewThrough = (lastIndex: number) => {
		if (lastIndex < newCursor) {
			return;
		}
		const text = newLines.slice(newCursor, lastIndex + 1).join("\n");
		parts.push({ value: lastIndex < lastNewLine ? `${text}\n` : text });
		newCursor = lastIndex + 1;
	};
	// A removed block sits right after the previous kept line. After a
	// paragraph line it needs a blank line of its own: a block that cannot
	// interrupt a paragraph (`2. item`) would otherwise continue it, and its
	// hoisted marker would survive the accept as text.
	const removedPart = (oldText: string): DiffPart => {
		if (newCursor > lastNewLine) {
			return { removed: true, value: `\n${oldText}` };
		}
		const previous = newLines[newCursor - 1] ?? "";
		// Code is not parsed into blocks, and inside it the blank line would
		// be content that rejecting the deletion keeps.
		const separate =
			newRoles[newCursor - 1] !== "inside" &&
			previous.trim() !== "" &&
			!BLOCK_START_RE.test(previous) &&
			/^\s*\d+[.)]\s/.test(oldText);
		return {
			removed: true,
			value: separate ? `\n${oldText}\n` : `${oldText}\n`,
		};
	};
	const oldSlice = (count: number) =>
		oldLines
			.slice(oldRefs[oldPos].first, oldRefs[oldPos + count - 1].last + 1)
			.join("\n");
	const newSlice = (count: number) =>
		newLines
			.slice(newRefs[newPos].first, newRefs[newPos + count - 1].last + 1)
			.join("\n");
	const closeNewSlice = (count: number) => {
		newCursor = newRefs[newPos + count - 1].last + 1;
		if (newCursor <= lastNewLine) {
			parts.push({ value: "\n" });
		}
	};

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const count = chunk.value.length;
		if (!chunk.added && !chunk.removed) {
			emitNewThrough(newRefs[newPos + count - 1].last);
			oldPos += count;
			newPos += count;
			continue;
		}
		if (chunk.removed) {
			const next = chunks[i + 1];
			const removed = oldSlice(count);
			if (next?.added) {
				const addedCount = next.value.length;
				if (
					allInside(oldRoles, oldRefs, oldPos, count) &&
					allInside(newRoles, newRefs, newPos, addedCount)
				) {
					emitNewThrough(newRefs[newPos].first - 1);
					// Inside a fence every line is code: replace the changed lines
					// whole, each side carrying its own newline. A line break left
					// between two diff elements is dropped by the editor's HTML
					// parser, and accepting then joins two lines of the diagram.
					if (count === addedCount) {
						// Line by line, so each line stays its own change.
						for (let k = 0; k < count; k++) {
							const newUnit = newRefs[newPos + k];
							emitNewThrough(newUnit.first - 1);
							parts.push(
								{
									removed: true,
									value: `${unitText(oldLines, oldRefs[oldPos + k])}\n`,
								},
								{
									added: true,
									value: `${unitText(newLines, newUnit)}\n`,
								},
							);
							newCursor = newUnit.last + 1;
						}
					} else {
						parts.push(
							{ removed: true, value: `${removed}\n` },
							{ added: true, value: `${newSlice(addedCount)}\n` },
						);
						newCursor = newRefs[newPos + addedCount - 1].last + 1;
					}
					newPos += addedCount;
					i += 1;
					oldPos += count;
					continue;
				}
				let oldUnits = oldRefs.slice(oldPos, oldPos + count);
				let newHunk = newRefs.slice(newPos, newPos + addedCount);
				// A wrapped paragraph whose lines became separate blocks (or
				// blocks joined into one wrapped paragraph) aligns line by line.
				if (oldUnits.length !== newHunk.length) {
					const oldSingles = singleLineUnits(oldLines, oldUnits);
					const newSingles = singleLineUnits(newLines, newHunk);
					if (oldSingles.length === newHunk.length) {
						oldUnits = oldSingles;
					} else if (newSingles.length === oldUnits.length) {
						newHunk = newSingles;
					}
				}
				const oldHunk = oldUnits.map((unit) =>
					unitText(oldLines, unit),
				);
				// Word-diff each block against the block it became, so a token
				// in one block can never match a token in its neighbour. A block
				// with no counterpart is a whole deletion or addition.
				for (const step of alignHunkUnits(
					oldHunk,
					newHunk.map((unit) => unitText(newLines, unit)),
				)) {
					if (step.newUnit === undefined) {
						parts.push(removedPart(oldHunk[step.oldUnit ?? 0]));
						continue;
					}
					const newUnit = newHunk[step.newUnit];
					emitNewThrough(newUnit.first - 1);
					const newText = unitText(newLines, newUnit);
					if (step.oldUnit === undefined) {
						parts.push({ added: true, value: newText });
					} else {
						parts.push(
							...diffWords(oldHunk[step.oldUnit], newText),
						);
					}
					newCursor = newUnit.last + 1;
					if (newUnit.last < lastNewLine) {
						parts.push({ value: "\n" });
					}
				}
				newPos += addedCount;
				i += 1;
			} else {
				parts.push(removedPart(removed));
			}
			oldPos += count;
			continue;
		}
		emitNewThrough(newRefs[newPos].first - 1);
		if (allInside(newRoles, newRefs, newPos, count)) {
			// An added code line takes its newline with it, so rejecting it
			// leaves no empty line behind.
			parts.push({ added: true, value: `${newSlice(count)}\n` });
			newCursor = newRefs[newPos + count - 1].last + 1;
			newPos += count;
			continue;
		}
		parts.push({ added: true, value: newSlice(count) });
		closeNewSlice(count);
		newPos += count;
	}
	emitNewThrough(lastNewLine);
	return parts;
}

/**
 * Calculate diff between two text strings using word-level comparison
 *
 * Uses placeholder tokens that are later replaced with HTML tags after markdown processing.
 * This prevents markdown from corrupting the diff tags in headings and other block elements.
 *
 * @param oldText - The original/baseline text
 * @param newText - The new/streaming text
 * @param isComplete - Whether streaming is complete (default: false)
 * @returns Text with placeholder tokens for additions and deletions
 */
export function diffPartialText(
	oldText: string,
	newText: string,
	isComplete = false,
): string {
	// For complete comparisons (version diff), normalize markdown to prevent
	// false diffs from formatting artifacts like ***, ---|---, multi-blank
	// lines, etc. Backslash escapes are NOT stripped — see normalizeMarkdownForDiff.
	const oldNorm = isComplete ? normalizeMarkdownForDiff(oldText) : oldText;
	const newNorm = isComplete ? normalizeMarkdownForDiff(newText) : newText;

	// Substitute HTML tables with shared placeholders so diffWords treats
	// each table as one atomic token. Prevents diff markers from landing
	// inside HTML attribute values (issue #714).
	const {
		oldProcessed: oldAfterHtml,
		newProcessed: newAfterHtml,
		blocks: htmlBlocks,
	} = extractHtmlTablesForDiff(oldNorm, newNorm);

	// Same treatment for GFM pipe tables — the format documents are actually
	// stored in. Markers landing inside a `| --- |` separator row stop the
	// table from parsing at all, and the accept-save round trip then persists
	// the raw pipes.
	const {
		oldProcessed,
		newProcessed,
		blocks: gfmBlocks,
	} = extractGfmTablesForDiff(oldAfterHtml, newAfterHtml);

	let oldTextToCompare = oldProcessed;
	if (oldProcessed.length > newProcessed.length && !isComplete) {
		// make oldText shorter
		oldTextToCompare = oldProcessed.slice(0, newProcessed.length);
	}

	const changes = mergePhantomEscapeDiffs(
		isComplete
			? diffByLines(oldTextToCompare, newProcessed)
			: diffWords(oldTextToCompare, newProcessed),
	);

	// When the diff part contains an HTML `<table>` (post-restore) along
	// with surrounding text — e.g. removing a section that includes a
	// table plus trailing prose — emit a SEPARATE DIFF wrapper around the
	// table itself so `extractDiffWrappedHtmlTables` (which requires the
	// markers to tightly wrap `<table>…</table>`) can pick it up. Without
	// this split, the table ends up inside `<del class="diff-del">…</del>`
	// after rendering, which TipTap can't apply as a mark on a table node.
	const HTML_TABLE_SPLIT_RE = /(<table\b[^>]*>[\s\S]*?<\/table>)/gi;
	const HTML_TABLE_OPEN_RE = /<table\b/i;
	const wrapWithMarkers = (
		content: string,
		startMarker: string,
		endMarker: string,
	): string => {
		if (!content) {
			return "";
		}
		if (htmlBlocks.size === 0 || !HTML_TABLE_OPEN_RE.test(content)) {
			return `${startMarker}${content}${endMarker}`;
		}
		const segments = content.split(HTML_TABLE_SPLIT_RE);
		let out = "";
		for (const segment of segments) {
			if (!segment) {
				continue;
			}
			out += `${startMarker}${segment}${endMarker}`;
		}
		return out;
	};

	// A changed GFM table must be marked as a whole block, not word by word:
	// `extractDiffWrappedTables` only recognises a table when the markers
	// TIGHTLY wrap it, and that is also what lets phase 3 render it into the
	// `diff-table-{added,deleted}` div that `stripDiffTags` understands on
	// save. Split each changed part on the placeholder boundary so the table
	// gets its own marker pair and the surrounding prose keeps word-level
	// granularity.
	const wrapPartWithMarkers = (
		value: string,
		startMarker: string,
		endMarker: string,
	): string => {
		if (gfmBlocks.size === 0 || !GFM_TABLE_PLACEHOLDER.test(value)) {
			return wrapWithMarkers(
				restoreHtmlTables(value, htmlBlocks),
				startMarker,
				endMarker,
			);
		}

		let out = "";
		for (const segment of value.split(GFM_TABLE_PLACEHOLDER_SPLIT)) {
			if (!segment) {
				continue;
			}
			const table = gfmBlocks.get(segment);
			if (table) {
				// Tight wrap, on its own lines so the block parser still sees a
				// table once the markers are stripped out again.
				out += `\n\n${startMarker}${table}${endMarker}\n\n`;
				continue;
			}
			out += wrapWithMarkers(
				restoreHtmlTables(segment, htmlBlocks),
				startMarker,
				endMarker,
			);
		}
		return out;
	};

	const restoreAll = (value: string): string =>
		restoreHtmlTables(restoreHtmlTables(value, gfmBlocks), htmlBlocks);

	let result = "";
	changes.forEach((part) => {
		// Use placeholder tokens instead of HTML tags
		// These will be replaced with actual tags after markdown processing
		if (part.added) {
			result += wrapPartWithMarkers(
				part.value,
				DIFF_ADD_START,
				DIFF_ADD_END,
			);
		} else if (part.removed) {
			result += wrapPartWithMarkers(
				part.value,
				DIFF_DEL_START,
				DIFF_DEL_END,
			);
		} else {
			result += restoreAll(part.value);
		}
	});

	if (oldProcessed.length > newProcessed.length && !isComplete) {
		// Note: the slice above can bisect a placeholder mid-token while
		// streaming, leaving its literal text in the tail. The HTML-table path
		// has always had the same exposure; the final render always runs with
		// `isComplete = true`, which skips the truncation entirely.
		result += restoreAll(oldProcessed.slice(newProcessed.length));
	}

	return result;
}

/**
 * Convert markdown to HTML with proper handling of diff markers
 *
 * Uses a three-phase approach to handle tables wrapped in diff markers:
 *
 * Phase 1: Extract tables wrapped in diff markers (they break block-level parsing)
 * Phase 2: Render markdown with MarkdownIt plugin for inline diff markers
 * Phase 3: Render extracted tables separately and reinsert with highlighting
 *
 * The MarkdownIt plugin approach is safer than post-render regex replacement
 * because markers are recognized as proper tokens within the Markdown structure.
 */
export interface FromMarkdownOptions {
	/**
	 * Merge orphan paragraph/bullet continuations into the preceding bullet
	 * (issue #737). Defaults to `true`.
	 *
	 * Pass `false` when loading *stored user content* into an
	 * editable editor. The heuristic is designed for LLM-emitted markdown that
	 * wraps long bullets to column 0; on hand-written lists it merges genuinely
	 * separate bullets, and StoryWorkspace's Effect 4 then writes the rewrite
	 * back to the database.
	 */
	repairLegacyBullets?: boolean;
}

const INLINE_TAGS = "ins|del|strong|em|s|code|a|mark|span";
const SPACE_BETWEEN_INLINE_TAGS_RE = new RegExp(
	`(</(?:${INLINE_TAGS})>)([ \\t]*\\n\\s*)(<(${INLINE_TAGS})\\b[^>]*>)`,
	"g",
);

/**
 * A soft line break between two inline elements (`</ins>\n<ins …>`, two lines
 * the AI added to one paragraph) is a whitespace-only text node, and TipTap
 * drops those when it parses HTML, gluing `line.Next` together on accept.
 * Move the space into the neighbouring insertion, which accepting keeps as
 * plain text. Other pairs are left alone: a space inside `<code>` or `<em>`
 * would change the code or break the emphasis. Inside a code block the line
 * break and indent are content, so they move into the insertion unchanged.
 */
function keepSpaceBetweenInlineTags(html: string): string {
	return html
		.split(/(<pre\b[\s\S]*?<\/pre>)/)
		.map((segment, index) => {
			// The split puts every whole <pre> at an odd index.
			const inCode = index % 2 === 1;
			return segment.replace(
				SPACE_BETWEEN_INLINE_TAGS_RE,
				(
					match,
					close: string,
					whitespace: string,
					open: string,
					openTag: string,
				) => {
					const kept = inCode ? whitespace : " ";
					if (openTag === "ins") {
						return `${close}${open}${kept}`;
					}
					return close === "</ins>"
						? `${kept}${close}${open}`
						: match;
				},
			);
		})
		.join("");
}

export function fromMarkdown(
	text: string | undefined,
	options?: FromMarkdownOptions,
): string {
	if (!text) {
		return "";
	}

	// Phase 1: Extract tables wrapped in diff markers FIRST
	// This must happen before fixAIMarkdownIssues which moves markers around
	// Tables wrapped in markers would break MarkdownIt's block-level parsing
	const firstPass = extractDiffWrappedTables(text);

	// Phase 1-bis: Whatever is left may still be a table with markers stranded
	// inside its rows — the shape word-level diffing used to emit, and the
	// shape already-damaged stored documents arrive in. Extraction only
	// recognises a table with a clean separator row, so lift the markers out
	// and look again. (`fixAIMarkdownIssues` also repairs marker placement but
	// runs several phases too late to rescue extraction.) Running this AFTER
	// the first pass is what keeps it from dismantling well-formed wraps.
	const sanitized = sanitizeTableMarkerPlacement(firstPass.processed);
	const secondPass =
		sanitized === firstPass.processed
			? null
			: extractDiffWrappedTables(sanitized, firstPass.tables.length);

	const textWithPlaceholders = secondPass
		? secondPass.processed
		: firstPass.processed;
	const tables = secondPass
		? [...firstPass.tables, ...secondPass.tables]
		: firstPass.tables;

	// Phase 1a-pre: Extract HTML `<table>…</table>` blocks wrapped in DIFF
	// markers. `diffPartialText` substitutes HTML tables as atomic tokens
	// before word-diffing (issue #714); when the table content changed
	// in-place that produces `DEL<table…/table>END ADD<table…/table>END`.
	// Multi-line HTML inside DIFF markers would be shredded by
	// `splitMultilineDiffBlocks`, so pull these out here and reinject as
	// `<div class="diff-table-{added,deleted}">…</div>` in phase 3 — same
	// treatment markdown-table wrapping already gets above.
	const { processed: textAfterHtmlTables, htmlTables } =
		extractDiffWrappedHtmlTables(textWithPlaceholders);

	// Phase 1a-bis: Extract fenced code blocks that are ENTIRELY wrapped in
	// a single ADD_START…ADD_END or DEL_START…DEL_END. Diff markers on a
	// fence's opening line prevent MarkdownIt from recognising the fence,
	// and per-line wrapping would turn `ADD_START```bashADD_END` into
	// garbage. Pulling them out here lets us render the code block cleanly
	// and reinject it with its content in one diff mark.
	const { processed: textWithoutFences, fences } =
		extractDiffWrappedFences(textAfterHtmlTables);

	// Phase 1b: Fuse word-fragmented diff blocks, then split multi-line
	// ADD/DEL bodies into per-line runs so MarkdownIt's BLOCK parser sees
	// lists/headings/paragraphs. Reconstruct any lines whose markers split
	// a block prefix across DEL+ADD bodies (heading-level change, HR add)
	// into whole-line pairs; if reconstruction added new pairs, re-run
	// the per-line wrap so the reconstructed bodies parse as the right
	// block element.
	const mergedText = mergeAdjacentDiffBlocks(textWithoutFences);
	const splitOnce = splitMultilineDiffBlocks(mergedText);
	const reconstructedText = reconstructBrokenStructureLines(splitOnce);
	const splitText =
		reconstructedText === splitOnce
			? splitOnce
			: splitMultilineDiffBlocks(reconstructedText);

	// Fix common AI markdown issues after table extraction
	const fixedText = fixAIMarkdownIssues(splitText);

	// Phase 1c: Merge orphan paragraph continuations into preceding bullets.
	// LLM-emitted markdown often wraps long bullets to column 0 on the next
	// line, which CommonMark parses as a sibling paragraph and breaks the
	// list. See `mergeOrphanBulletContinuations` doc for the heuristic.
	// Issue #737. Opt out for hand-authored content — Fizzy #1987.
	const repairedText =
		options?.repairLegacyBullets === false
			? fixedText
			: mergeOrphanBulletContinuations(fixedText);

	// Phase 2: Render markdown with diff marker plugin
	const md = createMarkdownIt();
	let html = md.render(repairedText);

	// Phase 3: Render extracted tables and reinsert with highlighting
	if (tables.length > 0) {
		// Create a fresh MarkdownIt instance for tables (no diff markers in clean tables)
		const tableMd = new MarkdownIt({
			typographer: false,
			html: true,
		});

		tables.forEach((table, index) => {
			const tableHtml = markTableWithDiffType(
				tableMd.render(table.markdown),
				table.type,
			);
			const highlightClass =
				table.type === "added"
					? "diff-table-added"
					: "diff-table-deleted";

			// Wrap the table in a highlighting container
			// Using a div wrapper preserves valid HTML structure
			const wrappedTable = `<div class="${highlightClass}">${tableHtml}</div>`;

			html = html.replace(`<!--DIFF_TABLE_${index}-->`, wrappedTable);
		});
	}

	// Phase 3a-pre: Reinject extracted diff-wrapped HTML tables.
	// Mirrors the markdown-table treatment above: wrap in a
	// `<div class="diff-table-{added,deleted}">` so `stripDiffTags` can
	// drop deleted tables wholesale and unwrap added ones on save.
	if (htmlTables.length > 0) {
		htmlTables.forEach((entry, index) => {
			const wrapped = `<div class="diff-table-${entry.type}">${markTableWithDiffType(entry.html, entry.type)}</div>`;
			html = html.replace(`<!--DIFF_HTML_TABLE_${index}-->`, wrapped);
		});
	}

	// Phase 3b: Reinject extracted diff-wrapped fences.
	//
	// A removed or added fence stays a code block, its whole content in one
	// diff mark. Code blocks and diagrams admit the two diff marks, so the
	// review bar accepts or rejects the block as one change and the source
	// never lands outside it as paragraphs. Accepting a removal or rejecting
	// an addition empties the block; the review bar and `stripDiffTags` then
	// drop it.
	if (fences.length > 0) {
		fences.forEach((fence, index) => {
			const langAttr = fence.language
				? ` class="language-${fence.language}"`
				: "";
			const tag = fence.type === "added" ? "ins" : "del";
			const markClass = fence.type === "added" ? "diff-ins" : "diff-del";
			const content = fence.code
				? `<${tag} class="${markClass}">${escapeHtml(fence.code)}</${tag}>`
				: "";
			html = html.replace(
				`<!--DIFF_FENCE_${index}-->`,
				`<pre><code${langAttr}>${content}</code></pre>`,
			);
		});
	}

	// Fallback: Replace any remaining markers that weren't handled by the plugin
	// This can happen if markers appear in contexts where inline rules don't run
	// (e.g., inside code blocks, which is fine - we don't want to highlight code)
	html = html
		.replace(
			new RegExp(escapeRegExp(DIFF_ADD_START), "g"),
			'<ins class="diff-ins">',
		)
		.replace(new RegExp(escapeRegExp(DIFF_ADD_END), "g"), "</ins>")
		.replace(
			new RegExp(escapeRegExp(DIFF_DEL_START), "g"),
			'<del class="diff-del">',
		)
		.replace(new RegExp(escapeRegExp(DIFF_DEL_END), "g"), "</del>");

	html = keepSpaceBetweenInlineTags(html);

	// Normalize tables for TipTap compatibility
	// MarkdownIt produces tables with <thead> and <tbody> wrappers, but TipTap's
	// Table extension doesn't parse these correctly. Strip the wrappers while
	// keeping the content to give TipTap a flat <table><tr>...</tr></table> structure.
	html = normalizeTables(html);

	return html;
}

/**
 * Convert diff placeholder tokens to HTML tags (without markdown processing)
 *
 * Use this for plain text content that doesn't need markdown rendering.
 * For markdown content, use fromMarkdown() instead which handles both.
 */
export function diffToHtml(text: string | undefined): string {
	if (!text) {
		return "";
	}

	// Escape HTML entities in the content first (but not our placeholders)
	let html = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

	// Replace placeholder tokens with actual HTML tags (class-tagged so the
	// TipTap DiffInsert/DiffDelete marks can distinguish these from pasted
	// bare <ins>/<del>).
	html = html
		.replace(
			new RegExp(escapeRegExp(DIFF_ADD_START), "g"),
			'<ins class="diff-ins">',
		)
		.replace(new RegExp(escapeRegExp(DIFF_ADD_END), "g"), "</ins>")
		.replace(
			new RegExp(escapeRegExp(DIFF_DEL_START), "g"),
			'<del class="diff-del">',
		)
		.replace(new RegExp(escapeRegExp(DIFF_DEL_END), "g"), "</del>");

	return html;
}

/**
 * Strip deletion markers AND their content from diff text.
 * Keeps addition markers intact for highlighting.
 * Used for side-by-side diff: left panel shows only the "new" text with additions highlighted.
 */
export function stripDiffDeletions(diffText: string): string {
	const pattern = new RegExp(
		`${escapeRegExp(DIFF_DEL_START)}[\\s\\S]*?${escapeRegExp(DIFF_DEL_END)}`,
		"g",
	);
	return diffText.replace(pattern, "");
}

/**
 * Strip addition markers AND their content from diff text.
 * Keeps deletion markers intact for highlighting.
 * Used for side-by-side diff: right panel shows only the "old" text with deletions highlighted.
 */
export function stripDiffAdditions(diffText: string): string {
	const pattern = new RegExp(
		`${escapeRegExp(DIFF_ADD_START)}[\\s\\S]*?${escapeRegExp(DIFF_ADD_END)}`,
		"g",
	);
	return diffText.replace(pattern, "");
}

/**
 * Strip diff markup from text (removes <ins> and <del> tags used for diff highlighting)
 * Also removes placeholder tokens in case they haven't been converted yet.
 * Uses <ins>/<del> which map to TipTap's DiffInsert/DiffDelete marks, keeping
 * ordinary italic (<em>) and strikethrough (<s>) formatting untouched.
 */
export function stripDiffMarkup(text: string | undefined): string {
	if (!text) {
		return "";
	}
	return (
		text
			// Remove HTML tags
			.replace(/<ins[^>]*>/gi, "")
			.replace(/<\/ins>/gi, "")
			.replace(/<del[^>]*>/gi, "")
			.replace(/<\/del>/gi, "")
			// Remove placeholder tokens (in case they weren't converted to HTML)
			.replace(new RegExp(escapeRegExp(DIFF_ADD_START), "g"), "")
			.replace(new RegExp(escapeRegExp(DIFF_ADD_END), "g"), "")
			.replace(new RegExp(escapeRegExp(DIFF_DEL_START), "g"), "")
			.replace(new RegExp(escapeRegExp(DIFF_DEL_END), "g"), "")
	);
}

/**
 * Remove diff marker tokens and stray zero-width characters (U+200B, U+FEFF)
 * from markdown that is about to be saved. A marker that escaped the diff
 * plugin reaches the editor as plain text, and without this pass its invisible
 * characters were written into the stored document. Ordinary non-breaking
 * spaces are left alone; only the ones inside a whole marker are removed.
 */
export function stripResidualDiffMarkers(markdown: string): string {
	return markdown
		.replace(new RegExp(ANY_MARKER_SOURCE, "g"), "")
		.replace(/[\u200B\uFEFF]/g, "");
}

// Throttle state for focusOnLastDiff
let lastScrollTime = 0;
const SCROLL_THROTTLE_MS = 150; // Scroll every 150ms for responsive following during streaming

// Track scroll position to detect user scrolling
let lastKnownScrollTop = 0;
let lastProgrammaticScrollTime = 0;
let userScrolledAway = false;

/**
 * Intelligent focus management during AI streaming
 *
 * Key behavior:
 * 1. Follows the LAST change (where AI is currently writing)
 * 2. Scrolls smoothly to keep the active writing zone visible
 * 3. Detects if user manually scrolled and respects their position
 * 4. Uses the change region from diff algorithm for smarter positioning
 * 5. Initially scrolls to top when streaming starts, then follows changes
 *
 * @param editor - The TipTap editor instance
 * @param focusAnchor - Optional heading/anchor to focus on (from agent state)
 * @param isInitialUpdate - Whether this is the first update in a streaming session
 */
export function focusOnLastDiff(
	editor: {
		view: {
			dom: HTMLElement;
			focus: () => void;
			posAtDOM: (node: Node, offset: number) => number;
		};
		commands: {
			setTextSelection: (range: { from: number; to: number }) => void;
		};
	} | null,
	focusAnchor?: string,
	isInitialUpdate = false,
): void {
	if (!editor) {
		return;
	}

	// Throttle scroll calls to prevent jittery behavior during rapid streaming
	const now = Date.now();
	if (now - lastScrollTime < SCROLL_THROTTLE_MS) {
		return;
	}
	lastScrollTime = now;

	requestAnimationFrame(() => {
		try {
			const container = editor.view.dom as HTMLElement;
			const scrollableParent = findScrollableParent(container);

			// Check if user manually scrolled away
			if (scrollableParent) {
				const currentScrollTop = scrollableParent.scrollTop;
				const scrollDelta = Math.abs(
					currentScrollTop - lastKnownScrollTop,
				);

				// If scroll position changed significantly and it wasn't from our programmatic scrolling,
				// the user scrolled manually - respect their position
				// We check if enough time has passed since our last programmatic scroll
				const timeSinceProgrammaticScroll =
					now - lastProgrammaticScrollTime;
				if (scrollDelta > 50 && timeSinceProgrammaticScroll > 300) {
					userScrolledAway = true;
				}
				lastKnownScrollTop = currentScrollTop;
			}

			// If user scrolled away, don't auto-scroll (let them browse freely)
			if (userScrolledAway) {
				return;
			}

			// For initial update, scroll to top to show the beginning of changes
			if (isInitialUpdate && scrollableParent) {
				scrollableParent.scrollTo({ top: 0, behavior: "smooth" });
				lastProgrammaticScrollTime = Date.now();
				return;
			}

			// If we have a focus anchor (section heading), try to focus on that first
			if (focusAnchor) {
				const targetElement = findAnchorElement(container, focusAnchor);
				if (targetElement && scrollableParent) {
					scrollToElementIfNeeded(targetElement, scrollableParent);
					lastProgrammaticScrollTime = Date.now();
					return;
				}
			}

			// Find all diff elements (additions marked with <ins>)
			const insElements = Array.from(container.querySelectorAll("ins"));

			// If no addition elements found, don't scroll
			if (insElements.length === 0) {
				return;
			}

			// Find the last addition element (where AI is currently writing)
			// Sort by document position to find the one furthest down
			const sortedInsElements = [...insElements].sort((a, b) => {
				const posA = a.compareDocumentPosition(b);
				return posA & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
			});

			const lastAdditionEl =
				sortedInsElements[sortedInsElements.length - 1];

			if (lastAdditionEl && scrollableParent) {
				scrollToElementIfNeeded(lastAdditionEl, scrollableParent);
				lastProgrammaticScrollTime = Date.now();
			} else if (lastAdditionEl) {
				// Fallback: scroll with "nearest" to minimize movement
				lastAdditionEl.scrollIntoView({
					block: "nearest",
					behavior: "smooth",
				});
				lastProgrammaticScrollTime = Date.now();
			}
		} catch {
			// Silently fail
		}
	});
}

/**
 * Reset scroll tracking state (call when streaming starts or ends)
 */
export function resetScrollTracking(): void {
	lastScrollTime = 0;
	lastKnownScrollTop = 0;
	lastProgrammaticScrollTime = 0;
	userScrolledAway = false;
}

/**
 * Find the scrollable parent container
 */
function findScrollableParent(element: HTMLElement): HTMLElement | null {
	let parent = element.parentElement;
	while (parent) {
		const style = window.getComputedStyle(parent);
		const overflowY = style.overflowY;
		if (overflowY === "auto" || overflowY === "scroll") {
			return parent;
		}
		parent = parent.parentElement;
	}
	return null;
}

/**
 * Find an element by anchor text (heading content)
 */
function findAnchorElement(
	container: HTMLElement,
	anchor: string,
): HTMLElement | null {
	const normalized = (s: string) =>
		s.replace(/\s+/g, " ").trim().toLowerCase();
	const targetText = normalized(anchor.replace(/^#+\s*/, ""));

	const headings = Array.from(
		container.querySelectorAll("h1, h2, h3, h4, h5, h6"),
	) as HTMLElement[];
	return (
		headings.find((h) => normalized(h.textContent || "") === targetText) ||
		null
	);
}

/**
 * Scroll to an element only if it's outside the visible area
 * Uses smooth scrolling and tries to keep element in comfortable reading position
 */
function scrollToElementIfNeeded(
	element: Element,
	scrollableParent: HTMLElement,
): void {
	const rect = element.getBoundingClientRect();
	const parentRect = scrollableParent.getBoundingClientRect();

	// Calculate comfortable margins (keep content in the middle 60% of viewport)
	const topMargin = parentRect.height * 0.2;
	const bottomMargin = parentRect.height * 0.2;

	const isAboveViewport = rect.top < parentRect.top + topMargin;
	const isBelowViewport = rect.bottom > parentRect.bottom - bottomMargin;

	if (isAboveViewport || isBelowViewport) {
		// Scroll to put the element in the upper third of the viewport
		// This gives room to see content being added below
		element.scrollIntoView({
			block: "center",
			behavior: "smooth",
		});

		// Update our tracking
		lastKnownScrollTop = scrollableParent.scrollTop;
	}
}

/**
 * Focus on a specific markdown heading anchor
 */
export function focusOnAnchor(
	editor: {
		view: {
			dom: HTMLElement;
			focus: () => void;
			posAtDOM: (node: Node, offset: number) => number;
		};
		commands: {
			setTextSelection: (range: { from: number; to: number }) => void;
			scrollIntoView: () => void;
		};
	} | null,
	anchor: string,
): void {
	if (!editor || !anchor) {
		return;
	}

	requestAnimationFrame(() => {
		try {
			const container = editor.view.dom as HTMLElement;
			const headings = Array.from(
				container.querySelectorAll("h1, h2, h3, h4, h5, h6"),
			) as HTMLElement[];

			const normalized = (s: string) => s.replace(/\s+/g, " ").trim();
			const match = headings.find(
				(h) =>
					normalized(h.textContent || "") ===
					normalized(anchor.replace(/^#+\s*/, "")),
			);

			// Fall back to diff elements if heading not found
			// We use <ins> for additions and <del> for deletions (DiffInsert/DiffDelete TipTap marks)
			const target =
				match ||
				container.querySelector("ins") ||
				container.querySelector("del");
			if (!target) {
				return;
			}

			if ("scrollIntoView" in target) {
				(target as HTMLElement).scrollIntoView({
					block: "center",
					behavior: "smooth",
				});
			}

			editor.view.focus();
			const pos = editor.view.posAtDOM(target, 0);
			if (typeof pos === "number" && pos > 0) {
				editor.commands.setTextSelection({ from: pos, to: pos });
				editor.commands.scrollIntoView();
			}
		} catch {
			// Silently fail
		}
	});
}
