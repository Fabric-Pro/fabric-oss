/**
 * The Proposal's print page front matter (Fizzy #2946): the cover, made of
 * the fields the data holds and the preamble it lifts out of Main, and the
 * contents page. The body itself is `build-theme-html`'s, which calls these
 * in reading order.
 */

import {
	PROPOSAL_PRINT_CLASSES,
	PROPOSAL_THEME_CLASSES,
} from "@repo/utils/proposal-artifact/proposal-theme";
import {
	parseStatTiles,
	STAT_TILES_LANGUAGE,
	type StatTileItem,
} from "@repo/utils/proposal-artifact/stat-tiles";
import type { Code, Nodes, Paragraph } from "mdast";
import type {
	BuildThemeHtmlInput,
	ExportSection,
	ThemeHtmlPass,
} from "./build-theme-html";
import type { PreparedExportMarkdown } from "./markdown";
import {
	dataUrl,
	escapeHtml,
	isEmbeddable,
	isImageParagraph,
	plainText,
	present,
} from "./print-markup";
import {
	COVER_LOGO_DARK_LUMINANCE,
	type ExportRaster,
	type ExportThemeTokens,
} from "./types";

const THEME = PROPOSAL_THEME_CLASSES;
const PRINT = PROPOSAL_PRINT_CLASSES;

/**
 * The longest first paragraph, in characters, the cover takes as its lead;
 * a longer one stays in the body.
 */
const COVER_LEAD_MAX_CHARACTERS = 320;

/**
 * The most tiles a stat tiles block may hold to print on the cover as its
 * key figures; a larger block stays whole in the body.
 */
const COVER_MAX_FIGURES = 3;

/**
 * A number typed at the start of a heading, such as "1. " or "2) ", which
 * the opener's eyebrow already says, so the contents page leaves it out.
 */
const TYPED_SECTION_NUMBER = /^\d{1,2}[.):]\s+(?=\S)/;

/** What the cover lifts out of Main, already rendered. */
export interface CoverContent {
	/** The lead's inline HTML, or null. */
	lead: string | null;
	/** The key figures, none when the preamble has no block that fits. */
	figures: readonly StatTileItem[];
}

/**
 * Whether a paragraph introduces the block after it, so lifting it would
 * strand that block: it ends with a colon, or a list, a table or a fence
 * follows it. The stat tiles fence the cover takes along is not stranded.
 */
function introducesNext(
	node: Paragraph,
	next: Nodes | undefined,
	lifted: Code | undefined,
): boolean {
	return (
		plainText(node).endsWith(":") ||
		next?.type === "list" ||
		next?.type === "table" ||
		(next?.type === "code" && next !== lifted)
	);
}

/**
 * The preamble the cover takes from Main: what comes before the first
 * heading, past one H1 that opens Main, and only when Main has sections at
 * all. Its first paragraph is the lead when it is short enough and does not
 * introduce the block after it; its first stat tiles block is the key
 * figures when it has at most three tiles. Whatever the cover takes, the
 * body leaves out; whatever it leaves, prints in the body as before.
 */
export function coverPreamble(root: PreparedExportMarkdown["root"]): {
	lead: Paragraph | null;
	figures: { node: Code; items: StatTileItem[] } | null;
} {
	const children = root.children;
	// A Main without sections prints whole, as it was written.
	if (!children.some((node) => node.type === "heading" && node.depth === 2)) {
		return { lead: null, figures: null };
	}
	let first: { node: Paragraph; next: Nodes | undefined } | undefined;
	let figures: { node: Code; items: StatTileItem[] } | null | undefined;
	const opener = children[0];
	const start = opener?.type === "heading" && opener.depth === 1 ? 1 : 0;
	for (let index = start; index < children.length; index++) {
		const node = children[index];
		if (!node || node.type === "heading") {
			break;
		}
		if (node.type === "paragraph" && first === undefined) {
			first = { node, next: children[index + 1] };
		} else if (
			node.type === "code" &&
			node.lang === STAT_TILES_LANGUAGE &&
			figures === undefined
		) {
			const parsed = parseStatTiles(node.value);
			figures =
				parsed.ok && parsed.items.length <= COVER_MAX_FIGURES
					? { node, items: parsed.items }
					: null;
		}
	}
	// Only the first paragraph is ever the lead.
	const text = first ? plainText(first.node) : "";
	const lead =
		first !== undefined &&
		text !== "" &&
		Array.from(text).length <= COVER_LEAD_MAX_CHARACTERS &&
		!isImageParagraph(first.node) &&
		!introducesNext(first.node, first.next, figures?.node)
			? first.node
			: null;
	return { lead, figures: figures ?? null };
}

/** A heading as the contents page lists it: without a typed number. */
function contentsTitle(title: string): string {
	return title.replace(TYPED_SECTION_NUMBER, "");
}

