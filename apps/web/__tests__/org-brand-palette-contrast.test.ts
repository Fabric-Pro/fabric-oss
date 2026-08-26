/**
 * WCAG AA coverage for the organization brand palette, which had none.
 *
 * `OrganizationThemeProvider` overrides `--primary`, `--primary-foreground` and
 * `--primary-ink-*` per organization from a table of eight brand colours. Nothing
 * measured any of it, and the values decide legibility of every primary CTA and
 * brand link inside an org.
 *
 * Two different results, and the distinction matters:
 *
 *   - **The `ink` / `inkDark` values are sound.** Their comment claims they were
 *     solved per brand to clear AA, and against `--background` and `--card` they
 *     do, in both themes. Asserted here so the solved values cannot drift.
 *   - **The `foreground` values are not.** Seven of the eight fail on their own
 *     fill; only `red` passes. That is already noted in `theme.css`, but as prose.
 *
 * The load-bearing addition is `describe("why a foreground tweak cannot fix it")`.
 * The obvious reading of "white text on this button fails contrast" is "pick a
 * better foreground" — and for these fills **no light colour can work at all**,
 * because the luminance it would need exceeds 1.0, i.e. brighter than white. That
 * turns an open-ended design question into a closed one: the FILL has to change,
 * or the label has to go near-black. Proving it is what stops the next person
 * spending an afternoon on it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readableForegroundFor } from "../modules/saas/organizations/components/OrganizationThemeProvider";

const PROVIDER_TSX = resolve(
	__dirname,
	"../modules/saas/organizations/components/OrganizationThemeProvider.tsx",
);

const AA_NORMAL_TEXT = 4.5;

/** Surfaces brand ink is expected to be legible on, per theme. */
const LIGHT_SURFACES = { background: "#f7f6f2", card: "#fffdf9" };
const DARK_SURFACES = { background: "#111110", card: "#1b1a19" };

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
	const raw = hex.replace("#", "");
	return [
		Number.parseInt(raw.slice(0, 2), 16),
		Number.parseInt(raw.slice(2, 4), 16),
		Number.parseInt(raw.slice(4, 6), 16),
	];
}

