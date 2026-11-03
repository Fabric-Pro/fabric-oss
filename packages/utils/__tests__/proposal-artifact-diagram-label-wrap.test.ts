/**
 * A flowchart's long node labels broken into lines and a sideways flowchart
 * turned top-down (Fizzy #2946), as the live page draws them and as the
 * Proposal export's print legibility rule does. Pure string work: the
 * engine is not drawn here.
 */

import { describe, expect, it } from "vitest";
import {
	flowchartNodeLabelsOverflow,
	legibleFigureMaxHeightPx,
	nodeLabelLineOverflows,
	PRINT_COLUMN_PX,
	PRINT_FIGURE_MAX_HEIGHT_PX,
	PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX,
	PRINT_LABEL_FLOOR_PT,
	printedNodeLabelPt,
	printsBetter,
	turnFlowchartTopDown,
	wrapFlowchartNodeLabels,
} from "../lib/proposal-artifact/diagram-label-wrap";

/** Four stages, each label a title, a sentence and a note on one line. */
const STAGES = [
	{
		title: "Scope alignment",
		sentence:
			"Select the example workflow, its stakeholders, the success measures and the pilot sites",
		note: "(Agreed pilot boundaries and the validation criteria)",
	},
	{
		title: "Data preparation",
		sentence:
			"Collect the sample records, map the source fields and clean the reference data with owners",
		note: "(A reviewed data set ready for the first pilot run)",
	},
	{
		title: "Pilot delivery",
		sentence:
			"Configure the agreed scope, run the pilot with example users and record every open question",
		note: "(A working pilot and a list of the open questions)",
	},
	{
		title: "Outcome review",
		sentence:
			"Assess the pilot against the agreed measures and decide the next phase with the sponsors",
		note: "(A written recommendation for the next delivery phase)",
	},
];
const STAGE_LABELS = STAGES.map(
	({ title, sentence, note }) => `${title} — ${sentence} ${note}`,
);
const LONG_CHAIN = [
	"flowchart LR",
	...STAGE_LABELS.map((label, index) => `  n${index}["${label}"]`),
	"  n0 --> n1",
	"  n1 --> n2",
	"  n2 --> n3",
].join("\n");

/** A generated fence's marker and caption lines, before its header. */
const LEADING_COMMENTS = [
	"%% fabric-visual: k3v9q2m7x1a8c4d6",
	"%% caption: How the example pilot runs",
];

/**
 * Labels under 40 characters dense in dashes, m, w and hyphens, which Inter
 * draws wider than beautiful-mermaid's estimate by more than the room their
 * boxes keep.
 */
const DENSE_LABELS = [
	"Momentum — minimum-time multi-team flow",
	"Mid-term metrics — maximum momentum",
	"multi-team time-to-market — momentum",
] as const;

/** Prose labels of 35 to 39 characters, which fit their boxes. */
const ORDINARY_LABELS = [
	"Discovery workshop with the client team",
	"Review the proposal with stakeholders",
	"Configure and validate the agreed scope",
	"Weekly status reviews with sponsors",
	"Map the current reporting landscape",
] as const;

/** A label of exactly `length` characters, words of five letters apart. */
function labelOf(length: number): string {
	const words: string[] = [];
	while (words.join(" ").length < length) {
		words.push("plans");
	}
	return words.join(" ").slice(0, length).trimEnd().padEnd(length, "x");
}

/**
 * The `<br/>`-separated lines of the quoted label of the node `id` on the
 * line that starts with it.
 */
function labelLines(source: string, id: string): string[] | undefined {
	const line = source
		.split("\n")
		.find((candidate) => candidate.trim().startsWith(`${id}[`));
	return /^\s*[\w-]+\["(.*?)"\]/.exec(line ?? "")?.[1]?.split("<br/>");
}

/** A size in CSS pixels. */
function sized(width: number, height: number) {
	return { width, height };
}

