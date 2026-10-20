/**
 * Section identity and prose hashes for a Proposal's Main body (Fizzy #2946).
 *
 * Analysis findings, the answers people give to them, section revisions and
 * visual preservation all need to name a section and to tell whether its
 * text changed. This is the one way to do both, and it must give the same
 * answer in the worker, the API and the editor bundle.
 *
 * ## Sections
 *
 * The body is normalised (line endings to `\n`, text to NFC) and parsed once
 * with remark (`markdown-ast.ts`). Root-level headings are the boundaries —
 * ATX, indented ATX and setext alike; a heading inside a fence, an HTML
 * block, a list or a quote is content. A section owns its heading and the
 * blocks up to the next heading of any level, so sections are disjoint and an
 * edit under a `###` never changes its parent `##`. Line numbers are 1-based
 * against the normalised text.
 *
 * A leading `#` heading is the document's title, the rule Glossy's
 * segmentation applies (`GlossySection.headingPath` in `glossy/cleanup.ts`):
 * it is not a section, the text after it joins the preamble, and the
 * sections under it leave its anchor out of their paths, so renaming the
 * title changes no key and no section hash. A later `#` is a section, and it
 * and the sections under it keep their full paths.
 *
 * Text before the first section heading (the title's lead-in included) is the
 * preamble, keyed `PREAMBLE_SECTION_KEY`, and listed only when it holds text.
 *
 * ## Keys
 *
 * `p1:` + the heading-anchor path (`headingAnchor` of each ancestor heading,
 * then this one) joined with `/`, + `#` + the occurrence index among
 * sections sharing that path. `%`, `/`, `#` and `@` inside an anchor are
 * percent-escaped, so no heading can spell a separator or a reserved key.
 * Anchors drop numbering and tag suffixes, so renumbering "3. Scope" to
 * "4. Scope" keeps the key; renaming the heading, renaming an ancestor, or
 * moving the heading under another parent changes it.
 *
 * ## Prose hash
 *
 * The hash covers the section's text, not its Markdown bytes, because the
 * editor's save (Turndown) re-serialises every section. The projection,
 * version `p1`:
 *
 * - decoded text in NFC; emphasis, strong and strikethrough markers and
 *   escapes are gone, and so are literal `*`, `_` and `~`, which the
 *   editor's save writes back unescaped and the next parse may read as
 *   markers;
 * - one separator between blocks, list items, table cells and hard breaks,
 *   so splitting a list item or moving text between cells changes the hash
 *   while a tight list turning loose does not;
 * - inline code and image alt text count; link and image destinations do
 *   not (the editor's load percent-encodes them, and a URL-only change is
 *   not a change of the text); list numbers, bullets and fence languages do
 *   not;
 * - a task item's box counts as `[x] ` or `[ ] ` text, the form it takes
 *   after an editor save, which has no task-list syntax on load;
 * - HTML counts by its text: tags and comments are dropped, an `<img>` keeps
 *   its alt, and `<br>` and block tags separate. A `<visual-slot>` tag
 *   therefore counts for nothing;
 * - diagram fences count for nothing (mermaid, and every fence the editor
 *   turns into one on save); a `stat-tiles` fence is content, without its
 *   `%% fabric-visual` line; any other fence counts by its text;
 * - whitespace runs collapse to one space.
 *
 * A section's heading is not part of its own hash: its identity is the key,
 * so renumbering headings changes no hash. The document prose hash covers
 * every block, headings and title included.
 *
 * Keys and hashes carry the `p1:` prefix. A future change to this projection
 * bumps it, so a stored value from another version reads as "unknown", not
 * as "changed" (`isCurrentSectionVersion`).
 *
 * Pure and deterministic, and no Node built-ins: the worker, the API and the
 * editor bundle all import it.
 */

