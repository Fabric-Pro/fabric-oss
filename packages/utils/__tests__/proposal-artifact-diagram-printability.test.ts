/**
 * Which Proposal diagrams the export draws (Fizzy #2946): the export's
 * renderer, the editor's figure numbers and its "not in PDF" note read the
 * same rule, and both hand beautiful-mermaid a chart the same way.
 */

import { describe, expect, it } from "vitest";
import {
	type DiagramPrintability,
	diagramPrintability,
	figurePaletteOf,
	hasBrokenFlowchartHeader,
	isLiveFigureCounted,
	type LiveDiagramEngine,
	printableDiagramKind,
	printsAsDrawn,
	withoutLeadingChartComments,
} from "../lib/proposal-artifact/diagram-printability";
import { FIGURE_PALETTE_ROLES } from "../lib/proposal-artifact/proposal-figures";
import {
	buildProposalThemeTokens,
	resolveThemePaint,
} from "../lib/proposal-artifact/theme-tokens";

/** A layers figure: the template draws it, and so would beautiful-mermaid. */
const LAYERS_FIGURE =
	'%% figure: layers\nflowchart TB\n  subgraph data["Data"]\n    d1["Store"]\n  end';

/** A team figure, two subgraphs and the forum they share. */
const TEAM_FIGURE = [
	"%% figure: team",
	"flowchart LR",
	'  subgraph pod["Example Studio"]',
	'    p1["Engagement lead"]',
	"  end",
	'  subgraph client["Example Harbor Co"]',
	'    c1["Operations sponsor"]',
	"  end",
	'  r["Weekly review"]',
].join("\n");

/** A bar chart its template refuses: thirteen bars, one past its limit. */
const REFUSED_BARS = [
	"%% fabric-visual: k3v9q2m7x1a8c4d6",
	"%% figure: bars",
	"xychart-beta horizontal",
	`  x-axis [${Array.from({ length: 13 }, (_, index) => `c${index}`).join(", ")}]`,
	`  bar [${Array.from({ length: 13 }, (_, index) => index + 1).join(", ")}]`,
].join("\n");

describe("printableDiagramKind", () => {
	it.each([
		["flowchart TD\n  A --> B", "graph"],
		["%% fabric-visual: k3v9q2m7x1a8c4d6\ngraph LR\n  A --> B", "graph"],
		["stateDiagram-v2\n  [*] --> Draft", "graph"],
		["sequenceDiagram\n  A->>B: hi", "other"],
		["classDiagram\n  class Proposal", "other"],
		["erDiagram\n  CLIENT ||--o{ PROPOSAL : receives", "other"],
		["xychart-beta\n  bar [3, 5]", "other"],
		["XYCHART-BETA\n  bar [3, 5]", "other"],
		// beautiful-mermaid finds a chart on its first line only; the
		// export and the live page strip the `%%` lines before it.
		[REFUSED_BARS, "other"],
		["%%{init: {}}%%\n\n%% a note\nxychart\n  bar [3, 5]", "other"],
	])("draws %j as %s", (source, kind) => {
		expect(printableDiagramKind(source)).toBe(kind);
	});

	it.each([
		"gantt\n  title Plan",
		'pie\n  "A" : 40',
		"mindmap\n  root((Plan))",
		"timeline\n  2026 : Discovery",
		"---\ntitle: Plan\n---\nflowchart TD\n  A --> B",
		"graph\n  A --> B",
		"graph TD; A --> B",
		"%% notes\nsequenceDiagram\n  A->>B: hi",
		"%% notes\nclassDiagram\n  class Proposal",
		"%% notes\nerDiagram\n  CLIENT ||--o{ PROPOSAL : receives",
		"---\ntitle: Plan\n---\nxychart-beta\n  bar [3, 5]",
		"flowchart LRt0TD\n  A --> B",
		"",
	])("leaves %j to the live page", (source) => {
		expect(printableDiagramKind(source)).toBeNull();
	});
});

describe("diagramPrintability", () => {
	it.each([
		"flowchart TD\n  A --> B",
		"sequenceDiagram\n  A->>B: hi",
		"xychart-beta\n  bar [3, 5]",
		REFUSED_BARS,
		"%% figure: process\nflowchart TD\n  A --> B",
		LAYERS_FIGURE,
		TEAM_FIGURE,
	])("prints %j as drawn", (source) => {
		expect(diagramPrintability(source)).toBe("printable");
	});

	it.each([
		"gantt\n  title Plan",
		'pie\n  "A" : 40',
		"mindmap\n  root((Plan))",
		"timeline\n  2026 : Discovery",
		"journey\n  title Onboarding",
		"gitGraph\n  commit",
		"quadrantChart\n  title Reach",
		"requirementDiagram\n  requirement r1 {\n  }",
		"C4Context\n  title System",
		"C4Deployment\n  title Nodes",
		"sankey-beta\n  A,B,10",
		"block-beta\n  a b",
		"packet-beta\n  0-15: Port",
		"architecture-beta\n  service api(server)[API]",
		"kanban\n  Todo",
		"classDiagram-v2\n  class Proposal",
		"---\ntitle: Plan\n---\nflowchart TD\n  A --> B",
		"---\ntitle: Plan\n---\n%% notes\ngantt\n  title Plan",
		"graph\n  A --> B",
		"graph TD; A --> B",
		"%% notes\nsequenceDiagram\n  A->>B: hi",
		"---\ntitle: Plan\n---\nxychart-beta\n  bar [3, 5]",
		"%% figure: gantt\ngantt\n  title Plan",
	])(
		"prints %j, a kind only mermaid.js draws, as a placeholder",
		(source) => {
			expect(diagramPrintability(source)).toBe("liveOnly");
		},
	);

	it.each([
		"",
		"Discovery, then Build, then Launch.",
		"flowchrt TD\n  A --> B",
		"sequenceDiagramm\n  A->>B: hi",
		// mermaid.js's keywords are case-sensitive.
		"Gantt\n  title Plan",
		"flowchart LRt0TD\n  A --> B",
		"---\ntitle: Plan\n---\nflowchart LRt0TD\n  A --> B",
		"---\ntitle: Plan\n---\nPlain text",
		"%% only a comment",
	])("leaves %j, which no engine draws, out", (source) => {
		expect(diagramPrintability(source)).toBe("unknown");
	});
});

