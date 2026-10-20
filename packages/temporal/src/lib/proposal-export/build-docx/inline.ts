/**
 * Inline content of the Word writer (Fizzy #2946): text runs, links, inline
 * raw HTML and embedded pictures.
 */

import {
	ExternalHyperlink,
	ImageRun,
	type ParagraphChild,
	ShadingType,
	TextRun,
} from "docx";
import type { Html, PhrasingContent } from "mdast";
import {
	isDocumentMediaKey,
	rawHtmlFallback,
	readUploadedImageTag,
	safeLinkHref,
	type UploadedImageTag,
} from "../document-content";
import { type ExportRaster, PROPOSAL_EXPORT_LIMITS } from "../types";
import {
	CODE_FONT,
	INLINE_CODE_SIZE,
	MAX_IMAGE_HEIGHT,
	TWIPS_PER_PIXEL,
} from "./styles";
import {
	type BlockContext,
	proseText,
	type RunStyle,
	runProperties,
	textRun,
	type Writer,
	xmlText,
} from "./writer";

// ---------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------

export function inlineChildren(
	writer: Writer,
	nodes: readonly PhrasingContent[],
	style: RunStyle,
	context: BlockContext,
): ParagraphChild[] {
	const children: ParagraphChild[] = [];
	for (const node of nodes) {
		children.push(...inlineNode(writer, node, style, context));
	}
	return children;
}

function inlineNode(
	writer: Writer,
	node: PhrasingContent,
	style: RunStyle,
	context: BlockContext,
): ParagraphChild[] {
	switch (node.type) {
		case "text": {
			const text = proseText(node.value);
			return text === "" ? [] : [textRun(text, style)];
		}
		case "emphasis":
			return inlineChildren(
				writer,
				node.children,
				{ ...style, italics: true },
				context,
			);
		case "strong":
			return inlineChildren(
				writer,
				node.children,
				{ ...style, bold: true },
				context,
			);
		case "delete":
			return inlineChildren(
				writer,
				node.children,
				{ ...style, strike: true },
				context,
			);
		case "inlineCode":
			return [
				new TextRun({
					text: xmlText(node.value).replace(/[\r\n\t]/g, " "),
					...runProperties({
						...style,
						font: CODE_FONT,
						size: style.size
							? Math.round(style.size * 0.9)
							: INLINE_CODE_SIZE,
					}),
					shading: {
						type: ShadingType.CLEAR,
						color: "auto",
						fill: writer.colors.wash,
					},
				}),
			];
		case "break":
			return [new TextRun({ break: 1 })];
		case "link":
			return linkChildren(
				writer,
				node.url,
				node.children,
				style,
				context,
			);
		case "linkReference": {
			const url = writer.definitions.get(node.identifier);
			return url === undefined
				? inlineChildren(writer, node.children, style, context)
				: linkChildren(writer, url, node.children, style, context);
		}
		case "image":
		case "imageReference":
			// A Markdown image names a URL, never a stored upload: it is not
			// fetched, only counted.
			writer.externalImages++;
			return [];
		case "html":
			return inlineHtml(writer, node, style, context);
		case "footnoteReference":
			return [
				textRun(xmlText(node.label ?? node.identifier), {
					...style,
					superScript: true,
				}),
			];
		default:
			return [];
	}
}

/**
 * A link keeps its link only when `safeLinkHref` returns an http(s) or
 * mailto URL; a same-document fragment, and anything refused, prints as its
 * text alone, so the file carries no other external relationship.
 */
function linkChildren(
	writer: Writer,
	url: string,
	nodes: readonly PhrasingContent[],
	style: RunStyle,
	context: BlockContext,
): ParagraphChild[] {
	const href = safeLinkHref(url);
	if (href === null || href.startsWith("#")) {
		return inlineChildren(writer, nodes, style, context);
	}
	const children = inlineChildren(
		writer,
		nodes,
		{ ...style, color: style.linkColor ?? style.color, link: true },
		context,
	);
	if (children.length === 0) {
		return [];
	}
	return [new ExternalHyperlink({ link: href, children })];
}

