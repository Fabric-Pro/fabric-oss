/**
 * The Word writer's shared state and text helpers (Fizzy #2946): what every
 * part of the walk reads and writes, and the runs it sets text in.
 */

import type { ProposalThemePaint } from "@repo/utils/proposal-artifact/theme-tokens";
import { type IParagraphOptions, type Table, TextRun } from "docx";
import type { Nodes } from "mdast";
import { eachNode, type PreparedExportMarkdown } from "../markdown";
import type {
	ExportDiagram,
	ExportDocumentImages,
	ExportThemeTokens,
} from "../types";

export interface BuildDocxInput {
	prepared: PreparedExportMarkdown;
	/** The diagram renders, by `prepared.diagramIndex`. */
	diagrams: readonly ExportDiagram[];
	/** Uploaded images by storage key, already re-encoded. */
	images: ExportDocumentImages;
	tokens: ExportThemeTokens;
	projectId: string;
	documentId: string;
	/** The document's title, for the cover, the running header and the footer. */
	title: string;
	/** The date as the cover and the footer print it, already formatted. */
	dateLabel: string;
}

// ---------------------------------------------------------------------------
// Writer state
// ---------------------------------------------------------------------------

/** Paint colours in the `RRGGBB` form docx writes. */
export interface DocxColors {
	surface: string;
	ink: string;
	heading: string;
	primary: string;
	onPrimary: string;
	muted: string;
	border: string;
	tint: string;
	/** A faint wash of ink on the paper, behind code. */
	wash: string;
}

export interface ListDefinition {
	reference: string;
	ordered: boolean;
	start: number;
}

export interface Writer {
	input: BuildDocxInput;
	colors: DocxColors;
	fonts: ProposalThemePaint["fonts"];
	/** Link reference definitions, by their normalised identifier. */
	definitions: ReadonlyMap<string, string>;
	/** One numbering definition per list node, in document order. */
	lists: ListDefinition[];
	/** Every Heading 2's text, for the contents shown before Word updates it. */
	contents: string[];
	/** Markdown images left out. */
	externalImages: number;
	/** Image bytes placed so far (cover, uploads, diagrams), repeats included. */
	placedImageBytes: number;
	/** Image placements left out past the placement budget. */
	imagesOverLimit: number;
	/** Drawings placed so far, for each one's own id. */
	drawings: number;
}

/** Where a block is being laid out. */
export interface BlockContext {
	/** The text column's width here, in twips. */
	textWidth: number;
	/** Left indent of plain paragraphs, in twips (list continuations). */
	indent: number;
	/** Inside a blockquote, which prints as a callout. */
	callout: boolean;
	/** List nesting depth of a list started here. */
	listDepth: number;
}

/** What a block emits: paragraph options, built once spacing is settled, or a table. */
export type Out = { paragraph: IParagraphOptions } | { table: Table };

/** How a run of inline text is set. */
export interface RunStyle {
	font: string;
	color: string;
	size?: number;
	bold?: boolean;
	italics?: boolean;
	strike?: boolean;
	allCaps?: boolean;
	characterSpacing?: number;
	superScript?: boolean;
	/** Inside a kept hyperlink. */
	link?: boolean;
	/** A kept link's text and underline colours here. */
	linkColor?: string;
	linkUnderline?: string;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Characters XML 1.0 cannot hold (C0 controls other than tab and line ends,
 * U+FFFE, U+FFFF) and unpaired surrogates. docx escapes markup but passes
 * these through, and one of them makes Word refuse the whole file.
 */
const XML_INVALID =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
	/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function xmlText(text: string): string {
	return text.replace(XML_INVALID, "");
}

/** Prose text: a soft line break or a tab reads as a space. */
export function proseText(text: string): string {
	return xmlText(text).replace(/[ \t]*[\r\n\t][ \t]*/g, " ");
}

export function partyName(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

export function textRun(text: string, style: RunStyle): TextRun {
	return new TextRun({
		text,
		...runProperties(style),
	});
}

/**
 * Every run names its font and colour, not only the styles: some readers
 * (Quick Look among them) ignore the document defaults.
 */
export function runProperties(style: RunStyle) {
	return {
		font: style.font,
		color: style.color,
		size: style.size,
		bold: style.bold,
		italics: style.italics,
		strike: style.strike,
		allCaps: style.allCaps,
		characterSpacing: style.characterSpacing,
		superScript: style.superScript,
		...(style.link
			? {
					style: "Hyperlink",
					underline: {
						type: "single" as const,
						color: style.linkUnderline,
					},
				}
			: {}),
	};
}

export function bodyRunStyle(writer: Writer): RunStyle {
	return {
		font: writer.fonts.body,
		color: writer.colors.ink,
		linkColor: writer.colors.heading,
		linkUnderline: writer.colors.primary,
	};
}

export function collectDefinitions(root: Nodes): Map<string, string> {
	const definitions = new Map<string, string>();
	eachNode(root, (node) => {
		if (node.type === "definition" && !definitions.has(node.identifier)) {
			definitions.set(node.identifier, node.url);
		}
	});
	return definitions;
}
