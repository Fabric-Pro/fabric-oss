/**
 * Legible node labels on the live page: beautiful-mermaid sizes a node from
 * an estimate of its text, which runs short for long single-line labels, so
 * on every page a flowchart is drawn from a copy with its long labels broken
 * into lines. On a client-document Proposal's page, which prints, a diagram
 * whose labels would still print below the floor at the print column also
 * follows the export's rule (top-down, then every long label broken); every
 * other page keeps the author's direction. The fence a document holds never
 * changes, other kinds of diagram and figure templates are drawn as before,
 * and a source drawn once is not laid out again. The export breaks, turns
 * and measures with the same helpers and canvas margin, so a fence gets the
 * same layout on a Proposal's page as in its PDF.
 *
 * The real renderer draws; its input is recorded.
 */

import {
	DIAGRAM_CANVAS_PADDING_PX,
	PRINT_COLUMN_PX,
	PRINT_FIGURE_MAX_HEIGHT_PX,
	PRINT_LABEL_FLOOR_PT,
	printedNodeLabelPt,
} from "@repo/utils/proposal-artifact/diagram-label-wrap";
import {
	buildProposalThemeTokens,
	resolveThemePaint,
	visualRoleClassDefs,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { readSvgNaturalSize } from "@saas/projects/lib/mermaid-diagram-sizing";
import { resetLegibleDrawingsForTests } from "@saas/projects/lib/tiptap-mermaid-extension";
import { render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DiagramHarness,
	fence,
	MARKER,
	newQueryClient,
} from "./tiptap-mermaid-visual-harness";

const renderer = vi.hoisted(() => ({
	beautiful: [] as string[],
	native: [] as string[],
	/** Inputs containing this the engine refuses, when set. */
	refuse: null as string | null,
}));

vi.mock("beautiful-mermaid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("beautiful-mermaid")>();
	return {
		...actual,
		renderMermaidSVG: (
			code: string,
			options: Parameters<typeof actual.renderMermaidSVG>[1],
		) => {
			renderer.beautiful.push(code);
			if (renderer.refuse !== null && code.includes(renderer.refuse)) {
				throw new Error("Layout failed");
			}
			return actual.renderMermaidSVG(code, options);
		},
	};
});

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

/**
 * Four steps left to right, each label a title, a sentence and a note in
 * parentheses on one line, as a generated plan writes them.
 */
const STEP_LABELS = [
	"Discover and confirm — Agree the example pilot scope, its users, the workflows and the sources of information (Name the success measures and the access rules that apply.)",
	"Prepare the pilot — Load the example records, connect the agreed sources and set up the working spaces for each team (Check the data with its owners before the first run.)",
	"Run the pilot — Work through the agreed workflows with the example users and record every question that comes up (Keep a short log of what worked and what did not.)",
	"Review and decide — Compare the pilot with the success measures and agree the next phase with the sponsors (Write one recommendation with its costs and its risks.)",
];

const WIDE_PLAN = [
	"flowchart LR",
	...STEP_LABELS.map((label, index) => `  t${index}["${label}"]`),
	"  t0 --> t1",
	"  t1 --> t2",
	"  t2 --> t3",
];

/** Eight short steps left to right: too wide to print, nothing to break. */
const LONG_CHAIN = [
	"flowchart LR",
	...Array.from({ length: 8 }, (_, index) => `  n${index}["Step ${index}"]`),
	...Array.from({ length: 7 }, (_, index) => `  n${index} --> n${index + 1}`),
];

const SHORT_PLAN = [
	"flowchart LR",
	'  a["Discovery"] --> b["Pilot"]',
	'  b --> c["Review"]',
];

const XYCHART = [
	"xychart-beta",
	'  title "Example pilot hours by month"',
	"  x-axis [Jan, Feb, Mar, Apr]",
	"  bar [12, 18, 9, 22]",
];

const NAVY = resolveThemePaint(
	buildProposalThemeTokens({
		organization: null,
		style: { primaryColor: "#1f3a8a", accentColors: [] },
		brandKit: null,
		recipient: null,
	}),
);

