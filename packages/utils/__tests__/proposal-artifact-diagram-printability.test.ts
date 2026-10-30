/**
 * Which Proposal diagrams the export draws (Fizzy #2946): the export's
 * renderer, the editor's figure numbers and its "not in PDF" note read the
 * same rule.
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
} from "../lib/proposal-artifact/diagram-printability";
import { FIGURE_PALETTE_ROLES } from "../lib/proposal-artifact/proposal-figures";
import {
	buildProposalThemeTokens,
	resolveThemePaint,
} from "../lib/proposal-artifact/theme-tokens";

describe("printableDiagramKind", () => {
	it.each([
		["flowchart TD\n  A --> B", "graph"],
		["%% fabric-visual: k3v9q2m7x1a8c4d6\ngraph LR\n  A --> B", "graph"],
		["stateDiagram-v2\n  [*] --> Draft", "graph"],
		["sequenceDiagram\n  A->>B: hi", "other"],
		["classDiagram\n  class Proposal", "other"],
		["erDiagram\n  CLIENT ||--o{ PROPOSAL : receives", "other"],
		["xychart-beta\n  bar [3, 5]", "other"],
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
