/**
 * The Proposal theme (Fizzy #2946): one stylesheet source for the live Main
 * page and the print page, so the page a reader edits and the PDF they
 * download share their look.
 *
 * The stylesheet is static. Everything brand-specific arrives as the `--pa-*`
 * custom properties `themeCustomProperties` (in `./theme-tokens`) produces,
 * set on the theme root by whoever renders it; the CSS reads nothing else, so
 * no brand value is ever interpolated into a rule. Without those properties
 * the colours do not resolve, so the root must always carry them.
 *
 * Three layers, each scoped under one root selector:
 *
 * - **Base**, shared by both targets: type, headings, lists, links, code,
 *   callouts, data tables, figures and stat tiles. Markdown forms map onto
 *   the semantic classes structurally, because the editor DOM carries no
 *   classes: a blockquote is a callout, a table a data table, the paragraph
 *   after the title the lead.
 * - **Live**: the document painted on the theme's own paper in both app
 *   colour modes, a readable column, the narrow-screen rules, and the app's
 *   colour tokens remapped onto the paper so editor node-view chrome inside
 *   it (which the theme never names) stays legible. The paper itself is
 *   painted from `--pa-*` only, never from the names it remaps — see
 *   `docs/solutions/design-patterns/remapping-theme-tokens-on-an-inverted-surface.md`.
 * - **Print**: page size, margins and the running footer as `@page` margin
 *   boxes, the cover and landscape pages as named pages, the section opener
 *   card and the contents page, whose page numbers a second print pass writes
 *   in. Page furniture is CSS, not browser header and footer templates.
 *
 * Pure functions and data only: client components import this module, so it
 * must not pull in anything the browser bundle cannot carry.
 */

import { NEUTRAL_THEME, safeFontFamily } from "./theme-tokens";

/**
 * The semantic class vocabulary both renderers use. Markdown forms map onto
 * it structurally on the live page (a blockquote is a callout, a table a data
 * table); the print builder writes the classes out.
 */
export const PROPOSAL_THEME_CLASSES = {
	root: "proposal-theme",
	lead: "pa-lead",
	figure: "pa-figure",
	caption: "pa-caption",
	statTiles: "pa-stat-tiles",
	statTile: "pa-stat-tile",
	statValue: "pa-stat-value",
	statLabel: "pa-stat-label",
	callout: "pa-callout",
	dataTable: "pa-data-table",
	/**
	 * A data table whose first column holds only short ids, set in mono.
	 * Only print can tell, so only print writes it.
	 */
	idColumn: "pa-id-column",
	/**
	 * An ordered list whose every item opens with bold text, numbered in
	 * squares. Only print can tell: no selector can look two levels into
	 * every item of the editor's list, so the live page keeps its decimals.
	 */
	steps: "pa-steps",
	cover: "pa-cover",
	sectionOpener: "pa-section-opener",
} as const;

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
 * starts a page.
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
	/** The hero again, cropped to a section opener's right side. */
	sectionGraphic: "pa-section-graphic",
	contents: "pa-contents",
	/** The contents page's "Contents" heading, under the title eyebrow. */
	contentsTitle: "pa-contents-title",
	/** The dotted rule between a contents entry's title and its page. */
	contentsLeader: "pa-contents-leader",
	/** A contents entry's page number, in a box of fixed width. */
	contentsPage: "pa-contents-page",
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

/** Where the theme is applied: the live Main wrapper, or the print body. */
export type ProposalThemeTarget = "live" | "print";

/** The attribute that marks a theme root and names its target. */
export const PROPOSAL_THEME_ATTRIBUTE = "data-proposal-theme";

/**
 * The element each target's rules are scoped under.
 *
 * Live: the Main wrapper, `<div class="proposal-theme"
 * data-proposal-theme="live">`. The class is repeated to lift every rule to
 * at least three classes, so the theme strictly outranks the app's global
 * editor rules (up to two classes and an element) and the typography
 * plugin's `prose` rules (one class) whatever order the stylesheets load in.
 * The wrapper must carry no `bg-*` or `text-*` utilities of its own: it
 * remaps the app's colour tokens for everything inside it, and a surface
 * painted from a remapped token would repaint itself.
 *
 * Print: the print page's `<body data-proposal-theme="print">`. The print
 * page carries no other stylesheet.
 */
export const PROPOSAL_THEME_ROOT_SELECTORS: Readonly<
	Record<ProposalThemeTarget, string>
> = {
	live: `.${PROPOSAL_THEME_CLASSES.root}.${PROPOSAL_THEME_CLASSES.root}[${PROPOSAL_THEME_ATTRIBUTE}="live"]`,
	print: `body[${PROPOSAL_THEME_ATTRIBUTE}="print"]`,
};

