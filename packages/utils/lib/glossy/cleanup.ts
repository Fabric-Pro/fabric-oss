/**
 * Glossy cleanup — turn a Proposal or Business Case into main-flow sections,
 * layout anchors, and appendix entries (Fizzy #2589, KTD7, KTD11).
 *
 * Pure and deterministic: the same markdown, type, and options always give
 * the same result, so the build workflow can call it from an activity and a
 * rebuild sees identical sections for unchanged text. No Node built-ins —
 * the section keys that hash this output live in `keys.ts`, which is the
 * server-only half.
 *
 * What it does, per scaffolding style (KTD11):
 * - Business Case: the header field block (`Owner: TBD` …), `0) Source
 *   Index`, `(Status: …; Evidence: …)` parentheticals, standalone
 *   `Evidence:` / `Confidence:` lines, and Status / Evidence table columns.
 * - Proposal: `1. Proposal Cover`, `1A. Source Index`, `[cite]` and `[S#]`
 *   markers, and an optional Appendix section, which merges into
 *   `appendix.additionalMaterial`.
 * Every rule runs on both types; `type` only decides which style counts as
 * "recognized" for `scaffoldingUnrecognized`.
 *
 * Sectioning comes from U17's `parseOutline` (the one fence-aware heading
 * walker). A segment is a `##` section, or a `###` subsection where present;
 * a `##` with `###` children keeps its own lead-in text as a section.
 *
 * Anchors (KTD7) — visual slots, ```mermaid fences, and the document's own
 * uploaded `<img data-s3-key>` images — are lifted out of the section text
 * and carry a `blockIndex`: how many of the section's cleaned text blocks
 * start above the anchor. That is the rule slot preservation uses
 * (`visual-slots.ts`): a block is a run of non-blank lines, and an anchor is
 * transparent to the count. `placeAnchors` is the inverse, for a rewrite or
 * the cleaned original. Section text never contains anchor lines, so a key
 * computed over it (`computeSectionKey`) does not change when a slot is added.
 *
 * Removal is single-pass and never loops to a fixed point: a deletion can
 * splice its neighbours into a new marker (see
 * docs/solutions/security-issues/a-sanitizer-that-deletes-can-reassemble-what-it-removed.md).
 * Instead the finished main flow is scanned once more, and anything still
 * citation-like is reported through `issues` and `scaffoldingUnrecognized`.
 * A status parenthetical that is unbalanced or longer than the scan bound is
 * left in place verbatim — never partially deleted — and reported the same way.
 */

import type { GlossyEligibleDocumentType } from "./eligibility";
import {
	FENCE_MARKER,
	type OutlineHeading,
	parseOutline,
	scanFences,
	VISUAL_SLOT_HINT_ATTR,
	VISUAL_SLOT_ID_ATTR,
	VISUAL_SLOT_KIND_ATTR,
	VISUAL_SLOT_TAG,
} from "./outline";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A claim's confidence tag, as the Business Case template writes it. */
export type GlossyClaimStatus =
	| "CONFIRMED"
	| "DIRECTIONALLY_CONFIRMED"
	| "ASSUMED"
	| "TBD"
	| "DERIVED_DEPENDENCY";

/** The short inline qualifier a non-confirmed claim keeps (R41). */
export type GlossyQualifier =
	| "indicative"
	| "assumed"
	| "to be confirmed"
	| "dependent";

/** Status → qualifier (R41). A Confirmed claim gets no qualifier. */
export const GLOSSY_STATUS_QUALIFIERS: Readonly<
	Record<GlossyClaimStatus, GlossyQualifier | null>
> = {
	CONFIRMED: null,
	DIRECTIONALLY_CONFIRMED: "indicative",
	ASSUMED: "assumed",
	TBD: "to be confirmed",
	DERIVED_DEPENDENCY: "dependent",
};

/** Layout lifted out of a section; `blockIndex` counts the text blocks above it. */
export type GlossyAnchor =
	| {
			kind: "slot";
			blockIndex: number;
			slotId: string;
			/** `data-kind`, or `null` when the slot lets detection choose. */
			slotKind: string | null;
			hint: string | null;
			/** The slot tag line, verbatim. */
			markdown: string;
	  }
	| {
			kind: "mermaid";
			blockIndex: number;
			/** The fence's inner source. Raw diagram source never enters section text (R13). */
			source: string;
	  }
	| {
			kind: "image";
			blockIndex: number;
			s3Key: string;
			/** The `<img>` line, verbatim. */
			markdown: string;
	  };

export interface GlossySection {
	/**
	 * Cleaned heading text: numbering kept, tag suffixes such as
	 * "(Required)" and citation markers removed. `null` for text before the
	 * first heading.
	 */
	heading: string | null;
	/** ATX level of the heading; `0` for text before the first heading. */
	level: number;
	/** From `parseOutline`; `[]` for text before the first heading. */
	headingPath: string[];
	occurrenceIndex: number;
	/** Cleaned body, anchor blocks removed, blocks separated by a blank line. */
	markdown: string;
	anchors: GlossyAnchor[];
}

export interface GlossyAppendixSource {
	/** "S1" for an `[S1]` entry; `null` for an unlabelled entry. */
	id: string | null;
	text: string;
}

export interface GlossyAppendixDetail {
	/** Field label, or `null` for a free-text line in a metadata block. */
	label: string | null;
	value: string;
}

export interface GlossyAppendixPlaceholder {
	/** Cleaned heading of the section the placeholder came from. */
	heading: string | null;
	text: string;
}

export interface GlossyAppendixAssumption {
	heading: string | null;
	/** The statement, without its qualifier. */
	text: string;
	status: Exclude<GlossyClaimStatus, "CONFIRMED">;
	qualifier: GlossyQualifier;
}

export interface GlossyAppendix {
	sources: GlossyAppendixSource[];
	/** Document-control and cover fields (R12). */
	details: GlossyAppendixDetail[];
	/** TBD and placeholder fields, lines, and table rows moved out of the main flow (R12). */
	placeholders: GlossyAppendixPlaceholder[];
	/** Every statement kept with a qualifier (R41). */
	assumptions: GlossyAppendixAssumption[];
	/** The source document's own Appendix section, cleaned like the main flow. */
	additionalMaterial: GlossySection[];
}

export type GlossyCleanupIssueKind =
	| "unbalanced_parenthetical"
	| "overlong_parenthetical"
	| "residual_marker";

export interface GlossyCleanupIssue {
	kind: GlossyCleanupIssueKind;
	heading: string | null;
	/** The offending text, truncated. */
	excerpt: string;
}

