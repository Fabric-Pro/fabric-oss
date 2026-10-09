/**
 * The color palette for generated visuals, and the one placeholder fill
 * (Fizzy #2589, Fizzy #2801).
 *
 * Derived at render time from both brands — the preparer's named brand
 * color and Brand kit accents, with any per-edition overrides applied, then
 * the recipient's colors — so a brand change never needs a rebuild. A Glossy
 * edition derives it in the browser; a Proposal's visuals are filled by the
 * worker before they are saved. Both import this module, so the two resolve
 * every placeholder identically.
 *
 * The preparer's brand leads whenever the preparer set one: primary is the
 * override, else the chosen theme color, else the first preparer accent,
 * else the recipient's first color, else neutral. An organization that
 * never chose a theme color gets neutral visuals, not the app theme's
 * crimson default, so `resolveBrandColor` is not the source here.
 *
 * Two rules keep untrusted input out of rendered output:
 * - only a `#rrggbb` string passes; anything else, including short hex and
 *   CSS smuggled into a color field, is dropped or replaced by neutral;
 * - a brand color is used as text or as a line on the white page only when
 *   it clears WCAG contrast there; otherwise that role falls back to
 *   neutral. Ink on a brand fill is always `readableForegroundFor` the fill.
 *
 * The neutral values are export colors for the PDF, DOCX, and rasterized
 * visuals — not UI tokens.
 *
 * No Node built-ins: the browser bundle imports this module.
 */

import {
	contrastRatio,
	findBrandColor,
	HEX_COLOR_PATTERN,
	normalizeHexColor,
	readableForegroundFor,
	rgbToHex,
} from "../brand-colors";
import { VISUAL_COLOR_PLACEHOLDERS } from "./visual-templates";

const PAGE = "#ffffff";

/** Fallbacks for a missing, invalid, or low-contrast brand color. */
export const NEUTRAL_GLOSSY_COLORS = {
	primary: "#374151",
	heading: "#1f2937",
	ink: "#1f2937",
	muted: "#4b5563",
	border: "#9ca3af",
	surface: "#f3f4f6",
} as const;

/** WCAG 2.1 AA for text (1.4.3). */
const TEXT_CONTRAST = 4.5;
/** WCAG 2.1 AA for graphical objects such as outlines and edges (1.4.11). */
const GRAPHIC_CONTRAST = 3;
/** Mermaid colors timeline and mindmap sections from `cScale0..11`. */
const SERIES_LENGTH = 12;
/** Share of the brand color in the node and card fill; the rest is white. */
const SURFACE_TINT = 0.12;

export interface GlossyPalette {
	/** Brand fill for the cover band and the first series color. */
	primary: string;
	/** Ink on a `primary` fill. */
	onPrimary: string;
	/** Headings and emphasis on the page: `primary` when it clears 4.5:1 there. */
	heading: string;
	/** Body text. */
	ink: string;
	/** Secondary text: labels, captions, the provenance line. */
	muted: string;
	/** Light tint of `primary` for node, card, and table-header fills. */
	surface: string;
	/** Outlines, edges, and rules: `primary` when it clears 3:1 on the page. */
	border: string;
	/**
	 * Accents that passed validation, in order: the preparer's, then the
	 * recipient's, each once and none equal to `primary`.
	 */
	accents: string[];
	/** Twelve fills for Mermaid's `cScale0..11`: primary, accents, then tints. */
	series: string[];
}

export interface GlossyPaletteInput {
	/** The organization's stored brand color name; a missing or unknown name means none was chosen. */
	brandColorName?: string | null;
	/** Brand kit accents. */
	accentColors?: readonly string[] | null;
	/** The project's recipient brand colors; they follow the preparer's. */
	recipientColors?: readonly string[] | null;
	/**
	 * Per-edition preparer overrides from the Align-first panel. A supplied
	 * override replaces the brand value; one that fails validation becomes
	 * neutral rather than a guess.
	 */
	overrides?: {
		primary?: string | null;
		accents?: readonly string[] | null;
	} | null;
}

/** Lowercase `#rrggbb`, or `null` for anything else — `#rgb` included. */
export function strictHexColor(value: unknown): string | null {
	if (typeof value !== "string" || !HEX_COLOR_PATTERN.test(value.trim())) {
		return null;
	}
	return normalizeHexColor(value);
}

/** `weight` of `color` over white, as `#rrggbb`. */
function tint(color: string, weight: number): string {
	const channel = (offset: number) =>
		Number.parseInt(color.slice(offset, offset + 2), 16);
	const mix = (value: number) => value * weight + 255 * (1 - weight);
	return rgbToHex(mix(channel(1)), mix(channel(3)), mix(channel(5)));
}

/**
 * The hex of the theme color the organization chose, or `null` when it chose
 * none. A missing or unknown name is "not chosen" here, where the app theme
 * (`resolveBrandColor`) falls back to crimson; both read the stored name
 * through `findBrandColor`.
 */
export function chosenBrandColor(
	name: string | null | undefined,
): string | null {
	return strictHexColor(findBrandColor(name)?.hex);
}

/** The colors that pass `strictHexColor`, in order; the rest are dropped. */
function validColors(values: readonly unknown[] | null | undefined): string[] {
	return (values ?? []).flatMap((value) => strictHexColor(value) ?? []);
}

