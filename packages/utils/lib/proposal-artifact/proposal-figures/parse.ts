/**
 * The figure line a fence asks for its template with, and the parser that
 * reads a fence's flowchart into the model every template draws from.
 *
 * Pure functions and data only: client components import this module.
 */

import {
	DIAGRAM_CAPTION_LINE,
	leadingCommentIndexes,
} from "../diagram-caption";
import { VISUAL_MARKER_PATTERN } from "../stat-tiles";

// ---------------------------------------------------------------------------
// The figure line
// ---------------------------------------------------------------------------

/** The templates a fence may ask for. A timeline draws as a dated process. */
export const FIGURE_KINDS = ["process", "timeline", "layers", "team"] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

/** A figure line, trimmed, capturing the kind as written. */
export const FIGURE_LINE = /^%%\s*figure:\s*(\S*)\s*$/i;

export function isFigureKind(value: string): value is FigureKind {
	return (FIGURE_KINDS as readonly string[]).includes(value);
}

/** The figure kind a fence body asks for, or null. */
export function readFigureKind(body: string): FigureKind | null {
	const lines = body.split(/\r\n?|\n/);
	for (const index of leadingCommentIndexes(lines, FIGURE_LINE)) {
		const kind = FIGURE_LINE.exec(lines[index].trim())?.[1]?.toLowerCase();
		if (kind && isFigureKind(kind)) {
			return kind;
		}
	}
	return null;
}

/**
 * `body` with `kind` as its only figure line: every figure line of the
 * leading comment block is removed, and a kind is written back after the
 * marker and caption lines (or first when there are none). Null only
 * removes. Returns `body` itself when nothing changes.
 */
export function withFigureKind(body: string, kind: FigureKind | null): string {
	const lines = body.split(/\r\n?|\n/);
	const existing = leadingCommentIndexes(lines, FIGURE_LINE);
	if (existing.length === 0 && kind === null) {
		return body;
	}
	const drop = new Set(existing);
	const kept = lines.filter((_line, index) => !drop.has(index));
	if (kind !== null) {
		const first = kept.findIndex((line) => line.trim() !== "");
		let at =
			first !== -1 && VISUAL_MARKER_PATTERN.test(kept[first].trim())
				? first + 1
				: 0;
		for (let index = at; index < kept.length; index += 1) {
			const trimmed = kept[index].trim();
			if (trimmed !== "" && !trimmed.startsWith("%%")) {
				break;
			}
			if (DIAGRAM_CAPTION_LINE.test(trimmed)) {
				at = index + 1;
			}
		}
		kept.splice(at, 0, `%% figure: ${kind}`);
	}
	const next = kept.join("\n");
	return next === body ? body : next;
}

// ---------------------------------------------------------------------------
// The flowchart subset
// ---------------------------------------------------------------------------

export interface FigureNode {
	id: string;
	/** Label lines, decoded; the id when the node was never given a label. */
	lines: string[];
	/** Class names from `class` lines and `:::name`, in order, unique. */
	classes: string[];
	/** The subgraph the node was first mentioned in, or null. */
	subgraph: string | null;
}

export interface FigureEdge {
	from: string;
	to: string;
	/** `-.->` rather than `-->`. */
	dashed: boolean;
	/** The `|label|` lines, decoded; empty when there is none. */
	label: string[];
}

export interface FigureSubgraph {
	id: string;
	/** Title lines, decoded; the id when there is no title. */
	title: string[];
	/** Member nodes in the order they were first mentioned. */
	nodeIds: string[];
}

export interface FigureModel {
	/** The header's direction, upper case, or null when it names none. */
	direction: string | null;
	/** Nodes in the order they were first mentioned. */
	nodes: FigureNode[];
	edges: FigureEdge[];
	/** Subgraphs in source order. */
	subgraphs: FigureSubgraph[];
}

/** The longest source read at all, in characters. */
const MAX_SOURCE_LENGTH = 20_000;
/** More nodes than this is not a figure any template draws. */
const MAX_NODES = 60;

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const HEADER = /^(?:flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?$/i;
const NODE_ID = /^[A-Za-z0-9_]+/;
/** Words that open a statement and so are never a node id. */
const RESERVED_IDS: ReadonlySet<string> = new Set([
	"end",
	"subgraph",
	"class",
	"classdef",
	"click",
	"style",
	"linkstyle",
	"direction",
	"graph",
	"flowchart",
]);
/** Node shapes as `[open, close]`, longest opener first. */
const SHAPES: ReadonlyArray<readonly [string, string]> = [
	["([", "])"],
	["[[", "]]"],
	["[(", ")]"],
	["((", "))"],
	["[", "]"],
	["(", ")"],
	["{", "}"],
];
const SOLID_ARROW = /^-{2,3}>/;
const DASHED_ARROW = /^-\.{1,3}->/;
const LINE_BREAK = /<br\s*\/?>/gi;
/** A tag the label would hand to an HTML parser: `<` then a name, `/`, `!` or `?`. */
const TAG_START = /<[A-Za-z/!?]/;
const ENTITY =
	/#(quot|lt|gt|amp|nbsp|\d{1,7});|&(quot|lt|gt|amp|apos|nbsp|#\d{1,7}|#x[0-9a-f]{1,6});/gi;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	quot: '"',
	lt: "<",
	gt: ">",
	amp: "&",
	apos: "'",
	nbsp: " ",
};

