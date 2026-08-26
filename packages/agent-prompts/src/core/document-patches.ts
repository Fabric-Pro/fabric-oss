/**
 * Document Patches
 *
 * Heading-anchored patch operations for targeted markdown edits.
 *
 * The problem this solves: forcing an LLM to rewrite an entire document on
 * every small edit is slow, expensive, and — when the document is large —
 * causes silent truncation when the output exceeds the model's max_tokens
 * budget. Documented in docs/plans/2026-04-10-selective-document-editing.md.
 *
 * The approach: the LLM emits a small list of targeted operations
 * (replace_section, insert_after, replace_text, etc.) anchored by heading
 * path strings like "## Requirements > ### Must Have". The applier here
 * resolves every anchor against the untouched baseline, checks for range
 * overlaps, and splices the document in a single pass.
 *
 * All-or-nothing semantics: if any patch fails validation, the original
 * document is returned unchanged along with the full error list for the
 * caller to feed back to the model in a retry loop.
 *
 * This module has no LangGraph or agent-core dependencies and is fully
 * unit-testable. It only depends on parseHeadings from markdown-parser.
 */

import type { Root as MdastRoot } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { type Processor, unified } from "unified";
import type { Node, Parent } from "unist";
import { visit } from "unist-util-visit";
import {
	type ParsedHeading,
	parseHeadings,
} from "../validation/markdown-parser";

// Lazy singleton — `unified()` returns a fresh processor each call; we want
// one parse-only processor reused across all validate calls.
let cachedProcessor: Processor<MdastRoot, MdastRoot, MdastRoot> | null = null;
function getMarkdownProcessor(): Processor<MdastRoot, MdastRoot, MdastRoot> {
	if (!cachedProcessor) {
		cachedProcessor = unified()
			.use(remarkParse)
			.use(remarkGfm) as unknown as Processor<
			MdastRoot,
			MdastRoot,
			MdastRoot
		>;
	}
	return cachedProcessor;
}

// Recursively collect all `text` node values under a node, joined by a space.
// Used to detect empty list items where the AST contains nested paragraph/text
// children that may all be whitespace-only. Cast required because mdast's
// generic Node type doesn't expose `value` on text nodes through unist-util-visit.
function collectText(node: Node): string {
	const out: string[] = [];
	visit(node, "text", (textNode: { value: string }) => {
		out.push(textNode.value);
	});
	return out.join(" ");
}

// Walk a node's children depth-first and return the value of the first `text`
// node encountered, or null if none exists. Used to inspect the leading
// content of paragraphs and list items.
function firstTextValue(node: Node): string | null {
	if (node.type === "text") {
		return (node as unknown as { value: string }).value;
	}
	const parent = node as Parent;
	if (!parent.children) {
		return null;
	}
	for (const child of parent.children) {
		if (child.type === "text") {
			return (child as unknown as { value: string }).value;
		}
		const nested = firstTextValue(child);
		if (nested !== null) {
			return nested;
		}
	}
	return null;
}

// =============================================================================
// Public types
// =============================================================================

export type PatchOp =
	| "replace_section"
	| "insert_after"
	| "insert_before"
	| "append_to_section"
	| "prepend_to_section"
	| "delete_section"
	| "replace_text";

export interface DocumentPatch {
	op: PatchOp;
	/**
	 * Full heading path, e.g. "## Requirements > ### Must Have".
	 *
	 * Required for every op EXCEPT `replace_text`, where it's optional.
	 * For `replace_text`, omitting the anchor searches the entire document
	 * for the `find` string — this is the simplest, most reliable shape and
	 * the one all popular LLMs (Claude, GPT, Gemini, Llama) handle natively
	 * because it matches the find/replace primitive they've seen in
	 * pretraining (Aider SEARCH/REPLACE, Anthropic str_replace, OpenAI V4A).
	 * Use the anchor only when the find string isn't unique document-wide.
	 */
	anchor?: string;
	/** New/replacement markdown. Required for every op except delete_section and replace_text. */
	content?: string;
	/** Literal string to find. Required only for replace_text. */
	find?: string;
	/** Replacement string. Required only for replace_text. */
	replace?: string;
	/**
	 * replace_text only: replace EVERY occurrence of `find` in the search
	 * scope (whole document if anchor-less, otherwise the anchored section).
	 * Default false, which keeps the strict must-match-exactly-once contract.
	 */
	replaceAll?: boolean;
	/** replace_section only: if false, also replaces the heading line itself. Default true. */
	keepHeading?: boolean;
}

export type PatchErrorCode =
	| "anchor_not_found"
	| "anchor_ambiguous"
	| "missing_content"
	| "missing_find_replace"
	| "find_not_in_section"
	| "find_ambiguous_in_section"
	| "overlapping_ranges"
	| "malformed_anchor"
	| "unsupported_op"
	| "invalid_replacement_content"
	| "excessive_content_loss"
	| "duplicate_heading_in_replace_section"
	| "invalid_document_structure";

export interface PatchError {
	patchIndex: number;
	op: PatchOp;
	anchor: string;
	code: PatchErrorCode;
	message: string;
	/** Candidate anchors, nearest substrings, etc. — whatever helps the model retry. */
	suggestions?: string[];
	/**
	 * Populated only for `overlapping_ranges`. Carries the line ranges of both
	 * conflicting patches so callers building retry hints can identify the
	 * dominant patch without parsing the message text. `otherIndex` is the
	 * original patch index of the partner in the overlap.
	 */
	overlapRanges?: {
		self: { startLine: number; endLine: number };
		other: { startLine: number; endLine: number };
		otherIndex: number;
	};
}

/** Per-patch occurrence accounting for replace_text patches. */
export interface ReplaceTextStat {
	patchIndex: number;
	/** The patch's `find` string, verbatim. */
	find: string;
	/** Number of occurrences this patch replaced. */
	occurrences: number;
	replaceAll: boolean;
	/**
	 * For replaceAll patches: occurrences of `find` (whitespace-normalized)
	 * still present in the final document after apply — typically left
	 * outside an anchored search scope, or formed at replacement
	 * boundaries. Always 0 when `replace` contains `find`, because then
	 * the replacement itself would self-count as a residual.
	 */
	residualOccurrences: number;
}

export interface ApplyPatchesResult {
	success: boolean;
	/** Original document on any failure; patched doc on success. */
	result: string;
	errors: PatchError[];
	appliedCount: number;
	/**
	 * Full anchor paths for every heading in the baseline. Populated only when
	 * `errors.length > 0`, so callers building retry messages don't have to
	 * re-parse the document via a separate `listAnchorPaths` call.
	 */
	availableAnchorPaths?: string[];
	/**
	 * Occurrence accounting for every replace_text patch in the call.
	 * Populated only on success.
	 */
	replaceTextStats?: ReplaceTextStat[];
}

export interface ValidatePatchesResult {
	valid: boolean;
	errors: PatchError[];
}

export interface ResolvedAnchor {
	startLine: number; // 1-indexed, heading line
	endLine: number; // 1-indexed, last line of the section (inclusive)
	level: number;
	text: string;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Attach an endLine to every heading, where endLine is "one line before the
 * next heading of equal or shallower level, or the end of the document".
 * This flattens the heading list while preserving range information the
 * default parseSections doesn't expose for non-H2 nodes.
 */
interface HeadingWithRange extends ParsedHeading {
	endLine: number;
}

function flattenHeadingsWithRanges(
	headings: ParsedHeading[],
	totalLines: number,
): HeadingWithRange[] {
	return headings.map((heading, i) => {
		let endLine = totalLines;
		for (let j = i + 1; j < headings.length; j++) {
			if (headings[j].level <= heading.level) {
				endLine = headings[j].line - 1;
				break;
			}
		}
		return { ...heading, endLine };
	});
}

/** Normalize whitespace: collapse internal runs, trim, strip trailing punctuation. */
function normalizeHeadingText(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[:.;,!?]+$/, "");
}

