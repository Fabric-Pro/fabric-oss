/**
 * The Proposal's print page (Fizzy #2946): one self-contained HTML document
 * a Chromium prints to the PDF, styled only by the shared Proposal theme so
 * the PDF reads like the live Main page.
 *
 * Self-contained means it loads nothing. There is no script, no `<link>` and
 * no external URL: every image is a `data:` URL of bytes the export already
 * re-encoded, the only font is the embedded Inter, and an `http(s):` URL can
 * appear only as the `href` of a link the reader may follow, or as visible
 * text. The browser that prints it also blocks every request, so this is the
 * second wall, not the only one.
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
	isDocumentMediaKey,
	isWideTable,
	rawHtmlFallback,
	readUploadedImageTag,
	safeLinkHref,
	type UploadedImageTag,
} from "./document-content";
import { exportFailure } from "./failures";
import { interFontFaceCss, PRINT_FONT_FAMILY, printTokensOf } from "./fonts";
import {
	eachNode,
	exportDiagramCaption,
	flatText,
	type PreparedExportMarkdown,
} from "./markdown";
import type {
	ExportDiagram,
	ExportDocumentImages,
	ExportRaster,
	ExportThemeTokens,
	ProposalExportWarning,
	ProposalExportWarningCode,
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

/** The caption of a diagram the diagram step returned nothing for. */
const MISSING_DIAGRAM_CAPTION = "This diagram could not be drawn for export.";

const ESCAPES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** Text or an attribute value, safe in either place. */
function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? "");
}

/** A trimmed, non-empty value, or null. */
function present(value: string | null | undefined): string | null {
	const trimmed = value?.trim() ?? "";
	return trimmed === "" ? null : trimmed;
}

/** A raster as a `data:` URL; anything but PNG or JPEG is never written. */
function dataUrl(raster: ExportRaster): string | null {
	if (raster.mimeType !== "image/png" && raster.mimeType !== "image/jpeg") {
		return null;
	}
	return `data:${raster.mimeType};base64,${raster.bytes.toString("base64")}`;
}

/** A node's text with all markup dropped, whitespace collapsed. */
function plainText(node: Nodes): string {
	return flatText(node).replace(/\s+/g, " ").trim();
}

/** The tree walk, with what it collects on the way. */
class BodyRenderer {
	readonly sections: ExportSection[] = [];
	/** How deep the walk is in the tree right now. */
	private depth = 0;
	private readonly tally = new ExportWarningTally();
	/** Each raster's data URL, encoded once however often it is placed. */
	private readonly dataUrls = new WeakMap<ExportRaster, string | null>();
	/** Characters of image data the body has embedded so far. */
	private embeddedImageChars = 0;
	private readonly definitions = new Map<string, Definition>();
	private readonly footnoteDefinitions = new Map<
		string,
		FootnoteDefinition
	>();
	/** Footnote identifiers in the order they are first referenced. */
	private readonly footnoteOrder: string[] = [];

	constructor(private readonly input: BuildThemeHtmlInput) {
		this.collectDefinitions(input.prepared.root);
	}

	count(code: ProposalExportWarningCode, by = 1): void {
		this.tally.add(code, by);
	}

	warnings(): ProposalExportWarning[] {
		return this.tally.warnings();
	}

