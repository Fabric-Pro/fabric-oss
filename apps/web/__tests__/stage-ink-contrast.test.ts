/**
 * Stage and status labels stay readable in their own colour (Fizzy #1444).
 *
 * The stage colours are mid-tone fills — amber `#F59E0B` measured 2.15:1 as a
 * label on white — so labels paint them through the `stage-ink` utility, which
 * mixes the colour toward black (light) or white (dark) in OKLab. This file
 * repeats that mix and measures the result for every stage colour on every
 * surface the label can sit on, including the 12.5% tint of a stage chip and
 * the hover wash, in both themes. It also holds the CSS and the constant the
 * mix is read from in step, so neither can drift on its own.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { STAGE_INK_MIX } from "../modules/saas/projects/lib/stories/stage-ink";
import {
	DRAFTING_STAGE_META,
	MATURATION_STATUS_META,
} from "../modules/saas/projects/lib/stories/types";

type Rgb = [number, number, number];

const hex = (value: string): Rgb =>
	[0, 2, 4].map(
		(i) =>
			Number.parseInt(value.replace("#", "").slice(i, i + 2), 16) / 255,
	) as Rgb;
const toLinear = (c: number) =>
	c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const encode = (x: number) => {
	const c = Math.min(1, Math.max(0, x));
	return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
};
const luminance = (c: Rgb) => {
	const [r, g, b] = c.map(toLinear) as Rgb;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgb, b: Rgb) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
		number,
		number,
	];
	return (hi + 0.05) / (lo + 0.05);
};

function toOklab(c: Rgb): Rgb {
	const [r, g, b] = c.map(toLinear) as Rgb;
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

function fromOklab([L, a, b]: Rgb): Rgb {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
	];
}

/** `color-mix(in oklab, colour p%, other)`. */
function mix(colour: Rgb, p: number, other: Rgb): Rgb {
	const a = toOklab(colour);
	const b = toOklab(other);
	return fromOklab(
		a.map((v, i) => p * v + (1 - p) * (b[i] as number)) as Rgb,
	);
}

const over = (c: Rgb, alpha: number, ground: Rgb) =>
	c.map((v, i) => alpha * v + (1 - alpha) * (ground[i] as number)) as Rgb;

// Card/background, muted/secondary, sidebar, hover wash — ordinary and
// high-contrast light share the first three; the high-contrast wash is darker.
const LIGHT = ["#ffffff", "#f1f3f6", "#f6f7f9", "#e8edf2", "#dde3ea"].map(hex);
// Background, card, popover, muted, secondary, hover wash — ordinary and
// high-contrast dark.
const DARK = [
	"#11171c",
	"#182026",
	"#1f272d",
	"#1e262d",
	"#222c34",
	"#26323d",
	"#000000",
	"#0a0d10",
	"#222c35",
].map(hex);
// A stage chip paints `${colour}20` behind its label.
const CHIP_ALPHA = 0x20 / 255;

const stageColours = [
	...Object.entries(DRAFTING_STAGE_META).map(
		([key, meta]) => [`drafting ${key}`, meta.color] as const,
	),
	...Object.entries(MATURATION_STATUS_META).map(
		([key, meta]) => [`maturation ${key}`, meta.color] as const,
	),
];

describe("stage-ink", () => {
	it("is the mix the constant says", () => {
		const css = readFileSync(
			resolve(__dirname, "../app/globals.css"),
			"utf8",
		);
		const block = css.slice(css.indexOf("@utility stage-ink {"));
		expect(block).toContain(
			`color-mix(in oklab, var(--stage-color) ${STAGE_INK_MIX.light * 100}%, black)`,
		);
		expect(block).toContain(
			`color-mix(in oklab, var(--stage-color) ${STAGE_INK_MIX.dark * 100}%, white)`,
		);
	});

	it("covers every stage colour that is not a token", () => {
		// The one token colour, the hidden stage, renders with
		// `text-muted-foreground` instead of the mix.
		const tokens = stageColours.filter(([, c]) => !c.startsWith("#"));
		expect(tokens.map(([name]) => name)).toEqual(["drafting CLOSED"]);
		expect(stageColours.length).toBeGreaterThan(8);
	});

	for (const [name, colour] of stageColours) {
		if (!colour.startsWith("#")) {
			continue;
		}
		const raw = hex(colour);

		it(`${name} ${colour}: ink clears AA on every light surface and chip`, () => {
			const ink = mix(raw, STAGE_INK_MIX.light, [0, 0, 0]);
			for (const surface of LIGHT) {
				expect(ratio(ink, surface)).toBeGreaterThanOrEqual(4.5);
				const chip = over(raw, CHIP_ALPHA, surface);
				expect(ratio(ink, chip)).toBeGreaterThanOrEqual(4.5);
			}
		});

		it(`${name} ${colour}: ink clears AA on every dark surface and chip`, () => {
			const ink = mix(raw, STAGE_INK_MIX.dark, [1, 1, 1]);
			for (const surface of DARK) {
				expect(ratio(ink, surface)).toBeGreaterThanOrEqual(4.5);
				const chip = over(raw, CHIP_ALPHA, surface);
				expect(ratio(ink, chip)).toBeGreaterThanOrEqual(4.5);
			}
		});
	}
});