describe("the print column, a figure's height and the label floor", () => {
	it("measures the print column as the portrait page less its side margins", () => {
		expect(PRINT_COLUMN_PX).toBeCloseTo((8.5 - 2 * 0.8) * 96, 5);
		expect(printedNodeLabelPt(sized(PRINT_COLUMN_PX, 100))).toBeCloseTo(
			9.75,
			5,
		);
	});

	it("measures a figure's height as the portrait page's text height less an inch for its caption", () => {
		expect(PRINT_FIGURE_MAX_HEIGHT_PX).toBeCloseTo(
			(11 - 0.85 - 0.9 - 1) * 96,
			5,
		);
		expect(printedNodeLabelPt(sized(200, PRINT_FIGURE_MAX_HEIGHT_PX))).toBe(
			9.75,
		);
	});

	it("never prints labels larger than their own size, and shrinks a wider diagram's with it", () => {
		expect(printedNodeLabelPt(sized(200, 100))).toBeCloseTo(9.75, 5);
		expect(printedNodeLabelPt(sized(PRINT_COLUMN_PX * 2, 100))).toBeCloseTo(
			4.875,
			5,
		);
		expect(PRINT_LABEL_FLOOR_PT).toBe(9);
		// The widest diagram whose labels still print at the floor.
		expect(
			printedNodeLabelPt(
				sized((PRINT_COLUMN_PX * 9.75) / PRINT_LABEL_FLOOR_PT, 100),
			),
		).toBeCloseTo(PRINT_LABEL_FLOOR_PT, 5);
	});

	it("shrinks a taller diagram's labels by its height, whichever edge shrinks it more", () => {
		expect(
			printedNodeLabelPt(sized(200, PRINT_FIGURE_MAX_HEIGHT_PX * 2)),
		).toBeCloseTo(4.875, 5);
		// The tallest diagram whose labels still print at the floor.
		expect(
			printedNodeLabelPt(
				sized(
					200,
					(PRINT_FIGURE_MAX_HEIGHT_PX * 9.75) / PRINT_LABEL_FLOOR_PT,
				),
			),
		).toBeCloseTo(PRINT_LABEL_FLOOR_PT, 5);
		// Twice too wide and four times too tall: the height decides.
		expect(
			printedNodeLabelPt(
				sized(PRINT_COLUMN_PX * 2, PRINT_FIGURE_MAX_HEIGHT_PX * 4),
			),
		).toBeCloseTo(9.75 / 4, 5);
	});

	it("measures a figure right under a section opener against the shorter height print gives it there", () => {
		expect(PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX).toBeCloseTo(
			(11 - 0.85 - 0.9 - 1 - 2) * 96,
			5,
		);
		expect(
			printedNodeLabelPt(
				sized(200, PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX),
				PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX,
			),
		).toBe(9.75);
		// A drawing 735 px tall prints at full size in a figure of its own
		// and below the floor right under an opener.
		expect(printedNodeLabelPt(sized(200, 735))).toBe(9.75);
		expect(
			printedNodeLabelPt(
				sized(200, 735),
				PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX,
			),
		).toBeCloseTo((9.75 * 600) / 735, 5);
		expect(
			printedNodeLabelPt(
				sized(200, 735),
				PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX,
			),
		).toBeLessThan(PRINT_LABEL_FLOOR_PT);
	});

	it("keeps the height an opener's page offers a drawing only while its labels print at the floor there", () => {
		const under = PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX;
		const own = PRINT_FIGURE_MAX_HEIGHT_PX;
		// Labels reach the floor at 9 / 9.75 of a drawing's height: a
		// drawing 650 px tall stays legible at 600 px, one 651 px does not.
		const floorShare = PRINT_LABEL_FLOOR_PT / 9.75;
		expect(legibleFigureMaxHeightPx(under, sized(200, 300))).toBe(under);
		expect(
			legibleFigureMaxHeightPx(under, sized(200, under / floorShare)),
		).toBe(under);
		expect(legibleFigureMaxHeightPx(under, sized(200, 651))).toBe(own);
		expect(legibleFigureMaxHeightPx(454, sized(200, 480))).toBe(454);
		expect(legibleFigureMaxHeightPx(454, sized(200, 565))).toBe(own);
		// At its own height a figure keeps it, legible or not: it has no
		// further page to move to.
		expect(legibleFigureMaxHeightPx(own, sized(200, own * 2))).toBe(own);
		// A drawing wider than the column that prints below the floor at any
		// height keeps a figure's own height too.
		expect(
			legibleFigureMaxHeightPx(under, sized(PRINT_COLUMN_PX * 2, 300)),
		).toBe(own);
	});

	it("never shrinks a figure template's 12 px text under an opener", () => {
		const under = PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX;
		const own = PRINT_FIGURE_MAX_HEIGHT_PX;
		// The template's text is at the floor at full size, so it keeps a
		// reduced height only when it is no taller.
		expect(legibleFigureMaxHeightPx(under, sized(662, 504), 12)).toBe(
			under,
		);
		expect(legibleFigureMaxHeightPx(under, sized(662, under), 12)).toBe(
			under,
		);
		expect(legibleFigureMaxHeightPx(454, sized(662, 504), 12)).toBe(own);
		expect(legibleFigureMaxHeightPx(under, sized(662, under + 1), 12)).toBe(
			own,
		);
	});
});