function decodeEntity(match: string, mermaid?: string, html?: string): string {
	const name = (mermaid ?? html ?? "").toLowerCase();
	const named = NAMED_ENTITIES[name];
	if (named !== undefined) {
		return named;
	}
	const code = name.startsWith("#x")
		? Number.parseInt(name.slice(2), 16)
		: Number.parseInt(name.replace("#", ""), 10);
	const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
	if (!Number.isFinite(code) || isControl || code > 0x10ffff) {
		return match;
	}
	if (code >= 0xd800 && code <= 0xdfff) {
		return match;
	}
	return String.fromCodePoint(code);
}

/**
 * A raw label as display lines, or null when it holds a tag other than a
 * line break. The tag check reads the raw text, before zero-width spaces are
 * removed: the templating writes a typed `<b>` as `<`, U+200B, `b>`, which is
 * text. Entities decode in one pass, so `&amp;lt;` reads as `&lt;`.
 */
function decodeLabel(raw: string): string[] | null {
	const broken = raw.replace(LINE_BREAK, "\n");
	if (TAG_START.test(broken)) {
		return null;
	}
	return broken
		.split("\n")
		.map((part) =>
			part
				.replace(ENTITY, decodeEntity)
				.split(ZERO_WIDTH_SPACE)
				.join("")
				.replace(/\s+/g, " ")
				.trim(),
		)
		.filter((part) => part !== "");
}

interface NodeRef {
	id: string;
	/** The raw label, or undefined when the reference declares none. */
	label?: string;
	classes: string[];
	end: number;
}

/** The node reference at `start` of `text`, or null when there is none. */
function readNodeRef(text: string, start: number): NodeRef | null {
	const id = NODE_ID.exec(text.slice(start))?.[0];
	if (!id || RESERVED_IDS.has(id.toLowerCase())) {
		return null;
	}
	let at = start + id.length;
	let label: string | undefined;
	const shape = SHAPES.find(([open]) => text.startsWith(open, at));
	if (shape) {
		const [open, close] = shape;
		at += open.length;
		if (text[at] === '"') {
			const closing = text.indexOf('"', at + 1);
			if (closing === -1) {
				return null;
			}
			label = text.slice(at + 1, closing);
			at = closing + 1;
		} else {
			const closing = text.indexOf(close, at);
			if (closing === -1) {
				return null;
			}
			label = text.slice(at, closing);
			if (/["[\](){}|]/.test(label)) {
				return null;
			}
			at = closing;
		}
		if (!text.startsWith(close, at)) {
			return null;
		}
		at += close.length;
	}
	const classes: string[] = [];
	const shorthand = /^:::([A-Za-z0-9_-]+)/.exec(text.slice(at));
	if (shorthand?.[1]) {
		classes.push(shorthand[1]);
		at += shorthand[0].length;
	}
	return { id, label, classes, end: at };
}

function skipSpaces(text: string, at: number): number {
	let index = at;
	while (index < text.length && /\s/.test(text[index])) {
		index += 1;
	}
	return index;
}

interface Statement {
	refs: NodeRef[];
	links: { dashed: boolean; label?: string }[];
}

/** A node statement: one node reference, or a chain of them joined by arrows. */
function readStatement(text: string): Statement | null {
	const first = readNodeRef(text, 0);
	if (!first) {
		return null;
	}
	const statement: Statement = { refs: [first], links: [] };
	let at = first.end;
	for (;;) {
		at = skipSpaces(text, at);
		if (at >= text.length) {
			return statement;
		}
		const rest = text.slice(at);
		const arrow = SOLID_ARROW.exec(rest) ?? DASHED_ARROW.exec(rest);
		if (!arrow) {
			return null;
		}
		const dashed = arrow[0].includes(".");
		at = skipSpaces(text, at + arrow[0].length);
		let label: string | undefined;
		if (text[at] === "|") {
			const closing = text.indexOf("|", at + 1);
			if (closing === -1) {
				return null;
			}
			label = text.slice(at + 1, closing).trim();
			const quoted = /^"([^"]*)"$/.exec(label);
			if (quoted) {
				label = quoted[1];
			} else if (label.includes('"')) {
				return null;
			}
			at = skipSpaces(text, closing + 1);
		}
		const next = readNodeRef(text, at);
		if (!next) {
			return null;
		}
		statement.links.push({ dashed, label });
		statement.refs.push(next);
		at = next.end;
	}
}

