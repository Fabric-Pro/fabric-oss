"use client";

/**
 * Glossy edition → branded PDF and DOCX (Fizzy #2589, R35, R36, R43, KTD15,
 * KTD16).
 *
 * Both formats walk one document model built here, so they carry the same
 * content in the same order:
 * - a cover with the title on a brand color band and both parties' names
 *   and logos, each logo on a light rounded tile (R35);
 * - the main-flow sections with brand-colored headings, each visual and
 *   uploaded image placed at its anchor (R19);
 * - the appendix last, ending with the provenance line (R36, R43).
 *
 * Section text renders without raw HTML or remote images (KTD16). The only
 * images drawn are `data:` URIs, rendered visuals, the two logo URLs, and
 * the document's own uploads through the server-signed URLs passed in; any
 * other image URL in the text is never fetched. A visual or image that
 * cannot be drawn is left out — never replaced by diagram source or a text
 * stand-in — and counted, so the caller can say how many were omitted.
 */

import { splitMarkdownBlocks } from "@repo/utils/glossy/cleanup";
import type {
	EditionAnchor,
	EditionContent,
	EditionProvenance,
} from "@repo/utils/glossy/edition-content";
import {
	getImageDimensions,
	stripInlineMarkdown,
	tryAddPdfImage,
	tryLoadImageBytes,
} from "../document-export-helpers";
import type { GlossyPalette } from "./palette";
import {
	type RenderedGlossyVisual,
	renderGlossyVisuals,
} from "./visual-render";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GlossyRenderLabels {
	preparedBy: string;
	preparedFor: string;
	appendix: string;
	sources: string;
	details: string;
	placeholders: string;
	assumptions: string;
	additionalMaterial: string;
	/** The appendix's closing line (R43). */
	provenance: (provenance: EditionProvenance) => string;
}

const DEFAULT_GLOSSY_RENDER_LABELS: GlossyRenderLabels = {
	preparedBy: "Prepared by",
	preparedFor: "Prepared for",
	appendix: "Appendix",
	sources: "Sources",
	details: "Document details",
	placeholders: "Open items",
	assumptions: "Assumptions",
	additionalMaterial: "Additional material",
	provenance: ({ sourceTitle, sourceVersion, builtAt }) =>
		`Built from "${sourceTitle}", version ${sourceVersion}, on ${builtAt.slice(0, 10)}.`,
};

export interface GlossyDocumentRenderInput {
	content: EditionContent;
	palette: GlossyPalette;
	/** The preparer organization; `logoUrl` is a signed read or a `data:` URI. */
	preparer: { name: string; logoUrl?: string | null };
	/** The saved recipient brand. Without a name, the cover falls back to the source's client field. */
	recipient?: { name?: string | null; logoUrl?: string | null } | null;
	/** Server-signed read URLs for the document's own uploads, by S3 key (KTD16). */
	imageUrls?: Readonly<Record<string, string>>;
	/** Visuals discarded in review: left out, and not counted as omitted. */
	excludedVisualKeys?: ReadonlySet<string>;
	/** Visuals already rendered for the preview, reused rather than rendered again. */
	renderedVisuals?: ReadonlyMap<string, RenderedGlossyVisual>;
	labels?: Partial<GlossyRenderLabels>;
}

export interface GlossyDocumentRenderResult {
	blob: Blob;
	/** Visuals that failed to render and were left out. */
	omittedVisuals: number;
	/** Section images and cover logos that could not be loaded or are not allowed (KTD16), left out. */
	omittedImages: number;
}

/**
 * The recipient's name for the cover (R35): the saved recipient brand, or
 * else the source's client or cover field, which cleanup moved into the
 * appendix details.
 */
export function resolveRecipientName(
	savedName: string | null | undefined,
	content: EditionContent,
): string | null {
	const saved = savedName?.trim();
	if (saved) {
		return saved;
	}
	for (const detail of content.appendix.details) {
		const label = detail.label?.replace(/[*_]/g, "").trim() ?? "";
		if (CLIENT_LABEL.test(label)) {
			const value = cleanInline(detail.value, () => undefined);
			if (value) {
				return stripInlineMarkdown(value);
			}
		}
	}
	return null;
}

export async function renderGlossyPdf(
	input: GlossyDocumentRenderInput,
): Promise<GlossyDocumentRenderResult> {
	const model = await buildDocumentModel(input);
	const blob = await writePdf(model, input.palette);
	return {
		blob,
		omittedVisuals: model.omittedVisuals,
		omittedImages: model.omittedImages,
	};
}

export async function renderGlossyDocx(
	input: GlossyDocumentRenderInput,
): Promise<GlossyDocumentRenderResult> {
	const model = await buildDocumentModel(input);
	const blob = await writeDocx(model, input.palette);
	return {
		blob,
		omittedVisuals: model.omittedVisuals,
		omittedImages: model.omittedImages,
	};
}

/**
 * A section's anchors in placement order: by `blockIndex`, anchors sharing a
 * block kept in the order the section lists them. The download and the
 * preview both place anchors in this order.
 */
export function orderGlossyAnchors(
	anchors: readonly EditionAnchor[],
): Array<{ anchor: EditionAnchor; order: number }> {
	return anchors
		.map((anchor, order) => ({ anchor, order }))
		.sort(
			(a, b) =>
				a.anchor.blockIndex - b.anchor.blockIndex || a.order - b.order,
		);
}

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

interface LoadedImage {
	dataUrl: string;
	format: "PNG" | "JPEG" | "GIF";
	/** Display size in CSS pixels. */
	width: number;
	height: number;
}

