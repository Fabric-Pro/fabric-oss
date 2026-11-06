/**
 * The cover letter's rules in the print layer (`./proposal-theme-print`):
 * the page Main's first section prints on when its heading is "Cover
 * letter", between the cover and the contents, under the running footer like
 * every page after the cover. It takes no section number and no contents
 * entry.
 *
 * The print layer spreads these rules into its own in the place they had
 * there, so its stylesheet does not change. The letter's class names stay in
 * `PROPOSAL_PRINT_CLASSES` with every other print class, and its head is
 * sized from the cover's brand row; both are passed in rather than imported,
 * because the print layer imports this module.
 *
 * Pure functions and data only: client components import the print layer,
 * so this module must not pull in anything the browser bundle cannot carry.
 */

import type { PROPOSAL_PRINT_CLASSES } from "./proposal-theme-print";
import {
	dot,
	FONT_MONO_ROLE,
	rule,
	type ThemeRule,
} from "./proposal-theme-rules";

/** The cover's brand row, which the letter's head is sized from. */
export interface LetterHeadSizes {
	/** The cover's logo row; the letter's head is at least this tall. */
	brandsHeight: string;
	/** A logo's height on the cover, which the letter's logo keeps. */
	logoHeight: string;
}

/** The cover letter's rules, in the order the print layer emits them. */
export function letterRules(
	print: typeof PROPOSAL_PRINT_CLASSES,
	sizes: LetterHeadSizes,
): ThemeRule[] {
	return [
		rule(dot(print.letter), { "break-after": "page" }),
		rule(dot(print.letterHead), {
			display: "flex",
			"align-items": "center",
			"justify-content": "space-between",
			gap: "0.5in",
			"min-height": sizes.brandsHeight,
			margin: "0 0 0.45in",
		}),
		rule(dot(print.letterLogo), {
			display: "block",
			width: "auto",
			height: "auto",
			"max-width": "2.4in",
			"max-height": sizes.logoHeight,
			"object-fit": "contain",
			"border-radius": "0",
		}),
		// A mark too light to read on the paper sits on a plate of the ink.
		rule(dot(print.letterLogoPlate), {
			padding: "7pt 10pt",
			"border-radius": "5pt",
			"background-color": "var(--pa-ink)",
		}),
		rule([dot(print.letterLabel), dot(print.letterDate)], {
			"font-family": FONT_MONO_ROLE,
			"font-size": "7.5pt",
			"font-weight": "500",
			"line-height": "1.4",
			"letter-spacing": "0.16em",
			"text-transform": "uppercase",
		}),
		// The label keeps to the right edge, with or without a logo.
		rule(dot(print.letterLabel), {
			margin: "0 0 0 auto",
			color: "var(--pa-muted)",
		}),
		rule(dot(print.letterDate), {
			margin: "0 0 1.8em",
			color: "var(--pa-label)",
		}),
		rule(dot(print.letterSubject), { "font-weight": "700" }),
		rule(dot(print.letterSigner), { margin: "1.6em 0 0.2em" }),
		rule(dot(print.letterSignerRole), { color: "var(--pa-muted)" }),
		// An address in the signature reads as part of the line, not a link.
		rule(`${dot(print.letterSignerRole)} a`, {
			color: "inherit",
			"text-decoration": "none",
		}),
	];
}
