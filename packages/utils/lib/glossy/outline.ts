/**
 * Fence-aware Markdown heading outline for Glossy (Fizzy #2589, KTD7).
 *
 * Cleanup, the fact guard, and slot preservation each need to walk a
 * document's headings the same way, so this is the one place that does it.
 * A Glossy "segment" is a `##` section, or a `###` subsection where one is
 * present — this module only produces the outline; deciding which headings
 * become segments is a caller concern.
 *
 * `scanFences` is the one fence rule, ported from `parseHeadings` in
 * `packages/agent-prompts/src/validation/markdown-parser.ts`, so a `##` line
 * inside a fenced code block (``` or ~~~) is never mistaken for a real
 * heading here either. Cleanup, slot preservation, and the key normalizer
 * call it too, so section bounds, block counts, and slot anchors agree on
 * which lines are code. `parseOutline` then adds what that parser does not
 * need but a segment identity key does (KTD7): a heading-anchor path from
 * the document root to each heading, and an occurrence index that
 * disambiguates repeated headings at the same nesting position.
 *
 * No Node built-ins: the editor bundle imports slot helpers built on this
 * module, so it must stay browser-safe, same rule as `markdown-heading.ts`.
 */

import { stripInlineDecoration } from "../markdown-heading";

/**
 * A fence marker line: up to 3 spaces of indent, then 3+ backticks or
 * tildes. The rest of an opening marker's line is its info string. Not
 * global, so `match` and `test` never carry `lastIndex` between calls.
 */
export const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})/;

/**
 * A line's place in a fenced code block: its opening marker, a line inside
 * it, or its closing marker. `null` is a line outside every fence.
 */
export type FenceRole = "open" | "inside" | "close" | null;

/**
 * Classify each line against fenced code blocks, one role per line.
 *
 * Ported from `parseHeadings` in
 * `packages/agent-prompts/src/validation/markdown-parser.ts`: a fence opens
 * on a line starting with 3+ backticks or tildes (optionally after up to 3
 * spaces of indent) and closes on a line with the same marker character and
 * at least as many repetitions — the CommonMark rule for the cases that
 * matter here. Any other line before that, marker-shaped or not, is inside,
 * and an unclosed fence runs to the last line. Keep this in sync with that
 * copy if the rule ever changes.
 */
export function scanFences(lines: readonly string[]): FenceRole[] {
	const roles: FenceRole[] = [];
	let fenceChar: string | null = null;
	let fenceLen = 0;

	for (const line of lines) {
		const marker = line.match(FENCE_MARKER)?.[1];
		if (fenceChar === null) {
			if (marker) {
				fenceChar = marker[0];
				fenceLen = marker.length;
				roles.push("open");
			} else {
				roles.push(null);
			}
			continue;
		}
		if (marker && marker[0] === fenceChar && marker.length >= fenceLen) {
			fenceChar = null;
			fenceLen = 0;
			roles.push("close");
			continue;
		}
		roles.push("inside");
	}

	return roles;
}

/** An ATX heading line: 1-6 `#` characters, a space, then the heading text. */
const HEADING_LINE = /^(#{1,6})\s+(.+)$/;

/** A leading numbering prefix, e.g. "5. ", "6) ", "1A. " (KTD11 numbering). */
// The editor escapes an ordered-looking heading on save (`## 5\. Scope`), so
// the separator may carry a backslash; both forms must share one anchor.
const NUMBERING_PREFIX = /^\d+[A-Za-z]?\\?[.)]\s+/;

/** A trailing parenthetical "tag" suffix, e.g. " (Required)", " (Status: Confirmed)". */
const TAG_SUFFIX = /\s*\([^()]*\)\s*$/;