describe("which laid-out copy of a fence is drawn", () => {
	it("finds a node label too wide for its box in a flowchart's copy, and none once it is broken", () => {
		const source = [
			"flowchart LR",
			`  a["${ORDINARY_LABELS[0]}"] --> b["${DENSE_LABELS[0]}"]`,
			`  b --> c[${ORDINARY_LABELS[1]}]`,
		].join("\n");
		expect(flowchartNodeLabelsOverflow(source)).toBe(true);
		const broken = String(
			wrapFlowchartNodeLabels(source, { overflowingOnly: true }),
		);
		expect(flowchartNodeLabelsOverflow(broken)).toBe(false);
		expect(
			flowchartNodeLabelsOverflow(
				`flowchart TD\n  a["${ORDINARY_LABELS[0]}"] --> b[Done]`,
			),
		).toBe(false);
	});

	it("measures each line of a broken label in the box its widest line sets", () => {
		const dense = DENSE_LABELS[0];
		expect(nodeLabelLineOverflows(dense)).toBe(true);
		expect(
			flowchartNodeLabelsOverflow(
				`flowchart TD\n  a["Plan<br/>${dense}"]`,
			),
		).toBe(true);
		// Under a longer line of prose the box is wide enough for it.
		const prose = "Discovery workshop with the client team and the owners";
		expect(nodeLabelLineOverflows(prose)).toBe(false);
		expect(
			flowchartNodeLabelsOverflow(
				`flowchart TD\n  a["${prose}<br/>${dense}"]`,
			),
		).toBe(false);
	});

	it("reads only node labels, and only in a flowchart", () => {
		const dense = DENSE_LABELS[0];
		expect(
			flowchartNodeLabelsOverflow(
				[
					`%% ${dense}`,
					"flowchart TD",
					`  %% ${dense}`,
					`  subgraph s1 ["${dense}"]`,
					`    a -->|${dense}| b`,
					"  end",
					"  classDef c1 fill:#fff",
				].join("\n"),
			),
		).toBe(false);
		expect(
			flowchartNodeLabelsOverflow(`stateDiagram-v2\n  s1 : ${dense}`),
		).toBe(false);
	});

	it("draws a copy whose labels fit their boxes over one whose labels spill, however large either prints", () => {
		const fits = { labelPt: 7.33, labelsOverflow: false };
		const spills = { labelPt: 9.75, labelsOverflow: true };
		expect(printsBetter(fits, spills)).toBe(true);
		expect(printsBetter(spills, fits)).toBe(false);
		expect(printsBetter(spills, fits, { winsTie: true })).toBe(false);
		// Its size unknown, a copy that fits still wins on the fit alone.
		expect(printsBetter({ ...fits, labelPt: null }, spills)).toBe(true);
	});

	it("draws the copy whose labels print larger among copies that all fit, or all spill, a tie going to the candidate only when told", () => {
		for (const labelsOverflow of [false, true]) {
			const larger = { labelPt: 9.75, labelsOverflow };
			const smaller = { labelPt: 8.42, labelsOverflow };
			expect(printsBetter(larger, smaller)).toBe(true);
			expect(printsBetter(smaller, larger)).toBe(false);
			expect(printsBetter(smaller, larger, { winsTie: true })).toBe(
				false,
			);
			expect(printsBetter(larger, { ...larger })).toBe(false);
			expect(printsBetter(larger, { ...larger }, { winsTie: true })).toBe(
				true,
			);
			// A size that is not known never wins on size.
			expect(printsBetter({ ...larger, labelPt: null }, smaller)).toBe(
				false,
			);
			expect(printsBetter(larger, { ...smaller, labelPt: null })).toBe(
				false,
			);
		}
	});
});