/**
 * The printed page size, in one place: US Letter until the page-size
 * question in Fizzy #2946 is answered.
 */
export const PROPOSAL_PAGE_SIZE = "letter";

/** The page size of a landscape appendix page. */
export const PROPOSAL_PAGE_SIZE_LANDSCAPE =
	`${PROPOSAL_PAGE_SIZE} landscape` as const;

/**
 * The portrait page height of each size the constant above may name, so the
 * full-bleed cover follows the page size rather than restating it.
 */
const PAGE_HEIGHTS = {
	letter: "11in",
} as const satisfies Record<typeof PROPOSAL_PAGE_SIZE, string>;

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

type Declarations = Readonly<Record<string, string>>;

interface ThemeRule {
	/** Selectors relative to the theme root; `&` is the root itself. */
	selectors: readonly string[];
	declarations: Declarations;
}

const THEME = PROPOSAL_THEME_CLASSES;
const PRINT = PROPOSAL_PRINT_CLASSES;

function rule(
	selectors: string | readonly string[],
	declarations: Declarations,
): ThemeRule {
	return {
		selectors: typeof selectors === "string" ? [selectors] : selectors,
		declarations,
	};
}

/** `.name` for a class in the vocabulary. */
function dot(name: string): string {
	return `.${name}`;
}

const NEUTRAL_FAMILY = `"${NEUTRAL_THEME.fonts.body}"`;
const NEUTRAL_DISPLAY = `"${NEUTRAL_THEME.fonts.display}"`;
const NEUTRAL_MONO = `"${NEUTRAL_THEME.fonts.mono}"`;
/** The app's own Inter (next/font exposes it as `--font-inter`), then system. */
const SANS_FALLBACK = `var(--font-inter, ${NEUTRAL_FAMILY}), ui-sans-serif, system-ui, sans-serif`;
/*
 * next/font registers each face under a hashed family name, so the live
 * page reaches Poppins and JetBrains Mono only through the custom property
 * next/font writes on the theme root. They follow the theme's own family: a
 * Brand kit family the reader's browser lacks falls back to the neutral
 * face, as print sets it. Print has no next/font property, and its literal
 * fallback names the face the page embeds.
 */
const FONT_BODY = `var(--pa-font-body, ${NEUTRAL_FAMILY}), ${SANS_FALLBACK}`;
const FONT_DISPLAY = `var(--pa-font-display, ${NEUTRAL_DISPLAY}), var(--font-poppins, ${NEUTRAL_DISPLAY}), ${SANS_FALLBACK}`;
/**
 * The mono role: eyebrows, labels, header cells, captions in print. Set at
 * 400 or 500 only, the weights both targets load; a heavier one would be
 * drawn as a synthetic bold.
 */
const FONT_MONO_ROLE = `var(--pa-font-mono, ${NEUTRAL_MONO}), var(--font-jetbrains-mono, ${NEUTRAL_MONO}), ui-monospace, monospace`;
/** Code is always set in a real monospace, whatever the brand. */
const FONT_CODE = `ui-monospace, var(--font-mono, Menlo), Menlo, Consolas, "Liberation Mono", monospace`;

/** The classes a figure template sets in the mono role. */
const FIGURE_MONO_TEXT = [
	"eyebrow",
	"step-number",
	"layer-title",
	"side-title",
	"team-title",
] as const;

/** A faint wash of ink on the paper, for code and the app's muted fills. */
const WASH = "color-mix(in srgb, var(--pa-ink) 5%, var(--pa-surface))";

/** The light grey behind a callout. */
const CALLOUT_GREY = "color-mix(in srgb, var(--pa-ink) 6%, var(--pa-surface))";

/** Every other data row. */
const ZEBRA = "color-mix(in srgb, var(--pa-ink) 4%, var(--pa-surface))";

/** The dark grey of every third stat tile, a step lighter than the ink. */
const INK_GREY = "color-mix(in srgb, var(--pa-on-ink) 12%, var(--pa-ink))";

/**
 * Inter's contextual alternates turn a hyphen between digits into a
 * private-use glyph in text extracted from the PDF, so they are off for the
 * whole document, margin boxes included.
 */
