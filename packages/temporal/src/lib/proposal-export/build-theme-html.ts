/**
 * The Proposal's print page (Fizzy #2946): one self-contained HTML document
 * a Chromium prints to the PDF, styled only by the shared Proposal theme so
 * the PDF reads like the live Main page.
 *
 * Self-contained means it loads nothing. There is no script, no `<link>` and
 * no external URL: every image is a `data:` URL of bytes the export already
 * re-encoded, the only fonts are the embedded Poppins, Inter and JetBrains
 * Mono, and an `http(s):` URL can appear only as the `href` of a link the
 * reader may follow, or as visible text. The browser that prints it also
 * blocks every request, so this is the second wall, not the only one.
 *
 * Main is untrusted text. Every piece of it reaches the page escaped
 * (`& < > " '`), through a fixed mapping of the Markdown tree onto the
 * theme's vocabulary. Raw HTML is never parsed: an uploaded image tag
 * becomes a figure of the bytes read for it, `<br>` stays a line break, a
 * comment is left out as the live page leaves it out, and everything else
 * prints as its own escaped source text. It is never cut apart, so nothing
 * removed from it can splice what is left into a tag (see
 * `docs/solutions/security-issues/a-sanitizer-that-deletes-can-reassemble-what-it-removed.md`).
 *
 * Chromium has no `target-counter()`, so the contents page gets its page
 * numbers from two passes over the same page. The `locate` pass puts a text
 * marker ({@link pageMarkerText}) in every section opener and leaves every
 * page-number slot empty; whoever prints it finds the page each marker lands
 * on. The `final` pass writes those numbers into the slots and leaves the
 * markers out. A marker is laid out of flow and a slot has a fixed width, so
 * both passes break pages identically.
 */

import {
	PROPOSAL_PRINT_CLASSES,
	PROPOSAL_THEME_ATTRIBUTE,
	PROPOSAL_THEME_CLASSES,
	proposalThemeCss,
} from "@repo/utils/proposal-artifact/proposal-theme";
import {
	parseStatTiles,
	STAT_TILES_LANGUAGE,
} from "@repo/utils/proposal-artifact/stat-tiles";
import {
	resolveThemePaint,
	themeCustomProperties,
} from "@repo/utils/proposal-artifact/theme-tokens";
import type {
	Code,
	Definition,
	Emphasis,
	FootnoteDefinition,
	Html,
	List,
	ListItem,
	Nodes,
	Paragraph,
	PhrasingContent,
	Table,
} from "mdast";
import {
	bodyStyle,
	type CoverContent,
	contentsHtml,
	coverHtml,
	coverPreamble,
	hasHeroImage,
} from "./build-cover-html";
import {
	isDocumentMediaKey,
	isWideTable,
	rawHtmlFallback,
	readUploadedImageTag,
	safeLinkHref,
	type UploadedImageTag,
} from "./document-content";
import { exportFailure } from "./failures";
import { PRINT_FONTS, printFontFaceCss, printTokensOf } from "./fonts";
import {
	eachNode,
	exportDiagramCaption,
	flatText,
	type PreparedExportMarkdown,
} from "./markdown";
import {
	dataUrl,
	escapeHtml,
	isImageParagraph,
	plainText,
	present,
} from "./print-markup";
import {
	diagramFigureNumbers,
	type ExportDiagram,
	type ExportDocumentImages,
	type ExportRaster,
	type ExportThemeTokens,
	type ProposalExportWarning,
	type ProposalExportWarningCode,
} from "./types";
import { ExportWarningTally } from "./warnings";

/** One root-level H2 of Main: a section opener and a contents entry. */
export interface ExportSection {
	/** 1-based, in document order. */
	index: number;
	/** The opener's element id, `pa-section-${index}`. */
	id: string;
	/** The heading's plain text. */
	title: string;
}

/**
 * Which of the two print passes the page is for. `locate` carries the page
 * markers and empty page-number slots; `final` carries each section's page
 * number, or no slots at all when `pageNumbers` is null (the locate pass
 * could not place them).
 */
export type ThemeHtmlPass =
	| { kind: "locate" }
	| {
			kind: "final";
			/** A section's 1-based page by its 1-based index. */
			pageNumbers: ReadonlyMap<number, number> | null;
	  };

