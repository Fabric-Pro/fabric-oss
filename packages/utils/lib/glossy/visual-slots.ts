/**
 * Visual slots for Glossy (Fizzy #2589, KTD17, KTD18).
 *
 * A visual slot is an editor's request for a visual at a position in a
 * Proposal or Business Case: a kind (or best fit when absent) and an optional
 * hint. Its markdown form is one tag on its own line (KTD18):
 *
 *   <visual-slot data-slot-id="…" data-kind="…" data-hint="…"></visual-slot>
 *
 * ## Why one helper on every write path
 *
 * Regenerate, Update using context, Auto-Refresh, the in-editor assistant, and
 * MCP updates all replace a whole body with model output, and a model given a
 * slot tag may drop it, move it, echo it twice, or invent one. Every such path
 * runs `preserveVisualSlots(previous, next)` instead of trusting the model
 * with the tag (KTD17).
 *
 * ## Why the incoming body is stripped first
 *
 * Only what `previous` held comes back — the baseline rule of
 * `restorePendingDecisions` (apps/web/modules/saas/projects/lib/stories/
 * pending-decisions-preserve.ts), in the same extract-then-splice shape. Every
 * slot tag in `next` is removed before the lifted slots are spliced in, so no
 * write path can double a slot, introduce one, or resurrect one the person
 * deleted from an older version the model was shown.
 *
 * ## Anchors
 *
 * A slot is anchored to the section it sits in — the nearest heading above
 * it, keyed by U17's heading-anchor path and occurrence index — plus its block
 * index: how many of that section's own blocks (runs of non-blank lines, a
 * fenced code block counting as one) start above it. The section's own
 * blocks stop at the next heading of any level, so a slot under `###` stays
 * under that `###` and a slot in a `##` introduction stays above its
 * subsections. Both bodies are counted with slot lines removed, so a slot
 * never shifts the count it is anchored by.
 *
 * Headings match through `headingAnchor`, so `## 5. Scope (Required)` and
 * `## 6. Scope` are the same section. When the full path misses — typically
 * because a regenerated document retitled its `#` title, which prefixes every
 * path — the section's own anchor and its rank among same-anchor headings is
 * tried before the slot is declared an orphan: the heading survived (AE5).
 *
 * A slot whose section is gone moves to the end of the document and carries
 * `data-orphaned-from` naming the section it came from — an attribute, so the
 * note never leaks into prose, exports, or retrieval. An orphan keeps its
 * first `data-orphaned-from` when it is orphaned again.
 *
 * The fence rule is `scanFences`, the one `parseOutline` and cleanup apply
 * (itself ported from `parseHeadings` in
 * packages/agent-prompts/src/validation/markdown-parser.ts): a slot tag
 * inside a fenced code block is code, never a slot. The heading walk is
 * `parseOutline` itself.
 *
 * Pure and deterministic, like `packages/temporal/src/lib/structure-guards.ts`:
 * activities call it, so the same inputs must give the same body on a retry,
 * which is why a re-issued slot id is a numbered suffix rather than a random
 * value. No Node built-ins: the editor bundle imports this module.
 */

import { stripInlineDecoration } from "../markdown-heading";
import {
	type OutlineHeading,
	parseOutline,
	scanFences,
	VISUAL_SLOT_HINT_ATTR,
	VISUAL_SLOT_ID_ATTR,
	VISUAL_SLOT_KIND_ATTR,
	VISUAL_SLOT_TAG,
} from "./outline";

/** Names the section an orphaned slot came from (KTD17). */
export const VISUAL_SLOT_ORPHANED_FROM_ATTR = "data-orphaned-from";

export interface VisualSlot {
	/** `data-slot-id`. Unique within a document once it has been preserved. */
	id: string;
	/** `data-kind`, or `null` for best fit. */
	kind: string | null;
	/** `data-hint`, or `null` when the editor gave none. */
	hint: string | null;
	/** `data-orphaned-from`: the source section's heading, or `null` when placed. */
	orphanedFrom: string | null;
}

export interface ParsedVisualSlot extends VisualSlot {
	/** 1-based line number of the line the tag sits on. */
	line: number;
}

