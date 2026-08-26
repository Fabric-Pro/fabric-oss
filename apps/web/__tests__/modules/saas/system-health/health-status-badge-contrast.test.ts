/**
 * WCAG AA contrast proof for the customer status badges.
 *
 * These badges are the one place on the status page where colour carries meaning
 * a customer acts on — how bad an outage is. An earlier pass moved the problem
 * states off coloured-text-on-a-10%-tint-of-itself and onto solid fills, on the
 * strength of arithmetic done by hand and never checked against the shipped
 * component. This file is that check, and it immediately found two failures the
 * arithmetic had missed:
 *
 *   - `OPERATIONAL` still used a tint. `text-secondary` on `bg-secondary/10`
 *     measured **4.41:1** over the page background — under the floor. It cleared
 *     on `--card` (4.70:1), which is why eyeballing it on a card would have
 *     looked fine.
 *   - `MAJOR_OUTAGE` was made WORSE by the earlier fix. `--destructive-foreground`
 *     was `#ffffff` in both themes, and white on dark mode's brighter
 *     `--destructive` (`#ef4444`) measures **3.76:1**, against 4.20–4.60:1 for
 *     the tint it replaced.
 *
 * The second was never specific to this badge: ANY surface in the product pairing
 * `bg-destructive` with `text-destructive-foreground` failed AA in dark mode. So
 * the token was fixed rather than the badge, and `theme-token-contrast.test.ts`
 * now guards every `--X` / `--X-foreground` pair.
 *
 * It is a proof rather than a snapshot: it parses the REAL token values out of
 * `tooling/tailwind/theme.css` and the REAL class strings out of the component,
 * models the `dark:` cascade, then computes the ratio. Nothing is hardcoded, so
 * it cannot pass while the shipped colours drift — change a token or a badge
 * class and this recomputes.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const THEME_CSS = resolve(
	__dirname,
	"../../../../../../tooling/tailwind/theme.css",
);
const BADGE_TSX = resolve(
	__dirname,
	"../../../../modules/saas/system-health/components/HealthStatusBadge.tsx",
);

const AA_NORMAL_TEXT = 4.5;
/** The badge label is `text-xs font-medium` — normal text, not large. */

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
	const raw = hex.replace("#", "");
	const full =
		raw.length === 3
			? raw
					.split("")
					.map((c) => c + c)
					.join("")
			: raw;
	return [
		Number.parseInt(full.slice(0, 2), 16),
		Number.parseInt(full.slice(2, 4), 16),
		Number.parseInt(full.slice(4, 6), 16),
	];
}

/** WCAG 2.1 relative luminance. */
function luminance([r, g, b]: Rgb): number {
	const channel = (value: number) => {
		const s = value / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return ((light as number) + 0.05) / ((dark as number) + 0.05);
}

/** Alpha-composite `fg` at `alpha` over opaque `bg`, as a browser would. */
function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
	return [0, 1, 2].map((i) =>
		Math.round((fg[i] as number) * alpha + (bg[i] as number) * (1 - alpha)),
	) as Rgb;
}

/**
 * Read one theme block's custom properties. The file has exactly two:
 * `:root` (light) and `.dark`.
 */
function readTokens(theme: "light" | "dark"): Map<string, string> {
	const css = readFileSync(THEME_CSS, "utf8");
	const startMarker = theme === "light" ? "\t:root {" : "\t.dark {";
	const start = css.indexOf(startMarker);
	if (start === -1) throw new Error(`theme block ${theme} not found`);
	// Blocks are siblings inside `@layer base`, closed by a tab-indented brace.
	const end = css.indexOf("\n\t}", start);
	const block = css.slice(start, end === -1 ? undefined : end);

	const tokens = new Map<string, string>();
	for (const [, name, value] of block.matchAll(
		/^\s*--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/gm,
	)) {
		if (name && value) tokens.set(name, value);
	}
	return tokens;
}

/**
 * Resolve a Tailwind colour utility (`bg-secondary/10`, `text-muted-foreground`)
 * to an RGB triple, compositing any `/alpha` over the theme background.
 */
function resolveUtility(
	utility: string,
	tokens: Map<string, string>,
): Rgb | undefined {
	const match = utility.match(/^(?:bg|text|border)-([\w-]+?)(?:\/(\d+))?$/);
	if (!match) return undefined;
	const [, token, alpha] = match;
	const hex = token ? tokens.get(token) : undefined;
	if (!hex) return undefined;
	const rgb = parseHex(hex);
	if (!alpha) return rgb;
	const background = tokens.get("background");
	if (!background) throw new Error("no --background token");
	return composite(rgb, Number(alpha) / 100, parseHex(background));
}

interface BadgeTone {
	status: string;
	classes: string[];
}