function doc(...bodies: string[][]): string {
	return `## Delivery\n\nWe start with discovery.\n\n${bodies
		.map((body) => fence(body))
		.join("\n\nThen.\n\n")}\n`;
}

async function drawnSvg(container: HTMLElement): Promise<SVGSVGElement> {
	await waitFor(() =>
		expect(
			container.querySelector(".mermaid-diagram-area svg"),
		).not.toBeNull(),
	);
	return container.querySelector(
		".mermaid-diagram-area svg",
	) as SVGSVGElement;
}

/** The size the drawn SVG declares, in CSS pixels. */
function declaredSize(svg: SVGSVGElement): { width: number; height: number } {
	const size = readSvgNaturalSize(svg.outerHTML);
	return { width: Number(size?.width), height: Number(size?.height) };
}

/** A top-down chain of `steps` nodes, each label a 73-character sentence. */
function tallChain(steps: number): string[] {
	return [
		"flowchart TD",
		...Array.from(
			{ length: steps },
			(_, index) =>
				`  n${index}["Step ${index + 1} — review the example records with the owners and agree the actions"]`,
		),
		...Array.from(
			{ length: steps - 1 },
			(_, index) => `  n${index} --> n${index + 1}`,
		),
	];
}

/** The header line of an engine input, after any leading `%%` lines. */
function headerOf(input: string | undefined): string | undefined {
	return input?.split("\n").find((line) => !line.startsWith("%%"));
}

/** Each drawn label of several lines, its lines joined by spaces. */
function multiLineLabels(svg: SVGSVGElement): string[] {
	return [...svg.querySelectorAll("text")]
		.map((text) => [...text.querySelectorAll("tspan")])
		.filter((lines) => lines.length > 1)
		.map((lines) => lines.map((line) => line.textContent).join(" "));
}

beforeEach(() => {
	renderer.beautiful = [];
	renderer.native = [];
	renderer.refuse = null;
	resetLegibleDrawingsForTests();
});

describe("long labels on every page", () => {
	it("breaks a flowchart's long labels into lines and keeps the author's direction", async () => {
		for (const label of STEP_LABELS) {
			expect(label.length).toBeGreaterThanOrEqual(150);
		}
		const { container } = render(
			<DiagramHarness markdown={doc(WIDE_PLAN)} themeRoot={false} />,
		);
		const svg = await drawnSvg(container);

		expect(renderer.beautiful.length).toBeGreaterThan(0);
		for (const input of renderer.beautiful) {
			expect(headerOf(input)).toBe("flowchart LR");
			expect(input).toContain("Discover and confirm —<br/>");
		}
		expect(multiLineLabels(svg)).toEqual(STEP_LABELS);
		expect(renderer.native).toEqual([]);
	});

	it("keeps a wide sideways chain of short labels sideways and as written", async () => {
		const { container } = render(
			<DiagramHarness markdown={doc(LONG_CHAIN)} themeRoot={false} />,
		);
		const svg = await drawnSvg(container);

		// Too wide to print at the floor; only a Proposal's page turns it.
		expect(printedNodeLabelPt(declaredSize(svg))).toBeLessThan(
			PRINT_LABEL_FLOOR_PT,
		);
		expect(renderer.beautiful.length).toBeGreaterThan(0);
		for (const input of renderer.beautiful) {
			expect(input).toBe(LONG_CHAIN.join("\n"));
		}
	});

	it("names Inter as the drawing's one font family", async () => {
		const { container } = render(
			<DiagramHarness markdown={doc(SHORT_PLAN)} themeRoot={false} />,
		);
		const svg = await drawnSvg(container);
		const css = [...svg.querySelectorAll("style")]
			.map((style) => style.textContent)
			.join("\n");
		expect(css).toContain(
			"text { font-family: 'Inter', system-ui, sans-serif; }",
		);
		expect(css).not.toContain("ui-sans-serif");
	});

	it("draws a short sideways flowchart once, sideways and as written", async () => {
		const { container } = render(
			<DiagramHarness markdown={doc(SHORT_PLAN)} themeRoot={false} />,
		);
		await drawnSvg(container);
		expect(renderer.beautiful.length).toBeGreaterThan(0);
		for (const input of renderer.beautiful) {
			expect(input).toBe(SHORT_PLAN.join("\n"));
		}
	});

	it("falls back to mermaid.js with the fence as written when the engine refuses it", async () => {
		renderer.refuse = "flowchart";
		const { container } = render(
			<DiagramHarness markdown={doc(WIDE_PLAN)} themeRoot={false} />,
		);
		await drawnSvg(container);
		await waitFor(() => expect(renderer.native.length).toBeGreaterThan(0));
		expect(renderer.native.at(-1)).toBe(WIDE_PLAN.join("\n"));
	});
});