export interface VisualSlotInput {
	id: string;
	kind?: string | null;
	hint?: string | null;
	orphanedFrom?: string | null;
}

type Attribute = readonly [name: string, value: string];

/** One HTML attribute, with a double-quoted, single-quoted, or bare value. */
const ATTRIBUTE_SOURCE = `\\s+[^\\s"'<>/=]+(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>\`]+))?`;

/**
 * An opening slot tag (capturing its attributes) with its optional closing
 * tag, or a stray closing tag on its own. Quoted values may hold `>`, so the
 * attribute grammar is spelled out rather than `[^>]*`. Global: only ever
 * used through `matchAll` and `replace`, which never leak `lastIndex`.
 */
const SLOT_TAG = new RegExp(
	`<${VISUAL_SLOT_TAG}((?:${ATTRIBUTE_SOURCE})*)\\s*/?>(?:\\s*</${VISUAL_SLOT_TAG}\\s*>)?|</${VISUAL_SLOT_TAG}\\s*>`,
	"gi",
);

/** Cheap pre-check: a body without this substring cannot hold a slot. */
const SLOT_TAG_HINT = new RegExp(`</?${VISUAL_SLOT_TAG}`, "i");

const ATTRIBUTE_PAIR =
	/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: " ",
	quot: '"',
};

/** Section key of the text above the first heading; it always exists. */
const PREAMBLE_KEY = "\u0002preamble";

interface Section {
	/** Heading-anchor path plus occurrence index, or `PREAMBLE_KEY`. */
	key: string;
	/** Own anchor plus its rank among same-anchor headings; `null` if none. */
	fallbackKey: string | null;
	heading: OutlineHeading | null;
	/** 0-based index of each of the section's own blocks' first line. */
	blockStarts: number[];
	/** 0-based index of the section's last own content line, or -1. */
	lastContentLine: number;
}

interface LiftedSlot {
	slot: VisualSlot;
	attributes: Attribute[];
	/** The tag exactly as written, reused when nothing about it changes. */
	raw: string;
	/** 0-based line index. */
	lineIndex: number;
	section: Section;
	blockIndex: number;
}

interface TagScan {
	/** Opening tags on the line, in order. */
	openings: Array<{ raw: string; attributes: Attribute[] }>;
	/** Whether the line held any slot tag, a stray closer included. */
	hasTag: boolean;
	/** The line with every slot tag removed. */
	rest: string;
}

/**
 * The markdown form of one slot, on one line. `data-kind`, `data-hint`, and
 * `data-orphaned-from` are omitted when empty, the way Tiptap renders a null
 * attribute, so the editor's own serialization and this one agree.
 */
export function serializeVisualSlot(slot: VisualSlotInput): string {
	const attributes: Attribute[] = [[VISUAL_SLOT_ID_ATTR, slot.id]];
	if (slot.kind) {
		attributes.push([VISUAL_SLOT_KIND_ATTR, slot.kind]);
	}
	if (slot.hint) {
		attributes.push([VISUAL_SLOT_HINT_ATTR, slot.hint]);
	}
	if (slot.orphanedFrom) {
		attributes.push([VISUAL_SLOT_ORPHANED_FROM_ATTR, slot.orphanedFrom]);
	}
	return renderTag(attributes);
}

/** Every slot in the body, in document order. Fenced tags are code, not slots. */
export function parseVisualSlots(
	markdown: string | null | undefined,
): ParsedVisualSlot[] {
	if (!markdown || !SLOT_TAG_HINT.test(markdown)) {
		return [];
	}
	return walkBody(markdown).slots.map(({ slot, lineIndex }) => ({
		...slot,
		line: lineIndex + 1,
	}));
}

/** Whether the body holds at least one slot outside a fenced code block. */
export function hasVisualSlots(markdown: string | null | undefined): boolean {
	return parseVisualSlots(markdown).length > 0;
}

/**
 * The body with every slot tag removed. A line that held only slots goes
 * with the blank lines around it, so the blocks either side end up one blank
 * line apart — no gap — and a leading or trailing slot leaves no blank edge.
 * Returns the input unchanged when it holds no slot tag.
 */
