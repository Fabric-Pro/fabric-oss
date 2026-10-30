/**
 * Figure numbers on the live page and in the exports (Fizzy #2946): the same
 * fences, in the same order, take the same "Figure n." on the live page as
 * in the PDF and the DOCX, so prose that cites a figure points at it in all
 * three.
 *
 * The live side is the page's own rule (`isLiveFigureCounted`) fed what the
 * page's engines do with each fence: its figure template, else
 * beautiful-mermaid on the fence with the role classes appended, else
 * mermaid.js. mermaid.js needs a browser; whether it draws a fence never
 * changes the number, which the test checks for every fence. The export
 * side is `renderExportDiagrams` and `diagramFigureNumbers`. beautiful-mermaid
 * runs for real on both sides, but refuses a fence marked as below, as no
 * real fence of a kind it takes is refused. The export's layout also runs
 * out of time on a fence marked as below, which the live page draws as any
 * other.
 */

import {
	diagramPrintability,
	figurePaletteOf,
	isLiveFigureCounted,
	type LiveDiagramEngine,
} from "@repo/utils/proposal-artifact/diagram-printability";
import { tryRenderFigure } from "@repo/utils/proposal-artifact/proposal-figures";
import {
	buildProposalThemeTokens,
	resolveThemePaint,
	withVisualRoleClassDefs,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { describe, expect, it, vi } from "vitest";
import type { DiagramLayout } from "../../../lib/proposal-export/diagram-layout";
import { diagramFigureNumbers } from "../../../lib/proposal-export/types";
import { renderExportDiagrams } from "../render-diagrams";

vi.mock("../../lib/activity-logger", () => ({
	activityLogger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

/** beautiful-mermaid refuses a fence carrying this; mermaid.js would draw it. */
const ENGINE_THROWS = "EngineThrowsHere";

/** The export's layout runs past its time limit on a fence carrying this. */
const LAYOUT_TIMES_OUT = "LayoutTimesOutHere";

vi.mock("beautiful-mermaid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("beautiful-mermaid")>();
	return {
		...actual,
		renderMermaidSVG: (
			text: string,
			options?: Parameters<typeof actual.renderMermaidSVG>[1],
		) => {
			if (text.includes("EngineThrowsHere")) {
				throw new Error("Layout failed");
			}
			return actual.renderMermaidSVG(text, options);
		},
	};
});

const paint = resolveThemePaint(
	buildProposalThemeTokens({
		organization: null,
		style: { primaryColor: "#1f3a6b", accentColors: [] },
		brandKit: null,
		recipient: null,
	}),
);

/** The engine on the test's own thread, so the mock above applies. */
const inProcessLayout: DiagramLayout = {
	async render(source, options) {
		if (source.includes(LAYOUT_TIMES_OUT)) {
			return { svg: null, abandoned: "timeLimit" };
		}
		const mermaid = await import("beautiful-mermaid");
		try {
			return {
				svg: mermaid.renderMermaidSVG(source, options),
				abandoned: false,
			};
		} catch {
			return { svg: null, abandoned: false };
		}
	},
	async close() {},
};

const GANTT = [
	"gantt",
	"  title Plan",
	"  dateFormat YYYY-MM-DD",
	"  section Build",
	"  Design :a1, 2026-01-01, 10d",
].join("\n");

/** The fences, as the export receives them: without a caption line. */
const FENCES: readonly [name: string, source: string][] = [
	[
		"a figure template",
		[
			"%% figure: process",
			"flowchart LR",
			'  s0["Discovery<br/>Agree on goals and success measures"]',
			'  s1["Pilot<br/>Configure the agreed scope"]',
			"  s0 --> s1",
		].join("\n"),
	],
	["a flowchart", "flowchart TD\n  a[Discovery] --> b[Launch]"],
	["plain text", "Discovery, then Build, then Launch."],
	["a misspelt header", "flowchrt TD\n  a --> b"],
	["a gantt chart", GANTT],
	["a gantt chart with an error", `${GANTT}\n  BROKEN`],
	[
		"a flowchart only mermaid.js draws",
		`flowchart TD\n  a[${ENGINE_THROWS}] --> b[Launch]`,
	],
	[
		"a flowchart whose export layout runs out of time",
		`flowchart TD\n  a[${LAYOUT_TIMES_OUT}] --> b[Launch]`,
	],
	["a sequence diagram", "sequenceDiagram\n  A->>B: Hello"],
];

/**
 * Which engine the live page draws a fence with, short of mermaid.js: its
 * template, beautiful-mermaid, or null when both refuse it.
 */
async function liveEngine(source: string): Promise<LiveDiagramEngine | null> {
	if (
		tryRenderFigure(source, figurePaletteOf(paint), { caption: null }) !==
		null
	) {
		return "template";
	}
	const { renderMermaidSVG } = await import("beautiful-mermaid");
	try {
		renderMermaidSVG(withVisualRoleClassDefs(source, paint).trim(), {});
		return "beautiful-mermaid";
	} catch {
		return null;
	}
}

describe("figure numbers on the live page and in the exports", () => {
	it("are the same for every fence", async () => {
		let next = 0;
		const live: (number | null)[] = [];
		for (const [name, source] of FENCES) {
			const printability = diagramPrintability(source.trim());
			const engine = await liveEngine(source);
			const counted = isLiveFigureCounted(printability, engine);
			// Left to mermaid.js, the number is the same whether it draws
			// the fence or not.
			if (engine === null) {
				expect(isLiveFigureCounted(printability, "mermaid"), name).toBe(
					counted,
				);
			}
			live.push(counted ? ++next : null);
		}

		const { diagrams, warnings } = await renderExportDiagrams({
			sources: FENCES.map(([, source]) => source),
			paint,
			browser: null,
			withPng: false,
			deadline: Date.now() + 60_000,
			layout: inProcessLayout,
		});

		// A broken fence takes no number on either side; one whose layout
		// ran out of time keeps its number, so the figure after it does too.
		expect(live).toEqual([1, 2, null, null, 3, 4, null, 5, 6]);
		expect(diagramFigureNumbers(diagrams)).toEqual(live);
		expect(diagrams.map((diagram) => diagram.kind)).toEqual([
			"svg",
			"svg",
			"omitted",
			"omitted",
			"placeholder",
			"placeholder",
			"omitted",
			"placeholder",
			"svg",
		]);
		expect(warnings).toEqual([
			{ code: "DIAGRAM_PLACEHOLDER", count: 3 },
			{ code: "DIAGRAM_NOT_PRINTABLE", count: 3 },
		]);
	});
});