export interface GlossyCleanupResult {
	/** Text of a leading `#` title heading, cleaned; `null` when there is none. */
	title: string | null;
	sections: GlossySection[];
	appendix: GlossyAppendix;
	/** No main-flow section survived cleanup. */
	nothingToPresent: boolean;
	/**
	 * No scaffolding rule for the document's type matched, or citation-like
	 * text is still in the main flow after cleanup (KTD11).
	 */
	scaffoldingUnrecognized: boolean;
	issues: GlossyCleanupIssue[];
}

export interface GlossyCleanupOptions {
	/**
	 * The document's project. An `<img data-s3-key>` whose key sits under
	 * `document-media/<projectId>/` is the document's own upload and
	 * becomes an anchor.
	 */
	projectId?: string;
	/** Overrides the `projectId` rule when set. */
	isOwnImageKey?: (s3Key: string) => boolean;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** A heading's escaped ordered marker, `## 1\. Proposal Cover`, left by the editor's serializer. */
const HEADING_ORDERED_ESCAPE = /^(#{1,6}[ \t]+)(\d+)\\\.(\s)/;

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * Opener of a status parenthetical: `(` then optional emphasis, then a
 * Status / Evidence / Confidence label and a colon. Sticky, tested at each `(`.
 */
const PARENTHETICAL_OPENER =
	/\(\s*(?:(?:\*\*|__|\*|_)\s*)?(?:status|evidence|confidence)\s*(?:(?:\*\*|__|\*|_)\s*)?:/iy;

const PARENTHETICAL_OPENER_ANYWHERE = new RegExp(
	PARENTHETICAL_OPENER.source,
	"i",
);

/** Longest status parenthetical the balanced scan will remove. */
const MAX_PARENTHETICAL_LENGTH = 400;

const STATUS_LABEL_VALUE =
	/(?:^|[\s;,(])(?:\*\*|__)?(?:status|confidence)(?:\*\*|__)?\s*:(?:\*\*|__)?\s*([^;),]*)/i;

const EVIDENCE_LABEL = /(?:^|[\s;,(*_])evidence\s*(?:\*\*|__)?\s*:/i;

/** A whole line that is only a status tag or an evidence pointer. */
const STATUS_TAG_LINE =
	/^\s*(?:[-*+]\s+)?(?:\*\*|__)?(evidence|status|confidence)(?:\*\*|__)?\s*:(?:\*\*|__)?\s*(.*)$/i;

/**
 * `[S1]`, `\[S2\]` (escaped by the editor's serializer), `[S1, S3]`,
 * `[S1–S3]`, `[cite]`, `[cite if derived]`, optionally bolded or linked.
 */
const MARKER_CORE = String.raw`\\?\[(?:cite\b[^\]\n]{0,80}|S\d{1,4}(?:\s{0,2}[,;–—-]\s{0,2}S?\d{1,4}){0,20})\\?\](?:\([^()\s]{0,200}\))?`;
const CITATION_MARKER = new RegExp(
	String.raw`\*\*${MARKER_CORE}\*\*|__${MARKER_CORE}__|${MARKER_CORE}`,
	"gi",
);

/**
 * Anything still citation-like after cleanup: `[S1]`, `[cite]`, `[1]`,
 * `[^2]`, `[R1]`, `[REF-2, REF-3]`, `【3】`. A markdown link (`[x](…)`) is not.
 */
const RESIDUAL_MARKER =
	/\\?\[(?:\^?\d{1,4}|[A-Za-z]{1,6}[-\s]?\d{1,4}(?:\s{0,2}[,;–—-]\s{0,2}[A-Za-z]{0,6}[-\s]?\d{1,4}){0,20}|cite\b[^\]\n]{0,80})\\?\](?!\()|【[^】\n]{1,40}】/;

const INLINE_CODE = /`[^`\n]*`/g;

/** A heading's trailing parenthetical. Only template tags are stripped (see `isHeadingTag`). */
const HEADING_TAG_SUFFIX = /\(([^()]*)\)\s*$/;

const HEADING_TAG_WORDS =
	/^(?:required|optional|recommended|lightweight|draft|approval section|contract[- ]ready|if applicable|as applicable|if known|if relevant|include if\b.*)$/i;

/**
 * Template instructions left in a field label: `Decision ask (one line):`.
 * Not anchored to the line start — the editor joins soft-broken lines, so a
 * label can sit mid-line.
 */
const LABEL_TAG =
	/[ \t]{0,4}\((?:one line|\d+\s*[–-]\s*\d+\s+bullets?|max \d+|if known|typed|required|optional)\)(?=\s*(?:(?:\*\*|__)\s*)?:)/gi;

const CLAIM_STATUS_WORD =
	"(?:directionally confirmed|derived dependency|confirmed|assumed|tbd)";

/**
 * A `Confidence:` / `Status:` tag ending a line that also holds a statement —
 * what a standalone tag line becomes once the editor joins it to the line above.
 */
const TRAILING_STATUS_TAG = new RegExp(
	String.raw`(?<=\S)\s+(?:\*\*|__)?(?:confidence|status)(?:\*\*|__)?\s*:(?:\*\*|__)?\s*(${CLAIM_STATUS_WORD}(?:\s*\/\s*${CLAIM_STATUS_WORD})*)\s*(?:\.\s*)?$`,
	"i",
);

/**
 * `Label: value`, optionally listed or bolded. The label starts on a
 * non-space so leading whitespace cannot backtrack against it.
 */
const FIELD_LINE =
	/^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?([^\s:][^:\n]{0,79}?)(?:\*\*|__)?\s*:(?:\*\*|__)?(?:\s+(.*))?$/;

const TBD_VALUE =
	/^(?:TBD|TBC|TBA|to be (?:determined|confirmed|decided))(?:$|\s*[—–:(-]|\s+(?:pending|until|once|if)\b)/i;

const PLACEHOLDER_VALUE =
	/^(?:_{3,}|\{\{?[^{}\n]{1,80}\}?\}|\.{3}|…|\?+|\[(?:TBD|TBC|placeholder|insert)[^\]\n]{0,60}\])$/i;

/** A template blank such as `<Option X>` — not an HTML tag like `<img …>` or `<br/>`. */
const ANGLE_PLACEHOLDER = /^<(?!\/?[a-z][a-z0-9-]*(?:\s|\/?>))[^<>\n]{1,80}>$/;

const INLINE_TBD = /\bTB[DC]\b/g;

/** Labels of a Business Case style header field block. */
const HEADER_LABELS = [
	"title",
	"owner",
	"status",
	"decision needed by",
	"links",
	"author",
	"version",
	"date",
	"last updated",
	"prepared by",
	"prepared for",
	"document owner",
	"document status",
	"approvers",
	"reviewers",
];
const HEADER_FIELD = new RegExp(
	String.raw`(?:^|\s)(?:\*\*|__)?(${HEADER_LABELS.join("|")})(?:\*\*|__)?\s*:(?:\*\*|__)?`,
	"gi",
);

/** Table columns that are scaffolding, not content. */
const SCAFFOLD_COLUMN =
	/^(?:status|evidence|confidence|citations?|sources?|evidence pointers?|evidence \/ sources?|sources? \/ evidence)$/;

const SEPARATOR_CELL = /^:?-+:?$/;

/** Fence languages whose body is diagram source with no Glossy renderer (R13). */
const DROPPED_DIAGRAM_LANGUAGES = new Set([
	"plantuml",
	"puml",
	"dot",
	"graphviz",
	"d2",
]);

const SLOT_LINE = new RegExp(
	String.raw`^\s*<${VISUAL_SLOT_TAG}\b([^>]*?)\/?>\s*(?:<\/${VISUAL_SLOT_TAG}>\s*)?$`,
	"i",
);
const IMG_LINE = /^\s*<img\s[^>]*>\s*$/i;
const S3_KEY_ATTR = /\sdata-s3-key="([^"]*)"/i;
const HTML_ATTR = /(?<![\w-])([\w-]+)\s*=\s*"([^"]*)"/g;

const SOURCE_INDEX_ANCHORS = new Set([
	"source index",
	"sources",
	"source list",
]);
const COVER_ANCHORS = new Set([
	"proposal cover",
	"cover",
	"cover page",
	"document control",
	"document information",
	"document metadata",
	"metadata",
]);
const APPENDIX_ANCHOR = /^appendix\b/;

type ScaffoldingRule =
	| "headerBlock"
	| "sourceIndex"
	| "statusParentheticals"
	| "statusTags"
	| "statusColumns"
	| "cover"
	| "citationMarkers"
	| "appendix";

/** Which rules count as recognizing each type's template (KTD11). */
const RULES_BY_TYPE: Record<
	GlossyEligibleDocumentType,
	ReadonlySet<ScaffoldingRule>
> = {
	BUSINESS_CASE: new Set([
		"headerBlock",
		"sourceIndex",
		"statusParentheticals",
		"statusTags",
		"statusColumns",
	]),
	PROPOSAL: new Set(["cover", "sourceIndex", "citationMarkers", "appendix"]),
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

type SegmentKind = "main" | "sources" | "cover" | "appendix";

interface Segment {
	heading: OutlineHeading | null;
	/** `heading.text` after `cleanHeading`, computed once. */
	cleanedHeading: string | null;
	bodyLines: string[];
	kind: SegmentKind;
}

interface CleanupContext {
	appendix: GlossyAppendix;
	issues: GlossyCleanupIssue[];
	rules: Set<ScaffoldingRule>;
	isOwnImageKey: (s3Key: string) => boolean;
	/** Cleaned heading of the section being processed. */
	heading: string | null;
}

/**
 * Split a document into cleaned main-flow sections, their anchors, and the
 * appendix entries (KTD11). See the module comment for the rules.
 */
export function cleanupDocument(
	markdown: string,
	type: GlossyEligibleDocumentType,
	options: GlossyCleanupOptions = {},
): GlossyCleanupResult {
	const ctx: CleanupContext = {
		appendix: {
			sources: [],
			details: [],
			placeholders: [],
			assumptions: [],
			additionalMaterial: [],
		},
		issues: [],
		rules: new Set(),
		isOwnImageKey: resolveOwnImageKey(options),
		heading: null,
	};

	const { title, segments } = segmentDocument(markdown, ctx);

	extractHeaderBlock(segments, ctx);

	const sections: GlossySection[] = [];
	for (const segment of segments) {
		ctx.heading = segment.cleanedHeading;
		switch (segment.kind) {
			case "sources":
				ctx.rules.add("sourceIndex");
				collectSources(segment.bodyLines, ctx);
				break;
			case "cover":
				ctx.rules.add("cover");
				collectCoverFields(segment.bodyLines, ctx);
				break;
			case "appendix":
				ctx.rules.add("appendix");
				ctx.appendix.additionalMaterial.push(
					cleanSegment(segment, ctx),
				);
				break;
			default:
				sections.push(cleanSegment(segment, ctx));
		}
	}

	const mainFlow = dropEmptySections(sections);
	ctx.appendix.additionalMaterial = dropEmptySections(
		ctx.appendix.additionalMaterial,
	);

	for (const section of mainFlow) {
		reportResidualMarkers(section, ctx);
	}

	const recognized = [...ctx.rules].some((rule) =>
		RULES_BY_TYPE[type].has(rule),
	);

	return {
		title,
		sections: mainFlow,
		appendix: ctx.appendix,
		nothingToPresent: mainFlow.length === 0,
		scaffoldingUnrecognized: !recognized || ctx.issues.length > 0,
		issues: ctx.issues,
	};
}

/**
 * Split section markdown into the blocks `blockIndex` counts: runs of
 * non-blank lines, a fenced block counting as content.
 */
export function splitMarkdownBlocks(markdown: string): string[] {
	return walkBody(markdown.split("\n"), () => null, false).flatMap((item) =>
		item.type === "run"
			? [item.parts.flatMap((part) => part.lines).join("\n")]
			: [],
	);
}

/**
 * Put anchors back into section text (a rewrite, or the cleaned original):
 * each goes before block `blockIndex`, or after the last block when fewer
 * remain; anchors sharing an index keep their order. The inverse of how
 * `cleanupDocument` lifts them.
 */
export function placeAnchors(
	markdown: string,
	anchors: readonly GlossyAnchor[],
	render: (anchor: GlossyAnchor) => string,
): string {
	const blocks = splitMarkdownBlocks(markdown);
	const ordered = anchors
		.map((anchor, order) => ({ anchor, order }))
		.sort(
			(a, b) =>
				a.anchor.blockIndex - b.anchor.blockIndex || a.order - b.order,
		);
	const out: string[] = [];
	let next = 0;
	for (let block = 0; block <= blocks.length; block++) {
		while (
			next < ordered.length &&
			Math.min(ordered[next].anchor.blockIndex, blocks.length) === block
		) {
			out.push(render(ordered[next].anchor));
			next++;
		}
		if (block < blocks.length) {
			out.push(blocks[block]);
		}
	}
	return out.join("\n\n");
}

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

function segmentDocument(
	markdown: string,
	ctx: CleanupContext,
): { title: string | null; segments: Segment[] } {
	const normalized = unescapeHeadingOrderedMarkers(
		markdown.replace(/\r\n?/g, "\n"),
	);
	const lines = normalized.split("\n");
	const boundaries = parseOutline(normalized).filter((h) => h.level <= 3);
	const end = lines.length + 1;

	let preamble = lines.slice(0, (boundaries[0]?.startLine ?? end) - 1);
	let first = 0;
	let title: string | null = null;
	// A leading `#` heading is the document title, not a section; its lead-in
	// text joins the preamble.
	if (boundaries[0]?.level === 1) {
		title = cleanHeading(boundaries[0].text, ctx);
		preamble = preamble.concat(
			lines.slice(
				boundaries[0].startLine,
				(boundaries[1]?.startLine ?? end) - 1,
			),
		);
		first = 1;
	}

	const segments: Segment[] = [
		{
			heading: null,
			cleanedHeading: null,
			bodyLines: preamble,
			kind: "main",
		},
	];
	let parentAnchor: string | null = null;
	for (let i = first; i < boundaries.length; i++) {
		const heading = boundaries[i];
		const anchor =
			heading.headingPath[heading.headingPath.length - 1] ?? "";
		if (heading.level <= 2) {
			parentAnchor = heading.level === 2 ? anchor : null;
		}
		const kind =
			classifyAnchor(anchor) ??
			(heading.level === 3 && parentAnchor !== null
				? classifyAnchor(parentAnchor)
				: null) ??
			"main";
		segments.push({
			heading,
			cleanedHeading: cleanHeading(heading.text, ctx),
			bodyLines: lines.slice(
				heading.startLine,
				(boundaries[i + 1]?.startLine ?? end) - 1,
			),
			kind,
		});
	}
	return { title, segments };
}

/**
 * The editor's serializer escapes a heading that reads like an ordered
 * list item (`## 1\. Proposal Cover`). Unescape heading lines before
 * outlining so the anchor path and the displayed numbering survive an
 * editor round trip. Heading lines come from `parseOutline`, so a fenced
 * `## 1\.` line is left alone.
 */
function unescapeHeadingOrderedMarkers(markdown: string): string {
	const headings = parseOutline(markdown);
	if (headings.length === 0) {
		return markdown;
	}
	const lines = markdown.split("\n");
	let changed = false;
	for (const heading of headings) {
		const index = heading.startLine - 1;
		const next = lines[index].replace(HEADING_ORDERED_ESCAPE, "$1$2.$3");
		if (next !== lines[index]) {
			lines[index] = next;
			changed = true;
		}
	}
	return changed ? lines.join("\n") : markdown;
}

function classifyAnchor(anchor: string): SegmentKind | null {
	if (SOURCE_INDEX_ANCHORS.has(anchor)) {
		return "sources";
	}
	if (COVER_ANCHORS.has(anchor)) {
		return "cover";
	}
	if (APPENDIX_ANCHOR.test(anchor)) {
		return "appendix";
	}
	return null;
}

function resolveOwnImageKey(
	options: GlossyCleanupOptions,
): (s3Key: string) => boolean {
	if (options.isOwnImageKey) {
		return options.isOwnImageKey;
	}
	const projectId = options.projectId;
	if (!projectId || projectId.includes("/")) {
		return () => false;
	}
	const prefix = `document-media/${projectId}/`;
	return (s3Key) => s3Key.startsWith(prefix) && !s3Key.includes("..");
}

// ---------------------------------------------------------------------------
// Header block, cover, and source index
// ---------------------------------------------------------------------------

/**
 * Move a Business Case header field block (`Title:`, `Owner: TBD`, …) out of
 * the main flow: the leading run of known-label field lines in the preamble,
 * or else in the first section. The editor joins soft-broken lines, so one
 * line may carry several fields.
 */
function extractHeaderBlock(segments: Segment[], ctx: CleanupContext): void {
	const candidates = [segments[0], segments[1]].filter(
		(segment): segment is Segment => segment?.kind === "main",
	);
	for (const segment of candidates) {
		ctx.heading = segment.cleanedHeading;
		let moved = false;
		let i = 0;
		for (; i < segment.bodyLines.length; i++) {
			const line = segment.bodyLines[i];
			if (!line.trim() || THEMATIC_BREAK.test(line)) {
				continue;
			}
			const fields = splitHeaderFields(line);
			if (!fields) {
				break;
			}
			for (const field of fields) {
				pushField(field.label, field.value, ctx);
			}
			moved = true;
		}
		if (moved) {
			ctx.rules.add("headerBlock");
			segment.bodyLines = segment.bodyLines.slice(i);
			return;
		}
	}
}

function splitHeaderFields(
	line: string,
): Array<{ label: string; value: string }> | null {
	const text = line.replace(LIST_MARKER, "");
	const matches = [...text.matchAll(HEADER_FIELD)];
	if (matches.length === 0 || matches[0].index !== 0) {
		return null;
	}
	return matches.map((match, i) => {
		const start = (match.index ?? 0) + match[0].length;
		const stop = matches[i + 1]?.index ?? text.length;
		return { label: match[1], value: text.slice(start, stop).trim() };
	});
}

/** A metadata field goes to details, or to placeholders when it holds no value. */
function pushField(label: string, rawValue: string, ctx: CleanupContext): void {
	const value = tidy(removeCitationMarkers(rawValue).text).trim();
	if (!value || isPlaceholderValue(value)) {
		ctx.appendix.placeholders.push({
			heading: ctx.heading,
			text: value ? `${label}: ${value}` : label,
		});
		return;
	}
	ctx.appendix.details.push({ label, value });
}

function collectCoverFields(lines: string[], ctx: CleanupContext): void {
	for (const line of lines) {
		if (!line.trim() || THEMATIC_BREAK.test(line) || isAnchorLike(line)) {
			continue;
		}
		const field = parseField(line);
		if (field) {
			pushField(field.label, field.value, ctx);
			continue;
		}
		const value = tidy(
			removeCitationMarkers(stripListMarker(line)).text,
		).trim();
		if (value) {
			ctx.appendix.details.push({ label: null, value });
		}
	}
}

function collectSources(lines: string[], ctx: CleanupContext): void {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim() || THEMATIC_BREAK.test(line) || isAnchorLike(line)) {
			continue;
		}
		if (isTableStart(lines, i)) {
			let end = i + 2;
			while (end < lines.length && isTableRow(lines[end])) {
				end++;
			}
			for (const row of lines.slice(i + 2, end)) {
				const cells = splitCells(row).filter((cell) => cell !== "");
				const idCell = cells.findIndex(
					(cell) => parseSourceId(cell) !== null,
				);
				ctx.appendix.sources.push({
					id: idCell >= 0 ? parseSourceId(cells[idCell]) : null,
					text: cells.filter((_, c) => c !== idCell).join(" — "),
				});
			}
			i = end - 1;
			continue;
		}
		// One entry per `[S#]`: the editor joins soft-broken index lines.
		const entries = stripListMarker(line)
			.trim()
			.split(/(?<=\S)\s+(?=(?:\*\*|__)?\\?\[S\d{1,4}\\?\])/i);
		for (const entry of entries) {
			const match = entry.match(
				/^(?:\*\*|__)?\\?\[(S\d{1,4})\\?\](?:\*\*|__)?\s*(?:[—–:-]\s*)?(.*)$/i,
			);
			ctx.appendix.sources.push(
				match
					? { id: match[1].toUpperCase(), text: match[2].trim() }
					: { id: null, text: entry.trim() },
			);
		}
	}
}