export function stripVisualSlots(markdown: string): string {
	if (!SLOT_TAG_HINT.test(markdown)) {
		return markdown;
	}

	const endsWithNewline = markdown.endsWith("\n");
	const lines = (endsWithNewline ? markdown.slice(0, -1) : markdown).split(
		"\n",
	);
	const fenced = scanFences(lines);

	// `null` marks a line that held only slot tags.
	const kept: Array<string | null> = [];
	let changed = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const scan = fenced[i] ? null : scanTags(line);
		if (!scan?.hasTag) {
			kept.push(line);
			continue;
		}
		changed = true;
		kept.push(scan.rest.trim() ? scan.rest : null);
	}
	if (!changed) {
		return markdown;
	}

	const isGap = (entry: string | null) => entry === null || !entry.trim();
	const out: string[] = [];
	let i = 0;
	while (i < kept.length) {
		const entry = kept[i];
		if (entry?.trim()) {
			out.push(entry);
			i++;
			continue;
		}

		let end = i;
		let removedSlot = false;
		while (end < kept.length && isGap(kept[end])) {
			removedSlot ||= kept[end] === null;
			end++;
		}
		const blanks = kept
			.slice(i, end)
			.filter((e): e is string => e !== null);

		if (!removedSlot) {
			// A run this strip did not touch keeps its exact whitespace.
			out.push(...blanks);
		} else if (i > 0 && end < kept.length && blanks.length > 0) {
			out.push("");
		}
		i = end;
	}

	const result = out.join("\n");
	return endsWithNewline && result ? `${result}\n` : result;
}

/**
 * `next` with the slots `previous` held spliced back in (KTD17).
 *
 * When neither body holds a slot, returns `next` unchanged — the common
 * case, byte-for-byte. Otherwise strips every slot tag from `next`, then
 * returns each slot lifted from `previous` to its section at its block index,
 * or to that section's end when fewer blocks remain; slots whose section is
 * gone go to the end with `data-orphaned-from`. Order is preserved
 * throughout, and a duplicate or missing slot id is re-issued.
 */
export function preserveVisualSlots(
	previous: string | null | undefined,
	next: string,
): string {
	const fromPrevious =
		previous && SLOT_TAG_HINT.test(previous)
			? walkBody(previous).slots
			: [];
	if (fromPrevious.length === 0 && !hasVisualSlots(next)) {
		return next;
	}

	const base = stripVisualSlots(next);
	if (fromPrevious.length === 0) {
		return base;
	}
	const lifted = reissueIds(fromPrevious);

	const { lines, sections } = walkBody(base);
	const byKey = new Map<string, Section>();
	const byFallbackKey = new Map<string, Section>();
	for (const section of sections) {
		byKey.set(section.key, section);
		if (section.fallbackKey) {
			byFallbackKey.set(section.fallbackKey, section);
		}
	}

	let documentEnd = lines.length;
	while (documentEnd > 0 && !lines[documentEnd - 1].trim()) {
		documentEnd--;
	}

	const placed: Array<{ at: number; tag: string }> = [];
	const orphans: Array<{ at: number; tag: string }> = [];
	for (const entry of lifted) {
		const target =
			byKey.get(entry.section.key) ??
			(entry.section.fallbackKey
				? byFallbackKey.get(entry.section.fallbackKey)
				: undefined);

		if (target) {
			placed.push({
				at: insertionLine(target, entry.blockIndex),
				tag: tagFor(entry),
			});
			continue;
		}

		const headingText = entry.section.heading?.text ?? "";
		orphans.push({
			at: documentEnd,
			tag: tagFor(entry, {
				orphanedFrom:
					entry.slot.orphanedFrom ||
					stripInlineDecoration(headingText) ||
					headingText,
			}),
		});
	}

	// Stable sort: slots sharing a line keep lifted order, and orphans follow
	// any slot placed at the same line.
	const insertions = [...placed, ...orphans].sort((a, b) => a.at - b.at);

	const out: string[] = [];
	let cursor = 0;
	const flush = (at: number) => {
		if (cursor >= insertions.length || insertions[cursor].at !== at) {
			return;
		}
		if (out.length > 0 && out[out.length - 1].trim()) {
			out.push("");
		}
		let first = true;
		while (cursor < insertions.length && insertions[cursor].at === at) {
			if (!first) {
				out.push("");
			}
			out.push(insertions[cursor].tag);
			first = false;
			cursor++;
		}
		if (at < lines.length && lines[at].trim()) {
			out.push("");
		}
	};

	for (let i = 0; i < lines.length; i++) {
		flush(i);
		out.push(lines[i]);
	}
	flush(lines.length);

	return out.join("\n");
}

