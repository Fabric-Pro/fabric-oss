export type EmbedTheme = "light" | "dark";

/**
 * Resolve the embed iframe's query params. Single-locale app today, so the only
 * param is `theme`; unknown/missing values fall back to "light".
 */
export function resolveEmbedParams(
	searchParams: { theme?: string | string[] } | undefined,
): { theme: EmbedTheme } {
	const raw = searchParams?.theme;
	const value = Array.isArray(raw) ? raw[0] : raw;
	return { theme: value === "dark" ? "dark" : "light" };
}

const RELEASE_WIDGET_FONTS = ["system", "inter", "serif"] as const;
type ReleaseWidgetFont = (typeof RELEASE_WIDGET_FONTS)[number];

/** `#RGB` or `#RRGGBB` only — anything else is rejected (CSS-injection-safe). */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function firstValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function clampInt(
	value: string | undefined,
	lo: number,
	hi: number,
	fallback: number,
): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed)
		? Math.min(hi, Math.max(lo, parsed))
		: fallback;
}

export interface ReleaseWidgetParams {
	theme: EmbedTheme;
	accent: string | null;
	font: ReleaseWidgetFont;
	radius: number;
	width: string;
	density: "comfortable" | "compact";
}

/**
 * Resolve + validate the per-project release-notes widget's theming query
 * params. Every value is allowlisted/clamped server-side so an attacker can't
 * inject CSS via the iframe URL: unknown themes/fonts/densities fall back to
 * safe defaults, accent must be a hex color (else dropped to null), and the
 * numeric radius/width are clamped to fixed ranges.
 */
export function resolveReleaseWidgetParams(
	searchParams: Record<string, string | string[] | undefined> | undefined,
): ReleaseWidgetParams {
	const accent = firstValue(searchParams?.accent);
	const font = firstValue(searchParams?.font);
	const width = firstValue(searchParams?.width);
	return {
		theme: firstValue(searchParams?.theme) === "dark" ? "dark" : "light",
		accent: accent && HEX_COLOR.test(accent) ? accent : null,
		font: (RELEASE_WIDGET_FONTS as readonly string[]).includes(font ?? "")
			? (font as ReleaseWidgetFont)
			: "system",
		radius: clampInt(firstValue(searchParams?.radius), 0, 24, 12),
		// width: literal "100%" passes through; otherwise a bare clamped integer STRING
		// (e.g. "480") — the consumer appends "px" for the numeric case.
		width:
			width === "100%" ? "100%" : String(clampInt(width, 280, 640, 480)),
		density:
			firstValue(searchParams?.density) === "compact"
				? "compact"
				: "comfortable",
	};
}