function parseSourceId(cell: string): string | null {
	const match = cell.replace(/[*_]/g, "").match(/^\\?\[?(S\d{1,4})\\?\]?$/i);
	return match ? match[1].toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// Sections and blocks
// ---------------------------------------------------------------------------

type WithoutBlockIndex<T> = T extends unknown ? Omit<T, "blockIndex"> : never;

/** An anchor before its block index is known. */
type AnchorDraft = WithoutBlockIndex<GlossyAnchor>;

type PendingAnchor =
	| Extract<AnchorDraft, { kind: "slot" | "image" }>
	| { kind: "dropped" };

/** A block: a run of non-blank lines, in which a fenced block is one part. */
type RunPart =
	| { type: "lines"; lines: string[] }
	| { type: "fence"; info: string; lines: string[] };

/**
 * In source order. An anchor inside a block comes after that block's item,
 * so the blocks before an anchor are exactly the runs listed before it.
 */
type BodyItem =
	| { type: "run"; parts: RunPart[] }
	| { type: "anchor"; anchor: AnchorDraft | { kind: "dropped" } };

/**
 * Walk a section body into blocks and anchors, by the rule slot
 * preservation uses (`visual-slots.ts`): a block is a run of non-blank
 * lines, a fenced block counting as content, and an anchor is transparent —
 * it neither starts nor ends a block. With `liftMermaid`, a ```mermaid fence
 * is an anchor too. Fences come from `scanFences`, the rule `parseOutline`
 * applies, so section bounds and blocks agree.
 */
function walkBody(
	lines: string[],
	anchorOf: (line: string) => PendingAnchor | null,
	liftMermaid: boolean,
): BodyItem[] {
	const items: BodyItem[] = [];
	const fences = scanFences(lines);
	let run: RunPart[] | null = null;
	let fence: { lines: string[]; mermaid: boolean } | null = null;

	const currentRun = (): RunPart[] => {
		if (!run) {
			run = [];
			items.push({ type: "run", parts: run });
		}
		return run;
	};
	const liftFence = (lines: string[], closed: boolean) => {
		items.push({
			type: "anchor",
			anchor: {
				kind: "mermaid",
				source: lines.slice(1, closed ? -1 : undefined).join("\n"),
			},
		});
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (fence) {
			fence.lines.push(line);
			if (fences[i] === "close") {
				if (fence.mermaid) {
					liftFence(fence.lines, true);
				}
				fence = null;
			}
			continue;
		}
		if (fences[i] === "open") {
			const info =
				line
					.replace(FENCE_MARKER, "")
					.trim()
					.split(/\s+/)[0]
					?.toLowerCase() ?? "";
			const mermaid = liftMermaid && info === "mermaid";
			const fenceLines = [line];
			if (!mermaid) {
				currentRun().push({ type: "fence", info, lines: fenceLines });
			}
			fence = { lines: fenceLines, mermaid };
			continue;
		}
		if (!line.trim()) {
			run = null;
			continue;
		}
		const anchor = anchorOf(line);
		if (anchor) {
			items.push({ type: "anchor", anchor });
			continue;
		}
		const parts = currentRun();
		const last = parts[parts.length - 1];
		if (last?.type === "lines") {
			last.lines.push(line);
		} else {
			parts.push({ type: "lines", lines: [line] });
		}
	}
	// An unclosed fence runs to the end, as it does for `parseOutline`.
	if (fence?.mermaid) {
		liftFence(fence.lines, false);
	}
	return items;
}

function cleanSegment(segment: Segment, ctx: CleanupContext): GlossySection {
	const items = walkBody(
		segment.bodyLines,
		(line) => anchorForLine(line, ctx),
		true,
	);
	const textBlocks: string[] = [];
	const anchors: GlossyAnchor[] = [];

	for (const item of items) {
		if (item.type === "run") {
			const block = cleanRun(item.parts, ctx);
			if (block !== "") {
				textBlocks.push(block);
			}
		} else if (item.anchor.kind !== "dropped") {
			// Only blocks that survived cleanup count, so an anchor keeps its
			// place relative to the text around it.
			anchors.push({ ...item.anchor, blockIndex: textBlocks.length });
		}
	}

	return {
		heading: segment.heading ? ctx.heading : null,
		level: segment.heading?.level ?? 0,
		headingPath: segment.heading ? [...segment.heading.headingPath] : [],
		occurrenceIndex: segment.heading?.occurrenceIndex ?? 0,
		markdown: textBlocks.join("\n\n"),
		anchors,
	};
}

/** Clean one block. Code fences stay as written; diagram-only fences go (R13). */
function cleanRun(parts: RunPart[], ctx: CleanupContext): string {
	const lines: string[] = [];
	for (const part of parts) {
		if (part.type === "fence") {
			if (!DROPPED_DIAGRAM_LANGUAGES.has(part.info)) {
				lines.push(...part.lines);
			}
			continue;
		}
		lines.push(...cleanTextBlock(part.lines, ctx));
	}
	return lines.join("\n");
}

function anchorForLine(
	line: string,
	ctx: CleanupContext,
): PendingAnchor | null {
	const slot = line.match(SLOT_LINE);
	if (slot) {
		const attrs = parseAttributes(slot[1]);
		const slotId = attrs.get(VISUAL_SLOT_ID_ATTR);
		// A slot without an id cannot be filled or keyed; it is layout only,
		// so it is dropped rather than left as raw HTML in the text.
		if (!slotId) {
			return { kind: "dropped" };
		}
		return {
			kind: "slot",
			slotId,
			slotKind: attrs.get(VISUAL_SLOT_KIND_ATTR) || null,
			hint: attrs.get(VISUAL_SLOT_HINT_ATTR) || null,
			markdown: line.trim(),
		};
	}
	if (IMG_LINE.test(line)) {
		const key = line.match(S3_KEY_ATTR)?.[1];
		if (key && ctx.isOwnImageKey(key)) {
			return { kind: "image", s3Key: key, markdown: line.trim() };
		}
	}
	return null;
}

function isAnchorLike(line: string): boolean {
	return SLOT_LINE.test(line) || IMG_LINE.test(line);
}

function parseAttributes(source: string): Map<string, string> {
	const attrs = new Map<string, string>();
	for (const match of source.matchAll(HTML_ATTR)) {
		attrs.set(match[1].toLowerCase(), decodeEntities(match[2]));
	}
	return attrs;
}

function decodeEntities(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/**
 * Keep a `##` whose text emptied out only while a deeper section under it
 * survives, so R15's heading structure holds; drop every other empty one.
 */
function dropEmptySections(sections: GlossySection[]): GlossySection[] {
	const keep = sections.map(
		(section) =>
			section.markdown.trim() !== "" || section.anchors.length > 0,
	);
	for (let i = sections.length - 1; i >= 0; i--) {
		if (keep[i] || sections[i].heading === null) {
			continue;
		}
		for (let j = i + 1; j < sections.length; j++) {
			if (sections[j].level <= sections[i].level) {
				break;
			}
			if (keep[j]) {
				keep[i] = true;
				break;
			}
		}
	}
	return sections.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

type Piece =
	| { kind: "text"; text: string }
	| { kind: "verbatim"; text: string }
	| { kind: "status"; status: GlossyClaimStatus | null };

interface FoundStatus {
	status: Exclude<GlossyClaimStatus, "CONFIRMED">;
	qualifier: GlossyQualifier;
	statement: string;
}

function cleanTextBlock(lines: string[], ctx: CleanupContext): string[] {
	const out: string[] = [];
	let lead: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		if (isTableStart(lines, i)) {
			let end = i + 2;
			while (end < lines.length && isTableRow(lines[end])) {
				end++;
			}
			out.push(...cleanTable(lines.slice(i, end), ctx));
			i = end - 1;
			continue;
		}
		const cleaned = cleanLine(lines[i], lead, ctx);
		if (cleaned !== null) {
			out.push(cleaned.text);
			lead ??= cleaned.statement;
		}
	}
	return out;
}

/**
 * Clean one line. Returns `null` when the line leaves the main flow.
 * `blockLead` is the first kept statement of the block, which a standalone
 * `Confidence:` line qualifies.
 */
function cleanLine(
	line: string,
	blockLead: string | null,
	ctx: CleanupContext,
): { text: string; statement: string } | null {
	if (THEMATIC_BREAK.test(line)) {
		return null;
	}

	const tag = line.match(STATUS_TAG_LINE);
	if (tag) {
		if (tag[1].toLowerCase() === "evidence") {
			ctx.rules.add("statusTags");
			return null;
		}
		const status = parseClaimStatus(tag[2]);
		if (status) {
			ctx.rules.add("statusTags");
			const statement = blockLead ?? ctx.heading;
			if (statement) {
				recordAssumption(status, statement, ctx);
			}
			return null;
		}
	}

	let working = line.replace(LABEL_TAG, "");
	const trailing = working.match(TRAILING_STATUS_TAG);
	const trailingStatus = trailing ? parseClaimStatus(trailing[1]) : null;
	if (trailing?.index && trailingStatus) {
		ctx.rules.add("statusTags");
		working = working.slice(0, trailing.index);
	}
	const scan = stripScaffolding(working, ctx);
	const hasVerbatim = scan.pieces.some((piece) => piece.kind === "verbatim");
	const bare = tidy(barePieces(scan.pieces));

	// A never-partially-deleted verbatim region pins the line in place.
	if (!hasVerbatim && isPlaceholderLine(bare)) {
		ctx.appendix.placeholders.push({
			heading: ctx.heading,
			text: stripListMarker(bare).trim(),
		});
		return null;
	}

	const assembled = assemble(scan.pieces);
	const changed = working !== line || scan.changed || assembled.tbdReplaced;
	let text = line;
	if (changed) {
		const verbatim = scan.pieces.find((piece) => piece.kind === "verbatim");
		// The verbatim region is always last; only the text before it is tidied.
		text = verbatim
			? `${tidyGaps(assembled.text.slice(0, -verbatim.text.length))}${verbatim.text}`.trimEnd()
			: tidy(assembled.text);
	}
	if (!stripListMarker(text).replace(/[*_\s]/g, "")) {
		return null;
	}

	const whole = statementText(assembled.bare);
	if (trailing?.index && trailingStatus) {
		recordAssumption(trailingStatus, blockLead ?? whole, ctx);
	}
	for (const found of assembled.found) {
		recordAssumption(
			found.status,
			statementText(found.statement) || whole,
			ctx,
		);
	}
	if (
		assembled.tbdReplaced &&
		!assembled.found.some((found) => found.status === "TBD")
	) {
		recordAssumption("TBD", whole, ctx);
	}
	return { text, statement: whole };
}

/**
 * Remove status parentheticals and citation markers from `text`.
 * Parentheticals become `status` pieces (the caller turns them into
 * qualifiers); an unbalanced or over-long one becomes a `verbatim` piece
 * that runs to the end of the text and is reported.
 */
function stripScaffolding(
	text: string,
	ctx: CleanupContext,
): { pieces: Piece[]; changed: boolean } {
	const pieces: Piece[] = [];
	let changed = false;
	let cursor = 0;
	let search = 0;

	while (search < text.length) {
		const open = text.indexOf("(", search);
		if (open === -1) {
			break;
		}
		PARENTHETICAL_OPENER.lastIndex = open;
		if (!PARENTHETICAL_OPENER.test(text)) {
			search = open + 1;
			continue;
		}

		const limit = Math.min(text.length, open + MAX_PARENTHETICAL_LENGTH);
		let depth = 0;
		let close = -1;
		for (let j = open; j < limit; j++) {
			const ch = text[j];
			if (ch === "\\") {
				j++;
			} else if (ch === "(") {
				depth++;
			} else if (ch === ")") {
				depth--;
				if (depth === 0) {
					close = j;
					break;
				}
			}
		}

		const content = text.slice(open + 1, close === -1 ? limit : close);
		if (!isScaffoldingParenthetical(content)) {
			search = open + 1;
			continue;
		}

		if (close === -1) {
			ctx.issues.push({
				kind:
					limit < text.length
						? "overlong_parenthetical"
						: "unbalanced_parenthetical",
				heading: ctx.heading,
				excerpt: excerpt(text.slice(open)),
			});
			pieces.push({ kind: "text", text: text.slice(cursor, open) });
			pieces.push({ kind: "verbatim", text: text.slice(open) });
			cursor = text.length;
			break;
		}

		ctx.rules.add("statusParentheticals");
		changed = true;
		pieces.push({ kind: "text", text: text.slice(cursor, open) });
		pieces.push({ kind: "status", status: statusOfParenthetical(content) });
		cursor = close + 1;
		search = cursor;
	}
	if (cursor < text.length) {
		pieces.push({ kind: "text", text: text.slice(cursor) });
	}

	for (const piece of pieces) {
		if (piece.kind === "text") {
			const removed = removeCitationMarkers(piece.text);
			if (removed.count > 0) {
				ctx.rules.add("citationMarkers");
				changed = true;
				piece.text = removed.text;
			}
		}
	}
	return { pieces, changed };
}

function isScaffoldingParenthetical(content: string): boolean {
	if (EVIDENCE_LABEL.test(content)) {
		return true;
	}
	return statusOfParenthetical(content) !== null;
}

function statusOfParenthetical(content: string): GlossyClaimStatus | null {
	const match = content.match(STATUS_LABEL_VALUE);
	return match ? parseClaimStatus(match[1]) : null;
}

/**
 * Join pieces into text: qualifiers inserted after the statement each
 * status parenthetical annotated, and inline TBDs turned into "to be
 * confirmed". Also returns the bare text (no qualifiers) and each
 * non-confirmed statement.
 */
function assemble(pieces: Piece[]): {
	text: string;
	bare: string;
	found: FoundStatus[];
	tbdReplaced: boolean;
} {
	let text = "";
	let bare = "";
	let statement = "";
	let tbdReplaced = false;
	const found: FoundStatus[] = [];

	for (const piece of pieces) {
		if (piece.kind === "status") {
			const qualifier = piece.status
				? GLOSSY_STATUS_QUALIFIERS[piece.status]
				: null;
			if (piece.status && piece.status !== "CONFIRMED" && qualifier) {
				if (!statement.toLowerCase().includes(qualifier)) {
					text += ` (${qualifier})`;
				}
				found.push({ status: piece.status, qualifier, statement });
			}
			statement = "";
			continue;
		}
		let chunk = piece.text;
		if (piece.kind === "text") {
			const source = piece.text;
			const atStart = text === "";
			chunk = source.replace(INLINE_TBD, (_match, offset: number) => {
				tbdReplaced = true;
				const before = source.slice(0, offset);
				return atStart &&
					/^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*|__)?$/.test(before)
					? "To be confirmed"
					: "to be confirmed";
			});
		}
		text += chunk;
		bare += chunk;
		statement += chunk;
	}
	return { text, bare, found, tbdReplaced };
}

/** The pieces' text with parentheticals dropped and no qualifiers added. */
function barePieces(pieces: Piece[]): string {
	return pieces
		.map((piece) => (piece.kind === "status" ? "" : piece.text))
		.join("");
}

function recordAssumption(
	status: GlossyClaimStatus,
	text: string,
	ctx: CleanupContext,
): void {
	const qualifier = GLOSSY_STATUS_QUALIFIERS[status];
	const statement = text.trim();
	if (status === "CONFIRMED" || !qualifier || !statement) {
		return;
	}
	ctx.appendix.assumptions.push({
		heading: ctx.heading,
		text: statement,
		status,
		qualifier,
	});
}

function removeCitationMarkers(text: string): { text: string; count: number } {
	let count = 0;
	const out = text.replace(CITATION_MARKER, () => {
		count++;
		return "";
	});
	return { text: count > 0 ? out : text, count };
}

function parseClaimStatus(value: string): GlossyClaimStatus | null {
	const normalized = value.replace(/[*_`]/g, "").trim().toLowerCase();
	if (!normalized || /^-{3,}$|^_{3,}$/.test(normalized)) {
		return "TBD";
	}
	if (normalized.startsWith("directionally confirmed")) {
		return "DIRECTIONALLY_CONFIRMED";
	}
	if (normalized.startsWith("derived")) {
		return "DERIVED_DEPENDENCY";
	}
	if (normalized.startsWith("assum")) {
		return "ASSUMED";
	}
	if (/^(?:tbd|tbc|to be confirmed|unknown)\b/.test(normalized)) {
		return "TBD";
	}
	if (normalized.startsWith("confirmed")) {
		return "CONFIRMED";
	}
	return null;
}

function parseField(line: string): { label: string; value: string } | null {
	const match = line.match(FIELD_LINE);
	if (!match) {
		return null;
	}
	const value = (match[2] ?? "").trim();
	// `See https://…` is not a field.
	if (value.startsWith("//")) {
		return null;
	}
	const label = match[1].replace(/[*_]/g, "").trim();
	return label ? { label, value } : null;
}

function isTbdValue(value: string): boolean {
	return TBD_VALUE.test(value.replace(/[*_`"']/g, "").trim());
}

function isPlaceholderValue(value: string): boolean {
	const stripped = value.replace(/[*_`"']/g, "").trim();
	return (
		TBD_VALUE.test(stripped) ||
		PLACEHOLDER_VALUE.test(stripped) ||
		ANGLE_PLACEHOLDER.test(stripped)
	);
}

/** A line whose only content is a placeholder, or a field whose value is one. */
function isPlaceholderLine(bare: string): boolean {
	const content = stripListMarker(bare).trim();
	if (!content) {
		return false;
	}
	if (isPlaceholderValue(content)) {
		return true;
	}
	const field = parseField(bare);
	return Boolean(field?.value && isPlaceholderValue(field.value));
}

function statementText(text: string): string {
	return tidy(stripListMarker(text)).trim();
}

function stripListMarker(text: string): string {
	return text.replace(LIST_MARKER, "");
}

/**
 * Close the gaps a removal leaves: doubled spaces, a space before
 * punctuation, and parentheses emptied of their markers. Never removes
 * words, so it cannot join fragments into a new marker.
 */
function tidy(text: string): string {
	return tidyGaps(text).trimEnd();
}

function tidyGaps(text: string): string {
	return (
		text
			.replace(/\(\s*(?:[,;]\s*)*\)/g, "")
			.replace(/(\S)[ \t]{2,}/g, "$1 ")
			// Anchored on the preceding character so a long run of spaces stays linear.
			.replace(/(^|\S)[ \t]+(?=[.,;:!?])/g, "$1")
	);
}

function excerpt(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

/**
 * Numbering stays; template tag suffixes ("(Required)", "(Include if
 * known)") and scaffolding go. A descriptive parenthetical such as
 * "(What We're Building)" stays.
 */
function cleanHeading(text: string, ctx: CleanupContext): string {
	const scan = stripScaffolding(text, ctx);
	let heading = tidy(barePieces(scan.pieces)).trim();
	for (;;) {
		const match = heading.match(HEADING_TAG_SUFFIX);
		if (!match || match.index === undefined || !isHeadingTag(match[1])) {
			break;
		}
		heading = heading.slice(0, match.index).trimEnd();
	}
	return heading;
}

function isHeadingTag(content: string): boolean {
	const normalized = content.replace(/[*_]/g, "").trim();
	return HEADING_TAG_WORDS.test(normalized) || /\bTBD\b/i.test(normalized);
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function isTableRow(line: string): boolean {
	return /^ {0,3}\|/.test(line);
}

function isTableStart(lines: string[], i: number): boolean {
	return (
		isTableRow(lines[i]) &&
		i + 1 < lines.length &&
		isTableRow(lines[i + 1]) &&
		splitCells(lines[i + 1]).every((cell) =>
			SEPARATOR_CELL.test(cell.replace(/\s/g, "")),
		)
	);
}

function splitCells(row: string): string[] {
	let body = row.trim();
	if (body.startsWith("|")) {
		body = body.slice(1);
	}
	if (body.endsWith("|") && !body.endsWith("\\|")) {
		body = body.slice(0, -1);
	}
	const cells: string[] = [];
	let current = "";
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "\\" && i + 1 < body.length) {
			current += ch + body[i + 1];
			i++;
		} else if (ch === "|") {
			cells.push(current.trim());
			current = "";
		} else {
			current += ch;
		}
	}
	cells.push(current.trim());
	return cells;
}

/**
 * Drop Status / Evidence columns; move a row whose key cell (the Metric
 * column, else the first) is a placeholder to the appendix; turn a TBD
 * cell into "to be confirmed"; qualify a row whose Status is not
 * Confirmed. An untouched table comes back verbatim.
 */
function cleanTable(rows: string[], ctx: CleanupContext): string[] {
	const header = splitCells(rows[0]);
	const separator = splitCells(rows[1]);
	const label = (cell: string) => cell.replace(/[*_`]/g, "").trim();
	const dropped = new Set(
		header.flatMap((cell, i) =>
			SCAFFOLD_COLUMN.test(label(cell).toLowerCase()) ? [i] : [],
		),
	);
	const kept = header.map((_, i) => i).filter((i) => !dropped.has(i));
	if (dropped.size > 0) {
		ctx.rules.add("statusColumns");
	}
	if (kept.length === 0) {
		return [];
	}
	const statusColumn = header.findIndex((cell) =>
		/^(?:status|confidence)$/i.test(label(cell)),
	);
	const keyColumn =
		kept.find((i) => /^metric\b/i.test(label(header[i]))) ?? kept[0];

	let changed = dropped.size > 0;
	const out: string[][] = [];
	for (const row of rows.slice(2).map(splitCells)) {
		const scans = kept.map((i) => stripScaffolding(row[i] ?? "", ctx));
		const bare = scans.map((scan) => tidy(barePieces(scan.pieces)).trim());
		const summary = kept
			.map((column, k) =>
				bare[k] ? `${label(header[column])}: ${bare[k]}` : "",
			)
			.filter(Boolean)
			.join("; ");
		const keyCell = bare[kept.indexOf(keyColumn)];
		if (
			isPlaceholderValue(keyCell) ||
			bare.every((cell) => !cell || isPlaceholderValue(cell))
		) {
			ctx.appendix.placeholders.push({
				heading: ctx.heading,
				text: summary,
			});
			changed = true;
			continue;
		}

		let tbd = false;
		const cells = scans.map((scan, k) => {
			// An unbalanced parenthetical keeps its cell exactly as written.
			if (scan.pieces.some((piece) => piece.kind === "verbatim")) {
				return row[kept[k]] ?? "";
			}
			if (bare[k] && isTbdValue(bare[k])) {
				tbd = true;
				return "to be confirmed";
			}
			const assembled = assemble(scan.pieces);
			tbd ||= assembled.tbdReplaced;
			for (const found of assembled.found) {
				recordAssumption(found.status, summary, ctx);
			}
			return scan.changed || assembled.tbdReplaced
				? tidy(assembled.text).trim()
				: (row[kept[k]] ?? "");
		});
		changed ||= tbd || scans.some((scan) => scan.changed);

		const status =
			statusColumn >= 0
				? parseClaimStatus(row[statusColumn] ?? "")
				: null;
		const qualifier = status ? GLOSSY_STATUS_QUALIFIERS[status] : null;
		if (status && qualifier) {
			// Next to the figure when there is one (AE11), else on the last cell.
			const numeric = cells.findIndex(
				(cell, k) => kept[k] !== keyColumn && /\d/.test(cell),
			);
			let target = numeric;
			for (let k = cells.length - 1; target < 0 && k >= 0; k--) {
				if (cells[k] !== "") {
					target = k;
				}
			}
			if (
				target >= 0 &&
				!cells[target].toLowerCase().includes(qualifier)
			) {
				cells[target] = `${cells[target]} (${qualifier})`;
			}
			recordAssumption(status, summary, ctx);
		} else if (tbd) {
			recordAssumption("TBD", summary, ctx);
		}
		out.push(cells);
	}

	if (!changed) {
		return rows;
	}
	if (out.length === 0) {
		return [];
	}
	const serialize = (cells: string[]) => `| ${cells.join(" | ")} |`;
	return [
		serialize(kept.map((i) => header[i])),
		serialize(
			kept.map((i) => {
				const cell = (separator[i] ?? "").replace(/\s/g, "");
				return SEPARATOR_CELL.test(cell) ? cell : "---";
			}),
		),
		...out.map(serialize),
	];
}

// ---------------------------------------------------------------------------
// Residual markers
// ---------------------------------------------------------------------------

function reportResidualMarkers(
	section: GlossySection,
	ctx: CleanupContext,
): void {
	const texts = [section.heading ?? ""];
	for (const item of walkBody(
		section.markdown.split("\n"),
		() => null,
		false,
	)) {
		if (item.type === "run") {
			for (const part of item.parts) {
				if (part.type === "lines") {
					texts.push(...part.lines);
				}
			}
		}
	}
	for (const text of texts) {
		// A status parenthetical still here was left verbatim and is already
		// reported; scan only what comes before it.
		const opener = text.search(PARENTHETICAL_OPENER_ANYWHERE);
		const scanned = opener === -1 ? text : text.slice(0, opener);
		const match = scanned.replace(INLINE_CODE, "").match(RESIDUAL_MARKER);
		if (match) {
			ctx.issues.push({
				kind: "residual_marker",
				heading: section.heading,
				excerpt: excerpt(match[0]),
			});
		}
	}
}