const NO_CONTEXTUAL = "no-contextual";

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/** Base layer: shared by the live page and print. */
const BASE_RULES: readonly ThemeRule[] = [
	rule("&", {
		"font-family": FONT_BODY,
		"font-variant-ligatures": NO_CONTEXTUAL,
		"font-kerning": "normal",
		color: "var(--pa-ink)",
		"overflow-wrap": "break-word",
		"counter-reset": "pa-section",
	}),
	rule(HEADINGS, {
		"font-family": FONT_DISPLAY,
		"font-style": "normal",
		"font-weight": "700",
		"line-height": "1.2",
		"letter-spacing": "-0.01em",
		"text-transform": "none",
		"text-wrap": "balance",
		color: "var(--pa-heading)",
		"margin-top": "2em",
		"margin-bottom": "0.6em",
	}),
	rule("h1", {
		"font-size": "2.25em",
		"font-weight": "800",
		"line-height": "1.12",
		"letter-spacing": "-0.02em",
		"margin-top": "0",
		"margin-bottom": "0.45em",
	}),
	// A section heading is an ink card holding the heading alone. Print
	// sets it in the section opener, which adds the eyebrow and the graphic.
	rule("h2", {
		"font-size": "1.55em",
		"margin-top": "2.1em",
		padding: "0.6em 0.85em 0.65em",
		"border-radius": "6pt",
		color: "var(--pa-on-ink)",
		"background-color": "var(--pa-ink)",
	}),
	rule("h3", { "font-size": "1.22em" }),
	rule("h4", { "font-size": "1.05em" }),
	rule(["h5", "h6"], { "font-size": "0.95em", "letter-spacing": "0.01em" }),
	rule(
		[
			...HEADINGS,
			"p",
			"ul",
			"ol",
			"blockquote",
			"pre",
			"table",
			"figure",
		].map((element) => `${element}:first-child`),
		{ "margin-top": "0" },
	),
	// Only the paragraph spacing the editor's own rules already set, and no
	// font or colour: the same element appears in node-view chrome, which
	// keeps its own type.
	rule("p", { "margin-bottom": "1em" }),
	rule(["h1 + p", dot(THEME.lead)], {
		"font-size": "1.22em",
		"line-height": "1.5",
		color: "var(--pa-muted)",
		"margin-bottom": "1.4em",
	}),
	rule("a", {
		color: "var(--pa-heading)",
		"font-weight": "inherit",
		"text-decoration-line": "underline",
		"text-decoration-color": "var(--pa-primary)",
		"text-decoration-thickness": "0.08em",
		"text-underline-offset": "0.18em",
	}),
	// A link on an ink fill takes the fill's own text colour: the paper's
	// link colour may be too dark to read there.
	rule(["th a", "h2 a"], {
		color: "inherit",
		"text-decoration-color": "currentColor",
	}),
	rule(["strong", "b"], { "font-weight": "700", color: "inherit" }),
	rule(["ul", "ol"], {
		margin: "0 0 1em",
		padding: "0 0 0 1.4em",
	}),
	rule("ul", { "list-style-type": "disc" }),
	rule("ol", { "list-style-type": "decimal" }),
	rule(["ul ul", "ul ol", "ol ul", "ol ol"], { "margin-block": "0.3em" }),
	rule("li", { "margin-block": "0.3em" }),
	rule("li p", { "margin-block": "0.25em" }),
	rule("ul > li::marker", { color: "var(--pa-primary)" }),
	rule("ol > li::marker", {
		color: "var(--pa-muted)",
		"font-weight": "600",
		"font-variant-numeric": "tabular-nums",
	}),
	rule(['ul[data-type="taskList"]', "ul.contains-task-list"], {
		"list-style": "none",
		padding: "0",
	}),
	// A callout: an ink rule on light grey.
	rule(["blockquote", dot(THEME.callout)], {
		margin: "1.25em 0 1.4em",
		padding: "0.95em 1.35em",
		border: "0",
		"border-left": "3pt solid var(--pa-ink)",
		"border-radius": "0",
		"background-color": CALLOUT_GREY,
		color: "var(--pa-ink)",
		"font-style": "normal",
		"font-weight": "400",
		quotes: "none",
	}),
	rule(["blockquote > :last-child", `${dot(THEME.callout)} > :last-child`], {
		"margin-bottom": "0",
	}),
	rule(["blockquote strong", `${dot(THEME.callout)} strong`], {
		"font-weight": "700",
		color: "var(--pa-ink)",
	}),
	rule("code", {
		"font-family": FONT_CODE,
		"font-size": "0.86em",
		"font-weight": "400",
		color: "var(--pa-ink)",
		"background-color": WASH,
		border: "1px solid var(--pa-border)",
		"border-radius": "0.3em",
		padding: "0.1em 0.35em",
	}),
	rule("pre", {
		"font-family": FONT_CODE,
		"font-size": "0.84em",
		"line-height": "1.6",
		color: "var(--pa-ink)",
		"background-color": WASH,
		border: "1px solid var(--pa-border)",
		"border-radius": "8px",
		margin: "1.5em 0",
		padding: "0.9em 1.1em",
		"overflow-x": "auto",
	}),
	rule("pre code", {
		"font-size": "inherit",
		color: "inherit",
		"background-color": "transparent",
		border: "0",
		"border-radius": "0",
		padding: "0",
	}),
	rule("hr", {
		height: "0",
		border: "0",
		"border-top": "1px solid var(--pa-border)",
		margin: "2.25em 0",
	}),
	rule(["table", dot(THEME.dataTable)], {
		width: "100%",
		"border-collapse": "collapse",
		"border-spacing": "0",
		margin: "1.25em 0 1.4em",
		"font-size": "0.85em",
		"line-height": "1.45",
		color: "var(--pa-ink)",
	}),
	// A table the editor marks as added or deleted while an AI change awaits
	// review keeps the editor's green or red frame and wash; only an unmarked
	// table takes the paper's, which is no frame at all.
	rule(["table:not([data-diff])", dot(THEME.dataTable)], {
		border: "0",
		"border-radius": "0",
		"background-color": "var(--pa-surface)",
	}),
	// An ink header row of uppercase mono labels.
	rule("th", {
		"font-family": FONT_MONO_ROLE,
		"font-size": "0.8em",
		"font-weight": "500",
		"letter-spacing": "0.1em",
		"text-transform": "uppercase",
		"text-align": "left",
		"vertical-align": "bottom",
		color: "var(--pa-on-ink)",
		"background-color": "var(--pa-ink)",
		border: "1px solid var(--pa-ink)",
		padding: "0.75em 0.95em",
	}),
	rule("td", {
		"text-align": "left",
		"vertical-align": "top",
		color: "var(--pa-ink)",
		"background-color": "transparent",
		border: "0",
		"border-bottom": "1px solid var(--pa-border)",
		padding: "0.7em 0.95em",
	}),
	rule(["th p", "td p"], { margin: "0 0 0.5em" }),
	rule(["th > :last-child", "td > :last-child"], { "margin-bottom": "0" }),
	// Zebra rows. The editor keeps its header row inside `tbody`, print puts
	// it in `thead`; both tint the second, fourth, sixth… data row.
	rule("tbody > tr:nth-child(odd) > td", {
		"background-color": ZEBRA,
	}),
	rule("thead + tbody > tr:nth-child(odd) > td", {
		"background-color": "transparent",
	}),
	rule("thead + tbody > tr:nth-child(even) > td", {
		"background-color": ZEBRA,
	}),
	rule(`${dot(THEME.idColumn)} td:first-child`, {
		"font-family": FONT_MONO_ROLE,
		"font-size": "0.92em",
		"font-weight": "500",
		"white-space": "nowrap",
		color: "var(--pa-heading)",
	}),
	rule(["figure", dot(THEME.figure)], {
		margin: "1.75em 0",
		padding: "0",
		"text-align": "center",
	}),
	// No display or margin: the editor positions images by alignment.
	rule("img", {
		"max-width": "100%",
		height: "auto",
		"border-radius": "6px",
	}),
	rule([`${dot(THEME.figure)} svg`, "figure svg"], {
		"max-width": "100%",
		height: "auto",
	}),
	rule(["figcaption", dot(THEME.caption)], {
		"font-size": "0.82em",
		"font-style": "normal",
		"line-height": "1.45",
		"text-align": "center",
		color: "var(--pa-muted)",
		"margin-top": "0.65em",
	}),
	// A `<dl>` of tiles, each `<div><dt>label</dt><dd>value</dd></div>`: the
	// value reads first and large, the label under it, while the DOM keeps
	// the "label: value" order a screen reader expects. Filled in turn with
	// ink, the primary, a dark grey whose value takes the brand colour that
	// reads on the ink, and ink again.
	rule(dot(THEME.statTiles), {
		display: "grid",
		"grid-template-columns": "repeat(auto-fit, minmax(9rem, 1fr))",
		gap: "0.65em",
		margin: "1.25em 0 1.5em",
		padding: "0",
	}),
	rule(dot(THEME.statTile), {
		display: "flex",
		"flex-direction": "column-reverse",
		"justify-content": "flex-end",
		gap: "0.5em",
		margin: "0",
		padding: "0.95em 1.05em 1.15em",
		color: "var(--pa-on-ink)",
		"background-color": "var(--pa-ink)",
		border: "0",
		"border-radius": "5pt",
	}),
	rule(`${dot(THEME.statTile)}:nth-child(4n + 2)`, {
		color: "var(--pa-on-primary)",
		"background-color": "var(--pa-primary)",
	}),
	rule(`${dot(THEME.statTile)}:nth-child(4n + 3)`, {
		"background-color": INK_GREY,
	}),
	rule(dot(THEME.statValue), {
		margin: "0",
		padding: "0",
		"font-family": FONT_DISPLAY,
		"font-size": "1.6em",
		"font-weight": "700",
		"line-height": "1.05",
		"letter-spacing": "-0.02em",
		"font-variant-numeric": "lining-nums tabular-nums",
		color: "inherit",
	}),
	rule(`${dot(THEME.statTile)}:nth-child(4n + 3) ${dot(THEME.statValue)}`, {
		color: "var(--pa-on-ink-accent)",
	}),
	rule(dot(THEME.statLabel), {
		margin: "0",
		padding: "0",
		"font-size": "0.76em",
		"font-weight": "400",
		"line-height": "1.35",
		"letter-spacing": "0",
		"text-transform": "none",
		color: "var(--pa-on-ink-muted)",
	}),
	rule(`${dot(THEME.statTile)}:nth-child(4n + 2) ${dot(THEME.statLabel)}`, {
		color: "var(--pa-on-primary)",
	}),
	// Numbered steps: each number in a primary square beside its item. The
	// list-item counter honours an ordered list's start.
	rule(`ol${dot(THEME.steps)}`, {
		"list-style": "none",
		margin: "0.75em 0 1.25em",
		padding: "0",
	}),
	rule(`ol${dot(THEME.steps)} > li`, {
		position: "relative",
		"min-height": "1.9em",
		margin: "0 0 0.85em",
		"padding-left": "2.75em",
	}),
	rule(`ol${dot(THEME.steps)} > li::before`, {
		content: "counter(list-item)",
		position: "absolute",
		top: "0",
		left: "0",
		width: "2.2em",
		height: "2.2em",
		"line-height": "2.2em",
		"text-align": "center",
		"font-family": FONT_MONO_ROLE,
		"font-size": "0.86em",
		"font-weight": "500",
		"font-variant-numeric": "tabular-nums",
		color: "var(--pa-on-primary)",
		"background-color": "var(--pa-primary)",
		"border-radius": "2pt",
	}),
];