describe("turnFlowchartTopDown", () => {
	it("turns a sideways header top-down and changes no other line", () => {
		const turned = turnFlowchartTopDown(LONG_CHAIN);
		expect(turned?.split("\n")[0]).toBe("flowchart TD");
		expect(turned?.split("\n").slice(1)).toEqual(
			LONG_CHAIN.split("\n").slice(1),
		);
	});

	it.each([
		["flowchart RL", "flowchart TD"],
		["graph LR", "graph TD"],
		["  Flowchart lr  ", "  Flowchart TD  "],
	])("turns %j into %j", (header, expected) => {
		expect(turnFlowchartTopDown(`${header}\n  a --> b`)).toBe(
			`${expected}\n  a --> b`,
		);
	});

	it.each([
		"flowchart TD\n  a --> b",
		"graph BT\n  a --> b",
		"stateDiagram-v2\n  [*] --> Draft",
		"xychart-beta\n  x-axis [Q1, Q2]\n  bar [3, 5]",
		"sequenceDiagram\n  A->>B: hi",
		"%% fabric-visual: k3v9q2m7x1a8c4d6",
		"",
	])("leaves %j as it is", (source) => {
		expect(turnFlowchartTopDown(source)).toBeNull();
	});

	it("turns the header after a generated fence's leading comment lines, which stay", () => {
		const source = [...LEADING_COMMENTS, "flowchart LR", "  a --> b"].join(
			"\n",
		);
		expect(turnFlowchartTopDown(source)).toBe(
			[...LEADING_COMMENTS, "flowchart TD", "  a --> b"].join("\n"),
		);
	});

	it("turns once: a turned source has nothing left to turn", () => {
		const turned = turnFlowchartTopDown(LONG_CHAIN);
		expect(turned).not.toBeNull();
		expect(turnFlowchartTopDown(String(turned))).toBeNull();
	});
});

