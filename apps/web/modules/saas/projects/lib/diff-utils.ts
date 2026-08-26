import { repairDegradedMarkdown } from "@repo/agent-prompts/markdown-repair";
import { diffWords } from "diff";
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
 * and reinjected with a proper diff-block wrapper.)
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
		const wrapLine = (line: string, inListContext = false): string => {
			if (line.trim().length === 0) {
				return "";
			}
			const listMatch = line.match(/^(\s*(?:\d+[.)]|[-*+])\s+)(.*)$/);
			if (listMatch) {
				return `${listMatch[1]}${startMarker}${listMatch[2]}${endMarker}`;
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

		result = result.replace(re, (match, body: string, offset: number) => {
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
				return isAddSide ? wrapLine(body, inListContext) : match;
			}

			const lines = body.split("\n");
			const output: string[] = [];
			let inFence = false;
			for (const line of lines) {
				const trimmed = line.trim();
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
	for (const line of text.split("\n")) {
		const hasAdd = line.includes(DIFF_ADD_START);
		const hasDel = line.includes(DIFF_DEL_START);
		if (!hasAdd && !hasDel) {
			output.push(line);
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
			output.push(line);
			continue;
		}
		const oldLine = getOldVersionOfLine(line);
		const newLine = getNewVersionOfLine(line);
		if (oldLine === newLine) {
			output.push(line);
			continue;
		}
		const oldKind = classifyLineBlock(oldLine);
		const newKind = classifyLineBlock(newLine);
		if (newKind.kind === "hr" || oldKind.kind === "hr") {
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
					output.push(hoisted);
					continue;
				}
				// Not hoistable — fall through to the whole-line split
				// below, which renders both sides without losing the
				// deleted text.
			} else {
				output.push(line);
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
			output.push(line);
			continue;
		}
		output.push(`${DIFF_DEL_START}${oldLine}${DIFF_DEL_END}`);
		// Only `1.` may interrupt a paragraph in CommonMark, so an
		// ordered item numbered anything else would be absorbed into the
		// preceding DEL line and lose its list role. A blank line keeps
		// the two sides as separate blocks. Headings need no such break.
		if (/^\s*(?:0|[2-9]|\d{2,})[.)]\s/.test(newLine)) {
			output.push("");
		}
		output.push(`${DIFF_ADD_START}${newLine}${DIFF_ADD_END}`);
	}
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

/**
 * Fix common markdown issues from AI generation.
 *
 * AI models sometimes escape backticks incorrectly or have formatting issues.
 * This preprocessor fixes common problems before passing to MarkdownIt.
 *
 * Also handles diff markers that can break block-level structures like tables.
 */
function fixAIMarkdownIssues(text: string): string {
	let fixed = text;

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
				fenceLanguage = "";
				fenceBody = [];
				return;
			}
			output.push(`\`\`\`${fenceLanguage}`.trimEnd());
			output.push(...fenceBody);
			output.push("```");
			inFence = false;
			fenceLanguage = "";
			fenceBody = [];
		};

		for (const line of lines) {
			const trimmed = line.trim();

			if (!inFence && trimmed.startsWith("```")) {
				inFence = true;
				fenceLanguage = trimmed.slice(3).trim().toLowerCase();
				fenceBody = [];
				continue;
			}

			if (inFence && trimmed === "```") {
				flushFence();
				continue;
			}

			if (inFence) {
				if (
					!fenceLanguage &&
					fenceBody.length === 0 &&
					/^[a-z0-9_+-]+$/i.test(trimmed)
				) {
					fenceLanguage = trimmed.toLowerCase();
					continue;
				}

				const jsonLikeFence =
					fenceLanguage === "json" ||
					fenceLanguage === "plaintext" ||
					fenceLanguage === "text" ||
					fenceLanguage === "txt";
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
		/```(?:md|markdown|mdx)\s*\n([\s\S]*?)\n```/gi,
		(_match, content: string) => `\n${content.trim()}\n`,
	);

	// Some documents wrap ordinary prose or headings in ```plaintext fences.
	// If the content clearly looks like document structure rather than literal code,
	// unwrap it so existing documents render as content instead of blue code panels.
	fixed = fixed.replace(
		/```(?:plaintext|text|txt)\s*\n([\s\S]*?)\n```/gi,
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

	// Normalize escaped bullet markers like "\- Item" into proper markdown bullets.
	fixed = fixed.replace(/^(\s*)\\([-*+])(\s+)/gm, "$1$2$3");

	// Fix mermaid code blocks that might have issues
	// Some AI models output "```mermaid" without proper spacing
	fixed = fixed.replace(
		/```(mermaid|c4context|c4container|c4component|c4deployment|flowchart|sequenceDiagram|classDiagram|erDiagram|gantt|pie|mindmap|graph\s+[TL][BDRB])/gi,
		"\n```$1",
	);

	// Ensure code blocks have newlines before them
	fixed = fixed.replace(/([^\n])```/g, "$1\n```");

	// Ensure code blocks have newlines after closing fence
	fixed = fixed.replace(/```([^\n])/g, "```\n$1");

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
		/```(?:\s*\n)?(json|plaintext|text|txt)\s*\n((?:(?!```)[\s\S])*?)(\n(?:#{1,6}\s|[-*+]\s|\d+\.\s))/gi,
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
			if (!trimmed.startsWith("```")) {
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
				pendingOpenerIsBare = trimmed === "```";
				bodyNonEmpty = 0;
				bodyStructured = 0;
				bodyProse = 0;
				continue;
			}
			if (trimmed === "```") {
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

const BULLET_PATTERN = /^(\s*)(?:[-*+]|\d+\.)\s+(\S.*)$/;
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
 * body has no sentence terminator, we keep consuming continuation candidates
 * (orphan paragraph or continuation bullet) into it.
 *
 * Conservative heuristics on what counts as a continuation:
 *   - leading `[a-z(["',;:.?!\]]` only — capital-letter starts read as
 *     intentional new sentences and are left alone.
 *   - the parent bullet must not already end with `.`, `?`, or `!` (allowing
 *     a trailing closing quote or bracket).
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
	const out: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const bulletMatch = line.match(BULLET_PATTERN);
		if (!bulletMatch) {
			out.push(line);
			i++;
			continue;
		}

		// Greedy walk: consume continuation fragments into this bullet.
		let merged = line.trimEnd();
		let body = bulletMatch[2];
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
					looksLikeContinuation(candidateBullet[2]) || !!splitMarkup;
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
					if (
						wordCount(body) < 3 ||
						wordCount(candidateBullet[2]) < 3
					) {
						break;
					}
				}
				const fragment = candidateBullet[2].trim();
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
	const input = text ?? "";
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
 * surrounding whitespace. Extract and reinject as a proper `<pre><code>`
 * (ADD) or per-line `<p><del class="diff-del">line</del></p>` (DEL).
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

	processed = processed.replace(
		makePattern(DIFF_ADD_START, DIFF_ADD_END),
		(_match, language: string, code: string) => {
			const index = fences.length;
			fences.push({
				language: language.trim(),
				code,
				type: "added",
			});
			return `\n\n<!--DIFF_FENCE_${index}-->\n\n`;
		},
	);

	processed = processed.replace(
		makePattern(DIFF_DEL_START, DIFF_DEL_END),
		(_match, language: string, code: string) => {
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
	processed = processed.replace(delRegionRe, (match, body: string) => {
		if (!body.includes("```")) {
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
	});

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

		// Remove trailing whitespace
		n = n.trimEnd();

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
 * common shape is `[removed: "\\"][unchanged: "X..."]`. The rarer paired
 * shape `[removed: "\\X"][added: "X"]` is also handled.
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

	const isLoneBackslashBeforeEscapable = (
		cur: DiffPart,
		next: DiffPart | undefined,
	): boolean =>
		cur.value === "\\" &&
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
		if (cur.removed && isLoneBackslashBeforeEscapable(cur, next)) {
			merged.push({ value: "\\" });
			i += 1;
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
		diffWords(oldTextToCompare, newProcessed),
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
	// and reinject with a proper diff-block wrapper class that
	// `stripDiffTags` understands on save.
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
	// ADD fences: render as a clean `<pre><code>` block. TipTap drops any
	// outer `<div>` wrapper during parse, so the "added" highlight would be
	// lost on a wrapped variant — but the code block itself is preserved
	// and round-trips correctly through save.
	//
	// DEL fences: render as per-line `<p><del class="diff-del">…</del></p>`.
	// We can't wrap the text in `<code>` because TipTap's Code mark is
	// exclusive (`excludes: "_"`) and would strip DiffDelete during parse.
	// Plain text inside `<del class="diff-del">` survives a parse/serialize
	// round trip cleanly, and `stripDiffTags` removes every
	// `<del class="diff-del">…</del>` with content on save so the deleted
	// fence disappears entirely. The reviewer loses code styling during the
	// diff view but the save is correct.
	if (fences.length > 0) {
		fences.forEach((fence, index) => {
			let replacement: string;
			if (fence.type === "added") {
				const langAttr = fence.language
					? ` class="language-${fence.language}"`
					: "";
				replacement = `<pre><code${langAttr}>${escapeHtml(fence.code)}</code></pre>`;
			} else {
				const lines = fence.code.split("\n");
				replacement = lines
					.map((line) => {
						if (line.length === 0) {
							return "";
						}
						return `<p><del class="diff-del">${escapeHtml(line)}</del></p>`;
					})
					.filter((paragraph) => paragraph.length > 0)
					.join("");
			}
			html = html.replace(`<!--DIFF_FENCE_${index}-->`, replacement);
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