/** Parse a single path segment like "## Overview" or "### Must Have" into {level, text}. */
function parsePathSegment(
	segment: string,
): { level: number; text: string } | null {
	const match = segment.trim().match(/^(#{1,6})\s+(.+)$/);
	if (!match) {
		return null;
	}
	return { level: match[1].length, text: match[2].trim() };
}

/** Split an anchor string on " > " into path segments. */
function splitAnchorPath(anchor: string): string[] {
	return anchor
		.split(">")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Levenshtein distance. Small, dependency-free, used only for nearest-match
 * suggestions in error messages.
 */
function levenshtein(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	if (a.length === 0) {
		return b.length;
	}
	if (b.length === 0) {
		return a.length;
	}
	const matrix: number[][] = [];
	for (let i = 0; i <= b.length; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= a.length; j++) {
		matrix[0][j] = j;
	}
	for (let i = 1; i <= b.length; i++) {
		for (let j = 1; j <= a.length; j++) {
			if (b.charAt(i - 1) === a.charAt(j - 1)) {
				matrix[i][j] = matrix[i - 1][j - 1];
			} else {
				matrix[i][j] = Math.min(
					matrix[i - 1][j - 1] + 1,
					matrix[i][j - 1] + 1,
					matrix[i - 1][j] + 1,
				);
			}
		}
	}
	return matrix[b.length][a.length];
}

/** Rank `candidates` by Levenshtein distance to `target`, return the top N. */
function nearestByLevenshtein(
	target: string,
	candidates: string[],
	n: number,
): string[] {
	return candidates
		.map((c) => ({
			c,
			d: levenshtein(target.toLowerCase(), c.toLowerCase()),
		}))
		.sort((a, b) => a.d - b.d)
		.slice(0, n)
		.map((x) => x.c);
}

/** Build the full heading path for a given heading index (e.g. "## Overview > ### Goals"). */
function buildHeadingPath(
	headings: ParsedHeading[],
	targetIndex: number,
): string {
	const segments: string[] = [];
	let currentLevel = headings[targetIndex].level;
	for (let i = targetIndex; i >= 0; i--) {
		if (headings[i].level <= currentLevel) {
			segments.unshift(
				`${"#".repeat(headings[i].level)} ${headings[i].text}`,
			);
			currentLevel = headings[i].level - 1;
			if (currentLevel < 1) {
				break;
			}
		}
	}
	return segments.join(" > ");
}

/** Trigram set for substring similarity. */
function trigrams(s: string): Set<string> {
	const out = new Set<string>();
	const padded = `  ${s.toLowerCase()}  `;
	for (let i = 0; i < padded.length - 2; i++) {
		out.add(padded.slice(i, i + 3));
	}
	return out;
}

/** Overlap score 0..1 between two trigram sets. */
function trigramOverlap(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) {
		return 0;
	}
	let common = 0;
	for (const t of a) {
		if (b.has(t)) {
			common++;
		}
	}
	return common / Math.max(a.size, b.size);
}

/** Rank `candidates` by trigram overlap with `target`, return the top N. */
function nearestByTrigram(
	target: string,
	candidates: string[],
	n: number,
): string[] {
	const targetGrams = trigrams(target);
	return candidates
		.map((c) => ({ c, s: trigramOverlap(targetGrams, trigrams(c)) }))
		.sort((a, b) => b.s - a.s)
		.slice(0, n)
		.map((x) => x.c);
}

/** Normalize a body of text for whitespace-insensitive indexOf. */
function normalizeWhitespace(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");
}

/**
 * Build a map from normalized character offset → original character offset
 * so we can map a match found in a normalized buffer back to the untouched
 * source. Each normalized character corresponds to the first original
 * character that produced it during normalization.
 */
function buildNormalizationMap(original: string): {
	normalized: string;
	map: number[];
} {
	const map: number[] = [];
	let normalized = "";
	let i = 0;
	while (i < original.length) {
		const ch = original[i];
		if (ch === "\r") {
			// \r\n → \n ; lone \r → \n
			if (i + 1 < original.length && original[i + 1] === "\n") {
				map.push(i);
				normalized += "\n";
				i += 2;
				continue;
			}
			map.push(i);
			normalized += "\n";
			i += 1;
			continue;
		}
		if (ch === " " || ch === "\t") {
			const startIdx = i;
			while (
				i < original.length &&
				(original[i] === " " || original[i] === "\t")
			) {
				i++;
			}
			map.push(startIdx);
			normalized += " ";
			continue;
		}
		map.push(i);
		normalized += ch;
		i++;
	}
	// Sentinel so we can compute the original end index for a normalized match.
	map.push(original.length);
	return { normalized, map };
}

// =============================================================================
// Public functions
// =============================================================================

/**
 * Normalize line endings so downstream matching/slicing is CRLF-agnostic.
 * The JavaScript regex `.` does not match `\r`, so parseHeadings would miss
 * `## Overview\r` entirely without this step.
 */
function normalizeLineEndings(markdown: string): string {
	return markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Build the anchor-path list for an already-parsed heading array. Shared
 * between `listAnchorPaths` (the public entry point) and `applyPatches`
 * (which reuses its own parse on the error path).
 */
function buildAnchorPathsFromHeadings(headings: ParsedHeading[]): string[] {
	return headings.map((_, i) => buildHeadingPath(headings, i));
}

/**
 * Single-slot memo for `listAnchorPaths`. Within a single agent turn the
 * prompt builder and several other callers pass the same baseline document.
 * Reference equality short-circuits the parse entirely; a length-plus-hash
 * fallback catches the case where a caller reconstructed the same string.
 */
let anchorPathsMemoKey: string | null = null;
let anchorPathsMemoValue: string[] | null = null;

/**
 * List every section in the document as its full anchor path. Paths use
 * ` > ` to separate levels, e.g.:
 *
 *   [
 *     "## Overview",
 *     "## Overview > ### Problem",
 *     "## Overview > ### Goals",
 *     "## Scope",
 *   ]
 */
export function listAnchorPaths(markdown: string): string[] {
	if (anchorPathsMemoKey === markdown && anchorPathsMemoValue !== null) {
		return anchorPathsMemoValue;
	}
	const result = buildAnchorPathsFromHeadings(
		parseHeadings(normalizeLineEndings(markdown)),
	);
	anchorPathsMemoKey = markdown;
	anchorPathsMemoValue = result;
	return result;
}

/**
 * Resolve a single anchor path to a section range on the given document.
 * Returns a PatchError (with patchIndex=0) on failure, so callers can surface
 * a consistent error shape without wrapping the result.
 */
export function resolveAnchor(
	markdown: string,
	anchor: string,
): ResolvedAnchor | PatchError {
	const normalized = normalizeLineEndings(markdown);
	const headings = parseHeadings(normalized);
	const totalLines = normalized.split("\n").length;
	const flat = flattenHeadingsWithRanges(headings, totalLines);
	return resolveAnchorInternal(flat, anchor, 0, "replace_section");
}

function resolveAnchorInternal(
	headings: HeadingWithRange[],
	anchor: string,
	patchIndex: number,
	op: PatchOp,
): ResolvedAnchor | PatchError {
	const segments = splitAnchorPath(anchor);
	if (segments.length === 0) {
		return {
			patchIndex,
			op,
			anchor,
			code: "malformed_anchor",
			message: `Anchor is empty. Use a full heading path like "## Overview".`,
		};
	}

	const parsedSegments: { level: number; text: string }[] = [];
	for (const seg of segments) {
		const parsed = parsePathSegment(seg);
		if (!parsed) {
			return {
				patchIndex,
				op,
				anchor,
				code: "malformed_anchor",
				message: `Anchor segment "${seg}" is not a valid markdown heading. Expected format like "## Overview".`,
			};
		}
		parsedSegments.push(parsed);
	}

	// Walk the heading list with a matching cascade per segment.
	// Candidates at each step are heading indices whose scope (startLine..endLine)
	// must contain the eventual match.
	let candidateIndices: number[] = headings.map((_h, i) => i);
	let parentIndex: number | null = null;

	for (let segIdx = 0; segIdx < parsedSegments.length; segIdx++) {
		const seg = parsedSegments[segIdx];
		const parentRange: { start: number; end: number } =
			parentIndex !== null
				? {
						start: headings[parentIndex].line + 1,
						end: headings[parentIndex].endLine,
					}
				: { start: 0, end: Number.POSITIVE_INFINITY };

		// Filter candidates by level match AND being inside parent's range.
		const scopedCandidates: number[] = candidateIndices.filter(
			(idx: number) => {
				const h = headings[idx];
				return (
					h.level === seg.level &&
					h.line >= parentRange.start &&
					h.line <= parentRange.end
				);
			},
		);

		// Match cascade: exact → whitespace/punctuation-normalized.
		let matches: number[] = scopedCandidates.filter(
			(idx: number) => headings[idx].text === seg.text,
		);
		if (matches.length === 0) {
			const normalizedTarget = normalizeHeadingText(seg.text);
			matches = scopedCandidates.filter(
				(idx: number) =>
					normalizeHeadingText(headings[idx].text) ===
					normalizedTarget,
			);
		}

		if (matches.length === 0) {
			// No match — suggest the nearest sibling headings at this level/scope.
			const siblingTexts = scopedCandidates.map(
				(idx: number) => headings[idx].text,
			);
			const levenshteinNearest = nearestByLevenshtein(
				seg.text,
				siblingTexts,
				3,
			);
			// If the scoped pool is empty, fall back to all headings at the right level.
			const suggestions =
				levenshteinNearest.length > 0
					? levenshteinNearest.map(
							(t) => `${"#".repeat(seg.level)} ${t}`,
						)
					: headings
							.filter((h) => h.level === seg.level)
							.slice(0, 3)
							.map((h) => `${"#".repeat(h.level)} ${h.text}`);
			return {
				patchIndex,
				op,
				anchor,
				code: "anchor_not_found",
				message: `No heading matches segment "${"#".repeat(seg.level)} ${seg.text}" (segment ${segIdx + 1} of ${parsedSegments.length}).`,
				suggestions,
			};
		}

		if (matches.length > 1) {
			// Ambiguous — return full paths for all matches.
			const ambiguousPaths = matches.map((idx: number) =>
				buildHeadingPath(headings, idx),
			);
			return {
				patchIndex,
				op,
				anchor,
				code: "anchor_ambiguous",
				message: `Segment "${"#".repeat(seg.level)} ${seg.text}" matches ${matches.length} headings. Disambiguate using a full parent path.`,
				suggestions: ambiguousPaths,
			};
		}

		// Exactly one match.
		parentIndex = matches[0];
		const resolvedParentIndex = parentIndex;
		// For the next segment, candidates are headings inside this range.
		candidateIndices = headings
			.map((_h, i) => i)
			.filter(
				(i: number) =>
					headings[i].line > headings[resolvedParentIndex].line &&
					headings[i].line <= headings[resolvedParentIndex].endLine,
			);
	}

	if (parentIndex === null) {
		return {
			patchIndex,
			op,
			anchor,
			code: "anchor_not_found",
			message: `Anchor "${anchor}" did not resolve.`,
		};
	}

	const hit = headings[parentIndex];
	return {
		startLine: hit.line,
		endLine: hit.endLine,
		level: hit.level,
		text: hit.text,
	};
}

// =============================================================================
// Validation & application
// =============================================================================

function isPatchError(x: unknown): x is PatchError {
	return (
		typeof x === "object" &&
		x !== null &&
		"code" in (x as Record<string, unknown>) &&
		"message" in (x as Record<string, unknown>)
	);
}

function validatePatchShape(
	patch: DocumentPatch,
	patchIndex: number,
): PatchError | null {
	const { op } = patch;
	const anchor: string = patch.anchor ?? "";
	if (!op) {
		return {
			patchIndex,
			op: "replace_section",
			anchor: anchor || "",
			code: "malformed_anchor",
			message: `Patch is missing required "op" field.`,
		};
	}
	// Anchor is optional only for `replace_text` — when omitted, the find
	// string is searched against the entire document. This is the preferred
	// path: it works the same way Anthropic's str_replace_based_edit_tool
	// works and matches the Aider SEARCH/REPLACE format every popular model
	// (Claude, GPT, Gemini, Llama) has seen in pretraining. For all other
	// ops the anchor remains required because they operate on heading
	// scopes by definition.
	if (!anchor && op !== "replace_text") {
		return {
			patchIndex,
			op,
			anchor: "",
			code: "malformed_anchor",
			message: `Patch is missing required "anchor" field. Only replace_text may omit the anchor (which makes the find string search the whole document).`,
		};
	}
	const supportedOps: PatchOp[] = [
		"replace_section",
		"insert_after",
		"insert_before",
		"append_to_section",
		"prepend_to_section",
		"delete_section",
		"replace_text",
	];
	if (!supportedOps.includes(op)) {
		return {
			patchIndex,
			op,
			anchor,
			code: "unsupported_op",
			message: `Operation "${op}" is not supported. Use one of: ${supportedOps.join(", ")}.`,
		};
	}
	if (op === "replace_text") {
		if (typeof patch.find !== "string" || patch.find.length === 0) {
			return {
				patchIndex,
				op,
				anchor,
				code: "missing_find_replace",
				message: `replace_text requires a non-empty "find" field.`,
			};
		}
		if (typeof patch.replace !== "string") {
			return {
				patchIndex,
				op,
				anchor,
				code: "missing_find_replace",
				message: `replace_text requires a "replace" field (can be an empty string).`,
			};
		}
	} else if (op !== "delete_section") {
		if (typeof patch.content !== "string") {
			return {
				patchIndex,
				op,
				anchor,
				code: "missing_content",
				message: `${op} requires a "content" field.`,
			};
		}
	}
	return null;
}

// Count fenced-code-block boundary lines (lines starting with ``` after optional
// whitespace). An odd count means an unclosed fence. Source-level check —
// the parser silently consumes everything to EOF when a fence is unclosed,
// so the AST alone can't reliably detect it.
function countCodeFences(text: string): number {
	let n = 0;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) {
			n++;
		}
	}
	return n;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countSubstring(haystack: string, needle: string): number {
	if (needle.length === 0) {
		return 0;
	}
	let count = 0;
	let i = 0;
	while (true) {
		const idx = haystack.indexOf(needle, i);
		if (idx === -1) {
			return count;
		}
		count++;
		i = idx + needle.length;
	}
}

/**
 * Count maximal backtick runs of an exact length. Used to distinguish
 * inline-code delimiter classes: 1-runs (`` ` ``) and 2-runs (`` `` ``)
 * are different delimiters and CommonMark requires opening and closing
 * to match in length, so `` ``broken` `` (one 2-run + one 1-run) is
 * malformed even though the total run count is even. Runs of 3+ are
 * fence boundaries and are counted separately by countCodeFences.
 */
function countBacktickRunsOfLength(s: string, exactLen: number): number {
	let count = 0;
	let i = 0;
	while (i < s.length) {
		if (s[i] !== "`") {
			i++;
			continue;
		}
		let j = i;
		while (j < s.length && s[j] === "`") {
			j++;
		}
		if (j - i === exactLen) {
			count++;
		}
		i = j;
	}
	return count;
}

/**
 * Substring-level parity check for `replace_text`. Catches the case where
 * find and replace differ in marker parity (introducing or removing a
 * stranded `**`, fence, or single-backtick), which signals new structural
 * damage at the patch boundary even when the post-apply AST-based check
 * can't see it (e.g. when the document has an unclosed code fence and
 * the replacement lands AFTER the fence — content there is consumed as
 * code by the parser and doesn't reach text-node visitors).
 *
 * Parity rule rather than count match: balanced replacements are allowed
 * to add or remove COMPLETE pairs (find=`text`, replace=`**bold**`), but
 * any change in odd-vs-even parity strands or completes a marker against
 * surrounding context, which is the high-signal defect class.
 */
function checkReplaceTextParity(
	find: string,
	replace: string,
): { token: string; findCount: number; replaceCount: number } | null {
	// Each check is independent; a single check covers one marker family.
	// Inline-code delimiters split BY RUN LENGTH because CommonMark requires
	// opening/closing delimiters of matching length: a 1-run can only close
	// a 1-run, a 2-run can only close a 2-run. `` ``broken` `` (one 2-run +
	// one 1-run, total even) is still malformed, so collapsing them into a
	// single counter would let the imbalance through.
	const checks: Array<{ token: string; counter: (s: string) => number }> = [
		// Fence boundary lines (3+ backticks at start of line).
		{ token: "```", counter: countCodeFences },
		// Inline code single-backtick runs.
		{ token: "`", counter: (s) => countBacktickRunsOfLength(s, 1) },
		// Inline code double-backtick runs (rare but valid CommonMark).
		{ token: "``", counter: (s) => countBacktickRunsOfLength(s, 2) },
		// Bold markers — non-overlapping.
		{ token: "**", counter: (s) => countSubstring(s, "**") },
	];
	for (const { token, counter } of checks) {
		const findCount = counter(find);
		const replaceCount = counter(replace);
		if (findCount % 2 !== replaceCount % 2) {
			return { token, findCount, replaceCount };
		}
	}
	return null;
}

/**
 * Structural defect descriptor. Code identifies the kind of malformation;
 * detail is a short human-readable line for retry messages.
 *
 * Defect taxonomy (post-AST refactor):
 * - `unrendered_bold`: any case where `**` markers should have rendered as
 *   bold but didn't. Catches odd parity, no-word content (`**-**`),
 *   internal whitespace (`** Bold**`), end-of-line markers (`User **\n
 *   Story**`), and cross-paragraph spans — all of which leave literal
 *   `**` in mdast text-node values.
 * - `unclosed_code_fence`: source-level odd count of ``` boundary lines.
 *   Detected pre-parse because mdast silently consumes everything to EOF
 *   when a fence is unclosed.
 * - `unbalanced_inline_code`: backticks that fail to form an inlineCode
 *   node and survive in text-node values (or appear in unparsed
 *   positions).
 * - `orphan_list_marker`: list item with no body content.
 * - `stray_closing_bracket`: paragraph whose only content is `)`, `]`,
 *   or `}`.
 * - `leading_mid_sentence_punct`: paragraph or list item whose first text
 *   begins with `;`, `,`, `:`, `?`, or `!` — a sentence severed from its
 *   parent.
 * - `bold_followed_by_word`: a properly-rendered emphasis/strong node
 *   immediately followed by a capitalized word in the same parent (no
 *   separator). The bold parsed but the layout reads smushed.
 * - `mixed_list_markers`: an unordered list item whose text begins with
 *   `\d+\. ` AND a sibling list with ordered/unordered marker disagrees.
 */
export interface MarkdownStructureDefect {
	code:
		| "unrendered_bold"
		| "unclosed_code_fence"
		| "unbalanced_inline_code"
		| "orphan_list_marker"
		| "stray_closing_bracket"
		| "leading_mid_sentence_punct"
		| "bold_followed_by_word"
		| "mixed_list_markers"
		| "broken_table";
	detail: string;
	/**
	 * Best-effort 1-based line number where the defect was detected.
	 * Document-level defects (e.g. `unclosed_code_fence`) report 0.
	 * Used by the post-apply comparison in `applyPatches` to distinguish
	 * patch-introduced damage (line falls inside a patch's edit range) from
	 * pre-existing damage (line is in unchanged content).
	 */
	line: number;
}

/**
 * Structural sanity check for a self-contained block of markdown content.
 * Returns the first defect found, or null when content is well-formed.
 *
 * Backed by the `unified` + `remark-parse` + `remark-gfm` ecosystem: the
 * input is parsed into an mdast AST and then visited by the rules below.
 * The AST approach replaces a chain of ~10 regex-based detectors that
 * was previously catching specific patterns (`**-**`, `**,**`,
 * `User **\nStory**`, etc.); the AST handles all those classes
 * structurally — any `**` that fails to form a bold span ends up in a
 * `text` node, which the literal-`**` rule catches once.
 *
 * Rules (in order; first defect wins so the model gets one focused
 * correction per retry):
 *
 * 1. **Unclosed code fence** (source-level pre-check). When the parser
 *    sees an opening `` ``` `` it consumes everything to EOF, so the AST
 *    can't reliably report this. Count fence boundary lines in the raw
 *    text — odd ⇒ unclosed.
 * 2. **Unrendered bold** — any `text` node whose value contains literal
 *    `**`. Catches the entire family of bold malformations: unbalanced
 *    parity, no-word content (`**-**`), internal whitespace
 *    (`** Bold**`), end-of-line markers (`User **\nStory**`), and
 *    cross-paragraph spans (`**foo\n\nbar**`). Whatever the cause, the
 *    `**` ends up as literal text.
 * 3. **Unbalanced inline code** — `text` node whose value contains a
 *    backtick `` ` ``. Real inline code becomes an `inlineCode` node;
 *    surviving backticks in `text` mean the markers failed to pair.
 * 4. **Stray closing bracket** — a `paragraph` whose only child is a
 *    `text` node whose value is exactly `)`, `]`, or `}`.
 * 5. **Orphan list marker** — a `listItem` whose recursive text content
 *    is empty or whitespace only.
 * 6. **Leading mid-sentence punctuation** — a `paragraph` or `listItem`
 *    whose first text content begins with `;`, `,`, `:`, `?`, or `!`,
 *    signaling a sentence severed from its parent.
 * 7. **Bold followed by word** — an `emphasis` or `strong` node followed
 *    immediately (in the same parent's children array) by a `text` node
 *    starting with `[A-Z][a-z]`. The bold parsed but no separator was
 *    emitted between heading and body — visually smushed.
 * 8. **Mixed list markers** — a `listItem` inside an unordered `list`
 *    whose first text begins with `\d+\. ` (the model embedded an
 *    ordered marker as bullet content).
 *
 * Used by both `apply_document_patches` (per whole-content patch) and
 * `write_document_local` (whole-document write) to guarantee the same
 * baseline of well-formedness regardless of which write path the model
 * chose.
 */
export function validateMarkdownStructure(
	content: string,
): MarkdownStructureDefect | null {
	return findAllMarkdownStructureDefects(content)[0] ?? null;
}

/**
 * Returns every defect detected in the content, not just the first.
 *
 * Used by `applyPatches` to compare baseline vs. post-apply defect sets at
 * line-level precision: the post-apply check rejects only when the result
 * has a defect whose line falls inside a patch's edit range (i.e. the
 * patch introduced or moved damage into edited content) and not when a
 * pre-existing defect from elsewhere in the document carries through to
 * the result unchanged.
 */
export function findAllMarkdownStructureDefects(
	content: string,
): MarkdownStructureDefect[] {
	const defects: MarkdownStructureDefect[] = [];
	if (content.length === 0) {
		return defects;
	}

	// Pre-parse: unclosed code fences are invisible to the AST (the parser
	// silently extends the open fence to EOF). Count source fences directly.
	// Continue to AST visits even when an unclosed fence is detected — the
	// parser still produces a usable tree for content BEFORE the open fence.
	// Bailing here would mask any other defects in the prose portion (and,
	// critically, would let post-apply comparisons treat a damaged baseline
	// with an unclosed fence as covering for any new defects introduced by
	// patches in the pre-fence content).
	if (countCodeFences(content) % 2 !== 0) {
		defects.push({
			code: "unclosed_code_fence",
			detail: "content has an unclosed ``` fenced code block — every opening fence needs a matching closing fence on its own line",
			line: 0,
		});
	}

	let tree: MdastRoot;
	try {
		tree = getMarkdownProcessor().parse(content) as MdastRoot;
	} catch (err) {
		// Parse failure: no AST to traverse, return what we have so far.
		defects.push({
			code: "unrendered_bold",
			detail: `markdown failed to parse: ${err instanceof Error ? err.message : String(err)}`,
			line: 0,
		});
		return defects;
	}

	// Rule 2 + 3: text-node residue. Any `**` or `` ` `` in a text-node value
	// means the corresponding markdown construct failed to form.
	visit(tree, "text", (node) => {
		const line = node.position?.start.line ?? 0;
		if (node.value.includes("**")) {
			defects.push({
				code: "unrendered_bold",
				detail: `line ${line} contains literal "**" — bold markers did not form an emphasis span. Common causes: odd marker count, whitespace immediately inside the markers (\`** word **\`), markers wrapping only punctuation (\`**-**\`, \`**,**\`), an opening \`**\` at end of line followed by content + closing \`**\` on the next line (\`User **\\nStory**\`), or a span that crosses a blank line. Tighten paired markers against word content on a single paragraph, e.g. \`**Bold**\``,
				line,
			});
			return;
		}
		if (node.value.includes("`")) {
			defects.push({
				code: "unbalanced_inline_code",
				detail: `line ${line} contains a literal backtick — inline-code markers did not pair. Inline code requires matching backticks, e.g. \`code\``,
				line,
			});
		}
	});

	// Rule 4: stray closing bracket on its own line.
	visit(tree, "text", (node: { value: string; position?: any }) => {
		const lines = node.value.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const t = lines[i].trim();
			if (t === ")" || t === "]" || t === "}") {
				const baseLine = node.position?.start.line ?? 0;
				defects.push({
					code: "stray_closing_bracket",
					detail: `line ${baseLine + i} contains only "${t}" — likely a paired open/close was severed across a patch boundary. Restore the opener and the wrapped content on the same line`,
					line: baseLine + i,
				});
				return;
			}
		}
	});

	// Rule 5: list item with no body content.
	visit(tree, "listItem", (node) => {
		const text = collectText(node);
		if (text.trim().length === 0) {
			defects.push({
				code: "orphan_list_marker",
				detail: `line ${node.position?.start.line ?? 0} has an empty list item — the marker has no body. Remove the empty marker or fill in the item`,
				line: node.position?.start.line ?? 0,
			});
		}
	});

	// Rule 6: severed sentence — any text node whose value contains a line
	// (first or subsequent) starting with `;`, `,`, `:`, `?`, or `!`.
	const SEVERING_PUNCT = new Set([";", ",", ":", "?", "!"]);
	visit(tree, "text", (node: { value: string; position?: any }) => {
		const lines = node.value.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trimStart();
			if (trimmed.length === 0) {
				continue;
			}
			const ch = trimmed[0];
			if (i === 0) {
				continue; // first line of a text node — its leading
			}
			// content is governed by the parent block context, not the text
			// node itself. The rule applies only to lines AFTER a soft break,
			// which is where the severance happens.
			if (SEVERING_PUNCT.has(ch)) {
				const baseLine = node.position?.start.line ?? 0;
				defects.push({
					code: "leading_mid_sentence_punct",
					detail: `line ${baseLine + i} starts with "${ch}" — this signals a sentence was split across lines or bullets and should be joined back. Move the punctuation and any trailing fragment back onto the previous sentence`,
					line: baseLine + i,
				});
				return;
			}
		}
	});
	// Same rule, but check the FIRST text of paragraph and listItem nodes —
	// catches the case where the punctuation IS the first content of a true
	// separate paragraph or bullet (no soft break involved).
	visit(tree, ["paragraph", "listItem"], (node) => {
		const firstText = firstTextValue(node);
		if (!firstText) {
			return;
		}
		const trimmed = firstText.trimStart();
		if (trimmed.length === 0) {
			return;
		}
		const ch = trimmed[0];
		if (SEVERING_PUNCT.has(ch)) {
			defects.push({
				code: "leading_mid_sentence_punct",
				detail: `line ${node.position?.start.line ?? 0} starts with "${ch}" — this signals a sentence was split across lines or bullets and should be joined back into one line/bullet. Move the punctuation and any trailing fragment back onto the previous sentence`,
				line: node.position?.start.line ?? 0,
			});
		}
	});

	// Rule 7: bold/emphasis immediately followed by uppercase word in the
	// same parent — e.g. mdast paragraph(strong("Heading"), text("Body...")).
	visit(tree, (node, index, parent) => {
		if (index == null || !parent) {
			return;
		}
		if (node.type !== "strong" && node.type !== "emphasis") {
			return;
		}
		const next = parent.children[index + 1];
		if (!next || next.type !== "text") {
			return;
		}
		if (/^[A-Z][a-z]/.test(next.value)) {
			defects.push({
				code: "bold_followed_by_word",
				detail: `line ${node.position?.start.line ?? 0} has a \`${node.type === "strong" ? "**...**" : "*...*"}\` span immediately followed by an uppercase word with no separator. The bold/emphasis renders correctly but visually fuses with the next word. Add a space, line break, or punctuation between the closing marker and the next sentence`,
				line: node.position?.start.line ?? 0,
			});
		}
	});

	// Rule 8: mixed list markers. See unchanged logic comments above for the
	// AST signature this matches and the corroboration heuristic.
	visit(tree, "list", (list) => {
		if ((list as { ordered?: boolean | null }).ordered) {
			return;
		}
		let corroboratedCount = 0;
		let firstHit: {
			start: number;
			line: number;
		} | null = null;
		for (const item of list.children) {
			if (item.children.length === 0) {
				continue;
			}
			const firstChild = item.children[0];
			if (firstChild.type !== "list") {
				continue;
			}
			const innerList = firstChild as {
				ordered?: boolean | null;
				start?: number | null;
				position?: { start: { line: number } };
			};
			if (!innerList.ordered) {
				continue;
			}
			const start = innerList.start ?? 1;
			if (start <= 1) {
				continue;
			}
			corroboratedCount++;
			if (firstHit === null) {
				firstHit = {
					start,
					line: innerList.position?.start.line ?? 0,
				};
			}
		}
		if (corroboratedCount >= 2 && firstHit !== null) {
			defects.push({
				code: "mixed_list_markers",
				detail: `line ${firstHit.line} is an unordered list item that contains an ordered sub-list starting at ${firstHit.start} — and at least one sibling bullet has the same pattern. This is the parse result of writing "- N. text" where N > 1, which renders as a bullet with literal numbered sub-list. Use a single consistent marker across the list: either all \`1. 2. 3.\` for ordered, or all \`-\` for unordered`,
				line: firstHit.line,
			});
		}
	});

	defects.push(...findBrokenTables(content));

	return defects;
}