interface ListItem {
	text: string;
	depth: number;
}

type GlossyNode =
	| { type: "heading"; level: number; text: string }
	| { type: "paragraph"; text: string }
	| { type: "list"; ordered: boolean; items: ListItem[] }
	| { type: "quote"; text: string }
	| { type: "code"; lines: string[] }
	| { type: "table"; rows: string[][] }
	| { type: "rule" }
	| { type: "image"; image: LoadedImage; visual: boolean }
	| { type: "pageBreak" }
	| { type: "provenance"; text: string };

interface CoverParty {
	label: string;
	name: string | null;
	logo: LoadedImage | null;
}

interface DocumentModel {
	title: string;
	parties: CoverParty[];
	nodes: GlossyNode[];
	omittedVisuals: number;
	omittedImages: number;
}

/**
 * Detail labels that name the recipient. A Proposal's `Client/Team` field
 * is one; its `Sponsor` is a person on the preparer's side, never the
 * recipient (Fizzy #2589 follow-up).
 */
const CLIENT_LABEL =
	/^(?:client|client name|client\s*\/\s*team|customer|customer name|recipient|prepared for)$/i;

async function buildDocumentModel(
	input: GlossyDocumentRenderInput,
): Promise<DocumentModel> {
	const { content } = input;
	const labels = { ...DEFAULT_GLOSSY_RENDER_LABELS, ...input.labels };
	const excluded = input.excludedVisualKeys ?? new Set<string>();
	const imageUrls = input.imageUrls ?? {};

	// The only remote URLs this render may fetch (KTD16).
	const allowedRemote = new Set<string>(
		[
			input.preparer.logoUrl,
			input.recipient?.logoUrl,
			...Object.values(imageUrls),
		].filter(
			(url): url is string => typeof url === "string" && REMOTE.test(url),
		),
	);

	const allAnchors = [
		...content.sections.flatMap((section) => section.anchors),
		...content.appendix.additionalMaterial.flatMap(
			(section) => section.anchors,
		),
	];
	const wantedVisuals = new Set(
		allAnchors.flatMap((anchor) =>
			anchor.ref.type === "visual" && !excluded.has(anchor.ref.visualKey)
				? [anchor.ref.visualKey]
				: [],
		),
	);
	const visuals = new Map(input.renderedVisuals ?? []);
	const missing = [...wantedVisuals].filter((key) => !visuals.has(key));
	if (missing.length > 0) {
		const rendered = await renderGlossyVisuals(
			content.visuals,
			input.palette,
			(key) => missing.includes(key),
		);
		for (const [key, image] of rendered.images) {
			visuals.set(key, image);
		}
	}

	let omittedVisuals = 0;
	let omittedImages = 0;
	const countOmittedImage = () => {
		omittedImages++;
	};

	const anchorNode = async (
		anchor: EditionAnchor,
	): Promise<GlossyNode | null> => {
		if (anchor.ref.type === "visual") {
			if (excluded.has(anchor.ref.visualKey)) {
				return null;
			}
			const visual = visuals.get(anchor.ref.visualKey);
			if (!visual) {
				omittedVisuals++;
				return null;
			}
			return {
				type: "image",
				visual: true,
				image: {
					dataUrl: visual.dataUrl,
					format: "PNG",
					width: visual.width,
					height: visual.height,
				},
			};
		}
		const url = Object.hasOwn(imageUrls, anchor.ref.s3Key)
			? imageUrls[anchor.ref.s3Key]
			: undefined;
		const image = url ? await loadImage(url, allowedRemote) : null;
		if (!image) {
			countOmittedImage();
			return null;
		}
		return { type: "image", image, visual: false };
	};

	const bodyNodes = async (
		markdown: string,
		anchors: readonly EditionAnchor[],
	): Promise<GlossyNode[]> => {
		const blocks = splitMarkdownBlocks(markdown);
		const ordered = orderGlossyAnchors(anchors);
		const nodes: GlossyNode[] = [];
		let next = 0;
		for (let block = 0; block <= blocks.length; block++) {
			while (
				next < ordered.length &&
				Math.min(ordered[next].anchor.blockIndex, blocks.length) ===
					block
			) {
				const node = await anchorNode(ordered[next].anchor);
				if (node) {
					nodes.push(node);
				}
				next++;
			}
			if (block < blocks.length) {
				for (const parsed of parseBlocks(
					blocks[block],
					countOmittedImage,
				)) {
					if (parsed.type === "inlineImage") {
						const image = await loadImage(parsed.src, new Set());
						if (image) {
							nodes.push({ type: "image", image, visual: false });
						} else {
							countOmittedImage();
						}
					} else {
						nodes.push(parsed);
					}
				}
			}
		}
		return nodes;
	};

	const nodes: GlossyNode[] = [];
	for (const section of content.sections) {
		if (section.heading) {
			nodes.push({
				type: "heading",
				level: Math.max(section.level, 1),
				text: cleanInline(section.heading, () => undefined),
			});
		}
		nodes.push(...(await bodyNodes(section.markdown, section.anchors)));
	}

	nodes.push({ type: "pageBreak" });
	nodes.push({ type: "heading", level: 1, text: labels.appendix });
	const { appendix } = content;
	const listSection = (heading: string, items: string[]) => {
		const kept = items
			.map((item) => cleanInline(item, countOmittedImage))
			.filter(Boolean);
		if (kept.length > 0) {
			nodes.push({ type: "heading", level: 2, text: heading });
			nodes.push({
				type: "list",
				ordered: false,
				items: kept.map((text) => ({ text, depth: 0 })),
			});
		}
	};
	listSection(
		labels.sources,
		appendix.sources.map((source) =>
			source.id ? `${source.id}: ${source.text}` : source.text,
		),
	);
	listSection(
		labels.details,
		appendix.details.map((detail) =>
			detail.label ? `${detail.label}: ${detail.value}` : detail.value,
		),
	);
	listSection(
		labels.placeholders,
		appendix.placeholders.map((placeholder) =>
			placeholder.heading
				? `${placeholder.heading}: ${placeholder.text}`
				: placeholder.text,
		),
	);
	listSection(
		labels.assumptions,
		appendix.assumptions.map(
			(assumption) => `${assumption.text} (${assumption.qualifier})`,
		),
	);
	if (appendix.additionalMaterial.length > 0) {
		nodes.push({
			type: "heading",
			level: 2,
			text: labels.additionalMaterial,
		});
		for (const section of appendix.additionalMaterial) {
			if (section.heading) {
				nodes.push({
					type: "heading",
					level: 3,
					text: cleanInline(section.heading, () => undefined),
				});
			}
			nodes.push(...(await bodyNodes(section.markdown, section.anchors)));
		}
	}
	nodes.push({
		type: "provenance",
		text: labels.provenance(content.provenance),
	});

	// A logo the render was handed but could not load (an expired signed
	// read, say) is left off the cover and counted, like any other image.
	const coverLogo = async (url: string | null | undefined) => {
		if (!url) {
			return null;
		}
		const image = await loadImage(url, allowedRemote);
		if (!image) {
			countOmittedImage();
		}
		return image;
	};
	const [preparerLogo, recipientLogo] = await Promise.all([
		coverLogo(input.preparer.logoUrl),
		coverLogo(input.recipient?.logoUrl),
	]);
	const parties: CoverParty[] = [
		{
			label: labels.preparedBy,
			name: input.preparer.name.trim() || null,
			logo: preparerLogo,
		},
	];
	const recipientName = resolveRecipientName(input.recipient?.name, content);
	if (recipientName || recipientLogo) {
		parties.push({
			label: labels.preparedFor,
			name: recipientName,
			logo: recipientLogo,
		});
	}

	return {
		title: cleanInline(content.title, () => undefined) || content.title,
		parties,
		nodes,
		omittedVisuals,
		omittedImages,
	};
}

