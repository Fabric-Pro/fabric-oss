import { describe, expect, it } from "vitest";
import {
	flowToMermaid,
	PROPOSAL_VISUAL_TEMPLATE_OPTIONS,
	proposalVisualTemplateOptions,
	timelineToMermaid,
	visualSpecToMermaid,
} from "../lib/glossy/visual-templates";
import { withDiagramCaption } from "../lib/proposal-artifact/diagram-caption";
import {
	FIGURE_LINE,
	FIGURE_WIDTH,
	type FigureModel,
	type FigurePalette,
	layersFigureSvg,
	parseFigureSource,
	processFigureSvg,
	readFigureKind,
	renderFigureSvg,
	teamFigureSvg,
	withFigureKind,
} from "../lib/proposal-artifact/proposal-figures";

const lines = (...parts: string[]) => parts.join("\n");

const ZWSP = String.fromCharCode(0x200b);

const PALETTE: FigurePalette = {
	ink: "#16171a",
	onInk: "#ffffff",
	primary: "#c2410c",
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
		expect(readFigureKind(lines("%% figure: gantt", "flowchart TD"))).toBe(
			null,
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
