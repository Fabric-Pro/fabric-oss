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
 * - **Print**: page size, margins and running header and footer as `@page`
 *   margin boxes, the cover and landscape pages as named pages, the section
 *   opener band and the contents page, whose page numbers a second print pass
 *   writes in. Page furniture is CSS, not browser header and footer
 *   templates.
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
 *   <div class="pa-cover-brands">
 *     <img class="pa-cover-logo pa-cover-logo-proposer" alt="…">
 *     <img class="pa-cover-logo pa-cover-logo-recipient" alt="…">
 *   </div>
 *   <img class="pa-cover-hero" alt="">
 *   <div class="pa-cover-body">
 *     <p class="pa-eyebrow">Proposal</p>
 *     <h1 class="pa-cover-title">…</h1>
 *     <p class="pa-cover-lead">…</p>
 *   </div>
 *   <dl class="pa-cover-parties">
 *     <div><dt>Prepared for</dt><dd>…</dd></div>
 *     <div><dt>Prepared by</dt><dd>…</dd></div>
 *   </dl>
 *   <p class="pa-cover-date">…</p>
 * </section>
 * ```
 *
 * A missing logo is left out rather than rendered empty: the proposer logo
 * holds the left edge and the recipient logo the right one on its own, and a
 * brands row with no logo at all (written with nothing inside, not even
 * whitespace) is hidden. The hero, the lead and the parties are left out
 * when there is nothing to put in them. A section opener is a
 * `<header class="pa-section-opener">` holding the `h2` and an optional
 * subtitle paragraph; its "Section N" eyebrow is a CSS counter.
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
	coverBody: "pa-cover-body",
	coverTitle: "pa-cover-title",
	coverLead: "pa-cover-lead",
	coverParties: "pa-cover-parties",
	coverDate: "pa-cover-date",
	/** An optional full-width picture between the brands and the title. */
	coverHero: "pa-cover-hero",
	contents: "pa-contents",
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
	/** A figure holding the caption of a diagram that did not render. */
	diagramPlaceholder: "pa-diagram-placeholder",
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

/** What the print layer needs that the stylesheet cannot work out itself. */
export interface ProposalPrintThemeOptions {
	/**
	 * Running header text, usually the document title. Plain text: it is
	 * escaped here, so pass it as the reader typed it.
	 */
	runningHeader: string;
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
	 * neutral font; a name `safeFontFamily` refuses falls back to it too.
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

const NEUTRAL_FAMILY = `"${NEUTRAL_THEME.font}"`;
/** The app's own Inter (next/font exposes it as `--font-inter`), then system. */
const SANS_FALLBACK = `var(--font-inter, ${NEUTRAL_FAMILY}), ui-sans-serif, system-ui, sans-serif`;
const FONT_BODY = `var(--pa-font-body, ${NEUTRAL_FAMILY}), ${SANS_FALLBACK}`;
const FONT_DISPLAY = `var(--pa-font-display, ${NEUTRAL_FAMILY}), ${SANS_FALLBACK}`;
/** The mono role: eyebrows, labels, header cells. Neutral is Inter. */
const FONT_MONO_ROLE = `var(--pa-font-mono, ${NEUTRAL_FAMILY}), ${SANS_FALLBACK}`;
/** Code is always set in a real monospace, whatever the brand. */
const FONT_CODE = `ui-monospace, var(--font-mono, Menlo), Menlo, Consolas, "Liberation Mono", monospace`;

/** A faint wash of ink on the paper, for code and the app's muted fills. */
const WASH = "color-mix(in srgb, var(--pa-ink) 5%, var(--pa-surface))";

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
	// The live page's section heading: a strong heading under a short primary
	// rule. Print wraps it in the section opener band instead.
	rule("h2", {
		"font-size": "1.55em",
		"margin-top": "2.1em",
		"padding-top": "0.65em",
		"background-image":
			"linear-gradient(var(--pa-primary), var(--pa-primary))",
		"background-repeat": "no-repeat",
		"background-position": "left top",
		"background-size": "2.75rem 3px",
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
	// A link in a header cell takes the cell's own text colour: the paper's
	// link colour is the cell's fill. The print layer does the same for the
	// section opener band.
	rule("th a", {
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
	rule(["blockquote", dot(THEME.callout)], {
		margin: "1.5em 0",
		padding: "0.95em 1.2em",
		border: "0",
		"border-left": "4px solid var(--pa-primary)",
		"border-radius": "0 8px 8px 0",
		"background-color": "var(--pa-tint)",
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
		margin: "1.5em 0",
		"font-size": "0.9em",
		"line-height": "1.5",
		color: "var(--pa-ink)",
	}),
	// A table the editor marks as added or deleted while an AI change awaits
	// review keeps the editor's green or red frame and wash; only an unmarked
	// table takes the paper's frame.
	rule(["table:not([data-diff])", dot(THEME.dataTable)], {
		border: "1px solid var(--pa-border)",
		"border-radius": "0",
		"background-color": "var(--pa-surface)",
	}),
	rule("th", {
		"font-family": FONT_MONO_ROLE,
		"font-size": "0.78em",
		"font-weight": "600",
		"letter-spacing": "0.06em",
		"text-transform": "uppercase",
		"text-align": "left",
		"vertical-align": "bottom",
		color: "var(--pa-on-primary)",
		"background-color": "var(--pa-primary)",
		border: "1px solid var(--pa-primary)",
		padding: "0.7em 0.85em",
	}),
	rule("td", {
		"text-align": "left",
		"vertical-align": "top",
		color: "var(--pa-ink)",
		"background-color": "transparent",
		border: "1px solid var(--pa-border)",
		padding: "0.6em 0.85em",
	}),
	rule(["th p", "td p"], { margin: "0 0 0.5em" }),
	rule(["th > :last-child", "td > :last-child"], { "margin-bottom": "0" }),
	// Zebra rows. The editor keeps its header row inside `tbody`, print puts
	// it in `thead`; both tint the first, third, fifth… data row.
	rule("tbody > tr:nth-child(even) > td", {
		"background-color": "var(--pa-tint)",
	}),
	rule("thead + tbody > tr:nth-child(even) > td", {
		"background-color": "transparent",
	}),
	rule("thead + tbody > tr:nth-child(odd) > td", {
		"background-color": "var(--pa-tint)",
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
	// the "label: value" order a screen reader expects.
	rule(dot(THEME.statTiles), {
		display: "grid",
		"grid-template-columns": "repeat(auto-fit, minmax(9rem, 1fr))",
		gap: "0.85em",
		margin: "1.75em 0",
		padding: "0",
	}),
	rule(dot(THEME.statTile), {
		display: "flex",
		"flex-direction": "column-reverse",
		"justify-content": "flex-end",
		gap: "0.35em",
		margin: "0",
		padding: "1em 1.1em 1.05em",
		"background-color": "var(--pa-surface)",
		border: "1px solid var(--pa-border)",
		"border-top": "3px solid var(--pa-primary)",
		"border-radius": "0 0 8px 8px",
	}),
	rule(dot(THEME.statValue), {
		margin: "0",
		padding: "0",
		"font-family": FONT_DISPLAY,
		"font-size": "2.1em",
		"font-weight": "700",
		"line-height": "1.05",
		"letter-spacing": "-0.02em",
		"font-variant-numeric": "lining-nums tabular-nums",
		color: "var(--pa-heading)",
	}),
	rule(dot(THEME.statLabel), {
		margin: "0",
		padding: "0",
		"font-family": FONT_MONO_ROLE,
		"font-size": "0.74em",
		"font-weight": "600",
		"line-height": "1.35",
		"letter-spacing": "0.08em",
		"text-transform": "uppercase",
		color: "var(--pa-muted)",
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
		"line-height": "1.55",
		color: "var(--pa-ink)",
		"background-color": "var(--pa-surface)",
		"-webkit-print-color-adjust": "exact",
		"print-color-adjust": "exact",
	}),
	rule("p", { "margin-top": "0", orphans: "3", widows: "3" }),
	rule(HEADINGS, { "break-after": "avoid", "break-inside": "avoid" }),
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
	rule(dot(PRINT.eyebrow), {
		margin: "0 0 0.9em",
		"font-family": FONT_MONO_ROLE,
		"font-size": "0.74em",
		"font-weight": "600",
		"letter-spacing": "0.14em",
		"text-transform": "uppercase",
		color: "var(--pa-muted)",
	}),
	// The cover: a page of its own with no furniture, both brands on a strip
	// of paper (a logo drawn for a light background stays visible), the rest
	// on the ink surface.
	rule(dot(THEME.cover), {
		page: "cover",
		"break-after": "page",
		"break-inside": "avoid",
		"box-sizing": "border-box",
		display: "flex",
		"flex-direction": "column",
		height: PAGE_HEIGHTS[PROPOSAL_PAGE_SIZE],
		margin: "0",
		overflow: "hidden",
		color: "var(--pa-surface)",
		"background-color": "var(--pa-ink)",
	}),
	rule(dot(PRINT.coverBrands), {
		display: "flex",
		"align-items": "center",
		"justify-content": "space-between",
		gap: "0.5in",
		padding: "0.55in 0.75in 0.45in",
		"background-color": "var(--pa-surface)",
		"border-bottom": "6pt solid var(--pa-primary)",
	}),
	rule(`${dot(PRINT.coverBrands)}:empty`, { display: "none" }),
	rule(dot(PRINT.coverLogo), {
		display: "block",
		width: "auto",
		height: "auto",
		"max-width": "2.75in",
		"max-height": "0.75in",
		"object-fit": "contain",
		"border-radius": "0",
	}),
	rule(dot(PRINT.recipientLogo), { "margin-inline-start": "auto" }),
	// A band of fixed height, cropped to fill it, so the cover's one page
	// always has room for the title, the parties and the date below it.
	rule(dot(PRINT.coverHero), {
		display: "block",
		flex: "0 0 auto",
		width: "100%",
		"max-width": "none",
		height: "3in",
		"object-fit": "cover",
		"border-radius": "0",
	}),
	rule(dot(PRINT.coverBody), {
		flex: "1 1 auto",
		display: "flex",
		"flex-direction": "column",
		"justify-content": "center",
		padding: "0.75in",
	}),
	rule(`${dot(THEME.cover)} ${dot(PRINT.eyebrow)}`, {
		color: "var(--pa-surface)",
	}),
	rule(dot(PRINT.coverTitle), {
		margin: "0 0 0.28in",
		padding: "0",
		"font-family": FONT_DISPLAY,
		"font-size": "34pt",
		"font-weight": "800",
		"line-height": "1.08",
		"letter-spacing": "-0.02em",
		"text-wrap": "balance",
		color: "var(--pa-surface)",
		"background-image": "none",
	}),
	rule(dot(PRINT.coverLead), {
		margin: "0",
		"max-width": "5.5in",
		"font-size": "14pt",
		"line-height": "1.45",
		color: "var(--pa-surface)",
	}),
	rule(dot(PRINT.coverParties), {
		display: "grid",
		"grid-template-columns": "repeat(2, minmax(0, 1fr))",
		gap: "0.4in",
		margin: "0",
		padding: "0 0.75in",
	}),
	rule(`${dot(PRINT.coverParties)} dt`, {
		margin: "0 0 4pt",
		"font-family": FONT_MONO_ROLE,
		"font-size": "7.5pt",
		"font-weight": "600",
		"letter-spacing": "0.12em",
		"text-transform": "uppercase",
		color: "var(--pa-surface)",
	}),
	rule(`${dot(PRINT.coverParties)} dd`, {
		margin: "0",
		"font-size": "12pt",
		"font-weight": "600",
		color: "var(--pa-surface)",
	}),
	rule(dot(PRINT.coverDate), {
		margin: "0",
		padding: "0.35in 0.75in 0.6in",
		"font-size": "10pt",
		color: "var(--pa-surface)",
	}),
	// A section opener: a rounded primary band with a "Section N" eyebrow,
	// the heading and an optional subtitle.
	rule(dot(THEME.sectionOpener), {
		// The containing block of the first pass's page marker.
		position: "relative",
		"counter-increment": "pa-section",
		"break-after": "avoid",
		margin: "2em 0 1.4em",
		padding: "1.25em 1.5em 1.35em",
		"border-radius": "10px",
		color: "var(--pa-on-primary)",
		"background-color": "var(--pa-primary)",
	}),
	rule(`${dot(THEME.sectionOpener)}:first-child`, { "margin-top": "0" }),
	rule(`${dot(THEME.sectionOpener)}::before`, {
		content: '"Section " counter(pa-section)',
		display: "block",
		"margin-bottom": "0.55em",
		"font-family": FONT_MONO_ROLE,
		"font-size": "0.72em",
		"font-weight": "600",
		"letter-spacing": "0.14em",
		"text-transform": "uppercase",
	}),
	rule(`${dot(THEME.sectionOpener)} h2`, {
		margin: "0",
		padding: "0",
		"font-size": "1.65em",
		color: "inherit",
		"background-image": "none",
	}),
	rule(`${dot(THEME.sectionOpener)} p`, {
		margin: "0.45em 0 0",
		color: "inherit",
	}),
	// The marker the first print pass looks a section's page up by: out of
	// flow at the band's corner, so it moves nothing, and drawn in the band's
	// own colour at a legible size, so the PDF's text holds it whole. It is
	// deliberately not made invisible: Chromium's Linux print output leaves
	// transparent text out of the PDF altogether, and only the first pass,
	// which nobody sees, carries markers.
	rule(dot(PRINT.pageMarker), {
		position: "absolute",
		top: "0",
		left: "0",
		"font-size": "8px",
		"line-height": "1",
		"letter-spacing": "0",
		"white-space": "nowrap",
	}),
	// The contents page: numbered sections, each with the page it starts on,
	// which a second print pass writes in (Chromium has no `target-counter()`
	// to look them up with).
	rule(dot(PRINT.contents), { "break-after": "page" }),
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
		"font-weight": "600",
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
	// A diagram that did not render keeps its place as a captioned frame.
	rule(dot(PRINT.diagramPlaceholder), {
		padding: "1.4em 1.25em",
		border: "1px dashed var(--pa-border)",
		"border-radius": "8px",
	}),
	rule(`${dot(PRINT.diagramPlaceholder)} ${dot(THEME.caption)}`, {
		margin: "0",
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

/** Longest running header or footer, in characters, before it is cut. */
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
	const family = safeFontFamily(options.fontFamily) ?? NEUTRAL_THEME.font;
	const literalStack =
		family === NEUTRAL_THEME.font
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
	const top: Declarations = {
		...furniture,
		"vertical-align": "bottom",
		"padding-bottom": "0.22in",
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
		pageRule(
			null,
			{ size: PROPOSAL_PAGE_SIZE, margin: "0.85in 0.8in 0.9in" },
			{
				"top-left": {
					...top,
					content: runningContent(options.runningHeader),
				},
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
		pageRule("landscape", { size: PROPOSAL_PAGE_SIZE_LANDSCAPE }, {}),
	].join("\n");
}

/** The theme stylesheet for the live Main wrapper. */
export function proposalThemeCss(target: "live"): string;
/**
 * The theme stylesheet for the print page, with its running header and
 * footer. Header and footer are document text and are escaped here.
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
	return [
		base,
		printLayer(root, options ?? { runningHeader: "", runningFooter: "" }),
	].join("\n");
}