/** Pull the real `cls` strings out of the component, keyed by status. */
function readBadgeTones(): BadgeTone[] {
	const source = readFileSync(BADGE_TSX, "utf8");
	const tones: BadgeTone[] = [];
	for (const [, status, cls] of source.matchAll(
		/(\w+):\s*\{[^}]*?cls:\s*"([^"]+)"/g,
	)) {
		if (status && cls) tones.push({ status, classes: cls.split(/\s+/) });
	}
	return tones;
}

/**
 * The utility that actually applies for `theme`, modelling the cascade: a
 * `dark:`-prefixed utility wins in dark mode, the unprefixed one otherwise.
 *
 * Without this the test would read only the base class and report a fail for a
 * badge the browser renders correctly — and, worse, would report a PASS for a
 * `dark:` override that fails.
 */
function effectiveUtility(
	classes: string[],
	prefix: "bg" | "text",
	theme: "light" | "dark",
): string | undefined {
	const base = classes.find((c) => c.startsWith(`${prefix}-`));
	if (theme === "light") return base;
	const darkOverride = classes.find((c) => c.startsWith(`dark:${prefix}-`));
	return darkOverride ? darkOverride.slice("dark:".length) : base;
}

const tones = readBadgeTones();

describe("HealthStatusBadge contrast", () => {
	it("parsed every status tone out of the component", () => {
		// A regex that silently matched nothing would make every ratio assertion
		// below vacuously true — the failure mode that makes a green contrast
		// test worthless.
		expect(tones.map((t) => t.status).sort()).toEqual([
			"DEGRADED",
			"MAINTENANCE",
			"MAJOR_OUTAGE",
			"NOT_CONFIGURED",
			"OPERATIONAL",
			"PARTIAL_OUTAGE",
			"UNKNOWN",
		]);
	});

	for (const theme of ["light", "dark"] as const) {
		describe(theme, () => {
			const tokens = readTokens(theme);

			it("resolved the theme tokens", () => {
				expect(tokens.get("background")).toMatch(/^#/);
				expect(tokens.size).toBeGreaterThan(10);
			});

			for (const tone of tones) {
				it(`${tone.status} label clears AA`, () => {
					const bgClass = effectiveUtility(tone.classes, "bg", theme);
					const fgClass = effectiveUtility(
						tone.classes,
						"text",
						theme,
					);
					expect(bgClass, `${tone.status} has no bg-*`).toBeDefined();
					expect(
						fgClass,
						`${tone.status} has no text-*`,
					).toBeDefined();

					const bg = resolveUtility(bgClass as string, tokens);
					const fg = resolveUtility(fgClass as string, tokens);
					// If either fails to resolve the badge is using a token this
					// test does not know about — that is a failure, not a skip.
					expect(bg, bgClass).toBeDefined();
					expect(fg, fgClass).toBeDefined();

					const ratio = contrastRatio(bg as Rgb, fg as Rgb);
					expect(
						ratio,
						`${tone.status} ${fgClass} on ${bgClass} = ${ratio.toFixed(2)}:1`,
					).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
				});
			}
		});
	}
});

describe("the contrast maths itself", () => {
	// Without these, a bug in luminance() could make every badge "pass".
	it("computes the known extremes", () => {
		expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 1);
		expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBeCloseTo(
			1,
			5,
		);
	});

	it("reproduces the tint failures that motivated the solid fills", () => {
		// Measured over `--card`, the surface the component list actually sits on.
		// `text-highlight` on `bg-highlight/10` = 2.83:1 in light mode, and
		// `text-destructive` on `bg-destructive/10` = 4.20:1 in dark mode. Both
		// under the floor, which is why no badge uses a tint any more.
		const light = readTokens("light");
		const highlight = parseHex(light.get("highlight") as string);
		const lightTint = composite(
			highlight,
			0.1,
			parseHex(light.get("card") as string),
		);
		expect(contrastRatio(lightTint, highlight)).toBeLessThan(
			AA_NORMAL_TEXT,
		);

		const dark = readTokens("dark");
		const destructive = parseHex(dark.get("destructive") as string);
		const darkTint = composite(
			destructive,
			0.1,
			parseHex(dark.get("card") as string),
		);
		expect(contrastRatio(darkTint, destructive)).toBeLessThan(
			AA_NORMAL_TEXT,
		);
	});

	it("no longer needs a local override for dark-mode destructive", () => {
		// This assertion is inverted from the one it replaces. The badge originally
		// carried `dark:text-background` because `--destructive-foreground` was
		// #ffffff and measured 3.76:1 on dark mode's brighter `--destructive`. The
		// failure was never specific to this badge — every
		// `bg-destructive` + `text-destructive-foreground` pairing in the product
		// had it — so the TOKEN was fixed instead, and the override removed.
		// `theme-token-contrast.test.ts` guards the token itself.
		const dark = readTokens("dark");
		expect(
			contrastRatio(
				parseHex(dark.get("destructive") as string),
				parseHex(dark.get("destructive-foreground") as string),
			),
		).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
	});
});