/** A pipe-delimited row: `| a | b |`, with or without the outer pipes. */
const PIPE_ROW = /^\s*\|.*\|\s*$/;
/** A separator row: `| --- | :---: |`, alignment colons allowed. */
const SEPARATOR_ROW = /^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/;
/** A whole table flattened onto one line: `| a | b | | --- | --- | | 1 | 2 |`. */
const COLLAPSED_TABLE = /\|[^|\n]*\|\s*\|\s*:?-{3,}/;
/**
 * A line that absorbs a table glued directly below it: a list item (bullet or
 * ordered, any nesting) or a blockquote line. Prose and headings do NOT — GFM
 * tables interrupt paragraphs in both remark and markdown-it.
 */
const TABLE_SWALLOWING_BLOCK = /^\s*(?:[-*+]\s|\d+[.)]\s|>)/;

/**
 * Detect tables that will render as literal pipe/dash text.
 *
 * remark parses these shapes as paragraphs, not tables, so there is no table
 * node to inspect — the absence IS the defect. Working from the raw lines is
 * what makes them visible.
 *
 * Every rule requires at least two pipe rows before it fires, so prose that
 * merely contains a pipe is never flagged.
 */
function findBrokenTables(content: string): MarkdownStructureDefect[] {
	const defects: MarkdownStructureDefect[] = [];
	const lines = content.split("\n");
	let inFence = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (line.trimStart().startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			continue;
		}

		if (COLLAPSED_TABLE.test(line)) {
			defects.push({
				code: "broken_table",
				detail: `line ${i + 1} holds a whole table flattened onto one line — header, separator and body run together, so it renders as literal pipe text. Put every row on its own line`,
				line: i + 1,
			});
			continue;
		}

		if (!PIPE_ROW.test(line)) {
			continue;
		}

		// Walk the run of pipe rows starting here.
		let end = i;
		while (end + 1 < lines.length && PIPE_ROW.test(lines[end + 1])) {
			end++;
		}
		const rowCount = end - i + 1;
		if (rowCount < 2) {
			i = end;
			continue;
		}

		const hasSeparator = SEPARATOR_ROW.test(lines[i + 1]);
		if (!hasSeparator) {
			defects.push({
				code: "broken_table",
				detail: `line ${i + 1} starts a run of pipe rows with no \`| --- | --- |\` separator on the line below the header — without it the rows render as literal text, not a table`,
				line: i + 1,
			});
		} else {
			// A table straight after prose or a heading parses fine (GFM tables
			// interrupt paragraphs in both remark and markdown-it — verified
			// empirically). What genuinely swallows the table is a list item or
			// blockquote directly above: the rows become continuation lines.
			const previous = i > 0 ? lines[i - 1] : "";
			if (TABLE_SWALLOWING_BLOCK.test(previous)) {
				defects.push({
					code: "broken_table",
					detail: `the table starting on line ${i + 1} is glued to the list item or blockquote on line ${i} — without a blank line in between the rows are absorbed as continuation text and render as literal pipes`,
					line: i + 1,
				});
			}
		}

		i = end;
	}

	return defects;
}