/**
 * The model of a flowchart in the figure subset, or null when the source is
 * anything else. `%%` comment lines (the marker, caption and figure lines
 * among them) are skipped, `classDef` lines and `style`/`linkStyle` lines
 * without `url(` are ignored, and `direction` lines inside a subgraph are
 * ignored. A node mentioned inside a subgraph belongs to the first one that
 * mentions it, as in Mermaid; a later label replaces an earlier one.
 */
export function parseFigureSource(source: string): FigureModel | null {
	if (source.length > MAX_SOURCE_LENGTH) {
		return null;
	}
	const nodes = new Map<string, FigureNode>();
	const edges: FigureEdge[] = [];
	const subgraphs: FigureSubgraph[] = [];
	const classLines: { ids: string[]; name: string }[] = [];
	let direction: string | null = null;
	let headerSeen = false;
	let current: FigureSubgraph | null = null;

	const mention = (ref: NodeRef): boolean => {
		let node = nodes.get(ref.id);
		if (!node) {
			node = { id: ref.id, lines: [ref.id], classes: [], subgraph: null };
			nodes.set(ref.id, node);
		}
		if (ref.label !== undefined) {
			const lines = decodeLabel(ref.label);
			if (lines === null) {
				return false;
			}
			node.lines = lines;
		}
		for (const name of ref.classes) {
			if (!node.classes.includes(name)) {
				node.classes.push(name);
			}
		}
		if (current && node.subgraph === null) {
			node.subgraph = current.id;
			current.nodeIds.push(node.id);
		}
		return true;
	};

	for (const raw of source.split(/\r\n?|\n/)) {
		const trimmed = raw.trim();
		if (trimmed === "") {
			continue;
		}
		if (trimmed.startsWith("%%{")) {
			return null;
		}
		if (trimmed.startsWith("%%")) {
			continue;
		}
		if (trimmed.startsWith("---")) {
			return null;
		}
		const line = trimmed.replace(/;+$/, "").trim();
		if (!headerSeen) {
			const header = HEADER.exec(line);
			if (!header) {
				return null;
			}
			direction = header[1]?.toUpperCase() ?? null;
			headerSeen = true;
			continue;
		}
		const keyword = /^[A-Za-z]+/.exec(line)?.[0]?.toLowerCase() ?? "";
		const afterKeyword = line.slice(keyword.length);
		const isKeyword = keyword !== "" && /^(?:\s|$)/.test(afterKeyword);
		if (isKeyword && keyword === "subgraph") {
			if (current) {
				return null;
			}
			const match =
				/^subgraph\s+([A-Za-z0-9_]+)\s*(?:\["([^"]*)"\]|\[([^\]"[]*)\])?$/i.exec(
					line,
				);
			if (
				!match?.[1] ||
				subgraphs.some((graph) => graph.id === match[1])
			) {
				return null;
			}
			const title = decodeLabel(match[2] ?? match[3] ?? match[1]);
			if (title === null) {
				return null;
			}
			current = { id: match[1], title, nodeIds: [] };
			subgraphs.push(current);
			continue;
		}
		if (isKeyword && keyword === "end") {
			if (!current || afterKeyword.trim() !== "") {
				return null;
			}
			current = null;
			continue;
		}
		if (isKeyword && keyword === "direction") {
			if (!/^direction\s+(?:TB|TD|BT|LR|RL)$/i.test(line)) {
				return null;
			}
			continue;
		}
		if (
			isKeyword &&
			(keyword === "classdef" ||
				keyword === "style" ||
				keyword === "linkstyle")
		) {
			if (/url\s*\(/i.test(line)) {
				return null;
			}
			continue;
		}
		if (isKeyword && keyword === "class") {
			const match =
				/^class\s+([A-Za-z0-9_,\s]+?)\s+([A-Za-z0-9_-]+)$/i.exec(line);
			if (!match?.[1] || !match[2]) {
				return null;
			}
			classLines.push({
				ids: match[1]
					.split(",")
					.map((id) => id.trim())
					.filter(Boolean),
				name: match[2],
			});
			continue;
		}
		if (isKeyword && keyword === "click") {
			return null;
		}
		const statement = readStatement(line);
		if (!statement) {
			return null;
		}
		for (const ref of statement.refs) {
			if (!mention(ref)) {
				return null;
			}
		}
		for (const [index, link] of statement.links.entries()) {
			const label =
				link.label === undefined ? [] : decodeLabel(link.label);
			if (label === null) {
				return null;
			}
			edges.push({
				from: statement.refs[index].id,
				to: statement.refs[index + 1].id,
				dashed: link.dashed,
				label,
			});
		}
		if (nodes.size > MAX_NODES) {
			return null;
		}
	}
	if (!headerSeen || current) {
		return null;
	}
	for (const { ids, name } of classLines) {
		for (const id of ids) {
			const node = nodes.get(id);
			if (node && !node.classes.includes(name)) {
				node.classes.push(name);
			}
		}
	}
	return {
		direction,
		nodes: Array.from(nodes.values()),
		edges,
		subgraphs,
	};
}
