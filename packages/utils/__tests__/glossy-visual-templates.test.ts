import { describe, expect, it } from "vitest";
import {
	type ComparisonVisualSpec,
	type FlowVisualSpec,
	type OrgChartVisualSpec,
	type StatVisualSpec,
	type TimelineVisualSpec,
	visualSpecSchema,
} from "../lib/glossy/visual-spec";
import {
	SVG_CARD_FONT_STACK,
	VISUAL_COLOR_PLACEHOLDERS,
	comparisonToSvgCard,
	escapeMermaidLabel,
	escapeXmlText,
	flowToMermaid,
	orgChartToMermaid,
	statToSvgCard,
	timelineToMermaid,
	visualSpecToMermaid,
	visualSpecToSvgCard,
} from "../lib/glossy/visual-templates";

describe("escapeMermaidLabel", () => {
	const ZWSP = "\u200B";

	it("keeps a plain label unchanged", () => {
		expect(escapeMermaidLabel("Pilot launch")).toBe("Pilot launch");
	});

	it("leaves brackets, parentheses, braces, percent, and a lone # as typed", () => {
		expect(escapeMermaidLabel("Phase 1 (Q1)")).toBe("Phase 1 (Q1)");
		expect(escapeMermaidLabel("85–90%")).toBe("85–90%");
		expect(escapeMermaidLabel("C#")).toBe("C#");
		expect(escapeMermaidLabel("a[b]c{d}e - end")).toBe("a[b]c{d}e - end");
		// No full-width look-alike is introduced anywhere.
		expect(escapeMermaidLabel(`a"b[c]d(e)f{g}h%%i#j;`)).not.toMatch(
			/[\uFF00-\uFFEF]/,
		);
	});

	it("writes > as &gt;, which Mermaid's SVG text decodes rather than drops", () => {
		expect(escapeMermaidLabel("A -> B")).toBe("A -&gt; B");
		expect(escapeMermaidLabel("-->")).toBe("--&gt;");
	});

	it("turns straight double quotes into typographic ones", () => {
		expect(escapeMermaidLabel('say "hi"')).toBe("say “hi”");
		expect(escapeMermaidLabel('"a" and "b"')).toBe("“a” and “b”");
		// An unpaired last quote closes.
		expect(escapeMermaidLabel('5" screen')).toBe("5” screen");
		expect(escapeMermaidLabel('a "b" c"')).toBe("a “b” c”");
	});

	it("neutralizes a quote/newline/click injection attempt", () => {
		const malicious = '"]\nclick A href "javascript:alert(1)""';
		const escaped = escapeMermaidLabel(malicious);

		expect(escaped).toBe("“] click A href ”javascript:alert(1)“”");
		// No raw double quote survives, so wrapping the result in our own
		// `"..."` label quotes cannot be terminated early by attacker text,
		// and the `]` stays inside the quoted string.
		expect(escaped).not.toContain('"');
		const wrapped = `n0["${escaped}"]`;
		expect(wrapped.match(/"/g)).toHaveLength(2);
		// No literal newline/carriage return survives, so the label cannot
		// put its text at the start of a second Mermaid line.
		expect(escaped).not.toMatch(/[\r\n]/);
	});

	it("collapses embedded newlines and carriage returns to a space", () => {
		expect(escapeMermaidLabel("line one\nline two\r\nline three")).toBe(
			"line one line two line three",
		);
	});

	it("breaks every %% so no directive or comment can form", () => {
		const escaped = escapeMermaidLabel(
			`%%{init: {'securityLevel':'loose'}}%% then %%% more`,
		);
		expect(escaped).not.toContain("%%");
		expect(escaped).toBe(
			`%${ZWSP}%{init: {'securityLevel':'loose'}}%${ZWSP}% then %${ZWSP}%${ZWSP}% more`,
		);
		expect(escapeMermaidLabel("%% comment")).toBe(`%${ZWSP}% comment`);
	});

	it("breaks Mermaid entity codes so they display literally", () => {
		expect(escapeMermaidLabel("#40;")).toBe(`#${ZWSP}40;`);
		expect(escapeMermaidLabel("#lt;script#gt;")).toBe(
			`#${ZWSP}lt;script#${ZWSP}gt;`,
		);
		expect(escapeMermaidLabel("##35;")).toBe(`##${ZWSP}35;`);
		// A `#` not followed by `word;` is left alone.
		expect(escapeMermaidLabel("C# #1 #tag")).toBe("C# #1 #tag");
		expect(escapeMermaidLabel("#40;")).not.toMatch(/#\w+;/);
	});

	it("breaks a tag opener so neither Mermaid nor the sanitizer sees a tag", () => {
		expect(escapeMermaidLabel("<img src=x onerror=alert(1)>")).toBe(
			`<${ZWSP}img src=x onerror=alert(1)&gt;`,
		);
		expect(escapeMermaidLabel("</b><!-- x --><?pi")).toBe(
			`<${ZWSP}/b&gt;<${ZWSP}!-- x --&gt;<${ZWSP}?pi`,
		);
		expect(escapeMermaidLabel("a <b")).not.toMatch(/<\w/);
		// A `<` that opens no tag stays as typed.
		expect(escapeMermaidLabel("a < b > c")).toBe("a < b &gt; c");
	});

	it("breaks a Mermaid direction statement the lexer would read from mid-line", () => {
		expect(escapeMermaidLabel("Strategic direction TBD")).toBe(
			`Strategic direction${ZWSP} TBD`,
		);
		for (const way of ["TB", "BT", "RL", "LR", "TD"]) {
			expect(escapeMermaidLabel(`x direction ${way}`)).toBe(
				`x direction${ZWSP} ${way}`,
			);
		}
		// Any whitespace the lexer's `\s` takes, a folded line break included.
		expect(escapeMermaidLabel("direction\u00A0LR")).toBe(
			`direction${ZWSP}\u00A0LR`,
		);
		expect(escapeMermaidLabel("direction\tLR")).toBe(
			`direction${ZWSP}\tLR`,
		);
		expect(escapeMermaidLabel("direction\nLR")).toBe(`direction${ZWSP} LR`);
		// Inside a longer word too: the lexer's rule starts with `.*`.
		expect(escapeMermaidLabel("redirection TB")).toBe(
			`redirection${ZWSP} TB`,
		);
		// Every occurrence, in any case.
		expect(escapeMermaidLabel("Direction lr, direction   TD")).toBe(
			`Direction${ZWSP} lr, direction${ZWSP}   TD`,
		);
		// Text the lexer's rule cannot match is left alone.
		expect(escapeMermaidLabel("direction of travel")).toBe(
			"direction of travel",
		);
		expect(escapeMermaidLabel("Direction: TBD")).toBe("Direction: TBD");
		expect(escapeMermaidLabel("directions TB")).toBe("directions TB");
		// A generated line no longer matches the lexer's direction rules.
		const directionRule = /^.*direction\s+(?:TB|BT|RL|LR|TD)/;
		for (const label of ["Strategic direction TBD", "direction\u00A0LR"]) {
			expect(`f0["${escapeMermaidLabel(label)}"]`).not.toMatch(
				directionRule,
			);
		}
	});

	it("breaks the C4 keywords Mermaid's type detection finds anywhere in the source", () => {
		for (const kind of [
			"Container",
			"Component",
			"Dynamic",
			"Deployment",
		]) {
			expect(escapeMermaidLabel(`Our C4${kind} map`)).toBe(
				`Our C4${ZWSP}${kind} map`,
			);
		}
		// `C4Context` only counts at the start of the source, which a label
		// never is.
		expect(escapeMermaidLabel("C4 model, C4Context")).toBe(
			"C4 model, C4Context",
		);
	});

	it("breaks Mermaid's internal entity form, which it decodes over the finished SVG", () => {
		expect(escapeMermaidLabel("\uFB02\u00B0lt\u00B6\u00DF")).toBe(
			`\uFB02${ZWSP}\u00B0lt\u00B6${ZWSP}\u00DF`,
		);
		expect(escapeMermaidLabel("\uFB02\u00B0\u00B060")).toBe(
			`\uFB02${ZWSP}\u00B0\u00B060`,
		);
		// Either character on its own is left alone.
		expect(escapeMermaidLabel("\uFB02 \u00B0 \u00B6 \u00DF")).toBe(
			"\uFB02 \u00B0 \u00B6 \u00DF",
		);
	});

	it("applies adjacent breaks independently of each other", () => {
		expect(escapeMermaidLabel("%%#lt;")).toBe(`%${ZWSP}%#${ZWSP}lt;`);
		expect(escapeMermaidLabel("<b%%")).toBe(`<${ZWSP}b%${ZWSP}%`);
		expect(escapeMermaidLabel("<direction TB")).toBe(
			`<${ZWSP}direction${ZWSP} TB`,
		);
		expect(escapeMermaidLabel("#C4Container;")).toBe(
			`#${ZWSP}C4${ZWSP}Container;`,
		);
		const combined = "<b%%#lt;direction TB C4Dynamic";
		const escaped = escapeMermaidLabel(combined);
		expect(escaped).toBe(
			`<${ZWSP}b%${ZWSP}%#${ZWSP}lt;direction${ZWSP} TB C4${ZWSP}Dynamic`,
		);
		// Only zero-width spaces were added: the text reads as typed.
		expect(escaped.split(ZWSP).join("")).toBe(combined);
	});

	it("keeps a leading backtick from opening a Markdown string", () => {
		expect(escapeMermaidLabel("`**x**`")).toBe(`${ZWSP}\`**x**\``);
		expect(escapeMermaidLabel("`[link](javascript:alert(1))`")).toBe(
			`${ZWSP}\`[link](javascript:alert(1))\``,
		);
		// Wrapped as our templates do, `"` is never directly followed by a backtick.
		expect(`n0["${escapeMermaidLabel("`abc")}"]`).not.toContain('"`');
		// A backtick later in the label is left alone.
		expect(escapeMermaidLabel("run `make`")).toBe("run `make`");
	});

	it("breaks a label that would otherwise read as a leading click/style directive", () => {
		const click = escapeMermaidLabel("click here to continue");
		const style = escapeMermaidLabel("style guide review");

		// Prefixed with a zero-width space, not an ordinary one: a lexer that
		// skips leading ASCII whitespace before matching the keyword token
		// would undo a plain-space prefix, but U+200B survives both that and
		// JavaScript's own `trim()` (it is not in the `\s` whitespace class).
		expect(click).toBe(`${ZWSP}click here to continue`);
		expect(style).toBe(`${ZWSP}style guide review`);
		expect(click.trim()).not.toMatch(/^click\b/i);
		expect(style.trim()).not.toMatch(/^style\b/i);

		// A label merely containing the word (not leading) is untouched otherwise.
		expect(escapeMermaidLabel("Please click here")).toBe(
			"Please click here",
		);
	});
});

describe("Mermaid templates quote every spec string", () => {
	const hostile = [
		'"]\nclick A href "javascript:alert(1)"',
		"%%{init: {'htmlLabels': true}}%%",
		"end",
		"--> f0",
		"`**x**`",
		"<b",
		"q=",
	];

	/** Every line, with quoted text blanked, is one the template itself writes. */
	function expectOnlyTemplateLines(source: string, grammar: RegExp): void {
		for (const line of source.split("\n")) {
			expect(line.replace(/"[^"]*"/g, '""')).toMatch(grammar);
		}
	}

	it("timeline dates, labels, and descriptions", () => {
		const source = timelineToMermaid({
			kind: "timeline",
			items: hostile.map((text) => ({
				date: text,
				label: text,
				description: text,
			})),
		});
		expectOnlyTemplateLines(
			source,
			/^(?:flowchart LR|t\d+\[""\]|style t\d+ fill:GLOSSY_COLOR_SURFACE,stroke:GLOSSY_COLOR_BORDER|t\d+ --> t\d+)$/,
		);
		expect(source.match(/^t\d+\["/gm)).toHaveLength(hostile.length);
	});

	it("flow labels and descriptions, in a chain and in lanes", () => {
		const steps = hostile.map((text) => ({
			label: text,
			description: text,
		}));
		const grammar =
			/^(?:flowchart TD|subgraph lane\d+\[""\]|f\d+\[""\]|end|style f\d+ fill:GLOSSY_COLOR_SURFACE,stroke:GLOSSY_COLOR_BORDER|f\d+ --> f\d+)$/;
		expectOnlyTemplateLines(
			flowToMermaid({ kind: "flow", steps }),
			grammar,
		);
		const laned = flowToMermaid({
			kind: "flow",
			steps: steps.map((step, index) => ({
				...step,
				lane: hostile[index],
			})),
		});
		expectOnlyTemplateLines(laned, grammar);
		expect(laned.match(/^subgraph /gm)).toHaveLength(hostile.length);
		expect(laned.match(/^end$/gm)).toHaveLength(hostile.length);
	});

	it("org chart labels, never its ids", () => {
		const source = orgChartToMermaid({
			kind: "org_chart",
			nodes: hostile.map((text, index) => ({
				id: `${text}-${index}`,
				label: text,
				parentId: index === 0 ? null : `${hostile[0]}-0`,
			})),
		});
		expectOnlyTemplateLines(
			source,
			/^(?:flowchart TD|o\d+\[""\]|style o\d+ fill:GLOSSY_COLOR_SURFACE,stroke:GLOSSY_COLOR_BORDER|o\d+ --> o\d+)$/,
		);
		expect(source.match(/ --> /g)).toHaveLength(hostile.length - 1);
	});
});

describe("escapeXmlText", () => {
	it("escapes the five XML-significant characters", () => {
		expect(escapeXmlText(`<b>Tom & "Jerry's" </b>`)).toBe(
			"&lt;b&gt;Tom &amp; &quot;Jerry&apos;s&quot; &lt;/b&gt;",
		);
	});
});

describe("timelineToMermaid", () => {
	const spec: TimelineVisualSpec = {
		kind: "timeline",
		items: [
			{ date: "Q1", label: "Pilot" },
			{ date: "Q2", label: "GA" },
		],
	};

	it("produces a left-to-right flowchart with one node per item and a chain of edges", () => {
		const source = timelineToMermaid(spec);
		expect(source).toContain("flowchart LR");
		expect(source).toContain('t0["Q1 — Pilot"]');
		expect(source).toContain('t1["Q2 — GA"]');
		expect(source).toContain("t0 --> t1");
	});

	it("uses color placeholder tokens rather than literal hex colors", () => {
		const source = timelineToMermaid(spec);
		expect(source).toContain(VISUAL_COLOR_PLACEHOLDERS.surface);
		expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
	});

	it("escapes an item label containing Mermaid-significant characters", () => {
		const source = timelineToMermaid({
			kind: "timeline",
			items: [
				{ date: "Q1", label: 'Ship "v2"' },
				{ date: "Q2", label: "GA" },
			],
		});
		expect(source).not.toContain('"Ship "v2""');
		expect(source).toContain('t0["Q1 — Ship “v2”"]');
	});
});

describe("flowToMermaid", () => {
	const spec: FlowVisualSpec = {
		kind: "flow",
		steps: [{ label: "Submit" }, { label: "Review" }, { label: "Approve" }],
	};

	it("produces a top-down flowchart chaining every step in order", () => {
		const source = flowToMermaid(spec);
		expect(source).toContain("flowchart TD");
		expect(source).toContain('f0["Submit"]');
		expect(source).toContain('f1["Review"]');
		expect(source).toContain('f2["Approve"]');
		expect(source).toContain("f0 --> f1");
		expect(source).toContain("f1 --> f2");
	});

	/** The plain chain, as it rendered before swimlanes existed. */
	const chain = [
		"flowchart TD",
		'f0["Submit"]',
		"style f0 fill:GLOSSY_COLOR_SURFACE,stroke:GLOSSY_COLOR_BORDER",
		'f1["Review"]',
		"style f1 fill:GLOSSY_COLOR_SURFACE,stroke:GLOSSY_COLOR_BORDER",
		"f0 --> f1",
		'f2["Approve"]',
		"style f2 fill:GLOSSY_COLOR_SURFACE,stroke:GLOSSY_COLOR_BORDER",
		"f1 --> f2",
	].join("\n");

	it("draws steps in lanes Sales, Legal, Sales as two lanes around three ordered steps", () => {
		const source = flowToMermaid({
			kind: "flow",
			steps: [
				{ label: "Submit", lane: "Sales" },
				{ label: "Review", lane: "Legal" },
				{ label: "Approve", lane: "Sales" },
			],
		});

		expect(source).toBe(
			[
				"flowchart TD",
				'subgraph lane0["Sales"]',
				'f0["Submit"]',
				'f2["Approve"]',
				"end",
				'subgraph lane1["Legal"]',
				'f1["Review"]',
				"end",
				"style f0 fill:GLOSSY_COLOR_SURFACE,stroke:GLOSSY_COLOR_BORDER",
				"style f1 fill:GLOSSY_COLOR_SURFACE,stroke:GLOSSY_COLOR_BORDER",
				"f0 --> f1",
				"style f2 fill:GLOSSY_COLOR_SURFACE,stroke:GLOSSY_COLOR_BORDER",
				"f1 --> f2",
			].join("\n"),
		);
	});

	it("renders the plain chain exactly when there are no lanes, one lane, or a missing lane", () => {
		const withLanes = (
			lanes: Array<string | undefined>,
		): FlowVisualSpec => ({
			kind: "flow",
			steps: spec.steps.map((step, index) => ({
				...step,
				...(lanes[index] === undefined ? {} : { lane: lanes[index] }),
			})),
		});

		expect(flowToMermaid(spec)).toBe(chain);
		expect(flowToMermaid(withLanes(["Sales", "Sales", "Sales"]))).toBe(
			chain,
		);
		expect(flowToMermaid(withLanes(["Sales", undefined, "Legal"]))).toBe(
			chain,
		);
	});

	it("renders a stored spec without lanes unchanged", () => {
		const stored = visualSpecSchema.parse(
			JSON.parse(
				JSON.stringify({
					kind: "flow",
					steps: [
						{ label: "Submit" },
						{ label: "Review" },
						{ label: "Approve" },
					],
				}),
			),
		);
		expect(visualSpecToMermaid(stored)).toBe(chain);
	});

	it("keeps hostile lane titles inside their quoted titles as text", () => {
		const titles = ['Sales"]', "end", "%% Legal", "Ops --> f0", "Ops]"];
		const source = flowToMermaid({
			kind: "flow",
			steps: titles.map((lane, index) => ({
				label: `Step ${index}`,
				lane,
			})),
		});

		// Outside quoted text, every line is one this template writes.
		for (const line of source.split("\n")) {
			expect(line.replace(/"[^"]*"/g, '""')).toMatch(
				/^(?:flowchart TD|subgraph lane\d+\[""\]|f\d+\[""\]|end|style f\d+ fill:GLOSSY_COLOR_SURFACE,stroke:GLOSSY_COLOR_BORDER|f\d+ --> f\d+)$/,
			);
		}
		expect(source).not.toContain("%%");
		// One lane per title, each closed once, each title escaped like a node label.
		expect(source.match(/^subgraph /gm)).toHaveLength(titles.length);
		expect(source.match(/^end$/gm)).toHaveLength(titles.length);
		titles.forEach((title, index) => {
			expect(source).toContain(
				`subgraph lane${index}["${escapeMermaidLabel(title)}"]`,
			);
		});
	});
});

describe("orgChartToMermaid", () => {
	const spec: OrgChartVisualSpec = {
		kind: "org_chart",
		nodes: [
			{ id: "ceo", label: "CEO", parentId: null },
			{ id: "cto", label: "CTO", parentId: "ceo" },
		],
	};

	it("emits generated node ids rather than spec-provided ids", () => {
		const source = orgChartToMermaid(spec);
		expect(source).toContain('o0["CEO"]');
		expect(source).toContain('o1["CTO"]');
		expect(source).toContain("o0 --> o1");
		// The original ids never appear as Mermaid syntax positions.
		expect(source).not.toMatch(/\bceo\s*\[/);
		expect(source).not.toMatch(/\bcto\s*\[/);
	});
});

describe("visualSpecToMermaid", () => {
	it("dispatches timeline, flow, and org_chart to their templates", () => {
		expect(
			visualSpecToMermaid({
				kind: "flow",
				steps: [{ label: "A" }, { label: "B" }],
			}),
		).toContain("flowchart TD");
	});

	it("throws for a kind it does not template", () => {
		expect(() =>
			visualSpecToMermaid({
				kind: "stat",
				items: [{ value: "1", label: "x" }],
			}),
		).toThrow(/does not template/);
	});
});

describe("statToSvgCard", () => {
	const spec: StatVisualSpec = {
		kind: "stat",
		items: [{ value: "42<%>&\"'", label: "Growth" }],
	};

	it("renders a valid SVG root element", () => {
		const svg = statToSvgCard(spec);
		expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
		expect(svg).toContain("</svg>");
	});

	it("XML-escapes the value and label text", () => {
		const svg = statToSvgCard(spec);
		expect(svg).toContain(escapeXmlText(spec.items[0].value));
		expect(svg).toContain("&lt;");
		expect(svg).toContain("&gt;");
		expect(svg).toContain("&amp;");
		expect(svg).toContain("&quot;");
		expect(svg).toContain("&apos;");
		expect(svg).not.toContain("42<%>&\"'");
		expect(svg).toContain(">Growth<");
	});

	it("uses the fixed system font stack and color placeholders, not literal colors", () => {
		const svg = statToSvgCard(spec);
		expect(svg).toContain(SVG_CARD_FONT_STACK);
		expect(svg).toContain(VISUAL_COLOR_PLACEHOLDERS.primary);
		expect(svg).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
	});
});

describe("comparisonToSvgCard", () => {
	const spec: ComparisonVisualSpec = {
		kind: "comparison",
		items: [
			{ title: "Build", points: ["Full control"] },
			{ title: 'Buy "now"', points: ["Faster <ship>"] },
		],
	};

	it("renders a valid SVG root element containing every item's title and points", () => {
		const svg = comparisonToSvgCard(spec);
		expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
		expect(svg).toContain(">Build<");
		expect(svg).toContain("Full control");
	});

	it("XML-escapes item titles and points", () => {
		const svg = comparisonToSvgCard(spec);
		expect(svg).toContain("Buy &quot;now&quot;");
		expect(svg).toContain("Faster &lt;ship&gt;");
		expect(svg).not.toContain('Buy "now"');
	});
});

/** The SVG's height, its viewBox height, and every text line's baseline:
 * each `<text>`'s `y`, then each `<tspan>`'s cumulative `dy` below it. */
function svgLayout(svg: string): {
	height: number;
	viewBoxHeight: number;
	baselines: number[];
} {
	const baselines: number[] = [];
	for (const [, y, content] of svg.matchAll(
		/<text[^>]* y="(\d+)"[^>]*>(.*?)<\/text>/g,
	)) {
		let baseline = Number(y);
		baselines.push(baseline);
		for (const [, dy] of content.matchAll(/<tspan[^>]* dy="(\d+)"/g)) {
			baseline += Number(dy);
			baselines.push(baseline);
		}
	}
	return {
		height: Number(svg.match(/<svg[^>]* height="(\d+)"/)?.[1]),
		viewBoxHeight: Number(svg.match(/viewBox="0 0 \d+ (\d+)"/)?.[1]),
		baselines,
	};
}

/** Each `<text>` element's lines, still escaped: its `<tspan>`s, or its whole content. */
function textElements(svg: string): string[][] {
	return [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map(([, content]) => {
		const tspans = [...content.matchAll(/<tspan[^>]*>(.*?)<\/tspan>/g)];
		return tspans.length > 0 ? tspans.map((m) => m[1]) : [content];
	});
}

function expectEverythingInside(svg: string): void {
	const { height, viewBoxHeight, baselines } = svgLayout(svg);
	expect(viewBoxHeight).toBe(height);
	for (const baseline of baselines) {
		expect(baseline).toBeLessThan(height);
	}
	for (const [, y, rectHeight] of svg.matchAll(
		/<rect[^>]* y="(\d+)"[^>]* height="(\d+)"/g,
	)) {
		expect(Number(y) + Number(rectHeight)).toBeLessThanOrEqual(height);
	}
}

describe("SVG card text wrapping", () => {
	// Exactly the spec's 120-character bound for a stat label or a point.
	const NEAR_MAX_LABEL =
		"Lower upfront cost but higher maintenance burden over the lifetime of the platform, plus vendor lock-in at every renewal";
	const LONG_TITLE =
		"Build in-house with our own platform and operations team";

	it("uses labels the spec schema accepts", () => {
		expect(NEAR_MAX_LABEL).toHaveLength(120);
		expect(
			visualSpecSchema.safeParse({
				kind: "comparison",
				items: [
					{ title: LONG_TITLE, points: [NEAR_MAX_LABEL] },
					{ title: "Buy", points: ["Fast"] },
				],
			}).success,
		).toBe(true);
		expect(
			visualSpecSchema.safeParse({
				kind: "stat",
				items: [{ value: "42%", label: NEAR_MAX_LABEL }],
			}).success,
		).toBe(true);
	});

	it("wraps a near-max stat label into tspans and grows the card to fit", () => {
		const short = statToSvgCard({
			kind: "stat",
			items: [{ value: "42%", label: "Growth" }],
		});
		const long = statToSvgCard({
			kind: "stat",
			items: [
				{ value: "42%", label: NEAR_MAX_LABEL },
				{ value: "7", label: "Teams" },
			],
		});

		const [, label] = textElements(long);
		expect(label.length).toBeGreaterThan(1);
		expect(label.join(" ")).toBe(NEAR_MAX_LABEL);
		// Grows by the label's extra lines, beyond the second row's 84.
		expect(svgLayout(long).height).toBeGreaterThan(
			svgLayout(short).height + 84,
		);
		expectEverythingInside(long);
	});

	it("wraps a near-max comparison point and a long title, growing every column alike", () => {
		const spec: ComparisonVisualSpec = {
			kind: "comparison",
			items: [
				{ title: LONG_TITLE, points: [NEAR_MAX_LABEL, "Slower start"] },
				{ title: "Buy", points: ["Faster", "Less control"] },
			],
		};
		const short = comparisonToSvgCard({
			kind: "comparison",
			items: [
				{ title: "Build", points: ["Full control", "Slower start"] },
				{ title: "Buy", points: ["Faster", "Less control"] },
			],
		});
		const svg = comparisonToSvgCard(spec);
		const [title, point, , otherTitle, otherPoint] = textElements(svg);

		expect(title.length).toBeGreaterThan(1);
		expect(title.join(" ")).toBe(LONG_TITLE);
		expect(point.length).toBeGreaterThan(1);
		expect(point[0].startsWith("• ")).toBe(true);
		expect(point.join(" ")).toBe(`• ${NEAR_MAX_LABEL}`);
		expect(otherTitle).toEqual(["Buy"]);
		expect(otherPoint).toEqual(["• Faster"]);

		expect(svgLayout(svg).height).toBeGreaterThan(svgLayout(short).height);
		expectEverythingInside(svg);
		// Both columns share one height, and the header band is shared too,
		// so each column's first point sits on the same baseline.
		const rectHeights = [...svg.matchAll(/<rect[^>]* height="(\d+)"/g)].map(
			(m) => m[1],
		);
		expect(new Set(rectHeights).size).toBe(1);
		const pointBaselines = [
			...svg.matchAll(/<text[^>]* y="(\d+)"[^>]*font-size="12"/g),
		].map((m) => Number(m[1]));
		expect(pointBaselines[2]).toBe(pointBaselines[0]);
		// The long point's extra lines push the next point down.
		expect(pointBaselines[1]).toBeGreaterThan(pointBaselines[3]);
	});

	it("keeps short labels on one line, in cards the same size as before wrapping", () => {
		const stat = statToSvgCard({
			kind: "stat",
			title: "Pilot",
			items: [
				{ value: "42%", label: "Growth" },
				{ value: "$1.2M", label: "Annual savings" },
			],
		});
		const comparison = comparisonToSvgCard({
			kind: "comparison",
			items: [
				{ title: "Build", points: ["Full control", "Slower start"] },
				{ title: "Buy", points: ["Faster"] },
			],
		});

		expect(stat).not.toContain("<tspan");
		expect(comparison).not.toContain("<tspan");
		// Stat: title band 40 + two 84 rows. Comparison: 20 + header 44 +
		// two 22 points + 20.
		expect(svgLayout(stat).height).toBe(40 + 2 * 84);
		expect(svgLayout(comparison).height).toBe(20 + 44 + 2 * 22 + 20);
		expect(stat).toContain(">Annual savings</text>");
		expect(comparison).toContain(">• Full control</text>");
	});

	it("XML-escapes wrapped text inside each tspan, never splitting an entity", () => {
		const hostile = `Tom & Jerry's "<script>alert(1)</script>" review covers every renewal & upgrade path <b>twice</b>`;
		const svg = comparisonToSvgCard({
			kind: "comparison",
			items: [
				{
					title: `<img src=x onerror="alert(1)"> & more`,
					points: [hostile],
				},
				{ title: "Buy", points: ["Fast"] },
			],
		});
		const [title, point] = textElements(svg);

		expect(point.length).toBeGreaterThan(1);
		expect(svg).not.toContain("<script");
		expect(svg).not.toContain("<b>");
		expect(svg).not.toContain("<img");
		for (const line of [...title, ...point]) {
			expect(line).not.toMatch(/[<>"']/);
			expect(line).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
		}
		expect(point.join(" ")).toBe(`• ${escapeXmlText(hostile)}`);
	});

	it("caps a pathological label at a few lines, ending in an ellipsis", () => {
		const unbroken = "x".repeat(500);
		const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(
			" ",
		);
		const stat = statToSvgCard({
			kind: "stat",
			items: [{ value: "1", label: unbroken }],
		});
		const comparison = comparisonToSvgCard({
			kind: "comparison",
			items: [
				{ title: "A", points: [words] },
				{ title: "B", points: ["b"] },
			],
		});

		const [, label] = textElements(stat);
		expect(label).toHaveLength(5);
		expect(label[label.length - 1].endsWith("…")).toBe(true);
		expect(label.join("")).toMatch(/^x+…$/);
		const [, point] = textElements(comparison);
		expect(point).toHaveLength(6);
		expect(point[point.length - 1].endsWith("…")).toBe(true);
		expectEverythingInside(stat);
		expectEverythingInside(comparison);
	});

	it("is deterministic", () => {
		const spec: StatVisualSpec = {
			kind: "stat",
			title: LONG_TITLE,
			items: [{ value: "1,234,567 customers", label: NEAR_MAX_LABEL }],
		};
		expect(statToSvgCard(spec)).toBe(statToSvgCard(structuredClone(spec)));
	});
});

describe("visualSpecToSvgCard", () => {
	it("dispatches stat and comparison to their templates", () => {
		expect(
			visualSpecToSvgCard({
				kind: "stat",
				items: [{ value: "1", label: "x" }],
			}),
		).toContain("<svg");
	});

	it("throws for a kind it does not template", () => {
		expect(() =>
			visualSpecToSvgCard({
				kind: "flow",
				steps: [{ label: "A" }, { label: "B" }],
			}),
		).toThrow(/does not template/);
	});
});
