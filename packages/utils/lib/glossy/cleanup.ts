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
 *   `Evidence:` / `Confidence:` lines, inline `Evidence: [S2] — anchor` and
 *   `Sources: [S1], [S3]` clauses, and Status / Evidence table columns.
 * - Proposal: `1. Proposal Cover`, `1A. Source Index`, `[cite]` and `[S#]`
 *   markers, and an optional Appendix section, which merges into
 *   `appendix.additionalMaterial`.
 * - Either: `(Source: …)` parentheticals, whose labelled source moves to the
 *   appendix once; footnote definitions; a `References`-family section whose
 *   entries are citation-shaped; footnote `[^1]` markers when the document
 *   has footnote definitions or a source index; and numeric `[1]` markers
 *   only for a number that footnote definitions or a numbered source list
 *   define — an `[S#]` index alone never makes `[1]` a citation. That
 *   apparatus usually sits after the text that cites it, so a pre-pass
 *   decides it before any section is cleaned.
 * Every rule runs on both types; `type` only decides which style counts as
 * "recognized" for `scaffoldingUnrecognized`.
 *
 * Sectioning comes from U17's `parseOutline` (the one fence-aware heading
 * walker). A segment is a `##` section, or a `###` subsection where present;
 * a `##` with `###` children keeps its own lead-in text as a section. A
 * section's heading path leaves out the document's `#` title, so renaming
 * the title keeps every section key; `parseOutline`, which slot
 * preservation keys on, still includes it.
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
	/**
	 * From `parseOutline`, without the document's `#` title, so renaming the
	 * title changes no section key; `[]` for text before the first heading.
	 */
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
 * Status / Evidence / Confidence / Source label and a colon. Sticky, tested
 * at each `(`.
 */