// ---------------------------------------------------------------------------
// Images (KTD16)
// ---------------------------------------------------------------------------

const REMOTE = /^https?:\/\//i;
const RASTER_DATA_URL = /^data:image\/(png|jpe?g|gif);base64,/i;

async function fetchAsDataUrl(url: string): Promise<string | null> {
	const response = await fetch(url, { credentials: "omit" });
	if (!response.ok) {
		return null;
	}
	const blob = await response.blob();
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => resolve(reader.result as string);
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}

/**
 * A raster image from a `data:` URI, or from a remote URL only when this
 * render was handed that exact URL. Anything else is refused unfetched.
 */
async function loadImage(
	src: string,
	allowedRemote: ReadonlySet<string>,
): Promise<LoadedImage | null> {
	try {
		const dataUrl = RASTER_DATA_URL.test(src)
			? src
			: allowedRemote.has(src)
				? await fetchAsDataUrl(src)
				: null;
		const match = dataUrl ? RASTER_DATA_URL.exec(dataUrl) : null;
		if (!dataUrl || !match) {
			return null;
		}
		const { width, height } = await getImageDimensions(dataUrl);
		if (!(width > 0 && height > 0)) {
			return null;
		}
		const type = match[1].toLowerCase();
		return {
			dataUrl,
			format: type === "gif" ? "GIF" : type === "png" ? "PNG" : "JPEG",
			width,
			height,
		};
	} catch {
		return null;
	}
}

function countWriteOmission(
	model: DocumentModel,
	node: Extract<GlossyNode, { type: "image" }>,
): void {
	if (node.visual) {
		model.omittedVisuals++;
	} else {
		model.omittedImages++;
	}
}

/** Largest size that fits `maxWidth` × `maxHeight` without upscaling. */
function fitSize(
	image: { width: number; height: number },
	maxWidth: number,
	maxHeight: number,
): { width: number; height: number } {
	const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
	return { width: image.width * scale, height: image.height * scale };
}

/** Space around a logo on its tile, as a share of the tile's height. */
const LOGO_TILE_PADDING = 0.14;
/** Corner radius of a logo tile, as a share of its height. */
const LOGO_TILE_RADIUS = 0.12;

interface LogoTile {
	width: number;
	height: number;
	radius: number;
	/** Where the logo sits on the tile. */
	logo: { x: number; y: number; width: number; height: number };
}

/**
 * A cover logo's tile (Fizzy #2589 follow-up): a light rounded backing with
 * a hairline border, the logo contained inside with its aspect ratio kept
 * and never enlarged. A dark, opaque logo drawn straight on the white page
 * reads as a black block; on the tile it reads as a logo. The tile is
 * `height` tall, at least square, and at most `maxWidth` wide, in the unit
 * the caller draws in.
 */
function logoTile(
	logo: { width: number; height: number },
	maxWidth: number,
	height: number,
): LogoTile {
	const padding = height * LOGO_TILE_PADDING;
	const fitted = fitSize(logo, maxWidth - padding * 2, height - padding * 2);
	const width = Math.max(height, fitted.width + padding * 2);
	return {
		width,
		height,
		radius: height * LOGO_TILE_RADIUS,
		logo: {
			x: (width - fitted.width) / 2,
			y: (height - fitted.height) / 2,
			...fitted,
		},
	};
}

