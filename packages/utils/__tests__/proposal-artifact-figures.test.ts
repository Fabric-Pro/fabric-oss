import { describe, expect, it } from "vitest";
import { contrastRatio } from "../lib/brand-colors";
import {
	flowToMermaid,
	PROPOSAL_VISUAL_TEMPLATE_OPTIONS,
	proposalVisualTemplateOptions,
	timelineToMermaid,
	visualSpecToMermaid,
} from "../lib/glossy/visual-templates";
import { withDiagramCaption } from "../lib/proposal-artifact/diagram-caption";
import {
	barsFigureSvg,
	barsOverGrey,
	FIGURE_LINE,
	FIGURE_WIDTH,
	type FigureModel,
	type FigurePalette,
	ganttFigureSvg,
	layersFigureSvg,
	parseBarsSource,
	parseFigureSource,
	parseGanttSource,
	processFigureSvg,
	readFigureKind,
	renderFigureSvg,
	teamFigureSvg,
	tryRenderFigure,
	withFigureKind,
} from "../lib/proposal-artifact/proposal-figures";

const lines = (...parts: string[]) => parts.join("\n");

const ZWSP = String.fromCharCode(0x200b);

const PALETTE: FigurePalette = {
	ink: "#16171a",
	onInk: "#ffffff",
	primary: "#c2410c",
	label: "#9a3412",
	onPrimary: "#ffffff",
	tint: "#fbefe9",
	border: "#d9dade",
	surface: "#ffffff",
	muted: "#5b5e66",
};

const MARKER = "%% fabric-visual: k3v9q2m7x1a8c4d6";

function parsed(source: string): FigureModel {
	const model = parseFigureSource(source);
	if (!model) {
		throw new Error("expected the source to parse");
	}
	return model;
}

function chainSource(count: number, extra: string[] = []): string {
	const body = ["flowchart TD"];
	for (let index = 1; index <= count; index += 1) {
		body.push(
			`n${index}["Step ${index} title<br/>Detail of step ${index}"]`,
		);
		if (index > 1) {
			body.push(`n${index - 1} --> n${index}`);
		}
	}
	return lines(...body, ...extra);
}

function svgOf(value: string | null): string {
	if (value === null) {
		throw new Error("expected an SVG");
	}
	return value;
}

/** Every `<rect>` the template draws as a step or layer box. */
function rectCount(svg: string, marker: string): number {
	return svg.split(marker).length - 1;
}

// A local copy of the export cleaner's allowlist (the Proposal export's
// clean-svg module): utils cannot import the temporal package, so this
// checks the same names mechanically. The temporal tests run the real one.
const ALLOWED_ELEMENTS = new Set([
	"svg",
	"g",
	"defs",
	"marker",
	"path",
	"line",
	"polyline",
	"polygon",
	"rect",
	"circle",
	"ellipse",
	"text",
	"tspan",
	"title",
	"desc",
]);
const ALLOWED_ATTRIBUTES = new Set([
	"id",
	"class",
	"font-family",
	"x",
	"y",
	"x1",
	"y1",
	"x2",
	"y2",
	"cx",
	"cy",
	"r",
	"rx",
	"ry",
	"dx",
	"dy",
	"width",
	"height",
	"d",
	"points",
	"transform",
	"fill",
	"fill-opacity",
	"fill-rule",
	"stroke",
	"stroke-width",
	"stroke-opacity",
	"stroke-dasharray",
	"stroke-dashoffset",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-miterlimit",
	"opacity",
	"font-size",
	"font-weight",
	"font-style",
	"text-anchor",
	"dominant-baseline",
	"alignment-baseline",
	"letter-spacing",
	"text-decoration",
	"markerWidth",
	"markerHeight",
	"markerUnits",
	"refX",
	"refY",
	"orient",
	"marker-start",
	"marker-mid",
	"marker-end",
	"vector-effect",
]);
const ROOT_ONLY_ATTRIBUTES = new Set(["xmlns", "viewBox", "role"]);

function expectSafeSvg(svg: string): void {
	expect(svg).not.toMatch(/<script/i);
	expect(svg).not.toMatch(/foreignObject/i);
	expect(svg).not.toMatch(/\son[a-z]+=/i);
	expect(svg).not.toMatch(/@import/i);
	expect(svg).not.toMatch(/href=/i);
	// The only url() is a same-document marker reference.
	for (const match of svg.matchAll(/url\(([^)]*)\)/g)) {
		expect(match[1]).toMatch(/^#[A-Za-z0-9_-]+$/);
	}
	const tags = Array.from(svg.matchAll(/<([A-Za-z][\w:-]*)([^>]*)>/g));
	tags.forEach(([, name, attributes], index) => {
		expect(ALLOWED_ELEMENTS.has(name), name).toBe(true);
		for (const attribute of attributes.matchAll(
			/\s([A-Za-z_:][\w:.-]*)=/g,
		)) {
			const attributeName = attribute[1];
			const allowed =
				ALLOWED_ATTRIBUTES.has(attributeName) ||
				(index === 0 && ROOT_ONLY_ATTRIBUTES.has(attributeName));
			expect(allowed, `${name} ${attributeName}`).toBe(true);
		}
	});
}

function expectPrintGeometry(svg: string): void {
	const root = /^<svg [^>]*>/.exec(svg)?.[0] ?? "";
	expect(root).toContain(`width="${FIGURE_WIDTH}"`);
	expect(root).toMatch(/viewBox="0 0 662 \d+(?:\.\d)?"/);
	const height = /height="(\d+(?:\.\d)?)"/.exec(root)?.[1];
	expect(root).toContain(`viewBox="0 0 662 ${height}"`);
	expect(root).toContain('role="img"');
	const sizes = Array.from(svg.matchAll(/font-size="([\d.]+)"/g)).map(
		(match) => Number(match[1]),
	);
	expect(sizes.length).toBeGreaterThan(0);
	for (const size of sizes) {
		expect(size).toBeGreaterThanOrEqual(12);
	}
}

/** The text of every `<text>` element, tspans joined with a space. */
function drawnTexts(svg: string): string[] {
	return Array.from(svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)).map((match) =>
		match[1]
			.replace(/<tspan[^>]*>/g, " ")
			.replace(/<\/tspan>/g, "")
			.trim(),
	);
}

describe("figure line", () => {
	it("reads the kind from the leading comment block", () => {
		expect(
			readFigureKind(lines(MARKER, "%% figure: process", "flowchart TD")),
		).toBe("process");
		expect(readFigureKind(lines("%%figure:team", "flowchart LR"))).toBe(
			"team",
		);
		expect(
			readFigureKind(lines("flowchart TD", "%% figure: process")),
		).toBe(null);
		expect(readFigureKind(lines("%% figure: pie", "flowchart TD"))).toBe(
			null,
		);
		expect(readFigureKind(lines("%% figure: gantt", "gantt"))).toBe(
			"gantt",
		);
		expect(FIGURE_LINE.test("%% figure: layers")).toBe(true);
	});

	it("writes after the marker and caption and round-trips", () => {
		const body = lines(MARKER, "%% caption: Delivery plan", "flowchart TD");
		const written = withFigureKind(body, "timeline");
		expect(written).toBe(
			lines(
				MARKER,
				"%% caption: Delivery plan",
				"%% figure: timeline",
				"flowchart TD",
			),
		);
		expect(readFigureKind(written)).toBe("timeline");
		expect(withFigureKind(written, "process")).toBe(
			lines(
				MARKER,
				"%% caption: Delivery plan",
				"%% figure: process",
				"flowchart TD",
			),
		);
		expect(withFigureKind(written, null)).toBe(body);
		expect(withFigureKind(body, null)).toBe(body);
	});

	it("keeps marker, caption, figure order whichever line is written first", () => {
		const source = lines(MARKER, "flowchart TD", "a --> b");
		const figureFirst = withDiagramCaption(
			withFigureKind(source, "process"),
			"How it flows",
		);
		const captionFirst = withFigureKind(
			withDiagramCaption(source, "How it flows"),
			"process",
		);
		const expected = lines(
			MARKER,
			"%% caption: How it flows",
			"%% figure: process",
			"flowchart TD",
			"a --> b",
		);
		expect(figureFirst).toBe(expected);
		expect(captionFirst).toBe(expected);
	});

	it("writes first when there is no marker", () => {
		expect(withFigureKind(lines("flowchart TD", "a --> b"), "layers")).toBe(
			lines("%% figure: layers", "flowchart TD", "a --> b"),
		);
	});
});

