/**
 * Figure numbers on the live page and in the exports (Fizzy #2946): the same
 * fences, in the same order, take the same "Figure n." on the live page as
 * in the PDF and the DOCX, so prose that cites a figure points at it in all
 * three.
 *
 * The live side is the page's own rule (`isLiveFigureCounted`) fed what the
 * page's engines do with each fence: its figure template, else
 * beautiful-mermaid on the fence with the role classes appended and, for a
 * chart, its leading `%%` lines stripped, else mermaid.js. mermaid.js
 * needs a browser; whether it draws a fence never
 * changes the number, which the test checks for every fence. The export
 * side is `renderExportDiagrams` and `diagramFigureNumbers`. beautiful-mermaid
 * runs for real on both sides, but refuses a fence marked as below, as no
 * real fence of a kind it takes is refused. The export's layout also runs
 * out of time on a fence marked as below, which the live page draws as any
 * other.
 *
 * A plain chain of seven steps or more with no figure line draws from the
 * process template on all three, and a shorter one with the engine; the
 * same fences in a Main get the same "Figure n." and caption on the page,
 * in the PDF and in the DOCX.
 */

import {
	diagramPrintability,
	figurePaletteOf,
	isLiveFigureCounted,
	type LiveDiagramEngine,
	withoutLeadingChartComments,
} from "@repo/utils/proposal-artifact/diagram-printability";
import { tryRenderFigure } from "@repo/utils/proposal-artifact/proposal-figures";
import {
	buildProposalThemeTokens,
	resolveThemePaint,
	withVisualRoleClassDefs,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { readDiagramCaption } from "@repo/utils/proposal-artifact/visual-identity";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { buildProposalDocx } from "../../../lib/proposal-export/build-docx";
import { buildThemeHtml } from "../../../lib/proposal-export/build-theme-html";
import type { DiagramLayout } from "../../../lib/proposal-export/diagram-layout";
import {
	exportDiagramCaptions,
	prepareExportMarkdown,
} from "../../../lib/proposal-export/markdown";
import {
	diagramFigureNumbers,
	type ExportThemeTokens,
} from "../../../lib/proposal-export/types";
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

const tokens = buildProposalThemeTokens({
	organization: null,
	style: { primaryColor: "#1f3a6b", accentColors: [] },
	brandKit: null,
	recipient: null,
});

const paint = resolveThemePaint(tokens);

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

/** A plan the gantt template draws. */
const GANTT_TEMPLATE = [
	"%% figure: gantt",
	"gantt",
	"  title Pilot schedule",
	"  dateFormat YYYY-MM-DD",
	"  section Build",
	"  Routing :a1, 2026-11-02, 3w",
	"  section Pilot",
	"  Region one :b1, after a1, 4w",
	"  Pilot review :milestone, m1, 2026-12-21, 0d",
].join("\n");

/** Thirteen bars, one past the bars template's limit. */
const THIRTEEN_BARS = [
	"%% figure: bars",
	"xychart-beta horizontal",
	`  x-axis [${Array.from({ length: 13 }, (_, index) => `c${index}`).join(", ")}]`,
	`  bar [${Array.from({ length: 13 }, (_, index) => index + 1).join(", ")}]`,
].join("\n");

/** Architecture layers the layers template draws. */
const LAYERS_TEMPLATE = [
	"%% figure: layers",
	"flowchart TB",
	'subgraph experience["Experience<br/>who uses it"]',
	'  e1["Crew app"]',
	'  e2["Dispatcher console"]',
	"end",
	'subgraph services["Services"]',
	'  s1["Routing"]',
	'  s2["Work orders"]',
	"end",
	'subgraph crosscutting["Cross-cutting"]',
	'  x1["Identity"]',
	"end",
].join("\n");

/** Two teams and the forum they share, as the team template draws them. */
const TEAM_TEMPLATE = [
	"%% figure: team",
	"flowchart LR",
	'subgraph pod["Example Studio pod"]',
	'  p1["Engagement lead<br/>Owns scope and the weekly review"]',
	'  p2["Senior engineer"]',
	"end",
	'subgraph client["Example Harbor Co"]',
	'  c1["Operations sponsor<br/>Approves milestones"]',
	"end",
	'r["Weekly review"]',
	"p1 --> r",
	"c1 --> r",
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
	[
		"a bar chart template",
		[
			"%% figure: bars",
			"xychart-beta horizontal",
			'  x-axis ["Expected · 5% uplift", Baseline]',
			"  bar [12, 4]",
			"  line [10, 10]",
		].join("\n"),
	],
	[
		// Two bar series: the template refuses it, beautiful-mermaid draws
		// it as a plain chart.
		"a bar chart its template refuses",
		[
			"%% figure: bars",
			"xychart-beta horizontal",
			"  x-axis [North, South]",
			"  bar [1, 2]",
			"  bar [3, 4]",
		].join("\n"),
	],
	["thirteen bars, past the bars template", THIRTEEN_BARS],
	[
		"a sequence diagram after a comment",
		"%% notes\nsequenceDiagram\n  A->>B: hi",
	],
	["a gantt chart its template draws", GANTT_TEMPLATE],
	[
		"a gantt chart its template refuses",
		GANTT_TEMPLATE.replace(
			"  section Build",
			"  excludes weekends\n  section Build",
		),
	],
	["a layers figure its template draws", LAYERS_TEMPLATE],
	["a team figure its template draws", TEAM_TEMPLATE],
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
		renderMermaidSVG(
			withoutLeadingChartComments(
				withVisualRoleClassDefs(source, paint).trim(),
			),
			{},
		);
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
		expect(live).toEqual([
			1,
			2,
			null,
			null,
			3,
			4,
			null,
			5,
			6,
			7,
			8,
			9,
			10,
			11,
			12,
			13,
			14,
		]);
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
			"svg",
			"svg",
			"svg",
			"placeholder",
			"svg",
			"placeholder",
			"svg",
			"svg",
		]);
		expect(warnings).toEqual([
			{ code: "DIAGRAM_PLACEHOLDER", count: 3 },
			{ code: "DIAGRAM_NOT_PRINTABLE", count: 5 },
		]);
	});

	it("match for a bar chart its template draws and for ones it refuses", async () => {
		const source = (name: string) =>
			FENCES.find(([fence]) => fence === name)?.[1] ?? "";
		const drawnBars = source("a bar chart template");
		const refused = [
			source("a bar chart its template refuses"),
			source("thirteen bars, past the bars template"),
		];
		expect(await liveEngine(drawnBars)).toBe("template");
		// A refused bar chart opens with `%%` lines, which beautiful-mermaid
		// finds no chart behind; the live page strips them, as the export
		// does, so the chart draws and prints alike.
		for (const refusedBars of refused) {
			expect(await liveEngine(refusedBars)).toBe("beautiful-mermaid");
			const printability = diagramPrintability(refusedBars.trim());
			expect(printability).toBe("printable");
			expect(isLiveFigureCounted(printability, "beautiful-mermaid")).toBe(
				true,
			);
		}

		const { diagrams, warnings } = await renderExportDiagrams({
			sources: [drawnBars, ...refused],
			paint,
			browser: null,
			withPng: false,
			deadline: Date.now() + 60_000,
			layout: inProcessLayout,
		});
		expect(diagrams.map((diagram) => diagram.kind)).toEqual([
			"svg",
			"svg",
			"svg",
		]);
		expect(diagramFigureNumbers(diagrams)).toEqual([1, 2, 3]);
		expect(warnings).toEqual([]);
		// The template draws the first; beautiful-mermaid the others.
		const svgs = diagrams.map((diagram) =>
			diagram.kind === "svg" ? diagram.svg : "",
		);
		expect(svgs[0]).toContain('role="img"');
		for (const svg of svgs.slice(1)) {
			expect(svg).not.toContain('role="img"');
			expect(svg).toContain("xychart");
		}
	});

	it("match for layers and team figures their templates draw and a team one refuses", async () => {
		// A team figure needs two subgraphs; with one, the template refuses
		// it and beautiful-mermaid draws the fence as a flowchart.
		const refusedTeam = TEAM_TEMPLATE.replace(
			/subgraph client[\s\S]*?end\n/,
			"",
		).replace("c1 --> r", "p2 --> r");
		expect(refusedTeam).not.toContain("subgraph client");
		expect(await liveEngine(LAYERS_TEMPLATE)).toBe("template");
		expect(await liveEngine(TEAM_TEMPLATE)).toBe("template");
		expect(await liveEngine(refusedTeam)).toBe("beautiful-mermaid");
		for (const source of [LAYERS_TEMPLATE, TEAM_TEMPLATE, refusedTeam]) {
			expect(diagramPrintability(source.trim())).toBe("printable");
		}

		const { diagrams, warnings } = await renderExportDiagrams({
			sources: [LAYERS_TEMPLATE, TEAM_TEMPLATE, refusedTeam],
			paint,
			browser: null,
			withPng: false,
			deadline: Date.now() + 60_000,
			layout: inProcessLayout,
		});
		expect(diagrams.map((diagram) => diagram.kind)).toEqual([
			"svg",
			"svg",
			"svg",
		]);
		expect(diagramFigureNumbers(diagrams)).toEqual([1, 2, 3]);
		expect(warnings).toEqual([]);
		// The templates draw the first two; beautiful-mermaid the third.
		const svgs = diagrams.map((diagram) =>
			diagram.kind === "svg" ? diagram.svg : "",
		);
		expect(svgs[0]).toContain('role="img"');
		expect(svgs[1]).toContain('role="img"');
		expect(svgs[2]).not.toContain('role="img"');
	});

	it("match, with their captions, for a plain chain of seven steps the process template draws and one of six the engine draws", async () => {
		const chain = (steps: number, caption: string) =>
			[
				"```mermaid",
				`%% caption: ${caption}`,
				"flowchart TD",
				...Array.from(
					{ length: steps - 1 },
					(_, index) =>
						`  s${index}["Step ${index + 1}"] --> s${index + 1}["Step ${index + 2}"]`,
				),
				"```",
			].join("\n");
		const fences = [
			chain(7, "Every step a request takes"),
			chain(6, "The short way round"),
		];
		const markdown = [
			"## How a request moves",
			fences[0],
			"Then the short way.",
			fences[1],
		].join("\n\n");

		// The live page: what each fence draws with, its number and caption.
		const bodies = fences.map((fence) =>
			fence.split("\n").slice(1, -1).join("\n"),
		);
		const live: {
			engine: LiveDiagramEngine | null;
			caption: string | null;
		}[] = [];
		for (const body of bodies) {
			live.push({
				engine: await liveEngine(body),
				caption: readDiagramCaption(body),
			});
		}
		expect(live).toEqual([
			{ engine: "template", caption: "Every step a request takes" },
			{ engine: "beautiful-mermaid", caption: "The short way round" },
		]);
		let next = 0;
		const liveNumbers = bodies.map((body, index) =>
			isLiveFigureCounted(
				diagramPrintability(body.trim()),
				live[index]?.engine ?? null,
			)
				? ++next
				: null,
		);
		expect(liveNumbers).toEqual([1, 2]);

		// The exports draw the same fences the same way, under the same
		// numbers and captions.
		const prepared = prepareExportMarkdown(markdown);
		const captions = exportDiagramCaptions(prepared);
		expect(captions).toEqual(live.map(({ caption }) => caption));
		const { diagrams, warnings } = await renderExportDiagrams({
			sources: prepared.diagramSources,
			captions,
			paint,
			browser: null,
			withPng: false,
			deadline: Date.now() + 60_000,
			layout: inProcessLayout,
		});
		expect(warnings).toEqual([]);
		expect(diagramFigureNumbers(diagrams)).toEqual(liveNumbers);
		const svgs = diagrams.map((diagram) =>
			diagram.kind === "svg" ? diagram.svg : "",
		);
		expect(svgs[0]).toContain('role="img"');
		expect(svgs[0]).toContain("<title>Every step a request takes</title>");
		expect(svgs[1]).not.toContain('role="img"');

		const exportInput = {
			prepared,
			diagrams,
			images: new Map(),
			tokens: tokens as unknown as ExportThemeTokens,
			projectId: "project-example-1",
			documentId: "document-example-1",
			title: "Example Proposal",
			dateLabel: "October 15, 2026",
		};
		const { html } = buildThemeHtml({
			...exportInput,
			pass: { kind: "final", pageNumbers: new Map() },
		});
		const printedCaptions = Array.from(
			html.matchAll(
				/<figcaption[^>]*><span[^>]*>(Figure \d+\.)<\/span> ([^<]*)<\/figcaption>/g,
			),
			(match) => `${match[1]} ${match[2]}`,
		);
		const expected = [
			"Figure 1. Every step a request takes",
			"Figure 2. The short way round",
		];
		expect(printedCaptions).toEqual(expected);

		// Without a browser the Word file has no pictures, and writes each
		// figure's placeholder under the same number and caption.
		const docx = await buildProposalDocx(exportInput);
		const documentXml =
			(await (
				await JSZip.loadAsync(docx.buffer)
			)
				.file("word/document.xml")
				?.async("string")) ?? "";
		const wordText = Array.from(
			documentXml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g),
			(match) => match[1],
		).join("");
		for (const caption of expected) {
			expect(wordText).toContain(caption);
		}
		expect(wordText).not.toContain("Figure 3.");
	});

	it("match for a gantt chart its template draws and for one it refuses", async () => {
		const drawn = GANTT_TEMPLATE;
		const refused = FENCES.find(
			([name]) => name === "a gantt chart its template refuses",
		)?.[1];
		if (!refused) {
			throw new Error("expected the refused gantt fence");
		}
		expect(await liveEngine(drawn)).toBe("template");
		// A refused gantt is a kind only mermaid.js draws: a numbered
		// placeholder in print, as before it had a template.
		expect(await liveEngine(refused)).toBeNull();
		expect(diagramPrintability(refused.trim())).toBe("liveOnly");
		expect(isLiveFigureCounted("liveOnly", "mermaid")).toBe(true);

		const { diagrams, warnings } = await renderExportDiagrams({
			sources: [drawn, refused],
			paint,
			browser: null,
			withPng: false,
			deadline: Date.now() + 60_000,
			layout: inProcessLayout,
		});
		expect(diagrams.map((diagram) => diagram.kind)).toEqual([
			"svg",
			"placeholder",
		]);
		expect(diagramFigureNumbers(diagrams)).toEqual([1, 2]);
		expect(warnings).toEqual([{ code: "DIAGRAM_NOT_PRINTABLE", count: 1 }]);
	});
});
