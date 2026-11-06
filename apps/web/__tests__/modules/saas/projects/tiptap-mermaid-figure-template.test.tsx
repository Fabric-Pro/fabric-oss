/**
 * Figure templates on a client-document Proposal's page (Fizzy #2946): a
 * fence with a `%% figure:` line draws its SVG template in the theme's
 * paint, through the diagram sanitizer, instead of a Mermaid layout. Every
 * other document, a page without the theme's paint and a source the
 * template refuses draw the fence as Mermaid, as before; a chart without
 * its leading `%%` lines, as print draws it. A plain chain of seven steps
 * or more with no figure line draws as a numbered process there too, as
 * print draws it. A drawn figure
 * carries the hooks the theme numbers it by, and a template shrinks to
 * 550 px before it scrolls.
 *
 * The real renderers draw. A Mermaid drawing is told from a template by its
 * SVG: beautiful-mermaid's carries its colour variables, a template its
 * `role="img"` and `<desc>`.
 */

import {
	buildProposalThemeTokens,
	type ProposalThemePaint,
	resolveThemePaint,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagramHarness, fence, MARKER } from "./tiptap-mermaid-visual-harness";

const renderer = vi.hoisted(() => ({ native: [] as string[] }));

vi.mock("mermaid", () => ({
	default: {
		initialize: () => {},
		mermaidAPI: { getSiteConfig: () => ({}) },
		render: async (_id: string, code: string) => {
			renderer.native.push(code);
			return {
				svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 200 100"><text>Fallback</text></svg>',
			};
		},
	},
}));

vi.mock("next-intl", async () => {
	const actual =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	const en = (await import("@repo/i18n/translations/en.json")).default;
	return {
		useTranslations: (namespace: string) =>
			actual.createTranslator({
				locale: "en",
				messages: en as never,
				namespace: namespace as never,
				onError: () => {},
			}),
		useLocale: () => "en",
	};
});

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				listVisualSpecs: vi.fn(async () => ({ specs: [] })),
				editVisual: vi.fn(),
			},
		},
	},
}));

const NAVY: ProposalThemePaint = resolveThemePaint(
	buildProposalThemeTokens({
		organization: null,
		style: { primaryColor: "#1f3a8a", accentColors: [] },
		brandKit: null,
		recipient: null,
	}),
);

const CAPTION = "How one scope line moves";

function processBody({
	caption = CAPTION as string | null,
	kind = "process",
} = {}): string[] {
	return [
		MARKER,
		...(caption ? [`%% caption: ${caption}`] : []),
		`%% figure: ${kind}`,
		"flowchart TD",
		'  f0["Scope<br/>Agree what done looks like"]',
		'  f1["Build"]',
		'  f2["Launch"]',
		"  f0 --> f1",
		"  f1 --> f2",
	];
}

function doc(...bodies: string[][]): string {
	return `## Delivery\n\nWe start with discovery.\n\n${bodies
		.map((body) => fence(body))
		.join("\n\nThen.\n\n")}\n`;
}

/** Drawn by beautiful-mermaid, not by a template. */
function expectMermaidDrawing(svg: SVGSVGElement | undefined) {
	expect(svg?.getAttribute("style")).toContain("--bg:");
	expect(svg?.getAttribute("role")).toBeNull();
	expect(svg?.querySelector("desc")).toBeNull();
}

async function drawnSvgs(container: HTMLElement, count = 1) {
	await waitFor(() =>
		expect(
			container.querySelectorAll(".mermaid-diagram-area svg"),
		).toHaveLength(count),
	);
	return [
		...container.querySelectorAll<SVGSVGElement>(
			".mermaid-diagram-area svg",
		),
	];
}