// ---------------------------------------------------------------------------
// Markdown (no raw HTML, no remote images)
// ---------------------------------------------------------------------------

type ParsedBlock =
	| Exclude<GlossyNode, { type: "image" | "pageBreak" | "provenance" }>
	| { type: "inlineImage"; src: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
/** Diagram source never appears in an edition (R13). */
const DIAGRAM_LANGUAGES = new Set([
	"mermaid",
	"plantuml",
	"puml",
	"dot",
	"graphviz",
	"d2",
]);
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d+\\?[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*(?::?-+:?\s*)?\|?\s*$/;
const HTML_LINE = /^\s*(?:<\/?[a-z][^>]*>\s*)+$/i;
const IMAGE_LINE =
	/^\s*!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\s*$/;
const IMG_SRC = /\bsrc\s*=\s*"([^"]*)"/i;
const INLINE_IMAGE = /!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>/gi;

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&nbsp;": " ",
};

/**
 * Inline Markdown with images and raw HTML removed and links reduced to
 * their text. Emphasis markers stay for the writers to style. Every inline
 * image is left out (and reported through `onOmittedImage`): an inline
 * image cannot sit in a line of PDF text, and a remote one is never fetched.
 */
function cleanInline(text: string, onOmittedImage: () => void): string {
	return text
		.replace(INLINE_IMAGE, () => {
			onOmittedImage();
			return "";
		})
		.replace(/<(https?:\/\/[^>\s]+)>/gi, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<\/?[a-z][^>]*>/gi, "")
		.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity])
		.replace(/\s{2,}/g, " ")
		.trim();
}

/** Drop Markdown's backslash escapes (`\*`, `\_`, `\[`) once styling is resolved. */
function unescapeMarkdown(text: string): string {
	return text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");
}