function inlineHtml(
	writer: Writer,
	node: Html,
	style: RunStyle,
	context: BlockContext,
): ParagraphChild[] {
	const tag = readUploadedImageTag(node.value);
	if (tag) {
		const image = uploadedImageRun(writer, tag, context);
		return image ? [image] : [];
	}
	// A refused upload's source holds its storage key and a signed URL, so
	// it is never printed.
	const fallback = rawHtmlFallback(node.value);
	switch (fallback.kind) {
		case "break":
			return [new TextRun({ break: 1 })];
		case "omit":
			return [];
		case "external-image":
			writer.externalImages++;
			return [];
		case "text": {
			const text = proseText(fallback.text);
			return text === "" ? [] : [textRun(text, style)];
		}
	}
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function imageType(raster: ExportRaster): "png" | "jpg" {
	return raster.mimeType === "image/png" ? "png" : "jpg";
}

/**
 * A display size in CSS pixels: `desiredWidth` wide at the raster's aspect,
 * shrunk to fit `maxWidth` × `maxHeight` (both in twips), never wider than
 * `desiredWidth`. Callers pass the raster's own width unless the editor set
 * one, so an image is only ever enlarged where its author enlarged it.
 */
export function fitImage(
	raster: { width: number; height: number },
	desiredWidth: number,
	maxWidth: number,
	maxHeight: number,
): { width: number; height: number } {
	const aspect = Math.max(1, raster.height) / Math.max(1, raster.width);
	const width = Math.max(1, desiredWidth);
	const scale = Math.min(
		1,
		maxWidth / TWIPS_PER_PIXEL / width,
		maxHeight / TWIPS_PER_PIXEL / (width * aspect),
	);
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(width * aspect * scale)),
	};
}

/**
 * An embedded picture, or null when it would take the file past its image
 * placement budget: the writer handles an image's bytes at every placement,
 * so an image placed thousands of times must not be. Each drawing gets its
 * own id: left to itself docx numbers every one 1, and drawing ids are meant
 * to be unique in a document.
 */
export function imageRun(
	writer: Writer,
	raster: ExportRaster,
	size: { width: number; height: number },
	description: string,
): ImageRun | null {
	if (
		writer.placedImageBytes + raster.bytes.length >
		PROPOSAL_EXPORT_LIMITS.maxPlacedImageBytes
	) {
		writer.imagesOverLimit++;
		return null;
	}
	writer.placedImageBytes += raster.bytes.length;
	const text = xmlText(description);
	writer.drawings++;
	return new ImageRun({
		type: imageType(raster),
		data: raster.bytes,
		transformation: size,
		altText: {
			id: String(writer.drawings),
			name: `Picture ${writer.drawings}`,
			description: text,
			title: text,
		},
	});
}

/**
 * The stored image an uploaded image tag names, when the key is under this
 * document's own media prefix and the image reader has its bytes. The
 * editor's width is honoured: pixels as given, a percentage of the column;
 * without one the image shows at its own size, shrunk to the column.
 */
function uploadedImage(
	writer: Writer,
	tag: UploadedImageTag,
): ExportRaster | null {
	const { projectId, documentId, images } = writer.input;
	if (!isDocumentMediaKey(tag.key, projectId, documentId)) {
		return null;
	}
	return images.get(tag.key) ?? null;
}

function uploadedImageSize(
	raster: ExportRaster,
	tag: UploadedImageTag,
	maxWidth: number,
): { width: number; height: number } {
	const columnPixels = maxWidth / TWIPS_PER_PIXEL;
	let desired = raster.width;
	if (tag.width?.endsWith("px")) {
		desired = Number.parseInt(tag.width, 10);
	} else if (tag.width?.endsWith("%")) {
		desired = (columnPixels * Number.parseInt(tag.width, 10)) / 100;
	}
	return fitImage(raster, desired, maxWidth, MAX_IMAGE_HEIGHT);
}

export function uploadedImageRun(
	writer: Writer,
	tag: UploadedImageTag,
	context: BlockContext,
): ImageRun | null {
	const raster = uploadedImage(writer, tag);
	if (!raster) {
		return null;
	}
	return imageRun(
		writer,
		raster,
		uploadedImageSize(raster, tag, context.textWidth - context.indent),
		tag.alt || tag.caption || "",
	);
}
