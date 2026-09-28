/**
 * Brand colour primitives shared by the organization theme, the Glossy
 * renderer and the website brand extractor.
 *
 * Pure functions and data only: this module is imported by client components,
 * so it must not pull in anything the browser bundle cannot carry.
 */

/**
 * Pick the label colour for a filled brand control: whichever of near-white or
 * near-black actually clears WCAG 2.1 AA (4.5:1) on that fill.
 *
 * Computed rather than stored per brand so a brand added later cannot ship with an
 * illegible label. Seven of the eight brands here need the DARK ink — white on them
 * measures 3.30-4.47:1 — and only `red` takes the light one. Nothing in between
 * works: `#111110`, the ink `--secondary-foreground` uses, leaves `indigo` and
 * `purple` short of the floor, so the dark candidate is pure black.
 *
 * Enforced by `apps/web/__tests__/org-brand-palette-contrast.test.ts`.
 */
export const LIGHT_INK = "#fff7f7";
export const DARK_INK = "#000000";

/** WCAG 2.1 relative luminance of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
	const raw = hex.replace("#", "");
	const channel = (offset: number) => {
		const value = Number.parseInt(raw.slice(offset, offset + 2), 16) / 255;
		return value <= 0.03928
			? value / 12.92
			: ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG 2.1 contrast ratio between two `#rrggbb` colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
	const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort(
		(x, y) => y - x,
	);
	return ((lighter as number) + 0.05) / ((darker as number) + 0.05);
}

export function readableForegroundFor(fillHex: string): string {
	return contrastRatio(fillHex, DARK_INK) >= contrastRatio(fillHex, LIGHT_INK)
		? DARK_INK
		: LIGHT_INK;
}

/**
 * A `#rrggbb` colour, either case; `#rgb` shorthand is not accepted.
 *
 * Spelled with both cases rather than the `i` flag: schemas pass it to
 * `z.string().regex()`, and the published OpenAPI document carries only the
 * pattern's source, so a flag would silently narrow it to lowercase there.
 */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const SHORT_HEX = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;

/**
 * Normalize an untrusted colour string to lowercase `#rrggbb`, or `null`.
 *
 * Only `#rgb` and `#rrggbb` are accepted. Anything else — named colours,
 * `rgb()`, or a value smuggling CSS such as `red;background:url(x)` — is
 * dropped rather than interpreted, because the result is interpolated into
 * rendered styles.
 */
export function normalizeHexColor(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (HEX_COLOR_PATTERN.test(trimmed)) {
		return trimmed.toLowerCase();
	}
	const short = SHORT_HEX.exec(trimmed);
	if (short) {
		const [, r, g, b] = short;
		return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
	}
	return null;
}

/** `#rrggbb` for 0-255 channel values (clamped and rounded). */
export function rgbToHex(r: number, g: number, b: number): string {
	const channel = (value: number) =>
		Math.max(0, Math.min(255, Math.round(value)))
			.toString(16)
			.padStart(2, "0");
	return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export interface BrandColorValue {
	hex: string;
	hue: string;
	saturation: string;
	lightness: string;
	/** Brand colour as INK on a surface — links and small text. Solved per
	 * brand to clear WCAG 2.1 AA (>=4.5:1) against the worst-case surface in
	 * each theme; a single lightness does not work across hues (indigo fails
	 * where teal passes, and vice versa). */
	ink: string;
	inkDark: string;
}

// Brand color to hex and HSL values for CSS variables
// Each color includes: hex (for --primary) and hsl components. The label colour
// is DERIVED via `readableForegroundFor` rather than stored — it used to be a
// hardcoded "#ffffff" (and one "#fef3f2") on every entry, which failed AA on seven
// of the eight fills.
export const brandColorValues: Record<string, BrandColorValue> = {
	teal: {
		hex: "#0d9488",
		hue: "173",
		saturation: "80%",
		lightness: "40%",
		ink: "#0e7c6f",
		inkDark: "#19e6ce",
	},
	blue: {
		hex: "#3b82f6",
		hue: "217",
		saturation: "91%",
		lightness: "60%",
		ink: "#0a5adb",
		inkDark: "#3780f6",
	},
	purple: {
		hex: "#8b5cf6",
		hue: "271",
		saturation: "81%",
		lightness: "56%",
		ink: "#7616d0",
		inkDark: "#ab62ef",
	},
	pink: {
		hex: "#ec4899",
		hue: "330",
		saturation: "81%",
		lightness: "60%",
		ink: "#d01673",
		inkDark: "#eb3d94",
	},
	orange: {
		hex: "#ea580c",
		hue: "25",
		saturation: "95%",
		lightness: "53%",
		ink: "#b84f05",
		inkDark: "#f96b06",
	},
	green: {
		hex: "#16a34a",
		hue: "142",
		saturation: "71%",
		lightness: "45%",
		ink: "#157e3c",
		inkDark: "#25da67",
	},
	red: {
		/* The Fabric crimson from the design system, not Tailwind's red-600. */
		hex: "#eb0600",
		hue: "2",
		saturation: "100%",
		lightness: "46%",
		ink: "#b30000",
		inkDark: "#ff8577",
	},
	indigo: {
		hex: "#6366f1",
		hue: "239",
		saturation: "84%",
		lightness: "67%",
		ink: "#1216d3",
		inkDark: "#7779f3",
	},
};

/** The brand an organization without a stored choice gets (Fabric crimson). */
const DEFAULT_BRAND_COLOR = "red";

/**
 * The values for a stored brand colour name, falling back to the default
 * brand for a missing or unknown name. Own keys only, so a name such as
 * `constructor` cannot resolve to an `Object.prototype` member.
 */
export function resolveBrandColor(
	name: string | null | undefined,
): BrandColorValue {
	const key = name || DEFAULT_BRAND_COLOR;
	const fallback = brandColorValues[DEFAULT_BRAND_COLOR] as BrandColorValue;
	return Object.hasOwn(brandColorValues, key)
		? (brandColorValues[key] ?? fallback)
		: fallback;
}