export interface OutlineHeading {
	/** ATX heading level, 1-6. */
	level: number;
	/** Raw heading text, trimmed, with the leading `#`s removed. Decoration intact. */
	text: string;
	/** 1-based line number of the heading line itself. */
	startLine: number;
	/**
	 * 1-based line number where this heading's span ends: the line before the
	 * next heading at the same level or shallower, or the document's last
	 * line. A nested subheading's lines are included in its parent's span.
	 */
	endLine: number;
	/**
	 * Heading anchors from the document root down to and including this
	 * heading — `headingAnchor(text)` for each ancestor, then this heading's
	 * own. A `###` heading's path always includes its parent `##`'s anchor.
	 */
	headingPath: string[];
	/**
	 * 0-based index of this heading among headings sharing the exact same
	 * `headingPath`, in document order. Two sibling headings that normalize
	 * to the same anchor at the same nesting position get 0 and 1.
	 */
	occurrenceIndex: number;
}

/**
 * Walk a Markdown document's ATX headings (`#` through `######`), skipping
 * any that fall inside a fenced code block (`scanFences`).
 */
export function parseOutline(markdown: string): OutlineHeading[] {
	const lines = markdown.split("\n");
	const fences = scanFences(lines);
	const rawHeadings: Array<{
		level: number;
		text: string;
		startLine: number;
	}> = [];

	for (let i = 0; i < lines.length; i++) {
		if (fences[i] !== null) {
			continue;
		}

		const line = lines[i];
		const match = line.match(HEADING_LINE);
		if (match) {
			rawHeadings.push({
				level: match[1].length,
				text: match[2].trim(),
				startLine: i + 1,
			});
		}
	}

	const headings: OutlineHeading[] = [];
	const occurrenceCounts = new Map<string, number>();
	// Open ancestors, shallowest first — mirrors the stack-based nesting used
	// by `buildDocumentTocTree` in apps/web's document-toc.ts.
	const ancestors: Array<{ level: number; anchor: string }> = [];

	for (let i = 0; i < rawHeadings.length; i++) {
		const { level, text, startLine } = rawHeadings[i];
		const anchor = headingAnchor(text);

		while (
			ancestors.length > 0 &&
			ancestors[ancestors.length - 1].level >= level
		) {
			ancestors.pop();
		}

		const headingPath = [
			...ancestors.map((ancestor) => ancestor.anchor),
			anchor,
		];
		const pathKey = headingPath.join("\u0000");
		const occurrenceIndex = occurrenceCounts.get(pathKey) ?? 0;
		occurrenceCounts.set(pathKey, occurrenceIndex + 1);

		ancestors.push({ level, anchor });

		let endLine = lines.length;
		for (let j = i + 1; j < rawHeadings.length; j++) {
			if (rawHeadings[j].level <= level) {
				endLine = rawHeadings[j].startLine - 1;
				break;
			}
		}

		headings.push({
			level,
			text,
			startLine,
			endLine,
			headingPath,
			occurrenceIndex,
		});
	}

	return headings;
}

/**
 * Normalize a heading's text into a stable anchor for the identity key
 * (KTD7): decoration-strip, drop a leading numbering prefix ("5. ", "6) ",
 * "1A. "), drop trailing parenthetical "tag" suffixes (" (Required)"), then
 * lowercase and collapse whitespace. `## 5. Scope (Required)` and
 * `## 6) Scope` both anchor to "scope".
 *
 * Pure and total: never throws, returns `""` for nullish or blank input.
 */
export function headingAnchor(text: string | null | undefined): string {
	if (!text?.trim()) {
		return "";
	}

	const decorationStripped = stripInlineDecoration(text);
	const withoutNumbering = decorationStripped.replace(NUMBERING_PREFIX, "");

	// Repeat: a heading may carry more than one trailing tag, e.g. "(Required) (Draft)".
	let withoutTags = withoutNumbering;
	let previous: string;
	do {
		previous = withoutTags;
		withoutTags = previous.replace(TAG_SUFFIX, "");
	} while (withoutTags !== previous);

	return withoutTags.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The visual-slot markdown grammar (KTD18): `<visual-slot data-slot-id
 * data-kind data-hint></visual-slot>` on its own line. Shared so cleanup,
 * the fact guard, and slot preservation recognize and skip the same tag
 * without each hand-rolling the name and attributes.
 */
export const VISUAL_SLOT_TAG = "visual-slot";
export const VISUAL_SLOT_ID_ATTR = "data-slot-id";
export const VISUAL_SLOT_KIND_ATTR = "data-kind";
export const VISUAL_SLOT_HINT_ATTR = "data-hint";
