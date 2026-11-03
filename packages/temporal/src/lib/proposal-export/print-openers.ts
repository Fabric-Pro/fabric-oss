/**
 * A section opener on the Proposal's print page (Fizzy #2946): the marker
 * the `locate` pass writes in it, the paragraph it takes as its subtitle,
 * the first block that prints after it, and the diagrams that print on
 * its page, right under it or after short blocks, whose drawings may be
 * kept shorter so they share that page, the more so the more lines come
 * before them, as long as their labels stay legible. The opener itself is
 * `build-theme-html`'s, whose body walk finds the block after it with
 * {@link firstPrintedAfterOpener}, as {@link printFigureMaxHeights} does.
 */

import { legibleFigureMaxHeightPx } from "@repo/utils/proposal-artifact/diagram-label-wrap";
import {
	type OpenerPageBlock,
	PRINT_FIGURE_MAX_HEIGHT_PX,
	printFigureUnderOpenerMaxHeightPx,
} from "@repo/utils/proposal-artifact/proposal-theme";
import type { Emphasis, Html, Nodes, RootContent } from "mdast";
import {
	coverLetter,
	hasEmptyHeaderRow,
	isCoverFence,
	isDocumentMediaKey,
	rawHtmlFallback,
	readUploadedImageTag,
	type UploadedImageTag,
} from "./document-content";
import { eachNode, type PreparedExportMarkdown } from "./markdown";
import { letterNodes } from "./print-letter";
import {
	isEmbeddable,
	isImageParagraph,
	meaningfulChildren,
	plainText,
} from "./print-markup";
import type {
	ExportDiagram,
	ExportDocumentImages,
	ExportRaster,
} from "./types";

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

/**
 * The longest paragraph, in characters, a section opener takes as its
 * subtitle; a longer one stays in the body.
 */
const SUBTITLE_MAX_CHARACTERS = 200;

/**
 * The emphasis a paragraph right after a section heading is made of, when
 * it is nothing else and short enough to be the opener's subtitle.
 */