/** The hero as a `data:` URL, or null when there is none to print. */
function heroDataUrl(tokens: ExportThemeTokens): string | null {
	const hero = tokens.proposer.hero.value;
	return hero ? dataUrl(hero) : null;
}

/** Whether there is a hero to print, without encoding it. */
export function hasHeroImage(tokens: ExportThemeTokens): boolean {
	const hero = tokens.proposer.hero.value;
	return hero ? isEmbeddable(hero) : false;
}

/**
 * The body's own style: the hero, once, as the custom property the cover
 * reads, and its small copy, when it has one, as the one every opener
 * graphic reads. A data URL's characters need no quoting inside `url()`.
 */
export function bodyStyle(tokens: ExportThemeTokens): string {
	const hero = heroDataUrl(tokens);
	if (hero === null) {
		return "";
	}
	const copy = tokens.proposer.hero.value?.openerCopy;
	const opener = copy ? dataUrl(copy) : null;
	const properties = [
		`--pa-hero-image: url(${hero})`,
		...(opener ? [`--pa-hero-opener-image: url(${opener})`] : []),
	];
	return ` style="${escapeHtml(properties.join("; "))}"`;
}

/** Whether a logo was drawn for a light background, so needs the plate. */
function needsPlate(raster: ExportRaster): boolean {
	return (
		raster.opaque === true ||
		(raster.luminance !== undefined &&
			raster.luminance < COVER_LOGO_DARK_LUMINANCE)
	);
}

/**
 * The cover: fields the data or the document holds, and nothing it does not
 * (Fizzy #2946). The eyebrow, the title and the date line always; each logo,
 * each party and the hero only when the tokens hold it; the lead and the key
 * figures only when Main's preamble has them. Nothing is written empty.
 */
export function coverHtml(
	input: BuildThemeHtmlInput,
	content: CoverContent,
): string {
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
		if (raster === null || src === null) {
			return "";
		}
		const plate = needsPlate(raster) ? ` ${PRINT.coverLogoPlate}` : "";
		return `<img class="${PRINT.coverLogo} ${role}${plate}" src="${escapeHtml(src)}" alt="${escapeHtml(name ? `${name} logo` : fallback)}">`;
	};
	const logos =
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
	const brands =
		logos === "" ? "" : `<div class="${PRINT.coverBrands}">${logos}</div>`;

	// A background, so it is never read as content; the hero itself is the
	// body's `--pa-hero-image`.
	const hero = hasHeroImage(tokens)
		? `<div class="${PRINT.coverHero}"></div>`
		: "";

	const lead =
		content.lead === null
			? ""
			: `<p class="${PRINT.coverLead}">${content.lead}</p>`;
	const figures =
		content.figures.length === 0
			? ""
			: `<dl class="${PRINT.coverFigures}">${content.figures
					.map(
						(item) =>
							`<div><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd></div>`,
					)
					.join("")}</dl>`;

	const preparedFor =
		recipient === null
			? ""
			: `<dl class="${PRINT.coverPartyFor}"><dt>Prepared for</dt><dd>${escapeHtml(recipient)}</dd></dl>`;
	const preparedBy =
		proposer === null
			? ""
			: `<dl><dt>Prepared by</dt><dd>${escapeHtml(proposer)}</dd></dl>`;
	const dateLine = [present(input.dateLabel), "Confidential"]
		.filter((part): part is string => part !== null)
		.join(" · ");

	return [
		`<section class="${THEME.cover}">`,
		hero,
		brands,
		`<div class="${PRINT.coverBody}">`,
		`<p class="${PRINT.eyebrow}">Proposal</p>`,
		`<h1 class="${PRINT.coverTitle}">${escapeHtml(input.title.trim())}</h1>`,
		lead,
		figures,
		"</div>",
		`<div class="${PRINT.coverParties}">`,
		preparedFor,
		`<div class="${PRINT.coverPartyBy}">${preparedBy}<p class="${PRINT.coverDate}">${escapeHtml(dateLine)}</p></div>`,
		"</div>",
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
 * The contents page, or nothing for a document without sections: the
 * document's title as its eyebrow over a "Contents" heading, then the
 * entries. Every entry's leader and slot are the same markup in both passes,
 * only the slot's text differs, and the slot's width is fixed by the theme.
 */
export function contentsHtml(
	sections: readonly ExportSection[],
	pass: ThemeHtmlPass,
	title: string,
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
		return `<li><a href="#${section.id}">${escapeHtml(contentsTitle(section.title))}</a>${slot}</li>`;
	});
	const eyebrow = present(title);
	return [
		`<nav class="${PRINT.contents}" aria-label="Contents">`,
		eyebrow === null
			? ""
			: `<p class="${PRINT.eyebrow}">${escapeHtml(eyebrow)}</p>`,
		`<p class="${PRINT.contentsTitle}">Contents</p>`,
		`<ol>${entries.join("")}</ol></nav>`,
	].join("");
}
