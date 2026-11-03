/**
 * The print layer of the Proposal theme (`./proposal-theme`): the classes
 * only the print page writes, the page size, and what the print body lays
 * over the base layer. That is the cover and the landscape pages as named
 * pages, the running footer as `@page` margin boxes, the section openers and
 * the contents page. The cover letter's rules are in
 * `./proposal-theme-print-letter`; the page size and margins, the `@page`
 * blocks, the opener room and the figure height limits are in
 * `./proposal-theme-print-page-flow`.
 *
 * `proposalThemeCss("print", …)` is the way in, and `./proposal-theme`
 * re-exports this module's public names, so importers keep one path.
 *
 * Pure functions and data only: client components import this module, so it
 * must not pull in anything the browser bundle cannot carry.
 */

import { letterRules } from "./proposal-theme-print-letter";
import {
	BODY_TEXT,
	figureHeightRules,
	OPENER_TEXT,
	openerRoomRules,
	PAGE_HEIGHTS,
	PROPOSAL_PAGE_SIZE,
	pageRules,
} from "./proposal-theme-print-page-flow";
import {
	block,
	type Declarations,
	dot,
	emitRules,
	FONT_DISPLAY,
	FONT_MONO_ROLE,
	HEADINGS,
	NEUTRAL_FAMILY,
	NO_CONTEXTUAL,
	PROPOSAL_THEME_CLASSES,
	rule,
	type ThemeRule,
	ZEBRA,
} from "./proposal-theme-rules";
import { NEUTRAL_THEME, safeFontFamily } from "./theme-tokens";

export {
	type OpenerPageBlock,
	PRINT_FIGURE_MAX_HEIGHT_PROPERTY,
	PRINT_FIGURE_MAX_HEIGHT_PX,
	PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX,
	PROPOSAL_PAGE_SIZE,
	PROPOSAL_PAGE_SIZE_LANDSCAPE,
	printFigureUnderOpenerMaxHeightPx,
} from "./proposal-theme-print-page-flow";