function splitRow(line: string): string[] {
	const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return cells.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** One text block (a run of non-blank lines) into renderable blocks. */
function parseBlocks(block: string, onOmittedImage: () => void): ParsedBlock[] {
	const lines = block.split("\n");
	const out: ParsedBlock[] = [];
	let paragraph: string[] = [];
	let list: Extract<ParsedBlock, { type: "list" }> | null = null;

	const flush = () => {
		if (paragraph.length > 0) {
			const text = cleanInline(paragraph.join(" "), onOmittedImage);
			if (text) {
				out.push({ type: "paragraph", text });
			}
			paragraph = [];
		}
		if (list) {
			out.push(list);
			list = null;
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		const fence = FENCE.exec(line);
		if (fence) {
			flush();
			const code: string[] = [];
			i++;
			while (i < lines.length && !lines[i].trim().startsWith(fence[1])) {
				code.push(lines[i]);
				i++;
			}
			if (!DIAGRAM_LANGUAGES.has(fence[2].toLowerCase())) {
				out.push({ type: "code", lines: code });
			}
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			flush();
			// Never outranks the section heading it sits under.
			out.push({
				type: "heading",
				level: Math.max(heading[1].length, 3),
				text: cleanInline(heading[2], onOmittedImage),
			});
			continue;
		}

		if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(lines[i + 1] ?? "")) {
			flush();
			const rows = [splitRow(line)];
			i += 2;
			while (i < lines.length && TABLE_ROW.test(lines[i])) {
				rows.push(splitRow(lines[i]));
				i++;
			}
			i--;
			out.push({
				type: "table",
				rows: rows.map((row) =>
					row.map((cell) => cleanInline(cell, onOmittedImage)),
				),
			});
			continue;
		}

		const image = IMAGE_LINE.exec(line);
		if (image || /^\s*<img\b[^>]*>\s*$/i.test(line)) {
			flush();
			const src = image ? image[2] : (IMG_SRC.exec(line)?.[1] ?? "");
			// Only an inline `data:` image can render; a remote URL is never fetched.
			if (RASTER_DATA_URL.test(src)) {
				out.push({ type: "inlineImage", src });
			} else {
				onOmittedImage();
			}
			continue;
		}

		if (HTML_LINE.test(line)) {
			// Raw HTML never renders, visual slot tags included (R38).
			flush();
			continue;
		}

		if (RULE.test(line)) {
			flush();
			out.push({ type: "rule" });
			continue;
		}

		const quote = QUOTE.exec(line);
		if (quote) {
			flush();
			const text = cleanInline(quote[1], onOmittedImage);
			if (text) {
				out.push({ type: "quote", text });
			}
			continue;
		}

		const bullet = BULLET.exec(line);
		const ordered = bullet ? null : ORDERED.exec(line);
		if (bullet || ordered) {
			const match = (bullet ?? ordered) as RegExpExecArray;
			const isOrdered = Boolean(ordered);
			if (paragraph.length > 0 || (list && list.ordered !== isOrdered)) {
				flush();
			}
			list ??= { type: "list", ordered: isOrdered, items: [] };
			const text = cleanInline(match[2], onOmittedImage);
			if (text) {
				list.items.push({
					text,
					depth: Math.min(Math.floor(match[1].length / 2), 2),
				});
			}
			continue;
		}

		if (list && /^\s+\S/.test(line)) {
			// A continuation line of the previous list item.
			const last = list.items.at(-1);
			if (last) {
				last.text =
					`${last.text} ${cleanInline(line, onOmittedImage)}`.trim();
			}
			continue;
		}
		if (list) {
			flush();
		}
		paragraph.push(line.trim());
	}
	flush();
	return out;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const PDF_PAGE_WIDTH = 595.28;
const PDF_PAGE_HEIGHT = 841.89;
const PDF_MARGIN = 56;
const PDF_CONTENT_WIDTH = PDF_PAGE_WIDTH - PDF_MARGIN * 2;
const PDF_HEADING_SIZES = [20, 17, 14, 12, 11, 11];
/** CSS pixels to points. */
const PX_TO_PT = 0.75;
/** A cover logo tile on the PDF, in points. */
const PDF_LOGO_TILE_HEIGHT = 72;
const PDF_LOGO_TILE_MAX_WIDTH = 176;
/** The tile's hairline border, in points (one CSS pixel). */
const LOGO_TILE_LINE_PT = 0.75;

function pdfText(markdown: string): string {
	return unescapeMarkdown(stripInlineMarkdown(markdown));
}

async function writePdf(
	model: DocumentModel,
	palette: GlossyPalette,
): Promise<Blob> {
	const { default: jsPDF } = await import("jspdf");
	const doc = new jsPDF({
		orientation: "portrait",
		unit: "pt",
		format: "a4",
	});
	let y = PDF_MARGIN;

	const ensureSpace = (needed: number) => {
		if (y + needed > PDF_PAGE_HEIGHT - PDF_MARGIN) {
			doc.addPage();
			y = PDF_MARGIN;
		}
	};

	const writeLines = (
		text: string,
		options: {
			size: number;
			style?: "normal" | "bold" | "italic";
			color: string;
			indent?: number;
			lineHeight?: number;
			after?: number;
		},
	) => {
		const indent = options.indent ?? 0;
		const lineHeight = options.lineHeight ?? options.size * 1.4;
		doc.setFont("helvetica", options.style ?? "normal");
		doc.setFontSize(options.size);
		doc.setTextColor(options.color);
		const wrapped: string[] = doc.splitTextToSize(
			text,
			PDF_CONTENT_WIDTH - indent,
		);
		for (const line of wrapped) {
			ensureSpace(lineHeight);
			doc.text(line, PDF_MARGIN + indent, y);
			y += lineHeight;
		}
		y += options.after ?? 0;
	};

	const addImage = async (image: LoadedImage) => {
		const targetWidth = Math.min(PDF_CONTENT_WIDTH, image.width * PX_TO_PT);
		const used = await tryAddPdfImage(
			doc,
			image.dataUrl,
			PDF_MARGIN,
			PDF_CONTENT_WIDTH,
			targetWidth,
			() => y,
			(value) => {
				y = value;
			},
			PDF_PAGE_HEIGHT,
		);
		y += used;
		return used > 0;
	};

	// Cover (R35): title on the brand band, then both parties.
	const bandHeight = 240;
	doc.setFillColor(palette.primary);
	doc.rect(0, 0, PDF_PAGE_WIDTH, bandHeight, "F");
	doc.setFont("helvetica", "bold");
	doc.setFontSize(28);
	doc.setTextColor(palette.onPrimary);
	const titleLines: string[] = doc.splitTextToSize(
		pdfText(model.title),
		PDF_CONTENT_WIDTH,
	);
	let titleY = Math.max(
		PDF_MARGIN + 28,
		bandHeight - 48 - (titleLines.length - 1) * 34,
	);
	for (const line of titleLines) {
		doc.text(line, PDF_MARGIN, titleY);
		titleY += 34;
	}

	const columnWidth = (PDF_CONTENT_WIDTH - 32) / 2;
	model.parties.forEach((party, index) => {
		const x = PDF_MARGIN + index * (columnWidth + 32);
		let partyY = bandHeight + 64;
		doc.setFont("helvetica", "normal");
		doc.setFontSize(10);
		doc.setTextColor(palette.muted);
		doc.text(party.label, x, partyY);
		partyY += 14;
		if (party.logo) {
			const tile = logoTile(
				{
					width: party.logo.width * PX_TO_PT,
					height: party.logo.height * PX_TO_PT,
				},
				Math.min(columnWidth, PDF_LOGO_TILE_MAX_WIDTH),
				PDF_LOGO_TILE_HEIGHT,
			);
			try {
				// Decoded first, so an undecodable logo leaves no empty tile.
				doc.getImageProperties(party.logo.dataUrl);
				doc.setFillColor(palette.surface);
				doc.setDrawColor(palette.border);
				doc.setLineWidth(LOGO_TILE_LINE_PT);
				doc.roundedRect(
					x,
					partyY,
					tile.width,
					tile.height,
					tile.radius,
					tile.radius,
					"FD",
				);
				doc.addImage(
					party.logo.dataUrl,
					party.logo.format,
					x + tile.logo.x,
					partyY + tile.logo.y,
					tile.logo.width,
					tile.logo.height,
				);
				partyY += tile.height + 12;
			} catch {
				// An undecodable logo is left off the cover.
			}
		}
		if (party.name) {
			doc.setFont("helvetica", "bold");
			doc.setFontSize(14);
			doc.setTextColor(palette.ink);
			doc.text(
				doc.splitTextToSize(party.name, columnWidth),
				x,
				partyY + 14,
			);
		}
	});
	doc.setFillColor(palette.primary);
	doc.rect(0, PDF_PAGE_HEIGHT - 16, PDF_PAGE_WIDTH, 16, "F");
	doc.addPage();
	y = PDF_MARGIN;

	for (const node of model.nodes) {
		switch (node.type) {
			case "heading": {
				const size = PDF_HEADING_SIZES[node.level - 1] ?? 11;
				y += node.level <= 2 ? 10 : 4;
				ensureSpace(size * 3);
				writeLines(pdfText(node.text), {
					size,
					style: "bold",
					color: palette.heading,
					after: 6,
				});
				break;
			}
			case "paragraph":
				writeLines(pdfText(node.text), {
					size: 11,
					color: palette.ink,
					after: 8,
				});
				break;
			case "list":
				node.items.forEach((item, index) => {
					const marker = node.ordered ? `${index + 1}.` : "•";
					writeLines(`${marker} ${pdfText(item.text)}`, {
						size: 11,
						color: palette.ink,
						indent: 8 + item.depth * 14,
						after: 2,
					});
				});
				y += 6;
				break;
			case "quote":
				writeLines(pdfText(node.text), {
					size: 11,
					style: "italic",
					color: palette.muted,
					indent: 14,
					after: 8,
				});
				break;
			case "code":
				doc.setFont("courier", "normal");
				doc.setFontSize(9);
				doc.setTextColor(palette.ink);
				for (const line of node.lines) {
					const wrapped: string[] = doc.splitTextToSize(
						line || " ",
						PDF_CONTENT_WIDTH - 16,
					);
					for (const part of wrapped) {
						ensureSpace(12);
						doc.text(part, PDF_MARGIN + 8, y);
						y += 12;
					}
				}
				y += 8;
				break;
			case "table": {
				const columns = Math.max(...node.rows.map((row) => row.length));
				const cellWidth = PDF_CONTENT_WIDTH / columns;
				const padding = 5;
				const lineHeight = 12;
				doc.setDrawColor(palette.border);
				doc.setLineWidth(0.5);
				node.rows.forEach((row, rowIndex) => {
					const header = rowIndex === 0;
					doc.setFont("helvetica", header ? "bold" : "normal");
					doc.setFontSize(9.5);
					const cells: string[][] = Array.from(
						{ length: columns },
						(_, c) =>
							doc.splitTextToSize(
								pdfText(row[c] ?? ""),
								cellWidth - padding * 2,
							),
					);
					const rowHeight =
						Math.max(1, ...cells.map((cell) => cell.length)) *
							lineHeight +
						padding * 2;
					ensureSpace(rowHeight);
					if (header) {
						doc.setFillColor(palette.surface);
						doc.rect(
							PDF_MARGIN,
							y,
							PDF_CONTENT_WIDTH,
							rowHeight,
							"F",
						);
					}
					doc.setTextColor(palette.ink);
					cells.forEach((cell, c) => {
						const x = PDF_MARGIN + c * cellWidth;
						if (cell.length > 0 && cell.join("").trim()) {
							doc.text(cell, x + padding, y + padding + 9, {
								lineHeightFactor: lineHeight / 9.5,
							});
						}
						doc.rect(x, y, cellWidth, rowHeight, "S");
					});
					y += rowHeight;
				});
				y += 10;
				break;
			}
			case "rule":
				ensureSpace(12);
				doc.setDrawColor(palette.border);
				doc.setLineWidth(0.75);
				doc.line(PDF_MARGIN, y, PDF_MARGIN + PDF_CONTENT_WIDTH, y);
				y += 12;
				break;
			case "image":
				// A decode failure after loading still leaves the image out.
				if (!(await addImage(node.image))) {
					countWriteOmission(model, node);
				}
				break;
			case "pageBreak":
				doc.addPage();
				y = PDF_MARGIN;
				break;
			case "provenance":
				y += 12;
				writeLines(node.text, {
					size: 9,
					style: "italic",
					color: palette.muted,
				});
				break;
		}
	}

	return doc.output("blob");
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

/** `#rrggbb` → `RRGGBB`, the form docx expects. */
function docxColor(hex: string): string {
	return hex.replace("#", "").toUpperCase();
}

/** Word page width at the default margins, in CSS pixels (about 6 inches). */
const DOCX_CONTENT_WIDTH = 576;

/**
 * The DOCX's own font (Fizzy #2589 follow-up). Without one Word falls back
 * to Times New Roman; Arial is the sans-serif every Word install has, the
 * counterpart of the PDF's Helvetica.
 */
const DOCX_FONT = "Arial";
/** Body text, in half-points: 11 pt, as on the PDF. */
const DOCX_BODY_SIZE = 22;
/** Heading sizes in half-points, as Word's built-in heading styles set them. */
const DOCX_HEADING_SIZES = [32, 26, 24, undefined, undefined, undefined];

/** A cover logo tile in the DOCX, in CSS pixels. */
const DOCX_LOGO_TILE_HEIGHT = 88;
const DOCX_LOGO_TILE_MAX_WIDTH = 240;
/** Canvas pixels per displayed pixel of a tile, so it stays sharp in print. */
const LOGO_TILE_SCALE = 3;

function decodeImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = reject;
		image.src = src;
	});
}