export interface BuildThemeHtmlInput {
	prepared: PreparedExportMarkdown;
	/** One per `prepared.diagramSources` entry, in the same order. */
	diagrams: readonly ExportDiagram[];
	/** The uploaded images read for this document, by storage key. */
	images: ExportDocumentImages;
	tokens: ExportThemeTokens;
	projectId: string;
	documentId: string;
	/** The document's title, plain text. */
	title: string;
	/** The cover's date, already formatted by the caller. */
	dateLabel: string;
	pass: ThemeHtmlPass;
}

export interface BuildThemeHtmlResult {
	html: string;
	sections: ExportSection[];
	/**
	 * What the body left out, the same for both passes of one input: keep one
	 * pass's. Missing page numbers are the print step's to report, since only
	 * it knows whether the locate pass placed them.
	 */
	warnings: ProposalExportWarning[];
}

/**
 * Matches every page marker of a `locate` pass, capturing the section's
 * 1-based index. Global: use it with `matchAll` or `replace`, which do not
 * share its `lastIndex`.
 */
export const PAGE_MARKER_PATTERN = /PAEXPORTH2N(\d{1,6})E/g;

/**
 * The marker text of section `index`: letters and digits only, so a PDF's
 * text layer keeps it whole, and closed by a letter, so a digit printed
 * right after it cannot extend the number.
 */
export function pageMarkerText(index: number): string {
	if (!Number.isSafeInteger(index) || index < 1) {
		throw new RangeError("A section index is a positive integer.");
	}
	return `PAEXPORTH2N${index}E`;
}

const THEME = PROPOSAL_THEME_CLASSES;
const PRINT = PROPOSAL_PRINT_CLASSES;

/**
 * How deep the walk follows the tree's markup. Real documents nest a few
 * levels; past this, a subtree prints as its plain text instead of
 * overflowing the stack.
 */
const MAX_RENDER_DEPTH = 64;

/**
 * The most image data, in base64 characters, the body embeds across every
 * placement: the export's 40 MB image budget once over, with room to spare.
 * Each image is already within the encoded cap Chromium draws a `data:` URL
 * under (`fit-export-image.ts`).
 */
export const MAX_EMBEDDED_IMAGE_CHARS = 80 * 1024 * 1024;

/** The only content a cell's alignment may write. */
const CELL_ALIGN: Readonly<Record<string, string>> = {
	left: ' style="text-align: left"',
	center: ' style="text-align: center"',
	right: ' style="text-align: right"',
};

/** A fence language worth naming in a class: nothing that can leave it. */
const CODE_LANGUAGE = /^[A-Za-z0-9_+-]{1,40}$/;

/** An uploaded image's width, as `readUploadedImageTag` constrains it. */
const IMAGE_WIDTH = /^(?:\d{1,4}px|\d{1,3}%)$/;

/**
 * The longest paragraph, in characters, a section opener takes as its
 * subtitle; a longer one stays in the body.
 */
const SUBTITLE_MAX_CHARACTERS = 200;

/**
 * A first-column cell that reads as an id, such as "FS-01": short, one word
 * and with a digit, so a column of plain words ("Discovery", "Pro") is not.
 */
const SHORT_ID = /^(?=[\p{L}\p{N}-]*\p{N})[\p{L}\p{N}-]{1,12}$/u;

/** The children that are more than whitespace. */
function meaningfulChildren(
	children: readonly PhrasingContent[],
): PhrasingContent[] {
	return children.filter(
		(child) => !(child.type === "text" && child.value.trim() === ""),
	);
}

/**
 * The emphasis a paragraph right after a section heading is made of, when
 * it is nothing else and short enough to be the opener's subtitle.
 */
function subtitleOf(node: Nodes | undefined): Emphasis | null {
	if (node?.type !== "paragraph") {
		return null;
	}
	const [only, ...rest] = meaningfulChildren(node.children);
	if (only?.type !== "emphasis" || rest.length > 0) {
		return null;
	}
	const text = plainText(only);
	return text !== "" &&
		Array.from(text).length <= SUBTITLE_MAX_CHARACTERS &&
		!isImageParagraph(node)
		? only
		: null;
}

/** Whether every body cell of the first column reads as a short id. */
function hasIdColumn(node: Table): boolean {
	const rows = node.children.slice(1);
	return (
		rows.length > 0 &&
		rows.every((row) => {
			const cell = row.children[0];
			return cell !== undefined && SHORT_ID.test(plainText(cell));
		})
	);
}

