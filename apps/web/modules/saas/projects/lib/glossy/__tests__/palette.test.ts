import {
	brandColorValues,
	contrastRatio,
	DARK_INK,
	resolveBrandColor,
} from "@repo/utils/brand-colors";
import { describe, expect, it } from "vitest";
import {
	chosenBrandColor,
	deriveGlossyPalette,
	type GlossyPalette,
	glossyMermaidThemeVariables,
	NEUTRAL_GLOSSY_COLORS,
	strictHexColor,
} from "../palette";

const HEX = /^#[0-9a-f]{6}$/;

// Sentinels no default can coincide with (checked below): a result equal to
// one of them came from the input, not from a fallback.
const RECIPIENT_FIRST = "#0055aa";
const RECIPIENT = "#aa5500";
const KIT_ACCENT = "#227744";
const OVERRIDE_PRIMARY = "#5b2a86";
const OVERRIDE_ACCENT = "#7a1f5c";
/** Fails 4.5:1 and 3:1 on the white page. */
const PALE_RECIPIENT = "#ffe14d";
const SENTINELS = [
	RECIPIENT_FIRST,
	RECIPIENT,
	KIT_ACCENT,
	OVERRIDE_PRIMARY,
	OVERRIDE_ACCENT,
	PALE_RECIPIENT,
];
const BLUE = brandColorValues.blue?.hex as string;
const CRIMSON = resolveBrandColor(null).hex;

/** Every text role clears WCAG AA where it is drawn. */
function expectReadable(palette: GlossyPalette) {
	expect(contrastRatio(palette.heading, "#ffffff")).toBeGreaterThanOrEqual(
		4.5,
	);
	expect(contrastRatio(palette.ink, "#ffffff")).toBeGreaterThanOrEqual(4.5);
	expect(contrastRatio(palette.muted, "#ffffff")).toBeGreaterThanOrEqual(4.5);
	expect(contrastRatio(palette.ink, palette.surface)).toBeGreaterThanOrEqual(
		4.5,
	);
	expect(
		contrastRatio(palette.onPrimary, palette.primary),
	).toBeGreaterThanOrEqual(4.5);
	const variables = glossyMermaidThemeVariables(palette);
	for (const value of Object.values(variables)) {
		expect(value).toMatch(HEX);
	}
	for (let i = 0; i < 12; i++) {
		expect(
			contrastRatio(
				variables[`cScaleLabel${i}`] as string,
				variables[`cScale${i}`] as string,
			),
		).toBeGreaterThanOrEqual(4.5);
	}
}

describe("strictHexColor", () => {
	it("passes only #rrggbb, lowercased", () => {
		expect(strictHexColor("#0D9488")).toBe("#0d9488");
		expect(strictHexColor(" #0d9488 ")).toBe("#0d9488");
		for (const value of [
			"#fff",
			"teal",
			"rgb(0,0,0)",
			"#0d9488;background:url(x)",
			"#0d94880",
			42,
			null,
		]) {
			expect(strictHexColor(value)).toBeNull();
		}
	});
});

describe("deriveGlossyPalette", () => {
	it("uses the organization's named brand color as primary", () => {
		const palette = deriveGlossyPalette({ brandColorName: "teal" });
		expect(palette.primary).toBe(resolveBrandColor("teal").hex);
		expect(palette.series[0]).toBe(palette.primary);
	});

	it("applies per-edition overrides over the brand", () => {
		const palette = deriveGlossyPalette({
			brandColorName: "teal",
			accentColors: ["#16a34a"],
			overrides: { primary: "#1e3a8a", accents: ["#9333ea"] },
		});
		expect(palette.primary).toBe("#1e3a8a");
		expect(palette.accents).toEqual(["#9333ea"]);
		expect(palette.series.slice(0, 2)).toEqual(["#1e3a8a", "#9333ea"]);
	});

	it("falls back to neutral for a hostile color", () => {
		const palette = deriveGlossyPalette({
			brandColorName: "teal",
			accentColors: ["red;background:url(x)", "#16a34a", "#abc"],
			overrides: { primary: "#000000;} body{display:none" },
		});
		expect(palette.primary).toBe(NEUTRAL_GLOSSY_COLORS.primary);
		expect(palette.accents).toEqual(["#16a34a"]);
		for (const value of Object.values(
			glossyMermaidThemeVariables(palette),
		)) {
			expect(value).toMatch(HEX);
		}
	});

	it("switches ink to dark on a light yellow primary and keeps it off headings", () => {
		const palette = deriveGlossyPalette({
			overrides: { primary: "#fde047" },
		});
		expect(palette.primary).toBe("#fde047");
		expect(palette.onPrimary).toBe(DARK_INK);
		// Yellow on white fails 4.5:1, so headings and outlines go neutral.
		expect(palette.heading).toBe(NEUTRAL_GLOSSY_COLORS.heading);
		expect(palette.border).toBe(NEUTRAL_GLOSSY_COLORS.border);
	});

	it("keeps a dark brand on headings and borders", () => {
		const palette = deriveGlossyPalette({
			overrides: { primary: "#1e3a8a" },
		});
		expect(palette.heading).toBe("#1e3a8a");
		expect(palette.border).toBe("#1e3a8a");
		expect(
			contrastRatio(palette.onPrimary, palette.primary),
		).toBeGreaterThan(4.5);
	});

	it("keeps every role readable and every value #rrggbb", () => {
		for (const name of [
			"teal",
			"blue",
			"purple",
			"pink",
			"orange",
			"green",
			"red",
			"indigo",
		]) {
			const palette = deriveGlossyPalette({ brandColorName: name });
			expect(
				contrastRatio(palette.heading, "#ffffff"),
			).toBeGreaterThanOrEqual(4.5);
			expect(
				contrastRatio(palette.ink, palette.surface),
			).toBeGreaterThanOrEqual(4.5);
			expect(
				contrastRatio(palette.onPrimary, palette.primary),
			).toBeGreaterThanOrEqual(4.5);
			expect(palette.series).toHaveLength(12);
			for (const color of [
				palette.primary,
				palette.onPrimary,
				palette.heading,
				palette.ink,
				palette.muted,
				palette.surface,
				palette.border,
				...palette.series,
			]) {
				expect(color).toMatch(HEX);
			}
		}
	});
});