export function subtitleOf(node: Nodes | undefined): Emphasis | null {
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

/**
 * What decides whether a block prints, beyond the Markdown itself: the
 * uploaded images read for the document and the diagrams drawn for it.
 */
export interface PrintedBlockFacts {
	/** Whether an uploaded image tag prints its bytes. */
	printsImage: (tag: UploadedImageTag) => boolean;
	/** Whether the diagram at `index`, by `diagramSources` order, prints nothing. */
	omitsDiagram: (index: number) => boolean;
}

/** The uploaded images a print page may embed, and whose they are. */
export interface PrintedImages {
	/** The uploaded images read for this document, by storage key. */
	images: ExportDocumentImages;
	projectId: string;
	documentId: string;
}

/**
 * The bytes an uploaded image tag prints, or null: only an image under this
 * document's own media prefix that was read has any.
 */
export function uploadedRaster(
	tag: UploadedImageTag,
	{ images, projectId, documentId }: PrintedImages,
): ExportRaster | null {
	return isDocumentMediaKey(tag.key, projectId, documentId)
		? (images.get(tag.key) ?? null)
		: null;
}

/**
 * The facts a print page is laid out from: its uploaded images, and
 * `diagrams` by `diagramSources` order, where a diagram missing from it or
 * left out (`omitted`) prints nothing.
 */
export function printedBlockFacts(
	printed: PrintedImages,
	diagrams: readonly (ExportDiagram | undefined)[],
): PrintedBlockFacts {
	return {
		printsImage: (tag) => {
			const raster = uploadedRaster(tag, printed);
			return raster !== null && isEmbeddable(raster);
		},
		omitsDiagram: (index) => {
			const diagram = diagrams[index];
			return diagram === undefined || diagram.kind === "omitted";
		},
	};
}

/**
 * Whether raw HTML prints nothing: an uploaded image without bytes to
 * print, an author's comment, or an image tag from elsewhere, which the
 * export never fetches.
 */
function htmlPrintsNothing(html: Html, facts: PrintedBlockFacts): boolean {
	const tag = readUploadedImageTag(html.value);
	if (tag) {
		return !facts.printsImage(tag);
	}
	const fallback = rawHtmlFallback(html.value).kind;
	return fallback === "omit" || fallback === "external-image";
}

/**
 * Whether a root block prints nothing on the print page, as `BodyRenderer`
 * (in `./build-theme-html`) renders it: a link or footnote definition,
 * printed where it is referenced; raw HTML that prints nothing; a paragraph
 * of nothing but Markdown images (each dropped) and such HTML; a `cover`
 * block the parser takes, which only the cover prints; a table with
 * neither a header nor a row; and a diagram left out.
 */
function printsNothing(
	node: RootContent,
	prepared: PreparedExportMarkdown,
	facts: PrintedBlockFacts,
): boolean {
	switch (node.type) {
		case "definition":
		case "footnoteDefinition":
			return true;
		case "html":
			return htmlPrintsNothing(node, facts);
		case "paragraph":
			return meaningfulChildren(node.children).every(
				(child) =>
					child.type === "image" ||
					child.type === "imageReference" ||
					(child.type === "html" && htmlPrintsNothing(child, facts)),
			);
		case "code": {
			const diagram = prepared.diagramIndex.get(node);
			return diagram === undefined
				? isCoverFence(node)
				: facts.omitsDiagram(diagram);
		}
		case "table":
			return hasEmptyHeaderRow(node) && node.children.length < 2;
		default:
			return false;
	}
}

/**
 * The index, among Main's root blocks, of the first block after the
 * section opener whose H2 is at `heading` that prints anything: past the
 * opener's subtitle and every block that {@link printsNothing}, so the
 * page places it right after the opener's header. The number of root
 * blocks when there is none.
 */
export function firstPrintedAfterOpener(
	prepared: PreparedExportMarkdown,
	heading: number,
	facts: PrintedBlockFacts,
): number {
	const children = prepared.root.children;
	return nextPrinted(
		prepared,
		heading + (subtitleOf(children[heading + 1]) ? 2 : 1),
		facts,
	);
}

/**
 * The index, among Main's root blocks, of the first block from `from` on
 * that prints anything; the number of root blocks when there is none.
 */
function nextPrinted(
	prepared: PreparedExportMarkdown,
	from: number,
	facts: PrintedBlockFacts,
): number {
	const children = prepared.root.children;
	const offset = children
		.slice(from)
		.findIndex((block) => !printsNothing(block, prepared, facts));
	return offset === -1 ? children.length : from + offset;
}

/**
 * The text a heading, a subtitle or a paragraph prints, as the page writes
 * it: its text and inline code, and raw HTML that prints as its own text,
 * with a line break (a hard break, or a `<br>` written as HTML) as `\n` and
 * any other run of whitespace as one space.
 */
function printedText(node: Nodes): string {
	const parts: string[] = [];
	eachNode(node, (child) => {
		if (child.type === "text" || child.type === "inlineCode") {
			parts.push(child.value.replace(/\s+/g, " "));
		} else if (child.type === "break") {
			parts.push("\n");
		} else if (child.type === "html") {
			const fallback = rawHtmlFallback(child.value);
			if (fallback.kind === "break") {
				parts.push("\n");
			} else if (fallback.kind === "text") {
				parts.push(fallback.text.replace(/\s+/g, " "));
			}
		}
	});
	return parts.join("");
}

/**
 * A block as it prints between an opener and a figure on its page, or null
 * for any block that is not short text: a paragraph of text, or a list
 * whose items hold nothing but such paragraphs.
 */
function openerPageBlock(node: RootContent): OpenerPageBlock | null {
	const text = (child: Nodes) =>
		child.type === "paragraph" && !isImageParagraph(child)
			? printedText(child)
			: null;
	if (node.type === "paragraph") {
		const paragraph = text(node);
		return paragraph === null
			? null
			: { kind: "paragraph", text: paragraph };
	}
	if (node.type !== "list") {
		return null;
	}
	const items: string[] = [];
	for (const item of node.children) {
		const paragraphs = item.children.map(text);
		if (paragraphs.some((paragraph) => paragraph === null)) {
			return null;
		}
		items.push(paragraphs.join("\n"));
	}
	return { kind: "list", items };
}

/**
 * Each diagram fence's offered height in print, in CSS pixels, by its
 * `diagramSources` order: the tallest its place on the page lets it print
 * before its own drawing is known ({@link figureMaxHeightAsDrawn} then
 * decides whether it keeps that height). The page places the first block
 * after a section opener that prints anything
 * ({@link firstPrintedAfterOpener}) right after the opener's header, where
 * the print layer leaves the opener its room too. The first fence on the opener's page, right under it or after
 * nothing but paragraphs and lists ({@link openerPageBlock}), gets at most
 * `PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX`, less by every line the
 * opener's text and those blocks are estimated to take
 * (`printFigureUnderOpenerMaxHeightPx`). The walk stops at any other block,
 * and once the blocks leave the figure less than its floor, where it keeps
 * a figure's own height and moves to the next page whole, as every other
 * fence, the cover letter's included, does. The Word file has no such
 * limit.
 */
export function printFigureMaxHeights(
	prepared: PreparedExportMarkdown,
	facts: PrintedBlockFacts,
): number[] {
	const heights = prepared.diagramSources.map(
		() => PRINT_FIGURE_MAX_HEIGHT_PX,
	);
	const letter = letterNodes(coverLetter(prepared.root));
	const children = prepared.root.children;
	for (const [index, node] of children.entries()) {
		if (node.type !== "heading" || node.depth !== 2 || letter.has(node)) {
			continue;
		}
		const heading = printedText(node);
		const lead = subtitleOf(children[index + 1]);
		const subtitle = lead ? printedText(lead) : null;
		const before: OpenerPageBlock[] = [];
		for (
			let at = firstPrintedAfterOpener(prepared, index, facts);
			at < children.length;
			at = nextPrinted(prepared, at + 1, facts)
		) {
			const block = children[at] as RootContent;
			const diagram =
				block.type === "code"
					? prepared.diagramIndex.get(block)
					: undefined;
			if (diagram !== undefined) {
				heights[diagram] = printFigureUnderOpenerMaxHeightPx(
					heading,
					subtitle,
					before,
				);
				break;
			}
			const short = openerPageBlock(block);
			if (short === null) {
				break;
			}
			before.push(short);
			// Past the floor, a figure after these keeps its own height.
			if (
				printFigureUnderOpenerMaxHeightPx(heading, subtitle, before) ===
				PRINT_FIGURE_MAX_HEIGHT_PX
			) {
				break;
			}
		}
	}
	return heights;
}

/**
 * The tallest `diagram` prints where the page offers it `offered`
 * ({@link printFigureMaxHeights}): `offered` while its labels stay at the
 * print floor there, else a figure's own height, at which it moves whole to
 * the next page (`legibleFigureMaxHeightPx`). A placeholder, or a diagram
 * not drawn yet, keeps `offered`. The page writes this on the figure, and
 * the diagram step measures the figure's labels against the same number.
 */
export function figureMaxHeightAsDrawn(
	offered: number,
	diagram: ExportDiagram | undefined,
): number {
	return diagram?.kind === "svg"
		? legibleFigureMaxHeightPx(offered, diagram, diagram.textPx)
		: offered;
}

/**
 * Fence `index`'s tallest drawing in print, for the diagram step, which
 * draws the fences in order: read with the diagrams drawn before it, so a
 * diagram left out between an opener and the fence leaves it right under
 * the opener. Before the fence is drawn (`drawn` holds no entry for it) it
 * counts as printing and gets the height its place offers
 * ({@link printFigureMaxHeights}); once drawn, the height it prints at
 * ({@link figureMaxHeightAsDrawn}), which the page writes on it.
 */
export function printFigureMaxHeight(
	prepared: PreparedExportMarkdown,
	printed: PrintedImages,
): (index: number, drawn: readonly ExportDiagram[]) => number {
	return (index, drawn) => {
		const facts: PrintedBlockFacts = {
			...printedBlockFacts(printed, drawn),
			omitsDiagram: (at) => drawn[at]?.kind === "omitted",
		};
		return figureMaxHeightAsDrawn(
			printFigureMaxHeights(prepared, facts)[index] ??
				PRINT_FIGURE_MAX_HEIGHT_PX,
			drawn[index],
		);
	};
}