/** Whether every item of an ordered list opens with bold text. */
function isStepList(node: List): boolean {
	return (
		node.ordered === true &&
		node.children.length > 0 &&
		node.children.every((item) => {
			const first = item.children[0];
			return (
				first?.type === "paragraph" &&
				meaningfulChildren(first.children)[0]?.type === "strong"
			);
		})
	);
}

/** The tree walk, with what it collects on the way. */
class BodyRenderer {
	readonly sections: ExportSection[] = [];
	/** How deep the walk is in the tree right now. */
	private depth = 0;
	private readonly tally = new ExportWarningTally();
	/** Characters of image data the body has embedded so far. */
	private embeddedImageChars = 0;
	private readonly definitions = new Map<string, Definition>();
	private readonly footnoteDefinitions = new Map<
		string,
		FootnoteDefinition
	>();
	/** Footnote identifiers in the order they are first referenced. */
	private readonly footnoteOrder: string[] = [];
	private readonly preamble: ReturnType<typeof coverPreamble>;
	/** Main's nodes the cover took, which the body leaves out. */
	private readonly lifted = new Set<Nodes>();
	/** Each diagram's "Figure n." number, as the Word file numbers it. */
	private readonly figureNumbers: readonly (number | null)[];

	constructor(private readonly input: BuildThemeHtmlInput) {
		this.collectDefinitions(input.prepared.root);
		this.figureNumbers = diagramFigureNumbers(input.diagrams);
		this.preamble = coverPreamble(input.prepared.root);
		if (this.preamble.lead) {
			this.lifted.add(this.preamble.lead);
		}
		if (this.preamble.figures) {
			this.lifted.add(this.preamble.figures.node);
		}
	}

	/**
	 * The cover's lead and key figures. Called before {@link body}, so a
	 * footnote the lead references keeps its place in the numbering.
	 */
	cover(): CoverContent {
		const lead = this.preamble.lead
			? this.phrasing(this.preamble.lead.children)
			: null;
		return {
			lead: lead === null || lead.trim() === "" ? null : lead,
			figures: this.preamble.figures?.items ?? [],
		};
	}

	count(code: ProposalExportWarningCode, by = 1): void {
		this.tally.add(code, by);
	}

	warnings(): ProposalExportWarning[] {
		return this.tally.warnings();
	}

	/**
	 * Main's body: every root-level H2 opens a section, and takes a short
	 * emphasised paragraph right after it as the opener's subtitle. A
	 * section whose first block is a table too wide for portrait opens on
	 * that table's landscape page, so its opener is not left alone at the
	 * foot of the page before it.
	 */
	body(): string {
		const parts: string[] = [];
		const children = this.input.prepared.root.children;
		for (let index = 0; index < children.length; index++) {
			const node = children[index];
			if (node?.type === "heading" && node.depth === 2) {
				const subtitle = subtitleOf(children[index + 1]);
				if (subtitle) {
					index++;
				}
				const opener = this.sectionOpener(
					node.children,
					plainText(node),
					subtitle,
				);
				const next = children[index + 1];
				if (next?.type === "table" && isWideTable(next)) {
					parts.push(
						`<section class="${PRINT.landscape}">${opener}${this.tableMarkup(next)}</section>`,
					);
					index++;
				} else {
					parts.push(opener);
				}
			} else if (node && !this.lifted.has(node)) {
				parts.push(this.flow(node));
			}
		}
		parts.push(this.footnotes());
		return parts.join("");
	}

	private collectDefinitions(root: Nodes): void {
		// The first definition of a label wins, as CommonMark reads it.
		eachNode(root, (node) => {
			if (
				node.type === "definition" &&
				!this.definitions.has(node.identifier)
			) {
				this.definitions.set(node.identifier, node);
			} else if (
				node.type === "footnoteDefinition" &&
				!this.footnoteDefinitions.has(node.identifier)
			) {
				this.footnoteDefinitions.set(node.identifier, node);
			}
		});
	}

