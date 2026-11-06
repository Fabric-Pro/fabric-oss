/**
 * The Word writer of the Proposal export (Fizzy #2946): Main, already
 * scrubbed and parsed into mdast, laid out as a branded DOCX.
 *
 * The file has up to four parts, each its own Word section:
 *
 * 1. a cover on the ink, as print's, with no running footer: the
 *    proposer's and the recipient's logos, the hero, a "Proposal" eyebrow,
 *    the title in the Title style and the lead in light text, then
 *    "Prepared for" / "Prepared by" and the date line at the foot. Every
 *    cover field comes from data; nothing is written in when a field is
 *    missing. The title is Main's leading H1 when Main opens with one and
 *    has sections, as on the print cover, and the body then leaves that H1
 *    out; so too the lead, the preamble's first paragraph when print's
 *    cover takes it (`coverPreamble`). A `cover` fence in Main's preamble
 *    sets the eyebrow, a line about the client under the logos, the party
 *    lines and the version, and the body leaves that fence out.
 * 2. a cover letter, when Main's first section is one: the proposer's logo
 *    and the letter, in a section of its own with the running footer. Its
 *    heading is no Heading 2, so the contents never list it.
 * 3. a contents page: a TOC field over the Heading 2 sections, which Word
 *    fills in with page numbers when it opens the file (`updateFields`).
 * 4. the body, in portrait Letter, except that a table wider than six
 *    columns gets a landscape section of its own and the body continues in
 *    portrait after it. Each section opens on a new page with print's ink
 *    card: its "Section N" eyebrow, its Heading 2 and its subtitle.
 *
 * Like print, the file runs no header; every page after the cover carries
 * the footer "proposer · title · date · Confidential" and "Page N of M".
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
 * uses, so colours that fail contrast are already replaced. A role in the
 * neutral style is set in the face print uses, Poppins, Inter or JetBrains
 * Mono, and the file embeds that face (with Inter's bold and JetBrains
 * Mono's Medium), since Word substitutes a family it lacks; see
 * `embedded-fonts.ts`. A font the brand chose keeps its name and is never
 * embedded.
 */

import { resolveThemePaint } from "@repo/utils/proposal-artifact/theme-tokens";
import { Document, Packer } from "docx";
import sharp from "sharp";
import { coverPreamble } from "../build-cover-html";
import { coverFence, coverLetter, printedTitle } from "../document-content";
import { diagramFigureNumbers, type ProposalExportWarning } from "../types";
import { ExportWarningTally } from "../warnings";
import { docxEmbeddedFonts, finishEmbeddedFonts } from "./embedded-fonts";
import {
	bodySections,
	contentsSection,
	coverSection,
	letterSection,
} from "./sections";
import {
	brandFontFamilies,
	documentStyles,
	docxColors,
	docxFonts,
	docxMonoMedium,
	listLevels,
	neutralFontRoles,
} from "./styles";
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
 * The cover's ink as a small PNG of the one colour, which Word stretches to
 * the page behind the cover's text (see `coverSection`).
 */
function inkBackdrop(ink: string): Promise<Buffer> {
	return sharp({
		create: { width: 8, height: 8, channels: 3, background: ink },
	})
		.png()
		.toBuffer();
}

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
	const neutralRoles = neutralFontRoles(input.tokens, paint);
	// Main's leading H1, when it is the title, as print takes it; the
	// download keeps the record's name, which is the caller's.
	const title = printedTitle(input.prepared.root, input.title);
	const writer: Writer = {
		input,
		title: title.text,
		titleHeading: title.heading,
		coverFence: coverFence(input.prepared.root),
		lead: coverPreamble(input.prepared.root).lead,
		letter: coverLetter(input.prepared.root),
		colors: docxColors(paint),
		fonts: docxFonts(input.tokens, paint),
		monoMedium: docxMonoMedium(input.tokens, paint),
		definitions: collectDefinitions(input.prepared.root),
		lists: [],
		contents: [],
		sectionNumber: 0,
		externalImages: 0,
		placedImageBytes: 0,
		imagesOverLimit: 0,
		drawings: 0,
		figureNumbers: diagramFigureNumbers(input.diagrams),
	};

	// The cover first, so its logos and hero are placed before any body
	// image can spend the placement budget, then the letter, as they read.
	const cover = coverSection(writer, await inkBackdrop(paint.ink));
	const letter = letterSection(writer);
	const body = bodySections(writer);
	const contents = contentsSection(writer);

	const document = new Document({
		title: xmlText(writer.title),
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
		sections: [cover, ...(letter ? [letter] : []), contents, ...body],
		// The print faces of the neutral roles travel in the file; a brand's
		// font is only named.
		...(neutralRoles.length > 0
			? { fonts: docxEmbeddedFonts(neutralRoles) }
			: {}),
	});

	const buffer = await finishEmbeddedFonts(
		await Packer.toBuffer(document),
		brandFontFamilies(input.tokens, paint),
	);
	const tally = new ExportWarningTally();
	tally.add("EXTERNAL_IMAGE_DROPPED", writer.externalImages);
	tally.add("IMAGE_LIMIT", writer.imagesOverLimit);
	return { buffer, warnings: tally.warnings() };
}
