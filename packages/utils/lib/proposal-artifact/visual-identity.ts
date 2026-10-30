/**
 * Identity of the generated visuals in a Proposal's Main body (Fizzy #2946).
 *
 * A diagram the generation's visuals step (or Edit with instructions) writes
 * opens its mermaid fence with one marker line naming the visual:
 *
 *   ```mermaid
 *   %% fabric-visual: k3v9q2m7x1a8c4d6
 *   flowchart LR
 *     ...
 *   ```
 *
 * Mermaid reads the line as a comment, and the editor keeps it because the
 * fence's language and body text survive its load and save. The server keeps
 * the fact-checked spec behind each visual, keyed by document, visual id and
 * the body's source hash, so any diagram fence can be classified against
 * those rows: still as generated, edited by a person, detached (copied, or
 * a second copy in the same document) or never generated.
 *
 * ## Source hash
 *
 * `v1:` plus `fnv1aHex64` over the body without its marker line, its
 * caption line (`diagram-caption.ts`) and its figure line
 * (`proposal-figures/`), after line endings become `\n`, trailing
 * whitespace is trimmed from every line and leading and trailing blank lines
 * are dropped. The editor's save rewrites a fence with three backticks and
 * trims trailing whitespace, so the hash is the same before and after a
 * round trip; a caption or figure line change leaves it as it was too, and a
 * fence that never had either hashes as it always did. It is a label, not a
 * security boundary: anyone with edit rights can write any fence.
 *
 * Pure and synchronous, no Node built-ins: the worker, the API and the
 * editor bundle all compute it. Minting an id needs randomness, so the
 * server mints it (`visual-id-server.ts`) and this module only checks the
 * shape.
 */

import type { Code, Root, RootContent } from "mdast";
import { fnv1aHex64 } from "../fnv1a";
import { parseOutline } from "../glossy/outline";
import {
	cleanDiagramCaption,
	DIAGRAM_CAPTION_LINE,
	DIAGRAM_CAPTION_MAX_CHARS,
	readDiagramCaption,
	withDiagramCaption,
} from "./diagram-caption";
import { diagramHeaderLine } from "./diagram-header";
import { parseMarkdownAst } from "./markdown-ast";
import {
	type FigureKind,
	readFigureKind,
	withFigureKind,
} from "./proposal-figures";
import { isDiagramFence } from "./section-hash";
import { VISUAL_MARKER_PATTERN } from "./stat-tiles";

export {
	cleanDiagramCaption,
	DIAGRAM_CAPTION_MAX_CHARS,
	diagramHeaderLine,
	readDiagramCaption,
	VISUAL_MARKER_PATTERN,
	withDiagramCaption,
};

/** The id shape a marker accepts: 12 to 32 lowercase letters or digits. */
export const VISUAL_ID_PATTERN = /^[a-z0-9]{12,32}$/;

/** Length of an id the server mints. */
export const MINTED_VISUAL_ID_LENGTH = 16;

/** The characters a minted id draws from. */
export const VISUAL_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Version prefix of the source and spec hashes. */
export const VISUAL_HASH_VERSION = "v1";

/** A source or spec hash of any version this module could have written. */
export const VISUAL_HASH_PATTERN = /^v[0-9]+:[0-9a-f]{16}$/;

/** Who generated a visual: the visuals step, or Edit with instructions. */
export const VISUAL_ORIGIN = {
	STEP: "STEP",
	INSTRUCTION: "INSTRUCTION",
} as const;
export const VISUAL_ORIGINS = [
	VISUAL_ORIGIN.STEP,
	VISUAL_ORIGIN.INSTRUCTION,
] as const;
export type VisualOrigin = (typeof VISUAL_ORIGINS)[number];

export function isVisualOrigin(value: string): value is VisualOrigin {
	return (VISUAL_ORIGINS as readonly string[]).includes(value);
}

/**
 * Bound on a person's request in Edit with instructions, for the editor's
 * form; the API and the prompt hold the same bound as
 * `GLOSSY_EDIT_INSTRUCTION_MAX_CHARS`.
 */
export const VISUAL_EDIT_INSTRUCTION_MAX_CHARS = 500;