/** Primary and accents by the brand precedence above. */
function resolveColors(input: GlossyPaletteInput): {
	primary: string;
	accents: string[];
} {
	// Override accents replace the Brand kit's for this edition, so they are
	// the preparer accents a missing theme color falls back to.
	const preparerAccents = validColors(
		input.overrides?.accents ?? input.accentColors,
	);
	const recipientColors = validColors(input.recipientColors);
	const override = input.overrides?.primary;
	const primary =
		override !== undefined && override !== null
			? (strictHexColor(override) ?? NEUTRAL_GLOSSY_COLORS.primary)
			: (chosenBrandColor(input.brandColorName) ??
				preparerAccents[0] ??
				recipientColors[0] ??
				NEUTRAL_GLOSSY_COLORS.primary);
	const accents: string[] = [];
	for (const color of [...preparerAccents, ...recipientColors]) {
		if (color !== primary && !accents.includes(color)) {
			accents.push(color);
		}
	}
	return { primary, accents };
}

/** Primary and accents, then rounds of lighter tints of each, to twelve colors. */
function buildSeries(primary: string, accents: readonly string[]): string[] {
	const bases = [primary, ...accents].slice(0, SERIES_LENGTH);
	const series = [...bases];
	const rounds = Math.ceil((SERIES_LENGTH - bases.length) / bases.length);
	for (let round = 1; series.length < SERIES_LENGTH; round++) {
		const weight = 1 - (round / (rounds + 1)) * 0.75;
		for (const base of bases) {
			if (series.length >= SERIES_LENGTH) {
				break;
			}
			series.push(tint(base, weight));
		}
	}
	return series;
}

export function deriveGlossyPalette(
	input: GlossyPaletteInput = {},
): GlossyPalette {
	const { primary, accents } = resolveColors(input);
	const onPage = contrastRatio(primary, PAGE);
	const ink = NEUTRAL_GLOSSY_COLORS.ink;
	const surface = tint(primary, SURFACE_TINT);

	return {
		primary,
		onPrimary: readableForegroundFor(primary),
		heading:
			onPage >= TEXT_CONTRAST ? primary : NEUTRAL_GLOSSY_COLORS.heading,
		ink,
		muted: NEUTRAL_GLOSSY_COLORS.muted,
		// A very dark brand would tint to a fill that fights body text.
		surface:
			contrastRatio(ink, surface) >= TEXT_CONTRAST
				? surface
				: NEUTRAL_GLOSSY_COLORS.surface,
		border:
			onPage >= GRAPHIC_CONTRAST ? primary : NEUTRAL_GLOSSY_COLORS.border,
		accents,
		series: buildSeries(primary, accents),
	};
}

/**
 * Mermaid `themeVariables` for `theme: "base"`. Every value is a palette
 * color, so every value is `#rrggbb`.
 */
export function glossyMermaidThemeVariables(
	palette: GlossyPalette,
): Record<string, string> {
	const variables: Record<string, string> = {
		background: PAGE,
		primaryColor: palette.surface,
		primaryTextColor: palette.ink,
		primaryBorderColor: palette.border,
		secondaryColor: palette.accents[0]
			? tint(palette.accents[0], SURFACE_TINT)
			: palette.surface,
		secondaryTextColor: palette.ink,
		secondaryBorderColor: palette.border,
		tertiaryColor: PAGE,
		tertiaryTextColor: palette.ink,
		tertiaryBorderColor: palette.border,
		mainBkg: palette.surface,
		nodeBorder: palette.border,
		clusterBkg: PAGE,
		clusterBorder: palette.border,
		lineColor: palette.border,
		textColor: palette.ink,
		titleColor: palette.heading,
		edgeLabelBackground: PAGE,
	};
	palette.series.forEach((color, index) => {
		variables[`cScale${index}`] = color;
		variables[`cScaleLabel${index}`] = readableForegroundFor(color);
	});
	return variables;
}

const PLACEHOLDER_ROLES: ReadonlyArray<
	readonly [string, (palette: GlossyPalette) => string]
> = [
	[VISUAL_COLOR_PLACEHOLDERS.surface, (palette) => palette.surface],
	[VISUAL_COLOR_PLACEHOLDERS.border, (palette) => palette.border],
	// Stat values are text on the card fill, so they take the text-safe brand color.
	[VISUAL_COLOR_PLACEHOLDERS.primary, (palette) => palette.heading],
	[VISUAL_COLOR_PLACEHOLDERS.ink, (palette) => palette.ink],
	[VISUAL_COLOR_PLACEHOLDERS.muted, (palette) => palette.muted],
];

/**
 * Replace the visual templates' color placeholders with palette values. A
 * value that is not `#rrggbb` is refused outright rather than interpolated.
 */
export function fillVisualColors(
	source: string,
	palette: GlossyPalette,
): string {
	let filled = source;
	for (const [placeholder, role] of PLACEHOLDER_ROLES) {
		const color = strictHexColor(role(palette));
		if (!color) {
			throw new Error(`Palette color for ${placeholder} is not #rrggbb.`);
		}
		filled = filled.split(placeholder).join(color);
	}
	return filled;
}