describe("parseFigureSource", () => {
	it("parses a Proposal flow from the templating", () => {
		const source = flowToMermaid(
			{
				kind: "flow",
				steps: [
					{
						label: "Scope the work with both teams together",
						description: "Agree what done looks like",
					},
					{
						label: "Build",
						description: 'The "core" <b>kit</b> & test',
					},
					{ label: "Review", description: "Read it -> then ship" },
				],
			},
			PROPOSAL_VISUAL_TEMPLATE_OPTIONS,
		);
		const model = parsed(withFigureKind(lines(MARKER, source), "process"));
		expect(model.nodes.map((node) => node.id)).toEqual(["f0", "f1", "f2"]);
		expect(model.nodes[0].lines).toEqual([
			"Scope the work with both",
			"teams together",
			"Agree what done looks like",
		]);
		expect(model.nodes[1].lines).toEqual([
			"Build",
			"The “core” <b>kit</b> & test",
		]);
		expect(model.nodes[2].lines[1]).toBe("Read it -> then ship");
		for (const node of model.nodes) {
			expect(node.classes).toEqual(["surface"]);
			for (const line of node.lines) {
				expect(line).not.toContain(ZWSP);
			}
		}
		expect(model.edges).toEqual([
			{ from: "f0", to: "f1", dashed: false, label: [] },
			{ from: "f1", to: "f2", dashed: false, label: [] },
		]);
	});

	it("draws a long generated title as the figure's title, not as detail", () => {
		const title = "Scope the work with both teams together";
		const textOf = (element: string) =>
			element
				.replace(/<\/tspan><tspan[^>]*>/g, " ")
				.replace(/<[^>]+>/g, "");
		const spec = {
			kind: "flow" as const,
			steps: [
				{ label: title, description: "Agree what done looks like" },
				{ label: "Build" },
				{ label: "Review" },
			],
		};
		const source = withFigureKind(
			visualSpecToMermaid(spec, proposalVisualTemplateOptions(spec)),
			"process",
		);
		expect(parsed(source).nodes[0].lines).toEqual([
			title,
			"Agree what done looks like",
		]);
		const svg = svgOf(renderFigureSvg("process", source, PALETTE));
		const labels = Array.from(
			svg.matchAll(/<text class="label" [^>]*>.*?<\/text>/g),
			([element]) => textOf(element),
		);
		expect(labels[0]).toBe(title);
		const details = Array.from(
			svg.matchAll(/<text class="detail" [^>]*>.*?<\/text>/g),
			([element]) => textOf(element),
		);
		expect(details).toEqual(["Agree what done looks like"]);
	});

	it("parses a Proposal timeline from the templating", () => {
		const source = timelineToMermaid(
			{
				kind: "timeline",
				items: [
					{
						date: "Week 1",
						label: "Discovery",
						description: "Interviews",
					},
					{ date: "Week 2-4", label: "First build" },
					{ date: "Week 5", label: "Pilot #1; 50% of crews" },
				],
			},
			PROPOSAL_VISUAL_TEMPLATE_OPTIONS,
		);
		const model = parsed(source);
		expect(model.nodes.map((node) => node.lines)).toEqual([
			["Week 1", "Discovery", "Interviews"],
			["Week 2-4", "First build"],
			["Week 5", "Pilot #1; 50% of crews"],
		]);
	});

	it("decodes the entity escapes and keeps a double-escaped one literal", () => {
		const model = parsed(
			lines(
				"graph LR",
				'a["#quot;A#quot; #lt;B#gt; #amp; &quot;C&quot; &lt;D&gt; &amp;"]',
				'b["&amp;lt;tag&amp;gt; #35;"]',
				"a --> b",
			),
		);
		expect(model.nodes[0].lines).toEqual(['"A" <B> & "C" <D> &']);
		expect(model.nodes[1].lines).toEqual(["&lt;tag&gt; #"]);
	});

	it("reads edges, chains, classes, subgraphs and other node shapes", () => {
		const model = parsed(
			lines(
				"%% a comment",
				"flowchart LR",
				"classDef highlight fill:#fff",
				'subgraph pod["Our pod"]',
				"  direction TB",
				'  p1["Lead"]:::highlight',
				"  p2(Engineer)",
				"end",
				"subgraph client [Client team]",
				'  c1(["Sponsor"])',
				"end",
				'p1 --> p2 -.->|"Weekly<br>review"| c1;',
				"class p2,c1 highlight",
				"style p1 fill:#eee",
			),
		);
		expect(model.direction).toBe("LR");
		expect(model.subgraphs).toEqual([
			{ id: "pod", title: ["Our pod"], nodeIds: ["p1", "p2"] },
			{ id: "client", title: ["Client team"], nodeIds: ["c1"] },
		]);
		expect(
			model.nodes.map((node) => [node.id, node.lines, node.classes]),
		).toEqual([
			["p1", ["Lead"], ["highlight"]],
			["p2", ["Engineer"], ["highlight"]],
			["c1", ["Sponsor"], ["highlight"]],
		]);
		expect(model.edges).toEqual([
			{ from: "p1", to: "p2", dashed: false, label: [] },
			{ from: "p2", to: "c1", dashed: true, label: ["Weekly", "review"] },
		]);
	});

	it("uses the id as the label of an undeclared node", () => {
		const model = parsed(lines("flowchart TD", "Start --> Finish"));
		expect(model.nodes.map((node) => node.lines)).toEqual([
			["Start"],
			["Finish"],
		]);
	});

	it.each([
		[
			"nested subgraphs",
			lines(
				"flowchart TD",
				"subgraph a",
				"subgraph b",
				"x",
				"end",
				"end",
			),
		],
		[
			"a click line",
			lines("flowchart TD", "a --> b", 'click a "https://example.com"'),
		],
		[
			"an init directive",
			lines("%%{init: {'theme': 'dark'}}%%", "flowchart TD", "a --> b"),
		],
		[
			"frontmatter",
			lines("---", "title: Example", "---", "flowchart TD", "a --> b"),
		],
		["a tag in a label", lines("flowchart TD", 'a["<b>Bold</b>"] --> b')],
		[
			"an image tag in a label",
			lines("flowchart TD", "a[\"<img src='x'>\"]"),
		],
		[
			"a style line with url(",
			lines("flowchart TD", "a --> b", "style a fill:url(#x)"),
		],
		[
			"a linkStyle line with url(",
			lines("flowchart TD", "a --> b", "linkStyle 0 stroke:url(#x)"),
		],
		[
			"an unknown statement",
			lines("flowchart TD", "a --> b", "accTitle: Hidden"),
		],
		["another diagram kind", lines("sequenceDiagram", "a->>b: hi")],
		["an unclosed subgraph", lines("flowchart TD", "subgraph a", "x")],
		["a stray end", lines("flowchart TD", "a --> b", "end")],
		["an unsupported arrow", lines("flowchart TD", "a ==> b")],
		["an empty source", ""],
	])("returns null for %s", (_name, source) => {
		expect(parseFigureSource(source)).toBeNull();
	});

	it("accepts an escaped tag the templating wrote", () => {
		const model = parsed(
			lines(
				"flowchart TD",
				`a["<${ZWSP}b>Bold<${ZWSP}/b> 100%${ZWSP}%"]`,
			),
		);
		expect(model.nodes[0].lines).toEqual(["<b>Bold</b> 100%%"]);
	});
});

describe("processFigureSvg", () => {
	it("lays a chain of six out in two rows of four and two", () => {
		const svg = svgOf(
			processFigureSvg(parsed(chainSource(6)), PALETTE, {}),
		);
		const tops = Array.from(
			svg.matchAll(/<rect class="step" x="[\d.]+" y="([\d.]+)"/g),
		).map((match) => match[1]);
		expect(tops).toHaveLength(6);
		expect(new Set(tops.slice(0, 4)).size).toBe(1);
		expect(new Set(tops.slice(4)).size).toBe(1);
		expect(tops[4]).not.toBe(tops[0]);
		expectPrintGeometry(svg);
		expectSafeSvg(svg);
	});

	it("highlights only the node with the highlight class", () => {
		const svg = svgOf(
			processFigureSvg(
				parsed(chainSource(4, ["class n3 highlight"])),
				PALETTE,
				{},
			),
		);
		const fills = Array.from(
			svg.matchAll(/<rect class="step" [^>]*fill="(#[0-9a-f]+)"/g),
		).map((match) => match[1]);
		expect(fills).toEqual([
			PALETTE.surface,
			PALETTE.surface,
			PALETTE.tint,
			PALETTE.surface,
		]);
		const squares = Array.from(
			svg.matchAll(/<rect class="number" [^>]*fill="(#[0-9a-f]+)"/g),
		).map((match) => match[1]);
		expect(squares).toEqual([
			PALETTE.ink,
			PALETTE.ink,
			PALETTE.primary,
			PALETTE.ink,
		]);
	});

	it("draws a dashed back edge as a labelled loop under the rows", () => {
		const svg = svgOf(
			processFigureSvg(
				parsed(chainSource(7, ["n7 -.->|Feedback| n1"])),
				PALETTE,
				{ idPrefix: "fig-3" },
			),
		);
		expect(svg).toMatch(
			new RegExp(
				`<path class="loop" [^>]*stroke="${PALETTE.primary}"[^>]*stroke-dasharray=`,
			),
		);
		expect(svg).toContain('marker-end="url(#fig-3-loop-arrow)"');
		expect(svg).toContain('<marker id="fig-3-loop-arrow"');
		expect(drawnTexts(svg)).toContain("Feedback");
		const loopLabel =
			/<text class="loop-label"[^>]*fill="([^"]+)"[^>]*>/.exec(svg);
		expect(loopLabel?.[1]).toBe(PALETTE.primary);
		expect(svg).toMatch(/<desc>[^<]*Feedback/);
		expectSafeSvg(svg);
		expectPrintGeometry(svg);
	});

	it("returns null for a cycle of solid edges", () => {
		expect(
			processFigureSvg(
				parsed(chainSource(3, ["n3 --> n1"])),
				PALETTE,
				{},
			),
		).toBeNull();
	});

	it.each([
		["a branch", lines("flowchart TD", "a --> b", "a --> c")],
		["two chains", lines("flowchart TD", "a --> b", "c --> d")],
		[
			"a dashed forward edge",
			lines("flowchart TD", "a --> b", "b --> c", "a -.-> c"),
		],
		["a labelled solid edge", lines("flowchart TD", "a -->|yes| b")],
		["a subgraph", lines("flowchart TD", "subgraph s", "a --> b", "end")],
	])("returns null for %s", (_name, source) => {
		expect(processFigureSvg(parsed(source), PALETTE, {})).toBeNull();
	});

	it("follows the edges, not the declaration order", () => {
		const svg = svgOf(
			processFigureSvg(
				parsed(
					lines(
						"flowchart LR",
						'c["Third"]',
						'a["First"]',
						'b["Second"]',
						"b --> c",
						"a --> b",
					),
				),
				PALETTE,
				{},
			),
		);
		const desc = /<desc>([^<]*)<\/desc>/.exec(svg)?.[1] ?? "";
		expect(desc.indexOf("First")).toBeLessThan(desc.indexOf("Second"));
		expect(desc.indexOf("Second")).toBeLessThan(desc.indexOf("Third"));
	});

	it("wraps a 160-character label to at most three lines with an ellipsis", () => {
		const long =
			"An unusually long step title that keeps going well past the budget of one box so that it has to wrap several times before it ends here";
		const label = `${long} and more words`.padEnd(160, " x");
		expect(label).toHaveLength(160);
		const svg = svgOf(
			processFigureSvg(
				parsed(
					lines(
						"flowchart TD",
						`a["${label}"]`,
						'b["Short"]',
						"a --> b",
					),
				),
				PALETTE,
				{},
			),
		);
		const titleText = /<text class="label"[^>]*>(.*?)<\/text>/.exec(
			svg,
		)?.[1];
		const tspans = (titleText ?? "").match(/<tspan/g) ?? [];
		expect(tspans.length).toBeLessThanOrEqual(3);
		expect(tspans.length).toBeGreaterThan(1);
		expect(titleText).toContain("…");
		expectPrintGeometry(svg);
	});

	it("gives every box of a row the tallest box's height", () => {
		const svg = svgOf(
			processFigureSvg(
				parsed(
					lines(
						"flowchart TD",
						'a["One line"]',
						'b["Title<br/>Detail one<br/>Detail two<br/>Detail three"]',
						"a --> b",
					),
				),
				PALETTE,
				{},
			),
		);
		const heights = Array.from(
			svg.matchAll(/<rect class="step" [^>]*height="([\d.]+)"/g),
		).map((match) => match[1]);
		expect(heights).toHaveLength(2);
		expect(heights[0]).toBe(heights[1]);
	});

	it("has a title, and a desc listing the steps in order", () => {
		const svg = svgOf(
			processFigureSvg(parsed(chainSource(5)), PALETTE, {
				caption: "How one scope line moves",
			}),
		);
		expect(svg).toContain("<title>How one scope line moves</title>");
		const desc = /<desc>([^<]*)<\/desc>/.exec(svg)?.[1] ?? "";
		const positions = [1, 2, 3, 4, 5].map((step) =>
			desc.indexOf(`Step ${step} title`),
		);
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		const untitled = svgOf(
			processFigureSvg(parsed(chainSource(2)), PALETTE, {}),
		);
		expect(untitled).toContain("<title>Process</title>");
	});

	it("escapes markup, ampersands and quotes", () => {
		const svg = svgOf(
			processFigureSvg(
				parsed(
					lines(
						"flowchart TD",
						'a["#lt;script#gt; & #quot;quoted#quot; it\'s"]',
						'b["B"]',
						"a --> b",
					),
				),
				PALETTE,
				{ caption: 'Tom & "Jerry" <x>' },
			),
		);
		expect(svg).not.toContain("<script");
		expect(svg).toContain(
			"&lt;script&gt; &amp; &quot;quoted&quot; it&apos;s",
		);
		expect(svg).toContain(
			"<title>Tom &amp; &quot;Jerry&quot; &lt;x&gt;</title>",
		);
		expectSafeSvg(svg);
	});

	it("draws a timeline node's first line as a mono eyebrow", () => {
		const source = timelineToMermaid(
			{
				kind: "timeline",
				items: [
					{ date: "Week 1", label: "Discovery" },
					{ date: "Week 2", label: "Build" },
				],
			},
			PROPOSAL_VISUAL_TEMPLATE_OPTIONS,
		);
		const svg = svgOf(
			processFigureSvg(parsed(source), PALETTE, { dated: true }),
		);
		const eyebrows = Array.from(
			svg.matchAll(
				/<text class="eyebrow" [^>]*font-family="([^"]+)"[^>]*>([^<]*)</g,
			),
		);
		expect(eyebrows.map((match) => match[2])).toEqual(["Week 1", "Week 2"]);
		expect(eyebrows[0][1]).toMatch(/^'JetBrains Mono'/);
		const labels = Array.from(
			svg.matchAll(
				/<text class="label" [^>]*font-family="([^"]+)"[^>]*>([^<]*)</g,
			),
		);
		expect(labels.map((match) => match[2])).toEqual(["Discovery", "Build"]);
		expect(labels[0][1]).toMatch(/^Inter/);
		expect(svg).toContain("<title>Timeline</title>");
	});

	it("is deterministic and scopes its marker ids", () => {
		const model = parsed(chainSource(5));
		const one = processFigureSvg(model, PALETTE, { idPrefix: "a1" });
		expect(processFigureSvg(model, PALETTE, { idPrefix: "a1" })).toBe(one);
		const two = svgOf(processFigureSvg(model, PALETTE, { idPrefix: "b2" }));
		expect(two).toContain('id="b2-arrow"');
		expect(two).not.toContain('id="a1-arrow"');
		expect(() =>
			processFigureSvg(model, PALETTE, { idPrefix: 'x" onload="y' }),
		).toThrow();
	});
});

