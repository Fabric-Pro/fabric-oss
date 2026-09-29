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

/** The zero-width space labels use to break Mermaid syntax invisibly. */
const ZWSP = "\u200B";

/** Full-width forms, which labels no longer use as look-alikes. */
const FULL_WIDTH = /[\uFF00-\uFFEF]/;

/** What a reader sees: `squash`, minus the invisible zero-width spaces. */
function visibleText(text: string | null | undefined): string {
	return squash(text).split(ZWSP).join("");
}

/**
 * Render a templated Mermaid visual (timeline, flow, org chart) and read back
 * its SVG, text, shape counts, and theme CSS.
 */
async function renderDiagram(spec: VisualSpec) {
	captured.svgs.length = 0;
	const image = await renderGlossyVisual(spec, palette);
	expect(image).not.toBeNull();
	const svg = captured.svgs.at(-1) ?? "";
	const doc = parseSvg(svg);
	const id = doc.documentElement.getAttribute("id") ?? "";
	const texts = (selector: string) =>
		Array.from(doc.querySelectorAll(selector)).map(
			(element) => element.textContent ?? "",
		);
	return {
		svg,
		doc,
		nodeTexts: texts("g.node"),
		laneTexts: texts("g.cluster"),
		counts: {
			nodes: doc.querySelectorAll("g.node").length,
			lanes: doc.querySelectorAll("g.cluster").length,
			edges: doc.querySelectorAll("path.flowchart-link").length,
		},
		// The theme CSS, scoped by the render's own id.
		style: (doc.querySelector("style")?.textContent ?? "")
			.split(id)
			.join(""),
	};
}

type RenderedDiagram = Awaited<ReturnType<typeof renderDiagram>>;

/**
 * The hostile render drew the same diagram as the benign reference: no node,
 * lane, or edge was added, removed, or merged; no link, handler, clickable
 * node, or HTML island was created; and no directive in the text changed the
 * brand theme.
 */