describe("wrapFlowchartNodeLabels", () => {
	it("breaks labels of 130 and more characters, title, sentence and note apart, every word kept", () => {
		for (const { sentence, note } of STAGES) {
			expect(sentence.length).toBeGreaterThanOrEqual(85);
			expect(note.length).toBeGreaterThanOrEqual(48);
		}
		const broken = String(wrapFlowchartNodeLabels(LONG_CHAIN));
		expect(broken.split("\n")[0]).toBe("flowchart LR");
		for (const [index, { title, note }] of STAGES.entries()) {
			const lines = labelLines(broken, `n${index}`);
			expect(lines?.[0]).toBe(`${title} —`);
			expect(lines?.at(-1)?.endsWith(")")).toBe(true);
			expect(lines?.filter((line) => line.startsWith("("))).toHaveLength(
				1,
			);
			expect(lines?.join(" ")).toBe(STAGE_LABELS[index]);
			expect(lines?.join(" ")).toContain(note);
			for (const line of lines ?? []) {
				expect(Array.from(line).length).toBeLessThanOrEqual(30);
			}
		}
		for (const word of STAGE_LABELS.join(" ").split(" ")) {
			expect(broken).toContain(word);
		}
		expect(broken).not.toContain("…");
		// The edges are not labels.
		expect(broken).toContain("  n0 --> n1");
	});

	it("leaves a label that already has line breaks, and one it cannot read safely, as written", () => {
		const brokenAlready = `Already broken<br/>${STAGE_LABELS[0]}`;
		const formatted = `**Formatted** ${STAGE_LABELS[1]}`;
		const source = [
			"flowchart LR",
			`  a["${brokenAlready}"] --> b["${formatted}"]`,
			`  b --> c["${STAGE_LABELS[2]}"]`,
		].join("\n");
		const broken = String(wrapFlowchartNodeLabels(source));
		expect(broken).toContain(`a["${brokenAlready}"]`);
		expect(broken).toContain(`b["${formatted}"]`);
		expect(broken).not.toContain(`c["${STAGE_LABELS[2]}"]`);
		expect(broken).toContain("Pilot delivery —<br/>");
	});

	it.each([
		[
			"`code`",
			"a label with `code` in it and far more words than one line holds",
		],
		[
			"~~struck~~",
			"a label with ~~struck~~ words and far more words than one line",
		],
		[
			"\\n",
			"a label with a \\n break and far more words than one line holds",
		],
		[
			"<b>",
			"a label with <b>bold</b> words and far more words than one line",
		],
	])("leaves a label carrying %s as written", (_mark, label) => {
		expect(
			wrapFlowchartNodeLabels(`flowchart TD\n  a["${label}"] --> b`),
		).toBeNull();
	});

	it("breaks labels of every common shape, quoted or not", () => {
		const label = STAGE_LABELS[3] ?? "";
		const bare = label.replace(/[()]/g, "");
		const source = [
			"flowchart TD",
			`  a[${label}] --> b(${bare})`,
			`  b --> c{${bare}}`,
			`  c --> d(["${label}"])`,
			`  d --> e[["${label}"]] & f{{"${label}"}}`,
			"  e -- yes --> g[Short label]",
		].join("\n");
		const broken = String(wrapFlowchartNodeLabels(source));
		expect(broken.match(/Outcome review —<br\/>/g)).toHaveLength(6);
		expect(broken).toContain("g[Short label]");
		expect(broken).toContain("e -- yes --> g");
	});

	it.each([
		["doublecircle", (text: string) => `a(((${text})))`],
		["stadium", (text: string) => `a([${text}])`],
		["circle", (text: string) => `a((${text}))`],
		["subroutine", (text: string) => `a[[${text}]]`],
		["cylinder", (text: string) => `a[(${text})]`],
		["trapezoid", (text: string) => `a[/${text}\\]`],
		["trapezoid-alt", (text: string) => `a[\\${text}/]`],
		["asymmetric", (text: string) => `a>${text}]`],
		["hexagon", (text: string) => `a{{${text}}}`],
		["rectangle", (text: string) => `a[${text}]`],
		["rounded", (text: string) => `a(${text})`],
		["diamond", (text: string) => `a{${text}}`],
	])("breaks a %s node's label in its own delimiters", (_shape, node) => {
		const text =
			"Example review — Confirm the agreed scope with every example sponsor";
		const broken = wrapFlowchartNodeLabels(`flowchart TD\n  ${node(text)}`);
		expect(broken).toBe(
			`flowchart TD\n  ${node(
				"Example review —<br/>Confirm the agreed scope with<br/>every example sponsor",
			)}`,
		);
	});

	it("breaks every node of an `&` group, on both sides of an arrow", () => {
		const label = STAGE_LABELS[0] ?? "";
		const source = `flowchart LR\n  a["${label}"] & b["${label}"] --> c["${label}"] & d`;
		const broken = String(wrapFlowchartNodeLabels(source));
		expect(broken.match(/Scope alignment —<br\/>/g)).toHaveLength(3);
		expect(broken).toMatch(/"\] & b\["/);
		expect(broken).toMatch(/"\] --> c\["/);
		expect(broken.endsWith('"] & d')).toBe(true);
	});

	it.each([
		[
			"a piped label",
			(from: string, to: string) => `${from} -->|yes| ${to}`,
		],
		[
			"a text label",
			(from: string, to: string) => `${from} -- when agreed --> ${to}`,
		],
		["a dotted arrow", (from: string, to: string) => `${from} -.-> ${to}`],
		["a thick arrow", (from: string, to: string) => `${from} ==> ${to}`],
		["an open link", (from: string, to: string) => `${from} --- ${to}`],
		["a two-way arrow", (from: string, to: string) => `${from} <--> ${to}`],
	])(
		"breaks the nodes on both ends of %s and keeps the arrow",
		(_kind, edge) => {
			const label = STAGE_LABELS[1] ?? "";
			const source = `flowchart TD\n  ${edge(`a["${label}"]`, `b["${label}"]`)}`;
			const broken = String(wrapFlowchartNodeLabels(source));
			expect(broken.match(/Data preparation —<br\/>/g)).toHaveLength(2);
			const lines = labelLines(broken, "a");
			expect(lines?.join(" ")).toBe(label);
			// The arrow, with its own label, stays between the two nodes.
			const arrow = edge("", "").trim();
			expect(broken).toContain(`"] ${arrow} b["`);
		},
	);

	it("keeps a node's class shorthand after its broken label", () => {
		const label = STAGE_LABELS[2] ?? "";
		const broken = String(
			wrapFlowchartNodeLabels(
				`flowchart TD\n  a["${label}"]:::surface --> b["${label}"]`,
			),
		);
		expect(broken).toMatch(
			/\)"\]:::surface --> b\["Pilot delivery —<br\/>/,
		);
	});

	it("keeps the indentation and every line the engine reads as other than an edge", () => {
		const label = STAGE_LABELS[0] ?? "";
		const source = [
			"flowchart TD",
			`  subgraph phase1 [${label}]`,
			"    direction LR",
			`    a["${label}"]`,
			"  end",
			"  classDef surface fill:#eef2ff,stroke:#c7d2fe",
			"  class a surface",
			"  style a stroke-width:2px",
			"  linkStyle default stroke:#94a3b8",
		].join("\n");
		const broken = String(wrapFlowchartNodeLabels(source));
		const before = source.split("\n");
		const after = broken.split("\n");
		expect(after).toHaveLength(before.length);
		for (const index of [0, 1, 2, 4, 5, 6, 7, 8]) {
			expect(after[index]).toBe(before[index]);
		}
		expect(after[3]?.startsWith('    a["Scope alignment —<br/>')).toBe(
			true,
		);
	});

	it("leaves the leading comment lines, the header and a comment in the body as written", () => {
		const label = STAGE_LABELS[3] ?? "";
		const source = [
			...LEADING_COMMENTS,
			"",
			"flowchart LR",
			`  %% a["${label}"] is described in the section above`,
			`  a["${label}"] --> b[Done]`,
		].join("\n");
		const lines = String(wrapFlowchartNodeLabels(source)).split("\n");
		expect(lines.slice(0, 5)).toEqual(source.split("\n").slice(0, 5));
		expect(lines[5]).toContain('a["Outcome review —<br/>');
	});

	it.each([
		["an xychart", "xychart-beta\n  x-axis [Q1, Q2]\n  bar [3, 5]"],
		[
			"an xychart after a marker line",
			`${LEADING_COMMENTS[0]}\nxychart-beta\n  title "${STAGE_LABELS[0]}"\n  bar [3, 5]`,
		],
		["a sequence diagram", `sequenceDiagram\n  A->>B: ${STAGE_LABELS[0]}`],
		["a state diagram", `stateDiagram-v2\n  s1 : ${STAGE_LABELS[0]}`],
		["a class diagram", "classDiagram\n  class Proposal"],
		["a header-only comment block", LEADING_COMMENTS.join("\n")],
		["an empty source", ""],
	])("leaves %s untouched", (_kind, source) => {
		expect(wrapFlowchartNodeLabels(source)).toBeNull();
		expect(
			wrapFlowchartNodeLabels(source, { overflowingOnly: true }),
		).toBeNull();
	});

	it("returns null when no label is long enough to break", () => {
		expect(
			wrapFlowchartNodeLabels(
				"flowchart LR\n  a[Discovery] --> b[Delivery and review]",
			),
		).toBeNull();
	});

	it("breaks only the labels too wide for their boxes when asked to", () => {
		const fits = labelOf(70);
		const dense = DENSE_LABELS[0];
		const source = `flowchart LR\n  a["${fits}"]\n  b["${dense}"]\n  a --> b`;
		const everything = String(wrapFlowchartNodeLabels(source));
		expect(everything).not.toContain(`a["${fits}"]`);
		expect(everything).not.toContain(`b["${dense}"]`);

		const overflowing = String(
			wrapFlowchartNodeLabels(source, { overflowingOnly: true }),
		);
		expect(overflowing).toContain(`a["${fits}"]`);
		expect(labelLines(overflowing, "b")).toEqual([
			"Momentum —",
			"minimum-time multi-team",
			"flow",
		]);
		// The dense label breaks exactly as without the option.
		expect(labelLines(overflowing, "b")).toEqual(
			labelLines(everything, "b"),
		);
	});

	it("keeps ordinary labels of 30 to 39 characters as written and breaks those dense in dashes, m, w and hyphens", () => {
		for (const label of ORDINARY_LABELS) {
			expect(
				wrapFlowchartNodeLabels(`flowchart LR\n  a["${label}"]`, {
					overflowingOnly: true,
				}),
			).toBeNull();
		}
		for (const label of DENSE_LABELS) {
			const broken = wrapFlowchartNodeLabels(
				`flowchart LR\n  a["${label}"]`,
				{ overflowingOnly: true },
			);
			expect(labelLines(String(broken), "a")?.length).toBeGreaterThan(1);
		}
	});

	it("predicts Cyrillic and Greek capitals at Inter's width, so an all-caps label too wide for its box is broken and lower-case prose that fits is not", () => {
		// The engine counts each of these capitals as an average lower-case
		// letter, which Inter draws narrower than it draws them.
		for (const label of [
			"ЦЕНТРАЛИЗОВАННОЕ УПРАВЛЕНИЕ ДОСТУПОМ",
			"ΚΕΝΤΡΙΚΗ ΔΙΑΧΕΙΡΙΣΗ ΠΡΟΣΒΑΣΗΣ ΟΜΑΔΩΝ",
		]) {
			expect(Array.from(label)).toHaveLength(36);
			expect(nodeLabelLineOverflows(label), label).toBe(true);
			const broken = wrapFlowchartNodeLabels(
				`flowchart LR\n  a["${label}"]`,
				{ overflowingOnly: true },
			);
			const lines = labelLines(String(broken), "a") ?? [];
			expect(lines.length, label).toBeGreaterThan(1);
			expect(lines.join(" ")).toBe(label);
		}
		for (const label of [
			"Согласование требований с заинтересованными сторонами",
			"Внедрение системы мониторинга и журналирования",
		]) {
			expect(nodeLabelLineOverflows(label), label).toBe(false);
		}
	});

	it("decides on the label's words with spacing collapsed", () => {
		const spaced = ORDINARY_LABELS[0].replaceAll(" ", "    ");
		expect(nodeLabelLineOverflows(spaced)).toBe(true);
		expect(
			wrapFlowchartNodeLabels(`flowchart TD\n  a["${spaced}"]`, {
				overflowingOnly: true,
			}),
		).toBeNull();
	});

	it("never breaks a label one wrapped line holds while it fits its box", () => {
		const short = labelOf(30);
		expect(nodeLabelLineOverflows(short)).toBe(false);
		expect(
			wrapFlowchartNodeLabels(`flowchart TD\n  a["${short}"]`),
		).toBeNull();
		expect(
			wrapFlowchartNodeLabels(`flowchart TD\n  a["${short}"]`, {
				overflowingOnly: true,
			}),
		).toBeNull();
	});

	it("breaks a label of 30 characters or fewer too wide for its box at its dash", () => {
		const dense = "Momentum — minimum-time flow";
		expect(Array.from(dense)).toHaveLength(28);
		for (const overflowingOnly of [false, true]) {
			const broken = String(
				wrapFlowchartNodeLabels(`flowchart TD\n  a["${dense}"]`, {
					overflowingOnly,
				}),
			);
			expect(labelLines(broken, "a")).toEqual([
				"Momentum —",
				"minimum-time flow",
			]);
		}
	});

	it("never leaves a line of several words too wide for its box, nor starts one with a dash", () => {
		const source = [
			"flowchart TD",
			`  a["${DENSE_LABELS.join(" — ")}"]`,
			'  b["mid-term metrics — minimum time — maximum momentum"]',
			'  c["minimum-time multi-team —"]',
		].join("\n");
		const broken = String(wrapFlowchartNodeLabels(source));
		for (const id of ["a", "b", "c"]) {
			const lines = labelLines(broken, id) ?? [];
			expect(lines.length).toBeGreaterThan(1);
			for (const line of lines) {
				expect(line).not.toMatch(/^[—–-] /);
				if (line.includes(" ")) {
					expect(nodeLabelLineOverflows(line), line).toBe(false);
				}
			}
		}
	});

	it("changes nothing in a source it already wrapped", () => {
		const once = String(wrapFlowchartNodeLabels(LONG_CHAIN));
		expect(wrapFlowchartNodeLabels(once)).toBeNull();
		expect(
			wrapFlowchartNodeLabels(once, { overflowingOnly: true }),
		).toBeNull();

		const medium = labelOf(45);
		const source = `flowchart LR\n  a["${medium}"] --> b["${STAGE_LABELS[0]}"]`;
		const overflowing = String(
			wrapFlowchartNodeLabels(source, { overflowingOnly: true }),
		);
		expect(overflowing).toContain(`a["${medium}"]`);
		expect(
			wrapFlowchartNodeLabels(overflowing, { overflowingOnly: true }),
		).toBeNull();
		// The full pass then breaks only what the first one left, and agrees
		// with breaking everything at once.
		const thenAll = String(wrapFlowchartNodeLabels(overflowing));
		expect(thenAll).toBe(wrapFlowchartNodeLabels(source));
		expect(wrapFlowchartNodeLabels(thenAll)).toBeNull();
	});

	it("wraps a turned source as it wraps the sideways one, header apart", () => {
		const turned = String(turnFlowchartTopDown(LONG_CHAIN));
		const wrapped = String(wrapFlowchartNodeLabels(turned));
		expect(wrapped.split("\n")[0]).toBe("flowchart TD");
		expect(wrapped.split("\n").slice(1)).toEqual(
			String(wrapFlowchartNodeLabels(LONG_CHAIN)).split("\n").slice(1),
		);
	});
});