const LAYERS = lines(
	"flowchart TB",
	'subgraph experience["Experience<br/>who uses it"]',
	'  e1["Crew app"]',
	'  e2["Dispatcher console"]',
	"end",
	'subgraph services["Services"]',
	'  s1["Routing"]',
	'  s2["Work orders"]',
	'  s3["Parts reservation"]',
	"end",
	'subgraph integration["Integration"]',
	'  i1["Order system"]',
	"end",
	'subgraph data["Data"]',
	'  d1["Store"]',
	'  d2["Event log"]',
	"end",
	'subgraph crosscutting["Cross-cutting"]',
	'  x1["Identity"]',
	'  x2["Audit log"]',
	"end",
	"class s3 highlight",
);

describe("layersFigureSvg", () => {
	it("draws four layer rows and the cross-cutting column", () => {
		const svg = svgOf(layersFigureSvg(parsed(LAYERS), PALETTE, {}));
		expect(rectCount(svg, '<rect class="layer"')).toBe(4);
		expect(rectCount(svg, '<rect class="box"')).toBe(8);
		expect(svg).toMatch(
			new RegExp(`<rect class="crosscutting" [^>]*fill="${PALETTE.ink}"`),
		);
		const texts = drawnTexts(svg);
		expect(texts).toContain("EXPERIENCE");
		expect(texts).toContain("who uses it");
		expect(texts).toContain("CROSS-CUTTING");
		expect(texts).toContain("Audit log");
		expect(svg).toMatch(
			new RegExp(
				`<rect class="box" [^>]*fill="${PALETTE.tint}" stroke="${PALETTE.primary}"`,
			),
		);
		expect(rectCount(svg, `fill="${PALETTE.tint}"`)).toBe(1);
		expect(svg).toContain("<title>Architecture layers</title>");
		const desc = /<desc>([^<]*)<\/desc>/.exec(svg)?.[1] ?? "";
		expect(desc.indexOf("Experience")).toBeLessThan(
			desc.indexOf("Services"),
		);
		expect(desc.indexOf("Data")).toBeLessThan(desc.indexOf("Identity"));
		expectPrintGeometry(svg);
		expectSafeSvg(svg);
	});

	it("gives a long word the room it needs instead of breaking it", () => {
		const svg = svgOf(
			layersFigureSvg(
				parsed(
					lines(
						"flowchart TB",
						'subgraph services["Services"]',
						'  s1["Routing"]',
						'  s2["Work orders"]',
						'  s3["Parts reservation"]',
						'  s4["Notifications"]',
						"end",
						'subgraph crosscutting["Cross-cutting"]',
						'  x1["Identity"]',
						"end",
					),
				),
				PALETTE,
				{},
			),
		);
		const texts = drawnTexts(svg);
		expect(texts).toContain("Notifications");
		expect(texts.join(" ")).toContain("reservation");
	});

	it("uses the whole width without a cross-cutting column", () => {
		const svg = svgOf(
			layersFigureSvg(
				parsed(lines("flowchart TB", "subgraph a", 'x["Only"]', "end")),
				PALETTE,
				{},
			),
		);
		expect(svg).not.toContain('class="crosscutting"');
		expectPrintGeometry(svg);
	});

	it.each([
		[
			"a node outside every subgraph",
			lines("flowchart TB", "subgraph a", "x", "end", "y"),
		],
		["no subgraph", lines("flowchart TB", "x --> y")],
		[
			"only the cross-cutting column",
			lines("flowchart TB", "subgraph crosscutting", "x", "end"),
		],
		["an empty layer", lines("flowchart TB", "subgraph a", "end")],
	])("returns null for %s", (_name, source) => {
		expect(layersFigureSvg(parsed(source), PALETTE, {})).toBeNull();
	});
});

const TEAM = lines(
	"flowchart LR",
	'subgraph pod["Example Studio pod"]',
	'  p1["Engagement lead<br/>Owns scope and the weekly review"]',
	'  p2["Senior engineer<br/>Mobile and offline sync"]',
	"end",
	'subgraph client["Example Harbor Co"]',
	'  c1["Operations sponsor<br/>Approves milestones"]',
	'  c2["Crew leads"]',
	'  c3["IT owner"]',
	"end",
	'r["Daily stand-up<br/>weekly review"]',
	"p1 -.-> c1",
	"p2 --> c3",
	"p1 --> r",
);

interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** The shared box's rectangle. */
function sharedBox(svg: string): Box {
	const rect = /<rect class="shared" ([^>]*)\/>/.exec(svg)?.[1] ?? "";
	const read = (name: string) =>
		Number(new RegExp(`\\b${name}="([\\d.]+)"`).exec(rect)?.[1]);
	const left = read("x");
	const top = read("y");
	return {
		left,
		top,
		right: left + read("width"),
		bottom: top + read("height"),
	};
}

type Segment = { x1: number; y1: number; x2: number; y2: number };

/** Every link path as its straight segments, from its M, H and V commands. */
function linkPaths(svg: string): Segment[][] {
	return Array.from(svg.matchAll(/<path class="link" d="([^"]*)"/g)).map(
		(match) => {
			const segments: Segment[] = [];
			let x = 0;
			let y = 0;
			for (const command of match[1].matchAll(
				/([MHV])\s*([\d.]+)(?:\s+([\d.]+))?/g,
			)) {
				const [, kind, first, second] = command;
				if (kind === "M") {
					x = Number(first);
					y = Number(second);
					continue;
				}
				const next =
					kind === "H"
						? { x: Number(first), y }
						: { x, y: Number(first) };
				segments.push({ x1: x, y1: y, x2: next.x, y2: next.y });
				x = next.x;
				y = next.y;
			}
			return segments;
		},
	);
}

/** Whether an axis-aligned segment touches the box, edges included. */
function segmentMeetsBox(segment: Segment, box: Box): boolean {
	return (
		Math.max(segment.x1, segment.x2) >= box.left &&
		Math.min(segment.x1, segment.x2) <= box.right &&
		Math.max(segment.y1, segment.y2) >= box.top &&
		Math.min(segment.y1, segment.y2) <= box.bottom
	);
}