/** What a client may know of a stored spec: never the spec itself. */
export interface VisualSpecSummary {
	visualId: string;
	sourceHash: string;
	kind: string;
	origin: VisualOrigin;
}

export type VisualFenceState = "generated" | "edited" | "detached" | "none";

export interface VisualFenceClassification {
	/** 0-based position among the document's diagram fences. */
	ordinal: number;
	/** The marker's id, when the fence opens with a valid marker. */
	visualId?: string;
	/** The body's source hash, marker excluded. */
	sourceHash: string;
	state: VisualFenceState;
	/** The matching row's origin, for `generated` only. */
	origin?: VisualOrigin;
}

export function isVisualId(value: string): boolean {
	return VISUAL_ID_PATTERN.test(value);
}

/** The marker line for `visualId`; throws on an id of any other shape. */
export function visualMarkerLine(visualId: string): string {
	if (!isVisualId(visualId)) {
		throw new Error("A visual id is 12 to 32 lowercase letters or digits");
	}
	return `%% fabric-visual: ${visualId}`;
}

/**
 * The body's marker id and the source after it. Only the first non-blank
 * line may be the marker; a malformed one is source, so the fence reads as
 * never generated.
 */
export function readVisualMarker(body: string): {
	visualId: string | null;
	source: string;
} {
	const lines = body.replace(/\r\n?/g, "\n").split("\n");
	const first = lines.findIndex((line) => line.trim() !== "");
	if (first === -1) {
		return { visualId: null, source: lines.join("\n") };
	}
	const marker = VISUAL_MARKER_PATTERN.exec(lines[first].trim());
	if (!marker?.[1]) {
		return { visualId: null, source: lines.join("\n") };
	}
	return {
		visualId: marker[1],
		source: lines.slice(first + 1).join("\n"),
	};
}

/** Whether `source` is a flowchart: its header is `flowchart` or `graph`. */
export function isFlowchartSource(source: string): boolean {
	const header = diagramHeaderLine(source);
	return header !== null && FLOWCHART_HEADER.test(header);
}

const FLOWCHART_HEADER = /^(?:flowchart|graph)(?:\s|$)/i;

/**
 * The source as the hash reads it: `\n` line endings, trailing whitespace
 * trimmed per line, leading and trailing blank lines dropped.
 */
export function normaliseVisualSource(source: string): string {
	const lines = source
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""));
	let first = 0;
	let last = lines.length - 1;
	while (first <= last && lines[first] === "") {
		first++;
	}
	while (last >= first && lines[last] === "") {
		last--;
	}
	return lines.slice(first, last + 1).join("\n");
}

/**
 * The source hash of a fence body; a valid marker line, the caption line and
 * the figure line are left out.
 */
export function visualSourceHash(body: string): string {
	const source = withFigureKind(
		withDiagramCaption(readVisualMarker(body).source, null),
		null,
	);
	return `${VISUAL_HASH_VERSION}:${fnv1aHex64(normaliseVisualSource(source))}`;
}

/**
 * A stable hash of a spec: JSON with object keys sorted, so two writers of
 * the same spec agree whatever order they built it in.
 */
