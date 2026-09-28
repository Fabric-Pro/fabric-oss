import { describe, expect, it } from "vitest";
import {
	brandColorValues,
	contrastRatio,
	DARK_INK,
	findBrandColor,
	LIGHT_INK,
	normalizeHexColor,
	readableForegroundFor,
	relativeLuminance,
	resolveBrandColor,
	rgbToHex,
} from "../lib/brand-colors";

describe("brand color map", () => {
	it("keeps the values it had in OrganizationThemeProvider before the move", () => {
		// Pinned literally: the move to a shared module must change no value the
		// organization theme sets.
		expect(brandColorValues).toEqual({
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
		});
	});

	it("resolves a missing or unknown name to the crimson default, as the provider did", () => {
		const red = brandColorValues.red;
		expect(resolveBrandColor(null)).toBe(red);
		expect(resolveBrandColor(undefined)).toBe(red);
		expect(resolveBrandColor("")).toBe(red);
		expect(resolveBrandColor("chartreuse")).toBe(red);
		expect(resolveBrandColor("teal")).toBe(brandColorValues.teal);
	});

	it("never resolves a name to an Object.prototype member", () => {
		expect(resolveBrandColor("constructor")).toBe(brandColorValues.red);
		expect(resolveBrandColor("toString")).toBe(brandColorValues.red);
		expect(resolveBrandColor("__proto__")).toBe(brandColorValues.red);
	});
});

describe("findBrandColor", () => {
	it("finds every stored brand by its name", () => {
		for (const [name, value] of Object.entries(brandColorValues)) {
			expect(findBrandColor(name)).toBe(value);
		}
	});

	it.each([[null], [undefined], [""], ["chartreuse"], ["Teal"]])(
		"finds nothing for %j, with no crimson fallback",
		(name) => {
			expect(findBrandColor(name)).toBeNull();
		},
	);

	it.each([["constructor"], ["toString"], ["hasOwnProperty"], ["__proto__"]])(
		"never finds the Object.prototype member %j",
		(name) => {
			expect(findBrandColor(name)).toBeNull();
		},
	);
});

describe("contrast helpers", () => {
	it("picks the dark ink for every brand fill, as before the move", () => {
		for (const value of Object.values(brandColorValues)) {
			expect(readableForegroundFor(value.hex)).toBe(DARK_INK);
		}
	});

	it("picks the light ink on a dark fill", () => {
		expect(readableForegroundFor("#111110")).toBe(LIGHT_INK);
	});

	it("measures the WCAG extremes", () => {
		expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
		expect(relativeLuminance("#000000")).toBe(0);
		expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
		expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 10);
		expect(contrastRatio("#3b82f6", "#3b82f6")).toBe(1);
	});
});

describe("normalizeHexColor", () => {
	it.each([
		["#AbCdEf", "#abcdef"],
		["  #0d9488 ", "#0d9488"],
		["#F0a", "#ff00aa"],
	])("normalizes %j to %j", (input, expected) => {
		expect(normalizeHexColor(input)).toBe(expected);
	});

	it.each([
		["red"],
		["red;background:url(x)"],
		["#0d9488;background:url(x)"],
		["rgb(1, 2, 3)"],
		["#12345"],
		["#1234567"],
		["#ggg"],
		["0d9488"],
		[""],
	])("drops %j", (input) => {
		expect(normalizeHexColor(input)).toBeNull();
	});

	it("drops non-strings", () => {
		expect(normalizeHexColor(undefined)).toBeNull();
		expect(normalizeHexColor(0x0d9488)).toBeNull();
		expect(normalizeHexColor({ toString: () => "#0d9488" })).toBeNull();
	});
});

describe("rgbToHex", () => {
	it("formats, rounds and clamps channels", () => {
		expect(rgbToHex(13, 148, 136)).toBe("#0d9488");
		expect(rgbToHex(0.4, 254.6, -3)).toBe("#00ff00");
		expect(rgbToHex(300, 0, 0)).toBe("#ff0000");
	});
});
