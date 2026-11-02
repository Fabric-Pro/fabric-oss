/**
 * The Proposal export's diagram renderer (Fizzy #2946): beautiful-mermaid runs
 * for real; the browser is a fake, since only the screenshot calls matter
 * here and no Chromium is needed to check them.
 */

import {
	flowToMermaid,
	PROPOSAL_VISUAL_TEMPLATE_OPTIONS,
	timelineToMermaid,
} from "@repo/utils/glossy/visual-templates";
import {
	ALWAYS_WRAPPED_LABEL_CHARS,
	PRINT_FIGURE_MAX_HEIGHT_PX,
} from "@repo/utils/proposal-artifact/diagram-label-wrap";
import {
	buildProposalThemeTokens,
	resolveThemePaint,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { toMermaidFence } from "@repo/utils/proposal-artifact/visual-insert";
import { renderMermaidSVG } from "beautiful-mermaid";
import type { Page } from "playwright";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExportBrowser,
	ExportPageOptions,
} from "../../../lib/proposal-export/browser";
import type { DiagramLayout } from "../../../lib/proposal-export/diagram-layout";
import {
	diagramFigureNumbers,
	type ExportDiagram,
	PROPOSAL_EXPORT_LIMITS,
} from "../../../lib/proposal-export/types";
import {
	DIAGRAM_CANVAS_PADDING_PX,
	DIAGRAM_PLACEHOLDER_CAPTION,
	PRINT_COLUMN_PX,
	PRINT_LABEL_FLOOR_PT,
	printedNodeLabelPt,
	type RenderDiagramsInput,
	renderExportDiagrams,
} from "../render-diagrams";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../../lib/activity-logger", () => ({
	activityLogger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * beautiful-mermaid 1.1.3 throws only for headers it does not know, which the
 * renderer refuses before calling it; this marker makes the real engine throw
 * so the renderer's own catch is covered too.
 */
const ENGINE_THROWS = "EngineThrowsHere";

vi.mock("beautiful-mermaid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("beautiful-mermaid")>();
	return {
		...actual,
		renderMermaidSVG: (
			text: string,
			options?: Parameters<typeof actual.renderMermaidSVG>[1],
		) => {
			if (text.includes(ENGINE_THROWS)) {
				throw new Error("Layout failed");
			}
			return actual.renderMermaidSVG(text, options);
		},
	};
});

/** The real worker-thread layout, counted, or failing to start on demand. */
const ownLayout = vi.hoisted(() => ({
	failToOpen: false,
	opened: 0,
	closed: 0,
}));

vi.mock(
	"../../../lib/proposal-export/diagram-layout",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../lib/proposal-export/diagram-layout")
			>();
		return {
			...actual,
			openDiagramLayout: (entry?: string): DiagramLayout => {
				if (ownLayout.failToOpen) {
					throw new Error("Engine missing");
				}
				const layout = actual.openDiagramLayout(entry);
				ownLayout.opened++;
				return {
					render: layout.render,
					close: async () => {
						ownLayout.closed++;
						await layout.close();
					},
				};
			},
		};
	},
);

beforeEach(() => {
	warn.mockClear();
	ownLayout.failToOpen = false;
	ownLayout.opened = 0;
	ownLayout.closed = 0;
});

const paint = resolveThemePaint(
	buildProposalThemeTokens({
		organization: null,
		style: { primaryColor: "#1f3a6b", accentColors: ["#8a5a00"] },
		brandKit: null,
		recipient: null,
	}),
);

const SVG_NAMESPACE_DECLARATION = 'xmlns="http://www.w3.org/2000/svg"';

/**
 * The engine on the test's own thread, so the mock above applies; the
 * worker-thread layout itself is covered in `diagram-layout.test.ts`.
 */
