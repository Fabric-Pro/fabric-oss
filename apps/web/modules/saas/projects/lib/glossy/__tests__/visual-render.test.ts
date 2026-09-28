/**
 * Glossy visuals render through the real mermaid.js in jsdom; only the
 * canvas step (`svgToPng`) is stubbed, since jsdom has no canvas. jsdom has
 * no text layout either, so `getBBox` is approximated from text length.
 */
import type { EditionVisual } from "@repo/utils/glossy/edition-content";
import type { VisualSpec } from "@repo/utils/glossy/visual-spec";
import mermaid from "mermaid";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MermaidExportTheme } from "../../markdown-to-document";
import { deriveGlossyPalette } from "../palette";
import {
	fillVisualColors,
	glossyMermaidTheme,
	renderGlossyVisual,
	renderGlossyVisuals,
} from "../visual-render";

const captured = vi.hoisted(() => {
	const svgs: string[] = [];
	const rasterize = (svg: string) => {
		svgs.push(svg);
		return {
			dataUrl: "data:image/png;base64,AAAA",
			width: 320,
			height: 120,
		};
	};
	return { svgs, rasterize };
});

vi.mock("../../document-export-helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../document-export-helpers")>()),
	svgToPng: vi.fn(async (svg: string) => captured.rasterize(svg)),
}));

vi.mock("../../markdown-to-document", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../markdown-to-document")>();
	return {
		...actual,
		// The real themed path with the canvas step stubbed out.
		renderMermaidToPng: vi.fn(
			async (code: string, theme?: MermaidExportTheme) => {
				if (!theme) {
					throw new Error("Glossy renders must pass a theme.");
				}
				try {
					return captured.rasterize(
						await actual.renderThemedMermaidSvg(code, theme),
					);
				} catch {
					return null;
				}
			},
		),
	};
});

beforeAll(() => {
	const proto = window.SVGElement.prototype as unknown as Record<
		string,
		unknown
	>;
	proto.getBBox = function getBBox(this: SVGElement) {
		const length = Math.min((this.textContent ?? "").length, 40);
		return { x: 0, y: 0, width: length * 7, height: 16 };
	};
	proto.getComputedTextLength = function getComputedTextLength(
		this: SVGElement,
	) {
		return (this.textContent ?? "").length * 7;
	};
});

afterEach(() => {
	captured.svgs.length = 0;
	vi.restoreAllMocks();
});

const palette = deriveGlossyPalette({
	overrides: { primary: "#1e3a8a", accents: ["#16a34a"] },
});

function parseSvg(svg: string): Document {
	return new DOMParser().parseFromString(svg, "image/svg+xml");
}

/** Mermaid wraps words into separate `<tspan>`s; compare without whitespace. */
function squash(text: string | null | undefined): string {
	return (text ?? "").replace(/\s+/g, "");
}

describe("renderGlossyVisual", () => {
	it("renders a timeline through Mermaid with the brand cScale0 and every label", async () => {
		const render = vi.spyOn(mermaid, "render");
		const spec: VisualSpec = {
			kind: "timeline",
			items: [
				{ date: "Q1 2026", label: "Pilot launch" },
				{ date: "Q2 2026", label: "Regional rollout" },
				{ date: "Q3 2026", label: "General availability" },
			],
		};

		const image = await renderGlossyVisual(spec, palette);

		expect(image).not.toBeNull();
		const source = String(render.mock.calls[0]?.[1]);
		expect(source).toContain('"theme":"base"');
		expect(source).toContain(`"cScale0":"${palette.primary}"`);
		expect(source).toContain('"htmlLabels":false');
		expect(source).not.toContain("GLOSSY_COLOR_");

		const svg = captured.svgs.at(-1) ?? "";
		const text = squash(parseSvg(svg).documentElement.textContent);
		for (const item of spec.items) {
			expect(text).toContain(squash(item.date));
			expect(text).toContain(squash(item.label));
		}
		// Placeholders were filled with the brand, and labels stayed SVG text.
		expect(svg).toContain(palette.surface);
		expect(svg).toContain(palette.border);
		expect(svg).not.toContain("<foreignObject");
	});

	it("renders a hostile label from U5's templates as literal text through mermaid", async () => {
		const spec: VisualSpec = {
			kind: "flow",
			steps: [
				{ label: '"]\nclick A href "javascript:alert(1)"' },
				{ label: "Review" },
			],
		};

		const image = await renderGlossyVisual(spec, palette);

		expect(image).not.toBeNull();
		const doc = parseSvg(captured.svgs.at(-1) ?? "");
		expect(doc.querySelector("parsererror")).toBeNull();
		// No link, handler, or clickable node was created from the label...
		expect(doc.querySelectorAll("a")).toHaveLength(0);
		expect(doc.querySelectorAll(".clickable")).toHaveLength(0);
		for (const element of Array.from(doc.querySelectorAll("*"))) {
			for (const attribute of Array.from(element.attributes)) {
				expect(attribute.name.startsWith("on")).toBe(false);
				expect(attribute.value).not.toMatch(/javascript:/i);
			}
		}
		// ...and its words are drawn as plain text instead.
		const text = squash(doc.documentElement.textContent);
		expect(text).toContain("clickAhref");
		expect(text).toContain("javascript:alert（1）");
		expect(text).toContain("Review");
	});

	it("restyles existing Mermaid over the diagram's own theme directive", async () => {
		const render = vi.spyOn(mermaid, "render");
		const spec: VisualSpec = {
			kind: "existing_mermaid",
			source: '%%{init: {"theme": "dark"}}%%\nflowchart TD\nA[Intake] --> B[Triage]',
		};

		const image = await renderGlossyVisual(spec, palette);

		expect(image).not.toBeNull();
		const source = String(render.mock.calls[0]?.[1]);
		// The brand directive comes last, so it wins over the diagram's own.
		expect(source.lastIndexOf('"theme":"base"')).toBeGreaterThan(
			source.indexOf('"theme": "dark"'),
		);
		expect(captured.svgs.at(-1)).toContain(`fill:${palette.surface}`);
	});

	it("fills an SVG card with palette colors and rasterizes it without Mermaid", async () => {
		const render = vi.spyOn(mermaid, "render");
		const spec: VisualSpec = {
			kind: "stat",
			items: [{ value: "42%", label: "Fewer support tickets" }],
		};

		const image = await renderGlossyVisual(spec, palette);

		expect(image).not.toBeNull();
		expect(render).not.toHaveBeenCalled();
		const svg = captured.svgs.at(-1) ?? "";
		expect(svg).toContain(`fill="${palette.heading}"`);
		expect(svg).toContain(`fill="${palette.surface}"`);
		expect(svg).not.toContain("GLOSSY_COLOR_");
	});

	it("refuses a palette color that is not #rrggbb", async () => {
		const hostile = { ...palette, surface: "red;background:url(x)" };
		expect(() =>
			fillVisualColors("fill:GLOSSY_COLOR_SURFACE", hostile),
		).toThrow();
		expect(
			await renderGlossyVisual(
				{ kind: "stat", items: [{ value: "1", label: "One" }] },
				hostile,
			),
		).toBeNull();
	});
});