describe("teamFigureSvg", () => {
	it("draws the proposer and client columns with dashed links", () => {
		const svg = svgOf(teamFigureSvg(parsed(TEAM), PALETTE, {}));
		expect(svg).toMatch(
			new RegExp(`<rect class="column" [^>]*fill="${PALETTE.ink}"`),
		);
		expect(rectCount(svg, '<rect class="column"')).toBe(2);
		expect(rectCount(svg, '<rect class="role"')).toBe(5);
		expect(rectCount(svg, '<rect class="shared"')).toBe(1);
		expect(rectCount(svg, `<path class="link" `)).toBe(2);
		expect(svg).toMatch(
			new RegExp(
				`<path class="link" [^>]*stroke="${PALETTE.primary}"[^>]*stroke-dasharray=`,
			),
		);
		const texts = drawnTexts(svg);
		expect(texts).toContain("EXAMPLE STUDIO POD");
		expect(texts).toContain("Daily stand-up");
		expect(svg).toContain("<title>Team</title>");
		expectPrintGeometry(svg);
		expectSafeSvg(svg);
	});

	it("joins both sides through the shared box and never crosses it", () => {
		const crossing = lines(
			"flowchart LR",
			'subgraph pod["Example Studio pod"]',
			'  p1["Engagement lead"]',
			'  p2["Senior engineer"]',
			'  p3["Designer"]',
			'  p4["QA engineer"]',
			"end",
			'subgraph client["Example Harbor Co"]',
			'  c1["Operations sponsor"]',
			'  c2["Crew leads"]',
			'  c3["IT owner"]',
			'  c4["Finance"]',
			"end",
			'r["Daily stand-up<br/>weekly review"]',
			"p1 -.-> c4",
			"p2 --> c2",
			"p3 --> c3",
			"p4 --> c1",
			"p2 --> r",
			"r --> c3",
		);
		for (const source of [TEAM, crossing]) {
			const svg = svgOf(teamFigureSvg(parsed(source), PALETTE, {}));
			const box = sharedBox(svg);
			const paths = linkPaths(svg);
			// The box is the hub: one straight connector on each side of it,
			// whatever links the source draws.
			expect(paths).toHaveLength(2);
			expect(paths.every((path) => path.length === 1)).toBe(true);
			for (const path of paths) {
				for (const segment of path) {
					expect(
						segmentMeetsBox(segment, box),
						JSON.stringify(segment),
					).toBe(false);
				}
			}
			expect(svg).toContain("Working links: ");
		}
	});

	it("gives every turning link its own lane when there is no shared box", () => {
		const source = lines(
			"flowchart LR",
			'subgraph pod["Example Studio pod"]',
			'  p1["Engagement lead"]',
			'  p2["Senior engineer"]',
			'  p3["Designer"]',
			"end",
			'subgraph client["Example Harbor Co"]',
			'  c1["Operations sponsor"]',
			'  c2["Crew leads"]',
			'  c3["IT owner"]',
			"end",
			"p1 --> c3",
			"p2 --> c1",
			"p3 --> c2",
			"p2 --> c2",
		);
		const svg = svgOf(teamFigureSvg(parsed(source), PALETTE, {}));
		const paths = linkPaths(svg);
		expect(paths).toHaveLength(4);
		const lanes = paths
			.filter((path) => path.length > 1)
			.map(
				(path) => path.find((segment) => segment.x1 === segment.x2)?.x1,
			);
		expect(lanes).toHaveLength(3);
		expect(new Set(lanes).size).toBe(3);
	});

	it("returns null for three subgraphs", () => {
		const source = lines(
			"flowchart LR",
			"subgraph a",
			"x",
			"end",
			"subgraph b",
			"y",
			"end",
			"subgraph c",
			"z",
			"end",
		);
		expect(teamFigureSvg(parsed(source), PALETTE, {})).toBeNull();
		expect(renderFigureSvg("team", source, PALETTE, {})).toBeNull();
	});

	it("returns null for two nodes outside the columns", () => {
		const source = lines(
			"flowchart LR",
			"subgraph a",
			"x",
			"end",
			"subgraph b",
			"y",
			"end",
			"r1",
			"r2",
		);
		expect(teamFigureSvg(parsed(source), PALETTE, {})).toBeNull();
	});
});

describe("renderFigureSvg", () => {
	it("draws each kind from a fence body", () => {
		const body = withFigureKind(lines(MARKER, chainSource(3)), "process");
		expect(renderFigureSvg("process", body, PALETTE, {})).toMatch(/^<svg /);
		expect(renderFigureSvg("layers", LAYERS, PALETTE, {})).toMatch(
			/^<svg /,
		);
		expect(renderFigureSvg("team", TEAM, PALETTE, {})).toMatch(/^<svg /);
		expect(
			renderFigureSvg("timeline", chainSource(3), PALETTE, {
				caption: "Plan",
			}),
		).toContain("<title>Plan</title>");
	});

	it("ignores extra palette properties and refuses a role that is not a colour", () => {
		const themeLike = {
			...PALETTE,
			recipient: ["#123456"],
			fonts: { body: "Inter" },
		};
		expect(
			renderFigureSvg("process", chainSource(2), themeLike, {}),
		).toMatch(/^<svg /);
		expect(() =>
			renderFigureSvg(
				"process",
				chainSource(2),
				{ ...PALETTE, ink: 'red" onload="x' },
				{},
			),
		).toThrow(TypeError);
	});

	it("reads labels declared inline in an edge", () => {
		const model = parsed(
			lines("flowchart LR", 'a["First"] --> b("Second") -.->|Back| a'),
		);
		expect(model.nodes.map((node) => node.lines)).toEqual([
			["First"],
			["Second"],
		]);
		expect(model.edges[1]).toEqual({
			from: "b",
			to: "a",
			dashed: true,
			label: ["Back"],
		});
	});

	it("returns null when the parser or the shape check refuses", () => {
		expect(
			renderFigureSvg(
				"process",
				lines("flowchart TD", "click a x"),
				PALETTE,
				{},
			),
		).toBeNull();
		expect(
			renderFigureSvg("layers", chainSource(3), PALETTE, {}),
		).toBeNull();
		expect(renderFigureSvg("process", LAYERS, PALETTE, {})).toBeNull();
	});
});