/**
 * The app's colour tokens, as the paper sees them. Each is set under its raw
 * name (read directly by the editor stylesheet, for example the diagram
 * colours declared as `var(--card)`) and under its `--color-*` name (what
 * Tailwind utilities read; a raw-name override alone never reaches them).
 * The typography plugin's `--color-fd-*` tokens get the same values.
 */
const APP_TOKEN_REMAP: readonly (readonly [
	token: string,
	value: string,
	typography: boolean,
])[] = [
	["background", "var(--pa-surface)", true],
	["foreground", "var(--pa-ink)", true],
	["card", "var(--pa-surface)", true],
	["card-foreground", "var(--pa-ink)", true],
	["popover", "var(--pa-surface)", true],
	["popover-foreground", "var(--pa-ink)", true],
	["primary", "var(--pa-primary)", true],
	["primary-foreground", "var(--pa-on-primary)", true],
	["primary-ink", "var(--pa-heading)", false],
	["secondary", WASH, true],
	["secondary-foreground", "var(--pa-ink)", true],
	["muted", WASH, true],
	["muted-foreground", "var(--pa-muted)", true],
	["accent", "color-mix(in srgb, var(--pa-ink) 9%, var(--pa-surface))", true],
	["accent-foreground", "var(--pa-ink)", true],
	["border", "var(--pa-border)", true],
	["input", "var(--pa-border)", false],
	["ring", "var(--pa-primary)", true],
];