function roundedRectPath(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
): void {
	const r = Math.min(radius, width / 2, height / 2);
	context.beginPath();
	context.moveTo(x + r, y);
	context.arcTo(x + width, y, x + width, y + height, r);
	context.arcTo(x + width, y + height, x, y + height, r);
	context.arcTo(x, y + height, x, y, r);
	context.arcTo(x, y, x + width, y, r);
	context.closePath();
}

/**
 * A cover logo drawn onto its tile as one PNG. Word has no rounded box to
 * set a picture on that every DOCX reader shows, so the tile is part of the
 * image. The logo is already a `data:` URI, so the canvas stays readable.
 * Null where no canvas can draw it; the cover then shows the logo alone.
 */
async function composeLogoTile(
	logo: LoadedImage,
	palette: GlossyPalette,
): Promise<LoadedImage | null> {
	try {
		const tile = logoTile(
			logo,
			DOCX_LOGO_TILE_MAX_WIDTH,
			DOCX_LOGO_TILE_HEIGHT,
		);
		const scale = LOGO_TILE_SCALE;
		const canvas = document.createElement("canvas");
		canvas.width = Math.round(tile.width * scale);
		canvas.height = Math.round(tile.height * scale);
		const context = canvas.getContext("2d");
		if (!context) {
			return null;
		}
		const image = await decodeImage(logo.dataUrl);
		// One CSS pixel of border, inset by half so the stroke stays whole.
		const line = scale;
		roundedRectPath(
			context,
			line / 2,
			line / 2,
			canvas.width - line,
			canvas.height - line,
			tile.radius * scale,
		);
		context.fillStyle = palette.surface;
		context.fill();
		context.lineWidth = line;
		context.strokeStyle = palette.border;
		context.stroke();
		context.imageSmoothingEnabled = true;
		context.imageSmoothingQuality = "high";
		context.drawImage(
			image,
			tile.logo.x * scale,
			tile.logo.y * scale,
			tile.logo.width * scale,
			tile.logo.height * scale,
		);
		return {
			dataUrl: canvas.toDataURL("image/png"),
			format: "PNG",
			width: tile.width,
			height: tile.height,
		};
	} catch {
		return null;
	}
}