describe("bars figure", () => {
	const INTER_ADVANCE = 12 * 0.62;
	const MONO_ADVANCE = 12 * 0.66 + 0.6;

	const SIX_BARS = lines(
		MARKER,
		"%% caption: Hours saved per week",
		"%% figure: bars",
		"xychart-beta horizontal",
		'  title "Weekly hours saved"',
		'  x-axis "Scenario" ["Expected · 5% uplift", "Faster review, fewer loops", Rollout, "Baseline", "Stretch goal", "Pilot team"]',
		'  y-axis "h" 0 --> 20',
		"  bar [12, 9.5, 15, 4, 18, 12.0]",
		"  line [12, 12, 12, 12, 12, 12]",
	);

	interface DrawnBar {
		x: number;
		width: number;
		fill: string;
	}

	function barsOf(svg: string): DrawnBar[] {
		return Array.from(
			svg.matchAll(
				/<rect class="bar" x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="14" rx="2" fill="(#[0-9a-f]+)"\/>/g,
			),
		).map((match) => ({
			x: Number(match[1]),
			width: Number(match[2]),
			fill: match[3],
		}));
	}

	/** Each `<text>` of `className`: its x, anchor, fill and text. */
	function textsOf(svg: string, className: string) {
		return Array.from(
			svg.matchAll(
				new RegExp(
					`<text class="${className}" ([^>]*)>([^<]*)</text>`,
					"g",
				),
			),
		).map(([, attributes, text]) => ({
			x: Number(/\bx="([\d.]+)"/.exec(attributes)?.[1]),
			anchor: /text-anchor="(\w+)"/.exec(attributes)?.[1] ?? "start",
			fill: /\bfill="([^"]+)"/.exec(attributes)?.[1],
			text,
		}));
	}

	function drawn(source: string, palette = PALETTE): string {
		return svgOf(renderFigureSvg("bars", source, palette, {}));
	}

	it("reads the figure line and draws through the bars parser", () => {
		expect(readFigureKind(SIX_BARS)).toBe("bars");
		expect(parseFigureSource(SIX_BARS)).toBeNull();
		const svg = svgOf(tryRenderFigure(SIX_BARS, PALETTE, {}));
		expectPrintGeometry(svg);
		expectSafeSvg(svg);
		expect(renderFigureSvg("process", SIX_BARS, PALETTE, {})).toBeNull();
	});

	it("parses labels, values as written, the unit, the range and the threshold", () => {
		expect(parseBarsSource(SIX_BARS)).toEqual({
			title: "Weekly hours saved",
			unit: "h",
			axisMax: { value: 20, text: "20" },
			bars: [
				{ label: "Expected · 5% uplift", value: 12, text: "12" },
				{
					label: "Faster review, fewer loops",
					value: 9.5,
					text: "9.5",
				},
				{ label: "Rollout", value: 15, text: "15" },
				{ label: "Baseline", value: 4, text: "4" },
				{ label: "Stretch goal", value: 18, text: "18" },
				{ label: "Pilot team", value: 12, text: "12.0" },
			],
			threshold: { value: 12, text: "12" },
		});
	});

	it("draws six bars: within the threshold in the primary, above it in a readable grey", () => {
		const svg = drawn(SIX_BARS);
		expectPrintGeometry(svg);
		const bars = barsOf(svg);
		expect(bars).toHaveLength(6);
		const grey = barsOverGrey(PALETTE.ink, PALETTE.surface);
		expect(bars.map((bar) => bar.fill)).toEqual([
			PALETTE.primary,
			PALETTE.primary,
			grey,
			PALETTE.primary,
			grey,
			PALETTE.primary,
		]);
		expect(grey).not.toBe(PALETTE.primary);
		expect(contrastRatio(grey, PALETTE.surface)).toBeGreaterThanOrEqual(3);
		// Lighter than the ink: mixed only as far as the floor needs.
		expect(contrastRatio(grey, PALETTE.surface)).toBeLessThan(
			contrastRatio(PALETTE.ink, PALETTE.surface),
		);
		// Bars scale to the value: 15 is 1.25 times 12.
		expect(bars[2].width / bars[0].width).toBeCloseTo(1.25, 2);
		// Every value prints as written, in mono muted, after its bar.
		const values = textsOf(svg, "bar-value");
		expect(values.map((value) => value.text)).toEqual([
			"12",
			"9.5",
			"15",
			"4",
			"18",
			"12.0",
		]);
		values.forEach((value, index) => {
			expect(value.fill).toBe(PALETTE.muted);
			expect(value.x).toBeCloseTo(
				bars[index].x + bars[index].width + 6,
				0,
			);
		});
		expect(svg).toMatch(/<text class="bar-value"[^>]*JetBrains Mono/);
	});

	it("draws the dashed threshold and its text at the threshold's x, in the label colour", () => {
		const svg = drawn(SIX_BARS);
		const line =
			/<line class="threshold" x1="([\d.]+)" y1="[\d.]+" x2="([\d.]+)" y2="[\d.]+" stroke="([^"]+)" stroke-width="1.3" stroke-dasharray="4 3"\/>/.exec(
				svg,
			);
		expect(line).not.toBeNull();
		const x = Number(line?.[1]);
		expect(Number(line?.[2])).toBe(x);
		expect(line?.[3]).toBe(PALETTE.label);
		// The first bar is exactly at the threshold: it ends on the line.
		const [atThreshold] = barsOf(svg);
		expect(atThreshold.x + atThreshold.width).toBeCloseTo(x, 0);
		expect(textsOf(svg, "threshold-label")).toEqual([
			{ x, anchor: "middle", fill: PALETTE.label, text: "12 h" },
		]);
		expect(svg).toMatch(/<text class="threshold-label"[^>]*JetBrains Mono/);
	});

	it("marks the axis ends in mono muted, the maximum with its unit", () => {
		const svg = drawn(SIX_BARS);
		const ends = textsOf(svg, "axis-end");
		expect(ends.map((end) => end.text)).toEqual(["0", "20 h"]);
		for (const end of ends) {
			expect(end.fill).toBe(PALETTE.muted);
		}
		const [first] = barsOf(svg);
		expect(ends[0].x).toBe(first.x);
		// The scale's maximum is where a bar of 20 would end.
		const twenty = first.x + (first.width / 12) * 20;
		expect(ends[1]).toMatchObject({ anchor: "end" });
		expect(ends[1].x).toBeCloseTo(twenty, 0);
	});

	it("labels the figure by its caption, then its chart title, then its kind", () => {
		expect(drawn(SIX_BARS)).toContain("<title>Weekly hours saved</title>");
		expect(
			svgOf(
				renderFigureSvg("bars", SIX_BARS, PALETTE, {
					caption: "Hours saved per week",
				}),
			),
		).toContain("<title>Hours saved per week</title>");
		const untitled = lines(
			"xychart-beta",
			"  x-axis [North, South]",
			"  bar [3, 7]",
		);
		expect(drawn(untitled)).toContain("<title>Bar chart</title>");
	});

	it("describes every full label with its value, in order, and the threshold", () => {
		const desc = /<desc>([^<]*)<\/desc>/.exec(drawn(SIX_BARS))?.[1];
		expect(desc).toBe(
			"Values in order: Expected · 5% uplift: 12 h; Faster review, fewer loops: 9.5 h; Rollout: 15 h (above the threshold); Baseline: 4 h; Stretch goal: 18 h (above the threshold); Pilot team: 12.0 h. Threshold: 12 h.",
		);
	});

	it("cuts a 40-character label left of the bars and keeps a value at the maximum inside the figure", () => {
		const label = "Expected · 5% uplift across every region";
		expect(Array.from(label)).toHaveLength(40);
		const svg = drawn(
			lines(
				"xychart-beta horizontal",
				`  x-axis ["${label}", "Short"]`,
				"  bar [1000, 40]",
			),
		);
		expectPrintGeometry(svg);
		const [top] = barsOf(svg);
		const [cut] = textsOf(svg, "bar-label");
		expect(cut.text).not.toBe(label);
		expect(cut.text.endsWith("…")).toBe(true);
		expect(label.startsWith(cut.text.slice(0, -1))).toBe(true);
		expect(cut.x).toBe(0);
		expect(Array.from(cut.text).length * INTER_ADVANCE).toBeLessThanOrEqual(
			top.x,
		);
		// 1000 is its own round maximum: the bar takes the whole bar area.
		const [value] = textsOf(svg, "bar-value");
		expect(value.text).toBe("1000");
		expect(value.x + 4 * MONO_ADVANCE).toBeLessThanOrEqual(
			FIGURE_WIDTH + 0.05,
		);
		expect(value.x + 4 * MONO_ADVANCE).toBeGreaterThan(FIGURE_WIDTH - 1);
		expect(svg).toContain(
			`<desc>Values in order: ${label}: 1000; Short: 40.</desc>`,
		);
	});

	it("gives the label column only the room its longest label needs", () => {
		const svg = drawn(
			lines("xychart-beta", "  x-axis [Q1, Q2, Q3]", "  bar [3, 5, 4]"),
		);
		const [bar] = barsOf(svg);
		expect(bar.x).toBe(Math.ceil(2 * INTER_ADVANCE) + 12);
	});

	it("draws every bar in the primary and no threshold without a line series", () => {
		const svg = drawn(
			lines(
				"xychart-beta horizontal",
				'  x-axis ["Expected · 5% uplift", Baseline, Stretch]',
				"  bar [12, 30, 4]",
			),
		);
		expect(barsOf(svg).map((bar) => bar.fill)).toEqual([
			PALETTE.primary,
			PALETTE.primary,
			PALETTE.primary,
		]);
		expect(svg).not.toContain("threshold");
		expect(svg).not.toContain("<line");
		expect(svg).not.toContain(PALETTE.label);
	});

	it("draws `xychart` without `horizontal` as the same chart", () => {
		const body = (header: string) =>
			lines(header, '  x-axis ["North", South]', "  bar [3, 7]");
		const expected = drawn(body("xychart-beta horizontal"));
		expect(drawn(body("xychart"))).toBe(expected);
		expect(drawn(body("xychart-beta"))).toBe(expected);
		expect(drawn(body("xychart horizontal"))).toBe(expected);
	});

	it("scales to the axis maximum only when it holds every value and the threshold", () => {
		const ends = (source: string) =>
			textsOf(drawn(source), "axis-end").map((end) => end.text);
		const chart = (...rest: string[]) =>
			lines("xychart-beta", "  x-axis [North, South]", ...rest);
		expect(ends(chart('  y-axis "h" 0 --> 40', "  bar [3, 7]"))).toEqual([
			"0",
			"40 h",
		]);
		// Below a value: rounded up from the largest value instead.
		expect(ends(chart('  y-axis "h" 0 --> 10', "  bar [3, 17]"))).toEqual([
			"0",
			"20 h",
		]);
		// Below the threshold, too.
		expect(
			ends(chart("  y-axis 0 --> 10", "  bar [3, 7]", "  line [12, 12]")),
		).toEqual(["0", "15"]);
		expect(ends(chart("  bar [3, 7]"))).toEqual(["0", "8"]);
		expect(ends(chart("  bar [0.12, 0.07]"))).toEqual(["0", "0.15"]);
		expect(ends(chart("  bar [1.2, 0.4]"))).toEqual(["0", "1.5"]);
		expect(ends(chart("  bar [0, 0]"))).toEqual(["0", "1"]);
		expect(ends(chart("  bar [1000000000, 2]"))).toEqual([
			"0",
			"1000000000",
		]);
	});

	it("keeps the threshold text inside the figure when the threshold is the maximum", () => {
		const svg = drawn(
			lines(
				"xychart-beta",
				"  x-axis [North, South]",
				'  y-axis "hours a week" 0 --> 10',
				"  bar [3, 7]",
				"  line [10, 10]",
			),
		);
		const [label] = textsOf(svg, "threshold-label");
		const half = (Array.from("10 hours a week").length * MONO_ADVANCE) / 2;
		expect(label.text).toBe("10 hours a week");
		expect(label.x + half).toBeLessThanOrEqual(FIGURE_WIDTH + 0.05);
		const [end] = textsOf(svg, "axis-end").slice(1);
		expect(end.x).toBeLessThanOrEqual(FIGURE_WIDTH);
	});

	it("reads quoted commas, escapes markup, and accepts comments and semicolons", () => {
		const model = parseBarsSource(
			lines(
				"%% figure: bars",
				"xychart-beta",
				"%% a note",
				'  x-axis ["A, then B", "<b>Tom & Jerry</b>"];',
				"  bar [1, 2];",
			),
		);
		expect(model?.bars.map((bar) => bar.label)).toEqual([
			"A, then B",
			"<b>Tom & Jerry</b>",
		]);
		const svg = drawn(
			lines(
				"xychart-beta",
				'  x-axis ["A, then B", "<b>Tom & Jerry</b>"]',
				"  bar [1, 2]",
			),
		);
		expect(svg).toContain("&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;");
		expect(svg).not.toContain("<b>");
		expectSafeSvg(svg);
	});

	it("paints with a palette written in short hex", () => {
		const short: FigurePalette = {
			...PALETTE,
			ink: "#111",
			surface: "#fff",
			primary: "#c40",
			label: "#930",
		};
		const svg = drawn(SIX_BARS, short);
		const grey = barsOverGrey("#111", "#fff");
		expect(grey).toMatch(/^#[0-9a-f]{6}$/);
		expect(contrastRatio(grey, "#ffffff")).toBeGreaterThanOrEqual(3);
		expect(barsOf(svg).map((bar) => bar.fill)).toContain(grey);
	});

	it("is deterministic, checks the palette and the id prefix, and ignores extra paint", () => {
		expect(drawn(SIX_BARS)).toBe(drawn(SIX_BARS));
		expect(
			renderFigureSvg(
				"bars",
				SIX_BARS,
				{ ...PALETTE, accent: "#123456" } as FigurePalette,
				{},
			),
		).toBe(drawn(SIX_BARS));
		expect(() =>
			renderFigureSvg(
				"bars",
				SIX_BARS,
				{ ...PALETTE, label: 'red" onload="x' },
				{},
			),
		).toThrow(TypeError);
		const { label: _label, ...withoutLabel } = PALETTE;
		expect(() =>
			renderFigureSvg(
				"bars",
				SIX_BARS,
				withoutLabel as FigurePalette,
				{},
			),
		).toThrow(TypeError);
		expect(
			tryRenderFigure(SIX_BARS, withoutLabel as FigurePalette),
		).toBeNull();
		expect(() =>
			renderFigureSvg("bars", SIX_BARS, PALETTE, { idPrefix: "1bad" }),
		).toThrow(TypeError);
	});

	it.each([
		["two bar series", ["  bar [1, 2]", "  bar [3, 4]"]],
		["a line that is not flat", ["  bar [1, 2]", "  line [5, 6]"]],
		["two line series", ["  bar [1, 2]", "  line [5, 5]", "  line [6, 6]"]],
		["a negative value", ["  bar [-1, 2]"]],
		["a signed value", ["  bar [+1, 2]"]],
		["a quoted value", ['  bar ["1", 2]']],
		["a value past the limit", ["  bar [1000000001, 2]"]],
		["a value written too long", ["  bar [1.000000000000000, 2]"]],
		["a bar series shorter than the axis", ["  bar [1]"]],
		["a line series shorter than the axis", ["  bar [1, 2]", "  line [5]"]],
		["no bar series", []],
		["an axis minimum other than 0", ["  y-axis 2 --> 10", "  bar [3, 4]"]],
		["a negative axis minimum", ["  y-axis -5 --> 10", "  bar [3, 4]"]],
		["an empty axis range", ["  y-axis 0 --> 0", "  bar [0, 0]"]],
		[
			"two y-axes",
			["  y-axis 0 --> 10", "  y-axis 0 --> 20", "  bar [1, 2]"],
		],
		[
			"a unit past 24 characters",
			[
				'  y-axis "hours of review saved each week" 0 --> 10',
				"  bar [1, 2]",
			],
		],
		["an unknown statement", ["  bar [1, 2]", "  accTitle: Hours"]],
		["a trailing comment", ["  bar [1, 2] %% note"]],
		["two titles", ['  title "A"', '  title "B"', "  bar [1, 2]"]],
	])("refuses %s", (_, rest) => {
		const source = lines(
			"%% figure: bars",
			"xychart-beta horizontal",
			"  x-axis [North, South]",
			...rest,
		);
		expect(parseBarsSource(source)).toBeNull();
		expect(renderFigureSvg("bars", source, PALETTE, {})).toBeNull();
	});

	it.each([
		[
			"an init directive",
			[
				"%%{init: {}}%%",
				"xychart-beta",
				"  x-axis [A, B]",
				"  bar [1, 2]",
			],
		],
		[
			"frontmatter",
			[
				"---",
				"title: x",
				"---",
				"xychart-beta",
				"  x-axis [A, B]",
				"  bar [1, 2]",
			],
		],
		[
			"a vertical chart",
			["xychart-beta vertical", "  x-axis [A, B]", "  bar [1, 2]"],
		],
		[
			"a header in capitals",
			["XYCHART-BETA", "  x-axis [A, B]", "  bar [1, 2]"],
		],
		["a flowchart", ["flowchart TD", "  a --> b"]],
		["no x-axis", ["xychart-beta", "  bar [1, 2]"]],
		[
			"a numeric x-axis",
			["xychart-beta", "  x-axis 0 --> 10", "  bar [1, 2]"],
		],
		[
			"two x-axes",
			[
				"xychart-beta",
				"  x-axis [A, B]",
				"  x-axis [C, D]",
				"  bar [1, 2]",
			],
		],
		["one bar", ["xychart-beta", "  x-axis [A]", "  bar [1]"]],
		[
			"thirteen bars",
			[
				"xychart-beta",
				`  x-axis [${Array.from({ length: 13 }, (_, index) => `c${index}`).join(", ")}]`,
				`  bar [${Array.from({ length: 13 }, () => "1").join(", ")}]`,
			],
		],
		[
			"a label past 40 characters",
			[
				"xychart-beta",
				'  x-axis ["Expected · 5% uplift across every regions", B]',
				"  bar [1, 2]",
			],
		],
		[
			"an unquoted label with a space",
			["xychart-beta", "  x-axis [North east, South]", "  bar [1, 2]"],
		],
		[
			"an empty label",
			["xychart-beta", '  x-axis ["", South]', "  bar [1, 2]"],
		],
		[
			"an empty item",
			["xychart-beta", "  x-axis [North,, South]", "  bar [1, 2]"],
		],
		[
			"an unclosed quote",
			["xychart-beta", '  x-axis ["North, South]', "  bar [1, 2]"],
		],
		[
			"a Markdown label",
			["xychart-beta", '  x-axis ["`**North**`", South]', "  bar [1, 2]"],
		],
		[
			"text after the list",
			["xychart-beta", "  x-axis [North, South] extra", "  bar [1, 2]"],
		],
	])("refuses %s", (_, source) => {
		expect(parseBarsSource(lines(...source))).toBeNull();
	});

	it("passes the export cleaner's allowlist with its threshold line", () => {
		expectSafeSvg(drawn(SIX_BARS));
		expect(drawn(SIX_BARS)).toMatch(/^<svg [^>]*role="img"/);
	});

	it("draws directly from a parsed model", () => {
		const model = parseBarsSource(SIX_BARS);
		if (!model) {
			throw new Error("expected the bars source to parse");
		}
		expect(barsFigureSvg(model, PALETTE)).toBe(drawn(SIX_BARS));
	});
});