describe("renderThemedMermaidSvg", () => {
	it("renders strict and restores the shared configuration afterwards", async () => {
		const { renderThemedMermaidSvg } = await vi.importActual<
			typeof import("../../markdown-to-document")
		>("../../markdown-to-document");
		mermaid.initialize({
			startOnLoad: false,
			theme: "default",
			securityLevel: "loose",
		});
		let during: ReturnType<typeof mermaid.mermaidAPI.getSiteConfig> | null =
			null;
		const original = mermaid.render.bind(mermaid);
		vi.spyOn(mermaid, "render").mockImplementation(
			(id, text, container) => {
				during = mermaid.mermaidAPI.getSiteConfig();
				return original(id, text, container);
			},
		);

		await renderThemedMermaidSvg(
			"flowchart LR\nA --> B",
			glossyMermaidTheme(palette),
		);

		expect(during).toMatchObject({
			securityLevel: "strict",
			theme: "base",
			htmlLabels: false,
		});
		const after = mermaid.mermaidAPI.getSiteConfig();
		expect(after.securityLevel).toBe("loose");
		expect(after.theme).toBe("default");
	});

	it("restores the shared configuration when a render fails", async () => {
		const { renderThemedMermaidSvg } = await vi.importActual<
			typeof import("../../markdown-to-document")
		>("../../markdown-to-document");
		mermaid.initialize({
			startOnLoad: false,
			theme: "default",
			securityLevel: "loose",
		});

		await expect(
			renderThemedMermaidSvg(
				"not a diagram at all",
				glossyMermaidTheme(palette),
			),
		).rejects.toThrow();

		expect(mermaid.mermaidAPI.getSiteConfig().securityLevel).toBe("loose");
	});
});

describe("renderGlossyVisuals", () => {
	it("reports failures per visual key and skips excluded keys", async () => {
		const timeline: VisualSpec = {
			kind: "timeline",
			items: [
				{ date: "Q1", label: "Start" },
				{ date: "Q2", label: "Finish" },
			],
		};
		const visuals: Record<string, EditionVisual> = {
			good: {
				kind: "timeline",
				spec: timeline,
				specHash: "a",
				source: "detected",
			},
			broken: {
				kind: "existing_mermaid",
				spec: {
					kind: "existing_mermaid",
					source: "not a diagram at all",
				},
				specHash: "b",
				source: "existing_mermaid",
			},
			unresolved: {
				kind: "auto",
				spec: { kind: "auto" },
				specHash: "c",
				source: "slot",
			},
			discarded: {
				kind: "timeline",
				spec: timeline,
				specHash: "d",
				source: "detected",
			},
		};

		const result = await renderGlossyVisuals(
			visuals,
			palette,
			(key) => key !== "discarded",
		);

		expect([...result.images.keys()]).toEqual(["good"]);
		expect(result.failures).toEqual([
			{
				visualKey: "broken",
				kind: "existing_mermaid",
				reason: "render_failed",
			},
			{
				visualKey: "unresolved",
				kind: "auto",
				reason: "unsupported_kind",
			},
		]);
	});
});