// Brand precedence (Fizzy #2589 follow-up): neutral without brands, the
// preparer's brand first, the recipient's colors next.
describe("deriveGlossyPalette — brand precedence", () => {
	it("uses sentinels that no default can coincide with", () => {
		const defaults = new Set<string>([
			...Object.values(NEUTRAL_GLOSSY_COLORS),
			...Object.values(brandColorValues).map((brand) => brand.hex),
		]);
		for (const sentinel of SENTINELS) {
			expect(defaults.has(sentinel)).toBe(false);
		}
	});

	it("is neutral with no brand and no recipient, never the app theme's crimson", () => {
		// The app theme keeps its crimson default; only Glossy goes neutral.
		expect(CRIMSON).toBe(brandColorValues.red?.hex);
		for (const input of [
			{},
			{ brandColorName: null },
			{ brandColorName: "" },
			{ brandColorName: null, accentColors: [], recipientColors: [] },
		]) {
			const palette = deriveGlossyPalette(input);
			expect(palette.primary).toBe(NEUTRAL_GLOSSY_COLORS.primary);
			expect(palette.primary).not.toBe(CRIMSON);
			expect(palette.accents).toEqual([]);
			expectReadable(palette);
		}
	});

	it("makes the recipient's first color primary when the preparer set none", () => {
		const palette = deriveGlossyPalette({
			brandColorName: null,
			accentColors: [],
			recipientColors: [RECIPIENT_FIRST],
		});
		expect(palette.primary).toBe(RECIPIENT_FIRST);
		expect(palette.series[0]).toBe(RECIPIENT_FIRST);
		// Used once, as primary, not again as an accent.
		expect(palette.accents).toEqual([]);
		expectReadable(palette);
	});

	it("keeps a chosen theme color primary and adds the recipient's colors as accents", () => {
		const palette = deriveGlossyPalette({
			brandColorName: "blue",
			recipientColors: [RECIPIENT],
		});
		expect(palette.primary).toBe(BLUE);
		expect(palette.accents).toEqual([RECIPIENT]);
		expect(palette.series.slice(0, 2)).toEqual([BLUE, RECIPIENT]);
		expectReadable(palette);
	});

	it("honors a crimson the organization chose", () => {
		const palette = deriveGlossyPalette({
			brandColorName: "red",
			recipientColors: [RECIPIENT],
		});
		expect(palette.primary).toBe(CRIMSON);
		expect(palette.accents).toEqual([RECIPIENT]);
	});

	it("leads with the first Brand kit accent without a theme color, then the recipient's colors", () => {
		const palette = deriveGlossyPalette({
			brandColorName: null,
			accentColors: [KIT_ACCENT],
			recipientColors: [RECIPIENT],
		});
		expect(palette.primary).toBe(KIT_ACCENT);
		expect(palette.accents).toEqual([RECIPIENT]);
		expectReadable(palette);
	});

	it("lets an override primary win over both brands", () => {
		for (const brandColorName of ["blue", null]) {
			const palette = deriveGlossyPalette({
				brandColorName,
				accentColors: [KIT_ACCENT],
				recipientColors: [RECIPIENT],
				overrides: { primary: OVERRIDE_PRIMARY },
			});
			expect(palette.primary).toBe(OVERRIDE_PRIMARY);
			expect(palette.accents).toEqual([KIT_ACCENT, RECIPIENT]);
		}
	});

	it("takes override accents as the preparer's, with the recipient's colors after them", () => {
		const palette = deriveGlossyPalette({
			brandColorName: null,
			accentColors: [KIT_ACCENT],
			recipientColors: [RECIPIENT],
			overrides: { primary: null, accents: [OVERRIDE_ACCENT] },
		});
		expect(palette.primary).toBe(OVERRIDE_ACCENT);
		expect(palette.accents).toEqual([RECIPIENT]);
	});

	it("deduplicates accents across both brands and never repeats the primary", () => {
		const palette = deriveGlossyPalette({
			brandColorName: "blue",
			accentColors: [KIT_ACCENT, BLUE, KIT_ACCENT.toUpperCase()],
			recipientColors: [KIT_ACCENT, RECIPIENT, BLUE, RECIPIENT],
		});
		expect(palette.primary).toBe(BLUE);
		expect(palette.accents).toEqual([KIT_ACCENT, RECIPIENT]);
	});

	it("validates recipient colors like the preparer's: a hostile or short value is dropped", () => {
		const palette = deriveGlossyPalette({
			brandColorName: null,
			recipientColors: [
				"red;background:url(x)",
				"#abc",
				"#0055aa0",
				` ${RECIPIENT.toUpperCase()} `,
				"#000000;} body{display:none",
			],
		});
		expect(palette.primary).toBe(RECIPIENT);
		expect(palette.accents).toEqual([]);
		expectReadable(palette);
	});

	it("keeps a low-contrast recipient primary as the fill, with neutral headings and borders and no new threshold", () => {
		const recipientLed = deriveGlossyPalette({
			brandColorName: null,
			recipientColors: [PALE_RECIPIENT, RECIPIENT],
		});
		expect(contrastRatio(PALE_RECIPIENT, "#ffffff")).toBeLessThan(3);
		expect(recipientLed.primary).toBe(PALE_RECIPIENT);
		expect(recipientLed.onPrimary).toBe(DARK_INK);
		expect(recipientLed.heading).toBe(NEUTRAL_GLOSSY_COLORS.heading);
		expect(recipientLed.border).toBe(NEUTRAL_GLOSSY_COLORS.border);
		expect(recipientLed.ink).toBe(NEUTRAL_GLOSSY_COLORS.ink);
		expect(recipientLed.accents).toEqual([RECIPIENT]);
		expectReadable(recipientLed);

		// The same color from the preparer gets exactly the same roles.
		const preparerLed = deriveGlossyPalette({
			overrides: { primary: PALE_RECIPIENT, accents: [RECIPIENT] },
		});
		expect(recipientLed).toEqual(preparerLed);
	});

	it("treats an unknown brand color name as not chosen", () => {
		for (const brandColorName of [
			"magenta",
			"Teal",
			"constructor",
			"__proto__",
			"toString",
		]) {
			expect(chosenBrandColor(brandColorName)).toBeNull();
			expect(deriveGlossyPalette({ brandColorName }).primary).toBe(
				NEUTRAL_GLOSSY_COLORS.primary,
			);
			expect(
				deriveGlossyPalette({
					brandColorName,
					recipientColors: [RECIPIENT_FIRST],
				}).primary,
			).toBe(RECIPIENT_FIRST);
		}
	});

	it("resolves a chosen name to its hex and nothing else to a color", () => {
		expect(chosenBrandColor("teal")).toBe(brandColorValues.teal?.hex);
		expect(chosenBrandColor("red")).toBe(CRIMSON);
		for (const name of [null, undefined, ""]) {
			expect(chosenBrandColor(name)).toBeNull();
		}
	});
});

describe("glossyMermaidThemeVariables", () => {
	it("maps the series onto cScale0..11 with a readable label for each", () => {
		const palette = deriveGlossyPalette({
			brandColorName: "indigo",
			accentColors: ["#16a34a", "#f59e0b"],
		});
		const variables = glossyMermaidThemeVariables(palette);
		expect(variables.cScale0).toBe(palette.primary);
		expect(variables.cScale1).toBe("#16a34a");
		expect(variables.cScale2).toBe("#f59e0b");
		expect(variables.cScale11).toBeDefined();
		for (let i = 0; i < 12; i++) {
			expect(
				contrastRatio(
					variables[`cScaleLabel${i}`],
					variables[`cScale${i}`],
				),
			).toBeGreaterThanOrEqual(4.5);
		}
		expect(variables.primaryColor).toBe(palette.surface);
		expect(variables.lineColor).toBe(palette.border);
	});
});
