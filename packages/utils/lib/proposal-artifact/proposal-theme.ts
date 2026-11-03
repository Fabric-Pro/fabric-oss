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
 *   callouts, data tables, figures, stat tiles, cards and columns. Markdown
 *   forms map onto the semantic classes structurally, because the editor
 *   DOM carries no classes: a blockquote is a callout, a table a data table,
 *   the paragraph after the title the lead.
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
 * The print layer lives in `./proposal-theme-print` and what the layers
 * share in `./proposal-theme-rules`; this module re-exports their public
 * names.
 *
 * Pure functions and data only: client components import this module, so it
 * must not pull in anything the browser bundle cannot carry.
 */

import {
	type ProposalPrintThemeOptions,
	printLayer,
} from "./proposal-theme-print";
import {
	atRule,
	CALLOUT_GREY,
	type Declarations,
	dot,
	emitRules,
	FONT_BODY,
	FONT_CODE,
	FONT_DISPLAY,
	FONT_MONO_ROLE,
	HEADINGS,
	INK_GREY,
	NO_CONTEXTUAL,
	PROPOSAL_THEME_CLASSES,
	rule,
	type ThemeRule,
	WASH,
	ZEBRA,
} from "./proposal-theme-rules";

export {
	type OpenerPageBlock,
	PRINT_FIGURE_MAX_HEIGHT_PROPERTY,
	PRINT_FIGURE_MAX_HEIGHT_PX,
	PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX,
	PROPOSAL_LABEL_ATTRIBUTE,
	PROPOSAL_PAGE_SIZE,
	PROPOSAL_PAGE_SIZE_LANDSCAPE,
	PROPOSAL_PRINT_CLASSES,
	type ProposalPrintThemeOptions,
	printFigureUnderOpenerMaxHeightPx,
} from "./proposal-theme-print";
export { PROPOSAL_THEME_CLASSES } from "./proposal-theme-rules";

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

const THEME = PROPOSAL_THEME_CLASSES;

