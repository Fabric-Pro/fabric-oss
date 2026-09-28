import {
	contrastRatio,
	DARK_INK,
	resolveBrandColor,
} from "@repo/utils/brand-colors";
import { describe, expect, it } from "vitest";
import {
	deriveGlossyPalette,
	glossyMermaidThemeVariables,
	NEUTRAL_GLOSSY_COLORS,
	strictHexColor,
} from "../palette";

const HEX = /^#[0-9a-f]{6}$/;

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