import type { Code, Heading, Nodes, PhrasingContent, RootContent } from "mdast";
import { fnv1aHex64 } from "../fnv1a";
import { headingAnchor } from "../glossy/outline";
import { parseMarkdownAst } from "./markdown-ast";

/** The projection version every key and hash is prefixed with. */
export const SECTION_HASH_VERSION = "p1";

const VERSION_PREFIX = `${SECTION_HASH_VERSION}:`;

/** Key of the text before the first section heading. */
export const PREAMBLE_SECTION_KEY = `${VERSION_PREFIX}@preamble`;

/**
 * Key of the whole document, for a finding that names no section. It never
 * appears in a section map; compare against `documentProseHash` instead.
 */
export const DOCUMENT_SECTION_KEY = `${VERSION_PREFIX}@document`;

/** One section of a body, in document order. */
export interface ProseSection {
	key: string;
	/** Decoded heading text, whitespace collapsed; `null` for the preamble. */
	headingText: string | null;
	/** Heading level, 1-6; `0` for the preamble. */
	depth: number;
	/** Heading anchors from the root down to this heading, title left out. */
	headingPath: string[];
	/** Index among sections sharing `headingPath`, in document order. */
	occurrenceIndex: number;
	/** 1-based first line of the section's own range: its heading. */
	startLine: number;
	/** 1-based last line before the next heading, or the document's last. */
	endLine: number;
	proseHash: string;
}

export interface SectionMap {
	sections: ProseSection[];
	/** Hash of the whole body's projection, headings included. */
	documentProseHash: string;
}

/**
 * Every section of `markdown` with its key and prose hash, plus the
 * document prose hash, from one parse. See the module comment for the rules.
 */
export function buildSectionMap(markdown: string): SectionMap {
	const source = normalizeSource(markdown);
	const blocks = parseMarkdownAst(source).children;
	const lineCount = source.split("\n").length;

	const headingIndexes: number[] = [];
	blocks.forEach((node, index) => {
		if (node.type === "heading") {
			headingIndexes.push(index);
		}
	});
	const firstHeading = headingIndexes[0];
	const titleIndex =
		firstHeading !== undefined &&
		(blocks[firstHeading] as Heading).depth === 1
			? firstHeading
			: -1;
	// The title's span ends at the next `#`; headings inside it drop its anchor.
	const titleSpanEnd =
		titleIndex === -1
			? -1
			: (headingIndexes.find(
					(index) =>
						index > titleIndex &&
						(blocks[index] as Heading).depth === 1,
				) ?? blocks.length);
	const sectionIndexes = headingIndexes.filter(
		(index) => index !== titleIndex,
	);

	const sections: ProseSection[] = [];

	const firstSection = sectionIndexes[0];
	const preambleBlocks = blocks
		.slice(0, firstSection ?? blocks.length)
		.filter((_, index) => index !== titleIndex);
	const preambleProjection = projectBlocks(preambleBlocks);
	if (preambleProjection) {
		sections.push({
			key: PREAMBLE_SECTION_KEY,
			headingText: null,
			depth: 0,
			headingPath: [],
			occurrenceIndex: 0,
			startLine: 1,
			endLine:
				firstSection === undefined
					? lineCount
					: startLineOf(blocks[firstSection]) - 1,
			proseHash: hashProjection(preambleProjection),
		});
	}

	const ancestors: Array<{ depth: number; anchor: string }> = [];
	const occurrences = new Map<string, number>();
	for (const index of headingIndexes) {
		const heading = blocks[index] as Heading;
		const headingText = collapse(inlineText(heading.children));
		const anchor = headingAnchor(headingText);
		while (
			ancestors.length > 0 &&
			ancestors[ancestors.length - 1].depth >= heading.depth
		) {
			ancestors.pop();
		}
		const fullPath = [...ancestors.map((entry) => entry.anchor), anchor];
		ancestors.push({ depth: heading.depth, anchor });
		if (index === titleIndex) {
			continue;
		}

		const underTitle = titleIndex !== -1 && index < titleSpanEnd;
		const headingPath = underTitle ? fullPath.slice(1) : fullPath;
		const pathKey = headingPath.map(escapeAnchor).join("/");
		const occurrenceIndex = occurrences.get(pathKey) ?? 0;
		occurrences.set(pathKey, occurrenceIndex + 1);

		const next = headingIndexes.find((candidate) => candidate > index);
		sections.push({
			key: `${VERSION_PREFIX}${pathKey}#${occurrenceIndex}`,
			headingText,
			depth: heading.depth,
			headingPath,
			occurrenceIndex,
			startLine: startLineOf(heading),
			endLine:
				next === undefined ? lineCount : startLineOf(blocks[next]) - 1,
			proseHash: hashProjection(
				projectBlocks(blocks.slice(index + 1, next ?? blocks.length)),
			),
		});
	}

	return {
		sections,
		documentProseHash: hashProjection(projectBlocks(blocks)),
	};
}