/** The classes a figure template sets in the mono role. */
const FIGURE_MONO_TEXT = [
	"eyebrow",
	"step-number",
	"layer-title",
	"side-title",
	"team-title",
] as const;

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
		// Headings are ink; the brand colour is for links and small labels.
		color: "var(--pa-ink)",
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
	rule("ul > li::marker", { color: "var(--pa-label)" }),
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
		color: "var(--pa-label)",
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
	// A grid of bordered cards, two across, or three when there are exactly
	// three: a small mono label in the label colour, a title in the display
	// face, then muted text.
	rule(dot(THEME.cards), {
		display: "grid",
		"grid-template-columns": "repeat(2, minmax(0, 1fr))",
		gap: "0.95em",
		margin: "1.25em 0 1.5em",
		padding: "0",
	}),
	rule(`${dot(THEME.cards)}${dot(THEME.cardsThree)}`, {
		"grid-template-columns": "repeat(3, minmax(0, 1fr))",
	}),
	rule(dot(THEME.card), {
		// Its track's width, so a long unbroken word wraps inside the border.
		"min-width": "0",
		margin: "0",
		padding: "1.24em 1.43em",
		color: "var(--pa-ink)",
		"background-color": "var(--pa-surface)",
		border: "1px solid var(--pa-border)",
		"border-radius": "7pt",
	}),
	rule(dot(THEME.cardLabel), {
		margin: "0 0 0.75em",
		"font-family": FONT_MONO_ROLE,
		"font-size": "0.76em",
		"font-weight": "500",
		"line-height": "1.35",
		"letter-spacing": "0.16em",
		"text-transform": "uppercase",
		color: "var(--pa-label)",
	}),
	rule(dot(THEME.cardTitle), {
		margin: "0 0 0.35em",
		"font-family": FONT_DISPLAY,
		"font-size": "1em",
		"font-weight": "700",
		"line-height": "1.3",
		color: "var(--pa-ink)",
	}),
	rule(dot(THEME.cardText), {
		margin: "0",
		"font-size": "0.87em",
		"line-height": "1.5",
		color: "var(--pa-muted)",
	}),
	rule(`${dot(THEME.card)} > :last-child`, { "margin-bottom": "0" }),
	// Two equal columns of smaller text. A column heading is a paragraph in
	// the display face; bullets and paragraphs keep the body's rhythm, and
	// the bullets their label-colour markers.
	rule(dot(THEME.columns), {
		display: "grid",
		"grid-template-columns": "repeat(2, minmax(0, 1fr))",
		"column-gap": "1.9em",
		"row-gap": "1.25em",
		margin: "1.25em 0 1.5em",
		padding: "0",
		"font-size": "0.86em",
		"line-height": "1.55",
	}),
	rule(dot(THEME.column), { "min-width": "0", margin: "0", padding: "0" }),
	rule(dot(THEME.columnHeading), {
		margin: "1.1em 0 0.45em",
		"font-family": FONT_DISPLAY,
		// The body's size, over the columns' smaller text.
		"font-size": "1.17em",
		"font-weight": "700",
		"line-height": "1.3",
		color: "var(--pa-ink)",
	}),
	rule(`${dot(THEME.column)} > :first-child`, { "margin-top": "0" }),
	rule(`${dot(THEME.column)} > :last-child`, { "margin-bottom": "0" }),
	// Numbered steps: a mono "01", "02"… in the label colour, hanging beside
	// its item. The list-item counter honours an ordered list's start.
	rule(`ol${dot(THEME.steps)}`, {
		"list-style": "none",
		margin: "0.75em 0 1.25em",
		padding: "0",
	}),
	rule(`ol${dot(THEME.steps)} > li`, {
		position: "relative",
		margin: "0 0 0.85em",
		"padding-left": "2.4em",
	}),
	rule(`ol${dot(THEME.steps)} > li::before`, {
		content: "counter(list-item, decimal-leading-zero)",
		position: "absolute",
		top: "0",
		left: "0",
		"font-family": FONT_MONO_ROLE,
		"font-size": "0.86em",
		"font-weight": "500",
		// The item's own line height (`lh` in line-height reads the parent's),
		// so the smaller number sits on its first line's baseline.
		"line-height": "1lh",
		"font-variant-numeric": "tabular-nums",
		color: "var(--pa-label)",
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

/**
 * A document no one is editing: an editor drawn read-only, and not a
 * read-only island inside an editable one.
 */
const READ_ONLY_EDITOR =
	'[contenteditable="false"]:not([contenteditable="true"] *)';

/**
 * An empty cell as the editor draws it: one paragraph holding only the line
 * break the editor puts in an empty block. A cell with text has no such
 * break, and a hard break brings a second one.
 */
const EMPTY_CELL = "p:only-child > br:only-child";

/** The widest table whose empty header row is hidden; a wider one keeps it. */
const EMPTY_HEADER_MAX_CELLS = 8;

/**
 * The `index`th of `cells` header cells, from its row. Sibling steps rather
 * than `:nth-child()` keep every `:has()` argument free of parentheses:
 * jsdom's selector engine misreads one that holds them and throws from
 * `getComputedStyle` in the app's tests.
 */
function headerCell(index: number, cells: number): string {
	const last = index === cells - 1;
	if (index === 0) {
		return last ? "th:only-child" : "th:first-child";
	}
	return [
		":first-child",
		...Array<string>(index - 1).fill("*"),
		last ? "th:last-child" : "th",
	].join(" + ");
}

/**
 * A read-only editor's first table row of exactly `cells` header cells, all
 * empty. `:has()` cannot nest, so "every cell is empty" is written out once
 * per row width.
 */
function emptyHeaderRow(cells: number): string {
	const each = Array.from(
		{ length: cells },
		(_, index) => `:has(> ${headerCell(index, cells)} > ${EMPTY_CELL})`,
	);
	return `${READ_ONLY_EDITOR} tbody > tr:first-child${each.join("")}`;
}

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
	// A header row with nothing in it is left out of a read-only page, as
	// print leaves it out; an editable editor keeps it, so its cells can be
	// filled in. The editor keeps the row in `tbody` and it stays in the DOM,
	// so the zebra, which still counts it, leaves the first data row plain.
	rule(
		Array.from({ length: EMPTY_HEADER_MAX_CELLS }, (_, index) =>
			emptyHeaderRow(index + 1),
		),
		{ display: "none" },
	),
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
	// Cards and columns stack in one column.
	rule(
		[
			dot(THEME.cards),
			`${dot(THEME.cards)}${dot(THEME.cardsThree)}`,
			dot(THEME.columns),
		],
		{ "grid-template-columns": "minmax(0, 1fr)" },
	),
	rule(["table", dot(THEME.dataTable)], {
		display: "block",
		"max-width": "100%",
		"overflow-x": "auto",
	}),
	rule(["th", "td"], { "min-width": "7.5rem" }),
];

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