function expectSameInertDiagram(
	render: RenderedDiagram,
	reference: RenderedDiagram,
) {
	expect(render.doc.querySelector("parsererror")).toBeNull();
	expect(render.counts).toEqual(reference.counts);
	expect(render.doc.querySelectorAll("a")).toHaveLength(0);
	expect(render.doc.querySelectorAll(".clickable")).toHaveLength(0);
	expect(render.doc.querySelectorAll("foreignObject")).toHaveLength(0);
	for (const element of Array.from(render.doc.querySelectorAll("*"))) {
		for (const attribute of Array.from(element.attributes)) {
			expect(attribute.name.startsWith("on")).toBe(false);
			expect(attribute.value).not.toMatch(/javascript:/i);
		}
	}
	expect(render.style).toBe(reference.style);
	expect(render.svg).not.toMatch(FULL_WIDTH);
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
		expect(text).toContain("javascript:alert(1)");
		expect(text).toContain("Review");
	});

	it("renders a flow whose steps name their performers as one titled lane each", async () => {
		const spec: VisualSpec = {
			kind: "flow",
			steps: [
				{ label: "Qualify lead", lane: "Sales" },
				{ label: "Review contract", lane: "Legal" },
				{ label: "Sign order", lane: "Sales" },
			],
		};

		const image = await renderGlossyVisual(spec, palette);

		expect(image).not.toBeNull();
		const doc = parseSvg(captured.svgs.at(-1) ?? "");
		expect(doc.querySelector("parsererror")).toBeNull();
		const lanes = Array.from(doc.querySelectorAll("g.cluster"));
		expect(lanes.map((lane) => squash(lane.textContent)).sort()).toEqual([
			"Legal",
			"Sales",
		]);
		expect(doc.querySelectorAll("g.node")).toHaveLength(3);
		expect(doc.querySelectorAll("path.flowchart-link")).toHaveLength(2);
		const text = squash(doc.documentElement.textContent);
		for (const step of spec.steps) {
			expect(text).toContain(squash(step.label));
		}
	});

	it("renders hostile lane titles as literal text through mermaid", async () => {
		const spec: VisualSpec = {
			kind: "flow",
			steps: [
				{ label: "Qualify lead", lane: 'Sales"] end' },
				{ label: "Review contract", lane: "Legal %% --> click A" },
			],
		};

		const image = await renderGlossyVisual(spec, palette);

		expect(image).not.toBeNull();
		const doc = parseSvg(captured.svgs.at(-1) ?? "");
		expect(doc.querySelector("parsererror")).toBeNull();
		// No title closed its lane early, commented out a line, or added an
		// edge, a node, or a link...
		const lanes = Array.from(doc.querySelectorAll("g.cluster"));
		expect(lanes).toHaveLength(2);
		expect(doc.querySelectorAll("g.node")).toHaveLength(2);
		expect(doc.querySelectorAll("path.flowchart-link")).toHaveLength(1);
		expect(doc.querySelectorAll("a")).toHaveLength(0);
		expect(doc.querySelectorAll(".clickable")).toHaveLength(0);
		// ...and each title's words are drawn as its lane's text.
		const titles = lanes.map((lane) => squash(lane.textContent)).join("|");
		expect(titles).toContain("Sales”]end");
		expect(titles).toContain(`Legal%${ZWSP}%-->`);
		expect(titles).toContain("clickA");
	});

	it("renders plain punctuation in labels and lane titles as typed", async () => {
		const spec: VisualSpec = {
			kind: "flow",
			steps: [
				{ label: "Phase 1 (Q1)", lane: "Sales (EMEA)" },
				{ label: "C#", lane: "85–90%" },
			],
		};

		const flow = await renderDiagram(spec);

		expect(flow.nodeTexts.sort()).toEqual(["C#", "Phase 1 (Q1)"]);
		expect(flow.laneTexts.sort()).toEqual(["85–90%", "Sales (EMEA)"]);
		expect(flow.svg).not.toMatch(FULL_WIDTH);
		// No entity code was drawn in place of a character.
		expect(flow.svg).not.toContain("&amp;#");
	});

	describe("hostile text in both a step label and its lane title", () => {
		const benign: VisualSpec = {
			kind: "flow",
			steps: [
				{ label: "Qualify lead", lane: "Sales" },
				{ label: "Review contract", lane: "Legal" },
			],
		};

		/** Each input, and the text a reader sees once it is drawn. */
		const cases: ReadonlyArray<readonly [string, string]> = [
			['"]', "”]"],
			[
				']\nclick A href "javascript:alert(1)"',
				"] click A href “javascript:alert(1)”",
			],
			[
				'%%{init: {"securityLevel":"loose"}}%%',
				"%%{init: {“securityLevel”:“loose”}}%%",
			],
			[
				"%%{init: {'flowchart': {'htmlLabels': true}}}%%",
				"%%{init: {'flowchart': {'htmlLabels': true}}}%%",
			],
			["%% comment", "%% comment"],
			["end", "end"],
			["-->", "-->"],
			["subgraph x", "subgraph x"],
			["click f0 call alert()", "click f0 call alert()"],
			["style f0 fill:#f00", "style f0 fill:#f00"],
			["<img src=x onerror=alert(1)>", "<img src=x onerror=alert(1)>"],
			// Mermaid rewrites `="..."` after a `<tag` across lines.
			["<b q=", "<b q="],
			["#lt;script#gt;", "#lt;script#gt;"],
			["`**x**`", "`**x**`"],
			["`[link](javascript:alert(1))`", "`[link](javascript:alert(1))`"],
			["`unterminated", "`unterminated"],
			// Mermaid's flowchart lexer turns a whole line containing
			// `direction` + whitespace + TB/BT/RL/LR/TD into a direction
			// statement before it reaches the quoted label.
			["Strategic direction TBD", "Strategic direction TBD"],
			["x direction LR", "x direction LR"],
			// Mermaid picks the diagram type from `C4Container`, `C4Component`,
			// `C4Dynamic`, or `C4Deployment` anywhere in the source.
			["Our C4Container rollout", "Our C4Container rollout"],
			// Mermaid's internal entity form, decoded over the finished SVG.
			["a\uFB02\u00B0b", "a\uFB02\u00B0b"],
			["\uFB02\u00B0lt\u00B6\u00DF", "\uFB02\u00B0lt\u00B6\u00DF"],
		];

		it.each(cases)(
			"%j draws as literal text without changing the diagram",
			async (hostile, visible) => {
				const reference = await renderDiagram(benign);
				const flow = await renderDiagram({
					kind: "flow",
					steps: [
						{ label: hostile, lane: hostile },
						{ label: "Review contract", lane: "Legal" },
					],
				});

				expectSameInertDiagram(flow, reference);
				expect(flow.counts).toEqual({ nodes: 2, lanes: 2, edges: 1 });
				// The text is drawn as typed, in the node and in the lane.
				expect(visibleText(flow.nodeTexts.join("|"))).toContain(
					visibleText(visible),
				);
				expect(visibleText(flow.laneTexts.join("|"))).toContain(
					visibleText(visible),
				);
			},
		);
	});

	describe("a Mermaid direction statement inside a step label or a lane title", () => {
		const benign: VisualSpec = {
			kind: "flow",
			steps: [
				{ label: "Qualify lead", lane: "Sales" },
				{ label: "Review contract", lane: "Legal" },
			],
		};

		/**
		 * A case name, and the text. `\s` in the lexer's rule also matches a
		 * non-breaking space and a tab.
		 */
		const texts: ReadonlyArray<readonly [string, string]> = [
			["Strategic direction TBD", "Strategic direction TBD"],
			["x direction LR", "x direction LR"],
			["Strategic direction<NBSP>TBD", "Strategic direction\u00A0TBD"],
			["x direction<NBSP>LR", "x direction\u00A0LR"],
			["Strategic direction<TAB>TBD", "Strategic direction\tTBD"],
			["x direction<TAB>LR", "x direction\tLR"],
			["direction BT", "direction BT"],
			["direction RL", "direction RL"],
			["set direction TD later", "set direction TD later"],
			["redirection TB", "redirection TB"],
			[
				"direction   TB twice direction LR",
				"direction   TB twice direction LR",
			],
		];

		it.each(texts)(
			"%s as a step label keeps the flow and draws as typed",
			async (_name, text) => {
				const reference = await renderDiagram(benign);
				const flow = await renderDiagram({
					kind: "flow",
					steps: [
						{ label: text, lane: "Sales" },
						{ label: "Review contract", lane: "Legal" },
					],
				});

				expectSameInertDiagram(flow, reference);
				expect(visibleText(flow.nodeTexts.join("|"))).toContain(
					visibleText(text),
				);
				expect(flow.laneTexts.map(squash).sort()).toEqual([
					"Legal",
					"Sales",
				]);
			},
		);

		it.each(texts)(
			"%s as a lane title keeps the flow and draws as typed",
			async (_name, text) => {
				const reference = await renderDiagram(benign);
				const flow = await renderDiagram({
					kind: "flow",
					steps: [
						{ label: "Qualify lead", lane: text },
						{ label: "Review contract", lane: "Legal" },
					],
				});

				expectSameInertDiagram(flow, reference);
				expect(visibleText(flow.laneTexts.join("|"))).toContain(
					visibleText(text),
				);
				expect(flow.nodeTexts.map(squash).sort()).toEqual([
					"Qualifylead",
					"Reviewcontract",
				]);
			},
		);

		it("draws a plain chain step with a direction statement as typed", async () => {
			const chain = (label: string): VisualSpec => ({
				kind: "flow",
				steps: [{ label }, { label: "Review contract" }],
			});
			const reference = await renderDiagram(chain("Qualify lead"));

			const flow = await renderDiagram(chain("Strategic direction TBD"));

			expectSameInertDiagram(flow, reference);
			expect(flow.counts).toEqual({ nodes: 2, lanes: 0, edges: 1 });
			expect(visibleText(flow.nodeTexts.join("|"))).toContain(
				"StrategicdirectionTBD",
			);
		});
	});

	describe("hostile text in timeline and org chart labels", () => {
		/** Each input, and the text a reader sees once it is drawn. */
		const cases: ReadonlyArray<readonly [string, string]> = [
			['"]', "”]"],
			[
				'%%{init: {"securityLevel":"loose"}}%%',
				"%%{init: {“securityLevel”:“loose”}}%%",
			],
			["click x call alert()", "click x call alert()"],
			["<img src=x onerror=alert(1)>", "<img src=x onerror=alert(1)>"],
			["direction TB", "direction TB"],
			["Strategic direction TBD", "Strategic direction TBD"],
			["Our C4Component map", "Our C4Component map"],
		];

		const timeline = (label: string): VisualSpec => ({
			kind: "timeline",
			items: [
				{ date: "Q1 2026", label },
				{ date: "Q2 2026", label: "Regional rollout" },
			],
		});

		const orgChart = (label: string): VisualSpec => ({
			kind: "org_chart",
			nodes: [
				{ id: "lead", label, parentId: null },
				{ id: "finance", label: "Finance", parentId: "lead" },
				{ id: "delivery", label, parentId: "lead" },
			],
		});

		it.each(cases)(
			"%j in a timeline label draws as literal text without changing the diagram",
			async (hostile, visible) => {
				const reference = await renderDiagram(timeline("Pilot launch"));
				const render = await renderDiagram(timeline(hostile));

				expectSameInertDiagram(render, reference);
				expect(render.counts).toEqual({ nodes: 2, lanes: 0, edges: 1 });
				expect(visibleText(render.nodeTexts.join("|"))).toContain(
					visibleText(`Q1 2026 — ${visible}`),
				);
			},
		);

		it.each(cases)(
			"%j in org chart labels draws as literal text without changing the diagram",
			async (hostile, visible) => {
				const reference = await renderDiagram(orgChart("Leadership"));
				const render = await renderDiagram(orgChart(hostile));

				expectSameInertDiagram(render, reference);
				expect(render.counts).toEqual({ nodes: 3, lanes: 0, edges: 2 });
				const drawn = render.nodeTexts.map(visibleText);
				expect(
					drawn.filter((text) => text === visibleText(visible)),
				).toHaveLength(2);
				expect(drawn).toContain("Finance");
			},
		);
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