export function visualSpecHash(spec: unknown): string {
	return `${VISUAL_HASH_VERSION}:${fnv1aHex64(stableJson(spec))}`;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, field]) => field !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries
			.map(
				([key, field]) => `${JSON.stringify(key)}:${stableJson(field)}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * Every diagram fence of `markdown` in document order, classified against
 * the document's stored specs:
 * - `generated`: a valid marker, the id's first occurrence, and a row with
 *   this id and source hash (its origin is returned);
 * - `edited`: a valid marker, first occurrence, rows for the id but none with
 *   this hash;
 * - `detached`: a valid marker whose id an earlier fence already carried, or
 *   with no row for the id at all (a fence pasted from another document);
 * - `none`: no valid marker.
 *
 * A diagram fence is what the editor draws as one (`isDiagramFence`), nested
 * fences included; stat tiles are not diagrams.
 */
export function classifyVisualFences(
	markdown: string,
	rows: readonly VisualSpecSummary[],
): VisualFenceClassification[] {
	const hashesById = new Map<string, Map<string, VisualOrigin>>();
	for (const row of rows) {
		let hashes = hashesById.get(row.visualId);
		if (!hashes) {
			hashes = new Map();
			hashesById.set(row.visualId, hashes);
		}
		if (!hashes.has(row.sourceHash)) {
			hashes.set(row.sourceHash, row.origin);
		}
	}

	const seen = new Set<string>();
	return diagramFences(markdown).map((fence, ordinal) => {
		const { visualId } = readVisualMarker(fence.value);
		const sourceHash = visualSourceHash(fence.value);
		if (!visualId) {
			return { ordinal, sourceHash, state: "none" };
		}
		const duplicate = seen.has(visualId);
		seen.add(visualId);
		const hashes = hashesById.get(visualId);
		if (duplicate || !hashes) {
			return { ordinal, visualId, sourceHash, state: "detached" };
		}
		const origin = hashes.get(sourceHash);
		return origin
			? { ordinal, visualId, sourceHash, state: "generated", origin }
			: { ordinal, visualId, sourceHash, state: "edited" };
	});
}

/**
 * `next` with the markers `previous` held put back on the diagrams a writer
 * left unchanged (Fizzy #2946).
 *
 * A model or API writer that replaces Main may drop the marker line of a
 * diagram it did not otherwise touch, which would leave the visual's stored
 * spec unreferenced. For each diagram fence of `next` without a valid marker
 * whose source hash equals that of a marked fence of `previous`, the marker
 * comes back as the fence's first body line. Each marker of `previous` is
 * used at most once, in order, and never when `next` already carries its id,
 * so two identical diagrams get back their own ids. A fence whose body
 * changed stays unmarked, and a marker `next` carries is never touched; a
 * duplicate id is left for `classifyVisualFences` to detach.
 *
 * A marked fence's figure line (`proposal-figures/`) comes back with it:
 * when the marker is restored, and when a writer kept the marker but dropped
 * the line of an otherwise unchanged diagram (the hash leaves the line out,
 * so a body is unchanged with or without it). It goes after the marker and
 * the caption, and never into a fence that carries a figure line of its own.
 *
 * Only the restored lines are added: every other byte of `next`, line
 * endings included, is unchanged. When `previous` holds no marker, returns
 * `next` itself.
 */
export function preserveVisualMarkers(
	previous: string | null | undefined,
	next: string,
): string {
	if (
		!previous ||
		!previous.includes(MARKER_HINT) ||
		!FENCE_HINT.test(next)
	) {
		return next;
	}

	const nextFences = diagramFences(next, { keepLineEndings: true });
	const keptIds = new Set<string>();
	for (const fence of nextFences) {
		const { visualId } = readVisualMarker(fence.value);
		if (visualId) {
			keptIds.add(visualId);
		}
	}

	// Each id's first fence in `previous`; the ones `next` lost are
	// available to restore.
	const previousById = new Map<string, PreviousVisual>();
	const available: PreviousVisual[] = [];
	for (const fence of diagramFences(previous)) {
		const { visualId } = readVisualMarker(fence.value);
		if (!visualId || previousById.has(visualId)) {
			continue;
		}
		const visual = {
			visualId,
			sourceHash: visualSourceHash(fence.value),
			figure: readFigureKind(fence.value),
		};
		previousById.set(visualId, visual);
		if (!keptIds.has(visualId)) {
			available.push(visual);
		}
	}
	if (previousById.size === 0) {
		return next;
	}

	const inserts: Array<{ at: number; text: string }> = [];
	const seenIds = new Set<string>();
	for (const fence of nextFences) {
		const sourceHash = visualSourceHash(fence.value);
		const { visualId } = readVisualMarker(fence.value);
		if (visualId) {
			const kept = seenIds.has(visualId)
				? undefined
				: previousById.get(visualId);
			seenIds.add(visualId);
			if (kept?.figure && kept.sourceHash === sourceHash) {
				const figure = figureInsertion(next, fence, kept.figure);
				if (figure) {
					inserts.push(figure);
				}
			}
			continue;
		}
		const index = available.findIndex(
			(entry) => entry.sourceHash === sourceHash,
		);
		if (index === -1) {
			continue;
		}
		const restored = available[index];
		const marker = visualMarkerLine(restored.visualId);
		// A fence told apart by its first line alone would stop being a
		// diagram under a marker line.
		if (!isDiagramFence(fence.lang, `${marker}\n${fence.value}`)) {
			continue;
		}
		const insert = markerInsertion(next, fence, marker);
		if (!insert) {
			continue;
		}
		available.splice(index, 1);
		inserts.push(insert);
		// Pushed after the marker: at the same offset, it lands below it.
		const figure =
			restored.figure && figureInsertion(next, fence, restored.figure);
		if (figure) {
			inserts.push(figure);
		}
	}
	if (inserts.length === 0) {
		return next;
	}

	let result = "";
	let cursor = 0;
	for (const { at, text } of inserts) {
		result += next.slice(cursor, at) + text;
		cursor = at;
	}
	return result + next.slice(cursor);
}

const MARKER_HINT = "fabric-visual:";
const FENCE_HINT = /```|~~~/;

/** A marked diagram of `previous`, as `preserveVisualMarkers` restores it. */
interface PreviousVisual {
	visualId: string;
	sourceHash: string;
	figure: FigureKind | null;
}

/**
 * Where the marker line of `fence` goes in `markdown`: right after the
 * opening fence line, with that line's own ending and the container prefix
 * a body line needs (a blockquote's `>`, a list item's indent).
 */
function markerInsertion(
	markdown: string,
	fence: Code,
	marker: string,
): { at: number; text: string } | null {
	const start = fence.position?.start.offset;
	if (start === undefined) {
		return null;
	}
	const ending = /\r\n|\r|\n/g;
	ending.lastIndex = start;
	const lineEnd = ending.exec(markdown);
	if (!lineEnd) {
		return null;
	}
	const lineStart =
		Math.max(
			markdown.lastIndexOf("\n", start - 1),
			markdown.lastIndexOf("\r", start - 1),
		) + 1;
	const prefix = markdown
		.slice(lineStart, start)
		.replace(/(?:[-*+]|\d{1,9}[.)])(?=[ \t])/g, (item) =>
			" ".repeat(item.length),
		);
	return {
		at: lineEnd.index + lineEnd[0].length,
		text: `${prefix}${marker}${lineEnd[0]}`,
	};
}

