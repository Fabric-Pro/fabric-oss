/**
 * WCAG AA guard on every `--X` / `--X-foreground` pair in the design tokens.
 *
 * A `*-foreground` token exists for exactly one job: to be legible on its own
 * fill. So the pairing is checkable mechanically, and it turned out two pairs did
 * not clear the 4.5:1 floor — both in dark mode, both affecting controls used
 * across the whole product:
 *
 *   - `--destructive` #ef4444 / #ffffff = **3.76:1**. Fixed in this change: the
 *     foreground is now #111110 (5.02:1), matching every other bright dark-mode
 *     fill in the block, all of which already pair with a dark ink.
 *   - `--primary` #c4556a / #fff7f7 = **4.10:1**, so every primary CTA in dark mode
 *     failed. Also fixed here: the foreground is now #000000 (4.85:1). It had to be
 *     the foreground rather than the fill — darkening `--primary` would break the
 *     ~870 `text-primary` usages that read it as ink — and near-black specifically,
 *     because #111110 reaches only 4.37:1 on that fill.
 *
 * This file guards the whole token set, not just the two. Any NEW pair that fails
 * fails CI.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const THEME_CSS = resolve(__dirname, "../../../tooling/tailwind/theme.css");

const AA_NORMAL_TEXT = 4.5;

/**
 * Pairs known to fail, with the reason they are not simply fixed. **Adding an
 * entry here is a design decision, not a way to silence the test** — each one is
 * a real accessibility failure shipping to users.
 */
const KNOWN_FAILING: Record<string, string> = {
	// EMPTY, and it should stay that way. `dark:primary` lived here at 4.10:1 until
	// the fix in this same change; the entry was asserted as still-failing, so
	// fixing it turned this file red and forced the removal — which is the point of
	// the pattern rather than an inconvenience.
	//
	// **Adding an entry is a design decision, not a way to silence the test.** Each
	// one is a real accessibility failure shipping to users.
};

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
	const [lighter, darker] = [luminance(a), luminance(b)].sort(
		(x, y) => y - x,
	);
	return ((lighter as number) + 0.05) / ((darker as number) + 0.05);
}

/**
 * The four palettes that ship. High contrast (Fizzy #1444) is a class beside
 * `.dark`, so each high-contrast palette is its base palette with the
 * high-contrast block laid over it — which is also what the browser computes.
 */
const THEMES = ["light", "dark", "hc-light", "hc-dark"] as const;
type Theme = (typeof THEMES)[number];

const BLOCK_SELECTOR: Record<
	"light" | "dark" | "high-contrast" | "dark-high-contrast",
	string
> = {
	light: "\t:root {",
	dark: "\t.dark {",
	"high-contrast": "\t.high-contrast {",
	"dark-high-contrast": "\t.dark.high-contrast {",
};

function readBlock(name: keyof typeof BLOCK_SELECTOR): string {
	const css = readFileSync(THEME_CSS, "utf8");
	const start = css.indexOf(BLOCK_SELECTOR[name]);
	if (start === -1) {
		throw new Error(`theme block ${name} not found`);
	}
	const end = css.indexOf("\n\t}", start);
	return css.slice(start, end === -1 ? undefined : end);
}

function readTokens(theme: Theme): Map<string, string> {
	if (theme === "hc-light" || theme === "hc-dark") {
		const base = readTokens(theme === "hc-light" ? "light" : "dark");
		const overlay = parseTokens(
			readBlock(
				theme === "hc-light" ? "high-contrast" : "dark-high-contrast",
			),
		);
		return new Map([...base, ...overlay]);
	}
	return parseTokens(readBlock(theme));
}