function contentError(
	patch: DocumentPatch,
	patchIndex: number,
	detail: string,
): PatchError {
	return {
		patchIndex,
		op: patch.op,
		anchor: patch.anchor ?? "",
		code: "invalid_replacement_content",
		message:
			`Patch replacement contains malformed markdown: ${detail}. ` +
			"Re-emit the patch with balanced markers (each `**` paired, each ``` closed), " +
			"no orphan list markers (a line that is only `- ` or `1. `), and no severed " +
			"closing brackets on their own line.",
	};
}

/**
 * Structural sanity check on a patch's replacement content. Catches the
 * common token-level damage modes seen in production: dropping one half of a
 * `**...**` pair, leaving an unclosed code fence, severing close parens onto
 * their own line, or emitting a list marker with no body.
 *
 * For `replace_text`, checks that find→replace preserves marker parity rather
 * than requiring the replacement to be self-balanced — replacements are
 * allowed to span half a pair as long as the document's overall balance is
 * preserved.
 *
 * For whole-content ops (`replace_section`, `insert_*`, `append/prepend`),
 * the content is required to be self-balanced because it lands as a complete
 * unit between section boundaries.
 *
 * `delete_section` carries no content so always passes.
 */
function validatePatchContent(
	patch: DocumentPatch,
	patchIndex: number,
): PatchError | null {
	if (patch.op === "delete_section") {
		return null;
	}

	if (patch.op === "replace_text") {
		// Substring-level parity check: catches strand introduction (or
		// removal) at the patch boundary independently of document-level
		// parser state. Necessary because the post-apply AST check can be
		// blinded when the document has an unclosed code fence — content
		// after the fence is consumed as code text and isn't visited.
		// The parity rule still allows legitimate balanced changes (find
		// has 0 markers, replace has 2 paired markers, etc.) and matched
		// strand-shifts (find=`Important** note`, replace=`Critical** observation`
		// where each side has one strand that the surrounding context
		// completes).
		const parityChange = checkReplaceTextParity(
			patch.find ?? "",
			patch.replace ?? "",
		);
		if (parityChange) {
			const { token, findCount, replaceCount } = parityChange;
			return contentError(
				patch,
				patchIndex,
				`replace_text changes the parity of \`${token}\` markers between find (${findCount}) and replace (${replaceCount}). Adjust find or replace so they have the same odd/even count of \`${token}\` — for example, both 0 (no markers either side), both 2 (a complete pair on each side), or both 1 (each side carries one half of a marker that surrounding text closes)`,
			);
		}
		// Other structural defects introduced by find/replace (orphan list
		// markers, severed brackets, etc.) are caught by the post-apply
		// AST-based validateMarkdownStructure pass on the whole document.
		return null;
	}

	const content = patch.content ?? "";
	const defect = validateMarkdownStructure(content);
	if (defect !== null) {
		return contentError(patch, patchIndex, defect.detail);
	}

	// replace_section misuse: content starts with a heading at the same level
	// as the anchor, AND keepHeading isn't explicitly false. The applier will
	// keep the existing heading line AND insert the new heading at the top of
	// the body, producing two adjacent same-level headings. The model almost
	// always intends a rename here — `keepHeading: false` is the correct
	// shape for that.
	if (patch.op === "replace_section" && patch.keepHeading !== false) {
		const segments = splitAnchorPath(patch.anchor ?? "");
		const lastSeg = segments[segments.length - 1];
		const parsedLast = lastSeg ? parsePathSegment(lastSeg) : null;
		if (parsedLast) {
			const firstNonEmptyLine = content
				.split("\n")
				.find((l) => l.trim().length > 0);
			if (firstNonEmptyLine) {
				const headingMatch =
					firstNonEmptyLine.match(/^(#{1,6})\s+(.+)$/);
				if (
					headingMatch &&
					headingMatch[1].length === parsedLast.level
				) {
					return {
						patchIndex,
						op: patch.op,
						anchor: patch.anchor ?? "",
						code: "duplicate_heading_in_replace_section",
						message:
							`replace_section content begins with a level-${parsedLast.level} heading "${firstNonEmptyLine.trim()}" while keepHeading defaults to true. ` +
							`Applying this would preserve the existing heading "${"#".repeat(parsedLast.level)} ${parsedLast.text}" AND inject your new heading immediately below it, producing two adjacent same-level headings. ` +
							"Pick one of these fixes:\n" +
							`- If you want to RENAME the section: set "keepHeading": false and keep the new heading as the first line of content.\n` +
							"- If you want to keep the existing heading and only update the body: remove the leading heading line from content (the heading is already part of the document).",
					};
				}
			}
		}
	}

	return null;
}

/**
 * Inferred rename: model's failing patches all anchor to a heading that
 * doesn't exist, but the document has a single same-level heading with very
 * similar text — strong signal the model is mid-rename and used the target
 * name as the anchor instead of the source name.
 */
export interface RenameIntent {
	/** The heading anchor that exists in the baseline document (use as anchor). */
	currentAnchor: string;
	/** The heading anchor the model emitted, which doesn't exist (the rename target). */
	proposedAnchor: string;
	/** Heading level (1..6). */
	level: number;
}

/**
 * When `applyPatches` fails with `anchor_not_found` errors, look for the
 * specific pattern of "model used the rename target as its anchor". Returns
 * the inferred rename mapping or `null` if the pattern doesn't match.
 *
 * Conservative — only fires when:
 * - At least one error has code `anchor_not_found`.
 * - All `anchor_not_found` errors share the same first path segment.
 * - That first segment isn't an exact match for any heading (otherwise
 *   it's not really a rename).
 * - The document has exactly one heading at that level (no ambiguity about
 *   which heading the model meant to anchor to).
 * - The candidate heading's text is close enough to the proposed text by
 *   trigram overlap (≥ 0.4) to plausibly be a rename rather than two
 *   unrelated headings.
 */
export function detectRenameIntent(
	markdown: string,
	errors: PatchError[],
): RenameIntent | null {
	const anchorErrors = errors.filter((e) => e.code === "anchor_not_found");
	if (anchorErrors.length === 0) {
		return null;
	}

	const firstSegments: string[] = [];
	for (const e of anchorErrors) {
		const segs = splitAnchorPath(e.anchor);
		if (segs.length === 0) {
			return null;
		}
		firstSegments.push(segs[0]);
	}
	const uniqueFirsts = Array.from(new Set(firstSegments));
	if (uniqueFirsts.length !== 1) {
		return null;
	}

	const sharedFirst = uniqueFirsts[0];
	const parsed = parsePathSegment(sharedFirst);
	if (!parsed) {
		return null;
	}

	const headings = parseHeadings(normalizeLineEndings(markdown));

	// If any heading at the right level matches the proposed text exactly,
	// the failure isn't a rename — it's something else.
	const exactMatch = headings.some(
		(h) => h.level === parsed.level && h.text === parsed.text,
	);
	if (exactMatch) {
		return null;
	}

	const sameLevelHeadings = headings.filter((h) => h.level === parsed.level);
	if (sameLevelHeadings.length !== 1) {
		return null;
	}

	const candidate = sameLevelHeadings[0];
	const similarity = trigramOverlap(
		trigrams(parsed.text),
		trigrams(candidate.text),
	);
	if (similarity < 0.4) {
		return null;
	}

	return {
		currentAnchor: `${"#".repeat(candidate.level)} ${candidate.text}`,
		proposedAnchor: sharedFirst,
		level: candidate.level,
	};
}

/** Diagnosis of an `overlapping_ranges` failure: which patch dominates and how much it covers. */
export interface OverlapIntent {
	dominantPatchIndex: number;
	/** 1-indexed line coordinates. Point-inserts have startLine > endLine. */
	dominantRange: { startLine: number; endLine: number };
	/** Percent of baseline (by line count) covered by the dominant patch. Clamped to [0, 100]. */
	dominantCoveragePercent: number;
	subsumedPatchIndexes: number[];
	/** ≥ 70% coverage → "whole-document"; below that → "partial". */
	kind: "whole-document" | "partial";
}

/**
 * Returns `null` if no `overlapping_ranges` errors carry structured ranges.
 * The dominant patch is selected by edit-range width; lower index wins ties.
 */
export function diagnoseOverlap(
	markdown: string,
	errors: PatchError[],
): OverlapIntent | null {
	const overlapErrors = errors.filter(
		(e) => e.code === "overlapping_ranges" && !!e.overlapRanges,
	);
	if (overlapErrors.length === 0) {
		return null;
	}

	// A patch can appear as both "self" and "other" across different errors;
	// dedupe by index, keeping first occurrence.
	const seen = new Map<number, { startLine: number; endLine: number }>();
	const record = (
		idx: number,
		range: { startLine: number; endLine: number },
	) => {
		if (seen.has(idx)) {
			return;
		}
		seen.set(idx, { startLine: range.startLine, endLine: range.endLine });
	};
	for (const e of overlapErrors) {
		const r = e.overlapRanges;
		if (!r) {
			continue;
		}
		record(e.patchIndex, r.self);
		record(r.otherIndex, r.other);
	}
	if (seen.size === 0) {
		return null;
	}

	const widthOf = (r: { startLine: number; endLine: number }): number =>
		r.startLine > r.endLine ? 0 : r.endLine - r.startLine + 1;

	let dominantIdx = -1;
	let dominantWidth = -1;
	for (const [idx, info] of seen) {
		const w = widthOf(info);
		if (w > dominantWidth || (w === dominantWidth && idx < dominantIdx)) {
			dominantIdx = idx;
			dominantWidth = w;
		}
	}
	const dominant = seen.get(dominantIdx);
	if (!dominant) {
		return null;
	}

	const totalLines = Math.max(
		1,
		normalizeLineEndings(markdown).split("\n").length,
	);
	const coveragePercent = Math.max(
		0,
		Math.min(100, Math.round((100 * dominantWidth) / totalLines)),
	);

	// Only patches whose ranges actually overlap with the dominant range. A
	// single failed call can contain independent overlap pairs in different
	// sections; folding/dropping unrelated patches in the retry would lose
	// good edits.
	const subsumed = Array.from(seen.entries())
		.filter(
			([idx, range]) =>
				idx !== dominantIdx && rangesOverlap(dominant, range),
		)
		.map(([idx]) => idx)
		.sort((a, b) => a - b);

	return {
		dominantPatchIndex: dominantIdx,
		dominantRange: {
			startLine: dominant.startLine,
			endLine: dominant.endLine,
		},
		dominantCoveragePercent: coveragePercent,
		subsumedPatchIndexes: subsumed,
		kind: coveragePercent >= 70 ? "whole-document" : "partial",
	};
}

/** Internal representation of a patch plus its resolved baseline range. */
interface ResolvedPatch {
	index: number;
	patch: DocumentPatch;
	resolved: ResolvedAnchor;
	/** The range on the baseline this patch occupies or touches. */
	editRange: { startLine: number; endLine: number };
	/** The function that produces the new content for this edit range. */
	apply: (lines: string[], sanitize: (content: string) => string) => string[];
	/** replace_text only: how many find-occurrences this edit splices. */
	occurrenceCount?: number;
}

/**
 * Ceiling on how many occurrences a single replaceAll patch may touch.
 * Insurance against over-generic finds (`find: "the"`) that the
 * content-preservation floor alone wouldn't necessarily catch.
 */
const MAX_REPLACE_ALL_OCCURRENCES = 100;

/**
 * A patch may resolve to SEVERAL precise edits: a replaceAll replace_text
 * emits one edit per cluster of contiguous affected lines. Structured ops
 * always resolve to exactly one edit.
 */
function buildResolvedPatch(
	patch: DocumentPatch,
	patchIndex: number,
	resolved: ResolvedAnchor,
	baselineLines: string[],
): ResolvedPatch[] | PatchError {
	const { op } = patch;
	const { startLine, endLine } = resolved;

	switch (op) {
		case "replace_section": {
			const keepHeading = patch.keepHeading !== false; // default true
			const editStart = keepHeading ? startLine + 1 : startLine;
			const editEnd = endLine;
			return [
				{
					index: patchIndex,
					patch,
					resolved,
					editRange: { startLine: editStart, endLine: editEnd },
					apply: (_lines, sanitize) => {
						const body = sanitize(patch.content ?? "");
						return splitLinesRetainingTrailing(body);
					},
				},
			];
		}
		case "delete_section": {
			return [
				{
					index: patchIndex,
					patch,
					resolved,
					editRange: { startLine, endLine },
					apply: () => [],
				},
			];
		}
		case "append_to_section": {
			// Insert AFTER the last line of the section, staying inside it.
			// Represented as a zero-width range at (endLine+1).
			return [
				{
					index: patchIndex,
					patch,
					resolved,
					editRange: { startLine: endLine + 1, endLine },
					apply: (_lines, sanitize) => {
						const body = sanitize(patch.content ?? "");
						return splitLinesRetainingTrailing(body);
					},
				},
			];
		}
		case "prepend_to_section": {
			// Insert right after the heading line.
			return [
				{
					index: patchIndex,
					patch,
					resolved,
					editRange: { startLine: startLine + 1, endLine: startLine },
					apply: (_lines, sanitize) => {
						const body = sanitize(patch.content ?? "");
						return splitLinesRetainingTrailing(body);
					},
				},
			];
		}
		case "insert_after": {
			return [
				{
					index: patchIndex,
					patch,
					resolved,
					editRange: { startLine: endLine + 1, endLine },
					apply: (_lines, sanitize) => {
						const body = sanitize(patch.content ?? "");
						return splitLinesRetainingTrailing(body);
					},
				},
			];
		}
		case "insert_before": {
			return [
				{
					index: patchIndex,
					patch,
					resolved,
					editRange: { startLine, endLine: startLine - 1 },
					apply: (_lines, sanitize) => {
						const body = sanitize(patch.content ?? "");
						return splitLinesRetainingTrailing(body);
					},
				},
			];
		}
		case "replace_text": {
			// Slice the section body (between heading line and endLine, inclusive).
			const sectionBody = baselineLines
				.slice(startLine, endLine) // exclude heading line; include up to endLine
				.join("\n");
			const rawFind = patch.find ?? "";
			const rawReplace = patch.replace ?? "";
			const replaceAll = patch.replaceAll === true;

			// Occurrence collection. Cascade 1: literal indexOf. Cascade 2:
			// whitespace-normalized indexOf, mapped back to original offsets.
			// Both cascades yield ascending, non-overlapping [start, end)
			// ranges (findAllOccurrences steps past each match, and the
			// normalization map is monotonic).
			let occurrences: Array<{ start: number; end: number }>;
			const literalHits = findAllOccurrences(sectionBody, rawFind);
			if (literalHits.length > 0) {
				if (literalHits.length > 1 && !replaceAll) {
					return {
						patchIndex,
						op,
						anchor: patch.anchor ?? "",
						code: "find_ambiguous_in_section",
						message: `The "find" string appears ${literalHits.length} times in section "${resolved.text}". Add more surrounding context to make it unique, or set "replaceAll": true to replace every occurrence.`,
					};
				}
				occurrences = literalHits.map((s) => ({
					start: s,
					end: s + rawFind.length,
				}));
				if (replaceAll) {
					// The literal scan misses whitespace variants of the
					// phrase (double spaces / tabs from editor round-trips),
					// which would survive a "replace every occurrence"
					// request silently. The normalized scan is a superset of
					// the literal one, so when it finds more occurrences,
					// take its hits for ALL occurrences — mixing literal and
					// normalized spans could overlap around collapsed runs.
					const { normalized: normBody, map } =
						buildNormalizationMap(sectionBody);
					const normFind = normalizeWhitespace(rawFind);
					const normHits = findAllOccurrences(normBody, normFind);
					if (normHits.length > literalHits.length) {
						occurrences = normHits.map((s) => ({
							start: map[s],
							end: map[s + normFind.length],
						}));
					}
				}
			} else {
				const { normalized: normBody, map } =
					buildNormalizationMap(sectionBody);
				const normFind = normalizeWhitespace(rawFind);
				const normHits = findAllOccurrences(normBody, normFind);
				if (normHits.length === 0) {
					// Neither literal nor normalized match — suggest nearest substrings.
					const bodyLines = sectionBody.split("\n");
					const suggestions = nearestByTrigram(
						rawFind,
						bodyLines.filter((l) => l.trim().length > 0),
						3,
					);
					return {
						patchIndex,
						op,
						anchor: patch.anchor ?? "",
						code: "find_not_in_section",
						message: `Could not find "${rawFind.slice(0, 60)}${rawFind.length > 60 ? "…" : ""}" in section "${resolved.text}".`,
						suggestions,
					};
				}
				if (normHits.length > 1 && !replaceAll) {
					return {
						patchIndex,
						op,
						anchor: patch.anchor ?? "",
						code: "find_ambiguous_in_section",
						message: `The "find" string appears ${normHits.length} times (whitespace-normalized) in section "${resolved.text}". Add more surrounding context to make it unique, or set "replaceAll": true to replace every occurrence.`,
					};
				}
				occurrences = normHits.map((s) => ({
					start: map[s],
					end: map[s + normFind.length],
				}));
			}

			if (
				replaceAll &&
				occurrences.length > MAX_REPLACE_ALL_OCCURRENCES
			) {
				return {
					patchIndex,
					op,
					anchor: patch.anchor ?? "",
					code: "find_ambiguous_in_section",
					message: `The "find" string appears ${occurrences.length} times in section "${resolved.text}" — more than the replaceAll limit of ${MAX_REPLACE_ALL_OCCURRENCES}. Use a longer, more specific "find" or narrow the scope with an anchor.`,
				};
			}

			// Line bookkeeping: character offset where each body line starts,
			// and a lookup from a character offset to its body line index.
			const lineStarts: number[] = [0];
			for (
				let nl = sectionBody.indexOf("\n");
				nl !== -1;
				nl = sectionBody.indexOf("\n", nl + 1)
			) {
				lineStarts.push(nl + 1);
			}
			const lineOfOffset = (offset: number): number => {
				let lo = 0;
				let hi = lineStarts.length - 1;
				while (lo < hi) {
					const mid = (lo + hi + 1) >> 1;
					if (lineStarts[mid] <= offset) {
						lo = mid;
					} else {
						hi = mid - 1;
					}
				}
				return lo;
			};

			// Group occurrences into clusters of contiguous affected body
			// lines. editRange covers ONLY the lines a cluster actually
			// touches, and apply() emits ONLY those lines — essential for
			// anchor-less replace_text where the section IS the whole
			// document: without line precision, two anchor-less edits both
			// nominally cover the entire doc and the overlap detector
			// rejects them. Occurrences sharing a line must be spliced by
			// ONE edit for the same reason: two same-line edits would trip
			// the overlap detector against each other.
			interface OccurrenceCluster {
				firstLine: number;
				lastLine: number;
				occurrences: Array<{ start: number; end: number }>;
			}
			const clusters: OccurrenceCluster[] = [];
			for (const occ of occurrences) {
				const occText = sectionBody.slice(occ.start, occ.end);
				const first = lineOfOffset(occ.start);
				const last = first + (occText.match(/\n/g) ?? []).length;
				const prev = clusters[clusters.length - 1];
				if (prev && first <= prev.lastLine) {
					prev.lastLine = Math.max(prev.lastLine, last);
					prev.occurrences.push(occ);
				} else {
					clusters.push({
						firstLine: first,
						lastLine: last,
						occurrences: [occ],
					});
				}
			}

			// `startLine` is the heading line (or 0 for the synthesized
			// whole-document anchor); body line 0 lives at document line
			// `startLine + 1` (1-indexed).
			return clusters.map((cluster) => {
				const clusterStart = lineStarts[cluster.firstLine];
				const clusterEnd =
					cluster.lastLine + 1 < lineStarts.length
						? lineStarts[cluster.lastLine + 1] - 1
						: sectionBody.length;
				const clusterText = sectionBody.slice(clusterStart, clusterEnd);
				return {
					index: patchIndex,
					patch,
					resolved,
					editRange: {
						startLine: startLine + 1 + cluster.firstLine,
						endLine: startLine + 1 + cluster.lastLine,
					},
					occurrenceCount: cluster.occurrences.length,
					apply: (
						_lines: string[],
						sanitize: (c: string) => string,
					) => {
						const replacement = sanitize(rawReplace);
						// Splice right-to-left so earlier offsets stay valid.
						let merged = clusterText;
						for (
							let k = cluster.occurrences.length - 1;
							k >= 0;
							k--
						) {
							const s =
								cluster.occurrences[k].start - clusterStart;
							const e = cluster.occurrences[k].end - clusterStart;
							merged =
								merged.slice(0, s) +
								replacement +
								merged.slice(e);
						}
						return splitLinesRetainingTrailing(merged);
					},
				};
			});
		}
		default: {
			return {
				patchIndex,
				op,
				anchor: patch.anchor ?? "",
				code: "unsupported_op",
				message: `Unhandled op "${op}".`,
			};
		}
	}
}

/** Find all occurrences of `needle` in `haystack`. Returns start indices. */
function findAllOccurrences(haystack: string, needle: string): number[] {
	if (needle.length === 0) {
		return [];
	}
	const out: number[] = [];
	let from = 0;
	while (from <= haystack.length - needle.length) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) {
			break;
		}
		out.push(idx);
		from = idx + needle.length;
	}
	return out;
}