beforeEach(() => {
	renderer.native = [];
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("figure templates", () => {
	it("draws a Proposal fence with a figure line from its template, named by its caption", async () => {
		const { container } = render(
			<DiagramHarness
				markdown={doc(processBody())}
				visual={{ paint: NAVY }}
			/>,
		);
		const [svg] = await drawnSvgs(container);

		expect(svg?.getAttribute("role")).toBe("img");
		expect(svg?.getAttribute("width")).toBe("662");
		expect(svg?.querySelector("title")?.textContent).toBe(CAPTION);
		expect(svg?.querySelector("desc")?.textContent).toContain("Scope");
		expect(svg?.textContent).toContain("Agree what done looks like");
		// The template's fills are the theme's paint, not Mermaid's tokens.
		expect(svg?.outerHTML).toContain(NAVY.ink);
		expect(svg?.getAttribute("style")).toBeNull();
		expect(renderer.native).toEqual([]);
	});

	it("passes the template through the sanitizer: nothing executable survives", async () => {
		const hostile = [
			MARKER,
			"%% figure: process",
			"flowchart TD",
			'  f0["A &lt;img src=x onerror=alert(1)&gt;"]',
			'  f1["B &amp; &quot;C&quot;"]',
			"  f0 --> f1",
		];
		const { container } = render(
			<DiagramHarness markdown={doc(hostile)} visual={{ paint: NAVY }} />,
		);
		const [svg] = await drawnSvgs(container);

		expect(svg?.getAttribute("role")).toBe("img");
		expect(svg?.querySelector("img, script, foreignObject")).toBeNull();
		const handlers = [svg, ...(svg?.querySelectorAll("*") ?? [])].flatMap(
			(element) =>
				[...(element?.attributes ?? [])]
					.map((attribute) => attribute.name)
					.filter((name) => /^on/i.test(name)),
		);
		expect(handlers).toEqual([]);
		expect(svg?.textContent).toContain("<img src=x onerror=alert(1)>");
	});

	it("gives each figure on the page its own ids", async () => {
		const { container } = render(
			<DiagramHarness
				markdown={doc(
					processBody(),
					processBody({ caption: "Second" }),
				)}
				visual={{ paint: NAVY }}
			/>,
		);
		const svgs = await drawnSvgs(container, 2);
		const ids = svgs.flatMap((svg) =>
			[...svg.querySelectorAll("[id]")].map((element) => element.id),
		);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			expect(id).toMatch(/^figure-/);
		}
	});

	it("draws the fence as Mermaid on any other document (no diagrams context)", async () => {
		const { container } = render(
			<DiagramHarness markdown={doc(processBody())} themeRoot={false} />,
		);
		const [svg] = await drawnSvgs(container);

		expectMermaidDrawing(svg);
		expect(
			container.querySelector(".pa-figure-counted, .pa-figure-caption"),
		).toBeNull();
	});

	it("draws the fence as Mermaid while the theme's paint is not worn", async () => {
		const { container } = render(
			<DiagramHarness
				markdown={doc(processBody())}
				visual={{ paint: null }}
			/>,
		);
		const [svg] = await drawnSvgs(container);
		expectMermaidDrawing(svg);
	});

	it("draws the fence as Mermaid when the template refuses its source", async () => {
		// A team figure needs exactly two subgraphs; a plain chain has none.
		const { container } = render(
			<DiagramHarness
				markdown={doc(processBody({ kind: "team" }))}
				visual={{ paint: NAVY }}
			/>,
		);
		const [svg] = await drawnSvgs(container);

		expectMermaidDrawing(svg);
		expect(svg?.textContent).toContain("Launch");
	});
});

describe("a plain chain without a figure line", () => {
	function chainBody(steps: number): string[] {
		return [
			"%% caption: Every step a request takes",
			"flowchart TD",
			...Array.from(
				{ length: steps - 1 },
				(_, index) =>
					`  s${index}["Step ${index + 1}"] --> s${index + 1}["Step ${index + 2}"]`,
			),
		];
	}

	it("draws seven steps or more as a numbered process on a Proposal's page, numbered and captioned as print numbers them", async () => {
		const { container } = render(
			<DiagramHarness
				markdown={doc(chainBody(12))}
				visual={{ paint: NAVY }}
			/>,
		);
		const [svg] = await drawnSvgs(container);

		expect(svg?.getAttribute("role")).toBe("img");
		expect(svg?.getAttribute("width")).toBe("662");
		expect(svg?.querySelector("title")?.textContent).toBe(
			"Every step a request takes",
		);
		expect(svg?.querySelectorAll("rect.step")).toHaveLength(12);
		expect(svg?.querySelector("desc")?.textContent).toContain(
			"12. Step 12.",
		);
		expect(renderer.native).toEqual([]);
		expect(container.querySelectorAll(".pa-figure-counted")).toHaveLength(
			1,
		);
		expect(container.textContent).toContain("Every step a request takes");
		expect(
			container.querySelector("[data-diagram-not-printable]"),
		).toBeNull();
	});

	it("leaves six steps to the Mermaid layout", async () => {
		const { container } = render(
			<DiagramHarness
				markdown={doc(chainBody(6))}
				visual={{ paint: NAVY }}
			/>,
		);
		const [svg] = await drawnSvgs(container);

		expectMermaidDrawing(svg);
		expect(container.querySelectorAll(".pa-figure-counted")).toHaveLength(
			1,
		);
	});

	it("draws the chain as Mermaid on any other document", async () => {
		const { container } = render(
			<DiagramHarness markdown={doc(chainBody(12))} themeRoot={false} />,
		);
		const [svg] = await drawnSvgs(container);

		expectMermaidDrawing(svg);
	});
});

describe("bar chart template", () => {
	/** A brand with an accent, so the label colour is not the primary. */
	const BRANDED: ProposalThemePaint = resolveThemePaint(
		buildProposalThemeTokens({
			organization: null,
			style: { primaryColor: "#1f3a8a", accentColors: ["#8a5a00"] },
			brandKit: null,
			recipient: null,
		}),
	);

	const barsBody = [
		MARKER,
		"%% caption: Hours saved per week",
		"%% figure: bars",
		"xychart-beta horizontal",
		'  x-axis ["Expected · 5% uplift", "Faster review", Baseline]',
		'  y-axis "h" 0 --> 20',
		"  bar [12, 15, 4]",
		"  line [12, 12, 12]",
	];

	it("draws a bar chart from its template in the theme's paint, threshold included", async () => {
		expect(BRANDED.label).not.toBe(BRANDED.primary);
		const { container } = render(
			<DiagramHarness
				markdown={doc(barsBody)}
				visual={{ paint: BRANDED }}
			/>,
		);
		const [svg] = await drawnSvgs(container);

		expect(svg?.getAttribute("role")).toBe("img");
		expect(svg?.getAttribute("width")).toBe("662");
		expect(svg?.querySelector("title")?.textContent).toBe(
			"Hours saved per week",
		);
		expect(svg?.querySelector("desc")?.textContent).toContain(
			"Expected · 5% uplift: 12 h",
		);
		const fills = [...(svg?.querySelectorAll("rect.bar") ?? [])].map(
			(bar) => bar.getAttribute("fill"),
		);
		expect(fills).toHaveLength(3);
		expect(fills[0]).toBe(BRANDED.primary);
		expect(fills[2]).toBe(BRANDED.primary);
		expect(fills[1]).not.toBe(BRANDED.primary);
		// The dashed threshold survives the sanitizer, in the label colour.
		const line = svg?.querySelector("line.threshold");
		expect(line?.getAttribute("stroke")).toBe(BRANDED.label);
		expect(line?.getAttribute("stroke-dasharray")).toBe("4 3");
		expect(svg?.getAttribute("style")).toBeNull();
		expect(renderer.native).toEqual([]);
		expect(container.querySelectorAll(".pa-figure-counted")).toHaveLength(
			1,
		);
	});

	it("draws a bar chart with beautiful-mermaid while the theme's paint is not worn", async () => {
		const { container } = render(
			<DiagramHarness
				markdown={doc(barsBody)}
				visual={{ paint: null }}
			/>,
		);
		const [svg] = await drawnSvgs(container);

		// beautiful-mermaid finds a chart on its first line only: the page
		// hands it the chart without its leading `%%` lines, as print does,
		// so the figure keeps its number while the paint loads.
		expectMermaidDrawing(svg);
		expect(svg?.textContent).toContain("Faster review");
		expect(renderer.native).toEqual([]);
		expect(container.querySelectorAll(".pa-figure-counted")).toHaveLength(
			1,
		);
	});

	it("draws a bar chart its template refuses with beautiful-mermaid, numbered and printed as drawn", async () => {
		const thirteen = [
			MARKER,
			"%% caption: Hours saved per team",
			"%% figure: bars",
			"xychart-beta horizontal",
			`  x-axis [${Array.from({ length: 13 }, (_, index) => `Team${index + 1}`).join(", ")}]`,
			`  bar [${Array.from({ length: 13 }, (_, index) => index + 1).join(", ")}]`,
		];
		const { container } = render(
			<DiagramHarness
				markdown={doc(thirteen)}
				visual={{ paint: BRANDED }}
			/>,
		);
		const [svg] = await drawnSvgs(container);

		expectMermaidDrawing(svg);
		expect(svg?.textContent).toContain("Team13");
		expect(renderer.native).toEqual([]);
		expect(container.querySelectorAll(".pa-figure-counted")).toHaveLength(
			1,
		);
		expect(
			container.querySelector("[data-diagram-not-printable]"),
		).toBeNull();
	});
});

describe("gantt template", () => {
	const ganttBody = [
		MARKER,
		"%% caption: Pilot schedule by workstream",
		"%% figure: gantt",
		"gantt",
		"  title Pilot schedule",
		"  dateFormat YYYY-MM-DD",
		"  section Build",
		"  Routing :a1, 2026-11-02, 3w",
		"  section Pilot",
		"  Region one :b1, after a1, 4w",
		"  Pilot review :milestone, m1, 2026-12-21, 0d",
	];

	it("draws a gantt from its template in the theme's paint, milestone included", async () => {
		const { container } = render(
			<DiagramHarness
				markdown={doc(ganttBody)}
				visual={{ paint: NAVY }}
			/>,
		);
		const [svg] = await drawnSvgs(container);

		expect(svg?.getAttribute("role")).toBe("img");
		expect(svg?.getAttribute("width")).toBe("662");
		expect(svg?.querySelector("title")?.textContent).toBe(
			"Pilot schedule by workstream",
		);
		expect(svg?.querySelector("desc")?.textContent).toContain(
			"Build: Routing, 2026-11-02 to 2026-11-22.",
		);
		const fills = [...(svg?.querySelectorAll("rect.task") ?? [])].map(
			(bar) => bar.getAttribute("fill"),
		);
		expect(fills).toEqual([NAVY.muted, NAVY.primary]);
		// The diamond and its dashed line survive the sanitizer.
		expect(svg?.querySelector("path.milestone")?.getAttribute("fill")).toBe(
			NAVY.label,
		);
		expect(
			svg
				?.querySelector("line.milestone-guide")
				?.getAttribute("stroke-dasharray"),
		).toBe("3 3");
		expect(svg?.getAttribute("style")).toBeNull();
		expect(renderer.native).toEqual([]);
		expect(container.querySelectorAll(".pa-figure-counted")).toHaveLength(
			1,
		);
		expect(
			container.querySelector("[data-diagram-not-printable]"),
		).toBeNull();
	});

	it("draws a gantt its template refuses with mermaid.js, numbered and noted as left out of the PDF", async () => {
		const refused = ganttBody.map((line) =>
			line === "  Routing :a1, 2026-11-02, 3w"
				? "  Routing :crit, a1, 2026-11-02, 3w"
				: line,
		);
		const { container } = render(
			<DiagramHarness markdown={doc(refused)} visual={{ paint: NAVY }} />,
		);
		const [svg] = await drawnSvgs(container);

		expect(renderer.native).toHaveLength(1);
		expect(renderer.native[0]).toContain("Routing :crit, a1");
		expect(svg?.textContent).toBe("Fallback");
		// Print keeps a numbered placeholder for it, so the page numbers it.
		expect(container.querySelectorAll(".pa-figure-counted")).toHaveLength(
			1,
		);
		expect(
			container.querySelector("[data-diagram-not-printable]"),
		).not.toBeNull();
	});
});

describe("figure numbering hooks", () => {
	it("marks a drawn figure as counted and its caption as the numbered line", async () => {
		const { container } = render(
			<DiagramHarness
				markdown={doc(processBody())}
				visual={{ paint: NAVY }}
			/>,
		);
		await drawnSvgs(container);

		const figures = container.querySelectorAll(".pa-figure-counted");
		expect(figures).toHaveLength(1);
		const caption = figures[0]?.querySelector(".pa-figure-caption");
		expect(caption?.textContent).toBe(CAPTION);
	});

	it("captions an uncaptioned figure with its section's heading, as the exports do (Fizzy #2946)", async () => {
		const { container } = render(
			<DiagramHarness
				markdown={doc(processBody({ caption: null }))}
				visual={{ paint: NAVY }}
				editable={false}
			/>,
		);
		await drawnSvgs(container);

		const caption = container.querySelector(
			".pa-figure-counted .pa-figure-caption",
		);
		expect(caption).not.toBeNull();
		expect(caption?.textContent?.trim()).toBe("Delivery");
	});

	it("gives an uncaptioned figure with no heading above it an empty caption line for its number", async () => {
		const { container } = render(
			<DiagramHarness
				markdown={`We start with discovery.\n\n${fence(processBody({ caption: null }))}\n`}
				visual={{ paint: NAVY }}
				editable={false}
			/>,
		);
		await drawnSvgs(container);

		const caption = container.querySelector(
			".pa-figure-counted .pa-figure-caption",
		);
		expect(caption).not.toBeNull();
		expect(caption?.textContent).toBe("");
	});

	it("counts a Mermaid diagram on a Proposal too", async () => {
		const mermaidBody = [
			MARKER,
			"flowchart LR",
			'  t0["Discovery"]',
			'  t1["Launch"]',
			"  t0 --> t1",
		];
		const { container } = render(
			<DiagramHarness
				markdown={doc(processBody(), mermaidBody)}
				visual={{ paint: NAVY }}
			/>,
		);
		await drawnSvgs(container, 2);
		expect(container.querySelectorAll(".pa-figure-counted")).toHaveLength(
			2,
		);
	});
});

describe("figure sizing", () => {
	function columnOf(width: number) {
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
			width,
		);
	}

	it("shrinks a template to a column of 550 px or more, without scrolling", async () => {
		columnOf(600);
		const { container } = render(
			<DiagramHarness
				markdown={doc(processBody())}
				visual={{ paint: NAVY }}
			/>,
		);
		await drawnSvgs(container);

		const area = container.querySelector(".mermaid-diagram-area");
		expect(area?.hasAttribute("data-diagram-scroll")).toBe(false);
		expect(area?.getAttribute("role")).toBeNull();
	});

	it("draws a template at 550 px in a narrower column, in a keyboard-reachable scroll region", async () => {
		columnOf(400);
		const { container } = render(
			<DiagramHarness
				markdown={doc(processBody())}
				visual={{ paint: NAVY }}
			/>,
		);
		await drawnSvgs(container);

		await waitFor(() =>
			expect(
				container
					.querySelector(".mermaid-diagram-area")
					?.hasAttribute("data-diagram-scroll"),
			).toBe(true),
		);
		const area = container.querySelector<HTMLElement>(
			".mermaid-diagram-area",
		);
		expect(area?.getAttribute("role")).toBe("region");
		expect(area?.getAttribute("tabindex")).toBe("0");
		expect(area?.getAttribute("aria-label")).toContain(CAPTION);
		expect(area?.style.getPropertyValue("--pa-diagram-width")).toBe(
			"550px",
		);
	});

	it("keeps the label rule for a Mermaid diagram in the same column", async () => {
		columnOf(400);
		// Top-down, so it is drawn as written: on a Proposal's page a sideways
		// chain this wide is drawn top-down to print, and then fits the column.
		const wide = [
			"flowchart TD",
			...Array.from(
				{ length: 12 },
				(_, index) => `  r[Start] --> n${index}["Step ${index}"]`,
			),
		];
		const { container } = render(
			<DiagramHarness markdown={doc(wide)} visual={{ paint: NAVY }} />,
		);
		await drawnSvgs(container);
		await waitFor(() =>
			expect(
				container
					.querySelector<HTMLElement>(".mermaid-diagram-area")
					?.style.getPropertyValue("--pa-diagram-width"),
			).not.toBe(""),
		);
		expect(
			container
				.querySelector<HTMLElement>(".mermaid-diagram-area")
				?.style.getPropertyValue("--pa-diagram-width"),
		).not.toBe("550px");
	});
});