function luminance([r, g, b]: Rgb): number {
	const channel = (value: number) => {
		const s = value / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
	const [lighter, darker] = [luminance(a), luminance(b)].sort(
		(x, y) => y - x,
	);
	return ((lighter as number) + 0.05) / ((darker as number) + 0.05);
}

interface Brand {
	name: string;
	hex: string;
	foreground: string;
	ink: string;
	inkDark: string;
}

function readBrands(): Brand[] {
	const source = readFileSync(PROVIDER_TSX, "utf8");
	// Search for the terminator AFTER the table's start: the file now exports a
	// helper above the table, so a bare indexOf("export") would slice backwards
	// and silently yield nothing.
	const start = source.indexOf("brandColorValues");
	const table = source.slice(start, source.indexOf("export", start));
	const pattern =
		/(\w+):\s*\{[\s\S]*?hex:\s*"(#[0-9a-fA-F]{6})"[\s\S]*?ink:\s*"(#[0-9a-fA-F]{6})"[\s\S]*?inkDark:\s*"(#[0-9a-fA-F]{6})"/g;
	const brands: Brand[] = [];
	for (const [, name, hex, ink, inkDark] of table.matchAll(pattern)) {
		if (name && hex && ink && inkDark) {
			// The label colour is derived from the fill, not stored, so the test
			// asks the SAME function production uses.
			brands.push({
				name,
				hex,
				foreground: readableForegroundFor(hex),
				ink,
				inkDark,
			});
		}
	}
	return brands;
}

const brands = readBrands();

/** The seven whose fill is too light for a near-white label. */
const DARK_INK_BRANDS = [
	"teal",
	"blue",
	"purple",
	"pink",
	"orange",
	"green",
	"indigo",
] as const;

describe("organization brand palette", () => {
	it("parsed all eight brands", () => {
		// A regex matching nothing would make every assertion below vacuously
		// true — the failure mode that makes a green contrast guard worthless.
		expect(brands.map((b) => b.name)).toEqual([
			"teal",
			"blue",
			"purple",
			"pink",
			"orange",
			"green",
			"red",
			"indigo",
		]);
	});

	describe("brand ink clears AA on the surfaces it appears on", () => {
		// These were solved per brand and the numbers hold. Asserted so they stay
		// solved — a future brand added by copying `hex` into `ink` would fail.
		for (const brand of brands) {
			it(`${brand.name} ink is legible in light mode`, () => {
				for (const [surface, value] of Object.entries(LIGHT_SURFACES)) {
					const ratio = contrastRatio(
						parseHex(brand.ink),
						parseHex(value),
					);
					expect(
						ratio,
						`${brand.name} ink ${brand.ink} on --${surface} ${value} = ${ratio.toFixed(2)}:1`,
					).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
				}
			});

			it(`${brand.name} inkDark is legible in dark mode`, () => {
				for (const [surface, value] of Object.entries(DARK_SURFACES)) {
					const ratio = contrastRatio(
						parseHex(brand.inkDark),
						parseHex(value),
					);
					expect(
						ratio,
						`${brand.name} inkDark ${brand.inkDark} on --${surface} ${value} = ${ratio.toFixed(2)}:1`,
					).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
				}
			});
		}

		it("is measured against background and card, not muted", () => {
			// Honest scope note rather than a silent choice. Several inks land
			// between 4.32 and 4.47 on `--muted`, just under the floor. Whether
			// brand ink is ever rendered on that surface is not established, so it
			// is not asserted — but it is not silently passing either.
			expect(Object.keys(LIGHT_SURFACES)).toEqual(["background", "card"]);
			expect(Object.keys(DARK_SURFACES)).toEqual(["background", "card"]);
		});
	});

	describe("the derived foreground clears AA on every fill", () => {
		// Was seven failures out of eight, with a hardcoded near-white label on
		// every entry. `readableForegroundFor` now picks per fill.
		for (const brand of brands) {
			it(`${brand.name} clears AA`, () => {
				const ratio = contrastRatio(
					parseHex(brand.hex),
					parseHex(brand.foreground),
				);
				expect(
					ratio,
					`${brand.name} ${brand.foreground} on ${brand.hex} = ${ratio.toFixed(2)}:1`,
				).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
			});
		}

		it("picks the dark ink for seven brands and the light one only for red", () => {
			// Pins the shape of the answer. If a future edit flipped the comparison
			// the ratios above would still pass for some brands, so assert the
			// distribution too.
			const dark = brands.filter((b) => b.foreground === "#000000");
			const light = brands.filter((b) => b.foreground !== "#000000");
			expect(dark).toHaveLength(7);
			expect(light.map((b) => b.name)).toEqual(["red"]);
		});
	});

	describe("why the dark ink is the only option for those seven", () => {
		// The whole point of this block. For a fill of luminance L, a LIGHTER
		// foreground reaching ratio R needs luminance >= R*(L+0.05) - 0.05. When
		// that exceeds 1.0 no colour qualifies, because white is 1.0.
		for (const name of DARK_INK_BRANDS) {
			it(`${name}: no light foreground can reach AA on its fill`, () => {
				const brand = brands.find((b) => b.name === name);
				expect(brand, name).toBeDefined();
				const fillLuminance = luminance(parseHex((brand as Brand).hex));
				const requiredLuminance =
					AA_NORMAL_TEXT * (fillLuminance + 0.05) - 0.05;

				expect(
					requiredLuminance,
					`${name} would need a foreground of luminance ${requiredLuminance.toFixed(2)}, but white is 1.0`,
				).toBeGreaterThan(1);
			});
		}

		it("a near-black foreground clears AA on each of them", () => {
			// Which is why `readableForegroundFor` picks it. The alternative would be
			// changing each customer's brand fill.
			for (const name of DARK_INK_BRANDS) {
				const brand = brands.find((b) => b.name === name) as Brand;
				const ratio = contrastRatio(parseHex(brand.hex), [0, 0, 0]);
				expect(
					ratio,
					`${name} on black = ${ratio.toFixed(2)}:1`,
				).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
			}
		});

		it("red is the one brand where the reverse holds", () => {
			// Worth pinning: red passes with white (4.83:1) and FAILS with black
			// (4.35:1), so any palette-wide "just use dark labels" fix would break
			// the default brand. There is no single foreground for all eight.
			const red = brands.find((b) => b.name === "red") as Brand;
			expect(
				contrastRatio(parseHex(red.hex), [255, 255, 255]),
			).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
			expect(contrastRatio(parseHex(red.hex), [0, 0, 0])).toBeLessThan(
				AA_NORMAL_TEXT,
			);
		});
	});
});