describe("gantt figure", () => {
	/** A `YYYY-MM-DD` date as the parser counts it: days since 1970, UTC. */
	const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

	const PLAN = lines(
		MARKER,
		"%% caption: Pilot schedule by workstream",
		"%% figure: gantt",
		"gantt",
		"  title Pilot schedule",
		"  dateFormat YYYY-MM-DD",
		"  section Discovery",
		"  Interviews :d1, 2026-11-02, 2w",
		"  Signature :milestone, m0, 2026-11-02, 0d",
		"  section Build",
		"  Routing :b1, after d1, 21d",
		"  Work orders :b2, after b1, 3w",
		"  First route live :milestone, m1, 2026-12-07, 0d",
		"  section Pilot",
		"  Region one :p1, after b2, 4w",
		"  Pilot review :milestone, m2, 2027-02-01, 0d",
	);

	/** Each `<text>` of `className`: its x, y, anchor, fill and text. */
	function textsOf(svg: string, className: string) {
		return Array.from(
			svg.matchAll(
				new RegExp(
					`<text class="${className}" ([^>]*)>(.*?)</text>`,
					"g",
				),
			),
		).map(([, attributes, text]) => ({
			x: Number(/\bx="([\d.]+)"/.exec(attributes)?.[1]),
			y: Number(/\by="([\d.]+)"/.exec(attributes)?.[1]),
			anchor: /text-anchor="(\w+)"/.exec(attributes)?.[1] ?? "start",
			fill: /\bfill="([^"]+)"/.exec(attributes)?.[1],
			text: text
				.replace(/<[^>]+>/g, " ")
				.replace(/\s+/g, " ")
				.trim(),
		}));
	}

	function tasksOf(svg: string) {
		return Array.from(
			svg.matchAll(
				/<rect class="task" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="14" rx="2" fill="(#[0-9a-f]+)"\/>/g,
			),
		).map((match) => ({
			x: Number(match[1]),
			y: Number(match[2]),
			width: Number(match[3]),
			fill: match[4],
		}));
	}

	function gridOf(svg: string): number[] {
		return Array.from(
			svg.matchAll(/<line class="grid" x1="([\d.]+)"/g),
		).map((match) => Number(match[1]));
	}

	function drawn(source: string, palette = PALETTE): string {
		return svgOf(renderFigureSvg("gantt", source, palette, {}));
	}

	function plan(...rest: string[]): string {
		return lines(
			"%% figure: gantt",
			"gantt",
			"  dateFormat YYYY-MM-DD",
			...rest,
		);
	}

	it("reads the figure line and draws through the gantt parser", () => {
		expect(readFigureKind(PLAN)).toBe("gantt");
		expect(parseFigureSource(PLAN)).toBeNull();
		const svg = svgOf(tryRenderFigure(PLAN, PALETTE, {}));
		expectPrintGeometry(svg);
		expectSafeSvg(svg);
		expect(renderFigureSvg("process", PLAN, PALETTE, {})).toBeNull();
		expect(
			renderFigureSvg("gantt", chainSource(3), PALETTE, {}),
		).toBeNull();
	});

	it("parses sections, tasks after one another, weeks and milestones", () => {
		expect(parseGanttSource(PLAN)).toEqual({
			title: "Pilot schedule",
			sections: ["Discovery", "Build", "Pilot"],
			tasks: [
				{
					id: "d1",
					name: "Interviews",
					section: 0,
					start: day("2026-11-02"),
					end: day("2026-11-16"),
				},
				{
					id: "b1",
					name: "Routing",
					section: 1,
					start: day("2026-11-16"),
					end: day("2026-12-07"),
				},
				{
					id: "b2",
					name: "Work orders",
					section: 1,
					start: day("2026-12-07"),
					end: day("2026-12-28"),
				},
				{
					id: "p1",
					name: "Region one",
					section: 2,
					start: day("2026-12-28"),
					end: day("2027-01-25"),
				},
			],
			milestones: [
				{
					id: "m0",
					name: "Signature",
					section: 0,
					day: day("2026-11-02"),
				},
				{
					id: "m1",
					name: "First route live",
					section: 1,
					day: day("2026-12-07"),
				},
				{
					id: "m2",
					name: "Pilot review",
					section: 2,
					day: day("2027-02-01"),
				},
			],
		});
	});

	it("reads keywords in any case, a milestone as the start of a task after it, and a plan without a title", () => {
		const model = parseGanttSource(
			plan(
				"  Section Build",
				"  Kickoff :milestone, k, 2026-11-02, 0d",
				"  Routing :r1, after k, 1d",
			).replace("dateFormat", "DATEFORMAT"),
		);
		expect(model?.title).toBeNull();
		expect(model?.sections).toEqual(["Build"]);
		expect(model?.tasks[0]).toMatchObject({
			start: day("2026-11-02"),
			end: day("2026-11-03"),
		});
	});

	it("numbers a week column for every week, from the plan's first day", () => {
		const svg = drawn(PLAN);
		// 2026-11-02 to 2027-02-01 is thirteen weeks.
		const weeks = textsOf(svg, "week");
		expect(weeks.map((week) => week.text)).toEqual(
			Array.from({ length: 13 }, (_, index) => `W${index + 1}`),
		);
		const grid = gridOf(svg);
		expect(grid).toHaveLength(14);
		const origin = grid[0];
		const end = grid[grid.length - 1];
		expect(end).toBeCloseTo(FIGURE_WIDTH - 8, 0);
		const column = (end - origin) / 13;
		weeks.forEach((week, index) => {
			expect(week.x).toBeCloseTo(origin + (index + 0.5) * column, 0);
			expect(week.anchor).toBe("middle");
			expect(week.fill).toBe(PALETTE.muted);
		});
		// The date week 1 begins, in the label column.
		const [start] = textsOf(svg, "week-start");
		expect(start?.text).toBe("2026-11-02");
		expect(start?.x).toBeLessThan(origin);
	});

	it("draws each task from its first day to its last, the first section muted and the others in the primary", () => {
		const svg = drawn(PLAN);
		const grid = gridOf(svg);
		const origin = grid[0];
		const dayWidth = (grid[grid.length - 1] - origin) / (13 * 7);
		const tasks = tasksOf(svg);
		expect(tasks.map((task) => task.fill)).toEqual([
			PALETTE.muted,
			PALETTE.primary,
			PALETTE.primary,
			PALETTE.primary,
		]);
		// Routing starts on day 14 and lasts 21 days, inset by a pixel.
		expect(tasks[1]?.x).toBeCloseTo(origin + 14 * dayWidth + 1, 0);
		expect(tasks[1]?.width).toBeCloseTo(21 * dayWidth - 2, 0);
		// Back to back, the next task's bar starts after a gap.
		const routing = tasks[1];
		const workOrders = tasks[2];
		if (!routing || !workOrders) {
			throw new Error("expected the tasks");
		}
		expect(workOrders.x).toBeGreaterThan(routing.x + routing.width);
		expect(workOrders.y).toBeGreaterThan(routing.y);
	});

	it("draws every bar in the primary with one section", () => {
		const svg = drawn(
			plan(
				"  section Build",
				"  Routing :a1, 2026-11-02, 1w",
				"  Work orders :a2, after a1, 1w",
			),
		);
		expect(tasksOf(svg).map((task) => task.fill)).toEqual([
			PALETTE.primary,
			PALETTE.primary,
		]);
	});

	it("puts every name in the label column, ending before the first week, and every section heading in mono capitals", () => {
		const svg = drawn(PLAN);
		const origin = gridOf(svg)[0];
		const labels = textsOf(svg, "task-label");
		expect(labels.map((label) => label.text)).toEqual([
			"Interviews",
			"Routing",
			"Work orders",
			"Region one",
		]);
		for (const label of labels) {
			expect(label.anchor).toBe("end");
			expect(label.x).toBeLessThanOrEqual(origin - 12);
			expect(label.fill).toBe(PALETTE.ink);
		}
		for (const task of tasksOf(svg)) {
			expect(task.x).toBeGreaterThanOrEqual(origin);
			expect(task.x + task.width).toBeLessThanOrEqual(FIGURE_WIDTH);
		}
		const headings = textsOf(svg, "section");
		expect(headings.map((heading) => heading.text)).toEqual([
			"DISCOVERY",
			"BUILD",
			"PILOT",
		]);
		expect(svg).toContain(
			'class="section" x="0" y="41" font-family="\'JetBrains Mono\', ui-monospace, monospace"',
		);
	});

	it("cuts a long name with an ellipsis within the 200 px label column", () => {
		const long = "A programme of work far longer than the label column";
		const svg = drawn(
			plan("  section Build", `  ${long} :a1, 2026-11-02, 2w`),
		);
		const [label] = textsOf(svg, "task-label");
		expect(label?.text.endsWith("…")).toBe(true);
		expect(
			Array.from(label?.text ?? "").length * 12 * 0.62,
		).toBeLessThanOrEqual(200);
		expect(gridOf(svg)[0]).toBe(212);
		expect(svg).toContain(
			`<desc>Week 1 begins 2026-11-02. Build: ${long}, `,
		);
	});

	it("draws each milestone as a diamond in the label colour on a dashed line, with its name and date", () => {
		const svg = drawn(PLAN);
		const diamonds = Array.from(
			svg.matchAll(
				/<path class="milestone" d="M ([\d.]+) [^"]*" fill="([^"]+)"\/>/g,
			),
		);
		expect(diamonds).toHaveLength(3);
		for (const [, , fill] of diamonds) {
			expect(fill).toBe(PALETTE.label);
		}
		const guides = Array.from(
			svg.matchAll(/<line class="milestone-guide" ([^>]*)\/>/g),
		);
		expect(guides).toHaveLength(3);
		for (const [, attributes] of guides) {
			expect(attributes).toContain(`stroke="${PALETTE.label}"`);
			expect(attributes).toContain('stroke-dasharray="3 3"');
		}
		const grid = gridOf(svg);
		// The last milestone, on the plan's last day, sits on the last line.
		expect(Number(diamonds[2]?.[1])).toBeCloseTo(grid[grid.length - 1], 0);
		expect(
			textsOf(svg, "milestone-label").map((label) => label.text),
		).toEqual(["Signature", "First route live", "Pilot review"]);
		const dates = textsOf(svg, "milestone-date");
		expect(dates.map((date) => date.text)).toEqual([
			"2026-11-02",
			"2026-12-07",
			"2027-02-01",
		]);
		for (const date of dates) {
			expect(date.fill).toBe(PALETTE.label);
		}
	});

	it("moves a milestone label that would touch the one before it to a line of its own, inside the figure", () => {
		const svg = drawn(
			plan(
				"  section Build",
				"  Routing :a1, 2026-11-02, 4w",
				"  Contract signed :milestone, m1, 2026-11-30, 0d",
				"  Review with the operations sponsor :milestone, m2, 2026-12-01, 0d",
			),
		);
		const labels = textsOf(svg, "milestone-label");
		expect(labels).toHaveLength(2);
		expect(labels[1]?.y).toBeGreaterThan(labels[0]?.y ?? 0);
		// The second name wraps to two lines, then its date.
		expect(labels[1]?.text).toBe("Review with the operations sponsor");
		const [, secondDate] = textsOf(svg, "milestone-date");
		expect(secondDate?.y).toBe((labels[1]?.y ?? 0) + 32);
		const height = Number(/height="([\d.]+)"/.exec(svg)?.[1]);
		expect(height).toBeGreaterThan((secondDate?.y ?? 0) + 3);
		for (const label of [...labels, ...textsOf(svg, "milestone-date")]) {
			expect(label.x).toBeLessThanOrEqual(FIGURE_WIDTH);
		}
	});

	it("thins the week numbers of a long plan so they never touch", () => {
		const svg = drawn(
			plan(
				"  section Year",
				"  A year of work :y1, 2026-01-05, 52w",
				"  Midpoint :milestone, mm, 2026-07-06, 0d",
			),
		);
		const weeks = textsOf(svg, "week");
		expect(weeks.map((week) => week.text)).toEqual(
			Array.from({ length: 13 }, (_, index) => `W${index * 4 + 1}`),
		);
		const width = 3 * (12 * 0.66 + 0.6);
		for (let index = 1; index < weeks.length; index += 1) {
			expect(
				(weeks[index]?.x ?? 0) - (weeks[index - 1]?.x ?? 0),
			).toBeGreaterThanOrEqual(width);
		}
		expectPrintGeometry(svg);
	});

	it("describes the start, every task with its dates in section order, and the milestones", () => {
		expect(/<desc>([^<]*)<\/desc>/.exec(drawn(PLAN))?.[1]).toBe(
			"Week 1 begins 2026-11-02. Discovery: Interviews, 2026-11-02 to 2026-11-15. Build: Routing, 2026-11-16 to 2026-12-06; Work orders, 2026-12-07 to 2026-12-27. Pilot: Region one, 2026-12-28 to 2027-01-24. Milestones: Signature, 2026-11-02; First route live, 2026-12-07; Pilot review, 2027-02-01.",
		);
		expect(
			drawn(plan("  section Build", "  Kickoff :k1, 2026-11-02, 1d")),
		).toContain("Build: Kickoff, 2026-11-02.</desc>");
	});

	it("labels the figure by its caption, then its chart title, then its kind", () => {
		const model = parseGanttSource(PLAN);
		if (!model) {
			throw new Error("expected the plan to parse");
		}
		expect(ganttFigureSvg(model, PALETTE, { caption: "Plan" })).toContain(
			"<title>Plan</title>",
		);
		expect(ganttFigureSvg(model, PALETTE)).toContain(
			"<title>Pilot schedule</title>",
		);
		expect(ganttFigureSvg({ ...model, title: null }, PALETTE)).toContain(
			"<title>Gantt chart</title>",
		);
	});

	it("escapes markup in names", () => {
		const svg = drawn(
			plan(
				"  section <b>Build</b> & run",
				'  Route "A" <script> :a1, 2026-11-02, 1w',
			),
		);
		expectSafeSvg(svg);
		expect(svg).not.toContain("<script>");
		expect(svg).not.toContain("<b>");
		expect(drawnTexts(svg)).toContain("Route &quot;A&quot; &lt;script&gt;");
		expect(drawnTexts(svg)).toContain("&lt;B&gt;BUILD&lt;/B&gt; &amp; RUN");
	});

	it("is deterministic, checks the palette and the id prefix, and ignores extra paint", () => {
		expect(drawn(PLAN)).toBe(drawn(PLAN));
		expect(
			renderFigureSvg(
				"gantt",
				PLAN,
				{ ...PALETTE, accent: "#123456" } as FigurePalette,
				{},
			),
		).toBe(drawn(PLAN));
		expect(() =>
			renderFigureSvg(
				"gantt",
				PLAN,
				{ ...PALETTE, label: 'red" onload="x' },
				{},
			),
		).toThrow(TypeError);
		expect(() =>
			renderFigureSvg("gantt", PLAN, PALETTE, { idPrefix: "1bad" }),
		).toThrow(TypeError);
		const { label: _label, ...withoutLabel } = PALETTE;
		expect(tryRenderFigure(PLAN, withoutLabel as FigurePalette)).toBeNull();
	});

	it.each([
		["a tag", ["  section A", "  Routing :crit, a1, 2026-11-02, 1w"]],
		["a done tag", ["  section A", "  Routing :done, a1, 2026-11-02, 1w"]],
		[
			"a tag word as the id",
			["  section A", "  Routing :crit, 2026-11-02, 1w"],
		],
		["no id", ["  section A", "  Routing :2026-11-02, 1w"]],
		[
			"an end date",
			["  section A", "  Routing :a1, 2026-11-02, 2026-11-20"],
		],
		[
			"a duration in hours",
			["  section A", "  Routing :a1, 2026-11-02, 24h"],
		],
		["a zero-day task", ["  section A", "  Routing :a1, 2026-11-02, 0d"]],
		[
			"a fractional duration",
			["  section A", "  Routing :a1, 2026-11-02, 1.5w"],
		],
		[
			"a date that does not exist",
			["  section A", "  Routing :a1, 2026-02-30, 1w"],
		],
		[
			"`after` an unknown id",
			["  section A", "  Routing :a1, after x9, 1w"],
		],
		[
			"`after` a task declared below",
			[
				"  section A",
				"  Routing :a1, after a2, 1w",
				"  Orders :a2, 2026-11-02, 1w",
			],
		],
		[
			"`after` two ids",
			[
				"  section A",
				"  Routing :a1, 2026-11-02, 1w",
				"  Orders :a2, 2026-11-02, 1w",
				"  Review :a3, after a1 a2, 1w",
			],
		],
		[
			"a duplicate id",
			[
				"  section A",
				"  Routing :a1, 2026-11-02, 1w",
				"  Orders :a1, 2026-11-09, 1w",
			],
		],
		[
			"a milestone that lasts",
			[
				"  section A",
				"  Routing :a1, 2026-11-02, 1w",
				"  Live :milestone, m1, 2026-11-09, 1d",
			],
		],
		[
			"a milestone after a task",
			[
				"  section A",
				"  Routing :a1, 2026-11-02, 1w",
				"  Live :milestone, m1, after a1, 0d",
			],
		],
		[
			"a milestone alone",
			["  section A", "  Live :milestone, m1, 2026-11-09, 0d"],
		],
		["a task before the first section", ["  Routing :a1, 2026-11-02, 1w"]],
		[
			"excluded days",
			[
				"  excludes weekends",
				"  section A",
				"  Routing :a1, 2026-11-02, 1w",
			],
		],
		[
			"an axis format",
			["  axisFormat %d", "  section A", "  Routing :a1, 2026-11-02, 1w"],
		],
		[
			"a today marker",
			[
				"  todayMarker off",
				"  section A",
				"  Routing :a1, 2026-11-02, 1w",
			],
		],
		[
			"a click line",
			[
				"  section A",
				"  Routing :a1, 2026-11-02, 1w",
				'  click a1 href "https://example.com"',
			],
		],
		[
			"an accessible title",
			[
				"  accTitle: Plan",
				"  section A",
				"  Routing :a1, 2026-11-02, 1w",
			],
		],
		[
			"a second date format",
			[
				"  dateFormat YYYY-MM-DD",
				"  section A",
				"  Routing :a1, 2026-11-02, 1w",
			],
		],
		[
			"two titles",
			[
				"  title A",
				"  title B",
				"  section A",
				"  Routing :a1, 2026-11-02, 1w",
			],
		],
		[
			"a line that is no statement",
			["  section A", "  Routing a1 2026-11-02 1w"],
		],
		[
			"a comment after the data",
			["  section A", "  Routing :a1, 2026-11-02, 1w # note"],
		],
		["a semicolon", ["  section A", "  Routing :a1, 2026-11-02, 1w;"]],
		[
			"a single-percent comment",
			["  section A", "  % note", "  Routing :a1, 2026-11-02, 1w"],
		],
		[
			"a name past 60 characters",
			["  section A", `  ${"Routing ".repeat(8)}:a1, 2026-11-02, 1w`],
		],
		[
			"a plan past 52 weeks",
			["  section A", "  Routing :a1, 2026-01-05, 53w"],
		],
		[
			"21 tasks",
			[
				"  section A",
				...Array.from(
					{ length: 21 },
					(_, index) => `  Task ${index} :t${index}, 2026-11-02, 1w`,
				),
			],
		],
		[
			"9 milestones",
			[
				"  section A",
				"  Routing :a1, 2026-11-02, 1w",
				...Array.from(
					{ length: 9 },
					(_, index) =>
						`  Mark ${index} :milestone, m${index}, 2026-11-02, 0d`,
				),
			],
		],
		[
			"9 sections",
			Array.from({ length: 9 }, (_, index) => [
				`  section S${index}`,
				`  Task ${index} :t${index}, 2026-11-02, 1w`,
			]).flat(),
		],
	])("refuses %s", (_, rest) => {
		const source = plan(...rest);
		expect(parseGanttSource(source)).toBeNull();
		expect(renderFigureSvg("gantt", source, PALETTE, {})).toBeNull();
	});

	it.each([
		[
			"an init directive",
			[
				"%%{init: {}}%%",
				"gantt",
				"  dateFormat YYYY-MM-DD",
				"  section A",
				"  Routing :a1, 2026-11-02, 1w",
			],
		],
		[
			"frontmatter",
			[
				"---",
				"title: x",
				"---",
				"gantt",
				"  dateFormat YYYY-MM-DD",
				"  section A",
				"  Routing :a1, 2026-11-02, 1w",
			],
		],
		[
			"a header in capitals",
			[
				"GANTT",
				"  dateFormat YYYY-MM-DD",
				"  section A",
				"  Routing :a1, 2026-11-02, 1w",
			],
		],
		[
			"no date format",
			["gantt", "  section A", "  Routing :a1, 2026-11-02, 1w"],
		],
		[
			"another date format",
			[
				"gantt",
				"  dateFormat DD-MM-YYYY",
				"  section A",
				"  Routing :a1, 02-11-2026, 1w",
			],
		],
		["no task", ["gantt", "  dateFormat YYYY-MM-DD", "  section A"]],
		["a flowchart", ["flowchart TD", "  a --> b"]],
	])("refuses %s", (_, source) => {
		expect(parseGanttSource(lines(...source))).toBeNull();
	});

	it("passes the export cleaner's allowlist with its milestones", () => {
		expectSafeSvg(drawn(PLAN));
		expect(drawn(PLAN)).toMatch(/^<svg [^>]*role="img"/);
	});
});