	/**
	 * Main's body: every root-level H2 opens a section. A section whose
	 * first block is a table too wide for portrait opens on that table's
	 * landscape page, so its opener is not left alone at the foot of the
	 * page before it.
	 */
	body(): string {
		const parts: string[] = [];
		const children = this.input.prepared.root.children;
		for (let index = 0; index < children.length; index++) {
			const node = children[index];
			if (node?.type === "heading" && node.depth === 2) {
				const opener = this.sectionOpener(
					node.children,
					plainText(node),
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
			} else if (node) {
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
	): string {
		const index = this.sections.length + 1;
		const id = `pa-section-${index}`;
		this.sections.push({ index, id, title });
		const marker =
			this.input.pass.kind === "locate"
				? `<span class="${PRINT.pageMarker}" aria-hidden="true">${pageMarkerText(index)}</span>`
				: "";
		return `<header class="${THEME.sectionOpener}" id="${id}">${marker}<h2>${this.phrasing(children)}</h2></header>`;
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
		const taskClass = tasks ? ' class="contains-task-list"' : "";
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
			return `<ol${start}${taskClass}>${items}</ol>`;
		}
		return `<ul${taskClass}>${items}</ul>`;
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
			return this.diagram(
				this.input.diagrams[diagramIndex],
				exportDiagramCaption(node.value),
			);
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
	 * A diagram's figure, with the fence's `%% caption:` line, as plain
	 * text, under it.
	 */
	private diagram(
		diagram: ExportDiagram | undefined,
		caption: string | null,
	): string {
		const figcaption = caption
			? `<figcaption class="${THEME.caption}">${escapeHtml(caption)}</figcaption>`
			: "";
		if (diagram?.kind === "svg") {
			// Allowlisted by the diagram step, which owns its safety.
			return `<figure class="${THEME.figure} ${PRINT.diagram}">${diagram.svg}${figcaption}</figure>`;
		}
		if (!diagram) {
			this.count("DIAGRAM_PLACEHOLDER");
		}
		const placeholder = diagram?.caption ?? MISSING_DIAGRAM_CAPTION;
		return `<figure class="${THEME.figure} ${PRINT.diagramPlaceholder}"><p class="${THEME.caption}">${escapeHtml(placeholder)}</p>${figcaption}</figure>`;
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
		return `<table class="${THEME.dataTable}">${thead}${tbody}</table>`;
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
		if (!this.dataUrls.has(raster)) {
			this.dataUrls.set(raster, dataUrl(raster));
		}
		const src = this.dataUrls.get(raster) ?? null;
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

/**
 * The cover: data-held fields only. The eyebrow, the title and the date
 * always; each party and each logo only when the tokens hold it; the hero
 * only when there is one. No lead sentence until the cover's fields are
 * settled in Fizzy #2946.
 */
function coverHtml(input: BuildThemeHtmlInput): string {
	const { tokens } = input;
	const proposer = present(tokens.proposer.name.value);
	const recipient = present(tokens.recipient.name.value);

	const logo = (
		raster: ExportRaster | null,
		role: string,
		name: string | null,
		fallback: string,
	): string => {
		const src = raster ? dataUrl(raster) : null;
		return src === null
			? ""
			: `<img class="${PRINT.coverLogo} ${role}" src="${escapeHtml(src)}" alt="${escapeHtml(name ? `${name} logo` : fallback)}">`;
	};
	// Nothing at all between the tags when there is no logo, not even
	// whitespace: the theme hides the row with `:empty`.
	const brands =
		logo(
			tokens.proposer.logo.value,
			PRINT.proposerLogo,
			proposer,
			"Proposer logo",
		) +
		logo(
			tokens.recipient.logo.value,
			PRINT.recipientLogo,
			recipient,
			"Client logo",
		);

	const heroSrc = tokens.proposer.hero.value
		? dataUrl(tokens.proposer.hero.value)
		: null;
	const hero =
		heroSrc === null
			? ""
			: `<img class="${PRINT.coverHero}" src="${escapeHtml(heroSrc)}" alt="">`;

	const party = (label: string, name: string | null) =>
		name === null
			? ""
			: `<div><dt>${label}</dt><dd>${escapeHtml(name)}</dd></div>`;
	const parties =
		party("Prepared for", recipient) + party("Prepared by", proposer);

	const date = present(input.dateLabel);

	return [
		`<section class="${THEME.cover}">`,
		`<div class="${PRINT.coverBrands}">${brands}</div>`,
		hero,
		`<div class="${PRINT.coverBody}">`,
		`<p class="${PRINT.eyebrow}">Proposal</p>`,
		`<h1 class="${PRINT.coverTitle}">${escapeHtml(input.title.trim())}</h1>`,
		"</div>",
		parties === ""
			? ""
			: `<dl class="${PRINT.coverParties}">${parties}</dl>`,
		date === null
			? ""
			: `<p class="${PRINT.coverDate}">${escapeHtml(date)}</p>`,
		"</section>",
	].join("");
}

/** A page number the final pass may print, or null. */
function pageNumberOf(
	pass: ThemeHtmlPass,
	section: ExportSection,
): number | null {
	if (pass.kind !== "final" || pass.pageNumbers === null) {
		return null;
	}
	const page = pass.pageNumbers.get(section.index);
	return typeof page === "number" && Number.isSafeInteger(page) && page > 0
		? page
		: null;
}

/**
 * The contents page, or nothing for a document without sections. Every
 * entry's leader and slot are the same markup in both passes, only the
 * slot's text differs, and the slot's width is fixed by the theme.
 */
function contentsHtml(
	sections: readonly ExportSection[],
	pass: ThemeHtmlPass,
): string {
	if (sections.length === 0) {
		return "";
	}
	const slots = pass.kind === "locate" || pass.pageNumbers !== null;
	const entries = sections.map((section) => {
		const page = pageNumberOf(pass, section);
		const slot = slots
			? `<span class="${PRINT.contentsLeader}" aria-hidden="true"></span><span class="${PRINT.contentsPage}">${page === null ? "" : page}</span>`
			: "";
		return `<li><a href="#${section.id}">${escapeHtml(section.title)}</a>${slot}</li>`;
	});
	return `<nav class="${PRINT.contents}" aria-label="Contents"><p class="${PRINT.eyebrow}">Contents</p><ol>${entries.join("")}</ol></nav>`;
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
	// The body first: the contents page lists the sections it found.
	const body = renderer.body();
	const sections = renderer.sections;

	const title = input.title.trim();
	const proposer = present(input.tokens.proposer.name.value);
	const runningFooter = [
		proposer,
		present(title),
		present(input.dateLabel),
		"Confidential",
	]
		.filter((part): part is string => part !== null)
		.join(" · ");

	// Margin boxes inherit from the root element, not from the body, so the
	// custom properties sit on <html>.
	const properties = Object.entries(
		themeCustomProperties(resolveThemePaint(printTokensOf(input.tokens))),
	)
		.map(([name, value]) => `${name}: ${value}`)
		.join("; ");

	const html = [
		"<!doctype html>",
		`<html lang="en" style="${escapeHtml(properties)}">`,
		"<head>",
		'<meta charset="utf-8">',
		`<title>${escapeHtml(title)}</title>`,
		styleElement(interFontFaceCss()),
		styleElement(
			proposalThemeCss("print", {
				runningHeader: title,
				runningFooter,
				fontFamily: PRINT_FONT_FAMILY,
			}),
		),
		"</head>",
		`<body ${PROPOSAL_THEME_ATTRIBUTE}="print">`,
		coverHtml(input),
		contentsHtml(sections, input.pass),
		body,
		"</body>",
		"</html>",
	].join("\n");

	return { html, sections, warnings: renderer.warnings() };
}