describe("the print floor on a Proposal's page", () => {
	it("draws a wide plan of sentence labels top-down with its labels broken, within the print column", async () => {
		const { container } = render(
			<DiagramHarness
				markdown={doc(WIDE_PLAN)}
				visual={{ paint: NAVY }}
			/>,
		);
		const svg = await drawnSvg(container);

		// The first copy drawn breaks the long labels and stays sideways.
		const [first] = renderer.beautiful;
		expect(headerOf(first)).toBe("flowchart LR");
		expect(first).toContain("Discover and confirm —<br/>");
		// The copy kept is top-down.
		expect(headerOf(renderer.beautiful.at(-1))).toBe("flowchart TD");

		const size = declaredSize(svg);
		expect(size.width).toBeGreaterThan(0);
		expect(size.width).toBeLessThanOrEqual(PRINT_COLUMN_PX);
		expect(printedNodeLabelPt(size)).toBeGreaterThanOrEqual(
			PRINT_LABEL_FLOOR_PT,
		);
		const labels = multiLineLabels(svg);
		expect(labels).toEqual(STEP_LABELS);
		expect(renderer.native).toEqual([]);
	});

	it("keeps a sideways pair of 70-character labels sideways with the labels broken, as the export prints it", async () => {
		const pair = [
			"flowchart LR",
			'  a["Discovery workshop — agree the example goals, the users and the measures"] --> b["Pilot delivery — configure the agreed scope and run it with example users"]',
		];
		const { container } = render(
			<DiagramHarness markdown={doc(pair)} visual={{ paint: NAVY }} />,
		);
		const svg = await drawnSvg(container);

		// The copy with both labels broken and the source as written, both
		// sideways; the broken one prints at full size and is kept, so
		// nothing turns.
		expect(renderer.beautiful).toHaveLength(2);
		const [drawn, written] = renderer.beautiful;
		expect(headerOf(drawn)).toBe("flowchart LR");
		expect(drawn).toContain("Discovery workshop —<br/>");
		expect(drawn).toContain("Pilot delivery —<br/>");
		expect(headerOf(written)).toBe("flowchart LR");
		expect(written).not.toContain("<br/>");
		expect(multiLineLabels(svg)).toHaveLength(2);
		const size = declaredSize(svg);
		expect(size.width).toBeLessThanOrEqual(PRINT_COLUMN_PX);
		expect(printedNodeLabelPt(size)).toBeGreaterThanOrEqual(
			PRINT_LABEL_FLOOR_PT,
		);
		// Drawn with the export's canvas margin, so as wide as it prints.
		const boxLefts = [...svg.querySelectorAll("rect[x]")].map((rect) =>
			Number(rect.getAttribute("x")),
		);
		expect(boxLefts.length).toBeGreaterThan(0);
		expect(Math.min(...boxLefts)).toBeCloseTo(DIAGRAM_CANVAS_PADDING_PX, 5);
	});

	it("turns a wide sideways chain of short labels top-down", async () => {
		const { container } = render(
			<DiagramHarness
				markdown={doc(LONG_CHAIN)}
				visual={{ paint: NAVY }}
			/>,
		);
		const svg = await drawnSvg(container);

		expect(headerOf(renderer.beautiful[0])).toBe("flowchart LR");
		expect(headerOf(renderer.beautiful.at(-1))).toBe("flowchart TD");
		expect(printedNodeLabelPt(declaredSize(svg))).toBeGreaterThanOrEqual(
			PRINT_LABEL_FLOOR_PT,
		);
	});

	it("draws a tall top-down chain of 70-character labels as written, as it prints, and broken on other pages", async () => {
		const proposal = render(
			<DiagramHarness
				markdown={doc(tallChain(8))}
				visual={{ paint: NAVY }}
			/>,
		);
		const printed = await drawnSvg(proposal.container);

		// The broken copy and the source as written: breaking makes the chain
		// taller than a printed figure may be, so the copy as written prints
		// larger and is kept, and it needs nothing more.
		expect(renderer.beautiful).toHaveLength(2);
		const [broken, written] = renderer.beautiful;
		expect(broken).toContain("<br/>");
		expect(written).not.toContain("<br/>");
		expect(multiLineLabels(printed)).toEqual([]);
		const size = declaredSize(printed);
		expect(size.width).toBeLessThanOrEqual(PRINT_COLUMN_PX);
		expect(size.height).toBeLessThanOrEqual(PRINT_FIGURE_MAX_HEIGHT_PX);
		expect(printedNodeLabelPt(size)).toBeCloseTo(9.75, 5);
		proposal.unmount();

		// A page that does not print draws the broken copy alone.
		renderer.beautiful = [];
		const other = render(
			<DiagramHarness markdown={doc(tallChain(8))} themeRoot={false} />,
		);
		const onScreen = await drawnSvg(other.container);
		expect(renderer.beautiful).toHaveLength(1);
		expect(renderer.beautiful[0]).toContain("<br/>");
		expect(multiLineLabels(onScreen)).toHaveLength(8);
	});

	it("keeps the broken copy of a chain when it prints as large as the source as written", async () => {
		const { container } = render(
			<DiagramHarness
				markdown={doc(tallChain(6))}
				visual={{ paint: NAVY }}
			/>,
		);
		const svg = await drawnSvg(container);
		expect(renderer.beautiful).toHaveLength(2);
		expect(multiLineLabels(svg)).toHaveLength(6);
		expect(printedNodeLabelPt(declaredSize(svg))).toBeCloseTo(9.75, 5);
	});

	it("draws without the caption line, comment lines first and the role classes after the broken labels", async () => {
		const caption = "How the example pilot runs";
		const body = [
			MARKER,
			`%% caption: ${caption}`,
			...WIDE_PLAN,
			"  class t0 surface",
			"  class t3 primary",
		];
		const { container } = render(
			<DiagramHarness markdown={doc(body)} visual={{ paint: NAVY }} />,
		);
		await drawnSvg(container);
		await waitFor(() =>
			expect(headerOf(renderer.beautiful.at(-1))).toBe("flowchart TD"),
		);

		const roles = visualRoleClassDefs(NAVY);
		// The source as written competes with the broken copies; every copy
		// but that one has its labels broken.
		expect(
			renderer.beautiful.filter((input) => !input.includes("<br/>")),
		).toHaveLength(1);
		for (const input of renderer.beautiful) {
			const lines = input.split("\n");
			expect(lines[0]).toBe(MARKER);
			expect(input).not.toContain("%% caption");
			expect(input).not.toContain(caption);
			// The role classes close the copy, after every broken label.
			expect(lines.slice(-roles.length)).toEqual(roles);
			const lastBroken = lines.findLastIndex((line) =>
				line.includes("<br/>"),
			);
			const firstRole = lines.indexOf(roles[0] ?? "");
			expect(lastBroken).toBeLessThan(firstRole);
			expect(lines).toContain("  class t0 surface");
		}
	});

	it("leaves the document's fence as written", async () => {
		let editor: Editor | null = null;
		const markdown = doc([MARKER, ...WIDE_PLAN]);
		const { container } = render(
			<DiagramHarness
				markdown={markdown}
				visual={{ paint: NAVY }}
				onEditor={(created) => {
					editor = created;
				}}
				queryClient={newQueryClient()}
			/>,
		);
		await drawnSvg(container);
		await waitFor(() =>
			expect(headerOf(renderer.beautiful.at(-1))).toBe("flowchart TD"),
		);
		const saved = getEditorMarkdownForSave(editor as unknown as Editor);
		expect(saved).toContain(fence([MARKER, ...WIDE_PLAN]));
		expect(saved).not.toContain("<br/>");
		expect(saved).not.toContain("flowchart TD");
		expect(saved).not.toContain("classDef");
	});

	it("draws an xychart as written, however wide", async () => {
		const { container } = render(
			<DiagramHarness markdown={doc(XYCHART)} visual={{ paint: NAVY }} />,
		);
		await drawnSvg(container);
		expect(renderer.beautiful.length).toBeGreaterThan(0);
		for (const input of renderer.beautiful) {
			expect(input).toBe(XYCHART.join("\n"));
		}
		expect(renderer.native).toEqual([]);
	});

	it("draws a figure template as before, never through the engine", async () => {
		const figure = [
			MARKER,
			"%% figure: process",
			"flowchart LR",
			...STEP_LABELS.map((label, index) => `  f${index}["${label}"]`),
			"  f0 --> f1",
			"  f1 --> f2",
			"  f2 --> f3",
		];
		const { container } = render(
			<DiagramHarness markdown={doc(figure)} visual={{ paint: NAVY }} />,
		);
		const svg = await drawnSvg(container);
		expect(svg.getAttribute("role")).toBe("img");
		expect(renderer.beautiful).toEqual([]);
		expect(renderer.native).toEqual([]);
	});

	it("keeps the drawing before a copy the engine refuses", async () => {
		renderer.refuse = "<br/>";
		const { container } = render(
			<DiagramHarness
				markdown={doc(WIDE_PLAN)}
				visual={{ paint: NAVY }}
			/>,
		);
		const svg = await drawnSvg(container);
		// Every broken copy was refused; the source as written drew, and so
		// did its top-down copy, whose labels print larger and is kept.
		const unbroken = renderer.beautiful.filter(
			(input) => !input.includes("<br/>"),
		);
		expect(unbroken.map(headerOf)).toEqual([
			"flowchart LR",
			"flowchart TD",
		]);
		expect(
			renderer.beautiful.some((input) => input.includes("<br/>")),
		).toBe(true);
		expect(svg.getAttribute("style")).toContain("--bg:");
		expect(svg.querySelectorAll("tspan")).toHaveLength(0);
		expect(declaredSize(svg).width).toBeLessThan(1500);
		expect(renderer.native).toEqual([]);
	});
});

