/**
 * Place generated visuals into a Proposal's Main body (Fizzy #2801).
 *
 * The coordinated Proposal job generates its visuals before the final save
 * and writes them into the body itself: timeline, flow and org chart as
 * ```` ```mermaid ```` fences, comparison as a markdown table
 * (`comparisonToMarkdownTable`). Each visual belongs to one section and goes
 * directly after that section's first block, so the section's opening
 * paragraph introduces it.
 *
 * ## Anchors
 *
 * A section is identified the way visual slots identify one
 * (`visual-slots.ts`): its heading-anchor path from `parseOutline` plus the
 * occurrence index among headings sharing that path. Glossy's sections
 * (`cleanupDocument`) carry the same path without the document's leading
 * `#` title, so that form matches too, after the full path is tried. A
 * visual whose section is not found is dropped — a visual never moves to
 * another section.
 *
 * A section's own content stops at the next heading of any level, and its
 * blocks are counted as slots count them: runs of non-blank lines, a fenced
 * block counting as one, slot-only lines transparent. A loose list is one
 * block, so a visual never splits a list.
 *
 * ## What is never changed
 *
 * Only new lines are added. Every existing line, `<visual-slot>` tags
 * included, comes back byte-identical. A section whose own content already
 * holds a mermaid fence gets no visual; a table does not count. A section
 * receives at most one visual, the first given for it.
 *
 * Pure and deterministic, and no Node built-ins: the worker calls it, and
 * a retried activity must write the same body.
 */

import {
	FENCE_MARKER,
	type FenceRole,
	parseOutline,
	scanFences,
	VISUAL_SLOT_TAG,
} from "../glossy/outline";
import { stripVisualSlots } from "../glossy/visual-slots";
import type { ComparisonVisualSpec } from "../glossy/visual-spec";

/** One visual to place, and the section it belongs to. */
export interface SectionVisual {
	/**
	 * Heading anchors from the document root down to the section's heading:
	 * `parseOutline(markdown)`'s `headingPath` for the body passed to
	 * `insertVisuals`, or that path without the leading `#` title, as
	 * `GlossySection.headingPath` has it. Anchors, not heading text.
	 */
	headingPath: readonly string[];
	/** The heading's `occurrenceIndex` among headings sharing that path. */
	occurrenceIndex: number;
	/**
	 * The rendered block, colors already filled: a mermaid fence
	 * (`toMermaidFence`) or a markdown table (`comparisonToMarkdownTable`).
	 * Leading and trailing blank lines are dropped; a block that leaves a
	 * fence open is refused.
	 */
	markdown: string;
}

export interface InsertVisualsResult {
	/** The body with every inserted visual; the input itself when none was. */
	markdown: string;
	inserted: number;
	/**
	 * Found a section but not placed: the section holds a mermaid fence or
	 * already received a visual, or the block was blank or left a fence open.
	 */
	skipped: number;
	/** No section has the visual's anchor. */
	unmatched: number;
}

interface VisualSection {
	/** 0-based line the visual goes after. */
	insertAfter: number;
	/**
	 * `false` when the section's own content already holds a mermaid fence,
	 * or its first block runs into a fence that never closes.
	 */
	accepts: boolean;
}