	private sectionOpener(
		children: readonly PhrasingContent[],
		title: string,
		subtitle: Emphasis | null,
	): string {
		const index = this.sections.length + 1;
		const id = `pa-section-${index}`;
		this.sections.push({ index, id, title });
		// The hero itself is the body's `--pa-hero-image`.
		const graphic = hasHeroImage(this.input.tokens)
			? `<div class="${PRINT.sectionGraphic}" aria-hidden="true"></div>`
			: "";
		const marker =
			this.input.pass.kind === "locate"
				? `<span class="${PRINT.pageMarker}" aria-hidden="true">${pageMarkerText(index)}</span>`
				: "";
		const lead = subtitle
			? `<p>${this.phrasing(subtitle.children)}</p>`
			: "";
		return `<header class="${THEME.sectionOpener}" id="${id}">${graphic}${marker}<h2>${this.phrasing(children)}</h2>${lead}</header>`;
	}

	/**
	 * Block content. Below {@link MAX_RENDER_DEPTH} the subtree prints as its
	 * plain text, so no nesting, however deep, exhausts the stack.
	 */
	private flow(node: Nodes): string {
		if (this.depth >= MAX_RENDER_DEPTH) {
			const text = flatText(node);
			return text.trim() === "" ? "" : `<p>${escapeHtml(text)}</p>`;
		}
		this.depth++;
		try {
			return this.flowNode(node);
		} finally {
			this.depth--;
		}
	}

	private flowNode(node: Nodes): string {
		switch (node.type) {
			case "heading":
				return `<h${node.depth}>${this.phrasing(node.children)}</h${node.depth}>`;
			case "paragraph": {
				const content = this.paragraphContent(node);
				if ("figure" in content) {
					return content.figure;
				}
				// A paragraph left with nothing (a dropped Markdown image) adds
				// no empty space.
				return content.inline.trim() === ""
					? ""
					: `<p>${content.inline}</p>`;
			}
			case "blockquote":
				return `<blockquote class="${THEME.callout}">${this.flowChildren(node.children)}</blockquote>`;
			case "list":
				return this.list(node);
			case "code":
				return this.code(node);
			case "table":
				return this.table(node);
			case "thematicBreak":
				return "<hr>";
			case "html":
				return this.blockHtml(node);
			// Read where they are referenced, never printed in place.
			case "definition":
			case "footnoteDefinition":
				return "";
			default:
				// A phrasing node where a block was expected still prints, as
				// a paragraph of its own.
				return `<p>${this.inline(node)}</p>`;
		}
	}

	private flowChildren(children: readonly Nodes[]): string {
		return children.map((child) => this.flow(child)).join("");
	}

	/**
	 * A paragraph's content: a figure when it holds only an uploaded image,
	 * otherwise its inline HTML.
	 */
	private paragraphContent(
		node: Paragraph,
	): { figure: string } | { inline: string } {
		const meaningful = node.children.filter(
			(child) => !(child.type === "text" && child.value.trim() === ""),
		);
		const only = meaningful.length === 1 ? meaningful[0] : undefined;
		if (only?.type === "html") {
			const upload = this.upload(only);
			if (upload) {
				return { figure: this.figure(upload.tag, upload.image) };
			}
		}
		return { inline: this.phrasing(node.children) };
	}

	private list(node: List): string {
		// A tight list prints its paragraphs bare, as the page does.
		const loose =
			node.spread === true ||
			node.children.some((item) =>
				item.spread === null || item.spread === undefined
					? item.children.length > 1
					: item.spread,
			);
		const tasks = node.children.some(
			(item) => typeof item.checked === "boolean",
		);
		const listClass = tasks
			? ' class="contains-task-list"'
			: isStepList(node)
				? ` class="${THEME.steps}"`
				: "";
		const items = node.children
			.map((item) => this.listItem(item, loose))
			.join("");
		if (node.ordered) {
			const start =
				typeof node.start === "number" &&
				Number.isSafeInteger(node.start) &&
				node.start !== 1
					? ` start="${node.start}"`
					: "";
			return `<ol${start}${listClass}>${items}</ol>`;
		}
		return `<ul${listClass}>${items}</ul>`;
	}

	private listItem(item: ListItem, loose: boolean): string {
		let checkbox =
			typeof item.checked === "boolean"
				? `<input type="checkbox" disabled${item.checked ? " checked" : ""}> `
				: "";
		const parts = item.children.map((child) => {
			if (child.type !== "paragraph") {
				return this.flow(child);
			}
			const content = this.paragraphContent(child);
			if ("figure" in content) {
				return content.figure;
			}
			// The checkbox sits in the item's first paragraph, beside its text.
			const text = checkbox + content.inline;
			checkbox = "";
			return loose ? `<p>${text}</p>` : text;
		});
		return `<li>${checkbox}${parts.join("")}</li>`;
	}

