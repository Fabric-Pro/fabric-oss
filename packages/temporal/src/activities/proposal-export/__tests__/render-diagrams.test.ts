/**
 * The Proposal export's diagram renderer (Fizzy #2946): beautiful-mermaid runs
 * for real; the browser is a fake, since only the screenshot calls matter
 * here and no Chromium is needed to check them.
 */

import {
	buildProposalThemeTokens,
	resolveThemePaint,
} from "@repo/utils/proposal-artifact/theme-tokens";
import type { Page } from "playwright";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExportBrowser,
	ExportPageOptions,
} from "../../../lib/proposal-export/browser";
import type { DiagramLayout } from "../../../lib/proposal-export/diagram-layout";
import {
	type ExportDiagram,
	PROPOSAL_EXPORT_LIMITS,
} from "../../../lib/proposal-export/types";
import {
	DIAGRAM_PLACEHOLDER_CAPTION,
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
			return mermaid.renderMermaidSVG(source, options);
		} catch {
			return null;
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

	it("prints a placeholder for a syntax error and carries on", async () => {
		const { diagrams, warnings } = await renderExportDiagrams(
			input([
				"flowchart XY\n  A --> B",
				"",
				`flowchart TD\n  a[${ENGINE_THROWS}] --> b`,
				FLOW,
			]),
		);
		for (const diagram of diagrams.slice(0, 3)) {
			expect(diagram).toEqual({
				kind: "placeholder",
				caption: DIAGRAM_PLACEHOLDER_CAPTION,
			});
		}
		expect(diagrams[3]?.kind).toBe("svg");
		expect(warnings).toEqual([{ code: "DIAGRAM_PLACEHOLDER", count: 3 }]);
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
		[
			"a comment before a sequence header",
			"%% notes\nsequenceDiagram\n  A->>B: hi",
		],
	])(
		"prints %s as a placeholder without opening a page",
		async (_, source) => {
			const fake = fakeBrowser();
			const { diagrams, warnings } = await renderExportDiagrams(
				input([source], { browser: fake.browser, withPng: true }),
			);
			expect(diagrams).toEqual([
				{ kind: "placeholder", caption: DIAGRAM_PLACEHOLDER_CAPTION },
			]);
			expect(warnings).toEqual([
				{ code: "DIAGRAM_PLACEHOLDER", count: 1 },
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
			expect(diagram.kind).toBe("placeholder");
		}
		expect(warnings).toEqual([
			{ code: "DIAGRAM_PLACEHOLDER", count: extra },
			{ code: "DIAGRAM_LIMIT", count: extra },
		]);
	});

	it("prints a source longer than one diagram may be as a placeholder", async () => {
		const long = `${FLOW}\n%% ${"x".repeat(PROPOSAL_EXPORT_LIMITS.maxDiagramSourceLength)}`;
		const { diagrams, warnings } = await renderExportDiagrams(
			input([long]),
		);
		expect(diagrams[0]?.kind).toBe("placeholder");
		expect(warnings).toEqual([{ code: "DIAGRAM_PLACEHOLDER", count: 1 }]);
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
		expect(warnings).toEqual([{ code: "DIAGRAM_PLACEHOLDER", count: 2 }]);
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
		expect(warnings).toEqual([{ code: "DIAGRAM_PLACEHOLDER", count: 2 }]);
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
		expect(warnings).toEqual([{ code: "DIAGRAM_PLACEHOLDER", count: 1 }]);
	});

	it("sizes the screenshot explicitly, never past the image edge", async () => {
		const fake = fakeBrowser();
		const wide = `flowchart LR\n  ${Array.from(
			{ length: 30 },
			(_, index) => `s${index}[Stage number ${index}]`,
		).join(" --> ")}`;
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

	it("leaves png null when a screenshot fails and counts the placeholder", async () => {
		const fake = fakeBrowser([1]);
		const { diagrams, warnings } = await renderExportDiagrams(
			input([FLOW, FLOW], { browser: fake.browser, withPng: true }),
		);
		expect(diagrams[0]).toMatchObject({ kind: "svg", png: null });
		expect(diagrams[1]).toMatchObject({
			kind: "svg",
			png: { mimeType: "image/png" },
		});
		expect(warnings).toEqual([{ code: "DIAGRAM_PLACEHOLDER", count: 1 }]);
		expect(warn).toHaveBeenCalledWith(
			"Proposal export diagram screenshot failed",
			{ diagram: 1, error: "Error" },
		);
		expect(fake.contextsClosed()).toBe(1);
	});
});