function remapDeclarations(): Declarations {
	const declarations: Record<string, string> = {};
	for (const [token, value, typography] of APP_TOKEN_REMAP) {
		declarations[`--${token}`] = value;
		declarations[`--color-${token}`] = value;
		if (typography) {
			declarations[`--color-fd-${token}`] = value;
		}
	}
	return declarations;
}

/**
 * Live layer: the paper, its column, and the app-token remap. Both editors
 * the root wraps already inset their text by 2.5rem a side, so the paper adds
 * only a hairline of its own: 0.5rem plus that inset is the 6rem the column
 * allows beyond its 72ch measure.
 */
const LIVE_RULES: readonly ThemeRule[] = [
	rule("&", {
		"box-sizing": "border-box",
		width: "100%",
		"max-width": "calc(72ch + 6rem)",
		margin: "1.5rem auto",
		padding: "0.5rem",
		"font-size": "1.0625rem",
		"line-height": "1.7",
		"color-scheme": "light",
		color: "var(--pa-ink)",
		"background-color": "var(--pa-surface)",
		"border-radius": "10px",
		"box-shadow":
			"0 1px 2px color-mix(in srgb, var(--pa-ink) 10%, transparent), 0 12px 32px -12px color-mix(in srgb, var(--pa-ink) 18%, transparent)",
	}),
	rule("&", remapDeclarations()),
	// Each drawn Proposal diagram is a numbered figure: the editor marks its
	// wrapper and caption strip, and a diagram that failed to draw carries
	// neither. Print writes the number out as text instead.
	rule("&", { "counter-reset": "pa-section pa-figure" }),
	rule(".pa-figure-counted", { "counter-increment": "pa-figure" }),
	rule(".pa-figure-counted .pa-figure-caption::before", {
		content: '"Figure " counter(pa-figure) "."',
		"margin-inline-end": "0.6ch",
		"font-family": FONT_MONO_ROLE,
		"font-size": "0.8125rem",
		"font-weight": "500",
		color: "var(--pa-ink)",
	}),
	// A Proposal figure template names Inter and JetBrains Mono on its text,
	// which print embeds under those names but next/font registers here
	// under hashed ones. These rules beat the presentation attribute, so the
	// live page draws each in the role's own face, as print does.
	rule(`.pa-figure-counted svg[role="img"] text[font-family]`, {
		"font-family": FONT_BODY,
	}),
	rule(
		FIGURE_MONO_TEXT.map(
			(name) =>
				`.pa-figure-counted svg[role="img"] text[font-family].${name}`,
		),
		{ "font-family": FONT_MONO_ROLE },
	),
	// Text an AI change inserts or removes keeps the editor's review wash but
	// takes the paper's ink: the dark mode review rules would otherwise paint
	// it white on the light paper. `:not([hidden])` only lifts the rule above
	// those rules (three classes and an element).
	rule(":is(ins, del):not([hidden])", { color: "var(--pa-ink)" }),
	// The review washes, opaque and mixed onto the paper (see the paint), so
	// the paper's ink reads on them in both colour modes and inside a header
	// cell's fill too.
	rule("ins:not([hidden])", {
		"background-color": "var(--pa-review-insert)",
	}),
	rule("del:not([hidden])", {
		"background-color": "var(--pa-review-delete)",
	}),
	// The typography wrapper between the root and the content sets its own
	// size, leading and ink; hand them back to the paper.
	rule(".prose", {
		"max-width": "none",
		"font-size": "inherit",
		"line-height": "inherit",
		color: "inherit",
	}),
];