	private code(node: Code): string {
		const diagramIndex = this.input.prepared.diagramIndex.get(node);
		if (diagramIndex !== undefined) {
			return this.diagram(diagramIndex, exportDiagramCaption(node.value));
		}
		if (node.lang === STAT_TILES_LANGUAGE) {
			const parsed = parseStatTiles(node.value);
			// A refused block prints as code, as the page shows it.
			if (parsed.ok) {
				const tiles = parsed.items
					.map(
						(item) =>
							`<div class="${THEME.statTile}"><dt class="${THEME.statLabel}">${escapeHtml(item.label)}</dt><dd class="${THEME.statValue}">${escapeHtml(item.value)}</dd></div>`,
					)
					.join("");
				return `<dl class="${THEME.statTiles}">${tiles}</dl>`;
			}
		}
		const language =
			node.lang && CODE_LANGUAGE.test(node.lang)
				? ` class="language-${node.lang}"`
				: "";
		return `<pre><code${language}>${escapeHtml(node.value)}</code></pre>`;
	}

	/**
	 * A diagram's figure, captioned "Figure n." and the fence's
	 * `%% caption:` line as plain text, or nothing for one left out.
	 */
	private diagram(index: number, caption: string | null): string {
		const diagram = this.input.diagrams[index];
		if (!diagram) {
			// The diagram step returned nothing for it: left out, as a
			// diagram that failed to draw is.
			this.count("DIAGRAM_PLACEHOLDER");
			return "";
		}
		if (diagram.kind === "omitted") {
			return "";
		}
		const number = this.figureNumbers[index] ?? null;
		const label =
			number === null
				? ""
				: `<span class="${PRINT.figureNumber}">Figure ${number}.</span>`;
		const text = caption ? escapeHtml(caption) : "";
		const figcaption =
			label || text
				? `<figcaption class="${THEME.caption}">${label}${label && text ? " " : ""}${text}</figcaption>`
				: "";
		if (diagram.kind === "svg") {
			// Allowlisted by the diagram step, which owns its safety.
			return `<figure class="${THEME.figure} ${PRINT.diagram}">${diagram.svg}${figcaption}</figure>`;
		}
		return `<figure class="${THEME.figure} ${PRINT.diagramPlaceholder}"><p class="${THEME.caption}">${escapeHtml(diagram.caption)}</p>${figcaption}</figure>`;
	}

	private table(node: Table): string {
		const table = this.tableMarkup(node);
		return isWideTable(node)
			? `<section class="${PRINT.landscape}">${table}</section>`
			: table;
	}

	private tableMarkup(node: Table): string {
		const [head, ...rows] = node.children;
		const cells = (
			tag: "th" | "td",
			row: (typeof node.children)[number],
		): string =>
			row.children
				.map((cell, index) => {
					const align = node.align?.[index];
					const style = align ? (CELL_ALIGN[align] ?? "") : "";
					return `<${tag}${style}>${this.phrasing(cell.children)}</${tag}>`;
				})
				.join("");
		const thead = head
			? `<thead><tr>${cells("th", head)}</tr></thead>`
			: "";
		const tbody =
			rows.length > 0
				? `<tbody>${rows.map((row) => `<tr>${cells("td", row)}</tr>`).join("")}</tbody>`
				: "";
		const ids = hasIdColumn(node) ? ` ${THEME.idColumn}` : "";
		return `<table class="${THEME.dataTable}${ids}">${thead}${tbody}</table>`;
	}

	/** Raw HTML where a block stands. */
	private blockHtml(node: Html): string {
		const upload = this.upload(node);
		if (upload) {
			return this.figure(upload.tag, upload.image);
		}
		const fallback = this.htmlFallback(node);
		return fallback === "<br>" || fallback === ""
			? fallback
			: `<p>${fallback}</p>`;
	}

	/** Raw HTML inside a line. */
	private inlineHtml(node: Html): string {
		const upload = this.upload(node);
		if (upload) {
			return upload.image ? this.image(upload.tag, upload.image) : "";
		}
		return this.htmlFallback(node);
	}