async function writeDocx(
	model: DocumentModel,
	palette: GlossyPalette,
): Promise<Blob> {
	const {
		AlignmentType,
		Document,
		HeadingLevel,
		ImageRun,
		Packer,
		PageBreak,
		Paragraph,
		ShadingType,
		Table,
		TableCell,
		TableRow,
		TextRun,
		WidthType,
	} = await import("docx");
	type Block = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;

	const headingLevels = [
		HeadingLevel.HEADING_1,
		HeadingLevel.HEADING_2,
		HeadingLevel.HEADING_3,
		HeadingLevel.HEADING_4,
		HeadingLevel.HEADING_5,
		HeadingLevel.HEADING_6,
	];
	const ink = docxColor(palette.ink);
	const band = {
		type: ShadingType.CLEAR,
		color: "auto",
		fill: docxColor(palette.primary),
	};

	const runs = (
		markdown: string,
		options: { bold?: boolean; italics?: boolean; color?: string } = {},
	): InstanceType<typeof TextRun>[] =>
		markdown
			.split(/(\*\*\*.+?\*\*\*|\*\*.+?\*\*|\*.+?\*|`[^`]+`)/g)
			.filter(Boolean)
			.map((part) => {
				const color = options.color ?? ink;
				if (part.startsWith("***") && part.endsWith("***")) {
					return new TextRun({
						text: unescapeMarkdown(part.slice(3, -3)),
						bold: true,
						italics: true,
						color,
					});
				}
				if (part.startsWith("**") && part.endsWith("**")) {
					return new TextRun({
						text: unescapeMarkdown(part.slice(2, -2)),
						bold: true,
						italics: options.italics,
						color,
					});
				}
				if (
					part.length > 2 &&
					part.startsWith("*") &&
					part.endsWith("*")
				) {
					return new TextRun({
						text: unescapeMarkdown(part.slice(1, -1)),
						bold: options.bold,
						italics: true,
						color,
					});
				}
				if (part.startsWith("`") && part.endsWith("`")) {
					return new TextRun({
						text: part.slice(1, -1),
						font: "Courier New",
						color,
					});
				}
				return new TextRun({
					text: unescapeMarkdown(part),
					bold: options.bold,
					italics: options.italics,
					color,
				});
			});

	const imageParagraph = async (
		image: LoadedImage,
		size: { width: number; height: number },
		alignment: (typeof AlignmentType)[keyof typeof AlignmentType],
	) => {
		const bytes = await tryLoadImageBytes(image.dataUrl);
		if (!bytes) {
			return null;
		}
		return new Paragraph({
			alignment,
			children: [
				new ImageRun({
					data: bytes.data,
					type:
						image.format === "PNG"
							? "png"
							: image.format === "GIF"
								? "gif"
								: "jpg",
					transformation: {
						width: Math.round(size.width),
						height: Math.round(size.height),
					},
				}),
			],
		});
	};

	// A page ends with a page-break run at the end of its last paragraph
	// (Fizzy #2589 follow-up): the break every DOCX reader honors, where
	// Quick Look and TextEdit ignore "page break before" and a second
	// section left an empty paragraph between cover and body. A page never
	// ends twice in a row, so an empty body leaves no blank page.
	const blocks: Block[] = [];
	let pageEnded = false;
	const add = (...added: Block[]) => {
		blocks.push(...added);
		pageEnded = false;
	};
	const endPage = () => {
		const last = blocks.at(-1);
		if (pageEnded || !last) {
			return;
		}
		if (last instanceof Paragraph) {
			last.addChildElement(new PageBreak());
		} else {
			// A table cannot hold the break: a paragraph after it does.
			blocks.push(new Paragraph({ children: [new PageBreak()] }));
		}
		pageEnded = true;
	};

	// Cover (R35): the title on a shaded brand band, then both parties.
	add(
		new Paragraph({ shading: band, spacing: { before: 0, after: 0 } }),
		new Paragraph({
			shading: band,
			spacing: { before: 480, after: 480 },
			children: [
				new TextRun({
					text: pdfText(model.title),
					bold: true,
					size: 56,
					color: docxColor(palette.onPrimary),
				}),
			],
		}),
		new Paragraph({ shading: band, spacing: { before: 0, after: 0 } }),
		new Paragraph({ spacing: { before: 480 } }),
	);
	for (const party of model.parties) {
		add(
			new Paragraph({
				spacing: { before: 240, after: 80 },
				children: [
					new TextRun({
						text: party.label,
						size: 20,
						color: docxColor(palette.muted),
					}),
				],
			}),
		);
		if (party.logo) {
			const tile = await composeLogoTile(party.logo, palette);
			// A tile the canvas could not encode leaves the bare logo.
			const logo =
				(tile &&
					(await imageParagraph(tile, tile, AlignmentType.LEFT))) ??
				(await imageParagraph(
					party.logo,
					fitSize(party.logo, 200, 80),
					AlignmentType.LEFT,
				));
			if (logo) {
				add(logo);
			}
		}
		if (party.name) {
			add(
				new Paragraph({
					children: [
						new TextRun({
							text: party.name,
							bold: true,
							size: 28,
							color: ink,
						}),
					],
				}),
			);
		}
	}

	endPage();

	let listInstance = 0;
	for (const node of model.nodes) {
		switch (node.type) {
			case "heading":
				add(
					new Paragraph({
						heading:
							headingLevels[node.level - 1] ??
							HeadingLevel.HEADING_6,
						children: runs(node.text, {
							bold: true,
							color: docxColor(palette.heading),
						}),
					}),
				);
				break;
			case "paragraph":
				add(
					new Paragraph({
						children: runs(node.text),
					}),
				);
				break;
			case "list":
				listInstance++;
				for (const item of node.items) {
					add(
						new Paragraph({
							children: runs(item.text),
							...(node.ordered
								? {
										numbering: {
											reference: "glossy-ordered",
											level: item.depth,
											instance: listInstance,
										},
									}
								: { bullet: { level: item.depth } }),
						}),
					);
				}
				break;
			case "quote":
				add(
					new Paragraph({
						indent: { left: 360 },
						children: runs(node.text, {
							italics: true,
							color: docxColor(palette.muted),
						}),
					}),
				);
				break;
			case "code":
				for (const line of node.lines) {
					add(
						new Paragraph({
							children: [
								new TextRun({
									text: line,
									font: "Courier New",
									size: 18,
									color: ink,
								}),
							],
						}),
					);
				}
				break;
			case "table": {
				const columns = Math.max(...node.rows.map((row) => row.length));
				add(
					new Table({
						width: { size: 100, type: WidthType.PERCENTAGE },
						rows: node.rows.map(
							(row, rowIndex) =>
								new TableRow({
									tableHeader: rowIndex === 0,
									children: Array.from(
										{ length: columns },
										(_, c) =>
											new TableCell({
												shading:
													rowIndex === 0
														? {
																type: ShadingType.CLEAR,
																color: "auto",
																fill: docxColor(
																	palette.surface,
																),
															}
														: undefined,
												children: [
													new Paragraph({
														children: runs(
															row[c] ?? "",
															{
																bold:
																	rowIndex ===
																	0,
															},
														),
													}),
												],
											}),
									),
								}),
						),
					}),
				);
				add(new Paragraph({}));
				break;
			}
			case "rule":
				add(
					new Paragraph({
						border: {
							bottom: {
								style: "single",
								size: 6,
								color: docxColor(palette.border),
								space: 1,
							},
						},
					}),
				);
				break;
			case "image": {
				const size = fitSize(node.image, DOCX_CONTENT_WIDTH, 700);
				const paragraph = await imageParagraph(
					node.image,
					size,
					AlignmentType.CENTER,
				);
				if (paragraph) {
					add(paragraph);
				} else {
					countWriteOmission(model, node);
				}
				break;
			}
			case "pageBreak":
				endPage();
				break;
			case "provenance":
				add(
					new Paragraph({
						spacing: { before: 360 },
						children: [
							new TextRun({
								text: node.text,
								italics: true,
								size: 18,
								color: docxColor(palette.muted),
							}),
						],
					}),
				);
				break;
		}
	}

	const heading = docxColor(palette.heading);
	const headingStyle = (size: number | undefined) => ({
		run: {
			font: DOCX_FONT,
			bold: true,
			color: heading,
			...(size ? { size } : {}),
		},
	});
	const doc = new Document({
		title: pdfText(model.title),
		// Sans-serif throughout, and headings in the palette's heading color
		// (the brand only where it clears contrast on the page), so the
		// document reads the same where its own run colors are not applied
		// (Fizzy #2589 follow-up).
		styles: {
			default: {
				document: { run: { font: DOCX_FONT, size: DOCX_BODY_SIZE } },
				heading1: headingStyle(DOCX_HEADING_SIZES[0]),
				heading2: headingStyle(DOCX_HEADING_SIZES[1]),
				heading3: headingStyle(DOCX_HEADING_SIZES[2]),
				heading4: headingStyle(DOCX_HEADING_SIZES[3]),
				heading5: headingStyle(DOCX_HEADING_SIZES[4]),
				heading6: headingStyle(DOCX_HEADING_SIZES[5]),
			},
		},
		numbering: {
			config: [
				{
					reference: "glossy-ordered",
					levels: [0, 1, 2].map((level) => ({
						level,
						format: "decimal" as const,
						text: `%${level + 1}.`,
						alignment: AlignmentType.START,
						style: {
							paragraph: {
								indent: {
									left: 360 * (level + 1),
									hanging: 260,
								},
							},
						},
					})),
				},
			],
		},
		sections: [{ children: blocks }],
	});
	return Packer.toBlob(doc);
}
