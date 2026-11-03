/**
 * Content-type chunking profiles.
 *
 * A profile splits a piece of content on its own boundaries — a heading, a
 * list item, a dated entry, a speaker turn, a table row — and uses size only to
 * split a boundary unit that is too long and to merge small neighbours. The
 * project RAG setting (`prose`) stays the fallback for content no profile fits.
 *
 * Everything here is pure and deterministic: no I/O, no model, no feature flag.
 * The decision to use a profile at all is taken in `content-routing.ts`, which
 * stays the one place that decides how project content is chunked.
 */

import { z } from "zod";
import { estimateTokenCount } from "./chunker";
import {
	CHUNK_PROFILES,
	type ChunkProfile,
	CONTENT_KINDS,
	type ContentKind,
	CUSTOM_CHUNK_LIMITS,
	CUSTOM_SPLIT_METHODS,
	type CustomSplitMethod,
	isChunkProfile,
	isContentKind,
	PROFILE_SIZE_LIMITS,
	PROFILE_SIZES,
	type ProfileSize,
} from "./profile-catalog";
import type { TextChunk } from "./types";

export {
	CHUNK_PROFILES,
	type ChunkProfile,
	CONTENT_KINDS,
	type ContentKind,
	CUSTOM_CHUNK_LIMITS,
	CUSTOM_SPLIT_METHODS,
	type CustomSplitMethod,
	isChunkProfile,
	isContentKind,
	PROFILE_SIZE_LIMITS,
	PROFILE_SIZES,
	type ProfileSize,
} from "./profile-catalog";

/** Why a profile was chosen; stored on every chunk payload. */
export type ChunkProfileReason = "override" | "kind" | "detected" | "fallback";

/**
 * The profile a known kind maps to. `knowledge` is resolved by length (see
 * {@link profileForKind}); `other` has no mapping and falls to detection.
 */
const KIND_PROFILE: Partial<Record<ContentKind, ChunkProfile>> = {
	prd: "sectioned",
	spec: "sectioned",
	design: "sectioned",
	readme: "sectioned",
	reference: "sectioned",
	adr: "whole",
	decision: "whole",
	note: "whole",
	backlog: "items",
	tasks: "items",
	checklist: "items",
	journal: "dated",
	changelog: "dated",
	"release-notes": "dated",
	"meeting-series": "dated",
	transcript: "dialogue",
	chat: "dialogue",
	csv: "tabular",
	spreadsheet: "tabular",
	openapi: "openapi",
};

/** Content at or below this length is a `whole` knowledge entry. */
export const WHOLE_MAX_CHARS = PROFILE_SIZES.whole.max;

/**
 * One per-type tuning entry of `ProjectRagSettings.chunkProfiles`. Keys of the
 * map are a content kind or, for content without a known kind, the profile
 * detection chose.
 */
export const chunkProfileTuningSchema = z
	.object({
		/**
		 * Custom: today's chunker with this type's own split method, size and
		 * overlap (spec §6). A value it leaves out is the project's, so a type
		 * switched to Custom starts exactly where the project was. A missing
		 * entry means Custom unless the project chunked by content type before
		 * per-type rows existed.
		 */
		custom: z.literal(true).optional(),
		/** The earlier name of `custom`, still read from stored rows. */
		standard: z.literal(true).optional(),
		splitMethod: z.enum(CUSTOM_SPLIT_METHODS).optional(),
		chunkSize: z
			.number()
			.int()
			.min(CUSTOM_CHUNK_LIMITS.minSize)
			.max(CUSTOM_CHUNK_LIMITS.maxSize)
			.optional(),
		chunkOverlap: z
			.number()
			.int()
			.min(0)
			.max(CUSTOM_CHUNK_LIMITS.maxOverlap)
			.optional(),
		profile: z.enum(CHUNK_PROFILES).optional(),
		target: z
			.number()
			.int()
			.min(PROFILE_SIZE_LIMITS.minTarget)
			.max(PROFILE_SIZE_LIMITS.maxChars)
			.optional(),
		max: z
			.number()
			.int()
			.min(PROFILE_SIZE_LIMITS.minTarget)
			.max(PROFILE_SIZE_LIMITS.maxChars)
			.optional(),
		overlap: z
			.number()
			.int()
			.min(0)
			.max(PROFILE_SIZE_LIMITS.maxOverlap)
			.optional(),
	})
	.strict()
	.refine(
		(value) =>
			value.target === undefined ||
			value.max === undefined ||
			value.max >= value.target,
		{ message: "max must be at least target" },
	)
	.refine(
		(value) =>
			value.chunkSize === undefined ||
			value.chunkOverlap === undefined ||
			value.chunkOverlap < value.chunkSize,
		{ message: "chunkOverlap must be smaller than chunkSize" },
	);

export type ChunkProfileTuning = z.infer<typeof chunkProfileTuningSchema>;

// `partialRecord`: zod 4 makes a record keyed by an enum exhaustive, and a
// project carries rows only for the types someone changed.
export const chunkProfilesConfigSchema = z.partialRecord(
	z.union([z.enum(CONTENT_KINDS), z.enum(CHUNK_PROFILES)]),
	chunkProfileTuningSchema,
);

export type ChunkProfilesConfig = Partial<
	Record<ContentKind | ChunkProfile, ChunkProfileTuning>
>;

/**
 * Whether a type is chunked Custom (today's chunker, with the type's own or
 * the project's split method, size and overlap). Without its own entry, a
 * type is Custom unless the project turned on chunking by content type
 * before per-type rows existed; then it keeps the detected profile it chunks
 * with today.
 */