	/**
	 * Raw HTML that is not an uploaded image: a line break, nothing, or its
	 * text escaped. A refused upload's source holds its storage key and a
	 * signed URL, so it is never printed.
	 */
	private htmlFallback(node: Html): string {
		const fallback = rawHtmlFallback(node.value);
		switch (fallback.kind) {
			case "break":
				return "<br>";
			case "omit":
				return "";
			case "external-image":
				this.count("EXTERNAL_IMAGE_DROPPED");
				return "";
			case "text":
				return escapeHtml(fallback.text);
		}
	}

	/**
	 * The uploaded image an `html` node is, with its bytes when this
	 * document's own media holds them, or null when it is any other HTML.
	 * An accepted tag without bytes prints nothing: the image reader already
	 * counted why.
	 */
	private upload(
		node: Html,
	): { tag: UploadedImageTag; image: ExportRaster | null } | null {
		const tag = readUploadedImageTag(node.value);
		if (!tag) {
			return null;
		}
		const owned = isDocumentMediaKey(
			tag.key,
			this.input.projectId,
			this.input.documentId,
		);
		return {
			tag,
			image: owned ? (this.input.images.get(tag.key) ?? null) : null,
		};
	}

	private image(tag: UploadedImageTag, raster: ExportRaster): string {
		const src = dataUrl(raster);
		if (src === null) {
			return "";
		}
		// Every placement embeds the bytes again (the page loads nothing), so
		// one image placed hundreds of times could outgrow what a page holds.
		if (this.embeddedImageChars + src.length > MAX_EMBEDDED_IMAGE_CHARS) {
			this.count("IMAGE_LIMIT");
			return "";
		}
		this.embeddedImageChars += src.length;
		const width =
			tag.width && IMAGE_WIDTH.test(tag.width)
				? ` style="width: ${tag.width}"`
				: "";
		return `<img src="${escapeHtml(src)}" alt="${escapeHtml(tag.alt)}"${width}>`;
	}

	private figure(tag: UploadedImageTag, raster: ExportRaster | null): string {
		const image = raster ? this.image(tag, raster) : "";
		if (image === "") {
			return "";
		}
		const caption = tag.caption
			? `<figcaption class="${THEME.caption}">${escapeHtml(tag.caption)}</figcaption>`
			: "";
		return `<figure class="${THEME.figure}">${image}${caption}</figure>`;
	}

	private phrasing(children: readonly PhrasingContent[]): string {
		return children.map((child) => this.inline(child)).join("");
	}

	/** Inline content, flattened to text below {@link MAX_RENDER_DEPTH}. */
	private inline(node: Nodes): string {
		if (this.depth >= MAX_RENDER_DEPTH) {
			return escapeHtml(flatText(node));
		}
		this.depth++;
		try {
			return this.inlineNode(node);
		} finally {
			this.depth--;
		}
	}

	private inlineNode(node: Nodes): string {
		switch (node.type) {
			case "text":
				return escapeHtml(node.value);
			case "emphasis":
				return `<em>${this.phrasing(node.children)}</em>`;
			case "strong":
				return `<strong>${this.phrasing(node.children)}</strong>`;
			case "delete":
				return `<del>${this.phrasing(node.children)}</del>`;
			case "inlineCode":
				return `<code>${escapeHtml(node.value)}</code>`;
			case "break":
				return "<br>";
			case "link":
				return this.link(node.url, node.children);
			case "linkReference": {
				const definition = this.definitions.get(node.identifier);
				return definition
					? this.link(definition.url, node.children)
					: this.phrasing(node.children);
			}
			case "image":
			case "imageReference":
				// A Markdown image names a URL, never a stored upload, and the
				// export fetches nothing by URL.
				this.count("EXTERNAL_IMAGE_DROPPED");
				return "";
			case "html":
				return this.inlineHtml(node);
			case "footnoteReference":
				return this.footnoteReference(node.identifier, node.label);
			default:
				if ("children" in node) {
					return node.children
						.map((child) => this.inline(child))
						.join("");
				}
				return "value" in node && typeof node.value === "string"
					? escapeHtml(node.value)
					: "";
		}
	}

	/** A link keeps its href only when it is one the export allows. */
	private link(url: string, children: readonly PhrasingContent[]): string {
		const content = this.phrasing(children);
		const href = safeLinkHref(url);
		return href === null
			? content
			: `<a href="${escapeHtml(href)}">${content}</a>`;
	}