/**
 * Classes only the print page writes: the parts of the cover, the eyebrow
 * label, the contents page, the page markers, diagrams, footnotes and the
 * landscape wrapper.
 *
 * The cover is laid out as
 *
 * ```html
 * <section class="pa-cover">
 *   <div class="pa-cover-hero" style="background-image: url(data:…)"></div>
 *   <div class="pa-cover-brands">
 *     <img class="pa-cover-logo pa-cover-logo-proposer" alt="…">
 *     <img class="pa-cover-logo pa-cover-logo-recipient pa-cover-logo-plate" alt="…">
 *   </div>
 *   <div class="pa-cover-body">
 *     <p class="pa-eyebrow">Proposal</p>
 *     <h1 class="pa-cover-title">…</h1>
 *     <p class="pa-cover-lead">…</p>
 *     <dl class="pa-cover-figures">
 *       <div><dt>label</dt><dd>value</dd></div>
 *     </dl>
 *   </div>
 *   <div class="pa-cover-parties">
 *     <dl class="pa-cover-party-for"><dt>Prepared for</dt><dd>…</dd></dl>
 *     <div class="pa-cover-party-by">
 *       <dl><dt>Prepared by</dt><dd>…</dd></dl>
 *       <p class="pa-cover-date">… · Confidential</p>
 *     </div>
 *   </div>
 * </section>
 * ```
 *
 * Whatever the cover has nothing for is left out rather than written empty:
 * the hero, either logo, the brands row when there is neither, the lead,
 * the figures and either party. The proposer logo holds the left edge and
 * the recipient logo the right one on its own; a logo drawn for a light
 * background carries `pa-cover-logo-plate`. The "Prepared by" column, which
 * always holds the date line, keeps its place without "Prepared for".
 *
 * A `cover` fence in Main's preamble adds to it: its eyebrow in place of
 * "Proposal", its `for:` and `by:` lines as one `<dd>` each in place of the
 * party names, its version on the date line, and its organization line as
 * `<p class="pa-cover-organization">` after the brands row, out of flow at
 * the top right, under the recipient logo.
 *
 * A cover letter, Main's first section when its heading is "Cover letter"
 * or "Anschreiben", prints on its own page after the cover:
 *
 * ```html
 * <section class="pa-letter" aria-label="Cover letter">
 *   <div class="pa-letter-head">
 *     <img class="pa-letter-logo" alt="…">
 *     <p class="pa-letter-label">Cover letter</p>
 *   </div>
 *   <p class="pa-letter-date">12 March 2027</p>
 *   <p>…</p>
 *   <p class="pa-letter-subject">Re: …</p>
 *   <p class="pa-letter-signer"><strong>…</strong></p>
 *   <p class="pa-letter-signer-role">…</p>
 * </section>
 * ```
 *
 * It is no section: no opener, no number, no contents entry and no page
 * marker. The running footer prints on it as on every page after the cover.
 *
 * A section opener is an ink card, its "Section N" eyebrow a CSS counter:
 *
 * ```html
 * <header class="pa-section-opener" id="pa-section-2">
 *   <div class="pa-section-graphic" aria-hidden="true"></div>
 *   <h2>…</h2>
 *   <p>…</p>
 * </header>
 * ```
 *
 * The graphic is there only when the Brand kit has a hero, and the subtitle
 * only when the paragraph after the heading is one short emphasis. The hero
 * is written once, as `--pa-hero-image` on the body, and the cover reads
 * it; every graphic reads its small copy, `--pa-hero-opener-image`, when
 * the body has one, so the bytes are embedded once however many sections
 * there are, and each crop print writes of them stays small. Every opener
 * starts a page, unless the section before it ends in a short tail: lines
 * that ran onto a page of their own and fill no more than a quarter of it.
 * The opener then follows them on that page, so no page is left almost
 * empty. Every opener after the first, except one that opens a landscape
 * page, comes right after an empty room block that decides which:
 *
 * ```html
 * <div class="pa-opener-room" aria-hidden="true"></div>
 * <header class="pa-section-opener" id="pa-section-2">…</header>
 * ```
 *
 * An appendix opener takes no section number. It carries
 * `pa-appendix` and its eyebrow as a `data-label` attribute, "Appendix A"
 * or "Appendix" alone, which the eyebrow shows in place of "Section N":
 *
 * ```html
 * <header class="pa-section-opener pa-appendix" id="pa-section-4" data-label="Appendix A">
 * ```
 *
 * The contents page is a `<nav class="pa-contents">` around an eyebrow and
 * an `ol` of entries, each
 *
 * ```html
 * <li>
 *   <a href="#pa-section-3">…</a>
 *   <span class="pa-contents-leader"></span>
 *   <span class="pa-contents-page">7</span>
 * </li>
 * ```
 *
 * An appendix's entry is `<li class="pa-appendix" data-label="A">`: it shows
 * its letter, or nothing, in place of a number, and the count of the
 * entries after it carries on as though it were not there.
 *
 * Chromium has no `target-counter()`, so the page numbers come from a second
 * print pass. The first prints every opener with a `pa-page-marker` (a text
 * marker that takes no space) and every number slot empty; the pages the
 * markers land on fill the slots of the second, which lays out exactly as
 * the first did because a slot's width never depends on what it holds.
 *
 * Named pages apply only to block-level boxes in normal flow, so the cover
 * and every landscape wrapper must not sit inside a flex or grid container.
 */