/**
 * Where the figure line for `kind` goes in `fence`: before the body line
 * after its marker and caption lines (the first body line when it has
 * neither), so the order is marker, caption, figure; null when the fence
 * already carries a figure line. Body lines map one to one onto the
 * Markdown's lines after the opening fence line, so the line is inserted at
 * the start of the matching Markdown line, with the same ending and
 * container prefix as `markerInsertion` writes.
 */
function figureInsertion(
	markdown: string,
	fence: Code,
	kind: FigureKind,
): { at: number; text: string } | null {
	if (withFigureKind(fence.value, null) !== fence.value) {
		return null;
	}
	const bodyLines = fence.value.split(/\r\n?|\n/);
	let after = 0;
	const first = bodyLines.findIndex((line) => line.trim() !== "");
	if (first !== -1 && VISUAL_MARKER_PATTERN.test(bodyLines[first].trim())) {
		after = first + 1;
	}
	for (let index = after; index < bodyLines.length; index += 1) {
		const trimmed = bodyLines[index].trim();
		if (trimmed !== "" && !trimmed.startsWith("%%")) {
			break;
		}
		if (DIAGRAM_CAPTION_LINE.test(trimmed)) {
			after = index + 1;
		}
	}
	const opening = markerInsertion(markdown, fence, `%% figure: ${kind}`);
	if (!opening) {
		return null;
	}
	// The opening fence line ends where `opening` inserts; skip `after` more
	// lines to reach the body line the figure line goes above.
	const ending = /\r\n|\r|\n/g;
	ending.lastIndex = opening.at;
	let at = opening.at;
	for (let line = 0; line < after; line += 1) {
		const lineEnd = ending.exec(markdown);
		if (!lineEnd) {
			return null;
		}
		at = lineEnd.index + lineEnd[0].length;
	}
	return { at, text: opening.text };
}

/**
 * The diagram fences of `markdown` in document order, nested ones included,
 * as `classifyVisualFences` counts them, so an ordinal names the same fence
 * everywhere. Line endings become `\n` first unless the caller needs offsets
 * into `markdown` itself.
 */
