/**
 * The Glossy edition's color palette (Fizzy #2589, R35, KTD15).
 *
 * Derived in the browser at render time from the preparer's brand — the
 * organization's named brand color and its Brand kit accents, with any
 * per-edition overrides applied — so a brand change never needs a rebuild.
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
 */

import {
	contrastRatio,
	HEX_COLOR_PATTERN,
	normalizeHexColor,
	readableForegroundFor,
	resolveBrandColor,
	rgbToHex,
} from "@repo/utils/brand-colors";

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
	/** Accents that passed validation, in order. */
	accents: string[];
	/** Twelve fills for Mermaid's `cScale0..11`: primary, accents, then tints. */
	series: string[];
}

export interface GlossyPaletteInput {
	/** The organization's stored brand color name; unknown or missing names resolve to the default brand. */
	brandColorName?: string | null;
	/** Brand kit accents. */
	accentColors?: readonly string[] | null;
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

function resolvePrimary(input: GlossyPaletteInput): string {
	const override = input.overrides?.primary;
	if (override !== undefined && override !== null) {
		return strictHexColor(override) ?? NEUTRAL_GLOSSY_COLORS.primary;
	}
	return (
		strictHexColor(resolveBrandColor(input.brandColorName).hex) ??
		NEUTRAL_GLOSSY_COLORS.primary
	);
}

function resolveAccents(input: GlossyPaletteInput): string[] {
	const source = input.overrides?.accents ?? input.accentColors ?? [];
	const accents: string[] = [];
	for (const value of source) {
		const hex = strictHexColor(value);
		if (hex && !accents.includes(hex)) {
			accents.push(hex);
		}
	}
	return accents;
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
	const primary = resolvePrimary(input);
	const accents = resolveAccents(input);
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
 * Mermaid `themeVariables` for `theme: "base"` (KTD15). Every value is a
 * palette color, so every value is `#rrggbb`.
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
