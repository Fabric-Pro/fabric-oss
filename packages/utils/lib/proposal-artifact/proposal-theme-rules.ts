/**
 * What every layer of the Proposal theme (`./proposal-theme`) builds its
 * rules from: the semantic class vocabulary, the rule and selector helpers,
 * the font stacks and ink washes, and the emitter that scopes each rule under
 * its theme root.
 *
 * A module of its own so the print layer (`./proposal-theme-print`) shares
 * them with the base and live layers without importing the stylesheet module
 * it is part of.
 *
 * Pure functions and data only: client components import this module, so it
 * must not pull in anything the browser bundle cannot carry.
 */

import { NEUTRAL_THEME } from "./theme-tokens";

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
	/** A card grid; three cards share one row (`cardsThree`). */
	cards: "pa-cards",
	cardsThree: "pa-cards-3",
	card: "pa-card",
	cardLabel: "pa-card-label",
	cardTitle: "pa-card-title",
	cardText: "pa-card-text",
	/**
	 * Two columns side by side. A column heading is a styled paragraph, not
	 * a heading element, so it never joins the outline or the contents.
	 */
	columns: "pa-columns",
	column: "pa-column",
	columnHeading: "pa-column-heading",
	callout: "pa-callout",
	dataTable: "pa-data-table",
	/**
	 * A data table whose first column holds only short ids, set in mono.
	 * Only print can tell, so only print writes it.
	 */
	idColumn: "pa-id-column",
	/**
	 * An ordered list whose every item opens with bold text, numbered as
	 * mono "01", "02"… in the label colour. Only print can tell: no selector
	 * can look two levels into every item of the editor's list, so the live
	 * page keeps its decimals.
	 */
	steps: "pa-steps",
	cover: "pa-cover",
	sectionOpener: "pa-section-opener",
} as const;

export type Declarations = Readonly<Record<string, string>>;

export interface ThemeRule {
	/** Selectors relative to the theme root; `&` is the root itself. */
	selectors: readonly string[];
	declarations: Declarations;
}

export function rule(
	selectors: string | readonly string[],
	declarations: Declarations,
): ThemeRule {
	return {
		selectors: typeof selectors === "string" ? [selectors] : selectors,
		declarations,
	};
}

/** `.name` for a class in the vocabulary. */
export function dot(name: string): string {
	return `.${name}`;
}

export const NEUTRAL_FAMILY = `"${NEUTRAL_THEME.fonts.body}"`;
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
export const FONT_BODY = `var(--pa-font-body, ${NEUTRAL_FAMILY}), ${SANS_FALLBACK}`;
export const FONT_DISPLAY = `var(--pa-font-display, ${NEUTRAL_DISPLAY}), var(--font-poppins, ${NEUTRAL_DISPLAY}), ${SANS_FALLBACK}`;
/**
 * The mono role: eyebrows, labels, header cells, captions in print. Set at
 * 400 or 500 only, the weights both targets load; a heavier one would be
 * drawn as a synthetic bold.
 */
export const FONT_MONO_ROLE = `var(--pa-font-mono, ${NEUTRAL_MONO}), var(--font-jetbrains-mono, ${NEUTRAL_MONO}), ui-monospace, monospace`;
/** Code is always set in a real monospace, whatever the brand. */
export const FONT_CODE = `ui-monospace, var(--font-mono, Menlo), Menlo, Consolas, "Liberation Mono", monospace`;

/** A faint wash of ink on the paper, for code and the app's muted fills. */
export const WASH = "color-mix(in srgb, var(--pa-ink) 5%, var(--pa-surface))";

/** The light grey behind a callout. */
export const CALLOUT_GREY =
	"color-mix(in srgb, var(--pa-ink) 6%, var(--pa-surface))";

/** Every other data row. */
export const ZEBRA = "color-mix(in srgb, var(--pa-ink) 4%, var(--pa-surface))";

/** The dark grey of every third stat tile, a step lighter than the ink. */
export const INK_GREY =
	"color-mix(in srgb, var(--pa-on-ink) 12%, var(--pa-ink))";

/**
 * Inter's contextual alternates turn a hyphen between digits into a
 * private-use glyph in text extracted from the PDF, so they are off for the
 * whole document, margin boxes included.
 */
export const NO_CONTEXTUAL = "no-contextual";

export const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

function scope(root: string, selector: string): string {
	return selector === "&" ? root : `${root} ${selector}`;
}

export function block(
	selectors: readonly string[],
	declarations: Declarations,
	indent = "",
): string {
	const lines = Object.entries(declarations).map(
		([property, value]) => `${indent}\t${property}: ${value};`,
	);
	return `${indent}${selectors.join(`,\n${indent}`)} {\n${lines.join("\n")}\n${indent}}`;
}

export function emitRules(
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

export function atRule(prelude: string, body: string): string {
	return `${prelude} {\n${body}\n}`;
}