const PARENTHETICAL_OPENER =
	/\(\s*(?:(?:\*\*|__|\*|_)\s*)?(?:status|evidence|confidence|sources?)\s*(?:(?:\*\*|__|\*|_)\s*)?:/iy;

const PARENTHETICAL_OPENER_ANYWHERE = new RegExp(
	PARENTHETICAL_OPENER.source,
	"i",
);

/** Longest status parenthetical the balanced scan will remove. */
const MAX_PARENTHETICAL_LENGTH = 400;

const STATUS_LABEL_VALUE =
	/(?:^|[\s;,(])(?:\*\*|__)?(?:status|confidence)(?:\*\*|__)?\s*:(?:\*\*|__)?\s*([^;),]*)/i;

const EVIDENCE_LABEL = /(?:^|[\s;,(*_])evidence\s*(?:\*\*|__)?\s*:/i;

const SOURCE_LABEL = /(?:^|[\s;,(*_])sources?\s*(?:\*\*|__)?\s*:/i;

/** A labelled part of a parenthetical, `Source: Acme report`, split on `;`. */
const PARENTHETICAL_PART_LABEL =
	/^\s*(?:(?:\*\*|__|\*|_)\s*)?(status|confidence|evidence|sources?)\s*(?:(?:\*\*|__|\*|_)\s*)?:(?:\*\*|__|\*|_)?/i;

/**
 * A whole line that is only a status tag or an evidence pointer; group 2 is
 * the value, absent when empty. The value starts on a non-space: `.` stops
 * at a line separator (U+2028) that `\s` still matches, so a plain `(.*)`
 * after `\s*` backtracked quadratically over a whitespace run.
 */
const STATUS_TAG_LINE =
	/^\s*(?:[-*+]\s+)?(?:\*\*|__)?(evidence|status|confidence)(?:\*\*|__)?\s*:(?:\*\*|__)?\s*(\S.*)?$/i;

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
 * `[1]`, `[1, 3]`, `[2–4]`, `[^2]`, `[^vendor]`, and the editor's escaped
 * forms. At most three digits, so a bracketed year such as `[2025]` is
 * never a citation.
 */
const NUMERIC_MARKER_CORE = String.raw`\\?\[(?:\d{1,3}(?:\s{0,2}[,;–—-]\s{0,2}\d{1,3}){0,20}|\^[A-Za-z0-9_-]{1,32})\\?\]`;
const NUMERIC_MARKER_RUN = `(?:${NUMERIC_MARKER_CORE}){1,20}`;
const NUMERIC_MARKER_CORES = new RegExp(NUMERIC_MARKER_CORE, "g");

/**
 * A run of numeric or footnote markers, removed only when the document's
 * own apparatus defines them (see `isNumericCitation`). A bare `[1]` is also
 * array indexing (`arr[1]`), a reference-style link (`[text][1]`,
 * `[1]: https://…`, `[1](…)`) or code, so the run must follow whitespace,
 * punctuation or the start of the text, and must not run into a word, a
 * `(`, a `:` or another bracket. Inline code is skipped by the caller.
 */
const NUMERIC_MARKER = new RegExp(
	String.raw`(?<![\p{L}\p{N}\]\\])(?:\*\*${NUMERIC_MARKER_RUN}\*\*|__${NUMERIC_MARKER_RUN}__|${NUMERIC_MARKER_RUN})(?![(:[\p{L}\p{N}]|\\\[)`,
	"gu",
);

/** Any citation or numeric marker, to test for rather than remove. */
const REFERENCE_MARKER = new RegExp(
	`${MARKER_CORE}|${NUMERIC_MARKER_CORE}`,
	"i",
);

/**
 * A footnote definition, `[^2]: Vendor survey 2025`, escaped or not. The
 * value is one quantifier over every character, line separators included
 * (the `s` flag's `.`, which this package's compile target lacks), trimmed
 * by the caller: `[ \t]*(.*)$` let a space run before a line separator
 * (U+2028) backtrack quadratically.
 */
const FOOTNOTE_DEFINITION =
	/^ {0,3}\\?\[\^([A-Za-z0-9_-]{1,32})\\?\]:([\s\S]*)$/;

/**
 * Where the editor may have joined a further footnote definition onto the
 * line; group 1 is its id. `parseFootnoteDefinitions` decides whether it
 * did. Linear: only the first space of a run passes the lookbehind.
 */
const FOOTNOTE_DEFINITION_JOIN =
	/(?<=\S)[ \t]+(?=\\?\[\^([A-Za-z0-9_-]{1,32})\\?\]:)/g;

/**
 * An inline evidence or source clause's label, `Evidence:` or `Sources:`,
 * optionally bolded and optionally led by a qualifier word (`Data
 * sources:`, `Key evidence:`). Word-delimited, so `Non-evidence:` is not
 * one. Whether it opens a clause or is prose is `opensClause`'s call.
 */
const CLAUSE_LABEL =
	/(?<![\p{L}\p{N}-])(?:\*\*|__)?(?:(?:data|key|supporting|primary)[ \t]{1,4})?(?:evidence|sources?)(?:\*\*|__)?[ \t]{0,4}:(?:\*\*|__)?/giu;

/**
 * One reference after a clause label: a citation marker, a numeric marker
 * (group 1, a citation only when the apparatus defines it), or `n/a`
 * (group 2). Sticky, so the references are read one after another from the
 * label.
 */
const CLAUSE_REFERENCE = new RegExp(
	String.raw`[ \t]{0,4}(?:(?:[,;]|and(?=[ \t]))[ \t]{0,4})?(?:\*\*${MARKER_CORE}\*\*|__${MARKER_CORE}__|${MARKER_CORE}|(${NUMERIC_MARKER_CORE})|(n\/a)(?![\p{L}\p{N}]))`,
	"iuy",
);

/**
 * The dash or colon between a clause's references and its anchor text;
 * group 1 is the dash or colon, absent when there is none.
 */
const CLAUSE_SEPARATOR = /[ \t]{0,4}(?:([—–:-]{1,2})[ \t]{0,4})?/y;

/**
 * The indentation and list marker a clause label may follow at the start of
 * a text. Anchored, so it runs once per text.
 */
const LINE_LEAD = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?/;

/**
 * The end of the text before a label that opens a clause: a sentence end
 * (with an optional closing quote, bracket or emphasis), `;` or `(`. Tested
 * on a short window before the label.
 */
const CLAUSE_OPENER =
	/(?:[.!?]["'”’)\]]?(?:\*\*|__|\*|_)?[ \t]{1,8}|[;(][ \t]{0,8})(?:\*\*|__|\*|_)?$/u;

/**
 * Where a clause's anchor text stops: the next scaffolding label, which
 * starts its own clause or tag.
 */
const CLAUSE_STOP_LABEL =
	/(?<![\p{L}\p{N}-])(?:\*\*|__)?(?:(?:data|key|supporting|primary)[ \t]{1,4})?(?:evidence|sources?|status|confidence)(?:\*\*|__)?[ \t]{0,4}:/giu;

/**
 * The `;` or `,` joining a clause with no anchor to the next label
 * (`Evidence: [S1]; Sources: [S2]`), which goes with the clause. Sticky.
 */
const CLAUSE_JOINER =
	/[ \t]{0,4}[;,][ \t]{0,4}(?=(?:\*\*|__)?(?:(?:data|key|supporting|primary)[ \t]{1,4})?(?:evidence|sources?|status|confidence)(?:\*\*|__)?[ \t]{0,4}:)/iy;

/**
 * The first character of a statement: an uppercase letter, a digit, a
 * currency sign, emphasis, or an opening quote.
 */
const STATEMENT_START = /[\p{Lu}\p{N}$€£*_"“'‘]/u;

/**
 * A sentence end: `.`, `!` or `?`, an optional closing quote or bracket,
 * then whitespace and the start of a statement.
 */
const SENTENCE_END = /[.!?]["'”’)\]]?(?=\s+[\p{Lu}\p{N}$€£*_"“'‘])/u;

/** Anchor text that ends a sentence, and so may carry a joined statement. */
const ENDS_SENTENCE = /[.!?]["'”’)\]]?\s*$/u;

/**
 * Anything still citation-like after cleanup: `[S1]`, `[cite]`, `[1]`,
 * `[^2]`, `[R1]`, `[REF-2, REF-3]`, `【3】`. A markdown link (`[x](…)`) is
 * not, and neither is a four-digit bracketed year.
 */
const RESIDUAL_MARKER =
	/\\?\[(?:\^[A-Za-z0-9_-]{1,32}|\d{1,3}|[A-Za-z]{1,6}[-\s]?\d{1,4}(?:\s{0,2}[,;–—-]\s{0,2}[A-Za-z]{0,6}[-\s]?\d{1,4}){0,20}|cite\b[^\]\n]{0,80})\\?\](?!\()|【[^】\n]{1,40}】/;

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
 * `Label: value`, optionally listed or bolded. The label and the value each
 * start on a non-space so a whitespace run cannot backtrack against them —
 * `.` stops at a line separator (U+2028) that `\s` still matches.
 */
const FIELD_LINE =
	/^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?([^\s:][^:\n]{0,79}?)(?:\*\*|__)?\s*:(?:\*\*|__)?(?:\s+(\S.*)?)?$/;

const TBD_VALUE =
	/^(?:TBD|TBC|TBA|to be (?:determined|confirmed|decided))(?:$|\s*[—–:(-]|\s+(?:pending|until|once|if)\b)/i;

const PLACEHOLDER_VALUE =
	/^(?:_{3,}|\{\{?[^{}\n]{1,80}\}?\}|\.{3}|…|\?+|\[(?:TBD|TBC|placeholder|insert)[^\]\n]{0,60}\])$/i;

/**
 * A whole cover or Document Control value that is a bracketed template
 * token, `[QA Lead]` or the editor's `\[QA Lead\]` — but not a citation
 * marker. Metadata only: in the main flow `[Option B]` is content, which is
 * why `PLACEHOLDER_VALUE` does not match it.
 */
const BRACKETED_TOKEN =
	/^\\?\[(?!\s*(?:S\d|\d|\^|cite\b))[^[\]\n]{1,60}\\?\]$/i;

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

/**
 * A metadata table's generic column title (`| Field | Value |`, `| Version
 * | Date | Author | Changes |`). A header row of only these is layout; any
 * other header row is a key/value table's first pair (`| Version | 0.3 |`).
 */
const GENERIC_COLUMN =
	/^(?:|#|fields?|values?|items?|propert(?:y|ies)|attributes?|details?|keys?|names?|versions?|revisions?|dates?|authors?|changes?|descriptions?|status(?:es)?|notes?|comments?)$/;

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
/**
 * A source index only when its entries are citation-shaped; a list of
 * customer references stays in the main flow.
 */
const REFERENCE_ANCHORS = new Set([
	"references",
	"bibliography",
	"citations",
	"works cited",
]);
const COVER_ANCHORS = new Set([
	"proposal cover",
	"cover",
	"cover page",
	"document control",
	"document information",
	"document metadata",
	"metadata",
	"revision history",
	"version history",
	"change log",
	"changelog",
]);
const APPENDIX_ANCHOR = /^appendix\b/;

/** A citation marker that leads an entry, optionally bolded. */
const LEADING_MARKER = new RegExp(
	String.raw`^(?:\*\*|__)?(?:${MARKER_CORE}|${NUMERIC_MARKER_CORE})`,
	"i",
);

/** A markdown link or image, `[title](https://…)`. */
const MARKDOWN_LINK = /!?\[([^\]\n]{0,200})\]\([^()\s]{0,500}\)/g;

/** Link text that is itself an address, `example.com/portal`, with or without a scheme. */
const URL_LIKE =
	/^(?:https?:\/\/)?(?:[\w-]{1,63}\.){1,10}[a-z]{2,24}(?:[/?#]\S{0,500})?$/i;

const BARE_URL = /\bhttps?:\/\/[^\s)>\]]{1,500}/g;

/** The dash of a `Name — outcome` entry. */
const OUTCOME_DASH = /[ \t][—–-][ \t]|[—–]/;

/** A numbered reference entry, `1. Vendor survey, 2025`; group 1 is its number. */
const ORDERED_ENTRY = /^\s*(\d{1,4})[.)]\s/;

/**
 * Where the editor may have joined a further source-index entry onto the
 * line; group 1 is its id. `splitSourceEntries` decides whether it did.
 * Linear: only the first space of a run passes the lookbehind.
 */
const SOURCE_ENTRY_JOIN =
	/(?<=\S)\s+(?=(?:\*\*|__)?\\?\[(S\d{1,4}|\d{1,3}|\^[A-Za-z0-9_-]{1,32})\\?\])/gi;

/**
 * A source-index entry, `[S1] Kickoff notes`, `[1] — Vendor survey`: group
 * 1 is its id, group 2 its text. The text is one quantifier over every
 * character, trimmed by the caller, so a whitespace run before a line
 * separator cannot backtrack.
 */
const SOURCE_ENTRY =
	/^(?:\*\*|__)?\\?\[(S\d{1,4}|\d{1,3}|\^[A-Za-z0-9_-]{1,32})\\?\](?:\*\*|__)?\s*(?:[—–:-]\s*)?([\s\S]*)$/i;

type ScaffoldingRule =
	| "headerBlock"
	| "sourceIndex"
	| "statusParentheticals"
	| "sourceParentheticals"
	| "statusTags"
	| "evidenceClauses"
	| "statusColumns"
	| "cover"
	| "citationMarkers"
	| "numericCitations"
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
		"sourceParentheticals",
		"statusTags",
		"evidenceClauses",
		"statusColumns",
	]),
	PROPOSAL: new Set([
		"cover",
		"sourceIndex",
		"sourceParentheticals",
		"citationMarkers",
		"numericCitations",
		"appendix",
	]),
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `references` is provisional: `prepareCitations` settles it as `sources`
 * or `main` before any segment is cleaned.
 */
type SegmentKind = "main" | "sources" | "references" | "cover" | "appendix";

interface Segment {
	heading: OutlineHeading | null;
	/** `heading.text` after `cleanHeading`, computed once. */
	cleanedHeading: string | null;
	/** `heading.headingPath` without the document title; `[]` for the preamble. */
	headingPath: string[];
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
	/**
	 * The numbers a numeric apparatus defines — numeric footnote definitions
	 * and numbered source entries (`1.`, `[1]`). A `[n]` marker is a
	 * citation only for these; an `[S#]` index alone defines none.
	 */
	definedNumbers: ReadonlySet<number>;
	/** The document has footnote definitions or a source index, so `[^n]` markers are citations. */
	footnoteMarkers: boolean;
	/**
	 * The ids that start a source-index line or footnote definition of their
	 * own (see `splitSourceEntries`); a joined line never splits on one.
	 */
	sourceEntryIds: ReadonlySet<string>;
	/** `appendix.sources` by text key and by id plus text key, for de-duplication. */
	listedSources: { texts: Set<string>; entries: Set<string> };
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
		definedNumbers: new Set(),
		footnoteMarkers: false,
		sourceEntryIds: new Set(),
		listedSources: { texts: new Set(), entries: new Set() },
	};

	const { titleHeading, segments } = segmentDocument(markdown);
	// The citation apparatus usually closes the document, so it is decided
	// before any text is cleaned, headings included.
	const footnotes = prepareCitations(segments, ctx);
	const title = titleHeading ? cleanHeading(titleHeading.text, ctx) : null;
	for (const segment of segments) {
		segment.cleanedHeading = segment.heading
			? cleanHeading(segment.heading.text, ctx)
			: null;
	}

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
	// Footnote definitions usually close a document, so they list last.
	for (const footnote of footnotes) {
		addSource(footnote, ctx);
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

/**
 * Split the document at its `#`–`###` headings. Headings are cleaned later,
 * once `prepareCitations` has decided the citation apparatus.
 */
function segmentDocument(markdown: string): {
	titleHeading: OutlineHeading | null;
	segments: Segment[];
} {
	const normalized = unescapeHeadingOrderedMarkers(
		markdown.replace(/\r\n?/g, "\n"),
	);
	const lines = normalized.split("\n");
	const boundaries = parseOutline(normalized).filter((h) => h.level <= 3);
	const end = lines.length + 1;

	let preamble = lines.slice(0, (boundaries[0]?.startLine ?? end) - 1);
	let first = 0;
	let titleHeading: OutlineHeading | null = null;
	// A leading `#` heading is the document title, not a section; its lead-in
	// text joins the preamble.
	if (boundaries[0]?.level === 1) {
		titleHeading = boundaries[0];
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
			headingPath: [],
			bodyLines: preamble,
			kind: "main",
		},
	];
	// A section under the title leaves it out of its path, so renaming the
	// title keeps every section key. A later `#` is a section, and it and
	// the sections under it keep their full paths.
	const underTitle = (heading: OutlineHeading) =>
		titleHeading !== null &&
		heading.startLine > titleHeading.startLine &&
		heading.startLine <= titleHeading.endLine;
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
			cleanedHeading: null,
			headingPath: underTitle(heading)
				? heading.headingPath.slice(1)
				: [...heading.headingPath],
			bodyLines: lines.slice(
				heading.startLine,
				(boundaries[i + 1]?.startLine ?? end) - 1,
			),
			kind,
		});
	}
	return { titleHeading, segments };
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
	if (REFERENCE_ANCHORS.has(anchor)) {
		return "references";
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
// Citation apparatus
// ---------------------------------------------------------------------------

/**
 * Decide the citation apparatus before any segment is cleaned: a source
 * index or footnote definitions usually sit after the text that cites them.
 * Settles each `References`-family segment as a source index or main flow,
 * lifts footnote definitions out of every segment, returning them as
 * sources, and records the numbers a numeric apparatus defines.
 */
function prepareCitations(
	segments: Segment[],
	ctx: CleanupContext,
): GlossyAppendixSource[] {
	// Every footnote id that starts a line of its own: a joined run never
	// splits on one of these.
	const fenced = segments.map((segment) => scanFences(segment.bodyLines));
	const footnoteIds = new Set<string>();
	segments.forEach((segment, s) => {
		segment.bodyLines.forEach((line, i) => {
			const id =
				fenced[s][i] === null
					? line.match(FOOTNOTE_DEFINITION)?.[1]
					: undefined;
			if (id !== undefined) {
				footnoteIds.add(id);
			}
		});
	});

	const footnotes: GlossyAppendixSource[] = [];
	segments.forEach((segment, s) => {
		segment.bodyLines = segment.bodyLines.filter((line, i) => {
			const found =
				fenced[s][i] === null
					? parseFootnoteDefinitions(line, footnoteIds)
					: null;
			if (!found) {
				return true;
			}
			footnotes.push(...found);
			return false;
		});
	});

	const cited = citedNumbers(
		segments.filter((segment) => segment.kind === "main"),
	);
	for (const segment of segments) {
		if (segment.kind === "references") {
			segment.kind = isCitationList(segment.bodyLines, cited)
				? "sources"
				: "main";
		}
	}

	const sourceSegments = segments.filter(
		(segment) => segment.kind === "sources",
	);
	const entryIds = new Set([...footnoteIds].map((id) => `^${id}`));
	for (const segment of sourceSegments) {
		collectEntryIds(segment.bodyLines, entryIds);
	}
	ctx.sourceEntryIds = entryIds;

	const defined = new Set<number>();
	for (const footnote of footnotes) {
		if (footnote.id !== null && /^\d{1,3}$/.test(footnote.id)) {
			defined.add(Number(footnote.id));
		}
	}
	for (const segment of sourceSegments) {
		collectEntryNumbers(segment.bodyLines, entryIds, defined);
	}
	ctx.definedNumbers = defined;
	ctx.footnoteMarkers = footnotes.length > 0 || sourceSegments.length > 0;
	return footnotes;
}

/**
 * The ids that start a source-index line or table row of their own, as
 * `entryKey` writes them.
 */
function collectEntryIds(lines: readonly string[], into: Set<string>): void {
	const fences = scanFences(lines);
	lines.forEach((line, i) => {
		if (fences[i] !== null || !line.trim() || isSeparatorRow(line)) {
			return;
		}
		const key = isTableRow(line) ? tableEntryKey(line) : lineEntryKey(line);
		if (key !== null) {
			into.add(key);
		}
	});
}

/**
 * The numbers a source list defines: an entry's own `[1]` or `[^1]` id,
 * else its ordered-list number (`1. Vendor survey`), or a table row whose
 * first cell is a number. An `[S1]` entry defines none, whatever its list
 * numbering, and neither does a `[1]` that its text only mentions.
 */
function collectEntryNumbers(
	lines: readonly string[],
	entryIds: ReadonlySet<string>,
	into: Set<number>,
): void {
	const fences = scanFences(lines);
	lines.forEach((line, i) => {
		if (fences[i] !== null || !line.trim() || isSeparatorRow(line)) {
			return;
		}
		const keys = isTableRow(line)
			? [tableEntryKey(line)]
			: splitSourceEntries(line, entryIds).map((entry, e) =>
					e === 0 ? lineEntryKey(line) : entryKey(entry),
				);
		for (const key of keys) {
			const number = key?.match(/^\^?(\d{1,3})$/);
			if (number) {
				into.add(Number(number[1]));
			}
		}
	});
}

/**
 * A source-index line's entries. The editor joins soft-broken index lines,
 * so a line may hold a run of entries — but an entry's text may also
 * mention another source. A run splits only on a marker of the kind that
 * leads the line (`[S#]`, numeric `[1]` or `1.`, or `[^1]`), and only on an
 * id that starts no line of its own and has not already appeared in the
 * run: a real run defines each id once, inside it, while a mention points
 * at an id defined elsewhere. A line with no leading id never splits.
 */
function splitSourceEntries(
	line: string,
	entryIds: ReadonlySet<string>,
): string[] {
	const text = stripListMarker(line).trim();
	const lead = lineEntryKey(line);
	if (lead === null) {
		return [text];
	}
	const kind = entryKind(lead);
	const run = new Set([lead]);
	const entries: string[] = [];
	let start = 0;
	for (const join of text.matchAll(SOURCE_ENTRY_JOIN)) {
		const key = idKey(join[1]);
		if (entryKind(key) !== kind || entryIds.has(key) || run.has(key)) {
			continue;
		}
		run.add(key);
		const at = join.index ?? 0;
		entries.push(text.slice(start, at));
		start = at + join[0].length;
	}
	entries.push(text.slice(start));
	return entries;
}

/**
 * A source id as one key per entry: `S1` (any case), `1` for `[1]`, `[01]`
 * or `1.`, `^note` for `[^note]`.
 */
function idKey(id: string): string {
	if (id.startsWith("^")) {
		return id;
	}
	return /^\d/.test(id) ? String(Number(id)) : `S${Number(id.slice(1))}`;
}

function entryKind(key: string): "S" | "footnote" | "numeric" {
	return key.startsWith("^") ? "footnote" : /^\d/.test(key) ? "numeric" : "S";
}

/** The key of an entry's own leading id, or `null`. */
function entryKey(entry: string): string | null {
	const id = entry.match(SOURCE_ENTRY)?.[1];
	return id === undefined ? null : idKey(id);
}

/** The key of the entry that leads a line: its `[id]`, else its `1.` number. */
function lineEntryKey(line: string): string | null {
	const key = entryKey(stripListMarker(line).trim());
	if (key !== null) {
		return key;
	}
	const ordered = line.match(ORDERED_ENTRY);
	return ordered && Number(ordered[1]) <= 999
		? String(Number(ordered[1]))
		: null;
}

/** The key of a source table row: an `[S#]` cell, else a numeric first cell. */
function tableEntryKey(row: string): string | null {
	const cells = splitCells(row).filter((cell) => cell !== "");
	for (const cell of cells) {
		const id = parseSourceId(cell);
		if (id !== null) {
			return idKey(id);
		}
	}
	const number = cells[0]
		?.replace(/[*_]/g, "")
		.match(/^\\?\[?\^?(\d{1,3})\\?\]?$/);
	return number ? String(Number(number[1])) : null;
}

/**
 * A numeric or footnote marker is a citation only when the document's own
 * apparatus says so: `[^n]` with footnote definitions or a source index,
 * `[n]` (every number of `[1, 3]` or `[2–4]`) only when a footnote
 * definition or numbered source entry defines it.
 */
function isNumericCitation(marker: string, ctx: CleanupContext): boolean {
	if (marker.includes("^")) {
		return ctx.footnoteMarkers;
	}
	const numbers = marker.match(/\d{1,3}/g);
	return (
		numbers?.every((number) => ctx.definedNumbers.has(Number(number))) ??
		false
	);
}

/**
 * `[^2]: Vendor survey 2025`, one entry per definition the editor joined. A
 * definition's text may itself mention `[^3]:`, so the line splits there
 * only when `[^3]` starts no line of its own (`footnoteIds`) and has not
 * already appeared in the run — the rule `splitSourceEntries` applies.
 */
function parseFootnoteDefinitions(
	line: string,
	footnoteIds: ReadonlySet<string>,
): GlossyAppendixSource[] | null {
	const lead = line.match(FOOTNOTE_DEFINITION)?.[1];
	if (lead === undefined) {
		return null;
	}
	const run = new Set([lead]);
	const parts: string[] = [];
	let start = 0;
	for (const join of line.matchAll(FOOTNOTE_DEFINITION_JOIN)) {
		const id = join[1];
		if (footnoteIds.has(id) || run.has(id)) {
			continue;
		}
		run.add(id);
		const at = join.index ?? 0;
		parts.push(line.slice(start, at));
		start = at + join[0].length;
	}
	parts.push(line.slice(start));
	return parts.map((part) => {
		const match = part.match(FOOTNOTE_DEFINITION);
		return match
			? { id: match[1], text: match[2].trim() }
			: { id: null, text: part.trim() };
	});
}

/** The numbers the main flow cites as `[n]`, by the rule that removes them. */
function citedNumbers(segments: readonly Segment[]): Set<number> {
	const cited = new Set<number>();
	for (const segment of segments) {
		const fences = scanFences(segment.bodyLines);
		segment.bodyLines.forEach((line, i) => {
			if (fences[i] !== null) {
				return;
			}
			for (const run of line
				.replace(INLINE_CODE, "`")
				.matchAll(NUMERIC_MARKER)) {
				const numbers = run[0].replace(
					/\\?\[\^[A-Za-z0-9_-]{1,32}\\?\]/g,
					"",
				);
				for (const number of numbers.matchAll(/\d{1,3}/g)) {
					cited.add(Number(number[0]));
				}
			}
		});
	}
	return cited;
}

/**
 * A `References`-family section is a source index when most of its entries
 * are citation-shaped (see `isCitationShapedEntry`), or when it is a
 * numbered list that the main flow cites as `[n]` within its numbering. A
 * list of customer references stays in the main flow.
 */
function isCitationList(
	lines: readonly string[],
	cited: ReadonlySet<number>,
): boolean {
	const fences = scanFences(lines);
	const entries = lines.filter(
		(line, i) =>
			fences[i] === null &&
			line.trim() !== "" &&
			!THEMATIC_BREAK.test(line) &&
			!isAnchorLike(line) &&
			!isSeparatorRow(line),
	);
	const most = (count: number) => count * 2 > entries.length;
	if (entries.length === 0) {
		return false;
	}
	if (most(entries.filter(isCitationShapedEntry).length)) {
		return true;
	}
	const numbering = entries.flatMap((line) => {
		const match = line.match(ORDERED_ENTRY);
		return match ? [Number(match[1])] : [];
	});
	return most(numbering.length) && numbering.some((n) => cited.has(n));
}

/**
 * A reference entry is citation-shaped when its citation identity leads it
 * — it starts with a marker (`[S1] Kickoff notes`, `[1] Vendor survey`) —
 * or when it is essentially a title and a link (`[Vendor survey](https://…)`,
 * `Vendor survey 2025 — https://…`). A URL with no title — alone, as
 * `[](…)`, or as its own link text — is not. A marker later in the entry
 * (`Example Co — migrated from [S1] to [S2]`) is incidental, and a link
 * beside `Name — outcome` prose (`Example Co — reduced onboarding time 30%
 * ([case study](…))`) is a customer reference, not a citation. A numbered
 * entry the text cites as `[n]` is `isCitationList`'s other test.
 */
function isCitationShapedEntry(line: string): boolean {
	const text = stripListMarker(line);
	if (LEADING_MARKER.test(text.trim())) {
		return true;
	}
	const rest = text.replace(MARKDOWN_LINK, " ").replace(BARE_URL, " ");
	if (rest === text) {
		return false;
	}
	// The link needs a title: link text that is not itself an address, or
	// text beside a bare URL. A URL alone, `[](…)` or `[https://…](…)` is not.
	const titled =
		/[\p{L}\p{N}]/u.test(rest) ||
		[...text.matchAll(MARKDOWN_LINK)].some((link) => isLinkTitle(link[1]));
	if (!titled) {
		return false;
	}
	const dash = rest.match(OUTCOME_DASH);
	if (!dash || dash.index === undefined) {
		return true;
	}
	const name = rest.slice(0, dash.index);
	const outcome = rest.slice(dash.index + dash[0].length);
	return !(/\p{L}/u.test(name) && /\p{L}/u.test(outcome));
}

/** Link text that names something, rather than being empty or an address. */
function isLinkTitle(text: string): boolean {
	const title = text.replace(/[*_`<>]/g, "").trim();
	return (
		/[\p{L}\p{N}]/u.test(title.replace(BARE_URL, "")) &&
		!URL_LIKE.test(title)
	);
}

/** Add a source unless one with the same text is already listed. */
function addSource(source: GlossyAppendixSource, ctx: CleanupContext): void {
	const key = sourceKey(source.text);
	if (key && !ctx.listedSources.texts.has(key)) {
		pushSource(source, key, ctx);
	}
}

/**
 * Add a source-index entry unless the same id and text are already listed —
 * a document may carry both a Source Index and a References section.
 */
function addIndexedSource(
	source: GlossyAppendixSource,
	ctx: CleanupContext,
): void {
	const key = sourceKey(source.text);
	if (!ctx.listedSources.entries.has(`${source.id ?? ""}\n${key}`)) {
		pushSource(source, key, ctx);
	}
}

/** List a source, and index it so each later check is one lookup. */
function pushSource(
	source: GlossyAppendixSource,
	key: string,
	ctx: CleanupContext,
): void {
	ctx.appendix.sources.push(source);
	ctx.listedSources.texts.add(key);
	ctx.listedSources.entries.add(`${source.id ?? ""}\n${key}`);
}

function sourceKey(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
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
	pushMetadata(label, [rawValue], ctx);
}

/**
 * A metadata field or table row: its values, joined with ` · `, go
 * to details, or to placeholders when every value is empty or a
 * placeholder. A value that is only citation markers keeps them — it points
 * into the source list and is not a blank to fill.
 */
function pushMetadata(
	label: string | null,
	rawValues: readonly string[],
	ctx: CleanupContext,
): void {
	const values = rawValues
		.map((raw) => tidy(removeMarkers(raw, ctx)).trim() || tidy(raw).trim())
		.filter(Boolean);
	const value = values.join(" · ");
	if (values.every(isMetadataPlaceholder)) {
		const text = label && value ? `${label}: ${value}` : (label ?? value);
		if (text) {
			ctx.appendix.placeholders.push({ heading: ctx.heading, text });
		}
		return;
	}
	ctx.appendix.details.push({ label, value });
}

function collectCoverFields(lines: string[], ctx: CleanupContext): void {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim() || THEMATIC_BREAK.test(line) || isAnchorLike(line)) {
			continue;
		}
		// A Document Control or revision-history table: every row is one
		// field, its first cell the label and the rest joined. The separator
		// row is layout, and so is a header row of generic column titles; a
		// key/value table with no real header carries its first pair there.
		if (isTableRow(line)) {
			const header = isTableStart(lines, i);
			if (
				!isSeparatorRow(line) &&
				!(header && isGenericHeaderRow(line))
			) {
				const [label = "", ...values] = splitCells(line);
				pushMetadata(
					label.replace(/[*_]/g, "").trim() || null,
					values,
					ctx,
				);
			}
			if (header) {
				i++;
			}
			continue;
		}
		const field = parseField(line);
		if (field) {
			pushField(field.label, field.value, ctx);
			continue;
		}
		const value = tidy(removeMarkers(stripListMarker(line), ctx)).trim();
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
				addIndexedSource(
					{
						id: idCell >= 0 ? parseSourceId(cells[idCell]) : null,
						text: cells.filter((_, c) => c !== idCell).join(" — "),
					},
					ctx,
				);
			}
			i = end - 1;
			continue;
		}
		for (const entry of splitSourceEntries(line, ctx.sourceEntryIds)) {
			const match = entry.match(SOURCE_ENTRY);
			addIndexedSource(
				match
					? { id: sourceIdOf(match[1]), text: match[2].trim() }
					: { id: null, text: entry.trim() },
				ctx,
			);
		}
	}
}

/** `S1` for `[s1]`, `2` for `[^2]` or `[2]`. */
function sourceIdOf(label: string): string {
	return label.startsWith("^") ? label.slice(1) : label.toUpperCase();
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
		headingPath: [...segment.headingPath],
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

/**
 * A line in scan order. A `boundary` sits where an inline evidence clause
 * was removed: the text after it is a new statement, so a status
 * parenthetical that follows qualifies only that statement.
 */
type Piece =
	| { kind: "text"; text: string }
	| { kind: "verbatim"; text: string }
	| { kind: "status"; status: GlossyClaimStatus | null }
	| { kind: "boundary" };

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
		const status = parseClaimStatus(tag[2] ?? "");
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
	const trailingTag = Boolean(trailing?.index && trailingStatus);
	if (trailing?.index && trailingStatus) {
		ctx.rules.add("statusTags");
		working = working.slice(0, trailing.index);
	}
	// Once a trailing tag is cut, the text no longer reaches the line's end.
	const scan = stripScaffolding(working, ctx, !trailingTag);
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
	// A list item whose only content was scaffolding (`- Key evidence: [S1]`)
	// leaves a bare marker, which `LIST_MARKER` needs a space after.
	if (
		!stripListMarker(text).replace(/[*_\s]/g, "") ||
		(changed && /^(?:[-+]|\d{1,9}[.)])?$/.test(text.replace(/[*_\s]/g, "")))
	) {
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
 * Remove status and source parentheticals, inline evidence clauses, and
 * citation markers from `text`. Parentheticals become `status` pieces (the
 * caller turns them into qualifiers); an unbalanced or over-long one becomes
 * a `verbatim` piece that runs to the end of the text and is reported.
 * `endsLine` is false when `text` stops short of its line's end.
 */
function stripScaffolding(
	text: string,
	ctx: CleanupContext,
	endsLine = true,
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

		if (isStatusParenthetical(content)) {
			ctx.rules.add("statusParentheticals");
		}
		if (SOURCE_LABEL.test(content)) {
			ctx.rules.add("sourceParentheticals");
		}
		changed = true;
		pieces.push({ kind: "text", text: text.slice(cursor, open) });
		const kept = splitParenthetical(content, ctx);
		if (kept) {
			pieces.push({ kind: "text", text: `(${kept})` });
		}
		pieces.push({ kind: "status", status: statusOfParenthetical(content) });
		cursor = close + 1;
		search = cursor;
	}
	if (cursor < text.length) {
		pieces.push({ kind: "text", text: text.slice(cursor) });
	}

	// Clauses first: they are recognized by the markers they carry. A text
	// piece reaches the line's end only when nothing follows it. Where a
	// clause was removed before more text, a boundary starts a new statement.
	const scanned: Piece[] = [];
	pieces.forEach((piece, p) => {
		if (piece.kind !== "text") {
			scanned.push(piece);
			return;
		}
		const atLineEnd = endsLine && p === pieces.length - 1;
		const clauses = removeEvidenceClauses(piece.text, ctx, atLineEnd);
		if (clauses.clauses > 0) {
			ctx.rules.add("evidenceClauses");
		}
		if (clauses.proseMarkers > 0) {
			ctx.rules.add("citationMarkers");
		}
		changed ||= clauses.clauses > 0 || clauses.proseMarkers > 0;
		const rest = clauses.text.slice(clauses.statementStart);
		if (clauses.statementStart > 0 && /\S/.test(rest)) {
			scanned.push(
				{
					kind: "text",
					text: clauses.text.slice(0, clauses.statementStart),
				},
				{ kind: "boundary" },
				{ kind: "text", text: rest },
			);
		} else {
			scanned.push({ kind: "text", text: clauses.text });
		}
	});

	// Numeric markers go before `[S#]` ones, whose removal could splice a new
	// `[1]` that is then reported rather than removed.
	for (const piece of scanned) {
		if (piece.kind !== "text") {
			continue;
		}
		const numeric = removeNumericMarkers(piece.text, ctx);
		if (numeric.count > 0) {
			ctx.rules.add("numericCitations");
			changed = true;
			piece.text = numeric.text;
		}
		const removed = removeCitationMarkers(piece.text);
		if (removed.count > 0) {
			ctx.rules.add("citationMarkers");
			changed = true;
			piece.text = removed.text;
		}
	}
	return { pieces: scanned, changed };
}

function isScaffoldingParenthetical(content: string): boolean {
	return isStatusParenthetical(content) || SOURCE_LABEL.test(content);
}

function isStatusParenthetical(content: string): boolean {
	if (EVIDENCE_LABEL.test(content)) {
		return true;
	}
	return statusOfParenthetical(content) !== null;
}

/**
 * Sort a scaffolding parenthetical's `;`-separated parts. A labelled part
 * (`Status:`, `Evidence:`, `Source:` …) is scaffolding, and a `Source:`
 * part names a source for the appendix, once however often it is cited:
 * whatever description it carries beside its markers (`[S1] internal
 * report` names `internal report`), and nothing when it is only markers or
 * `n/a`, which point into the source index. An unlabelled part that
 * carries a marker or is `n/a` goes too. Any other unlabelled part is content (`figures are rough`): it is
 * returned, `;`-joined, to stay in the main flow.
 */
function splitParenthetical(content: string, ctx: CleanupContext): string {
	const kept: string[] = [];
	for (const part of splitTopLevel(content)) {
		const label = part.match(PARENTHETICAL_PART_LABEL);
		if (label) {
			if (/^sources?$/i.test(label[1])) {
				const name = sourceName(part.slice(label[0].length));
				if (name) {
					addSource({ id: null, text: name }, ctx);
				}
			}
			continue;
		}
		const value = tidy(part).trim();
		if (value && !/^n\/a$/i.test(value) && !REFERENCE_MARKER.test(value)) {
			kept.push(value);
		}
	}
	return kept.join("; ");
}

/**
 * What a `Source:` value names once its markers are gone: `[S1] internal
 * report` names `internal report`; `[S1], [S2]` or `n/a` names nothing.
 */
function sourceName(value: string): string {
	const name = trimSeparators(
		tidy(
			value
				.replace(CITATION_MARKER, " ")
				.replace(NUMERIC_MARKER_CORES, " "),
		),
	);
	return /^n\/a$/i.test(name) ? "" : name;
}

/** Trim whitespace and the `,` `;` `:` or dash a removed marker leaves at either end. */
function trimSeparators(text: string): string {
	const separator = /[\s,;:—–-]/;
	let start = 0;
	let end = text.length;
	while (start < end && separator.test(text[start])) {
		start++;
	}
	while (end > start && separator.test(text[end - 1])) {
		end--;
	}
	return text.slice(start, end);
}

/** Split on `;` outside nested parentheses; a backslash escapes the next character. */
function splitTopLevel(content: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < content.length; i++) {
		const ch = content[i];
		if (ch === "\\") {
			i++;
		} else if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			depth = Math.max(0, depth - 1);
		} else if (ch === ";" && depth === 0) {
			parts.push(content.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(content.slice(start));
	return parts;
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
		if (piece.kind === "boundary") {
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
		.map((piece) =>
			piece.kind === "text" || piece.kind === "verbatim"
				? piece.text
				: "",
		)
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

/**
 * Remove numeric and footnote marker runs the apparatus defines (see
 * `isNumericCitation`), never inside inline code. A run with any marker the
 * apparatus does not define stays whole, and is reported.
 */
function removeNumericMarkers(
	text: string,
	ctx: CleanupContext,
): { text: string; count: number } {
	if (ctx.definedNumbers.size === 0 && !ctx.footnoteMarkers) {
		return { text, count: 0 };
	}
	let count = 0;
	const strip = (chunk: string) =>
		chunk.replace(NUMERIC_MARKER, (run) => {
			for (const marker of run.matchAll(NUMERIC_MARKER_CORES)) {
				if (!isNumericCitation(marker[0], ctx)) {
					return run;
				}
			}
			count++;
			return "";
		});
	let out = "";
	let cursor = 0;
	for (const code of text.matchAll(INLINE_CODE)) {
		const start = code.index ?? 0;
		out += strip(text.slice(cursor, start)) + code[0];
		cursor = start + code[0].length;
	}
	out += strip(text.slice(cursor));
	return { text: count > 0 ? out : text, count };
}

/** Every marker a metadata value may carry: numeric ones only as the apparatus defines them. */
function removeMarkers(text: string, ctx: CleanupContext): string {
	return removeCitationMarkers(removeNumericMarkers(text, ctx).text).text;
}

/**
 * Remove inline evidence and source clauses, `Evidence: [S2] — anchor` and
 * `Sources: [S1], [S3]`: a label that opens a clause (`opensClause`), at
 * least one marker or `n/a`, and — only after a dash or colon, and only
 * for a label that surely opens a clause — anchor text up to a safe end
 * (`clauseEnd`). With no dash or colon the clause ends at its last
 * reference. A label with no marker
 * (`Evidence: the survey shows…`) is prose and stays; so is a label in the
 * middle of a sentence (`The key evidence: [S2] shows…`), which loses only
 * its markers and the colon before them. The gap closes with a space where
 * the two sides would otherwise touch.
 *
 * `statementStart` is where the text after the last removed clause begins
 * in the result, or -1: that text is a statement of its own.
 */
function removeEvidenceClauses(
	text: string,
	ctx: CleanupContext,
	atLineEnd: boolean,
): {
	text: string;
	clauses: number;
	proseMarkers: number;
	statementStart: number;
} {
	let clauses = 0;
	let proseMarkers = 0;
	let statementStart = -1;
	let out = "";
	let cursor = 0;
	const leadEnd = text.match(LINE_LEAD)?.[0].length ?? 0;
	CLAUSE_LABEL.lastIndex = 0;
	for (
		let label = CLAUSE_LABEL.exec(text);
		label;
		label = CLAUSE_LABEL.exec(text)
	) {
		const labelEnd = label.index + label[0].length;
		const opens = opensClause(text, label.index, leadEnd, label[0]);
		let at = labelEnd;
		let references = 0;
		for (;;) {
			CLAUSE_REFERENCE.lastIndex = at;
			const reference = CLAUSE_REFERENCE.exec(text);
			if (
				!reference ||
				(reference[1] && !isNumericCitation(reference[1], ctx)) ||
				// `n/a` is a clause's reference, but not a marker to strip from prose.
				(reference[2] && !opens)
			) {
				break;
			}
			references++;
			at = CLAUSE_REFERENCE.lastIndex;
		}
		if (references === 0) {
			CLAUSE_LABEL.lastIndex = labelEnd;
			continue;
		}

		if (!opens) {
			const colon = label.index + label[0].lastIndexOf(":");
			out += text.slice(cursor, colon) + text.slice(colon + 1, labelEnd);
			if (/[\p{L}\p{N}]/u.test(text.slice(at, at + 1))) {
				out += " ";
			}
			cursor = at;
			CLAUSE_LABEL.lastIndex = at;
			proseMarkers += references;
			continue;
		}

		CLAUSE_SEPARATOR.lastIndex = at;
		const separator = CLAUSE_SEPARATOR.exec(text);
		CLAUSE_JOINER.lastIndex = at;
		// A `joined` label keeps the text after its separator: a leftover
		// fragment of an anchor, or the rest of a sentence it sat in.
		const end = !separator?.[1]
			? CLAUSE_JOINER.test(text)
				? CLAUSE_JOINER.lastIndex
				: at
			: opens === "joined"
				? CLAUSE_SEPARATOR.lastIndex
				: clauseEnd(text, CLAUSE_SEPARATOR.lastIndex, atLineEnd);

		out += text.slice(cursor, label.index);
		if (
			/\S/.test(out.slice(-1)) &&
			/[\p{L}\p{N}]/u.test(text.slice(end, end + 1))
		) {
			out += " ";
		}
		// What follows a `joined` label belongs with what precedes it.
		if (opens === "clause") {
			statementStart = out.length;
		}
		cursor = end;
		CLAUSE_LABEL.lastIndex = end;
		clauses++;
	}
	return {
		text: clauses + proseMarkers > 0 ? out + text.slice(cursor) : text,
		clauses,
		proseMarkers,
		statementStart,
	};
}

/**
 * Whether the label at `at` opens a clause rather than sitting in prose.
 * `clause`: it starts the text (after indentation, a list marker, or
 * emphasis — a text piece also starts after a removed parenthetical), or
 * follows a sentence end, `;` or `(`. `joined`: it is capitalized and
 * follows a space — likely a line the editor joined to one that ended
 * without punctuation, but possibly prose (`The report's Evidence: [S1] —
 * survey results show…`), so only its label, references and separator go
 * and the text after them stays. `null`: prose.
 */
function opensClause(
	text: string,
	at: number,
	leadEnd: number,
	label: string,
): "clause" | "joined" | null {
	if (
		at >= leadEnd &&
		at - leadEnd <= 2 &&
		/^[*_]*$/.test(text.slice(leadEnd, at))
	) {
		return "clause";
	}
	const before = text.slice(Math.max(0, at - 16), at);
	if (CLAUSE_OPENER.test(before)) {
		return "clause";
	}
	return /[ \t]$/.test(before) && /^(?:\*\*|__)?\p{Lu}/u.test(label)
		? "joined"
		: null;
}

/**
 * Where a clause's anchor text ends: at a sentence end followed by a
 * statement, else at the next scaffolding label or the end of the text.
 * The editor joins soft-broken lines, so the anchor may carry the next
 * line's statement (`— table B holds.`, `— table 40% stall`). The anchor
 * stops before such a statement whenever it does not simply run to the end
 * of its line: when it ends a sentence, when a label follows, or when the
 * text stops short of the line's end (a status parenthetical or a trailing
 * tag follows). Cleanup never deletes that statement; it may leave a
 * capitalized word of the anchor itself behind instead.
 */
function clauseEnd(text: string, from: number, atLineEnd: boolean): number {
	CLAUSE_STOP_LABEL.lastIndex = from;
	const label = CLAUSE_STOP_LABEL.exec(text);
	const stop = label?.index ?? text.length;
	const anchor = text.slice(from, stop);
	const sentence = anchor.match(SENTENCE_END);
	if (sentence?.index !== undefined) {
		return from + sentence.index + sentence[0].length;
	}
	if (label || !atLineEnd || ENDS_SENTENCE.test(anchor)) {
		const statement = joinedStatementStart(anchor);
		if (statement !== -1) {
			return from + statement;
		}
	}
	return stop;
}

/**
 * The whitespace before the first statement start (`STATEMENT_START`) after
 * the anchor's own first word, outside quotes; `-1` when there is none.
 * Under-deletes an anchor with a capitalized word or a number in it rather
 * than risk a statement.
 */
function joinedStatementStart(anchor: string): number {
	let seenWord = false;
	let closeQuote: string | null = null;
	for (let i = 0; i < anchor.length; i++) {
		const ch = anchor[i];
		if (closeQuote !== null) {
			if (ch === closeQuote) {
				closeQuote = null;
			}
		} else if (/\s/.test(ch)) {
			if (seenWord && STATEMENT_START.test(anchor[i + 1] ?? "")) {
				return i;
			}
		} else {
			if (ch === '"' || ch === "“") {
				closeQuote = ch === '"' ? '"' : "”";
			}
			seenWord = true;
		}
	}
	return -1;
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

/** `isPlaceholderValue`, plus a bracketed template token (cover and Document Control only). */
function isMetadataPlaceholder(value: string): boolean {
	return (
		isPlaceholderValue(value) ||
		BRACKETED_TOKEN.test(value.replace(/[*_`"']/g, "").trim())
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
		isSeparatorRow(lines[i + 1])
	);
}

/** A metadata table header of only generic column titles (`GENERIC_COLUMN`). */
function isGenericHeaderRow(line: string): boolean {
	return splitCells(line).every((cell) =>
		GENERIC_COLUMN.test(cell.replace(/[*_`]/g, "").trim().toLowerCase()),
	);
}

function isSeparatorRow(line: string): boolean {
	return (
		isTableRow(line) &&
		splitCells(line).every((cell) =>
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