export function isCustomChunking(
	tuning: ChunkProfileTuning | undefined,
	chunkByContentType: boolean | undefined,
): boolean {
	if (tuning) {
		return tuning.custom === true || tuning.standard === true;
	}
	return chunkByContentType !== true;
}

/**
 * The split method, size and overlap a Custom type chunks with: its own
 * values, each falling back to the project's.
 */
export function customChunkSettings<S extends string>(
	tuning: ChunkProfileTuning | undefined,
	project: { splitMethod?: S; chunkSize: number; chunkOverlap: number },
): {
	splitMethod: S | CustomSplitMethod | undefined;
	chunkSize: number;
	chunkOverlap: number;
} {
	const chunkSize = tuning?.chunkSize ?? project.chunkSize;
	const chunkOverlap = tuning?.chunkOverlap ?? project.chunkOverlap;
	return {
		splitMethod: tuning?.splitMethod ?? project.splitMethod,
		chunkSize,
		// A type's own size may undercut the project's overlap.
		chunkOverlap: Math.min(chunkOverlap, Math.max(chunkSize - 100, 0)),
	};
}

/**
 * Whether a project (or organization) moved to per-type chunking: the earlier
 * toggle, or any per-type row. Neither means today's chunking everywhere.
 */
export function usesPerTypeChunking(settings: {
	chunkByContentType?: boolean | null;
	chunkProfiles?: unknown;
}): boolean {
	return (
		settings.chunkByContentType === true ||
		Object.keys(parseChunkProfilesConfig(settings.chunkProfiles)).length > 0
	);
}

/**
 * Parse a stored `chunkProfiles` value. Anything invalid is dropped rather than
 * thrown: a bad row must not stop ingestion, and the defaults are always safe.
 */
export function parseChunkProfilesConfig(value: unknown): ChunkProfilesConfig {
	if (!value || typeof value !== "object") {
		return {};
	}
	const out: ChunkProfilesConfig = {};
	for (const [key, entry] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (!isContentKind(key) && !isChunkProfile(key)) {
			continue;
		}
		const parsed = chunkProfileTuningSchema.safeParse(entry);
		if (parsed.success) {
			out[key] = parsed.data;
		}
	}
	return out;
}

/**
 * The content kind a context row's own fields imply (§5 step 2). An explicit
 * `metadata.contentKind` (set by an importer that classified the file) wins;
 * then the system type. Unknown → undefined, and detection decides.
 */
export function contentKindForContext(params: {
	type?: string | null;
	metadata?: unknown;
}): ContentKind | undefined {
	const declared =
		params.metadata && typeof params.metadata === "object"
			? (params.metadata as Record<string, unknown>).contentKind
			: undefined;
	if (isContentKind(declared)) {
		return declared;
	}
	switch (params.type) {
		case "MEETING_TRANSCRIPT":
			return "transcript";
		case "ARCHITECTURE_DECISION":
			return "adr";
		case "SPREADSHEET":
			return "spreadsheet";
		case "API_SPEC":
			return "openapi";
		case "FEATURES":
			return "backlog";
		default:
			return undefined;
	}
}

/** Fabric document types (`ProjectDocumentType`) that imply a kind. */
export function contentKindForDocumentType(
	documentType: string,
): ContentKind | undefined {
	switch (documentType) {
		case "PRD":
		case "SRS":
		case "PROPOSAL":
		case "BUSINESS_CASE":
		case "QA_STRATEGY":
		case "TEST_PLAN":
		case "TEST_REPORT":
			return "prd";
		case "TECHNICAL_SPEC":
		case "ARCHITECTURE":
		case "INTEGRATION_CONTRACT":
			return "spec";
		case "DESIGN_SYSTEM":
			return "design";
		case "TRACEABILITY_MATRIX":
			return "checklist";
		default:
			return undefined;
	}
}

/** The profile a known kind implies, or null when the kind does not decide. */
export function profileForKind(
	kind: ContentKind,
	contentLength: number,
): ChunkProfile | null {
	if (kind === "knowledge") {
		return contentLength <= WHOLE_MAX_CHARS ? "whole" : "sectioned";
	}
	return KIND_PROFILE[kind] ?? null;
}

// ---------------------------------------------------------------------------
// Detection (§5 step 3)
// ---------------------------------------------------------------------------

/** Bounded so a pathological line cannot make a pattern slow. */
const MAX_LINE_SCAN = 400;

const HEADING_RE = /^(#{1,6})[ \t]+(\S.*?)[ \t#]*$/;
const LIST_ITEM_RE = /^([ \t]*)(?:[-*+]|\d{1,4}[.)])[ \t]+\S/;
const TABLE_ROW_START_RE = /^[ \t]*\|/;
const TABLE_ROW_END_RE = /\|[ \t]*$/;

/**
 * A markdown table row. Checked on the line's two ends rather than through
 * `scanLine`: a row is often longer than the scan limit, and a cut row
 * would not end in `|`.
 */
function isTableRow(line: string): boolean {
	const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
	return (
		TABLE_ROW_START_RE.test(bare.slice(0, MAX_LINE_SCAN)) &&
		TABLE_ROW_END_RE.test(bare.slice(-MAX_LINE_SCAN))
	);
}
const TABLE_SEPARATOR_RE =
	/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/;
const DATE_RE =
	/\b(\d{4}-\d{2}-\d{2}|\d{4}\/\d{2}\/\d{2}|\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4})\b/;
const VERSION_RE =
	/(?:^|[\s[(])v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)(?=$|[\s\]),:])/;
const SPEAKER_RE =
	/^(?:\[?\(?\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\]?\)?[ \t]*(?:-[ \t]*)?)?([A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,3}):[ \t]+\S/;
