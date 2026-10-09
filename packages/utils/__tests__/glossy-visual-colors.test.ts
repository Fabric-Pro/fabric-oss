import { describe, expect, it } from "vitest";
import {
	deriveGlossyPalette,
	fillVisualColors,
	type GlossyPalette,
	type GlossyPaletteInput,
	glossyMermaidThemeVariables,
	NEUTRAL_GLOSSY_COLORS,
	strictHexColor,
} from "../lib/glossy/visual-colors";
import type { VisualSpec } from "../lib/glossy/visual-spec";
import {
	VISUAL_COLOR_PLACEHOLDERS,
	visualSpecToMermaid,
	visualSpecToSvgCard,
} from "../lib/glossy/visual-templates";

const HEX = /^#[0-9a-f]{6}$/;

const SPECS: VisualSpec[] = [
	{
		kind: "timeline",
		items: [
			{ date: "Q1", label: "Discovery" },
			{ date: "Q2", label: "Delivery" },
		],
	},
	{
		kind: "flow",
		steps: [
			{ label: "Brief", lane: "Example Org" },
			{ label: "Design", lane: "Agency" },
		],
	},
	{
		kind: "org_chart",
		nodes: [
			{ id: "lead", label: "Engagement lead", parentId: null },
			{ id: "design", label: "Design", parentId: "lead" },
		],
	},
	{
		kind: "stat",
		items: [{ value: "40%", label: "Faster pages" }],
	},
	{
		kind: "comparison",
		items: [
			{ title: "Option A", points: ["Faster launch"] },
			{ title: "Option B", points: ["Full redesign"] },
		],
	},
];

const TEMPLATES = SPECS.map((spec) =>
	spec.kind === "stat" || spec.kind === "comparison"
		? visualSpecToSvgCard(spec)
		: visualSpecToMermaid(spec),
);

const PALETTE_INPUTS: Array<[string, GlossyPaletteInput]> = [
	["no brand", {}],
	["a chosen theme color", { brandColorName: "blue" }],
	[
		"recipient colors",
		{ recipientColors: ["#0055aa", "#AA5500", "not-a-color"] },
	],
	["overrides", { overrides: { primary: "#5b2a86", accents: ["#7a1f5c"] } }],
	[
		"hostile values",
		{
			accentColors: ["red;}</style><script>", "#abc", "url(x)"],
			recipientColors: ["#zzzzzz"],
			overrides: { primary: "#fff;background:url(x)" },
		},
	],
	["a very dark brand", { overrides: { primary: "#000000" } }],
	["a pale brand", { overrides: { primary: "#ffe14d" } }],
];

/** Every color a filled template now carries, in `fill:`/`stroke:` lists or attributes. */
function colorsIn(filled: string): string[] {
	return [...filled.matchAll(/(?:fill|stroke)(?::|=")([^,"\s;]+)/g)].map(
		(match) => match[1],
	);
}

describe("fillVisualColors", () => {
	for (const [name, input] of PALETTE_INPUTS) {
		it(`leaves only #rrggbb values for every placeholder with ${name}`, () => {
			const palette = deriveGlossyPalette(input);
			for (const template of TEMPLATES) {
				const filled = fillVisualColors(template, palette);
				for (const placeholder of Object.values(
					VISUAL_COLOR_PLACEHOLDERS,
				)) {
					expect(filled).not.toContain(placeholder);
				}
				const colors = colorsIn(filled);
				expect(colors.length).toBeGreaterThan(0);
				for (const color of colors) {
					expect(color).toMatch(HEX);
				}
			}
		});
	}

	it("fills each placeholder with its palette role", () => {
		const palette = deriveGlossyPalette({
			overrides: { primary: "#1d4ed8" },
		});
		const source = Object.values(VISUAL_COLOR_PLACEHOLDERS).join(" ");

		expect(fillVisualColors(source, palette)).toBe(
			[
				palette.surface,
				palette.border,
				palette.heading,
				palette.ink,
				palette.muted,
			].join(" "),
		);
	});

	it("refuses a palette color that is not #rrggbb rather than interpolating it", () => {
		const hostile: GlossyPalette = {
			...deriveGlossyPalette(),
			surface: "red;stroke-width:40",
		};

		expect(() =>
			fillVisualColors(
				`fill:${VISUAL_COLOR_PLACEHOLDERS.surface}`,
				hostile,
			),
		).toThrow(/not #rrggbb/);
	});

	it("leaves a source without placeholders unchanged", () => {
		const source = "flowchart LR\nA --> B";

		expect(fillVisualColors(source, deriveGlossyPalette())).toBe(source);
	});
});

describe("deriveGlossyPalette", () => {
	it("is neutral when no brand color is set", () => {
		const palette = deriveGlossyPalette();

		expect(palette.primary).toBe(NEUTRAL_GLOSSY_COLORS.primary);
		expect(palette.ink).toBe(NEUTRAL_GLOSSY_COLORS.ink);
		expect(palette.accents).toEqual([]);
	});

	it("gives every role, accent, series and theme variable as lowercase #rrggbb", () => {
		for (const [, input] of PALETTE_INPUTS) {
			const palette = deriveGlossyPalette(input);
			const { accents, series, ...roles } = palette;
			for (const color of [
				...Object.values(roles),
				...accents,
				...series,
			]) {
				expect(color).toMatch(HEX);
			}
			expect(series).toHaveLength(12);
			for (const value of Object.values(
				glossyMermaidThemeVariables(palette),
			)) {
				expect(value).toMatch(HEX);
			}
		}
	});

	it("derives the same palette from the same input", () => {
		const input = PALETTE_INPUTS[2][1];

		expect(deriveGlossyPalette(input)).toEqual(deriveGlossyPalette(input));
	});
});

describe("strictHexColor", () => {
	it("passes #rrggbb in either case, lowercased", () => {
		expect(strictHexColor(" #AbCdEf ")).toBe("#abcdef");
	});

	it("refuses short hex, CSS and non-strings", () => {
		expect(strictHexColor("#abc")).toBeNull();
		expect(strictHexColor("#abcdef;fill:red")).toBeNull();
		expect(strictHexColor("blue")).toBeNull();
		expect(strictHexColor(0xabcdef)).toBeNull();
		expect(strictHexColor(null)).toBeNull();
	});
});