/** Split on \n, preserving an empty trailing entry only if the source ends with \n. */
function splitLinesRetainingTrailing(s: string): string[] {
	if (s.length === 0) {
		return [];
	}
	const lines = s.split("\n");
	// If the string ends with a newline, split gives us a trailing empty string
	// we don't actually want to emit as content.
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

/** Render an edit range for human-readable error messages. */
export function formatLineRange(r: {
	startLine: number;
	endLine: number;
}): string {
	if (r.startLine > r.endLine) {
		return `at line ${r.startLine} (insert point)`;
	}
	if (r.startLine === r.endLine) {
		return `line ${r.startLine}`;
	}
	return `lines ${r.startLine}-${r.endLine}`;
}

/**
 * Build the `overlapping_ranges` PatchError for a conflicting pair. `self` is
 * the patch the error is attributed to (typically the later-sorted one), and
 * `other` is its partner in the overlap. Both ranges are included on the
 * error so callers can run `diagnoseOverlap` without parsing message text.
 */
function buildOverlapError(
	self: ResolvedPatch,
	other: ResolvedPatch,
): PatchError {
	const bothReplaceText =
		self.patch.op === "replace_text" && other.patch.op === "replace_text";
	const eitherReplaceAll =
		self.patch.replaceAll === true || other.patch.replaceAll === true;
	const header =
		`Patch at index ${self.index} (${formatLineRange(self.editRange)}) overlaps with patch at index ${other.index} ` +
		`(${formatLineRange(other.editRange)}). `;
	// Two find/replace patches whose targets share a line cannot both apply
	// (edits are line-granular). Without explicit guidance the cheapest
	// "fix" is dropping one patch — which silently loses an edit — so the
	// message spells out the correct merge instead. Two colliding replaceAll
	// renames have no single-call patch expression at all, so point them at
	// the full-rewrite escape hatch.
	const guidance = bothReplaceText
		? 'Two replace_text patches cannot edit the same line. Merge them into ONE replace_text whose "find" spans the text containing both targets and whose "replace" applies both changes. If one "find" is a substring of the other, expand the shorter one with more surrounding context first.' +
			(eitherReplaceAll
				? " If these are replaceAll renames whose occurrences share a line, apply_document_patches cannot express the combined edit — use write_document_local to rewrite the document with every replacement applied."
				: "")
		: "Anchors resolve against the baseline document, so a wide patch on a root " +
			"heading cannot coexist with narrower patches anchored under it in the same call.";
	return {
		patchIndex: self.index,
		op: self.patch.op,
		anchor: self.patch.anchor ?? "",
		code: "overlapping_ranges",
		message: header + guidance,
		overlapRanges: {
			self: { ...self.editRange },
			other: { ...other.editRange },
			otherIndex: other.index,
		},
	};
}

/**
 * Check whether two edit ranges conflict. A point-insert (start > end, like
 * insert_after/insert_before/append/prepend) at a range boundary is allowed.
 */
function rangesOverlap(
	a: { startLine: number; endLine: number },
	b: { startLine: number; endLine: number },
): boolean {
	// Normalize to true ranges: a point-insert is zero-width located "before startLine".
	const aIsPoint = a.startLine > a.endLine;
	const bIsPoint = b.startLine > b.endLine;

	if (aIsPoint && bIsPoint) {
		// Two inserts at the same slot are always a conflict.
		return a.startLine === b.startLine;
	}
	if (aIsPoint) {
		return a.startLine > b.startLine && a.startLine <= b.endLine + 1
			? a.startLine <= b.endLine
			: false;
	}
	if (bIsPoint) {
		return b.startLine > a.startLine && b.startLine <= a.endLine + 1
			? b.startLine <= a.endLine
			: false;
	}
	return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/**
 * Validate a list of patches against a baseline markdown document. Returns
 * all errors found, without mutating anything.
 */
export function validatePatches(
	markdown: string,
	patches: DocumentPatch[],
): ValidatePatchesResult {
	const errors: PatchError[] = [];
	const normalized = normalizeLineEndings(markdown);
	const headings = parseHeadings(normalized);
	const baselineLines = normalized.split("\n");
	const totalLines = baselineLines.length;
	const flat = flattenHeadingsWithRanges(headings, totalLines);

	const resolvedPatches: ResolvedPatch[] = [];

	for (let i = 0; i < patches.length; i++) {
		const patch = patches[i];
		const shapeError = validatePatchShape(patch, i);
		if (shapeError) {
			errors.push(shapeError);
			continue;
		}

		const contentErr = validatePatchContent(patch, i);
		if (contentErr) {
			errors.push(contentErr);
			continue;
		}

		// replace_text without anchor: search the entire document. Synthesize
		// a "document root" ResolvedAnchor that covers the whole baseline so
		// the existing replace_text body-slice logic (which excludes a single
		// heading line and includes up to endLine) sees lines 0..totalLines-1.
		const resolved =
			patch.op === "replace_text" && !patch.anchor
				? {
						startLine: 0,
						endLine: totalLines,
						level: 0,
						text: "(document)",
					}
				: resolveAnchorInternal(flat, patch.anchor ?? "", i, patch.op);
		if (isPatchError(resolved)) {
			errors.push(resolved);
			continue;
		}

		const built = buildResolvedPatch(patch, i, resolved, baselineLines);
		if (isPatchError(built)) {
			errors.push(built);
			continue;
		}

		resolvedPatches.push(...built);
	}

	// Overlap detection (only meaningful when all patches are otherwise valid;
	// still useful for partial error reporting).
	for (let i = 0; i < resolvedPatches.length; i++) {
		for (let j = i + 1; j < resolvedPatches.length; j++) {
			if (
				rangesOverlap(
					resolvedPatches[i].editRange,
					resolvedPatches[j].editRange,
				)
			) {
				errors.push(
					buildOverlapError(resolvedPatches[j], resolvedPatches[i]),
				);
				break;
			}
		}
	}

	return { valid: errors.length === 0, errors };
}

/**
 * Apply a list of patches to the markdown document. All-or-nothing: if any
 * patch fails validation, returns the original document and the full error
 * list.
 *
 * Anchors are resolved against the untouched baseline, not incrementally
 * against the mutating buffer. This keeps patch ordering order-independent
 * for non-overlapping edits.
 */
export function applyPatches(
	markdown: string,
	patches: DocumentPatch[],
	options: { sanitizeContent?: (content: string) => string } = {},
): ApplyPatchesResult {
	const sanitize = options.sanitizeContent ?? ((c: string) => c);

	if (!Array.isArray(patches) || patches.length === 0) {
		return { success: true, result: markdown, errors: [], appliedCount: 0 };
	}

	const normalized = normalizeLineEndings(markdown);
	const headings = parseHeadings(normalized);
	const baselineLines = normalized.split("\n");
	const totalLines = baselineLines.length;
	const flat = flattenHeadingsWithRanges(headings, totalLines);

	const resolvedPatches: ResolvedPatch[] = [];
	const errors: PatchError[] = [];

	for (let i = 0; i < patches.length; i++) {
		const patch = patches[i];
		const shapeError = validatePatchShape(patch, i);
		if (shapeError) {
			errors.push(shapeError);
			continue;
		}

		const contentErr = validatePatchContent(patch, i);
		if (contentErr) {
			errors.push(contentErr);
			continue;
		}

		// replace_text without anchor: search the entire document. Synthesize
		// a "document root" ResolvedAnchor that covers the whole baseline so
		// the existing replace_text body-slice logic (which excludes a single
		// heading line and includes up to endLine) sees lines 0..totalLines-1.
		const resolved =
			patch.op === "replace_text" && !patch.anchor
				? {
						startLine: 0,
						endLine: totalLines,
						level: 0,
						text: "(document)",
					}
				: resolveAnchorInternal(flat, patch.anchor ?? "", i, patch.op);
		if (isPatchError(resolved)) {
			errors.push(resolved);
			continue;
		}

		const built = buildResolvedPatch(patch, i, resolved, baselineLines);
		if (isPatchError(built)) {
			errors.push(built);
			continue;
		}

		resolvedPatches.push(...built);
	}

	if (errors.length > 0) {
		return {
			success: false,
			result: markdown,
			errors,
			appliedCount: 0,
			availableAnchorPaths: buildAnchorPathsFromHeadings(headings),
		};
	}

	// Overlap check
	const sorted = [...resolvedPatches].sort(
		(a, b) => a.editRange.startLine - b.editRange.startLine,
	);
	for (let i = 0; i < sorted.length; i++) {
		for (let j = i + 1; j < sorted.length; j++) {
			if (rangesOverlap(sorted[i].editRange, sorted[j].editRange)) {
				errors.push(buildOverlapError(sorted[j], sorted[i]));
				break;
			}
		}
	}

	if (errors.length > 0) {
		return {
			success: false,
			result: markdown,
			errors,
			appliedCount: 0,
			availableAnchorPaths: buildAnchorPathsFromHeadings(headings),
		};
	}

	// Apply in ascending startLine order so splice offsets track correctly.
	// For point inserts, break ties by keeping `insert_before` ordering stable:
	// an insert_before at the same line as a replace_section should emit
	// inserted content before the replaced section.
	sorted.sort((a, b) => {
		if (a.editRange.startLine !== b.editRange.startLine) {
			return a.editRange.startLine - b.editRange.startLine;
		}
		// Point inserts first, then wider ranges
		const aWidth = a.editRange.endLine - a.editRange.startLine;
		const bWidth = b.editRange.endLine - b.editRange.startLine;
		return aWidth - bWidth;
	});

	// Emit lines 1..totalLines, splicing each patch at its boundary. Track
	// each patch's replacement width so the post-apply structural check below
	// can map line numbers in `result` back to "this line came from a patch"
	// vs. "this line is unchanged baseline".
	const resultLines: string[] = [];
	let cursor = 1; // 1-indexed line pointer
	const replacementWidths = new Map<ResolvedPatch, number>();
	for (const rp of sorted) {
		const { startLine, endLine } = rp.editRange;

		// Copy unedited baseline lines up to the patch start.
		while (cursor < startLine && cursor <= totalLines) {
			resultLines.push(baselineLines[cursor - 1]);
			cursor++;
		}

		// Emit the patch's replacement lines.
		const replacement = rp.apply(baselineLines, sanitize);
		replacementWidths.set(rp, replacement.length);
		for (const line of replacement) {
			resultLines.push(line);
		}

		// Skip over the replaced range (for point inserts, endLine < startLine
		// so this is a no-op).
		if (endLine >= startLine) {
			cursor = endLine + 1;
		}
	}

	// Copy any remaining baseline lines.
	while (cursor <= totalLines) {
		resultLines.push(baselineLines[cursor - 1]);
		cursor++;
	}

	const result = resultLines.join("\n");

	// Content-preservation guard. A patch run that drops the document under
	// 20% of its original size is almost always destructive (anchor too
	// broad, replacement too small) rather than a real edit. Reject so the
	// model can retry with a narrower scope. Skips small documents where
	// percentage thresholds aren't meaningful.
	const MIN_LEN_FOR_PRESERVATION_CHECK = 500;
	const PRESERVATION_FLOOR = 0.2;
	const baseLen = normalized.length;
	if (
		baseLen >= MIN_LEN_FOR_PRESERVATION_CHECK &&
		result.length < baseLen * PRESERVATION_FLOOR
	) {
		const retainedPct = Math.round((100 * result.length) / baseLen);
		const lostPct = 100 - retainedPct;
		// Attribute the failure to the first sorted patch — for a single
		// destructive patch this is the right one; for multi-patch runs
		// it's a reasonable starting point and the message names the
		// aggregate problem so the model can audit all patches.
		const culprit = sorted[0];
		return {
			success: false,
			result: markdown,
			errors: [
				{
					patchIndex: culprit.index,
					op: culprit.patch.op,
					anchor: culprit.patch.anchor ?? "",
					code: "excessive_content_loss",
					message:
						`Patches would reduce the document from ${baseLen} characters to ${result.length} characters ` +
						`(${retainedPct}% retained, ${lostPct}% lost). This indicates an anchor or operation scope is ` +
						`too broad — for example, a replace_section against the document's top-level heading wipes the ` +
						"entire body. Use narrower anchors (target the specific subsection that needs editing, e.g. " +
						`"## Context Summary" or a deeper "### ..." heading), or use replace_text for sentence-level ` +
						"edits that change a small portion of the document. If you genuinely need to rewrite the " +
						"whole document, use write_document_local instead of apply_document_patches.",
				},
			],
			appliedCount: 0,
			availableAnchorPaths: buildAnchorPathsFromHeadings(headings),
		};
	}

	// Whole-document structural sanity check on the post-apply result. This is
	// the deferred pass that `validatePatchContent` skips for `replace_text`
	// (a substring replacement can introduce imbalance even when both sides are
	// individually well-formed — e.g. replacing `Important** note` with
	// `Critical observation` inside `**Important** note here.` strands a `**`).
	// Structured ops (`replace_section`, `insert_*`, etc.) already validate
	// their content per-patch, but composing valid content into the document
	// can still produce a defect at the seam, so the check runs unconditionally
	// to match the guard that `write_document_local` enforces.
	//
	// Distinguish patch-introduced damage from pre-existing baseline damage at
	// LINE-LEVEL precision: walk every result defect and check whether its line
	// falls inside any patch's edit range in the result document. If yes, the
	// patch put it there — reject. If no, the line maps to unchanged content
	// from the baseline, so the defect must be pre-existing — tolerate.
	//
	// This handles the case the reviewer flagged: a damaged baseline with an
	// unmatched `**` in `## Intro` should still allow a `replace_text` against
	// `## Target`, but reject if that same patch introduces NEW damage of the
	// same code (e.g. another unmatched `**`) in the edited section.
	const resultDefects = findAllMarkdownStructureDefects(result);
	if (resultDefects.length > 0) {
		// Build patch edit ranges in result-line space. As we apply patches
		// in ascending baseline-line order, each one shifts subsequent line
		// numbers by `replacementWidth - baselineWidth`. The result range
		// for each patch is [baselineStart + cumulativeOffset,
		// baselineStart + cumulativeOffset + replacementWidth - 1].
		const patchResultRanges: Array<{ start: number; end: number }> = [];
		let lineOffset = 0;
		for (const rp of sorted) {
			const baselineWidth =
				rp.editRange.endLine >= rp.editRange.startLine
					? rp.editRange.endLine - rp.editRange.startLine + 1
					: 0; // point insert
			const replacementWidth = replacementWidths.get(rp) ?? 0;
			const resultStart = rp.editRange.startLine + lineOffset;
			const resultEnd = resultStart + Math.max(replacementWidth - 1, 0);
			if (replacementWidth > 0) {
				patchResultRanges.push({
					start: resultStart,
					end: resultEnd,
				});
			}
			lineOffset += replacementWidth - baselineWidth;
		}

		const isInPatchRange = (line: number): boolean => {
			for (const range of patchResultRanges) {
				if (line >= range.start && line <= range.end) {
					return true;
				}
			}
			return false;
		};

		// A document-level defect (line 0, e.g. `unclosed_code_fence`) is
		// always treated as pre-existing if the baseline already had one of
		// the same code, otherwise as patch-introduced. Line-range matching
		// can't disambiguate document-level findings.
		const baselineDefects = findAllMarkdownStructureDefects(normalized);
		const baselineCodes = new Set(baselineDefects.map((d) => d.code));

		const newDefect = resultDefects.find((d) => {
			if (d.line > 0) {
				return isInPatchRange(d.line);
			}
			return !baselineCodes.has(d.code);
		});

		if (newDefect) {
			const culprit = sorted[0];
			return {
				success: false,
				result: markdown,
				errors: [
					{
						patchIndex: culprit.index,
						op: culprit.patch.op,
						anchor: culprit.patch.anchor ?? "",
						code: "invalid_document_structure",
						message:
							`Patches produced a document with malformed markdown: ${newDefect.detail}. ` +
							"Re-emit the patches so the post-apply document has balanced markers " +
							"(each `**` paired, each ``` closed), no orphan list markers, no severed " +
							"closing brackets on their own line, and no headings absorbed into preceding lists. " +
							"For replace_text, adjust find or replace so the substitution preserves marker parity " +
							"with surrounding text. For structured ops, ensure the replacement content fits " +
							"cleanly at its boundary.",
					},
				],
				appliedCount: 0,
				availableAnchorPaths: buildAnchorPathsFromHeadings(headings),
			};
		}
		// All result defects are outside patch ranges (or document-level
		// codes already present in the baseline) → pre-existing damage.
		// Allow the patch through so users can repair damaged documents.
	}

	// Per-patch occurrence accounting for replace_text patches, so callers
	// can log/report "replaced N occurrences" and detect occurrences that
	// survived outside an anchored replaceAll scope.
	const replaceTextStats: ReplaceTextStat[] = [];
	for (let i = 0; i < patches.length; i++) {
		const patch = patches[i];
		if (patch?.op !== "replace_text") {
			continue;
		}
		const find = patch.find ?? "";
		const isReplaceAll = patch.replaceAll === true;
		const occurrences = resolvedPatches
			.filter((rp) => rp.index === i)
			.reduce((sum, rp) => sum + (rp.occurrenceCount ?? 0), 0);
		// Residuals are counted whitespace-normalized, matching the widest
		// scan the occurrence collection runs, so a surviving whitespace
		// variant of the phrase is not reported as fully replaced.
		const normFind = normalizeWhitespace(find);
		const selfReferential = normalizeWhitespace(
			patch.replace ?? "",
		).includes(normFind);
		replaceTextStats.push({
			patchIndex: i,
			find,
			occurrences,
			replaceAll: isReplaceAll,
			residualOccurrences:
				isReplaceAll && !selfReferential && find.length > 0
					? findAllOccurrences(normalizeWhitespace(result), normFind)
							.length
					: 0,
		});
	}

	return {
		success: true,
		result,
		errors: [],
		// One patch can resolve to several precise edits (replaceAll
		// clusters); count patches, not edits.
		appliedCount: new Set(resolvedPatches.map((rp) => rp.index)).size,
		replaceTextStats,
	};
}