/**
 * The 0-based line a slot is inserted before: the start of block
 * `blockIndex`, or — when fewer blocks remain — the line after the section's
 * last own content line (after the heading itself when it has none).
 */
function insertionLine(section: Section, blockIndex: number): number {
	if (blockIndex < section.blockStarts.length) {
		return section.blockStarts[blockIndex];
	}
	if (section.lastContentLine >= 0) {
		return section.lastContentLine + 1;
	}
	return section.heading ? section.heading.startLine : 0;
}

/**
 * The tag to write for a lifted slot: the original text when nothing about
 * it changes (unknown attributes and quoting survive), re-rendered from its
 * own attributes otherwise.
 */
function tagFor(
	entry: LiftedSlot,
	change: { orphanedFrom?: string } = {},
): string {
	let attributes = entry.attributes;
	if (entry.slot.id !== readAttribute(attributes, VISUAL_SLOT_ID_ATTR)) {
		attributes = withAttribute(
			attributes,
			VISUAL_SLOT_ID_ATTR,
			entry.slot.id,
		);
	}
	if (
		change.orphanedFrom &&
		change.orphanedFrom !==
			readAttribute(attributes, VISUAL_SLOT_ORPHANED_FROM_ATTR)
	) {
		attributes = withAttribute(
			attributes,
			VISUAL_SLOT_ORPHANED_FROM_ATTR,
			change.orphanedFrom,
		);
	}
	return attributes === entry.attributes ? entry.raw : renderTag(attributes);
}

/**
 * Give every lifted slot a unique id. The first holder of an id keeps it; a
 * later duplicate, or a slot with no id, gets the lowest free numbered
 * suffix — deterministic, so a retried activity writes the same body.
 */
function reissueIds(slots: LiftedSlot[]): LiftedSlot[] {
	const taken = new Set(slots.map((entry) => entry.slot.id).filter(Boolean));
	const seen = new Set<string>();

	return slots.map((entry) => {
		const { id } = entry.slot;
		if (id && !seen.has(id)) {
			seen.add(id);
			return entry;
		}

		const base = id || "slot";
		let n = id ? 2 : 1;
		while (taken.has(`${base}-${n}`)) {
			n++;
		}
		const issued = `${base}-${n}`;
		taken.add(issued);
		seen.add(issued);
		return { ...entry, slot: { ...entry.slot, id: issued } };
	});
}

/**
 * One pass over a body: its sections with their own blocks, and its slots
 * with their anchors. Slot lines are transparent to block counting — they
 * neither start nor end a block — so the counts match the stripped body.
 */