describe("drawings kept", () => {
	it("lays a source out once, however often the page shows it", async () => {
		const first = render(
			<DiagramHarness
				markdown={doc(WIDE_PLAN, WIDE_PLAN)}
				visual={{ paint: NAVY }}
			/>,
		);
		await waitFor(() =>
			expect(
				first.container.querySelectorAll(".mermaid-diagram-area svg"),
			).toHaveLength(2),
		);
		const drawn = [...renderer.beautiful];
		expect(drawn.length).toBeGreaterThan(0);
		// The second diagram took the first one's drawing.
		expect(new Set(drawn).size).toBe(drawn.length);
		const [one, two] = [
			...first.container.querySelectorAll(".mermaid-diagram-area svg"),
		];
		expect(one?.outerHTML).toBe(two?.outerHTML);
		first.unmount();

		const again = render(
			<DiagramHarness
				markdown={doc(WIDE_PLAN)}
				visual={{ paint: NAVY }}
			/>,
		);
		await drawnSvg(again.container);
		expect(renderer.beautiful).toEqual(drawn);
	});

	it("draws the same source again under the other rule", async () => {
		// Without a paint the source carries no role classes, so it is a
		// different source; a template-free non-flowchart is the same text.
		const withPaint = render(
			<DiagramHarness markdown={doc(XYCHART)} visual={{ paint: NAVY }} />,
		);
		await drawnSvg(withPaint.container);
		const drawn = renderer.beautiful.length;
		withPaint.unmount();

		const without = render(
			<DiagramHarness markdown={doc(XYCHART)} themeRoot={false} />,
		);
		await drawnSvg(without.container);
		expect(renderer.beautiful.length).toBeGreaterThan(drawn);
	});
});