const TIMESTAMP_ONLY_RE = /^\[?\(?\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\]?\)?\s*$/;

function scanLine(line: string): string {
	// A CRLF file leaves `\r` on every line; `$` in the patterns above would
	// not match after it.
	const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
	return bare.length > MAX_LINE_SCAN ? bare.slice(0, MAX_LINE_SCAN) : bare;
}

interface MarkdownHeading {
	level: number;
	title: string;
	/** Line index. */
	line: number;
}

/** ATX headings outside fenced code blocks, up to `maxLevel`. */
function findHeadings(lines: string[], maxLevel = 6): MarkdownHeading[] {
	const headings: MarkdownHeading[] = [];
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = scanLine(lines[i] ?? "");
		const fenceMatch = /^[ \t]*(```|~~~)/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1] ?? "";
			fence = fence === null ? marker : fence === marker ? null : fence;
			continue;
		}
		if (fence !== null) {
			continue;
		}
		const match = HEADING_RE.exec(line);
		if (match && (match[1]?.length ?? 7) <= maxLevel) {
			headings.push({
				level: match[1]?.length ?? 1,
				title: (match[2] ?? "").trim(),
				line: i,
			});
		}
	}
	return headings;
}

function dateOrVersion(text: string): string | null {
	const line = scanLine(text);
	const date = DATE_RE.exec(line);
	if (date?.[1]) {
		return date[1];
	}
	const version = VERSION_RE.exec(line);
	return version?.[1] ?? null;
}

function looksTabular(content: string, mimeType: string, filename: string) {
	const lower = filename.toLowerCase();
	if (
		mimeType.includes("csv") ||
		mimeType.includes("tab-separated") ||
		lower.endsWith(".csv") ||
		lower.endsWith(".tsv")
	) {
		return true;
	}
	// Tab-separated text with a stable column count, pasted or exported.
	const lines = content
		.split("\n")
		.slice(0, 50)
		.filter((l) => l.trim().length > 0);
	if (lines.length < 5) {
		return false;
	}
	const columns = lines.map((l) => l.split("\t").length);
	const first = columns[0] ?? 1;
	return first >= 2 && columns.every((c) => c === first);
}

/**
 * The profile the content's own shape suggests, or null for ordinary prose.
 * Order follows §5: tabular, transcript, dated, list-heavy, sectioned.
 * OpenAPI is detected earlier, by the content router.
 */
export function detectProfile(params: {
	content: string;
	mimeType: string;
	filename: string;
}): Exclude<ChunkProfile, "openapi" | "prose" | "whole"> | null {
	const { content, mimeType, filename } = params;
	if (looksTabular(content, mimeType, filename)) {
		return "tabular";
	}

	const lines = content.split("\n");
	const nonBlank = lines.filter((l) => l.trim().length > 0);

	let speakerLines = 0;
	for (const line of nonBlank) {
		if (SPEAKER_RE.test(scanLine(line.trim()))) {
			speakerLines++;
		}
	}
	if (
		speakerLines >= 5 &&
		speakerLines / Math.max(nonBlank.length, 1) >= 0.3
	) {
		return "dialogue";
	}

	const headings = findHeadings(lines);
	const datedHeadings = headings.filter((h) => dateOrVersion(h.title));
	if (datedHeadings.length >= 3) {
		return "dated";
	}

	let listLines = 0;
	for (const line of nonBlank) {
		const scanned = scanLine(line);
		if (LIST_ITEM_RE.test(scanned) || isTableRow(line)) {
			listLines++;
		}
	}
	if (nonBlank.length >= 5 && listLines / nonBlank.length >= 0.6) {
		return "items";
	}

	if (headings.length >= 2) {
		return "sectioned";
	}
	return null;
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/** A boundary unit: one section, item, dated entry, turn or row. */
interface Unit {
	text: string;
	start: number;
	end: number;
	/** Heading path above (and including) the unit, for `sectioned`/`items`. */
	path?: string[];
	itemKey?: string;
	date?: string;
}

/** Extra payload fields a profile chunk carries (§7). */
export interface ProfileChunkPayload {
	section?: string;
	itemKey?: string;
	date?: string;
}

export interface ProfileChunk {
	chunk: TextChunk;
	payload: ProfileChunkPayload;
}

const SPLIT_SEPARATORS = ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " "];

/**
 * The last `sep` in `window` worth cutting at. A line break is skipped when
 * the next line continues the one before (a wrapped list item or sentence)
 * or is a table's separator row, which must stay under its header.
 */
function lastCleanCut(
	text: string,
	cursor: number,
	window: string,
	sep: string,
): number {
	let at = window.lastIndexOf(sep);
	if (sep !== "\n") {
		return at;
	}
	while (at > 0) {
		const nextLine = scanLine(
			text.slice(cursor + at + 1, cursor + at + 1 + MAX_LINE_SCAN),
		).split("\n", 1)[0] as string;
		const continues =
			TABLE_SEPARATOR_RE.test(scanLine(nextLine)) ||
			(/^(?:[ \t]+|)\p{Ll}/u.test(nextLine) &&
				!LIST_ITEM_RE.test(nextLine));
		if (!continues) {
			return at;
		}
		at = window.lastIndexOf(sep, at - 1);
	}
	return at;
}

/**
 * Split text into pieces of at most `max` characters, preferring the coarsest
 * separator that works. Pieces keep their offset inside `text`.
 */
export function splitToMax(
	text: string,
	max: number,
): Array<{ text: string; start: number }> {
	if (text.length <= max) {
		return [{ text, start: 0 }];
	}
	const pieces: Array<{ text: string; start: number }> = [];
	let cursor = 0;
	while (cursor < text.length) {
		if (text.length - cursor <= max) {
			pieces.push({ text: text.slice(cursor), start: cursor });
			break;
		}
		const window = text.slice(cursor, cursor + max);
		let cut = -1;
		for (const sep of SPLIT_SEPARATORS) {
			const at = lastCleanCut(text, cursor, window, sep);
			// Do not cut in the first quarter: it would leave a sliver.
			if (at > max / 4) {
				cut = at + sep.length;
				break;
			}
		}
		if (cut <= 0) {
			cut = max;
		}
		pieces.push({ text: text.slice(cursor, cursor + cut), start: cursor });
		cursor += cut;
	}
	return pieces.filter((p) => p.text.trim().length > 0);
}

function pathLabel(path: string[] | undefined): string | undefined {
	return path && path.length > 0 ? path.join(" > ") : undefined;
}

/**
 * Merge small neighbouring units up to `target` and split units over `max`.
 * `prefixFor` returns text placed before a chunk's body (a heading path or a
 * table header); it is not counted against the unit's own size.
 */
function packUnits(
	units: Unit[],
	size: ProfileSize,
	options: {
		joiner?: string;
		prefixFor?: (first: Unit, piece: { continued: boolean }) => string;
		/** Units that may share a chunk (`length`: the chunk so far); default any. */
		canMerge?: (a: Unit, b: Unit, length: number) => boolean;
		/** Text of a unit joining a chunk after `previous`; default its own. */
		textFor?: (unit: Unit, previous: Unit) => string;
		/** Below this length a chunk takes in more, up to `max`. */
		smallUnder?: number;
	} = {},
): Array<{ text: string; start: number; end: number; first: Unit }> {
	const joiner = options.joiner ?? "\n\n";
	const out: Array<{
		text: string;
		start: number;
		end: number;
		first: Unit;
		/** Last unit of a packed chunk; absent on a piece of a split unit. */
		last?: Unit;
	}> = [];
	let current: { units: Unit[]; length: number } | null = null;

	const flush = () => {
		if (!current || current.units.length === 0) {
			current = null;
			return;
		}
		const first = current.units[0] as Unit;
		const last = current.units[current.units.length - 1] as Unit;
		const units = current.units;
		const body = units
			.map((u, i) =>
				i > 0 && options.textFor
					? options.textFor(u, units[i - 1] as Unit)
					: u.text,
			)
			.join(joiner);
		// A small last piece joins the chunk before it when that one has room.
		const before = out[out.length - 1];
		if (
			current.length < (options.smallUnder ?? 0) &&
			before?.last &&
			(options.canMerge?.(before.last, first, 0) ?? true)
		) {
			const tail = options.textFor
				? options.textFor(first, before.last)
				: first.text;
			const rest = body.slice(first.text.length);
			const text = `${before.text}${joiner}${tail}${rest}`;
			if (text.length <= size.max) {
				before.text = text;
				before.end = last.end;
				before.last = last;
				current = null;
				return;
			}
		}
		const prefix = options.prefixFor?.(first, { continued: false }) ?? "";
		out.push({
			text: prefix + body,
			start: first.start,
			end: last.end,
			first,
			last,
		});
		current = null;
	};

	for (const unit of units) {
		if (unit.text.trim().length === 0) {
			continue;
		}
		if (unit.text.length > size.max) {
			flush();
			const pieces = splitToMax(unit.text, size.max);
			pieces.forEach((piece, i) => {
				const prefix =
					options.prefixFor?.(unit, { continued: i > 0 }) ?? "";
				out.push({
					text: prefix + piece.text,
					start: unit.start + piece.start,
					end: unit.start + piece.start + piece.text.length,
					first: unit,
				});
			});
			continue;
		}
		const previous = current?.units[current.units.length - 1];
		const joined =
			previous && options.textFor
				? options.textFor(unit, previous)
				: unit.text;
		const fits =
			current !== null &&
			previous !== undefined &&
			current.length + joiner.length + joined.length <=
				// A chunk still too small to stand alone may grow to `max`.
				(current.length < (options.smallUnder ?? 0)
					? size.max
					: size.target) &&
			(options.canMerge?.(previous, unit, current.length) ?? true);
		if (current && fits) {
			current.units.push(unit);
			current.length += joiner.length + joined.length;
		} else {
			flush();
			current = { units: [unit], length: unit.text.length };
		}
	}
	flush();
	return out;
}

/** Character offset of the start of each line. */
function lineOffsets(lines: string[]): number[] {
	const offsets: number[] = [];
	let at = 0;
	for (const line of lines) {
		offsets.push(at);
		at += line.length + 1;
	}
	return offsets;
}

function sliceLines(
	content: string,
	lines: string[],
	offsets: number[],
	from: number,
	to: number,
): { text: string; start: number; end: number } {
	const start = offsets[from] ?? content.length;
	const end =
		to >= lines.length
			? content.length
			: (offsets[to] ?? content.length) - 1;
	const raw = content.slice(start, Math.max(start, end));
	const trimmedEnd = raw.replace(/\s+$/, "");
	return { text: trimmedEnd, start, end: start + trimmedEnd.length };
}

/** Paragraph units for text without structure. */
function paragraphUnits(content: string): Unit[] {
	const units: Unit[] = [];
	const re = /\r?\n[ \t]*\r?\n/g;
	let start = 0;
	let match: RegExpExecArray | null = re.exec(content);
	while (match !== null) {
		const text = content.slice(start, match.index);
		if (text.trim()) {
			units.push({ text: text.trim(), start, end: match.index });
		}
		start = match.index + match[0].length;
		match = re.exec(content);
	}
	const tail = content.slice(start);
	if (tail.trim()) {
		units.push({ text: tail.trim(), start, end: content.length });
	}
	return units;
}

function sectionUnits(content: string): Unit[] {
	const lines = content.split("\n");
	const offsets = lineOffsets(lines);
	const headings = findHeadings(lines, 3);
	if (headings.length === 0) {
		return paragraphUnits(content);
	}
	const units: Unit[] = [];
	const stack: MarkdownHeading[] = [];
	const first = headings[0] as MarkdownHeading;
	if (first.line > 0) {
		const pre = sliceLines(content, lines, offsets, 0, first.line);
		if (pre.text.trim()) {
			units.push({ ...pre, path: [] });
		}
	}
	headings.forEach((heading, i) => {
		while (
			stack.length > 0 &&
			(stack[stack.length - 1] as MarkdownHeading).level >= heading.level
		) {
			stack.pop();
		}
		stack.push(heading);
		const nextLine = headings[i + 1]?.line ?? lines.length;
		const slice = sliceLines(
			content,
			lines,
			offsets,
			heading.line,
			nextLine,
		);
		units.push({ ...slice, path: stack.map((h) => h.title) });
	});
	return units;
}

/**
 * `sectioned`: one unit per H1–H3 section; the heading path is prefixed so a
 * chunk taken out of its document still says where it came from. Without
 * headings, paragraphs are the units.
 */
function chunkSectioned(content: string, size: ProfileSize) {
	const units = sectionUnits(content);
	return packUnits(units, size, {
		smallUnder: SMALL_SECTION_CHARS,
		prefixFor: (first, { continued }) => {
			const path = first.path ?? [];
			if (path.length === 0) {
				return "";
			}
			// The section's own heading opens its first piece; prefix only the
			// ancestors there, and the full path on a continuation.
			const shown = continued ? path : path.slice(0, -1);
			return shown.length > 0 ? `${shown.join(" > ")}\n\n` : "";
		},
	}).map((p) => ({ ...p, payload: { section: pathLabel(p.first.path) } }));
}

const RULE_RE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** A chunk shorter than this takes the next section in rather than ending. */
const SMALL_SECTION_CHARS = 400;

function headerOf(unit: Unit): string | undefined {
	return (unit as { tableHeader?: string }).tableHeader;
}

const ITEM_KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+|#\d+)\b/;

function itemKeyFor(text: string, fallback: number): string {
	const match = ITEM_KEY_RE.exec(scanLine(text));
	return match?.[1] ?? `item-${fallback}`;
}

/**
 * `items`: one unit per top-level list item (with its sub-items and
 * continuation lines) or table row (with the table header repeated).
 * Headings and loose paragraphs become their own units and set the section.
 */
function chunkItems(content: string, size: ProfileSize) {
	const lines = content.split("\n");
	const offsets = lineOffsets(lines);
	const units: Array<Unit & { tableHeader?: string }> = [];
	let section: string[] = [];
	let itemCount = 0;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const scanned = scanLine(line);
		if (line.trim().length === 0) {
			i++;
			continue;
		}
		const heading = HEADING_RE.exec(scanned);
		if (heading) {
			section = [(heading[2] ?? "").trim()];
			i++;
			continue;
		}
		const list = LIST_ITEM_RE.exec(scanned);
		if (list) {
			const indent = (list[1] ?? "").length;
			let j = i + 1;
			while (j < lines.length) {
				const next = scanLine(lines[j] ?? "");
				if (next.trim().length === 0) {
					// A blank line ends the item unless indented content follows.
					const after = scanLine(lines[j + 1] ?? "");
					const afterIndent = /^[ \t]*/.exec(after)?.[0].length ?? 0;
					if (after.trim().length > 0 && afterIndent > indent) {
						j++;
						continue;
					}
					break;
				}
				const nextList = LIST_ITEM_RE.exec(next);
				if (nextList && (nextList[1] ?? "").length <= indent) {
					break;
				}
				if (HEADING_RE.test(next) || isTableRow(lines[j] ?? "")) {
					break;
				}
				j++;
			}
			const slice = sliceLines(content, lines, offsets, i, j);
			itemCount++;
			units.push({
				...slice,
				path: section,
				itemKey: itemKeyFor(slice.text, itemCount),
			});
			i = j;
			continue;
		}
		if (isTableRow(line)) {
			let header: string | undefined;
			let j = i;
			if (TABLE_SEPARATOR_RE.test(scanLine(lines[i + 1] ?? ""))) {
				header = `${line}\n${lines[i + 1]}`;
				j = i + 2;
			}
			while (j < lines.length && isTableRow(lines[j] ?? "")) {
				const slice = sliceLines(content, lines, offsets, j, j + 1);
				itemCount++;
				units.push({
					...slice,
					path: section,
					itemKey: itemKeyFor(slice.text, itemCount),
					tableHeader: header,
				});
				j++;
			}
			i = j;
			continue;
		}
		// A horizontal rule only separates; on its own it would be a chunk
		// holding nothing but its section's name.
		if (RULE_RE.test(scanned)) {
			i++;
			continue;
		}
		// A loose paragraph: up to the next blank line, heading or list item.
		let j = i + 1;
		while (j < lines.length) {
			const next = scanLine(lines[j] ?? "");
			if (
				next.trim().length === 0 ||
				HEADING_RE.test(next) ||
				LIST_ITEM_RE.test(next) ||
				isTableRow(lines[j] ?? "")
			) {
				break;
			}
			j++;
		}
		units.push({
			...sliceLines(content, lines, offsets, i, j),
			path: section,
		});
		i = j;
	}

	return packUnits(units, size, {
		joiner: "\n",
		// A short section joins the chunk before it rather than standing alone
		// as a fragment; its own heading goes in front of it there.
		smallUnder: SMALL_SECTION_CHARS,
		canMerge: (a, b, length) =>
			length < SMALL_SECTION_CHARS ||
			(pathLabel(a.path) === pathLabel(b.path) &&
				headerOf(a) === headerOf(b)),
		textFor: (unit, previous) => {
			const label = pathLabel(unit.path);
			const header = headerOf(unit);
			const lead = [
				label && label !== pathLabel(previous.path) ? label : "",
				header && header !== headerOf(previous) ? header : "",
			].filter(Boolean);
			return lead.length > 0
				? `${lead.join("\n")}\n${unit.text}`
				: unit.text;
		},
		prefixFor: (first) => {
			const parts: string[] = [];
			const label = pathLabel(first.path);
			if (label) {
				parts.push(label);
			}
			const header = (first as { tableHeader?: string }).tableHeader;
			if (header) {
				parts.push(header);
			}
			return parts.length > 0 ? `${parts.join("\n")}\n` : "";
		},
	}).map((p) => ({
		...p,
		payload: { section: pathLabel(p.first.path), itemKey: p.first.itemKey },
	}));
}

/**
 * `dated`: one unit per heading that carries a date or version (an entry runs
 * to the next such heading, so its own sub-headings stay with it).
 */
function chunkDated(content: string, size: ProfileSize) {
	const lines = content.split("\n");
	const offsets = lineOffsets(lines);
	const dated = findHeadings(lines)
		.map((h) => ({ ...h, date: dateOrVersion(h.title) }))
		.filter(
			(h): h is MarkdownHeading & { date: string } => h.date !== null,
		);
	if (dated.length === 0) {
		return chunkSectioned(content, size);
	}
	const units: Unit[] = [];
	const firstLine = (dated[0] as MarkdownHeading).line;
	if (firstLine > 0) {
		const pre = sliceLines(content, lines, offsets, 0, firstLine);
		if (pre.text.trim()) {
			units.push(pre);
		}
	}
	dated.forEach((heading, i) => {
		const next = dated[i + 1]?.line ?? lines.length;
		units.push({
			...sliceLines(content, lines, offsets, heading.line, next),
			date: heading.date,
			path: [heading.title],
		});
	});
	return packUnits(units, size, {
		prefixFor: (first, { continued }) =>
			continued && first.path?.[0] ? `${first.path[0]}\n\n` : "",
	}).map((p) => ({
		...p,
		payload: { section: pathLabel(p.first.path), date: p.first.date },
	}));
}

/**
 * `dialogue`: speaker turns grouped into windows up to `target`, each window
 * repeating the previous window's last `overlap` turns.
 */
function chunkDialogue(content: string, size: ProfileSize) {
	const lines = content.split("\n");
	const offsets = lineOffsets(lines);
	const starts: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = scanLine((lines[i] ?? "").trim());
		if (SPEAKER_RE.test(line)) {
			// A bare timestamp line directly above a speaker belongs to the turn.
			const prev = (lines[i - 1] ?? "").trim();
			starts.push(i > 0 && TIMESTAMP_ONLY_RE.test(prev) ? i - 1 : i);
		}
	}
	if (starts.length === 0) {
		return chunkSectioned(content, PROFILE_SIZES.sectioned);
	}
	const turns: Unit[] = [];
	if ((starts[0] as number) > 0) {
		const pre = sliceLines(content, lines, offsets, 0, starts[0] as number);
		if (pre.text.trim()) {
			turns.push(pre);
		}
	}
	starts.forEach((start, i) => {
		const slice = sliceLines(
			content,
			lines,
			offsets,
			start,
			starts[i + 1] ?? lines.length,
		);
		if (slice.text.trim()) {
			turns.push(slice);
		}
	});

	const out: Array<{
		text: string;
		start: number;
		end: number;
		first: Unit;
		payload: ProfileChunkPayload;
	}> = [];
	const overlap = Math.max(0, Math.floor(size.overlap));
	let i = 0;
	while (i < turns.length) {
		const turn = turns[i] as Unit;
		if (turn.text.length > size.max) {
			for (const piece of splitToMax(turn.text, size.max)) {
				out.push({
					text: piece.text,
					start: turn.start + piece.start,
					end: turn.start + piece.start + piece.text.length,
					first: turn,
					payload: {},
				});
			}
			i++;
			continue;
		}
		const window: Unit[] = [turn];
		let length = turn.text.length;
		let j = i + 1;
		while (j < turns.length) {
			const next = turns[j] as Unit;
			if (length + 1 + next.text.length > size.target) {
				break;
			}
			window.push(next);
			length += 1 + next.text.length;
			j++;
		}
		const last = window[window.length - 1] as Unit;
		out.push({
			text: window.map((t) => t.text).join("\n"),
			start: turn.start,
			end: last.end,
			first: turn,
			payload: {},
		});
		if (j >= turns.length) {
			break;
		}
		// Step back `overlap` turns, but always move forward.
		i = Math.max(i + 1, j - overlap);
	}
	return out;
}

/** Split CSV text into records, keeping quoted newlines inside a record. */
function csvRecords(content: string): Array<{ text: string; start: number }> {
	const records: Array<{ text: string; start: number }> = [];
	let start = 0;
	let inQuotes = false;
	for (let i = 0; i < content.length; i++) {
		const ch = content[i];
		if (ch === '"') {
			inQuotes = !inQuotes;
		} else if (ch === "\n" && !inQuotes) {
			records.push({
				text: content.slice(start, i).replace(/\r$/, ""),
				start,
			});
			start = i + 1;
		}
	}
	if (start < content.length) {
		records.push({ text: content.slice(start).replace(/\r$/, ""), start });
	}
	return records.filter((r) => r.text.trim().length > 0);
}

/** `tabular`: rows grouped up to `target`, the header row repeated in each. */
function chunkTabular(content: string, size: ProfileSize) {
	const records = csvRecords(content);
	const header = records[0];
	if (!header) {
		return [];
	}
	const rows: Unit[] = records.slice(1).map((r, n) => ({
		text: r.text,
		start: r.start,
		end: r.start + r.text.length,
		itemKey: `row-${n + 1}`,
	}));
	if (rows.length === 0) {
		return [
			{
				text: header.text,
				start: header.start,
				end: header.start + header.text.length,
				first: { text: header.text, start: 0, end: header.text.length },
				payload: {},
			},
		];
	}
	const budget: ProfileSize = {
		...size,
		target: Math.max(size.target - header.text.length - 1, 1),
		max: Math.max(size.max - header.text.length - 1, 1),
	};
	return packUnits(rows, budget, {
		joiner: "\n",
		prefixFor: () => `${header.text}\n`,
	}).map((p) => ({ ...p, payload: { itemKey: p.first.itemKey } }));
}

/** `whole`: one chunk, unless longer than `max`, then `sectioned`. */
function chunkWhole(content: string, size: ProfileSize) {
	if (content.length > size.max) {
		return chunkSectioned(content, PROFILE_SIZES.sectioned);
	}
	const text = content.trim();
	const start = content.indexOf(text);
	return [
		{
			text,
			start,
			end: start + text.length,
			first: { text, start, end: start + text.length },
			payload: {},
		},
	];
}

function isTableBlock(lines: string[]): boolean {
	return lines.length >= 2 && lines.every((line) => isTableRow(line));
}

/**
 * Split an oversized block: a table by rows with its header repeated, any
 * other block at the coarsest boundary (`splitToMax`). Pieces keep their
 * offset inside the block.
 */
function splitBlock(
	text: string,
	max: number,
): Array<{ text: string; start: number }> {
	const lines = text.split("\n");
	if (!isTableBlock(lines)) {
		return splitToMax(text, max);
	}
	const offsets = lineOffsets(lines);
	const headerLines = TABLE_SEPARATOR_RE.test(scanLine(lines[1] ?? ""))
		? 2
		: 0;
	const header =
		headerLines > 0 ? `${lines.slice(0, headerLines).join("\n")}\n` : "";
	const pieces: Array<{ text: string; start: number }> = [];
	let rows: string[] = [];
	let start = offsets[headerLines] ?? 0;
	const flush = () => {
		if (rows.length > 0) {
			pieces.push({ text: header + rows.join("\n"), start });
		}
		rows = [];
	};
	for (let i = headerLines; i < lines.length; i++) {
		const row = lines[i] ?? "";
		const length =
			header.length + rows.reduce((n, r) => n + r.length + 1, 0);
		if (rows.length > 0 && length + row.length > max) {
			flush();
			start = offsets[i] ?? start;
		}
		rows.push(row);
	}
	flush();
	return pieces;
}

/**
 * The end of `previous` repeated at the start of the next chunk: at most
 * `overlap` characters, beginning at a line or a sentence so the next chunk
 * never opens mid-word. Empty when no boundary falls inside the window.
 */
export function boundaryOverlap(previous: string, overlap: number): string {
	if (overlap <= 0 || previous.length === 0) {
		return "";
	}
	const from = Math.max(0, previous.length - overlap);
	// Scan a few characters before the window: a boundary that ends right
	// at its edge still opens it.
	const scanFrom = Math.max(0, from - 2);
	const window = previous.slice(from);
	const starts: number[] = from === 0 ? [0] : [];
	const re = /\n|[.!?](?![.!?])[ \t]+/g;
	const scan = previous.slice(scanFrom);
	let match: RegExpExecArray | null = re.exec(scan);
	while (match !== null) {
		const at = scanFrom + match.index + match[0].length - from;
		if (at >= 0 && at < window.length) {
			starts.push(at);
		}
		match = re.exec(scan);
	}
	// A line start opening a lower-case word is a wrapped sentence; prefer
	// a start that opens a new sentence, line or structure.
	const at =
		starts.find((s) => !/^[ \t]*\p{Ll}/u.test(window.slice(s))) ??
		starts[0];
	return at === undefined ? "" : window.slice(at).trim();
}

/**
 * Content-aware `prose` (spec 2026-10-28 §5): the project's chunk size and
 * overlap, but chunks end between blocks (paragraphs, lists, tables), then
 * lines, then sentences; an oversized table repeats its header; the overlap
 * starts at a line or a sentence. Headings above a chunk become its section.
 */
export function chunkProseByBoundaries(
	content: string,
	filename: string,
	options: { chunkSize: number; chunkOverlap: number },
): TextChunk[] {
	const chunkSize = Math.max(options.chunkSize, 1);
	const blocks: Unit[] = [];
	for (const section of sectionUnits(content)) {
		for (const block of paragraphUnits(section.text)) {
			const pieces =
				block.text.length > chunkSize
					? splitBlock(block.text, chunkSize)
					: [{ text: block.text, start: 0 }];
			for (const piece of pieces) {
				const start = section.start + block.start + piece.start;
				blocks.push({
					text: piece.text.trim(),
					start,
					end: start + piece.text.length,
					path: section.path,
				});
			}
		}
	}

	const packed = packUnits(
		blocks.filter((b) => b.text.length > 0),
		{ target: chunkSize, max: chunkSize, overlap: 0 },
	);
	if (packed.length === 0 && content.trim().length > 0) {
		const text = content.trim();
		packed.push({
			text,
			start: 0,
			end: content.length,
			first: { text, start: 0, end: content.length },
		});
	}

	return packed.map((piece, index) => {
		const previous = packed[index - 1];
		const lead = previous
			? boundaryOverlap(previous.text, options.chunkOverlap)
			: "";
		const text = lead ? `${lead}\n\n${piece.text}` : piece.text;
		const section = pathLabel(piece.first.path);
		return {
			content: text,
			index,
			tokenEstimate: estimateTokenCount(text),
			metadata: {
				filename,
				startOffset: piece.start,
				endOffset: piece.end,
				...(section ? { section, headings: section.split(" > ") } : {}),
			},
		};
	});
}

/** Resolve the effective size: code default, then a per-type tuning entry. */
export function resolveProfileSize(
	profile: Exclude<ChunkProfile, "openapi" | "prose">,
	tuning?: ChunkProfileTuning,
): ProfileSize {
	const base = PROFILE_SIZES[profile];
	const target = tuning?.target ?? base.target;
	const max = Math.max(tuning?.max ?? base.max, target);
	return { target, max, overlap: tuning?.overlap ?? base.overlap };
}

/**
 * Chunk content with a structural profile. `openapi` and `prose` are not
 * handled here: the router owns them.
 */
export function chunkWithProfile(
	content: string,
	filename: string,
	profile: Exclude<ChunkProfile, "openapi" | "prose">,
	tuning?: ChunkProfileTuning,
): ProfileChunk[] {
	const size = resolveProfileSize(profile, tuning);
	let pieces: Array<{
		text: string;
		start: number;
		end: number;
		payload: ProfileChunkPayload;
	}>;
	switch (profile) {
		case "sectioned":
			pieces = chunkSectioned(content, size);
			break;
		case "whole":
			pieces = chunkWhole(content, size);
			break;
		case "items":
			pieces = chunkItems(content, size);
			break;
		case "dated":
			pieces = chunkDated(content, size);
			break;
		case "dialogue":
			pieces = chunkDialogue(content, size);
			break;
		case "tabular":
			pieces = chunkTabular(content, size);
			break;
	}

	const nonEmpty = repeatTableHeaders(
		pieces.filter((p) => p.text.trim().length > 0),
	);
	// Never drop non-empty content (same guarantee as `chunkText`).
	if (nonEmpty.length === 0 && content.trim().length > 0) {
		const text = content.trim();
		nonEmpty.push({ text, start: 0, end: text.length, payload: {} });
	}

	return nonEmpty.map((piece, index) => ({
		chunk: {
			content: piece.text,
			index,
			tokenEstimate: estimateTokenCount(piece.text),
			metadata: {
				filename,
				startOffset: piece.start,
				endOffset: piece.end,
				...(piece.payload.section
					? {
							section: piece.payload.section,
							headings: piece.payload.section.split(" > "),
						}
					: {}),
			},
		},
		payload: stripUndefined(piece.payload),
	}));
}

/**
 * A table cut between two chunks (an oversized section split by lines)
 * continues under its header: the next chunk gets the header row and
 * separator in front of its first row, after any heading-path prefix.
 */
function repeatTableHeaders<T extends { text: string }>(pieces: T[]): T[] {
	let header: string | null = null;
	return pieces.map((piece, index) => {
		let text = piece.text;
		const previous = index > 0 ? pieces[index - 1] : undefined;
		const continues =
			header !== null &&
			previous !== undefined &&
			isTableRow(lastLineOf(previous.text));
		const lines = text.split("\n");
		const firstRow = lines.findIndex((l) => isTableRow(l));
		if (
			continues &&
			firstRow !== -1 &&
			lines.slice(0, firstRow).every((l) => !isTableRow(l)) &&
			!TABLE_SEPARATOR_RE.test(scanLine(lines[firstRow + 1] ?? "")) &&
			lines.slice(0, firstRow).join("").trim().length < 300
		) {
			lines.splice(firstRow, 0, header as string);
			text = lines.join("\n");
		}
		header = trailingTableHeader(lines, header);
		return text === piece.text ? piece : { ...piece, text };
	});
}

/**
 * The header of the table a chunk ends in: its own header row, the header
 * carried in when the table began in an earlier chunk, or null for a
 * headerless table (or none at the end).
 */
function trailingTableHeader(
	lines: string[],
	carried: string | null,
): string | null {
	let end = lines.length - 1;
	while (end >= 0 && (lines[end] ?? "").trim().length === 0) {
		end--;
	}
	if (end < 0 || !isTableRow(lines[end] ?? "")) {
		return null;
	}
	let start = end;
	while (start > 0 && isTableRow(lines[start - 1] ?? "")) {
		start--;
	}
	if (TABLE_SEPARATOR_RE.test(scanLine(lines[start + 1] ?? ""))) {
		return `${scanLine(lines[start] ?? "")}\n${scanLine(lines[start + 1] ?? "")}`;
	}
	return start === 0 ? carried : null;
}

function lastLineOf(text: string): string {
	const trimmed = text.replace(/\s+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("\n") + 1);
}

function stripUndefined(payload: ProfileChunkPayload): ProfileChunkPayload {
	const out: ProfileChunkPayload = {};
	if (payload.section) {
		out.section = payload.section;
	}
	if (payload.itemKey) {
		out.itemKey = payload.itemKey;
	}
	if (payload.date) {
		out.date = payload.date;
	}
	return out;
}