/** An opening fence whose info string names mermaid. */
const MERMAID_OPEN = /^ {0,3}(?:`{3,}|~{3,})[ \t]*mermaid(?:[\s{]|$)/i;

/** A list item's first line: a bullet or an ordered marker. */
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/** A line indented as a list item's continuation. */
const INDENTED = /^[ \t]/;

/** Cheap pre-check before asking whether a line holds only slot tags. */
const SLOT_TAG_HINT = new RegExp(`</?${VISUAL_SLOT_TAG}`, "i");

/**
 * `markdown` with each visual after its section's first block. See the
 * module comment for anchoring and the skip rules.
 */
export function insertVisuals(
	markdown: string,
	visuals: readonly SectionVisual[],
): InsertVisualsResult {
	const result: InsertVisualsResult = {
		markdown,
		inserted: 0,
		skipped: 0,
		unmatched: 0,
	};
	if (visuals.length === 0) {
		return result;
	}

	const lines = markdown.split("\n");
	const fences = scanFences(lines);
	const { byPath, byTitlelessPath } = indexSections(markdown, lines, fences);

	const placed = new Set<VisualSection>();
	const insertions = new Map<number, string[]>();
	for (const visual of visuals) {
		const key = sectionKey(visual.headingPath, visual.occurrenceIndex);
		const section = byPath.get(key) ?? byTitlelessPath.get(key);
		if (!section) {
			result.unmatched++;
			continue;
		}
		const block = blockLines(visual.markdown);
		if (!section.accepts || placed.has(section) || !block) {
			result.skipped++;
			continue;
		}
		placed.add(section);
		insertions.set(section.insertAfter, block);
		result.inserted++;
	}
	if (insertions.size === 0) {
		return result;
	}

	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		out.push(lines[i]);
		const block = insertions.get(i);
		if (!block) {
			continue;
		}
		out.push("", ...block);
		if (i + 1 < lines.length && lines[i + 1].trim()) {
			out.push("");
		}
	}
	result.markdown = out.join("\n");
	return result;
}

/**
 * A ```` ```mermaid ```` fence around `source`, its backtick run longer than
 * any fence-shaped run inside, so the source can never close it early.
 */
export function toMermaidFence(source: string): string {
	const body = source.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
	let longest = 2;
	for (const line of body.split("\n")) {
		const run = line.match(FENCE_MARKER)?.[1];
		if (run?.startsWith("`")) {
			longest = Math.max(longest, run.length);
		}
	}
	const fence = "`".repeat(longest + 1);
	return `${fence}mermaid\n${body}\n${fence}`;
}

/**
 * A comparison spec as a markdown table: one column per item, its title as
 * the header and its points down the rows, a shorter column padded with
 * empty cells. The spec's title is not rendered, as the mermaid templates
 * and the comparison card leave theirs out; the section heading names it.
 */
export function comparisonToMarkdownTable(spec: ComparisonVisualSpec): string {
	const rowCount = Math.max(...spec.items.map((item) => item.points.length));
	const row = (cells: readonly string[]) =>
		`| ${cells.map(tableCell).join(" | ")} |`;
	const rows = [
		row(spec.items.map((item) => item.title)),
		`| ${spec.items.map(() => "---").join(" | ")} |`,
	];
	for (let index = 0; index < rowCount; index++) {
		rows.push(row(spec.items.map((item) => item.points[index] ?? "")));
	}
	return rows.join("\n");
}

/**
 * One table cell: on one line, with backslashes and pipes escaped so the
 * text can neither split the cell nor escape its delimiter.
 */
function tableCell(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|");
}

function sectionKey(path: readonly string[], occurrenceIndex: number): string {
	return `${path.join("\u0000")}\u0001${occurrenceIndex}`;
}

/**
 * Every headed section by its full anchor key, and by the key without a
 * leading `#` title for the sections under that title — the form
 * `cleanupDocument` gives its sections. A later `#` and its sections keep
 * their full paths there too, so both maps hold them.
 */
function indexSections(
	markdown: string,
	lines: readonly string[],
	fences: readonly FenceRole[],
): {
	byPath: Map<string, VisualSection>;
	byTitlelessPath: Map<string, VisualSection>;
} {
	const outline = parseOutline(markdown);
	const title = outline[0]?.level === 1 ? outline[0] : null;
	const byPath = new Map<string, VisualSection>();
	const byTitlelessPath = new Map<string, VisualSection>();

	outline.forEach((heading, index) => {
		const headingLine = heading.startLine - 1;
		const lastLine =
			(outline[index + 1]?.startLine ?? lines.length + 1) - 2;
		const section = describeSection(lines, fences, headingLine, lastLine);
		byPath.set(
			sectionKey(heading.headingPath, heading.occurrenceIndex),
			section,
		);

		if (heading === title) {
			return;
		}
		const underTitle =
			title !== null &&
			heading.startLine > title.startLine &&
			heading.startLine <= title.endLine;
		const titleless = sectionKey(
			underTitle ? heading.headingPath.slice(1) : heading.headingPath,
			heading.occurrenceIndex,
		);
		if (!byTitlelessPath.has(titleless)) {
			byTitlelessPath.set(titleless, section);
		}
	});

	return { byPath, byTitlelessPath };
}

/**
 * Where a section's visual goes — after its first block, or after the
 * heading when it has none — and whether it already shows a diagram.
 * `headingLine` and `lastLine` are 0-based; the section's own lines are
 * those between them.
 */
function describeSection(
	lines: readonly string[],
	fences: readonly FenceRole[],
	headingLine: number,
	lastLine: number,
): VisualSection {
	let hasMermaid = false;
	for (let i = headingLine + 1; i <= lastLine; i++) {
		if (fences[i] === "open" && MERMAID_OPEN.test(lines[i])) {
			hasMermaid = true;
			break;
		}
	}

	const isContent = (i: number) => fences[i] !== null || !!lines[i].trim();
	const runEnd = (start: number) => {
		let end = start;
		while (end + 1 <= lastLine && isContent(end + 1)) {
			end++;
		}
		return end;
	};

	let start = headingLine + 1;
	while (
		start <= lastLine &&
		(!isContent(start) ||
			(fences[start] === null && isSlotOnly(lines[start])))
	) {
		start++;
	}
	if (start > lastLine) {
		return { insertAfter: headingLine, accepts: !hasMermaid };
	}

	let end = runEnd(start);
	if (fences[start] === null && LIST_ITEM.test(lines[start])) {
		// A loose list continues past its blank lines while the next line is
		// another item or indented into the current one.
		for (;;) {
			let next = end + 1;
			while (next <= lastLine && !isContent(next)) {
				next++;
			}
			if (
				next > lastLine ||
				!(LIST_ITEM.test(lines[next]) || INDENTED.test(lines[next]))
			) {
				break;
			}
			end = runEnd(next);
		}
	}

	// A block running into a fence that never closes would put the visual
	// inside it as code.
	const endRole = fences[end];
	const unclosed = endRole === "open" || endRole === "inside";
	return { insertAfter: end, accepts: !hasMermaid && !unclosed };
}

function isSlotOnly(line: string): boolean {
	return SLOT_TAG_HINT.test(line) && !stripVisualSlots(line).trim();
}

/**
 * The visual's lines without leading or trailing blank lines, or `null`
 * when it is blank or leaves a fence open.
 */
function blockLines(markdown: string): string[] | null {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	let first = 0;
	let last = lines.length - 1;
	while (first <= last && !lines[first].trim()) {
		first++;
	}
	while (last >= first && !lines[last].trim()) {
		last--;
	}
	if (first > last) {
		return null;
	}
	const block = lines.slice(first, last + 1);
	const roles = scanFences(block);
	const lastRole = roles[roles.length - 1];
	if (lastRole === "open" || lastRole === "inside") {
		return null;
	}
	return block;
}