describe("figure outlines", () => {
	interface PaintedRect {
		left: number;
		top: number;
		right: number;
		bottom: number;
	}

	/**
	 * Every `<rect>` as the area it paints: its box, widened on each side by
	 * half its stroke (1 when `stroke` is set without a width).
	 */
	function paintedRects(svg: string): PaintedRect[] {
		return Array.from(svg.matchAll(/<rect ([^>]*)\/>/g)).map(
			([, attributes]) => {
				const read = (name: string) =>
					new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(
						attributes,
					)?.[1];
				const half =
					read("stroke") === undefined
						? 0
						: Number(read("stroke-width") ?? 1) / 2;
				const x = Number(read("x") ?? 0);
				const y = Number(read("y") ?? 0);
				return {
					left: x - half,
					top: y - half,
					right: x + Number(read("width")) + half,
					bottom: y + Number(read("height")) + half,
				};
			},
		);
	}

	const timeline = () =>
		timelineToMermaid(
			{
				kind: "timeline",
				items: [
					{ date: "Week 1", label: "Kickoff" },
					{ date: "Weeks 2-5", label: "First build" },
					{ date: "Weeks 6-9", label: "Pilot region" },
					{ date: "Weeks 10-12", label: "Review" },
				],
			},
			PROPOSAL_VISUAL_TEMPLATE_OPTIONS,
		);

	it.each<[string, () => string | null]>([
		[
			"a process filling its row",
			() => processFigureSvg(parsed(chainSource(4)), PALETTE, {}),
		],
		[
			"a process with a loop",
			() =>
				processFigureSvg(
					parsed(chainSource(5, ["n5 -.->|Next| n1"])),
					PALETTE,
					{},
				),
		],
		[
			"a timeline filling its row",
			() =>
				processFigureSvg(parsed(timeline()), PALETTE, { dated: true }),
		],
		["layers", () => layersFigureSvg(parsed(LAYERS), PALETTE, {})],
		[
			"layers without a cross-cutting column",
			() =>
				layersFigureSvg(
					parsed(
						lines(
							"flowchart TB",
							"subgraph a",
							'x["Only"]',
							'y["Second"]',
							"end",
						),
					),
					PALETTE,
					{},
				),
		],
		["a team", () => teamFigureSvg(parsed(TEAM), PALETTE, {})],
		[
			"a bar chart",
			() =>
				renderFigureSvg(
					"bars",
					lines(
						"xychart-beta horizontal",
						'  x-axis ["Baseline", "Pilot"]',
						"  bar [4, 20]",
						"  line [20, 20]",
					),
					PALETTE,
					{},
				),
		],
		[
			"a gantt chart",
			() =>
				renderFigureSvg(
					"gantt",
					lines(
						"gantt",
						"  dateFormat YYYY-MM-DD",
						"  section Build",
						"  Routing :b1, 2026-11-02, 3w",
						"  Done :milestone, m1, 2026-11-23, 0d",
					),
					PALETTE,
					{},
				),
		],
	])("paints every outline of %s inside the figure", (_name, draw) => {
		const svg = svgOf(draw());
		const height = Number(
			/viewBox="0 0 662 ([\d.]+)"/.exec(svg)?.[1] ?? Number.NaN,
		);
		const rects = paintedRects(svg);
		expect(rects.length).toBeGreaterThan(0);
		const epsilon = 1e-6;
		const outside = rects.flatMap((rect, index) =>
			[
				rect.left < -epsilon ? `rect ${index} left ${rect.left}` : "",
				rect.top < -epsilon ? `rect ${index} top ${rect.top}` : "",
				rect.right > FIGURE_WIDTH + epsilon
					? `rect ${index} right ${rect.right}`
					: "",
				rect.bottom > height + epsilon
					? `rect ${index} bottom ${rect.bottom} of ${height}`
					: "",
			].filter(Boolean),
		);
		expect(outside).toEqual([]);
	});
});
