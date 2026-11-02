/**
 * A flowchart's long node labels broken into lines and a sideways flowchart
 * turned top-down (Fizzy #2946), as the live page draws them and as the
 * Proposal export's print legibility rule does. Pure string work: the
 * engine is not drawn here.
 */

import { describe, expect, it } from "vitest";
import {
	PRINT_COLUMN_PX,
	PRINT_FIGURE_MAX_HEIGHT_PX,
	PRINT_LABEL_FLOOR_PT,
	printedNodeLabelPt,
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
		expect(wrapFlowchartNodeLabels(source, { minChars: 1 })).toBeNull();
	});

	it("returns null when no label is long enough to break", () => {
		expect(
			wrapFlowchartNodeLabels(
				"flowchart LR\n  a[Discovery] --> b[Delivery and review]",
			),
		).toBeNull();
	});

	it("breaks only labels at least `minChars` long when asked to", () => {
		const medium = labelOf(45);
		const long = labelOf(70);
		const source = `flowchart LR\n  a["${medium}"] --> b["${long}"]`;
		const everything = String(wrapFlowchartNodeLabels(source));
		expect(everything).not.toContain(`a["${medium}"]`);
		expect(everything).not.toContain(`b["${long}"]`);

		const longOnly = String(
			wrapFlowchartNodeLabels(source, { minChars: 60 }),
		);
		expect(longOnly).toContain(`a["${medium}"]`);
		expect(longOnly).not.toContain(`b["${long}"]`);
		// The long label breaks exactly as without the threshold.
		expect(labelLines(longOnly, "b")).toEqual(labelLines(everything, "b"));
	});

	it("counts `minChars` inclusively, on the label's words with spacing collapsed", () => {
		const at = labelOf(60);
		const below = labelOf(59);
		expect(Array.from(at)).toHaveLength(60);
		expect(Array.from(below)).toHaveLength(59);
		expect(
			wrapFlowchartNodeLabels(`flowchart TD\n  a["${at}"]`, {
				minChars: 60,
			}),
		).not.toBeNull();
		expect(
			wrapFlowchartNodeLabels(`flowchart TD\n  a["${below}"]`, {
				minChars: 60,
			}),
		).toBeNull();
		// Doubled spaces do not count toward the threshold.
		expect(
			wrapFlowchartNodeLabels(
				`flowchart TD\n  a["${below.replace(" ", "    ")}"]`,
				{ minChars: 60 },
			),
		).toBeNull();
	});

	it("never breaks a label one wrapped line holds, however low `minChars` is", () => {
		expect(
			wrapFlowchartNodeLabels(`flowchart TD\n  a["${labelOf(30)}"]`, {
				minChars: 1,
			}),
		).toBeNull();
	});

	it("changes nothing in a source it already wrapped", () => {
		const once = String(wrapFlowchartNodeLabels(LONG_CHAIN));
		expect(wrapFlowchartNodeLabels(once)).toBeNull();
		expect(wrapFlowchartNodeLabels(once, { minChars: 60 })).toBeNull();

		const medium = labelOf(45);
		const source = `flowchart LR\n  a["${medium}"] --> b["${STAGE_LABELS[0]}"]`;
		const longOnly = String(
			wrapFlowchartNodeLabels(source, { minChars: 60 }),
		);
		expect(wrapFlowchartNodeLabels(longOnly, { minChars: 60 })).toBeNull();
		// The full pass then breaks only what the threshold left, and agrees
		// with breaking everything at once.
		const thenAll = String(wrapFlowchartNodeLabels(longOnly));
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