describe("withoutLeadingChartComments", () => {
	it("hands beautiful-mermaid a chart from its header, its own comments kept", () => {
		const chart = [
			"xychart-beta horizontal",
			"  x-axis [North, South]",
			"  %% a note",
			"  bar [1, 2]",
		].join("\n");
		expect(
			withoutLeadingChartComments(
				`%% fabric-visual: k3v9q2m7x1a8c4d6\n%% caption: Hours\n\n  %% figure: bars\n${chart}`,
			),
		).toBe(chart);
		expect(withoutLeadingChartComments(`%%{init: {}}%%\n${chart}`)).toBe(
			chart,
		);
	});

	it.each([
		"xychart-beta\n  bar [3, 5]",
		"%% notes\nsequenceDiagram\n  A->>B: hi",
		"%% figure: process\nflowchart TD\n  A --> B",
		LAYERS_FIGURE,
		TEAM_FIGURE,
		"%% figure: gantt\ngantt\n  title Plan",
		"---\ntitle: Plan\n---\nxychart-beta\n  bar [3, 5]",
		"%% only a comment",
		"",
	])("leaves %j as it is", (source) => {
		expect(withoutLeadingChartComments(source)).toBe(source);
	});
});

describe("isLiveFigureCounted and printsAsDrawn", () => {
	const cases: [
		DiagramPrintability,
		LiveDiagramEngine | null,
		{ counted: boolean; drawnInPrint: boolean | null },
	][] = [
		["printable", "template", { counted: true, drawnInPrint: true }],
		["unknown", "template", { counted: true, drawnInPrint: true }],
		[
			"printable",
			"beautiful-mermaid",
			{ counted: true, drawnInPrint: true },
		],
		// The export's beautiful-mermaid refuses it too: it is left out.
		["printable", "mermaid", { counted: false, drawnInPrint: false }],
		["printable", null, { counted: false, drawnInPrint: null }],
		// Print keeps a numbered placeholder, drawn live or not.
		["liveOnly", "mermaid", { counted: true, drawnInPrint: false }],
		[
			"liveOnly",
			"beautiful-mermaid",
			{ counted: true, drawnInPrint: false },
		],
		["liveOnly", null, { counted: true, drawnInPrint: null }],
		["unknown", "mermaid", { counted: false, drawnInPrint: false }],
		[
			"unknown",
			"beautiful-mermaid",
			{ counted: false, drawnInPrint: false },
		],
		["unknown", null, { counted: false, drawnInPrint: null }],
	];

	it.each(cases)(
		"%s drawn by %s",
		(printability, engine, { counted, drawnInPrint }) => {
			expect(isLiveFigureCounted(printability, engine)).toBe(counted);
			if (engine !== null) {
				expect(printsAsDrawn(printability, engine)).toBe(drawnInPrint);
			}
		},
	);
});

describe("hasBrokenFlowchartHeader", () => {
	it("marks a flowchart header whose direction is not one", () => {
		expect(hasBrokenFlowchartHeader("flowchart LRt0TD\n  A --> B")).toBe(
			true,
		);
		expect(hasBrokenFlowchartHeader("%% note\ngraph XY\n  A --> B")).toBe(
			true,
		);
	});

	it.each([
		"flowchart TD\n  A --> B",
		"graph\n  A --> B",
		"graph TD; A --> B",
		"gantt\n  title Plan",
		"",
	])("does not mark %j", (source) => {
		expect(hasBrokenFlowchartHeader(source)).toBe(false);
	});
});

describe("figurePaletteOf", () => {
	it("fills every template role from the paint", () => {
		const paint = resolveThemePaint(
			buildProposalThemeTokens({
				organization: null,
				style: { primaryColor: "#1f3a6b", accentColors: [] },
				brandKit: null,
				recipient: null,
			}),
		);
		const palette = figurePaletteOf(paint);
		for (const role of FIGURE_PALETTE_ROLES) {
			expect(palette[role]).toBe(paint[role]);
		}
	});
});
