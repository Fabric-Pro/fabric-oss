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

function readTokens(theme: "light" | "dark"): Map<string, string> {
	const css = readFileSync(THEME_CSS, "utf8");
	const start = css.indexOf(theme === "light" ? "\t:root {" : "\t.dark {");
	if (start === -1) throw new Error(`theme block ${theme} not found`);
	const end = css.indexOf("\n\t}", start);
	const block = css.slice(start, end === -1 ? undefined : end);

	const tokens = new Map<string, string>();
	// Two shapes, because a token that is themeable at runtime declares its own
	// default rather than a bare hex: `--primary-ink: var(--primary-ink-light,
	// #9f2a3a)`. Reading only the bare form silently skipped every such token —
	// which is how the SYSTEM tier's own ink escaped the guard written to cover
	// it, leaving one measured tier and one merely asserted. The fallback is the
	// value that ships whenever an organization has set no theme of its own, so
	// it is the one worth measuring.
	for (const [, name, value] of block.matchAll(
		/^\s*--([\w-]+):\s*(?:var\([^,)]+,\s*)?(#[0-9a-fA-F]{3,8})\s*\)?\s*;/gm,
	)) {
		if (name && value) tokens.set(name, value);
	}
	return tokens;
}

interface Pair {
	theme: "light" | "dark";
	name: string;
	fill: string;
	foreground: string;
	ratio: number;
}

function allPairs(): Pair[] {
	const pairs: Pair[] = [];
	for (const theme of ["light", "dark"] as const) {
		const tokens = readTokens(theme);
		for (const [name, fill] of tokens) {
			if (name.endsWith("-foreground")) continue;
			const foreground = tokens.get(`${name}-foreground`);
			if (!foreground) continue;
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
	it("found pairs in both themes", () => {
		// A parser that matched nothing would make every assertion below vacuously
		// true — the failure mode that makes a green contrast guard worthless.
		expect(pairs.filter((p) => p.theme === "light").length).toBeGreaterThan(
			5,
		);
		expect(pairs.filter((p) => p.theme === "dark").length).toBeGreaterThan(
			5,
		);
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
	for (const theme of ["light", "dark"] as const) {
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
	}
});

describe("the destructive pair specifically", () => {
	// This is the one this change fixed, and the regression is easy to reintroduce
	// by "restoring" white text on a red button.
	it("uses a dark ink in dark mode, like every other bright fill", () => {
		const dark = readTokens("dark");
		for (const name of [
			"destructive",
			"secondary",
			"success",
			"highlight",
		]) {
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
