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

/** The smallest label a printed diagram shows, in points. */
function smallestPrintedLabelPt(diagram: ExportDiagram | undefined): number {
	if (diagram?.kind !== "svg") {
		throw new Error("expected a drawn diagram");
	}
	const sizes = Array.from(
		diagram.svg.matchAll(/<text [^>]*font-size="([\d.]+)"/g),
		(match) => Number(match[1]),
	);
	expect(sizes.length).toBeGreaterThan(0);
	const scale = Math.min(1, PRINT_COLUMN_PX / diagram.width);
	return Math.min(...sizes) * scale * 0.75;
}

/** The real engine in this thread, recording every source it is handed. */
function recordingLayout(): DiagramLayout & { sources: string[] } {
	const sources: string[] = [];
	return {
		sources,
		render: async (source, options) => {
			sources.push(source);
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

/** The width the real engine lays `source` out at, in CSS pixels. */
function viewBoxWidth(source: string): number {
	return Number(
		/viewBox="0 0 ([\d.]+)/.exec(renderMermaidSVG(source, {}))?.[1],
	);
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

	it("measures the print column as the portrait page less its side margins", () => {
		expect(PRINT_COLUMN_PX).toBeCloseTo((8.5 - 2 * 0.8) * 96, 5);
		expect(printedNodeLabelPt(PRINT_COLUMN_PX)).toBeCloseTo(9.75, 5);
	});

	it("lays a sideways chain of sentence labels out top-down once, so it prints at 9 pt or more", async () => {
		const sideways = renderMermaidSVG(SIDEWAYS_CHAIN, {});
		const sidewaysWidth = Number(
			/viewBox="0 0 ([\d.]+)/.exec(sideways)?.[1],
		);
		expect(printedNodeLabelPt(sidewaysWidth)).toBeLessThan(
			PRINT_LABEL_FLOOR_PT,
		);

		const layout = recordingLayout();
		const sources = [SIDEWAYS_CHAIN];
		const { diagrams, warnings } = await renderExportDiagrams(
			input(sources, { layout }),
		);
		expect(layout.sources).toHaveLength(2);
		expect(layout.sources[0]?.split("\n")[0]).toBe("flowchart LR");
		expect(layout.sources[1]?.split("\n")[0]).toBe("flowchart TD");
		// Only the header turned; Main's fence is untouched.
		expect(layout.sources[1]?.split("\n").slice(1)).toEqual(
			layout.sources[0]?.split("\n").slice(1),
		);
		expect(sources).toEqual([SIDEWAYS_CHAIN]);
		const diagram = diagrams[0];
		if (diagram?.kind !== "svg") {
			throw new Error("expected a drawn diagram");
		}
		expect(diagram.width).toBeLessThan(sidewaysWidth);
		expect(printedNodeLabelPt(diagram.width)).toBeGreaterThanOrEqual(
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

	it("breaks a label too long even top-down into lines, so it prints at 9 pt or more", async () => {
		const long = Array.from(
			{ length: 12 },
			(_, index) => `requirement ${index + 1} of the example programme`,
		).join(", ");
		const fence = `flowchart LR\n  a["${long}"] --> b[Done]`;
		const layout = recordingLayout();
		const { diagrams, warnings } = await renderExportDiagrams(
			input([fence, FLOW], { layout }),
		);
		// Sideways, top-down, broken; then the narrow flow once.
		expect(layout.sources).toHaveLength(4);
		// Top-down alone is still below the floor.
		expect(
			printedNodeLabelPt(viewBoxWidth(fence.replace("LR", "TD"))),
		).toBeLessThan(PRINT_LABEL_FLOOR_PT);
		const [wide, narrow] = diagrams;
		if (wide?.kind !== "svg" || narrow?.kind !== "svg") {
			throw new Error("expected drawn diagrams");
		}
		expect(smallestPrintedLabelPt(wide)).toBeGreaterThanOrEqual(9);
		expect(warnings).toEqual([]);
	});

	it("keeps the better render and warns when even broken labels are too wide", async () => {
		const siblings = Array.from(
			{ length: 40 },
			(_, index) =>
				`  r[Start] --> s${index}["Workstream ${index + 1} — prepare the example data, the agreed integrations and the review notes"]`,
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
		expect(printedNodeLabelPt(diagram.width)).toBeLessThan(
			PRINT_LABEL_FLOOR_PT,
		);
		const widths = layout.sources.map(viewBoxWidth);
		expect(diagram.width).toBeCloseTo(Math.min(...widths), 0);
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
		expect(printedNodeLabelPt(viewBoxWidth(LONG_CHAIN))).toBeLessThan(
			PRINT_LABEL_FLOOR_PT,
		);
		expect(
			printedNodeLabelPt(viewBoxWidth(LONG_CHAIN.replace("LR", "TD"))),
		).toBeLessThan(PRINT_LABEL_FLOOR_PT);

		const layout = recordingLayout();
		const sources = [LONG_CHAIN];
		const { diagrams, warnings } = await renderExportDiagrams(
			input(sources, { layout }),
		);
		expect(layout.sources).toHaveLength(3);
		const broken = String(layout.sources[2]);
		expect(broken.split("\n")[0]).toBe("flowchart TD");
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
		const last = String(layout.sources.at(-1));
		expect(last).toContain(`a["${brokenAlready}"]`);
		expect(last).toContain(`b["${formatted}"]`);
		expect(last).not.toContain(`c["${STAGE_LABELS[2]}"]`);
		expect(last).toContain("Pilot delivery —<br/>");
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

	it("would print the same six items far below that in the Glossy layout, until the export breaks their labels", async () => {
		const glossy = timelineToMermaid({
			kind: "timeline",
			items: Array.from({ length: 6 }, (_, index) => ({
				date: `Phase ${index + 1}`,
				label: TITLE,
				description: DETAIL,
			})),
		});
		expect(printedNodeLabelPt(viewBoxWidth(glossy))).toBeLessThan(9);
		const { diagrams } = await renderExportDiagrams(input([glossy]));
		expect(smallestPrintedLabelPt(diagrams[0])).toBeGreaterThanOrEqual(9);
	});
});