/**
 * Hash of the whole body's projection, headings and title included: run
 * staleness, and answers to findings that name no section.
 */
export function documentProseHash(markdown: string): string {
	return hashProjection(
		projectBlocks(parseMarkdownAst(normalizeSource(markdown)).children),
	);
}

/** The section with `key`, or `undefined` when the body has none. */
export function findSection(
	map: Pick<SectionMap, "sections">,
	key: string,
): ProseSection | undefined {
	return map.sections.find((section) => section.key === key);
}

/**
 * Whether a stored key or hash was written by this projection version. A
 * value from another version can be neither matched nor compared.
 */
export function isCurrentSectionVersion(value: string): boolean {
	return value.startsWith(VERSION_PREFIX);
}

// ---------------------------------------------------------------------------
// Normalisation and keys
// ---------------------------------------------------------------------------

/**
 * A UTF-16 surrogate without its pair; it has no NFC form. In `u` mode a
 * valid pair reads as one code point, so only a lone half matches.
 */
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;

function normalizeSource(markdown: string): string {
	return markdown
		.replace(/\r\n?/g, "\n")
		.replace(LONE_SURROGATE, "\uFFFD")
		.normalize("NFC");
}

/** Characters with a meaning in a key: the path and index separators, `@`. */
const KEY_RESERVED = /[%/#@]/g;

function escapeAnchor(anchor: string): string {
	return anchor.replace(
		KEY_RESERVED,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function startLineOf(node: RootContent): number {
	return node.position?.start.line ?? 1;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * The one boundary mark between blocks, list items, cells and hard breaks.
 * A control character, removed from text first, so text cannot spell it.
 */
const SEPARATOR = "\u001e";

/** A separator with the spaces either side of it. */
const PADDED_SEPARATOR = new RegExp(` ?${SEPARATOR} ?`, "g");

/** Two or more separators in a row. */
const SEPARATOR_RUN = new RegExp(`${SEPARATOR}{2,}`, "g");

/** Separators and spaces at either end. */
const SEPARATOR_EDGES = new RegExp(`^[${SEPARATOR} ]+|[${SEPARATOR} ]+$`, "g");

/** Control characters other than whitespace, the separator among them. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f]/g;

/** Marker characters that never count, parsed or literal. */
const MARKERS = /[*_~]/g;

/**
 * Fence languages the editor renders as a mermaid diagram and saves as
 * ```` ```mermaid ````: `MERMAID_LANGUAGES` in
 * apps/web/modules/saas/projects/lib/tiptap-mermaid-extension.tsx. Keep in
 * step with it.
 */
export const DIAGRAM_LANGUAGES: ReadonlySet<string> = new Set([
	"mermaid",
	"c4context",
	"c4container",
	"c4component",
	"c4deployment",
	"c4dynamic",
	"flowchart",
	"sequencediagram",
	"sequence",
	"classdiagram",
	"statediagram",
	"erdiagram",
	"gantt",
	"pie",
	"mindmap",
	"timeline",
]);

/**
 * First-line prefixes that make the same editor read a fence of any other
 * language as a diagram (its `diagramKeywords`). Keep in step with it.
 */
export const DIAGRAM_KEYWORDS: readonly string[] = [
	"c4context",
	"c4container",
	"c4component",
	"c4deployment",
	"c4dynamic",
	"flowchart",
	"graph",
	"sequencediagram",
	"classdiagram",
	"statediagram",
	"statediagram-v2",
	"erdiagram",
	"gantt",
	"pie",
	"mindmap",
	"timeline",
	"gitgraph",
	"journey",
	"quadrantchart",
	"sankey",
	"xychart",
	"block",
];

/** The fence language whose body is always content. */
const STAT_TILES_LANGUAGE = "stat-tiles";

/** A generated visual's id line inside its fence. */
const VISUAL_MARKER_LINE = /^\s*%%\s*fabric-visual\b/;

/** An HTML comment, a declaration, or a processing instruction. */
const HTML_NON_ELEMENT =
	/<!--[\s\S]*?(?:-->|$)|<![^>]*>?|<\?[\s\S]*?(?:\?>|$)/g;

/**
 * An opening or closing tag, quoted attribute values allowed to hold `>`.
 * Global: only ever used through `replace`, which resets `lastIndex`.
 */
const HTML_TAG =
	/<\/?([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;

/** An `alt` attribute's value, in any quoting. */
const ALT_ATTRIBUTE = /\salt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

/** Tags that end a line of text when the editor loads them. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"br",
	"dd",
	"details",
	"div",
	"dl",
	"dt",
	"figcaption",
	"figure",
	"footer",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"li",
	"main",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"summary",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"ul",
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: "\u00a0",
	quot: '"',
};

/** The projection of `nodes`, finished: see the module comment. */
function projectBlocks(nodes: readonly RootContent[]): string {
	const parts: string[] = [];
	for (const node of nodes) {
		projectNode(node, parts);
	}
	return parts
		.join("")
		.normalize("NFC")
		.replace(/\s+/g, " ")
		.replace(PADDED_SEPARATOR, SEPARATOR)
		.replace(SEPARATOR_RUN, SEPARATOR)
		.replace(SEPARATOR_EDGES, "");
}

function projectNode(node: Nodes, parts: string[]): void {
	switch (node.type) {
		case "text":
			parts.push(proseText(node.value));
			return;
		case "inlineCode":
			parts.push(plainText(node.value));
			return;
		case "break":
		case "thematicBreak":
			parts.push(SEPARATOR);
			return;
		case "image":
		case "imageReference":
			parts.push(SEPARATOR, proseText(node.alt ?? ""), SEPARATOR);
			return;
		case "html":
			projectHtml(node.value, parts);
			return;
		case "code":
			parts.push(SEPARATOR, codeText(node), SEPARATOR);
			return;
		case "definition":
		case "footnoteReference":
		case "yaml":
			return;
	}
	if (!("children" in node)) {
		return;
	}
	const block = !isPhrasing(node);
	if (block) {
		parts.push(SEPARATOR);
	}
	let children: readonly Nodes[] = node.children;
	if (node.type === "listItem" && typeof node.checked === "boolean") {
		// The box joins the item's first line, as it reads once saved.
		parts.push(node.checked ? "[x] " : "[ ] ");
		const [first, ...rest] = node.children;
		if (first?.type === "paragraph") {
			children = [...first.children, ...rest];
		}
	}
	for (const child of children) {
		projectNode(child, parts);
	}
	if (block) {
		parts.push(SEPARATOR);
	}
}

/** Inline containers: their text runs on without a boundary. */
function isPhrasing(node: Nodes): node is PhrasingContent {
	return (
		node.type === "emphasis" ||
		node.type === "strong" ||
		node.type === "delete" ||
		node.type === "link" ||
		node.type === "linkReference"
	);
}

/**
 * A fence's counted text: nothing for a diagram, the body without its
 * `%% fabric-visual` line otherwise.
 */
function codeText(node: Code): string {
	if (isDiagramFence(node.lang, node.value)) {
		return "";
	}
	return plainText(
		node.value
			.split("\n")
			.filter((line) => !VISUAL_MARKER_LINE.test(line))
			.join("\n"),
	);
}

/**
 * The editor's own test for a diagram fence, so a save cannot flip it and
 * an export draws exactly the fences the page draws. A stat tiles fence is
 * never a diagram, whatever its first line holds.
 */
export function isDiagramFence(
	lang: string | null | undefined,
	body: string,
): boolean {
	const language = (lang ?? "").toLowerCase();
	if (language === STAT_TILES_LANGUAGE) {
		return false;
	}
	if (DIAGRAM_LANGUAGES.has(language)) {
		return true;
	}
	const firstLine = body.trim().split("\n")[0].toLowerCase();
	return DIAGRAM_KEYWORDS.some((keyword) => firstLine.startsWith(keyword));
}

/**
 * Raw HTML by its text: see the module comment. Entities are decoded before
 * tags are read, as the editor's load does: an escaped tag comes back from a
 * save as a real one.
 */
function projectHtml(value: string, parts: string[]): void {
	const text = decodeEntities(value.replace(HTML_NON_ELEMENT, ""))
		.replace(CONTROL, "")
		.replace(HTML_TAG, (_tag, name: string, attributes: string) => {
			const tagName = name.toLowerCase();
			if (tagName === "img") {
				const alt = attributes.match(ALT_ATTRIBUTE);
				const altText = alt ? (alt[1] ?? alt[2] ?? alt[3] ?? "") : "";
				return `${SEPARATOR}${altText}${SEPARATOR}`;
			}
			return BLOCK_TAGS.has(tagName) ? SEPARATOR : "";
		});
	parts.push(text.replace(MARKERS, ""));
}

function decodeEntities(text: string): string {
	return text.replace(
		/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g,
		(entity, decimal?: string, hex?: string, name?: string) => {
			if (name !== undefined) {
				return NAMED_ENTITIES[name] ?? entity;
			}
			const code =
				decimal !== undefined
					? Number(decimal)
					: Number.parseInt(hex ?? "", 16);
			return code > 0 &&
				code <= 0x10ffff &&
				(code < 0xd800 || code > 0xdfff)
				? String.fromCodePoint(code)
				: "\uFFFD";
		},
	);
}

/** Text that counts as written: no control characters. */
function plainText(value: string): string {
	return value.replace(CONTROL, "");
}

/** Prose text: no control characters and no marker characters. */
function proseText(value: string): string {
	return plainText(value).replace(MARKERS, "");
}

/** Heading text as read: text, code and alt; tags dropped; breaks as spaces. */
function inlineText(nodes: readonly PhrasingContent[]): string {
	let text = "";
	for (const node of nodes) {
		if (node.type === "text" || node.type === "inlineCode") {
			text += node.value;
		} else if (node.type === "image" || node.type === "imageReference") {
			text += node.alt ?? "";
		} else if (node.type === "break") {
			text += " ";
		} else if (node.type === "html") {
			text += decodeEntities(
				node.value.replace(HTML_NON_ELEMENT, ""),
			).replace(HTML_TAG, "");
		} else if ("children" in node) {
			text += inlineText(node.children);
		}
	}
	return text;
}

function collapse(text: string): string {
	return text
		.replace(CONTROL, "")
		.normalize("NFC")
		.replace(/\s+/g, " ")
		.trim();
}

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

/** `p1:` + sixteen hex characters: two independent 32-bit halves. */
function hashProjection(projection: string): string {
	return `${VERSION_PREFIX}${fnv1aHex64(projection)}`;
}
