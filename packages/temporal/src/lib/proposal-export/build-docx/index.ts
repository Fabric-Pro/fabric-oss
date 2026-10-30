/**
 * The Word writer of the Proposal export (Fizzy #2946): Main, already
 * scrubbed and parsed into mdast, laid out as a branded DOCX.
 *
 * The file has three parts, each its own Word section:
 *
 * 1. a cover with no running header or footer: the proposer's and the
 *    recipient's logos, the hero, a "Proposal" eyebrow, the title in the
 *    Title style, "Prepared for" / "Prepared by" and the date. Every cover
 *    field comes from data; nothing is written in when a field is missing.
 * 2. a contents page: a TOC field over the Heading 2 sections, which Word
 *    fills in with page numbers when it opens the file (`updateFields`).
 * 3. the body, in portrait Letter, except that a table wider than six
 *    columns gets a landscape section of its own and the body continues in
 *    portrait after it.
 *
 * Everything a reader of the file sees comes from the walk below; the file
 * holds no relationship to anything outside itself except the http(s) and
 * mailto links `safeLinkHref` keeps. Images are the stored bytes the image
 * reader re-encoded, embedded rather than linked, and a Markdown image
 * (`![alt](url)`) is never fetched: it is left out and counted.
 *
 * Text is handed to docx as text (docx escapes it for XML); nothing here
 * builds an XML string. Raw HTML is never interpreted: a `<br>` is a line
 * break, an uploaded image tag is its stored image, and anything else is
 * printed as its literal text.
 *
 * The brand comes from `resolveThemePaint`, the same paint the print page
 * uses, so colours that fail contrast are already replaced. Fonts are named,
 * never embedded: Word substitutes a family it lacks, and without a hint it
 * falls back to its default, often a serif. So the neutral style, which
 * prints in Poppins, Inter and JetBrains Mono, is written as Arial, which
 * every Word has; a font the brand chose keeps its name.
 */

import { resolveThemePaint } from "@repo/utils/proposal-artifact/theme-tokens";
import { Document, Packer } from "docx";
import { diagramFigureNumbers, type ProposalExportWarning } from "../types";
import { ExportWarningTally } from "../warnings";
import { bodySections, contentsSection, coverSection } from "./sections";
import { documentStyles, docxColors, docxFonts, listLevels } from "./styles";
import {
	type BuildDocxInput,
	collectDefinitions,
	partyName,
	type Writer,
	xmlText,
} from "./writer";

export type { BuildDocxInput } from "./writer";

export interface BuildDocxResult {
	buffer: Buffer;
	warnings: ProposalExportWarning[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Lay Main out as a DOCX. Never fetches anything: every image is either in
 * `images`, in a diagram render, or in the tokens, or it is not printed.
 *
 * Warnings: `EXTERNAL_IMAGE_DROPPED`, for images with no stored upload, and
 * `IMAGE_LIMIT`, for placements past the placement budget. Placeholders,
 * missing uploads and unreadable logos are reported by whichever step
 * produced them (the diagram renderer and the image reader), so they are
 * not counted twice.
 */
export async function buildProposalDocx(
	input: BuildDocxInput,
): Promise<BuildDocxResult> {
	const paint = resolveThemePaint(input.tokens);
	const writer: Writer = {
		input,
		colors: docxColors(paint),
		fonts: docxFonts(input.tokens, paint),
		definitions: collectDefinitions(input.prepared.root),
		lists: [],
		contents: [],
		externalImages: 0,
		placedImageBytes: 0,
		imagesOverLimit: 0,
		drawings: 0,
		figureNumbers: diagramFigureNumbers(input.diagrams),
	};

	// The cover first, so its logos and hero are placed before any body
	// image can spend the placement budget.
	const cover = coverSection(writer);
	const body = bodySections(writer);
	const contents = contentsSection(writer);

	const document = new Document({
		title: xmlText(input.title),
		creator: xmlText(partyName(input.tokens.proposer.name.value) ?? ""),
		lastModifiedBy: "",
		// Word fills the TOC field, and the page numbers in it, when it opens
		// the file; it asks first, because the file holds fields.
		features: { updateFields: true },
		styles: documentStyles(writer),
		numbering: {
			config: writer.lists.map((list) => ({
				reference: list.reference,
				levels: listLevels(writer, list),
			})),
		},
		sections: [cover, contents, ...body],
	});

	const buffer = await Packer.toBuffer(document);
	const tally = new ExportWarningTally();
	tally.add("EXTERNAL_IMAGE_DROPPED", writer.externalImages);
	tally.add("IMAGE_LIMIT", writer.imagesOverLimit);
	return { buffer, warnings: tally.warnings() };
}