function parseTokens(block: string): Map<string, string> {
	const tokens = new Map<string, string>();
	// Two shapes, because a token that is themeable at runtime declares its own
	// default rather than a bare hex: `--primary-ink: var(--primary-ink-light,
	// #9f2a3a)`. Reading only the bare form silently skipped every such token —
	// which is how the SYSTEM tier's own ink escaped the guard written to cover
	// it, leaving one measured tier and one merely asserted. The fallback is the
	// value that ships whenever an organization has set no theme of its own, so
	// it is the one worth measuring.
	for (const [, name, value] of block.matchAll(
		/^\s*--([\w-]+):\s*(?:var\([^,)]+,\s*)?(#[0-9a-fA-F]{3,8})\s*\)?\s*(?:!important\s*)?;/gm,
	)) {
		if (name && value) {
			tokens.set(name, value);
		}
	}
	return tokens;
}

interface Pair {
	theme: Theme;
	name: string;
	fill: string;
	foreground: string;
	ratio: number;
}

function allPairs(): Pair[] {
	const pairs: Pair[] = [];
	for (const theme of THEMES) {
		const tokens = readTokens(theme);
		for (const [name, fill] of tokens) {
			if (name.endsWith("-foreground")) {
				continue;
			}
			const foreground = tokens.get(`${name}-foreground`);
			if (!foreground) {
				continue;
			}
			pairs.push({
				theme,
				name,
				fill,
				foreground,
				ratio: contrastRatio(parseHex(fill), parseHex(foreground)),
			});
		}
	}
	return pairs;
}

const pairs = allPairs();

describe("design-token fill / foreground contrast", () => {
	it("found pairs in every theme", () => {
		// A parser that matched nothing would make every assertion below vacuously
		// true — the failure mode that makes a green contrast guard worthless.
		for (const theme of THEMES) {
			expect(
				pairs.filter((p) => p.theme === theme).length,
				theme,
			).toBeGreaterThan(5);
		}
	});

	for (const pair of pairs) {
		const key = `${pair.theme}:${pair.name}`;
		const known = KNOWN_FAILING[key];

		if (known) {
			it(`${key} is a KNOWN failure (${known})`, () => {
				// Asserted as still-failing on purpose. When someone fixes it, this
				// flips red and tells them to delete the exception rather than
				// leaving a stale "known issue" behind forever.
				expect(
					pair.ratio,
					`${key} now measures ${pair.ratio.toFixed(2)}:1 — if this is fixed, remove it from KNOWN_FAILING`,
				).toBeLessThan(AA_NORMAL_TEXT);
			});
			continue;
		}

		it(`${key} clears AA`, () => {
			expect(
				pair.ratio,
				`--${pair.name} ${pair.fill} / --${pair.name}-foreground ${pair.foreground} = ${pair.ratio.toFixed(2)}:1`,
			).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
		});
	}

	it("has no accepted failures left", () => {
		// A reviewer seeing this change knows a new accessibility failure was
		// accepted instead of fixed.
		expect(Object.keys(KNOWN_FAILING)).toEqual([]);
	});
});

describe("slider component contrast (WCAG 2.1 1.4.11)", () => {
	// The shared Slider (`modules/ui/components/slider.tsx`) paints its unfilled
	// track in `--muted`, its filled range in `--primary`, and its thumb as a
	// `--primary` disc with a `--background` border. Non-text contrast requires
	// 3:1 between adjacent parts that convey state — filled vs unfilled, and the
	// thumb against whichever segment it overlaps. Over the unfilled track the
	// disc carries it; over the filled range it would vanish into its own
	// colour, so the border carries that case.
	const NON_TEXT = 3;

	for (const theme of THEMES) {
		const tokens = readTokens(theme);

		it(`${theme}: filled range clears 3:1 against the unfilled track`, () => {
			const ratio = contrastRatio(
				parseHex(tokens.get("primary") as string),
				parseHex(tokens.get("muted") as string),
			);
			expect(ratio).toBeGreaterThanOrEqual(NON_TEXT);
		});

		it(`${theme}: thumb border clears 3:1 against the filled range`, () => {
			// The case hue alone cannot carry: same-colour thumb on same-colour
			// range is separated only by the background border.
			const ratio = contrastRatio(
				parseHex(tokens.get("primary") as string),
				parseHex(tokens.get("background") as string),
			);
			expect(ratio).toBeGreaterThanOrEqual(NON_TEXT);
		});
	}
});

describe("ink tokens on the neutral surfaces", () => {
	/**
	 * The `-foreground` guard above covers ink on its OWN fill, which is a
	 * different question from ink on a neutral surface — and the gap let a real
	 * failure ship: the prompt-tier badge coloured its label `text-primary`
	 * (4.02:1 on the dark card) and `text-highlight` (3.14:1 on the light one),
	 * both under AA, with nothing to catch it.
	 *
	 * An `-ink` token exists precisely to be read as text on a neutral surface,
	 * so that pairing is checkable mechanically. Any new `--X-ink` is covered the
	 * moment it is added.
	 *
	 * Both surfaces, not just `--card`: a page decides its own ground, and the
	 * two disagree. The prompt grid renders its cards on `--background` with no
	 * `bg-card` ancestor, and the governance page is a bare `div` — so a guard
	 * that only knew about `--card` would have called a link on the page
	 * background covered when nothing had measured it.
	 */
	for (const theme of THEMES) {
		const tokens = readTokens(theme);
		for (const surface of ["card", "background"] as const) {
			const ground = tokens.get(surface);
			for (const [name, value] of tokens) {
				if (!name.endsWith("-ink") || !ground) {
					continue;
				}
				it(`${theme}:--${name} clears AA on --${surface}`, () => {
					const ratio = contrastRatio(
						parseHex(value),
						parseHex(ground),
					);
					expect(
						ratio,
						`--${name} ${value} on --${surface} ${ground} = ${ratio.toFixed(2)}:1`,
					).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
				});
			}
		}

		for (const surface of [
			"card",
			"background",
			"popover",
			"muted",
			"accent",
		] as const) {
			const ground = tokens.get(surface);
			for (const inkToken of ["primary", "primary-ink"] as const) {
				const value = tokens.get(inkToken);
				it(`${theme}:--${inkToken} clears AA on --${surface}`, () => {
					expect(value, `--${inkToken}`).toBeDefined();
					expect(ground, `--${surface}`).toBeDefined();
					const ratio = contrastRatio(
						parseHex(value as string),
						parseHex(ground as string),
					);
					expect(
						ratio,
						`--${inkToken} ${value} on --${surface} ${ground} = ${ratio.toFixed(2)}:1`,
					).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
				});
			}
		}
	}
});

describe("control border, focus ring, and button interactive states", () => {
	const NON_TEXT = 3;

	for (const theme of THEMES) {
		const tokens = readTokens(theme);

		for (const surface of ["background", "card", "popover"] as const) {
			const ground = tokens.get(surface);
			for (const controlToken of ["input", "ring"] as const) {
				const value = tokens.get(controlToken);
				it(`${theme}:--${controlToken} clears 3:1 non-text contrast on --${surface}`, () => {
					expect(value, `--${controlToken}`).toBeDefined();
					expect(ground, `--${surface}`).toBeDefined();
					const ratio = contrastRatio(
						parseHex(value as string),
						parseHex(ground as string),
					);
					expect(
						ratio,
						`--${controlToken} ${value} on --${surface} ${ground} = ${ratio.toFixed(2)}:1`,
					).toBeGreaterThanOrEqual(NON_TEXT);
				});
			}
		}

		for (const [stateToken, fgToken] of [
			["primary-hover", "primary-foreground"],
			["primary-active", "primary-foreground"],
			["destructive-hover", "destructive-foreground"],
			["destructive-active", "destructive-foreground"],
		] as const) {
			const fill = tokens.get(stateToken);
			const fg = tokens.get(fgToken);
			it(`${theme}:--${stateToken} clears AA with --${fgToken}`, () => {
				expect(fill, `--${stateToken}`).toBeDefined();
				expect(fg, `--${fgToken}`).toBeDefined();
				const ratio = contrastRatio(
					parseHex(fill as string),
					parseHex(fg as string),
				);
				expect(
					ratio,
					`--${stateToken} ${fill} / --${fgToken} ${fg} = ${ratio.toFixed(2)}:1`,
				).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
			});
		}
	}
});

describe("the destructive pair specifically", () => {
	// This is the one this change fixed, and the regression is easy to reintroduce
	// by "restoring" white text on a red button.
	//
	// `secondary` is not in this list any more. It used to be a bright emerald
	// fill (#34d399) that needed a dark ink like the others; the design system
	// made it a neutral dark surface (#262626) whose correct ink is LIGHT, and
	// the pair clears AA in the loop above. Asserting a dark ink on it would be
	// asserting a failure.
	it("uses a dark ink in dark mode, like every other bright fill", () => {
		const dark = readTokens("dark");
		for (const name of ["destructive", "success", "highlight"]) {
			const foreground = dark.get(`${name}-foreground`);
			expect(foreground, `--${name}-foreground`).toBeDefined();
			// Dark ink: luminance well below the midpoint.
			expect(
				luminance(parseHex(foreground as string)),
				`--${name}-foreground ${foreground} should be a dark ink in dark mode`,
			).toBeLessThan(0.2);
		}
	});

	it("keeps white in light mode, where the fill is darker", () => {
		const light = readTokens("light");
		expect(light.get("destructive-foreground")).toBe("#ffffff");
		expect(
			contrastRatio(
				parseHex(light.get("destructive") as string),
				parseHex(light.get("destructive-foreground") as string),
			),
		).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
	});
});

describe("secondary and status text on every surface (Fizzy #1444, AC-13/16)", () => {
	/**
	 * The grey/secondary text the ticket was raised about is `--muted-foreground`,
	 * and it sits on every surface the app paints — the hover wash and the
	 * sidebar rail included, where it measured lowest. The status inks are read
	 * as text too (`text-destructive`, `text-success`). Guarding the token on
	 * every surface is what makes a component that uses it compliant by default,
	 * instead of each instance being checked by hand.
	 */
	const SURFACES = [
		"background",
		"card",
		"popover",
		"muted",
		"secondary",
		"accent",
		"sidebar",
	] as const;
	const INKS = [
		"foreground",
		"muted-foreground",
		"primary",
		"primary-ink",
		"destructive",
		"success",
		"highlight-ink",
		"fab-warn",
		"fab-bad",
		"fab-good",
	] as const;

	for (const theme of THEMES) {
		const tokens = readTokens(theme);
		for (const ink of INKS) {
			for (const surface of SURFACES) {
				it(`${theme}: --${ink} clears AA on --${surface}`, () => {
					const value = tokens.get(ink);
					const ground = tokens.get(surface);
					expect(value, `--${ink}`).toBeDefined();
					expect(ground, `--${surface}`).toBeDefined();
					const ratio = contrastRatio(
						parseHex(value as string),
						parseHex(ground as string),
					);
					expect(
						ratio,
						`--${ink} ${value} on --${surface} ${ground} = ${ratio.toFixed(2)}:1`,
					).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
				});
			}
		}
	}
});

describe("high contrast is materially stronger than AA (Fizzy #1444)", () => {
	/**
	 * Clearing AA is the floor every palette meets; a high-contrast mode that
	 * only met it too would be the default palette with a new name. These are
	 * the margins the high-contrast block promises in its own comment.
	 */
	const ENHANCED_TEXT = 7;
	const STRONG_BORDER = 4.5;

	for (const theme of ["hc-light", "hc-dark"] as const) {
		const tokens = readTokens(theme);

		for (const ink of [
			"foreground",
			"muted-foreground",
			"primary-ink",
			"destructive",
			"success",
			"highlight-ink",
		] as const) {
			for (const surface of [
				"background",
				"card",
				"popover",
				"muted",
				"secondary",
				"accent",
				"sidebar",
			] as const) {
				it(`${theme}: --${ink} reaches 7:1 on --${surface}`, () => {
					const ratio = contrastRatio(
						parseHex(tokens.get(ink) as string),
						parseHex(tokens.get(surface) as string),
					);
					expect(ratio).toBeGreaterThanOrEqual(ENHANCED_TEXT);
				});
			}
		}

		for (const pair of [
			["primary", "primary-foreground"],
			["primary-hover", "primary-foreground"],
			["primary-active", "primary-foreground"],
			["destructive", "destructive-foreground"],
			["success", "success-foreground"],
			["highlight", "highlight-foreground"],
		] as const) {
			it(`${theme}: --${pair[1]} reaches 7:1 on --${pair[0]}`, () => {
				const ratio = contrastRatio(
					parseHex(tokens.get(pair[0]) as string),
					parseHex(tokens.get(pair[1]) as string),
				);
				expect(ratio).toBeGreaterThanOrEqual(ENHANCED_TEXT);
			});
		}

		for (const surface of ["background", "card", "popover"] as const) {
			it(`${theme}: structural --border is visible (4.5:1) on --${surface}`, () => {
				// The default palettes keep --border a hairline (1.3:1) and leave
				// component boundaries to --input; high contrast draws them.
				const ratio = contrastRatio(
					parseHex(tokens.get("border") as string),
					parseHex(tokens.get(surface) as string),
				);
				expect(ratio).toBeGreaterThanOrEqual(STRONG_BORDER);
			});
			for (const control of ["input", "ring"] as const) {
				it(`${theme}: --${control} reaches 7:1 on --${surface}`, () => {
					const ratio = contrastRatio(
						parseHex(tokens.get(control) as string),
						parseHex(tokens.get(surface) as string),
					);
					expect(ratio).toBeGreaterThanOrEqual(ENHANCED_TEXT);
				});
			}
		}
	}
});

describe("the high-contrast blocks themselves (Fizzy #1444)", () => {
	const declared = (name: "high-contrast" | "dark-high-contrast") =>
		[...readBlock(name).matchAll(/^\s*--([\w-]+):/gm)].map((m) => m[1]);

	it("declare the same tokens, so the light block cannot leak into dark", () => {
		// `.high-contrast` comes after `.dark` with equal specificity, so in dark
		// mode any token it declares that `.dark.high-contrast` does not would
		// resolve to the LIGHT high-contrast value.
		expect(new Set(declared("dark-high-contrast"))).toEqual(
			new Set(declared("high-contrast")),
		);
	});

	it("cover every colour token the dark palette sets", () => {
		const darkColours = [...readTokens("dark").keys()];
		const hc = new Set(declared("high-contrast"));
		expect(darkColours.filter((name) => !hc.has(name))).toEqual([]);
	});

	it("hold the focus ring and accent against an organization's brand", () => {
		// OrganizationThemeProvider writes these as inline styles on <html>; only
		// an important declaration outranks that.
		for (const name of ["high-contrast", "dark-high-contrast"] as const) {
			const block = readBlock(name);
			for (const token of ["ring", "fab-accent", "fab-accent-fill"]) {
				expect(block, `${name} --${token}`).toMatch(
					new RegExp(`--${token}:\\s*#[0-9a-fA-F]{6}\\s*!important;`),
				);
			}
			// And the brand-aware ink is set by value, not through the
			// --primary-ink-light/-dark variables the provider writes.
			expect(block).toMatch(/--primary-ink:\s*#[0-9a-fA-F]{6};/);
		}
	});
});