const inProcessLayout: DiagramLayout = {
	async render(source, options) {
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

function input(
	sources: readonly string[],
	overrides: Partial<RenderDiagramsInput> = {},
): RenderDiagramsInput {
	return {
		sources,
		paint,
		browser: null,
		withPng: false,
		deadline: Date.now() + 60_000,
		layout: inProcessLayout,
		...overrides,
	};
}

function svgOf(diagram: ExportDiagram | undefined): string {
	if (diagram?.kind !== "svg") {
		throw new Error("expected a drawn diagram");
	}
	return diagram.svg;
}

/** The `<rect>` drawn for the node labelled `label`. */
function nodeRect(svg: string, label: string): string {
	const match = new RegExp(
		`(<rect [^>]*/>)\\s*<text [^>]*>${label}</text>`,
	).exec(svg);
	if (!match) {
		throw new Error(`no node labelled ${label}`);
	}
	return String(match[1]);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The start of a PNG: signature and IHDR, enough for its size. */
function fakePng(width: number, height: number): Buffer {
	const bytes = Buffer.alloc(33);
	Buffer.from(PNG_SIGNATURE).copy(bytes, 0);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "latin1");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes;
}

function fakeBrowser(failingScreenshots: readonly number[] = []) {
	const newPageCalls: (ExportPageOptions | undefined)[] = [];
	const contents: string[] = [];
	const selectors: string[] = [];
	const screenshotOptions: unknown[] = [];
	let screenshots = 0;
	let contextsClosed = 0;
	const page = {
		async setContent(html: string) {
			contents.push(html);
		},
		locator(selector: string) {
			selectors.push(selector);
			return {
				async screenshot(options: unknown) {
					screenshots++;
					screenshotOptions.push(options);
					if (failingScreenshots.includes(screenshots)) {
						throw new Error("Element is not attached to the DOM");
					}
					return fakePng(400 + screenshots, 200);
				},
			};
		},
		context() {
			return {
				async close() {
					contextsClosed++;
				},
			};
		},
	};
	const browser: ExportBrowser = {
		async newPage(options?: ExportPageOptions) {
			newPageCalls.push(options);
			return page as unknown as Page;
		},
		blockedRequests: 0,
	};
	return {
		browser,
		newPageCalls,
		contents,
		selectors,
		screenshotOptions,
		contextsClosed: () => contextsClosed,
	};
}

const FLOW = "flowchart TD\n  a[Discovery] --> b[Build]\n  b --> c[Launch]";

describe("renderExportDiagrams", () => {
	it("paints a role class with the theme's colour", async () => {
		const { diagrams, warnings } = await renderExportDiagrams(
			input(["flowchart TD\n  n[Node] --> m[Other]\n  class n primary"]),
		);
		const svg = svgOf(diagrams[0]);
		expect(nodeRect(svg, "Node")).toContain(`fill="${paint.primary}"`);
		expect(nodeRect(svg, "Node")).toContain(`stroke="${paint.primary}"`);
		expect(svg).toMatch(
			new RegExp(`<text [^>]*fill="${paint.onPrimary}"[^>]*>Node</text>`),
		);
		// A node without a role keeps the theme's default node fill.
		expect(nodeRect(svg, "Other")).toContain('fill="var(--_node-fill)"');
		expect(warnings).toEqual([]);
	});

	it("keeps a node's own style over its role", async () => {
		const { diagrams } = await renderExportDiagrams(
			input([
				"flowchart TD\n  n[Node] --> m[Other]\n  style m fill:#abcdef,stroke:#123456\n  class m primary",
			]),
		);
		const rect = nodeRect(svgOf(diagrams[0]), "Other");
		expect(rect).toContain('fill="#abcdef"');
		expect(rect).toContain('stroke="#123456"');
	});

	it("ignores an init directive: no foreignObject, one stylesheet", async () => {
		const { diagrams } = await renderExportDiagrams(
			input([
				`%%{init: {"htmlLabels": true, "themeCSS": ".node rect { fill: url(http://example.com/x); }"}}%%\n${FLOW}`,
			]),
		);
		const svg = svgOf(diagrams[0]);
		expect(svg.toLowerCase()).not.toContain("foreignobject");
		expect(svg.match(/<style>/g)).toHaveLength(1);
		expect(svg).not.toContain("@import");
		expect(svg.replace(SVG_NAMESPACE_DECLARATION, "")).not.toContain(
			"http",
		);
	});

	it("drops url() fills and strokes a fence writes", async () => {
		const { diagrams } = await renderExportDiagrams(
			input([
				"flowchart TD\n  A --> B\n  style A fill:url(http://example.com/x)\n  linkStyle 0 stroke:url(file:///etc/passwd)",
			]),
		);
		const svg = svgOf(diagrams[0]);
		expect(svg.replace(SVG_NAMESPACE_DECLARATION, "")).not.toContain(
			"http",
		);
		expect(svg).not.toContain("file:");
		expect(svg.match(/url\((?!#)/gi)).toBeNull();
	});

	it("keeps only a narrow blank margin around a flowchart, so its box is as tall as what it draws", async () => {
		const { diagrams } = await renderExportDiagrams(input([FLOW]));
		const svg = svgOf(diagrams[0]);
		const rects = Array.from(
			svg.matchAll(/<rect [^>]*\bx="([\d.]+)" y="([\d.]+)"/g),
			(match) => ({ x: Number(match[1]), y: Number(match[2]) }),
		);
		expect(rects.length).toBeGreaterThan(0);
		expect(Math.min(...rects.map((rect) => rect.x))).toBeCloseTo(
			DIAGRAM_CANVAS_PADDING_PX,
			5,
		);
		expect(Math.min(...rects.map((rect) => rect.y))).toBeCloseTo(
			DIAGRAM_CANVAS_PADDING_PX,
			5,
		);
	});

	it("scopes every diagram's ids to its own position", async () => {
		const { diagrams } = await renderExportDiagrams(input([FLOW, FLOW]));
		const first = svgOf(diagrams[0]);
		const second = svgOf(diagrams[1]);
		expect(first).toContain('id="pa-diagram-1"');
		expect(second).toContain('id="pa-diagram-2"');
		const idsOf = (svg: string) =>
			Array.from(svg.matchAll(/\sid="([^"]*)"/g), (match) => match[1]);
		const firstIds = new Set(idsOf(first));
		for (const id of idsOf(second)) {
			expect(firstIds.has(id)).toBe(false);
		}
	});

	it("leaves out a source that fails to draw and carries on", async () => {
		const { diagrams, warnings } = await renderExportDiagrams(
			input([
				"flowchart XY\n  A --> B",
				"flowchart LRt0TD\n  A --> B",
				"",
				`flowchart TD\n  a[${ENGINE_THROWS}] --> b`,
				FLOW,
			]),
		);
		for (const diagram of diagrams.slice(0, 4)) {
			expect(diagram).toEqual({ kind: "omitted", numbered: false });
		}
		expect(diagrams[4]).toMatchObject({ kind: "svg", numbered: true });
		expect(warnings).toEqual([{ code: "DIAGRAM_PLACEHOLDER", count: 4 }]);
	});

	it.each([
		["a timeline", "timeline\n  title Plan\n  2026 : Discovery"],
		[
			"a gantt chart",
			"gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section A\n  Task :a1, 2026-01-01, 3d",
		],
		["a pie chart", 'pie\n  "A" : 40\n  "B" : 60'],
		["a mind map", "mindmap\n  root((Plan))\n    Discovery"],
		[
			"a frontmatter block",
			`---\ntitle: Plan\nconfig:\n  theme: dark\n---\n${FLOW}`,
		],
		["a graph without a direction", "graph\n  A --> B"],
		["a one-line graph", "graph TD; A --> B"],
		[
			"a comment before a sequence header",
			"%% notes\nsequenceDiagram\n  A->>B: hi",
		],
	])(
		"prints %s, which only the live page draws, as a numbered placeholder without opening a page",
		async (_, source) => {
			const fake = fakeBrowser();
			const { diagrams, warnings } = await renderExportDiagrams(
				input([source], { browser: fake.browser, withPng: true }),
			);
			expect(diagrams).toEqual([
				{
					kind: "placeholder",
					caption: DIAGRAM_PLACEHOLDER_CAPTION,
					numbered: true,
				},
			]);
			expect(warnings).toEqual([
				{ code: "DIAGRAM_NOT_PRINTABLE", count: 1 },
			]);
			expect(fake.newPageCalls).toEqual([]);
			expect(fake.contents).toEqual([]);
		},
	);

	it.each([
		["a sequence diagram", "sequenceDiagram\n  A->>B: hi\n  B-->>A: hello"],
		[
			"a state diagram",
			"%% notes\nstateDiagram-v2\n  [*] --> Draft\n  Draft --> [*]",
		],
		[
			"a class diagram",
			"classDiagram\n  class Proposal {\n    +String title\n  }",
		],
		["an ER diagram", "erDiagram\n  CLIENT ||--o{ PROPOSAL : receives"],
		["an XY chart", "xychart-beta\n  x-axis [q1, q2]\n  bar [3, 5]"],
	])("draws %s", async (_, source) => {
		const { diagrams, warnings } = await renderExportDiagrams(
			input([source]),
		);
		expect(diagrams[0]?.kind).toBe("svg");
		expect(warnings).toEqual([]);
	});

	it("does not draw a click line as a stray node", async () => {
		const source = `${FLOW}\n  click a href "https://example.com"\n  click b callback`;
		const { renderMermaidSVG } = await import("beautiful-mermaid");
		// Unstripped, beautiful-mermaid draws a box named "click".
		expect(renderMermaidSVG(source)).toContain(">click</text>");

		const { diagrams } = await renderExportDiagrams(input([source]));
		const svg = svgOf(diagrams[0]);
		expect(svg).not.toContain(">click</text>");
		expect(svg).toContain(">Discovery</text>");
	});

	it("prints diagrams past the limit as placeholders and says how many", async () => {
		const extra = 5;
		const sources = Array.from(
			{ length: PROPOSAL_EXPORT_LIMITS.maxDiagrams + extra },
			(_, index) =>
				`flowchart LR\n  a${index}[Step ${index}] --> b${index}[Next]`,
		);
		const { diagrams, warnings } = await renderExportDiagrams(
			input(sources),
		);
		expect(diagrams).toHaveLength(sources.length);
		expect(diagrams[PROPOSAL_EXPORT_LIMITS.maxDiagrams - 1]?.kind).toBe(
			"svg",
		);
		for (const diagram of diagrams.slice(
			PROPOSAL_EXPORT_LIMITS.maxDiagrams,
		)) {
			expect(diagram).toMatchObject({
				kind: "placeholder",
				numbered: true,
			});
		}
		// Kept in place, not left out: only the limit is reported.
		expect(warnings).toEqual([{ code: "DIAGRAM_LIMIT", count: extra }]);
	});

	it("prints a source longer than one diagram may be as a numbered placeholder", async () => {
		const long = `${FLOW}\n%% ${"x".repeat(PROPOSAL_EXPORT_LIMITS.maxDiagramSourceLength)}`;
		const { diagrams, warnings } = await renderExportDiagrams(
			input([long]),
		);
		expect(diagrams[0]).toEqual({
			kind: "placeholder",
			caption: DIAGRAM_PLACEHOLDER_CAPTION,
			numbered: true,
		});
		expect(warnings).toEqual([{ code: "DIAGRAM_NOT_PRINTABLE", count: 1 }]);
	});

	it("prints a layout whose SVG is past its size limit as a numbered placeholder", async () => {
		const { diagrams, warnings } = await renderExportDiagrams(
			input([FLOW], {
				layout: {
					render: async () => ({
						svg: `<svg>${"x".repeat(PROPOSAL_EXPORT_LIMITS.maxSvgLength)}</svg>`,
						abandoned: false,
					}),
					close: async () => {},
				},
			}),
		);
		expect(diagrams[0]).toMatchObject({
			kind: "placeholder",
			numbered: true,
		});
		expect(warnings).toEqual([{ code: "DIAGRAM_NOT_PRINTABLE", count: 1 }]);
	});

	it("draws the same input to the same SVG", async () => {
		const sources = [
			FLOW,
			"flowchart TD\n  n[Node] --> m\n  class n accent",
		];
		const first = await renderExportDiagrams(input(sources));
		const second = await renderExportDiagrams(input(sources));
		expect(second).toEqual(first);
	});

	it("returns nothing for a document without diagrams", async () => {
		const fake = fakeBrowser();
		expect(
			await renderExportDiagrams(
				input([], { browser: fake.browser, withPng: true }),
			),
		).toEqual({ diagrams: [], warnings: [] });
		expect(fake.newPageCalls).toEqual([]);
	});

	it("draws nothing and needs no browser when there are no diagrams, as a Word export without diagrams runs", async () => {
		await expect(
			renderExportDiagrams(input([], { browser: null, withPng: true })),
		).resolves.toEqual({ diagrams: [], warnings: [] });
	});

	it("prints the rest as placeholders once the export's deadline has passed, laying nothing out", async () => {
		const render = vi.fn(inProcessLayout.render);
		const { diagrams, warnings } = await renderExportDiagrams(
			input([FLOW, FLOW], {
				deadline: Date.now() - 1,
				layout: { render, close: async () => {} },
			}),
		);
		expect(diagrams.map((diagram) => diagram.kind)).toEqual([
			"placeholder",
			"placeholder",
		]);
		expect(warnings).toEqual([{ code: "DIAGRAM_NOT_PRINTABLE", count: 2 }]);
		expect(render).not.toHaveBeenCalled();
	});

	it("lays diagrams out in a thread of its own when given no layout, and stops it afterwards", async () => {
		const { diagrams, warnings } = await renderExportDiagrams(
			input([FLOW], { layout: undefined }),
		);
		expect(svgOf(diagrams[0])).toMatch(/^<svg\b/);
		expect(warnings).toEqual([]);
		expect(ownLayout).toMatchObject({ opened: 1, closed: 1 });
	});

	it("prints placeholders and logs when its own layout thread cannot start", async () => {
		ownLayout.failToOpen = true;
		const { diagrams, warnings } = await renderExportDiagrams(
			input([FLOW, FLOW], { layout: undefined }),
		);
		expect(diagrams.map((diagram) => diagram.kind)).toEqual([
			"placeholder",
			"placeholder",
		]);
		expect(warnings).toEqual([{ code: "DIAGRAM_NOT_PRINTABLE", count: 2 }]);
		expect(warn).toHaveBeenCalledWith(
			"Proposal export diagram engine failed to load",
			expect.objectContaining({ error: "Error" }),
		);
	});

	it("needs a browser for PNGs", async () => {
		await expect(
			renderExportDiagrams(input([FLOW], { withPng: true })),
		).rejects.toThrow(TypeError);
	});
});

describe("figure templates and diagrams that do not draw (Fizzy #2946)", () => {
	/** A sideways process whose labels beautiful-mermaid would print small. */
	const PROCESS = [
		"%% figure: process",
		"flowchart LR",
		'  s0["Discovery<br/>Agree on goals, users, the workflow and success measures"]',
		'  s1["Definition<br/>Confirm the pilot scope, integrations and acceptance criteria"]',
		'  s2["Pilot<br/>Configure the agreed scope with example data"]',
		"  s0 --> s1 --> s2",
		"  class s1 highlight",
	].join("\n");

	/** A layout that records each source and answers from a script. */
	function scriptedLayout(
		answers: ("timeLimit" | "thread" | "refused" | "draw")[],
	): DiagramLayout & { sources: string[] } {
		const sources: string[] = [];
		return {
			sources,
			async render(source, options) {
				sources.push(source);
				const answer = answers[sources.length - 1] ?? "draw";
				if (answer === "draw") {
					return {
						svg: renderMermaidSVG(source, options),
						abandoned: false,
					};
				}
				return {
					svg: null,
					abandoned: answer === "refused" ? false : answer,
				};
			},
			close: async () => undefined,
		};
	}

	it("draws a figure template cleaned, with its role, title and desc, and no layout", async () => {
		const layout = scriptedLayout([]);
		const { diagrams, warnings } = await renderExportDiagrams(
			input([PROCESS], {
				captions: ["How a pilot runs"],
				layout,
			}),
		);
		expect(layout.sources).toEqual([]);
		expect(diagrams[0]).toMatchObject({
			kind: "svg",
			width: 662,
			numbered: true,
		});
		const svg = svgOf(diagrams[0]);
		expect(svg).toMatch(/^<svg [^>]*\bid="pa-diagram-1"[^>]*\brole="img"/);
		expect(svg).toContain("<title>How a pilot runs</title>");
		expect(svg).toMatch(
			/<desc>[^<]*Discovery[^<]*Definition[^<]*Pilot[^<]*<\/desc>/,
		);
		// Coloured from the paint the diagram roles use.
		expect(svg).toContain(`fill="${paint.tint}"`);
		expect(svg).not.toMatch(/<script|foreignObject|\son\w+=/i);
		// Never turned or re-wrapped, so never measured against the floor.
		expect(warnings).toEqual([]);
	});

	it("draws a bar chart from its template, cleaned, with its threshold line, and no layout", async () => {
		const bars = [
			"%% figure: bars",
			"xychart-beta horizontal",
			'  x-axis ["Expected · 5% uplift", "Faster review", Baseline]',
			'  y-axis "h" 0 --> 20',
			"  bar [12, 15, 4]",
			"  line [12, 12, 12]",
		].join("\n");
		const layout = scriptedLayout([]);
		const { diagrams, warnings } = await renderExportDiagrams(
			input([bars], { captions: ["Hours saved per week"], layout }),
		);
		expect(layout.sources).toEqual([]);
		expect(diagrams[0]).toMatchObject({
			kind: "svg",
			width: 662,
			numbered: true,
		});
		const svg = svgOf(diagrams[0]);
		expect(svg).toMatch(/^<svg [^>]*\bid="pa-diagram-1"[^>]*\brole="img"/);
		expect(svg).toContain("<title>Hours saved per week</title>");
		expect(svg).toMatch(
			/<desc>[^<]*Expected · 5% uplift: 12 h;[^<]*Faster review: 15 h \(above the threshold\)[^<]*Threshold: 12 h\.<\/desc>/,
		);
		// Within the threshold in the primary; the line and its text in the
		// label colour, dashed, through the cleaner.
		expect(paint.label).not.toBe(paint.primary);
		expect(svg).toContain(`fill="${paint.primary}"`);
		expect(svg).toMatch(
			new RegExp(
				`<line [^>]*stroke="${paint.label}"[^>]*stroke-dasharray="4 3"`,
			),
		);
		expect(svg).toMatch(
			new RegExp(`<text [^>]*fill="${paint.label}"[^>]*>12 h</text>`),
		);
		expect(svg).not.toMatch(/<script|foreignObject|\son\w+=/i);
		expect(warnings).toEqual([]);
	});

	it.each([
		[
			"a line that is not flat",
			["  x-axis [North, South]", "  bar [1, 2]", "  line [5, 6]"],
		],
		[
			"thirteen bars",
			[
				`  x-axis [${Array.from({ length: 13 }, (_, index) => `c${index}`).join(", ")}]`,
				`  bar [${Array.from({ length: 13 }, (_, index) => index + 1).join(", ")}]`,
			],
		],
	])(
		"draws a bar chart the template refuses (%s) as a plain chart, numbered",
		async (_, rest) => {
			const refused = [
				"%% fabric-visual: k3v9q2m7x1a8c4d6",
				"%% figure: bars",
				"xychart-beta horizontal",
				...rest,
			].join("\n");
			const layout = scriptedLayout([]);
			const { diagrams, warnings } = await renderExportDiagrams(
				input([refused], { layout }),
			);
			// beautiful-mermaid finds the chart on its first line only.
			expect(layout.sources).toHaveLength(1);
			expect(
				layout.sources[0]?.startsWith("xychart-beta horizontal\n"),
			).toBe(true);
			expect(layout.sources[0]).not.toContain("%%");
			expect(diagrams[0]).toMatchObject({ kind: "svg", numbered: true });
			const svg = svgOf(diagrams[0]);
			expect(svg).not.toContain('role="img"');
			expect(svg).toContain("xychart-bar");
			expect(warnings).toEqual([]);
		},
	);

	it("draws a gantt from its template, cleaned, with its milestone, and no layout", async () => {
		const gantt = [
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
		const layout = scriptedLayout([]);
		const { diagrams, warnings } = await renderExportDiagrams(
			input([gantt], {
				captions: ["Pilot schedule by workstream"],
				layout,
			}),
		);
		expect(layout.sources).toEqual([]);
		expect(diagrams[0]).toMatchObject({
			kind: "svg",
			width: 662,
			numbered: true,
		});
		const svg = svgOf(diagrams[0]);
		expect(svg).toMatch(/^<svg [^>]*\bid="pa-diagram-1"[^>]*\brole="img"/);
		expect(svg).toContain("<title>Pilot schedule by workstream</title>");
		expect(svg).toMatch(
			/<desc>Week 1 begins 2026-11-02\. Build: Routing, 2026-11-02 to 2026-11-22\. Pilot: Region one, 2026-11-23 to 2026-12-20\. Milestones: Pilot review, 2026-12-21\.<\/desc>/,
		);
		// The first of two sections muted, the other in the primary; the
		// milestone a diamond in the label colour on its dashed line.
		expect(svg).toMatch(new RegExp(`<rect [^>]*fill="${paint.muted}"`));
		expect(svg).toMatch(new RegExp(`<rect [^>]*fill="${paint.primary}"`));
		expect(svg).toMatch(new RegExp(`<path [^>]*fill="${paint.label}"`));
		expect(svg).toMatch(
			new RegExp(
				`<line [^>]*stroke="${paint.label}"[^>]*stroke-dasharray="3 3"`,
			),
		);
		expect(svg).not.toMatch(/<script|foreignObject|\son\w+=/i);
		expect(warnings).toEqual([]);
	});

	it("prints a gantt the template refuses as a numbered placeholder, as before", async () => {
		const refused = [
			"%% figure: gantt",
			"gantt",
			"  dateFormat YYYY-MM-DD",
			"  section Build",
			"  Routing :crit, a1, 2026-11-02, 3w",
		].join("\n");
		const layout = scriptedLayout([]);
		const { diagrams, warnings } = await renderExportDiagrams(
			input([refused], { layout }),
		);
		expect(layout.sources).toEqual([]);
		expect(diagrams[0]).toMatchObject({
			kind: "placeholder",
			numbered: true,
		});
		expect(warnings).toEqual([{ code: "DIAGRAM_NOT_PRINTABLE", count: 1 }]);
	});

	it("titles an uncaptioned template by its kind", async () => {
		const { diagrams } = await renderExportDiagrams(input([PROCESS]));
		expect(svgOf(diagrams[0])).toMatch(/<title>[^<]+<\/title>/);
	});

	it.each([
		["a click line", `${PROCESS}\n  click s0 callback`],
		[
			"a tag in a label",
			PROCESS.replace("Pilot<br/>", "<b>Pilot</b><br/>"),
		],
	])(
		"draws a fence the template refuses (%s) with beautiful-mermaid",
		async (_, source) => {
			const layout = scriptedLayout([]);
			const { diagrams } = await renderExportDiagrams(
				input([source], { layout }),
			);
			expect(layout.sources.length).toBeGreaterThan(0);
			expect(layout.sources[0]).not.toContain("%% figure");
			const svg = svgOf(diagrams[0]);
			expect(svg).not.toContain('role="img"');
			expect(svg).toContain(">Discovery");
		},
	);

	it("numbers what prints and leaves a broken fence out, by cause", async () => {
		const gantt =
			"gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section A\n  Task :a1, 2026-01-01, 3d";
		const { diagrams, warnings } = await renderExportDiagrams(
			input([PROCESS, "flowchart LRt0TD\n  A --> B", FLOW, gantt]),
		);
		expect(diagrams.map((diagram) => diagram.kind)).toEqual([
			"svg",
			"omitted",
			"svg",
			"placeholder",
		]);
		expect(diagramFigureNumbers(diagrams)).toEqual([1, null, 2, 3]);
		expect(warnings).toEqual([
			{ code: "DIAGRAM_PLACEHOLDER", count: 1 },
			{ code: "DIAGRAM_NOT_PRINTABLE", count: 1 },
		]);
	});

	it("tries a layout whose thread failed once more before printing a placeholder", async () => {
		const retried = scriptedLayout(["thread", "draw"]);
		const drawn = await renderExportDiagrams(
			input([FLOW], { layout: retried }),
		);
		expect(retried.sources).toHaveLength(2);
		expect(retried.sources[1]).toBe(retried.sources[0]);
		expect(drawn.diagrams[0]?.kind).toBe("svg");
		expect(drawn.warnings).toEqual([]);

		const abandoned = scriptedLayout(["thread", "thread", "draw"]);
		const left = await renderExportDiagrams(
			input([FLOW], { layout: abandoned }),
		);
		expect(abandoned.sources).toHaveLength(2);
		expect(left.diagrams[0]).toMatchObject({
			kind: "placeholder",
			numbered: true,
		});
		expect(left.warnings).toEqual([
			{ code: "DIAGRAM_NOT_PRINTABLE", count: 1 },
		]);
	});

	it("never tries a layout that ran past its time limit again", async () => {
		const layout = scriptedLayout(["timeLimit", "draw"]);
		const { diagrams, warnings } = await renderExportDiagrams(
			input([FLOW], { layout }),
		);
		expect(layout.sources).toHaveLength(1);
		expect(diagrams[0]).toMatchObject({
			kind: "placeholder",
			numbered: true,
		});
		expect(warnings).toEqual([{ code: "DIAGRAM_NOT_PRINTABLE", count: 1 }]);
	});

	it("never tries a source the engine refused again, and leaves it out", async () => {
		const layout = scriptedLayout(["refused", "draw"]);
		const { diagrams, warnings } = await renderExportDiagrams(
			input([FLOW], { layout }),
		);
		expect(layout.sources).toHaveLength(1);
		expect(diagrams[0]?.kind).toBe("omitted");
		expect(warnings).toEqual([{ code: "DIAGRAM_PLACEHOLDER", count: 1 }]);
	});

	it("screenshots a template for DOCX on the page that embeds the print faces", async () => {
		const fake = fakeBrowser();
		const { diagrams } = await renderExportDiagrams(
			input([PROCESS], { browser: fake.browser, withPng: true }),
		);
		expect(diagrams[0]).toMatchObject({
			kind: "svg",
			png: { mimeType: "image/png" },
		});
		expect(fake.selectors).toEqual(["#pa-diagram-1"]);
		const html = String(fake.contents[0]);
		expect(html).toContain('font-family: "Inter"');
		expect(html).toContain("font-weight: 600");
		expect(html).toContain('font-family: "JetBrains Mono"');
		expect(html).toContain("font-weight: 500");
		expect(html).toContain(svgOf(diagrams[0]));
	});
});

describe("renderExportDiagrams with PNGs", () => {
	it("screenshots each drawn diagram on one hardened page", async () => {
		const fake = fakeBrowser();
		const { diagrams, warnings } = await renderExportDiagrams(
			input([FLOW, "timeline\n  2026 : Discovery", FLOW], {
				browser: fake.browser,
				withPng: true,
			}),
		);

		expect(fake.newPageCalls).toHaveLength(1);
		expect(fake.newPageCalls[0]).toMatchObject({ deviceScaleFactor: 2 });
		expect(fake.selectors).toEqual(["#pa-diagram-1", "#pa-diagram-3"]);
		expect(fake.screenshotOptions).toEqual([
			{ type: "png", omitBackground: false },
			{ type: "png", omitBackground: false },
		]);
		expect(fake.contextsClosed()).toBe(1);

		expect(fake.contents).toHaveLength(2);
		for (const [position, html] of fake.contents.entries()) {
			expect(html.toLowerCase()).not.toContain("<script");
			expect(html).toContain('<meta charset="utf-8">');
			expect(html).toContain("@font-face");
			expect(html).toContain(svgOf(diagrams[position * 2]));
		}

		expect(diagrams[0]).toMatchObject({
			kind: "svg",
			png: { mimeType: "image/png", width: 401, height: 200 },
		});
		expect(diagrams[1]?.kind).toBe("placeholder");
		expect(diagrams[2]).toMatchObject({
			kind: "svg",
			png: { mimeType: "image/png", width: 402, height: 200 },
		});
		expect(warnings).toEqual([{ code: "DIAGRAM_NOT_PRINTABLE", count: 1 }]);
	});

	it("sizes the screenshot explicitly, never past the image edge", async () => {
		const fake = fakeBrowser();
		// Thirty siblings side by side: wide whichever way the header points.
		const wide = `flowchart TD\n  ${Array.from(
			{ length: 30 },
			(_, index) => `r[Start] --> s${index}[Stage number ${index}]`,
		).join("\n  ")}`;
		const { diagrams } = await renderExportDiagrams(
			input([wide, FLOW], { browser: fake.browser, withPng: true }),
		);
		const sizes = fake.contents.map((html) => {
			const match =
				/svg\{display:block;width:([\d.]+)px;height:([\d.]+)px\}/.exec(
					html,
				);
			return { width: Number(match?.[1]), height: Number(match?.[2]) };
		});

		const wideDiagram = diagrams[0];
		if (wideDiagram?.kind !== "svg") {
			throw new Error("expected a drawn diagram");
		}
		const maxCssEdge = PROPOSAL_EXPORT_LIMITS.maxImageEdge / 2;
		expect(wideDiagram.width).toBeGreaterThan(maxCssEdge);
		expect(sizes[0]?.width).toBe(maxCssEdge);
		expect(sizes[0]?.height).toBeCloseTo(
			(wideDiagram.height * maxCssEdge) / wideDiagram.width,
			1,
		);

		const small = diagrams[1];
		if (small?.kind !== "svg") {
			throw new Error("expected a drawn diagram");
		}
		expect(sizes[1]?.width).toBeCloseTo(small.width, 1);
		expect(sizes[1]?.height).toBeCloseTo(small.height, 1);
	});

	it("keeps a diagram whose screenshot fails numbered as in print, and counts it", async () => {
		const fake = fakeBrowser([1]);
		const { diagrams, warnings } = await renderExportDiagrams(
			input([FLOW, FLOW], { browser: fake.browser, withPng: true }),
		);
		const printed = await renderExportDiagrams(
			input([FLOW, FLOW], { withPng: false }),
		);
		expect(diagrams[0]).toMatchObject({
			kind: "svg",
			png: null,
			numbered: true,
		});
		expect(diagrams[1]).toMatchObject({
			kind: "svg",
			png: { mimeType: "image/png" },
		});
		expect(diagramFigureNumbers(diagrams)).toEqual([1, 2]);
		expect(diagramFigureNumbers(diagrams)).toEqual(
			diagramFigureNumbers(printed.diagrams),
		);
		expect(warnings).toEqual([{ code: "DIAGRAM_PLACEHOLDER", count: 1 }]);
		expect(warn).toHaveBeenCalledWith(
			"Proposal export diagram screenshot failed",
			{ diagram: 1, error: "Error" },
		);
		expect(fake.contextsClosed()).toBe(1);
	});
});

/** A generated fence's body, marker line first, as Main holds it. */
function generatedFenceBody(source: string): string {
	return toMermaidFence(source, "abcdefgh12345678")
		.split("\n")
		.slice(1, -1)
		.join("\n");
}

/**
 * The smallest label a printed diagram shows, in points: shrunk to the print
 * column's width or a printed figure's height, whichever shrinks it more.
 */
function smallestPrintedLabelPt(diagram: ExportDiagram | undefined): number {
	if (diagram?.kind !== "svg") {
		throw new Error("expected a drawn diagram");
	}
	const sizes = Array.from(
		diagram.svg.matchAll(/<text [^>]*font-size="([\d.]+)"/g),
		(match) => Number(match[1]),
	);
	expect(sizes.length).toBeGreaterThan(0);
	const scale = Math.min(
		1,
		PRINT_COLUMN_PX / diagram.width,
		PRINT_FIGURE_MAX_HEIGHT_PX / diagram.height,
	);
	return Math.min(...sizes) * scale * 0.75;
}

/**
 * The real engine in this thread, recording every source it is handed; it
 * refuses a source containing `refuse`, when given.
 */
function recordingLayout(
	refuse?: string,
): DiagramLayout & { sources: string[] } {
	const sources: string[] = [];
	return {
		sources,
		render: async (source, options) => {
			sources.push(source);
			if (refuse !== undefined && source.includes(refuse)) {
				return { svg: null, abandoned: false };
			}
			try {
				return {
					svg: renderMermaidSVG(source, options),
					abandoned: false,
				};
			} catch {
				return { svg: null, abandoned: false };
			}
		},
		close: async () => undefined,
	};
}

/**
 * The size the real engine lays `source` out at with the export's canvas
 * margin, in CSS pixels.
 */
function viewBoxSize(source: string): { width: number; height: number } {
	const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)/.exec(
		renderMermaidSVG(source, { padding: DIAGRAM_CANVAS_PADDING_PX }),
	);
	return { width: Number(viewBox?.[1]), height: Number(viewBox?.[2]) };
}

/** Each engine input's header line. */
function headersOf(sources: readonly string[]): (string | undefined)[] {
	return sources.map((source) => source.split("\n")[0]);
}

describe("the print legibility floor (Fizzy #2946)", () => {
	/** Four steps left to right, each a whole sentence on one line. */
	const SIDEWAYS_CHAIN = [
		"flowchart LR",
		'  a["Discovery — agree on goals, users, the workflow and success measures."]',
		'  b["Definition — confirm the pilot scope, integrations and acceptance criteria."]',
		'  c["Pilot — configure the agreed scope with example data"]',
		'  d["Review — assess the pilot against the agreed measures"]',
		"  a --> b",
		"  b --> c",
		"  c --> d",
	].join("\n");

	/** A top-down chain of `steps` nodes, each label a 73-character sentence. */
	function tallChain(steps: number): string {
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
		].join("\n");
	}

	/**
	 * Eight steps left to right, each label a title and a sentence of 40 to
	 * 55 characters on one line.
	 */
	function eightStepChain(): string {
		const labels = [
			"Discovery — agree the example goals and the measures",
			"Definition — confirm the pilot scope and the criteria",
			"Delivery — configure the agreed scope with example data",
			"Review — assess the pilot against the agreed measures",
			"Handover — train the owners and agree the support rota",
			"Support — answer the example questions for six weeks",
			"Planning — agree the next phase and its example dates",
			"Close — record the example lessons and the decisions",
		];
		for (const label of labels) {
			expect(label.length).toBeGreaterThanOrEqual(
				ALWAYS_WRAPPED_LABEL_CHARS,
			);
			expect(label.length).toBeLessThan(60);
		}
		return [
			"flowchart LR",
			...labels.map((label, index) => `  s${index}["${label}"]`),
			...labels
				.slice(1)
				.map((_, index) => `  s${index} --> s${index + 1}`),
		].join("\n");
	}

	it("measures the print column as the portrait page less its side margins", () => {
		expect(PRINT_COLUMN_PX).toBeCloseTo((8.5 - 2 * 0.8) * 96, 5);
		expect(
			printedNodeLabelPt({ width: PRINT_COLUMN_PX, height: 100 }),
		).toBeCloseTo(9.75, 5);
	});

	it("lays a sideways chain of sentence labels out top-down once, so it prints at 9 pt or more", async () => {
		const sideways = viewBoxSize(SIDEWAYS_CHAIN);
		expect(printedNodeLabelPt(sideways)).toBeLessThan(PRINT_LABEL_FLOOR_PT);

		const layout = recordingLayout();
		const sources = [SIDEWAYS_CHAIN];
		const { diagrams, warnings } = await renderExportDiagrams(
			input(sources, { layout }),
		);
		// As written and with its four labels of 40 characters or more
		// broken, both sideways and below the floor; then both top-down. The
		// broken copy turned prints as large as the one as written turned and
		// is kept.
		expect(headersOf(layout.sources)).toEqual([
			"flowchart LR",
			"flowchart LR",
			"flowchart TD",
			"flowchart TD",
		]);
		expect(layout.sources[0]).not.toContain("<br/>");
		expect(layout.sources[1]).toContain("<br/>");
		expect(layout.sources[3]).not.toContain("<br/>");
		// Only the header turned; Main's fence is untouched.
		expect(layout.sources[2]?.split("\n").slice(1)).toEqual(
			layout.sources[1]?.split("\n").slice(1),
		);
		expect(sources).toEqual([SIDEWAYS_CHAIN]);
		const diagram = diagrams[0];
		if (diagram?.kind !== "svg") {
			throw new Error("expected a drawn diagram");
		}
		expect(diagram.width).toBeCloseTo(
			viewBoxSize(String(layout.sources[2])).width,
			0,
		);
		expect(diagram.width).toBeLessThan(sideways.width);
		expect(printedNodeLabelPt(diagram)).toBeGreaterThanOrEqual(
			PRINT_LABEL_FLOOR_PT,
		);
		expect(smallestPrintedLabelPt(diagram)).toBeGreaterThanOrEqual(9);
		expect(warnings).toEqual([]);
	});

	it("draws a narrow sideways diagram once, as written", async () => {
		const layout = recordingLayout();
		const { diagrams, warnings } = await renderExportDiagrams(
			input(["flowchart LR\n  a[Plan] --> b[Build]"], { layout }),
		);
		expect(layout.sources).toHaveLength(1);
		expect(diagrams[0]?.kind).toBe("svg");
		expect(warnings).toEqual([]);
	});

	it("keeps sideways a label too long even top-down, broken into lines, so it prints at 9 pt or more", async () => {
		const long = Array.from(
			{ length: 12 },
			(_, index) => `requirement ${index + 1} of the example programme`,
		).join(", ");
		const fence = `flowchart LR\n  a["${long}"] --> b[Done]`;
		const layout = recordingLayout();
		const { diagrams, warnings } = await renderExportDiagrams(
			input([fence, FLOW], { layout }),
		);
		// As written and with the label broken; the broken copy fits the
		// column sideways, so nothing turns. Then the narrow flow once.
		expect(headersOf(layout.sources)).toEqual([
			"flowchart LR",
			"flowchart LR",
			"flowchart TD",
		]);
		expect(layout.sources[0]).not.toContain("<br/>");
		expect(layout.sources[1]).toContain("<br/>");
		// Top-down alone is still below the floor.
		expect(
			printedNodeLabelPt(viewBoxSize(fence.replace("LR", "TD"))),
		).toBeLessThan(PRINT_LABEL_FLOOR_PT);
		const [wide, narrow] = diagrams;
		if (wide?.kind !== "svg" || narrow?.kind !== "svg") {
			throw new Error("expected drawn diagrams");
		}
		expect(smallestPrintedLabelPt(wide)).toBeGreaterThanOrEqual(9);
		expect(warnings).toEqual([]);
	});

	it("keeps a sideways pair of 70-character labels sideways with the labels broken, as the live page draws it", async () => {
		const first =
			"Discovery workshop — agree the example goals, the users and the measures";
		const second =
			"Pilot delivery — configure the agreed scope and run it with example users";
		expect(first.length).toBeGreaterThanOrEqual(70);
		expect(second.length).toBeGreaterThanOrEqual(70);
		const fence = `flowchart LR\n  a["${first}"] --> b["${second}"]`;
		// As written it would print below the floor and turn top-down.
		expect(printedNodeLabelPt(viewBoxSize(fence))).toBeLessThan(
			PRINT_LABEL_FLOOR_PT,
		);

		const layout = recordingLayout();
		const { diagrams, warnings } = await renderExportDiagrams(
			input([fence], { layout }),
		);
		// As written and with its labels broken; the broken copy prints its
		// labels larger and fits the column sideways, so nothing turns.
		expect(headersOf(layout.sources)).toEqual([
			"flowchart LR",
			"flowchart LR",
		]);
		expect(layout.sources[0]).not.toContain("<br/>");
		const drawn = String(layout.sources[1]);
		expect(drawn).toContain("Discovery workshop —<br/>");
		expect(drawn).toContain("Pilot delivery —<br/>");
		const diagram = diagrams[0];
		if (diagram?.kind !== "svg") {
			throw new Error("expected a drawn diagram");
		}
		expect(diagram.width).toBeCloseTo(viewBoxSize(drawn).width, 0);
		expect(diagram.width).toBeLessThanOrEqual(PRINT_COLUMN_PX);
		expect(smallestPrintedLabelPt(diagram)).toBeCloseTo(9.75, 5);
		expect(warnings).toEqual([]);
	});

	it("breaks a 57-character label dense in narrow letters, even in a diagram the floor rule turns", async () => {
		const narrow =
			"implementation — implementation of the agreed pilot scope";
		expect(narrow.length).toBeGreaterThanOrEqual(
			ALWAYS_WRAPPED_LABEL_CHARS,
		);
		const fence = [
			"flowchart LR",
			`  a["Discovery — agree the example goals"] --> b["${narrow}"]`,
			'  b --> c["Review — assess the pilot and decide"]',
			'  c --> d["Handover — train the example owners"]',
		].join("\n");
		const layout = recordingLayout();
		const { diagrams, warnings } = await renderExportDiagrams(
			input([fence], { layout }),
		);
		// As written and with that label broken, both sideways and below the
		// floor; then both top-down. The broken copy turned prints as large
		// as the one as written turned and is kept, so the label is never
		// drawn on one line, which the engine's estimate draws a box too
		// narrow for.
		expect(headersOf(layout.sources)).toEqual([
			"flowchart LR",
			"flowchart LR",
			"flowchart TD",
			"flowchart TD",
		]);
		expect(layout.sources[0]).not.toContain("<br/>");
		const kept = String(layout.sources[2]);
		expect(kept).toContain(
			"implementation —<br/>implementation of the agreed<br/>pilot scope",
		);
		const diagram = diagrams[0];
		if (diagram?.kind !== "svg") {
			throw new Error("expected a drawn diagram");
		}
		expect(diagram.width).toBeCloseTo(viewBoxSize(kept).width, 0);
		expect(smallestPrintedLabelPt(diagram)).toBeCloseTo(9.75, 5);
		expect(warnings).toEqual([]);
	});

	it("prints a sideways chain of eight 40- to 55-character labels top-down as written, which prints larger than its broken copy turned", async () => {
		const chain = eightStepChain();
		const layout = recordingLayout();
		const { diagrams, warnings } = await renderExportDiagrams(
			input([chain], { layout }),
		);
		// As written and broken, both sideways and below the floor; then both
		// top-down. Broken and turned it is taller than a figure may be; as
		// written and turned it fits the page, so that one is kept.
		expect(headersOf(layout.sources)).toEqual([
			"flowchart LR",
			"flowchart LR",
			"flowchart TD",
			"flowchart TD",
		]);
		const brokenTurned = viewBoxSize(String(layout.sources[2]));
		expect(brokenTurned.height).toBeGreaterThan(PRINT_FIGURE_MAX_HEIGHT_PX);
		expect(printedNodeLabelPt(brokenTurned)).toBeLessThan(
			PRINT_LABEL_FLOOR_PT,
		);
		const kept = String(layout.sources[3]);
		expect(kept).not.toContain("<br/>");
		const diagram = diagrams[0];
		if (diagram?.kind !== "svg") {
			throw new Error("expected a drawn diagram");
		}
		expect(diagram.width).toBeCloseTo(viewBoxSize(kept).width, 0);
		expect(diagram.svg).not.toContain("<tspan");
		expect(smallestPrintedLabelPt(diagram)).toBeCloseTo(9.75, 5);
		expect(warnings).toEqual([]);
	});

	it("breaks labels shorter than that only once top-down is still below the floor", async () => {
		const labels = [
			"Discovery — agree the example goals",
			"Definition — confirm the pilot scope",
			"Delivery — configure the agreed scope",
			"Review — assess the pilot and decide",
			"Handover — train the example owners",
		];
		for (const label of labels) {
			expect(label.length).toBeLessThan(ALWAYS_WRAPPED_LABEL_CHARS);
		}
		const [lead, first, second, third, after] = labels;
		const fence = [
			"flowchart LR",
			`  a["${lead}"] --> b["${first}"] & c["${second}"] & d["${third}"]`,
			`  b --> e["${after}"]`,
		].join("\n");
		const layout = recordingLayout();
		const { diagrams, warnings } = await renderExportDiagrams(
			input([fence], { layout }),
		);
		// Sideways and top-down as written, both below the floor; then
		// top-down with every long label broken.
		expect(layout.sources.map((source) => source.split("\n")[0])).toEqual([
			"flowchart LR",
			"flowchart TD",
			"flowchart TD",
		]);
		expect(layout.sources[0]).not.toContain("<br/>");
		expect(layout.sources[1]).not.toContain("<br/>");
		expect(layout.sources[2]).toContain("Discovery —<br/>");
		expect(smallestPrintedLabelPt(diagrams[0])).toBeGreaterThanOrEqual(9);
		expect(warnings).toEqual([]);
	});

	it("draws the fence as prepared when the engine refuses its broken copy, as the live page does", async () => {
		const label =
			"Discovery workshop — agree the example goals, the users and the measures";
		const fence = `flowchart LR\n  a["${label}"] --> b["${label}"]`;
		const layout = recordingLayout("<br/>");
		const { diagrams, warnings } = await renderExportDiagrams(
			input([fence], { layout }),
		);
		// The broken copy is refused and drops out, so the copy as written is
		// kept; below the floor sideways, it is turned top-down.
		expect(headersOf(layout.sources)).toEqual([
			"flowchart LR",
			"flowchart LR",
			"flowchart TD",
		]);
		expect(layout.sources[0]).not.toContain("<br/>");
		expect(layout.sources[1]).toContain("<br/>");
		expect(layout.sources[2]).not.toContain("<br/>");
		const diagram = diagrams[0];
		if (diagram?.kind !== "svg") {
			throw new Error("expected a drawn diagram");
		}
		expect(diagram.numbered).toBe(true);
		expect(printedNodeLabelPt(diagram)).toBeGreaterThanOrEqual(
			PRINT_LABEL_FLOOR_PT,
		);
		expect(warnings).toEqual([]);
	});

	it("keeps the better render and warns when even broken labels are too wide", async () => {
		// Every label is shorter than the always-broken length, so the first
		// layout draws them as written and the floor rule runs in full.
		const start = "Start — agree the scope and the owners";
		const workstream = (index: number) =>
			`Workstream ${index + 1} — prepare example data`;
		expect(start.length).toBeLessThan(ALWAYS_WRAPPED_LABEL_CHARS);
		expect(workstream(39).length).toBeLessThan(ALWAYS_WRAPPED_LABEL_CHARS);
		const siblings = Array.from(
			{ length: 40 },
			(_, index) =>
				`  r["${start}"] --> s${index}["${workstream(index)}"]`,
		).join("\n");
		const fence = `flowchart LR\n${siblings}`;
		const layout = recordingLayout();
		const { diagrams, warnings } = await renderExportDiagrams(
			input([fence], { layout }),
		);
		expect(layout.sources).toHaveLength(3);
		expect(layout.sources[2]?.split("\n")[0]).toBe("flowchart TD");
		expect(layout.sources[2]).toContain("<br/>");
		const diagram = diagrams[0];
		if (diagram?.kind !== "svg") {
			throw new Error("expected a drawn diagram");
		}
		expect(printedNodeLabelPt(diagram)).toBeLessThan(PRINT_LABEL_FLOOR_PT);
		// The kept render is the one whose labels print largest.
		const printed = layout.sources.map((source) =>
			printedNodeLabelPt(viewBoxSize(source)),
		);
		expect(printedNodeLabelPt(diagram)).toBeCloseTo(
			Math.max(...printed),
			5,
		);
		expect(warnings).toEqual([
			{ code: "DIAGRAM_BELOW_PRINT_FLOOR", count: 1 },
		]);
	});

	it("prints a tall top-down chain of 70-character labels as written, which prints larger than its broken copy", async () => {
		const chain = tallChain(8);
		const asWritten = viewBoxSize(chain);
		expect(asWritten.width).toBeLessThanOrEqual(PRINT_COLUMN_PX);
		expect(asWritten.height).toBeLessThanOrEqual(
			PRINT_FIGURE_MAX_HEIGHT_PX,
		);

		const layout = recordingLayout();
		const { diagrams, warnings } = await renderExportDiagrams(
			input([chain], { layout }),
		);
		// As written and broken; breaking makes it taller than a figure may
		// be, so the copy as written is kept, and it needs nothing more.
		expect(layout.sources).toHaveLength(2);
		expect(layout.sources[0]).not.toContain("<br/>");
		expect(layout.sources[1]).toContain("<br/>");
		const broken = viewBoxSize(String(layout.sources[1]));
		expect(broken.height).toBeGreaterThan(PRINT_FIGURE_MAX_HEIGHT_PX);
		expect(printedNodeLabelPt(broken)).toBeLessThan(PRINT_LABEL_FLOOR_PT);
		const diagram = diagrams[0];
		if (diagram?.kind !== "svg") {
			throw new Error("expected a drawn diagram");
		}
		expect(diagram.width).toBeCloseTo(asWritten.width, 0);
		expect(diagram.svg).not.toContain("<tspan");
		expect(smallestPrintedLabelPt(diagram)).toBeCloseTo(9.75, 5);
		expect(warnings).toEqual([]);
	});

	it("keeps the broken copy when it prints as large as the copy as written", async () => {
		const chain = tallChain(6);
		const layout = recordingLayout();
		const { diagrams, warnings } = await renderExportDiagrams(
			input([chain], { layout }),
		);
		expect(layout.sources).toHaveLength(2);
		// Both print at full size; the broken labels stay inside their boxes.
		for (const source of layout.sources) {
			expect(printedNodeLabelPt(viewBoxSize(source))).toBeCloseTo(
				9.75,
				5,
			);
		}
		const diagram = diagrams[0];
		if (diagram?.kind !== "svg") {
			throw new Error("expected a drawn diagram");
		}
		expect(diagram.width).toBeCloseTo(
			viewBoxSize(String(layout.sources[1])).width,
			0,
		);
		expect(diagram.svg).toContain("<tspan");
		expect(warnings).toEqual([]);
	});

	it("warns for a figure shrunk below the floor by its height", async () => {
		const chain = [
			"flowchart TD",
			...Array.from(
				{ length: 12 },
				(_, index) => `  n${index}["Step ${index + 1}"]`,
			),
			...Array.from(
				{ length: 11 },
				(_, index) => `  n${index} --> n${index + 1}`,
			),
		].join("\n");
		const size = viewBoxSize(chain);
		expect(size.width).toBeLessThanOrEqual(PRINT_COLUMN_PX);
		expect(size.height).toBeGreaterThan(PRINT_FIGURE_MAX_HEIGHT_PX);

		const layout = recordingLayout();
		const { diagrams, warnings } = await renderExportDiagrams(
			input([chain], { layout }),
		);
		// Nothing to turn or break: it prints as written, below the floor.
		expect(layout.sources).toHaveLength(1);
		expect(smallestPrintedLabelPt(diagrams[0])).toBeLessThan(
			PRINT_LABEL_FLOOR_PT,
		);
		expect(warnings).toEqual([
			{ code: "DIAGRAM_BELOW_PRINT_FLOOR", count: 1 },
		]);
	});

	it("warns when the broken copy it keeps is still below the floor", async () => {
		const label = (index: number) =>
			`Workstream ${index + 1} — prepare the example data, the owners and the review notes`;
		expect(label(0).length).toBeGreaterThanOrEqual(
			ALWAYS_WRAPPED_LABEL_CHARS,
		);
		const fan = [
			"flowchart TD",
			...Array.from(
				{ length: 6 },
				(_, index) => `  r[Start] --> s${index}["${label(index)}"]`,
			),
		].join("\n");
		const layout = recordingLayout();
		const { diagrams, warnings } = await renderExportDiagrams(
			input([fan], { layout }),
		);
		// As written and broken; the broken copy prints larger and is kept.
		// Top-down already, with every long label broken, it has nothing left
		// to try.
		expect(layout.sources).toHaveLength(2);
		const diagram = diagrams[0];
		if (diagram?.kind !== "svg") {
			throw new Error("expected a drawn diagram");
		}
		expect(diagram.width).toBeCloseTo(
			viewBoxSize(String(layout.sources[1])).width,
			0,
		);
		expect(printedNodeLabelPt(diagram)).toBeLessThan(PRINT_LABEL_FLOOR_PT);
		expect(warnings).toEqual([
			{ code: "DIAGRAM_BELOW_PRINT_FLOOR", count: 1 },
		]);
	});

	it("warns for a top-down diagram too wide to turn", async () => {
		const layout = recordingLayout();
		const siblings = Array.from(
			{ length: 12 },
			(_, index) => `  r[Start] --> s${index}[Workstream ${index + 1}]`,
		).join("\n");
		const { diagrams, warnings } = await renderExportDiagrams(
			input([`flowchart TD\n${siblings}`], { layout }),
		);
		expect(layout.sources).toHaveLength(1);
		expect(diagrams[0]?.kind).toBe("svg");
		expect(warnings).toEqual([
			{ code: "DIAGRAM_BELOW_PRINT_FLOOR", count: 1 },
		]);
	});
});

describe("long node labels broken for print (Fizzy #2946)", () => {
	/** Four stages left to right, each label a title, a sentence and a note on one line. */
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

	it("prints labels of 130 and more characters at 9 pt or more, every word kept", async () => {
		for (const { sentence, note } of STAGES) {
			expect(sentence.length).toBeGreaterThanOrEqual(85);
			expect(note.length).toBeGreaterThanOrEqual(48);
		}
		expect(printedNodeLabelPt(viewBoxSize(LONG_CHAIN))).toBeLessThan(
			PRINT_LABEL_FLOOR_PT,
		);
		expect(
			printedNodeLabelPt(viewBoxSize(LONG_CHAIN.replace("LR", "TD"))),
		).toBeLessThan(PRINT_LABEL_FLOOR_PT);

		const layout = recordingLayout();
		const sources = [LONG_CHAIN];
		const { diagrams, warnings } = await renderExportDiagrams(
			input(sources, { layout }),
		);
		// As written and broken, both sideways and below the floor; then both
		// top-down, where the broken copy prints larger and is kept.
		expect(headersOf(layout.sources)).toEqual([
			"flowchart LR",
			"flowchart LR",
			"flowchart TD",
			"flowchart TD",
		]);
		expect(layout.sources[0]).not.toContain("<br/>");
		const broken = String(layout.sources[2]);
		expect(String(layout.sources[1]).split("\n").slice(1)).toEqual(
			broken.split("\n").slice(1),
		);
		for (const [index, { title, note }] of STAGES.entries()) {
			const lines = /\["(.*)"\]/
				.exec(
					broken
						.split("\n")
						.find((line) => line.trim().startsWith(`n${index}[`)) ??
						"",
				)?.[1]
				?.split("<br/>");
			expect(lines?.[0]).toBe(`${title} —`);
			expect(lines?.some((line) => line.startsWith("("))).toBe(true);
			expect(lines?.at(-1)?.endsWith(")")).toBe(true);
			expect(lines?.join(" ")).toBe(STAGE_LABELS[index]);
			expect(lines?.filter((line) => line.startsWith("("))).toHaveLength(
				1,
			);
			expect(lines?.join(" ")).toContain(note);
		}
		for (const word of STAGE_LABELS.join(" ").split(" ")) {
			expect(broken).toContain(word);
		}
		expect(broken).not.toContain("…");
		expect(sources).toEqual([LONG_CHAIN]);
		const diagram = diagrams[0];
		if (diagram?.kind !== "svg") {
			throw new Error("expected a drawn diagram");
		}
		expect(smallestPrintedLabelPt(diagram)).toBeGreaterThanOrEqual(9);
		expect(warnings).toEqual([]);
	});

	it("leaves a label that already has line breaks, and one it cannot read safely, as written", async () => {
		const brokenAlready = `Already broken<br/>${STAGE_LABELS[0]}`;
		const formatted = `**Formatted** ${STAGE_LABELS[1]}`;
		const fence = [
			"flowchart LR",
			`  a["${brokenAlready}"] --> b["${formatted}"]`,
			`  b --> c["${STAGE_LABELS[2]}"]`,
		].join("\n");
		const layout = recordingLayout();
		await renderExportDiagrams(input([fence], { layout }));
		// Every copy keeps the first two as written; the broken one, sideways
		// and turned, breaks only the third.
		for (const source of layout.sources) {
			expect(source).toContain(`a["${brokenAlready}"]`);
			expect(source).toContain(`b["${formatted}"]`);
		}
		const broken = layout.sources.filter((source) =>
			source.includes("Pilot delivery —<br/>"),
		);
		expect(headersOf(broken)).toEqual(["flowchart LR", "flowchart TD"]);
		for (const source of broken) {
			expect(source).not.toContain(`c["${STAGE_LABELS[2]}"]`);
		}
	});

	it("breaks labels of every common shape, quoted or not", async () => {
		const label = STAGE_LABELS[3] ?? "";
		const fence = [
			"flowchart TD",
			`  a[${label}] --> b(${label.replace(/[()]/g, "")})`,
			`  b --> c{${label.replace(/[()]/g, "")}}`,
			`  c --> d(["${label}"])`,
			`  d --> e[["${label}"]] & f{{"${label}"}}`,
			"  e -- yes --> g[Short label]",
		].join("\n");
		const layout = recordingLayout();
		await renderExportDiagrams(input([fence], { layout }));
		const last = String(layout.sources.at(-1));
		expect(last.match(/Outcome review —<br\/>/g)).toHaveLength(6);
		expect(last).toContain("g[Short label]");
		expect(last).toContain("e -- yes --> g");
	});
});

describe("generated Proposal diagrams in print (Fizzy #2946)", () => {
	/**
	 * Labels longer than the Proposal extraction asks for, so the template's
	 * wrapping and cutting are what keep them legible.
	 */
	const TITLE = "Discovery workshops with every business unit ok";
	const DETAIL =
		"Interviews, process mapping and one written summary of gaps";

	it("paints a generated fence's role classes with the brand's tint and border", async () => {
		const source = generatedFenceBody(
			timelineToMermaid(
				{
					kind: "timeline",
					items: [
						{ date: "Q1 2026", label: "Kickoff" },
						{ date: "Q2 2026", label: "Launch" },
					],
				},
				PROPOSAL_VISUAL_TEMPLATE_OPTIONS,
			),
		);
		expect(source.startsWith("%% fabric-visual: ")).toBe(true);
		const { diagrams, warnings } = await renderExportDiagrams(
			input([source]),
		);
		const svg = svgOf(diagrams[0]);
		const rect =
			/(<rect [^>]*\/>)\s*<text [^>]*>(?:<tspan[^>]*>Q1 2026<\/tspan>)/.exec(
				svg,
			)?.[1];
		expect(rect).toContain(`fill="${paint.tint}"`);
		expect(rect).toContain(`stroke="${paint.border}"`);
		expect(warnings).toEqual([]);
	});

	it("prints a six-item timeline and a six-step flow with labels at 9 pt or more", async () => {
		expect(TITLE.length).toBeGreaterThan(32);
		expect(DETAIL.length).toBeLessThanOrEqual(60);
		const timeline = timelineToMermaid(
			{
				kind: "timeline",
				items: Array.from({ length: 6 }, (_, index) => ({
					date: `Phase ${index + 1}: weeks ${index * 4 + 1}–${index * 4 + 4}`,
					label: TITLE,
					description: DETAIL,
				})),
			},
			PROPOSAL_VISUAL_TEMPLATE_OPTIONS,
		);
		const flow = flowToMermaid(
			{
				kind: "flow",
				steps: Array.from({ length: 6 }, (_, index) => ({
					label: `${index + 1}. ${TITLE}`,
					description: DETAIL,
				})),
			},
			PROPOSAL_VISUAL_TEMPLATE_OPTIONS,
		);
		expect(timeline.startsWith("flowchart TD")).toBe(true);
		const { diagrams } = await renderExportDiagrams(
			input([generatedFenceBody(timeline), generatedFenceBody(flow)]),
		);
		for (const diagram of diagrams) {
			expect(smallestPrintedLabelPt(diagram)).toBeGreaterThanOrEqual(9);
		}
	});

	it("prints the same six items in the Glossy layout far larger once turned top-down as written, still below the floor, and warns", async () => {
		const glossy = timelineToMermaid({
			kind: "timeline",
			items: Array.from({ length: 6 }, (_, index) => ({
				date: `Phase ${index + 1}`,
				label: TITLE,
				description: DETAIL,
			})),
		});
		expect(printedNodeLabelPt(viewBoxSize(glossy))).toBeLessThan(2);
		const layout = recordingLayout();
		const { diagrams, warnings } = await renderExportDiagrams(
			input([glossy], { layout }),
		);
		const diagram = diagrams[0];
		if (diagram?.kind !== "svg") {
			throw new Error("expected a drawn diagram");
		}
		// As written and broken sideways, then both top-down. Broken and
		// turned it is taller than a figure may be (about 7.8 pt); as written
		// and turned it is wider than the column but prints larger (about
		// 8.3 pt), so that one is kept, still below the floor.
		expect(headersOf(layout.sources)).toEqual([
			"flowchart LR",
			"flowchart LR",
			"flowchart TD",
			"flowchart TD",
		]);
		const brokenTurned = viewBoxSize(String(layout.sources[2]));
		expect(brokenTurned.height).toBeGreaterThan(PRINT_FIGURE_MAX_HEIGHT_PX);
		expect(layout.sources[3]).not.toContain("<br/>");
		expect(diagram.width).toBeCloseTo(
			viewBoxSize(String(layout.sources[3])).width,
			0,
		);
		expect(diagram.width).toBeGreaterThan(PRINT_COLUMN_PX);
		expect(printedNodeLabelPt(diagram)).toBeGreaterThan(
			printedNodeLabelPt(brokenTurned),
		);
		expect(smallestPrintedLabelPt(diagram)).toBeGreaterThan(8);
		expect(smallestPrintedLabelPt(diagram)).toBeLessThan(
			PRINT_LABEL_FLOOR_PT,
		);
		expect(warnings).toEqual([
			{ code: "DIAGRAM_BELOW_PRINT_FLOOR", count: 1 },
		]);
	});
});