/** Below Tailwind's `md` breakpoint. */
const NARROW_MEDIA = "(width < 48rem)";

const LIVE_NARROW_RULES: readonly ThemeRule[] = [
	rule("&", {
		"max-width": "none",
		margin: "0",
		padding: "0",
		"font-size": "1rem",
		"border-radius": "0",
		"box-shadow": "none",
	}),
	rule(dot(THEME.statTiles), {
		"grid-template-columns": "repeat(2, minmax(0, 1fr))",
	}),
	rule(["table", dot(THEME.dataTable)], {
		display: "block",
		"max-width": "100%",
		"overflow-x": "auto",
	}),
	rule(["th", "td"], { "min-width": "7.5rem" }),
];

/** Print layer: body, page breaks, cover, section openers, contents. */
const PRINT_RULES: readonly ThemeRule[] = [
	rule(`${dot(THEME.sectionOpener)} a`, {
		color: "inherit",
		"text-decoration-color": "currentColor",
	}),
	rule("&", {
		margin: "0",
		padding: "0",
		"font-size": "10.5pt",
		"line-height": "1.6",
		color: "var(--pa-ink)",
		"background-color": "var(--pa-surface)",
		"-webkit-print-color-adjust": "exact",
		"print-color-adjust": "exact",
	}),
	rule("p", { "margin-top": "0", orphans: "3", widows: "3" }),
	rule(HEADINGS, { "break-after": "avoid", "break-inside": "avoid" }),
	rule("h3", { "font-size": "13.5pt" }),
	rule("pre", {
		"white-space": "pre-wrap",
		"overflow-wrap": "anywhere",
		"overflow-x": "visible",
	}),
	// Header rows repeat on every page a table spans.
	rule("thead", { display: "table-header-group" }),
	rule("tfoot", { display: "table-footer-group" }),
	rule(
		[
			"tr",
			"img",
			"svg",
			"figure",
			dot(THEME.figure),
			dot(THEME.statTiles),
			dot(THEME.statTile),
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
	rule(dot(PRINT.figureNumber), {
		"font-weight": "500",
		color: "var(--pa-ink)",
	}),
	rule(dot(PRINT.eyebrow), {
		margin: "0 0 0.9em",
		"font-family": FONT_MONO_ROLE,
		"font-size": "7.5pt",
		"font-weight": "500",
		"letter-spacing": "0.16em",
		"text-transform": "uppercase",
		color: "var(--pa-muted)",
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
	rule(`${dot(PRINT.coverBrands)} + ${dot(PRINT.coverBody)}`, {
		"margin-top": `calc(${COVER_BODY_TOP} - ${COVER_TOP} - ${COVER_BRANDS_HEIGHT})`,
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
	// A section opener: an ink card, at the top of its own page, with a
	// "Section N" eyebrow, the heading, an optional subtitle and an optional
	// graphic. A forced break right after the contents page, or a landscape
	// page starting with the opener, is the same break, so no page is left
	// blank.
	rule(dot(THEME.sectionOpener), {
		// The containing block of the graphic and the first pass's marker.
		// Nothing clips it: the marker must never be cut by a corner.
		position: "relative",
		"counter-increment": "pa-section",
		"break-before": "page",
		"break-after": "avoid",
		"box-sizing": "border-box",
		"min-height": "1.35in",
		margin: "0 0 16pt",
		padding: "18pt 22pt 20pt",
		"border-radius": "6pt",
		color: "var(--pa-on-ink)",
		"background-color": "var(--pa-ink)",
	}),
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
	// Drawn after the graphic, so above it.
	rule(`${dot(THEME.sectionOpener)} h2`, {
		position: "relative",
		margin: "0 0 6pt",
		padding: "0",
		"font-size": "21pt",
		"line-height": "1.15",
		color: "inherit",
		"background-color": "transparent",
		"border-radius": "0",
	}),
	rule(`${dot(THEME.sectionOpener)} h2:last-child`, { "margin-bottom": "0" }),
	rule(`${dot(THEME.sectionOpener)} p`, {
		position: "relative",
		"max-width": "3.9in",
		margin: "0",
		"font-size": "10.5pt",
		"line-height": "1.45",
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
		color: "var(--pa-heading)",
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
		"border-bottom": "1px solid var(--pa-border)",
	}),
	// Fixed-width figures in a fixed-width box, so every title starts at the
	// same edge whatever its number.
	rule(`${dot(PRINT.contents)} li::before`, {
		content: "counter(pa-contents, decimal-leading-zero)",
		flex: "0 0 2.2em",
		"font-family": FONT_MONO_ROLE,
		"font-size": "0.8em",
		"font-weight": "500",
		"font-variant-numeric": "tabular-nums",
		color: "var(--pa-heading)",
	}),
	rule(`${dot(PRINT.contents)} a`, {
		color: "inherit",
		"text-decoration-line": "none",
	}),
	// An empty box has its baseline at its bottom edge, so in the entry's
	// baseline-aligned row the dots sit on the title's baseline.
	rule(dot(PRINT.contentsLeader), {
		flex: "1 1 auto",
		"min-width": "1.5em",
		"border-bottom": "1px dotted var(--pa-border)",
	}),
	// Fixed width whatever it holds: the second pass fills the slots the
	// first left empty, and nothing may move when it does.
	rule(dot(PRINT.contentsPage), {
		flex: "0 0 3ch",
		width: "3ch",
		"text-align": "right",
		"white-space": "nowrap",
		"font-variant-numeric": "tabular-nums",
		"font-weight": "600",
		color: "var(--pa-heading)",
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

/** Every margin box a page can have. */
const MARGIN_BOXES = [
	"top-left-corner",
	"top-left",
	"top-center",
	"top-right",
	"top-right-corner",
	"bottom-left-corner",
	"bottom-left",
	"bottom-center",
	"bottom-right",
	"bottom-right-corner",
	"left-top",
	"left-middle",
	"left-bottom",
	"right-top",
	"right-middle",
	"right-bottom",
] as const;

/** Longest running footer, in characters, before it is cut. */
const RUNNING_TEXT_LIMIT = 200;

/**
 * `text` as a double-quoted CSS string a document title cannot break out of.
 * Control characters and line breaks become spaces, whitespace collapses,
 * and the text is cut to {@link RUNNING_TEXT_LIMIT} characters. Backslash
 * and quote are escaped, and `<` and `>` become hex escapes so the
 * stylesheet can sit inside a `<style>` element without `</style>` closing
 * it.
 */
function cssString(text: string): string {
	const flat = text
		// Direction overrides and invisible breaks go; the joiners some scripts
		// and emoji need (U+200C, U+200D) stay.
		.replace(
			/[\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g,
			"",
		)
		.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	const characters = Array.from(flat);
	const capped =
		characters.length > RUNNING_TEXT_LIMIT
			? `${characters
					.slice(0, RUNNING_TEXT_LIMIT - 1)
					.join("")
					.trimEnd()}…`
			: flat;
	const escaped = capped.replace(/[\\"<>]/g, (character) => {
		switch (character) {
			case "\\":
				return "\\\\";
			case '"':
				return '\\"';
			case "<":
				return "\\3c ";
			default:
				return "\\3e ";
		}
	});
	return `"${escaped}"`;
}

/** A margin box's `content`: the text as a string, or nothing at all. */
function runningContent(text: string): string {
	const value = cssString(text);
	return value === '""' ? "none" : value;
}

function scope(root: string, selector: string): string {
	return selector === "&" ? root : `${root} ${selector}`;
}

function block(
	selectors: readonly string[],
	declarations: Declarations,
	indent = "",
): string {
	const lines = Object.entries(declarations).map(
		([property, value]) => `${indent}\t${property}: ${value};`,
	);
	return `${indent}${selectors.join(`,\n${indent}`)} {\n${lines.join("\n")}\n${indent}}`;
}

function emitRules(
	root: string,
	rules: readonly ThemeRule[],
	indent = "",
): string {
	return rules
		.map((entry) =>
			block(
				entry.selectors.map((selector) => scope(root, selector)),
				entry.declarations,
				indent,
			),
		)
		.join("\n");
}

function atRule(prelude: string, body: string): string {
	return `${prelude} {\n${body}\n}`;
}

function pageRule(
	name: string | null,
	declarations: Declarations,
	boxes: Readonly<Record<string, Declarations>>,
): string {
	const own = Object.entries(declarations).map(
		([property, value]) => `\t${property}: ${value};`,
	);
	const nested = Object.entries(boxes).map(([box, boxDeclarations]) =>
		block([`@${box}`], boxDeclarations, "\t"),
	);
	return atRule(
		name ? `@page ${name}` : "@page",
		[...own, ...nested].join("\n"),
	);
}

function printLayer(root: string, options: ProposalPrintThemeOptions): string {
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
	const bottom: Declarations = {
		...furniture,
		"vertical-align": "top",
		"padding-top": "0.24in",
	};
	const blank = Object.fromEntries(
		MARGIN_BOXES.map((box) => [box, { content: "none" }]),
	);

	return [
		// Margin boxes inherit from the root element, not from the body.
		block([`html:has(> ${root})`], {
			"font-family": literalStack,
			"font-variant-ligatures": NO_CONTEXTUAL,
			"-webkit-print-color-adjust": "exact",
			"print-color-adjust": "exact",
		}),
		emitRules(root, PRINT_RULES),
		// The cover counts as page 1, so the first body page reads "Page 2".
		// A footer only: the opener names each section at the top of its page.
		pageRule(
			null,
			{ size: PROPOSAL_PAGE_SIZE, margin: "0.85in 0.8in 0.9in" },
			{
				"bottom-left": {
					...bottom,
					content: runningContent(options.runningFooter),
				},
				"bottom-right": {
					...bottom,
					content: '"Page " counter(page) " of " counter(pages)',
					"text-align": "right",
					"white-space": "nowrap",
				},
			},
		),
		pageRule("cover", { margin: "0" }, blank),
		// The cover is always the first page. Chromium 143 lays it out on the
		// cover page's geometry but paints page 1 with the default page's
		// margins and furniture unless the first page carries them itself.
		pageRule(":first", { margin: "0" }, blank),
		pageRule("landscape", { size: PROPOSAL_PAGE_SIZE_LANDSCAPE }, {}),
	].join("\n");
}

/** The theme stylesheet for the live Main wrapper. */
export function proposalThemeCss(target: "live"): string;
/**
 * The theme stylesheet for the print page, with its running footer, which is
 * document text and is escaped here.
 */
export function proposalThemeCss(
	target: "print",
	options: ProposalPrintThemeOptions,
): string;
export function proposalThemeCss(
	target: ProposalThemeTarget,
	options?: ProposalPrintThemeOptions,
): string {
	const root = PROPOSAL_THEME_ROOT_SELECTORS[target];
	const base = emitRules(root, BASE_RULES);
	if (target === "live") {
		return [
			base,
			emitRules(root, LIVE_RULES),
			atRule(
				`@media ${NARROW_MEDIA}`,
				emitRules(root, LIVE_NARROW_RULES, "\t"),
			),
		].join("\n");
	}
	return [base, printLayer(root, options ?? { runningFooter: "" })].join(
		"\n",
	);
}
