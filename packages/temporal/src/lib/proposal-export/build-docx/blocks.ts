/**
 * Block content of the Word writer (Fizzy #2946): paragraphs, headings,
 * lists, callouts, code, diagrams and block raw HTML.
 */

import {
	parseStatTiles,
	STAT_TILES_LANGUAGE,
} from "@repo/utils/proposal-artifact/stat-tiles";
import {
	AlignmentType,
	BorderStyle,
	HeadingLevel,
	type IBorderOptions,
	type IParagraphOptions,
	type ParagraphChild,
	ShadingType,
	Tab,
	TextRun,
} from "docx";
import type {
	Code,
	Html,
	List,
	Paragraph as MdParagraph,
	RootContent,
} from "mdast";
import { rawHtmlFallback, readUploadedImageTag } from "../document-content";
import { flatText } from "../markdown";
import type { ExportDiagram } from "../types";
import { fitImage, imageRun, inlineChildren, uploadedImageRun } from "./inline";
import {
	BODY_AFTER,
	CALLOUT_INDENT,
	CAPTION_SIZE,
	CODE_FONT,
	CODE_INDENT,
	CODE_SIZE,
	DIAGRAM_UNAVAILABLE,
	HEADING_SIZES,
	LIST_HANGING,
	LIST_ITEM_AFTER,
	LIST_LEVELS,
	LIST_STEP,
	MAX_IMAGE_HEIGHT,
	registerList,
	SINGLE_LINE,
	SYMBOL_FONT,
} from "./styles";
import { renderTable, spacerParagraph, statTilesTable } from "./tables";
import {
	type BlockContext,
	bodyRunStyle,
	type Out,
	proseText,
	type RunStyle,
	runProperties,
	textRun,
	type Writer,
	xmlText,
} from "./writer";

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function headingRunStyle(writer: Writer, level: number): RunStyle {
	return {
		font: writer.fonts.display,
		color: writer.colors.heading,
		size: HEADING_SIZES[level - 1],
		bold: true,
		linkColor: writer.colors.heading,
		linkUnderline: writer.colors.primary,
	};
}

/**
 * Add a paragraph, decorated for where it sits: inside a callout it takes
 * the tint and a primary rule on the left, and a list continuation keeps the
 * list's text indent. Numbered paragraphs take their indent from the level.
 */
function pushParagraph(
	out: Out[],
	writer: Writer,
	context: BlockContext,
	options: IParagraphOptions,
): void {
	let paragraph: IParagraphOptions = options;
	const numbered = options.numbering !== undefined && options.numbering;
	if (!numbered && options.indent === undefined && context.indent > 0) {
		paragraph = { ...paragraph, indent: { left: context.indent } };
	}
	if (context.callout) {
		const { colors } = writer;
		const left = numbered
			? undefined
			: (paragraph.indent?.left as number | undefined);
		paragraph = {
			...paragraph,
			...(numbered
				? {}
				: {
						indent: {
							...paragraph.indent,
							left: (left ?? context.indent) + CALLOUT_INDENT,
							right: CALLOUT_INDENT,
						},
					}),
			shading: {
				type: ShadingType.CLEAR,
				color: "auto",
				fill: colors.tint,
			},
			// Paper-tint top, bottom and right rules pad the box; Word joins
			// neighbouring paragraphs with the same rules into one callout.
			border: {
				left: {
					style: BorderStyle.SINGLE,
					size: 24,
					color: colors.primary,
					space: 10,
				},
				top: {
					style: BorderStyle.SINGLE,
					size: 4,
					color: colors.tint,
					space: 6,
				},
				bottom: {
					style: BorderStyle.SINGLE,
					size: 4,
					color: colors.tint,
					space: 6,
				},
				right: {
					style: BorderStyle.SINGLE,
					size: 4,
					color: colors.tint,
					space: 10,
				},
			},
		};
	}
	out.push({ paragraph });
}

function renderBlocks(
	writer: Writer,
	nodes: readonly RootContent[],
	out: Out[],
	context: BlockContext,
): void {
	for (const node of nodes) {
		renderBlock(writer, node, out, context);
	}
}