export function diagramFences(
	markdown: string,
	{ keepLineEndings = false }: { keepLineEndings?: boolean } = {},
): Code[] {
	const fences: Code[] = [];
	const visit = (node: Root | RootContent) => {
		if (node.type === "code") {
			if (isDiagramFence(node.lang, node.value)) {
				fences.push(node);
			}
			return;
		}
		if ("children" in node) {
			for (const child of node.children) {
				visit(child);
			}
		}
	};
	visit(
		parseMarkdownAst(
			keepLineEndings ? markdown : markdown.replace(/\r\n?/g, "\n"),
		),
	);
	return fences;
}

/** A diagram's section: its heading, and that heading's own body. */
export interface DiagramSection {
	heading: string | null;
	/** The body below the heading, trimmed, with `\n` line endings. */
	markdown: string;
}

/**
 * The section holding the `ordinal`-th diagram fence of `markdown`: the
 * nearest heading above it and that heading's own body, up to the next
 * heading of any level, as the visuals step reads a section. Above the
 * first heading, the preamble without one. Null for a bad ordinal.
 */
export function diagramSectionAt(
	markdown: string,
	ordinal: number,
): DiagramSection | null {
	const normalised = markdown.replace(/\r\n?/g, "\n");
	const fence = diagramFences(normalised)[ordinal];
	if (!fence) {
		return null;
	}
	return sectionAtLine(normalised, fence.position?.start.line ?? 1);
}

function sectionAtLine(markdown: string, line: number): DiagramSection {
	const lines = markdown.split("\n");
	const outline = parseOutline(markdown);
	let index = -1;
	for (let i = 0; i < outline.length; i++) {
		if (outline[i].startLine < line) {
			index = i;
		}
	}
	const bodyStart = index === -1 ? 0 : outline[index].startLine;
	const bodyEnd = (outline[index + 1]?.startLine ?? lines.length + 1) - 1;
	return {
		heading: index === -1 ? null : outline[index].text,
		markdown: lines.slice(bodyStart, bodyEnd).join("\n").trim(),
	};
}

/**
 * A fingerprint of the prose around the `ordinal`-th diagram fence: `v1:`
 * plus `fnv1aHex64` over the text of its section (`diagramSectionAt`),
 * heading included, with every diagram fence left out and whitespace
 * collapsed. Null for a bad ordinal.
 *
 * The text is read from the parsed tree, not the Markdown, so the same
 * prose written by a model or by the editor's save (other bullet or
 * emphasis markers, escapes, line wrapping) fingerprints the same; any
 * change to the words does not. Edit with instructions fact-checks a
 * candidate against this section, so the editor applies it only while its
 * own copy of the section still has the fingerprint the server returned.
 */
export function diagramSectionFingerprint(
	markdown: string,
	ordinal: number,
): string | null {
	const section = diagramSectionAt(markdown, ordinal);
	if (!section) {
		return null;
	}
	// The heading is read as inline text too, so `**` and `__` agree.
	const text = [section.heading ?? "", section.markdown]
		.map((part) => proseText(parseMarkdownAst(part)))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return `${VISUAL_HASH_VERSION}:${fnv1aHex64(text)}`;
}

/** Blocks and cells: their text stands a word apart from the next one's. */
const SPACED_NODES = new Set([
	"root",
	"paragraph",
	"heading",
	"blockquote",
	"list",
	"listItem",
	"table",
	"tableRow",
	"tableCell",
	"footnoteDefinition",
]);

/**
 * The words of a tree: text, inline code, image alt text and the body of
 * every fence that is not a diagram. Raw HTML tags (a highlight, a mention's
 * wrapper) are left out; the text between them is kept. Inline nodes join
 * without a space, so how a writer split a run of text does not count.
 */
function proseText(node: Root | RootContent): string {
	switch (node.type) {
		case "text":
		case "inlineCode":
			return node.value;
		case "code":
			return isDiagramFence(node.lang, node.value)
				? " "
				: ` ${node.value} `;
		case "image":
			return node.alt ?? "";
		case "break":
		case "thematicBreak":
			return " ";
		case "html":
			return "";
		default:
			break;
	}
	if (!("children" in node)) {
		return "";
	}
	const text = (node.children as RootContent[]).map(proseText).join("");
	return SPACED_NODES.has(node.type) ? ` ${text} ` : text;
}