export const PROPOSAL_PRINT_CLASSES = {
	eyebrow: "pa-eyebrow",
	coverBrands: "pa-cover-brands",
	coverLogo: "pa-cover-logo",
	proposerLogo: "pa-cover-logo-proposer",
	recipientLogo: "pa-cover-logo-recipient",
	/** A logo drawn for a light background, set on a light plate. */
	coverLogoPlate: "pa-cover-logo-plate",
	coverBody: "pa-cover-body",
	coverTitle: "pa-cover-title",
	coverLead: "pa-cover-lead",
	/** Up to three key figures, each over a rule. */
	coverFigures: "pa-cover-figures",
	/** The block pinned to the cover's foot. */
	coverParties: "pa-cover-parties",
	coverPartyFor: "pa-cover-party-for",
	coverPartyBy: "pa-cover-party-by",
	coverDate: "pa-cover-date",
	/** The optional hero: a darkened background layer of the upper cover. */
	coverHero: "pa-cover-hero",
	/**
	 * The cover fence's line about the client, under the recipient logo at
	 * the right edge. Out of flow, so the title keeps its height.
	 */
	coverOrganization: "pa-cover-organization",
	/** The cover letter's page, between the cover and the contents. */
	letter: "pa-letter",
	/** The letter's top row: the proposer logo left, its label right. */
	letterHead: "pa-letter-head",
	letterLogo: "pa-letter-logo",
	/** A logo drawn for a dark background, set on a plate of the ink. */
	letterLogoPlate: "pa-letter-logo-plate",
	/** The letter's heading, as a quiet label rather than a heading element. */
	letterLabel: "pa-letter-label",
	/** The letter's first short line, its date. */
	letterDate: "pa-letter-date",
	/** A paragraph starting "Re:". */
	letterSubject: "pa-letter-subject",
	/** The last wholly bold paragraph: the signer's name. */
	letterSigner: "pa-letter-signer",
	/** The paragraph right after the signer's name. */
	letterSignerRole: "pa-letter-signer-role",
	/** The hero again, cropped to a section opener's right side. */
	sectionGraphic: "pa-section-graphic",
	/**
	 * The room an opener needs below the previous section's last lines: an
	 * empty block, laid out but drawing nothing, right before the opener.
	 * When it fits on their page the opener follows them there; when it
	 * does not, it moves to the next page and the opener starts that page.
	 */
	openerRoom: "pa-opener-room",
	contents: "pa-contents",
	/** The contents page's "Contents" heading, under the title eyebrow. */
	contentsTitle: "pa-contents-title",
	/**
	 * The empty space between a contents entry's title and its page, which
	 * pushes the page number to the right edge. Drawn as nothing.
	 */
	contentsLeader: "pa-contents-leader",
	/** A contents entry's page number, in a box of fixed width. */
	contentsPage: "pa-contents-page",
	/**
	 * An appendix's section opener and contents entry. Its `data-label`
	 * attribute holds what each shows in place of a number.
	 */
	appendix: "pa-appendix",
	/**
	 * A data table whose header cells hold nothing, printed without a header
	 * row. Only print writes it; the live editor keeps its header row.
	 */
	headerless: "pa-headerless",
	/**
	 * The first print pass's marker inside a section opener: text a PDF
	 * reader extracts, laid out out of flow so it moves nothing. Never
	 * clipped to a tiny box, which drops the text from the PDF altogether.
	 */
	pageMarker: "pa-page-marker",
	/** A figure holding a rendered diagram's SVG. */
	diagram: "pa-diagram",
	/** A figure holding the caption of a diagram only the live page draws. */
	diagramPlaceholder: "pa-diagram-placeholder",
	/** A diagram caption's leading "Figure n.", written out as text. */
	figureNumber: "pa-figure-number",
	/** The notes a document's footnote references point at, at its end. */
	footnotes: "pa-footnotes",
	landscape: "pa-landscape",
} as const;

/**
 * The attribute an appendix's opener and contents entry carry the text they
 * show in place of a number in.
 */
export const PROPOSAL_LABEL_ATTRIBUTE = "data-label";

/**
 * The cover's geometry (Fizzy #2946): the brands row from the top margin,
 * the body from one fixed line below it, and room kept at the foot for the
 * parties, so the longest title and lead still end above them.
 */
const COVER_TOP = "0.7in";
const COVER_SIDE = "0.8in";
const COVER_BRANDS_HEIGHT = "0.56in";
/** A logo's height; a plated one adds its padding, within the row. */
const COVER_LOGO_HEIGHT = "0.36in";
const COVER_BODY_TOP = "3.05in";
/** The parties' block, its distance from the foot and the gap above it. */
const COVER_FOOT_RESERVE = "2in";
/**
 * The hero fades into the ink from the top right towards the text at the
 * lower left, and fully along its lower edge.
 */
const HERO_FADE =
	"linear-gradient(to bottom, transparent 55%, var(--pa-ink) 92%), linear-gradient(200deg, transparent 25%, var(--pa-ink) 85%)";

/** An opener's graphic fades into the ink along its left edge. */
const GRAPHIC_FADE =
	"linear-gradient(to right, var(--pa-ink), transparent 35%)";

/** The ink veil over a hero, wherever it is drawn. */
const HERO_VEIL: Declarations = {
	"background-color": "var(--pa-ink)",
	opacity: "var(--pa-hero-veil, 1)",
};

/** What the print layer needs that the stylesheet cannot work out itself. */
export interface ProposalPrintThemeOptions {
	/**
	 * Running footer text, "proposer · title · date · Confidential". Plain
	 * text, escaped here. The page counter is added on the right.
	 */
	runningFooter: string;
	/**
	 * The family the page furniture is set in. Margin boxes do not reliably
	 * resolve custom properties, so it is written as a literal; it must be
	 * the body family, embedded by the print page with `@font-face`, so the
	 * font is loaded when the margin boxes are laid out. Defaults to the
	 * neutral body font, Inter; a name `safeFontFamily` refuses falls back to
	 * it too.
	 */
	fontFamily?: string;
}