	/**
	 * A footnote call, numbered by first reference. Ids are numbers only, so
	 * no label a reader wrote ever reaches an attribute.
	 */
	private footnoteReference(
		identifier: string,
		label?: string | null,
	): string {
		if (!this.footnoteDefinitions.has(identifier)) {
			return escapeHtml(`[^${label ?? identifier}]`);
		}
		let number = this.footnoteOrder.indexOf(identifier) + 1;
		if (number === 0) {
			this.footnoteOrder.push(identifier);
			number = this.footnoteOrder.length;
		}
		return `<sup><a href="#pa-fn-${number}">${number}</a></sup>`;
	}

	/**
	 * The referenced footnotes, in reference order, at the end of the body.
	 * A note may reference another; the list grows while it is printed and
	 * holds each identifier once, so it ends.
	 */
	private footnotes(): string {
		const items: string[] = [];
		for (let index = 0; index < this.footnoteOrder.length; index++) {
			const identifier = this.footnoteOrder[index] as string;
			const definition = this.footnoteDefinitions.get(identifier);
			items.push(
				`<li id="pa-fn-${index + 1}">${definition ? this.flowChildren(definition.children) : ""}</li>`,
			);
		}
		return items.length > 0
			? `<section class="${PRINT.footnotes}" aria-label="Footnotes"><hr><ol>${items.join("")}</ol></section>`
			: "";
	}
}

/** Longest document title the footer shows, in characters. */
const FOOTER_TITLE_LIMIT = 60;

/**
 * The title as the footer shows it: cut at a word to
 * {@link FOOTER_TITLE_LIMIT} characters with an ellipsis, so the footer
 * stays on one line beside the page counter.
 */
function footerTitle(title: string): string {
	const characters = Array.from(title);
	if (characters.length <= FOOTER_TITLE_LIMIT) {
		return title;
	}
	const cut = characters.slice(0, FOOTER_TITLE_LIMIT - 1).join("");
	const atWord = cut.replace(/\s+\S*$/u, "");
	return `${(atWord.length > 0 ? atWord : cut).trimEnd()}…`;
}

/** A stylesheet for a `<style>` element, which nothing in it may close. */
function styleElement(css: string): string {
	if (/<\/style/i.test(css)) {
		throw exportFailure("EXPORT_FAILED");
	}
	return `<style>${css}</style>`;
}

/**
 * The print page of one pass. Sections and warnings are the same for both
 * passes of one input.
 */
export function buildThemeHtml(
	input: BuildThemeHtmlInput,
): BuildThemeHtmlResult {
	const renderer = new BodyRenderer(input);
	// The cover's lead before the body, as a reader meets them; the body
	// before the contents page, which lists the sections it found.
	const cover = renderer.cover();
	const body = renderer.body();
	const sections = renderer.sections;

	const title = input.title.trim();
	const proposer = present(input.tokens.proposer.name.value);
	const runningFooter = [
		proposer,
		present(footerTitle(title)),
		present(input.dateLabel),
		"Confidential",
	]
		.filter((part): part is string => part !== null)
		.join(" · ");

	// Margin boxes inherit from the root element, not from the body, so the
	// custom properties sit on <html>. The veil is as dense as the measured
	// hero needs.
	const properties = Object.entries(
		themeCustomProperties(
			resolveThemePaint(printTokensOf(input.tokens), {
				heroLuminance: input.tokens.proposer.hero.value?.luminance,
			}),
		),
	)
		.map(([name, value]) => `${name}: ${value}`)
		.join("; ");

	const html = [
		"<!doctype html>",
		`<html lang="en" style="${escapeHtml(properties)}">`,
		"<head>",
		'<meta charset="utf-8">',
		`<title>${escapeHtml(title)}</title>`,
		styleElement(printFontFaceCss()),
		styleElement(
			proposalThemeCss("print", {
				runningFooter,
				fontFamily: PRINT_FONTS.body,
			}),
		),
		"</head>",
		`<body ${PROPOSAL_THEME_ATTRIBUTE}="print"${bodyStyle(input.tokens)}>`,
		coverHtml(input, cover),
		contentsHtml(sections, input.pass, title),
		body,
		"</body>",
		"</html>",
	].join("\n");

	return { html, sections, warnings: renderer.warnings() };
}