export function renderBlock(
	writer: Writer,
	node: RootContent,
	out: Out[],
	context: BlockContext,
): void {
	switch (node.type) {
		case "heading": {
			const level = Math.min(Math.max(node.depth, 1), 6);
			if (level === 2) {
				const title = proseText(flatText(node)).trim();
				if (title !== "") {
					writer.contents.push(title);
				}
			}
			pushParagraph(out, writer, context, {
				heading: HEADING_LEVELS[level - 1],
				children: inlineChildren(
					writer,
					node.children,
					headingRunStyle(writer, level),
					context,
				),
			});
			return;
		}
		case "paragraph":
			renderParagraph(writer, node, out, context);
			return;
		case "blockquote":
			renderBlocks(writer, node.children, out, {
				...context,
				callout: true,
			});
			return;
		case "list":
			renderList(writer, node, out, context);
			return;
		case "code":
			renderCode(writer, node, out, context);
			return;
		case "table":
			renderTable(writer, node, out, context);
			return;
		case "thematicBreak":
			pushParagraph(out, writer, context, {
				spacing: { before: 120, after: 360 },
				border: {
					bottom: {
						style: BorderStyle.SINGLE,
						size: 6,
						color: writer.colors.border,
						space: 1,
					},
				},
			});
			return;
		case "html":
			renderHtmlBlock(writer, node, out, context);
			return;
		case "footnoteDefinition": {
			const [first, ...rest] = node.children;
			const label = textRun(xmlText(node.label ?? node.identifier), {
				...bodyRunStyle(writer),
				superScript: true,
			});
			if (first?.type === "paragraph") {
				renderParagraph(writer, first, out, context, {
					prefix: [label],
				});
				renderBlocks(writer, rest, out, context);
			} else {
				pushParagraph(out, writer, context, { children: [label] });
				renderBlocks(writer, node.children, out, context);
			}
			return;
		}
		case "definition":
			return;
		default: {
			// Phrasing content where a block was expected: print its text.
			const text = proseText(flatText(node)).trim();
			if (text !== "") {
				pushParagraph(out, writer, context, {
					children: [textRun(text, bodyRunStyle(writer))],
				});
			}
		}
	}
}

const HEADING_LEVELS = [
	HeadingLevel.HEADING_1,
	HeadingLevel.HEADING_2,
	HeadingLevel.HEADING_3,
	HeadingLevel.HEADING_4,
	HeadingLevel.HEADING_5,
	HeadingLevel.HEADING_6,
] as const;

function renderParagraph(
	writer: Writer,
	node: MdParagraph,
	out: Out[],
	context: BlockContext,
	extra: {
		prefix?: ParagraphChild[];
		options?: IParagraphOptions;
	} = {},
): void {
	const children = [
		...(extra.prefix ?? []),
		...inlineChildren(writer, node.children, bodyRunStyle(writer), context),
	];
	// A paragraph of nothing but left-out images leaves no gap behind.
	if (children.length === 0 && !extra.options?.numbering) {
		return;
	}
	pushParagraph(out, writer, context, { ...extra.options, children });
}

/**
 * A list, one numbering definition per list node. A task item shows its
 * ballot box in place of the marker, hanging where the marker would.
 * Continuation blocks of an item keep the item's text indent; nested lists
 * step in a level.
 */
function renderList(
	writer: Writer,
	list: List,
	out: Out[],
	context: BlockContext,
): void {
	const reference = registerList(writer, list);
	const depth = Math.min(context.listDepth, LIST_LEVELS - 1);
	const textIndent = LIST_STEP * (depth + 1);
	const firstOut = out.length;
	const itemContext: BlockContext = {
		...context,
		indent: textIndent,
		listDepth: context.listDepth + 1,
	};

	for (const item of list.children) {
		const task = item.checked === true || item.checked === false;
		const prefix: ParagraphChild[] = task
			? [
					new TextRun({
						text: item.checked ? "☑" : "☐",
						font: SYMBOL_FONT,
						color: writer.colors.primary,
					}),
					new TextRun({ children: [new Tab()] }),
				]
			: [];
		const marker: IParagraphOptions = task
			? {
					indent: { left: textIndent, hanging: LIST_HANGING },
					spacing: { after: LIST_ITEM_AFTER },
				}
			: {
					numbering: { reference, level: depth, instance: 0 },
					spacing: { after: LIST_ITEM_AFTER },
				};
		const [first, ...rest] = item.children;
		if (first?.type === "paragraph") {
			renderParagraph(writer, first, out, context, {
				prefix,
				options: marker,
			});
			renderBlocks(writer, rest, out, itemContext);
		} else {
			// An item that opens with something other than text still shows
			// its marker, on a line of its own.
			pushParagraph(out, writer, context, {
				...marker,
				children: prefix,
			});
			renderBlocks(writer, item.children, out, itemContext);
		}
	}

	// The list ends with the body's gap, not an item's.
	if (context.listDepth === 0) {
		for (let index = out.length - 1; index >= firstOut; index--) {
			const entry = out[index];
			if (entry && "paragraph" in entry) {
				out[index] = {
					paragraph: {
						...entry.paragraph,
						spacing: {
							...entry.paragraph.spacing,
							after: BODY_AFTER,
						},
					},
				};
				break;
			}
		}
	}
}

/**
 * A fence: a diagram's render or its placeholder caption, stat tiles when
 * the block is valid, and otherwise a shaded monospace block that keeps its
 * lines. A diagram is looked up by its node, never by counting fences, so
 * it can never take another fence's render.
 */