function walkBody(markdown: string): {
	lines: string[];
	sections: Section[];
	slots: LiftedSlot[];
} {
	const lines = markdown.split("\n");
	const fenced = scanFences(lines);
	const headingAt = new Map<number, OutlineHeading>();
	for (const heading of parseOutline(markdown)) {
		headingAt.set(heading.startLine - 1, heading);
	}

	let section: Section = {
		key: PREAMBLE_KEY,
		fallbackKey: null,
		heading: null,
		blockStarts: [],
		lastContentLine: -1,
	};
	const sections: Section[] = [section];
	const slots: LiftedSlot[] = [];
	const anchorRanks = new Map<string, number>();
	let inBlock = false;

	const lift = (scan: TagScan, lineIndex: number, blockIndex: number) => {
		for (const { raw, attributes } of scan.openings) {
			slots.push({
				slot: slotFromAttributes(attributes),
				attributes,
				raw,
				lineIndex,
				section,
				blockIndex,
			});
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (fenced[i]) {
			if (!inBlock) {
				section.blockStarts.push(i);
				inBlock = true;
			}
			section.lastContentLine = i;
			continue;
		}

		const scan = scanTags(line);
		const heading = headingAt.get(i);

		if (heading) {
			const anchor = heading.headingPath[heading.headingPath.length - 1];
			const rank = anchorRanks.get(anchor) ?? 0;
			anchorRanks.set(anchor, rank + 1);
			section = {
				key: `${heading.headingPath.join("\u0000")}\u0001${heading.occurrenceIndex}`,
				fallbackKey: anchor ? `${anchor}\u0001${rank}` : null,
				heading,
				blockStarts: [],
				lastContentLine: -1,
			};
			sections.push(section);
			inBlock = false;
			// A tag written into the heading line itself anchors above the
			// section's first block.
			lift(scan, i, 0);
			continue;
		}

		if (!scan.rest.trim()) {
			if (scan.hasTag) {
				lift(scan, i, section.blockStarts.length);
			} else {
				inBlock = false;
			}
			continue;
		}

		if (!inBlock) {
			section.blockStarts.push(i);
			inBlock = true;
		}
		section.lastContentLine = i;
		// An inline tag counts its own block as above it.
		lift(scan, i, section.blockStarts.length);
	}

	return { lines, sections, slots };
}

function scanTags(line: string): TagScan {
	if (!SLOT_TAG_HINT.test(line)) {
		return { openings: [], hasTag: false, rest: line };
	}
	const openings: TagScan["openings"] = [];
	for (const match of line.matchAll(SLOT_TAG)) {
		if (match[1] !== undefined) {
			openings.push({
				raw: match[0],
				attributes: parseAttributes(match[1]),
			});
		}
	}
	const rest = line.replace(SLOT_TAG, "");
	return { openings, hasTag: rest !== line, rest };
}

/** Attributes in source order, values decoded; the first of a repeated name wins. */
function parseAttributes(source: string): Attribute[] {
	const attributes: Attribute[] = [];
	for (const match of source.matchAll(ATTRIBUTE_PAIR)) {
		const name = match[1].toLowerCase();
		if (attributes.some(([existing]) => existing === name)) {
			continue;
		}
		attributes.push([
			name,
			decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""),
		]);
	}
	return attributes;
}

function slotFromAttributes(attributes: Attribute[]): VisualSlot {
	const read = (name: string) =>
		(readAttribute(attributes, name) ?? "").trim() || null;
	return {
		id: read(VISUAL_SLOT_ID_ATTR) ?? "",
		kind: read(VISUAL_SLOT_KIND_ATTR),
		hint: read(VISUAL_SLOT_HINT_ATTR),
		orphanedFrom: read(VISUAL_SLOT_ORPHANED_FROM_ATTR),
	};
}

function readAttribute(
	attributes: readonly Attribute[],
	name: string,
): string | undefined {
	return attributes.find(([existing]) => existing === name)?.[1];
}

function withAttribute(
	attributes: Attribute[],
	name: string,
	value: string,
): Attribute[] {
	const index = attributes.findIndex(([existing]) => existing === name);
	if (index === -1) {
		return [...attributes, [name, value]];
	}
	return attributes.map((attribute, i) =>
		i === index ? ([name, value] as const) : attribute,
	);
}

function renderTag(attributes: readonly Attribute[]): string {
	const rendered = attributes
		.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
		.join("");
	return `<${VISUAL_SLOT_TAG}${rendered}></${VISUAL_SLOT_TAG}>`;
}

/** Escapes a double-quoted attribute value; line breaks become character references so the tag stays on one line. */
function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\r/g, "&#13;")
		.replace(/\n/g, "&#10;");
}

function decodeEntities(value: string): string {
	return value.replace(
		/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
		(entity, body: string) => {
			if (body[0] === "#") {
				const code =
					body[1] === "x" || body[1] === "X"
						? Number.parseInt(body.slice(2), 16)
						: Number.parseInt(body.slice(1), 10);
				return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
			}
			return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
		},
	);
}