const THEME = PROPOSAL_THEME_CLASSES;
const PRINT = PROPOSAL_PRINT_CLASSES;

/** Print layer: body, page breaks, cover, section openers, contents. */
const PRINT_RULES: readonly ThemeRule[] = [
	rule(`${dot(THEME.sectionOpener)} a`, {
		color: "inherit",
		"text-decoration-color": "currentColor",
	}),
	rule("&", {
		margin: "0",
		padding: "0",
		"font-size": BODY_TEXT.size,
		"line-height": String(BODY_TEXT.lineHeight),
		color: "var(--pa-ink)",
		"background-color": "var(--pa-surface)",
		"-webkit-print-color-adjust": "exact",
		"print-color-adjust": "exact",
	}),
	rule("p", { "margin-top": "0", orphans: "3", widows: "3" }),
	rule(HEADINGS, { "break-after": "avoid", "break-inside": "avoid" }),
	rule("h3", { "font-size": "12.5pt" }),
	rule("pre", {
		"white-space": "pre-wrap",
		"overflow-wrap": "anywhere",
		"overflow-x": "visible",
	}),
	// Header rows repeat on every page a table spans.
	rule("thead", { display: "table-header-group" }),
	rule("tfoot", { display: "table-footer-group" }),
	// A table without a header row tints its second, fourth, sixth… row, so
	// its first row is plain, as under a header.
	rule(`${dot(PRINT.headerless)} tbody > tr:nth-child(odd) > td`, {
		"background-color": "transparent",
	}),
	rule(`${dot(PRINT.headerless)} tbody > tr:nth-child(even) > td`, {
		"background-color": ZEBRA,
	}),
	// Cards and columns at the exemplar's sizes. A columns block may run
	// longer than a page, so only its headings stay with what follows.
	rule(dot(THEME.cards), { gap: "10pt" }),
	rule(dot(THEME.card), { padding: "13pt 15pt" }),
	rule(dot(THEME.cardLabel), { "font-size": "8pt" }),
	rule(dot(THEME.cardTitle), { "font-size": "10.5pt" }),
	rule(dot(THEME.cardText), { "font-size": "9.1pt" }),
	rule(dot(THEME.columns), { "column-gap": "0.28in", "font-size": "9pt" }),
	rule(dot(THEME.columnHeading), {
		"font-size": "10.5pt",
		"break-after": "avoid",
	}),
	rule(
		[
			"tr",
			"img",
			"svg",
			"figure",
			dot(THEME.figure),
			dot(THEME.statTiles),
			dot(THEME.statTile),
			dot(THEME.card),
			"blockquote",
			dot(THEME.callout),
			dot(THEME.sectionOpener),
		],
		{ "break-inside": "avoid" },
	),
	// Captions read as labels in print, set in the mono role. A numbered
	// figure's caption starts at the column's left edge, its "Figure n." in
	// ink.
	rule(["figcaption", dot(THEME.caption)], {
		"font-family": FONT_MONO_ROLE,
		"font-size": "7.75pt",
	}),
	rule(`${dot(PRINT.diagram)} figcaption`, { "text-align": "left" }),
	// A figure's drawing is never taller than a page holds with its caption,
	// less an opener's room right below one.
	...figureHeightRules(),
	rule(dot(PRINT.figureNumber), {
		"font-weight": "500",
		color: "var(--pa-ink)",
	}),
	// An eyebrow on the paper is a label, in the label colour; the cover's,
	// on the ink, takes its own.
	rule(dot(PRINT.eyebrow), {
		margin: "0 0 0.9em",
		"font-family": FONT_MONO_ROLE,
		"font-size": "7.5pt",
		"font-weight": "500",
		"letter-spacing": "0.16em",
		"text-transform": "uppercase",
		color: "var(--pa-label)",
	}),
	// The cover: one dark page with no furniture. The hero is a darkened
	// layer behind everything; the brands and the body flow from the top,
	// so the title starts at the same height whatever the cover holds, and
	// only the parties are pinned to the foot. Block-level and out of any
	// flex or grid container, so the named page applies.
	rule(dot(THEME.cover), {
		page: "cover",
		"break-after": "page",
		"break-inside": "avoid",
		"box-sizing": "border-box",
		display: "block",
		position: "relative",
		height: PAGE_HEIGHTS[PROPOSAL_PAGE_SIZE],
		margin: "0",
		padding: `${COVER_TOP} ${COVER_SIDE} 0`,
		overflow: "hidden",
		color: "var(--pa-on-ink)",
		"background-color": "var(--pa-ink)",
	}),
	// The hero fills the upper cover under two layers of ink: a veil at the
	// paint's opacity, worked out so the cover's text reads at 4.5:1 even
	// over a pure white hero, and a fade into the plain ink towards the text
	// and along the lower edge. The fade only softens the edge; the veil is
	// what keeps the text legible. Painted over the hero rather than masking
	// it: Chromium's print output masks a large layer only in part.
	rule(dot(PRINT.coverHero), {
		position: "absolute",
		top: "0",
		right: "0",
		left: "0",
		height: "7.4in",
		"background-color": "transparent",
		"background-image": "var(--pa-hero-image)",
		"background-position": "center",
		"background-repeat": "no-repeat",
		"background-size": "cover",
	}),
	rule(
		[`${dot(PRINT.coverHero)}::before`, `${dot(PRINT.coverHero)}::after`],
		{ content: '""', position: "absolute", inset: "0" },
	),
	rule(`${dot(PRINT.coverHero)}::before`, HERO_VEIL),
	// Past the hero's lower edge, so the picture's own edge is under solid
	// ink rather than beside it, where a viewer draws a seam.
	rule(`${dot(PRINT.coverHero)}::after`, {
		bottom: "-0.25in",
		"background-image": HERO_FADE,
	}),
	// Drawn after the hero, so above it.
	rule([dot(PRINT.coverBrands), dot(PRINT.coverBody)], {
		position: "relative",
	}),
	// A row of fixed height, so the body below it starts at one place.
	rule(dot(PRINT.coverBrands), {
		display: "flex",
		"align-items": "center",
		"justify-content": "space-between",
		gap: "0.5in",
		height: COVER_BRANDS_HEIGHT,
	}),
	rule(dot(PRINT.coverLogo), {
		display: "block",
		width: "auto",
		height: "auto",
		"max-width": "2.4in",
		"max-height": COVER_LOGO_HEIGHT,
		"object-fit": "contain",
		"border-radius": "0",
	}),
	rule(dot(PRINT.recipientLogo), { "margin-inline-start": "auto" }),
	// A logo drawn for a light background sits on a plate of the paper.
	rule(dot(PRINT.coverLogoPlate), {
		padding: "7pt 10pt",
		"border-radius": "5pt",
		"background-color": "var(--pa-surface)",
	}),
	rule(dot(PRINT.coverBody), {
		"margin-top": `calc(${COVER_BODY_TOP} - ${COVER_TOP})`,
		// Ends a gap above the parties, whatever the title and lead hold.
		// The cover's content box starts at its top padding.
		"max-height": `calc(100% + ${COVER_TOP} - ${COVER_BODY_TOP} - ${COVER_FOOT_RESERVE})`,
		overflow: "hidden",
	}),
	// A general sibling: the organization line may sit between the two, out
	// of flow.
	rule(`${dot(PRINT.coverBrands)} ~ ${dot(PRINT.coverBody)}`, {
		"margin-top": `calc(${COVER_BODY_TOP} - ${COVER_TOP} - ${COVER_BRANDS_HEIGHT})`,
	}),
	// Under the recipient logo at the right edge, whether or not there is a
	// brands row: out of flow, so the title starts where it always does, and
	// after the hero, so drawn above it.
	rule(dot(PRINT.coverOrganization), {
		position: "absolute",
		top: `calc(${COVER_TOP} + ${COVER_BRANDS_HEIGHT})`,
		right: COVER_SIDE,
		left: "50%",
		margin: "0",
		"font-family": FONT_MONO_ROLE,
		"font-size": "7pt",
		"font-weight": "400",
		"line-height": "1.5",
		"letter-spacing": "0.12em",
		"text-transform": "uppercase",
		"text-align": "right",
		color: "var(--pa-on-ink-muted)",
	}),
	rule(`${dot(THEME.cover)} ${dot(PRINT.eyebrow)}`, {
		margin: "0 0 12pt",
		"font-size": "8pt",
		"letter-spacing": "0.18em",
		color: "var(--pa-on-ink-accent)",
	}),
	rule(dot(PRINT.coverTitle), {
		display: "-webkit-box",
		"-webkit-box-orient": "vertical",
		"-webkit-line-clamp": "3",
		"line-clamp": "3",
		overflow: "hidden",
		margin: "0 0 16pt",
		padding: "0",
		"font-family": FONT_DISPLAY,
		"font-size": "34pt",
		"font-weight": "700",
		"line-height": "1.08",
		"letter-spacing": "-0.02em",
		"text-wrap": "balance",
		color: "var(--pa-on-ink)",
		"background-image": "none",
	}),
	rule(dot(PRINT.coverLead), {
		margin: "0",
		"max-width": "5.7in",
		"font-size": "13pt",
		"line-height": "1.5",
		color: "var(--pa-on-ink-muted)",
	}),
	rule(`${dot(PRINT.coverLead)} a`, {
		color: "inherit",
		"text-decoration-color": "currentColor",
	}),
	// Up to three figures, each a third of the row from the left, so one or
	// two keep the width three would have.
	rule(dot(PRINT.coverFigures), {
		display: "grid",
		"grid-template-columns": "repeat(3, minmax(0, 1fr))",
		gap: "0.22in",
		"max-width": "6.4in",
		margin: "34pt 0 0",
		padding: "0",
	}),
	rule(`${dot(PRINT.coverFigures)} > div`, {
		display: "flex",
		"flex-direction": "column",
		"padding-top": "10pt",
		"border-top": "2pt solid var(--pa-on-ink-rule)",
	}),
	// The value reads first, over its label.
	rule(`${dot(PRINT.coverFigures)} dd`, {
		order: "-1",
		margin: "0 0 6pt",
		"font-family": FONT_DISPLAY,
		"font-size": "19pt",
		"font-weight": "700",
		"line-height": "1.15",
		"letter-spacing": "-0.01em",
		color: "var(--pa-on-ink)",
	}),
	rule(`${dot(PRINT.coverFigures)} dt`, {
		margin: "0",
		"font-size": "8.5pt",
		"line-height": "1.45",
		color: "var(--pa-on-ink-muted)",
	}),
	// Pinned to the foot: who it is for on the left, who it is from with the
	// date on the right, each in its own column whether or not the other is
	// there.
	rule(dot(PRINT.coverParties), {
		position: "absolute",
		right: COVER_SIDE,
		bottom: "0.75in",
		left: COVER_SIDE,
		display: "grid",
		"grid-template-columns": "minmax(0, 1fr) minmax(0, 1.25fr)",
		gap: "0.4in",
		"font-size": "9pt",
		"line-height": "1.55",
		color: "var(--pa-on-ink-muted)",
	}),
	rule(dot(PRINT.coverPartyFor), { "grid-column": "1", margin: "0" }),
	rule(dot(PRINT.coverPartyBy), { "grid-column": "2", margin: "0" }),
	rule(`${dot(PRINT.coverParties)} dl`, { margin: "0" }),
	rule(`${dot(PRINT.coverParties)} dt`, {
		margin: "0 0 5pt",
		"font-family": FONT_MONO_ROLE,
		"font-size": "7pt",
		"font-weight": "500",
		"letter-spacing": "0.16em",
		"text-transform": "uppercase",
		color: "var(--pa-on-ink-accent)",
	}),
	rule(`${dot(PRINT.coverParties)} dd`, { margin: "0" }),
	rule(dot(PRINT.coverDate), { margin: "0" }),
	// The cover letter's page, between the cover and the contents.
	...letterRules(PRINT, {
		brandsHeight: COVER_BRANDS_HEIGHT,
		logoHeight: COVER_LOGO_HEIGHT,
	}),
	// A section opener: an ink card, at the top of its own page or below a
	// short tail, with a "Section N" eyebrow, the heading, an optional
	// subtitle and an optional graphic. A forced break right after the
	// contents page, or a landscape page starting with the opener, is the
	// same break, so no page is left blank.
	rule(dot(THEME.sectionOpener), {
		// The containing block of the graphic and the first pass's marker.
		// Nothing clips it: the marker must never be cut by a corner.
		position: "relative",
		"counter-increment": "pa-section",
		"break-before": "page",
		"break-after": "avoid",
		"box-sizing": "border-box",
		"min-height": "1.35in",
		margin: `0 0 ${OPENER_TEXT.below}`,
		padding: `18pt ${OPENER_TEXT.sidePadding} 20pt`,
		"border-radius": "6pt",
		color: "var(--pa-on-ink)",
		"background-color": "var(--pa-ink)",
	}),
	// The room before an opener, which decides whether it follows a short
	// tail on that tail's page or starts the next.
	...openerRoomRules(PRINT),
	rule(`${dot(THEME.sectionOpener)}::before`, {
		content: '"Section " counter(pa-section)',
		position: "relative",
		display: "block",
		"margin-bottom": "8pt",
		"font-family": FONT_MONO_ROLE,
		"font-size": "7.5pt",
		"font-weight": "500",
		"line-height": "1.4",
		"letter-spacing": "0.16em",
		"text-transform": "uppercase",
		color: "var(--pa-on-ink-accent)",
	}),
	// An appendix takes no section number: its eyebrow is its own label,
	// "Appendix A", and the sections after it keep counting from the last.
	rule(`${dot(THEME.sectionOpener)}${dot(PRINT.appendix)}`, {
		"counter-increment": "none",
	}),
	rule(`${dot(THEME.sectionOpener)}${dot(PRINT.appendix)}::before`, {
		content: `attr(${PROPOSAL_LABEL_ATTRIBUTE})`,
	}),
	// Drawn after the graphic, so above it. Its text and the subtitle's are
	// set as the figure under an opener reads their lines (`OPENER_TEXT`).
	rule(`${dot(THEME.sectionOpener)} h2`, {
		position: "relative",
		margin: `0 0 ${OPENER_TEXT.heading.gap}`,
		padding: "0",
		"font-size": OPENER_TEXT.heading.size,
		"line-height": String(OPENER_TEXT.heading.lineHeight),
		color: "inherit",
		"background-color": "transparent",
		"border-radius": "0",
	}),
	rule(`${dot(THEME.sectionOpener)} h2:last-child`, { "margin-bottom": "0" }),
	rule(`${dot(THEME.sectionOpener)} p`, {
		position: "relative",
		"max-width": OPENER_TEXT.subtitle.maxWidth,
		margin: "0",
		"font-size": OPENER_TEXT.subtitle.size,
		"line-height": String(OPENER_TEXT.subtitle.lineHeight),
		color: "var(--pa-on-ink-muted)",
	}),
	// The hero on the card's right side, under the same veil as on the
	// cover and faded into the ink towards the text. It rounds its own
	// corners with the card's.
	rule(dot(PRINT.sectionGraphic), {
		position: "absolute",
		top: "0",
		right: "0",
		bottom: "0",
		left: "42%",
		"border-radius": "0 6pt 6pt 0",
		// Print writes a crop of the image per opener: the hero's small
		// copy keeps each one small.
		"background-image": "var(--pa-hero-opener-image, var(--pa-hero-image))",
		"background-position": "center",
		"background-repeat": "no-repeat",
		"background-size": "cover",
	}),
	rule(
		[
			`${dot(PRINT.sectionGraphic)}::before`,
			`${dot(PRINT.sectionGraphic)}::after`,
		],
		{
			content: '""',
			position: "absolute",
			inset: "0",
			"border-radius": "inherit",
		},
	),
	rule(`${dot(PRINT.sectionGraphic)}::before`, HERO_VEIL),
	// Past the graphic's left edge, so that edge sits under solid ink.
	rule(`${dot(PRINT.sectionGraphic)}::after`, {
		left: "-2pt",
		"background-image": GRAPHIC_FADE,
	}),
	// The marker the first print pass looks a section's page up by: out of
	// flow at the card's corner, above the graphic, so it moves nothing, and
	// drawn in the card's own text colour at a legible size, so the PDF's
	// text holds it whole. It is
	// deliberately not made invisible: Chromium's Linux print output leaves
	// transparent text out of the PDF altogether, and only the first pass,
	// which nobody sees, carries markers.
	rule(dot(PRINT.pageMarker), {
		position: "absolute",
		top: "0",
		left: "0",
		"z-index": "1",
		"font-size": "8px",
		"line-height": "1",
		"letter-spacing": "0",
		"white-space": "nowrap",
	}),
	// The contents page: numbered sections, each with the page it starts on,
	// which a second print pass writes in (Chromium has no `target-counter()`
	// to look them up with).
	rule(dot(PRINT.contents), { "break-after": "page" }),
	// Not a heading element: the heading rules would make it a section card.
	rule(dot(PRINT.contentsTitle), {
		margin: "0 0 0.6em",
		"font-family": FONT_DISPLAY,
		"font-size": "22pt",
		"font-weight": "700",
		"line-height": "1.15",
		"letter-spacing": "-0.015em",
		color: "var(--pa-ink)",
	}),
	rule(`${dot(PRINT.contents)} ol`, {
		"list-style": "none",
		"counter-reset": "pa-contents",
		margin: "0",
		padding: "0",
	}),
	rule(`${dot(PRINT.contents)} li`, {
		"counter-increment": "pa-contents",
		display: "flex",
		gap: "0.9em",
		"align-items": "baseline",
		margin: "0",
		padding: "0.55em 0",
		"border-bottom": "1px dashed var(--pa-border)",
	}),
	// Fixed-width figures in a fixed-width box, so every title starts at the
	// same edge whatever its number.
	rule(`${dot(PRINT.contents)} li::before`, {
		content: "counter(pa-contents)",
		flex: "0 0 2.2em",
		"font-family": FONT_MONO_ROLE,
		"font-size": "0.8em",
		"font-weight": "500",
		"font-variant-numeric": "tabular-nums",
		color: "var(--pa-label)",
	}),
	// An appendix's entry shows its letter, or nothing, in the number's box,
	// and the entries after it keep counting from the last number.
	rule(`${dot(PRINT.contents)} li${dot(PRINT.appendix)}`, {
		"counter-increment": "none",
	}),
	rule(`${dot(PRINT.contents)} li${dot(PRINT.appendix)}::before`, {
		content: `attr(${PROPOSAL_LABEL_ATTRIBUTE})`,
	}),
	rule(`${dot(PRINT.contents)} a`, {
		color: "inherit",
		"text-decoration-line": "none",
	}),
	// Draws nothing, but still takes the free width, so the page number
	// keeps to the right edge. Both passes write it, so it stays.
	rule(dot(PRINT.contentsLeader), {
		flex: "1 1 auto",
		"min-width": "1.5em",
	}),
	// Fixed width whatever it holds: the second pass fills the slots the
	// first left empty, and nothing may move when it does.
	rule(dot(PRINT.contentsPage), {
		flex: "0 0 3ch",
		width: "3ch",
		"text-align": "right",
		"white-space": "nowrap",
		"font-family": FONT_MONO_ROLE,
		"font-size": "0.8em",
		"font-variant-numeric": "tabular-nums",
		"font-weight": "400",
		color: "var(--pa-muted)",
	}),
	// A diagram only the live page draws keeps its place as a captioned
	// frame, its note aligned with the numbered caption under it.
	rule(dot(PRINT.diagramPlaceholder), {
		padding: "1.4em 1.25em",
		border: "1px dashed var(--pa-border)",
		"border-radius": "8px",
	}),
	rule(`${dot(PRINT.diagramPlaceholder)} ${dot(THEME.caption)}`, {
		margin: "0",
		"text-align": "left",
	}),
	// The diagram's own caption under the "could not be drawn" note.
	rule(`${dot(PRINT.diagramPlaceholder)} figcaption${dot(THEME.caption)}`, {
		"margin-top": "0.75em",
	}),
	rule(dot(PRINT.footnotes), {
		"margin-top": "2.5em",
		"font-size": "0.86em",
		color: "var(--pa-muted)",
	}),
	rule(dot(PRINT.landscape), { page: "landscape" }),
];