function renderCode(
	writer: Writer,
	node: Code,
	out: Out[],
	context: BlockContext,
): void {
	const diagramIndex = writer.input.prepared.diagramIndex.get(node);
	if (diagramIndex !== undefined) {
		renderDiagram(
			writer,
			writer.input.diagrams[diagramIndex],
			out,
			context,
		);
		return;
	}
	if (node.lang === STAT_TILES_LANGUAGE) {
		const parsed = parseStatTiles(node.value);
		if (parsed.ok) {
			out.push({ table: statTilesTable(writer, parsed.items, context) });
			out.push({ paragraph: spacerParagraph() });
			return;
		}
	}
	const style: RunStyle = {
		font: CODE_FONT,
		color: writer.colors.ink,
		size: CODE_SIZE,
	};
	const lines = xmlText(node.value)
		.replace(/\t/g, "    ")
		.split(/\r\n|\r|\n/);
	const box: IBorderOptions = {
		style: BorderStyle.SINGLE,
		size: 4,
		color: writer.colors.border,
		space: 6,
	};
	pushParagraph(
		out,
		writer,
		{ ...context, callout: false },
		{
			indent: {
				left: context.indent + CODE_INDENT,
				right: CODE_INDENT,
			},
			spacing: { before: 120, after: BODY_AFTER + 60, line: 264 },
			shading: {
				type: ShadingType.CLEAR,
				color: "auto",
				fill: writer.colors.wash,
			},
			border: { top: box, bottom: box, left: box, right: box },
			children: lines.map((line, index) =>
				index === 0
					? textRun(line, style)
					: new TextRun({
							text: line,
							break: 1,
							...runProperties(style),
						}),
			),
		},
	);
}

function renderDiagram(
	writer: Writer,
	diagram: ExportDiagram | undefined,
	out: Out[],
	context: BlockContext,
): void {
	if (diagram?.kind === "svg" && diagram.png) {
		// Shown at the SVG's own size, as print does, shrunk to the column.
		const size = fitImage(
			diagram.png,
			diagram.width > 0 ? diagram.width : diagram.png.width / 2,
			context.textWidth - context.indent,
			MAX_IMAGE_HEIGHT,
		);
		const image = imageRun(writer, diagram.png, size, "Diagram");
		if (image) {
			pushParagraph(out, writer, context, {
				alignment: AlignmentType.CENTER,
				spacing: {
					before: 120,
					after: BODY_AFTER + 60,
					line: SINGLE_LINE,
				},
				children: [image],
			});
			return;
		}
	}
	const caption =
		diagram?.kind === "placeholder" ? diagram.caption : DIAGRAM_UNAVAILABLE;
	pushParagraph(out, writer, context, {
		alignment: AlignmentType.CENTER,
		spacing: { before: 120, after: BODY_AFTER + 60, line: SINGLE_LINE },
		children: [
			textRun(proseText(caption), {
				font: writer.fonts.body,
				color: writer.colors.muted,
				size: CAPTION_SIZE,
				italics: true,
			}),
		],
	});
}

/**
 * Raw HTML at block level: an uploaded image with its caption under it, a
 * line break, or the literal text. An uploaded image tag whose key is not
 * this document's, or whose bytes the image reader left out, prints nothing:
 * the tag itself (a storage key) is never client text, and the reader has
 * already reported the image as dropped.
 */
function renderHtmlBlock(
	writer: Writer,
	node: Html,
	out: Out[],
	context: BlockContext,
): void {
	const tag = readUploadedImageTag(node.value);
	if (tag) {
		const image = uploadedImageRun(writer, tag, context);
		if (!image) {
			return;
		}
		pushParagraph(out, writer, context, {
			alignment: AlignmentType.CENTER,
			keepNext: tag.caption !== null,
			spacing: {
				before: 120,
				after: tag.caption ? 80 : BODY_AFTER + 60,
				line: SINGLE_LINE,
			},
			children: [image],
		});
		if (tag.caption) {
			pushParagraph(out, writer, context, {
				alignment: AlignmentType.CENTER,
				spacing: { after: BODY_AFTER + 60, line: SINGLE_LINE },
				children: [
					textRun(proseText(tag.caption), {
						font: writer.fonts.body,
						color: writer.colors.muted,
						size: CAPTION_SIZE,
					}),
				],
			});
		}
		return;
	}
	const fallback = rawHtmlFallback(node.value);
	if (fallback.kind === "break") {
		pushParagraph(out, writer, context, { children: [] });
		return;
	}
	if (fallback.kind === "external-image") {
		writer.externalImages++;
		return;
	}
	if (fallback.kind === "omit") {
		return;
	}
	const style = bodyRunStyle(writer);
	const lines = xmlText(fallback.text).split(/\r\n|\r|\n/);
	pushParagraph(out, writer, context, {
		children: lines.map((line, index) =>
			index === 0
				? textRun(line.replace(/\t/g, " "), style)
				: new TextRun({
						text: line.replace(/\t/g, " "),
						break: 1,
						...runProperties(style),
					}),
		),
	});
}