/** The print layer: its rules and `@page` blocks, scoped under `root`. */
export function printLayer(
	root: string,
	options: ProposalPrintThemeOptions,
): string {
	const family =
		safeFontFamily(options.fontFamily) ?? NEUTRAL_THEME.fonts.body;
	const literalStack =
		family === NEUTRAL_THEME.fonts.body
			? `${NEUTRAL_FAMILY}, ui-sans-serif, sans-serif`
			: `"${family}", ${NEUTRAL_FAMILY}, ui-sans-serif, sans-serif`;
	const furniture: Declarations = {
		"font-family": literalStack,
		"font-size": "7.5pt",
		"font-variant-ligatures": NO_CONTEXTUAL,
		"font-variant-numeric": "tabular-nums",
		"letter-spacing": "0.03em",
		// Resolves where the custom properties sit on the root element, and
		// otherwise falls back to the inherited text colour.
		color: "var(--pa-muted)",
	};

	return [
		// Margin boxes inherit from the root element, not from the body.
		block([`html:has(> ${root})`], {
			"font-family": literalStack,
			"font-variant-ligatures": NO_CONTEXTUAL,
			"-webkit-print-color-adjust": "exact",
			"print-color-adjust": "exact",
		}),
		emitRules(root, PRINT_RULES),
		...pageRules(options.runningFooter, furniture),
	].join("\n");
}
