/**
 * The browser export draws a diagram with beautiful-mermaid into a PNG: its
 * long node labels are broken into lines as the page breaks them, the
 * source as written is drawn when the engine refuses that copy, and the
 * engine is given one font family, which it quotes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
	calls: [] as Array<{ source: string; options: Record<string, unknown> }>,
	/** Sources containing this the engine refuses, when set. */
	refuse: null as string | null,
	/** Sources mermaid.js was handed. */
	native: [] as string[],
}));

vi.mock("beautiful-mermaid", () => ({
	renderMermaidSVG: (source: string, options: Record<string, unknown>) => {
		engine.calls.push({ source, options });
		if (engine.refuse !== null && source.includes(engine.refuse)) {
			throw new Error("Layout failed");
		}
		return '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
	},
}));

vi.mock("mermaid", () => ({
	default: {
		initialize: () => {},
		mermaidAPI: { getSiteConfig: () => ({}) },
		render: async (_id: string, source: string) => {
			engine.native.push(source);
			return {
				svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
			};
		},
	},
}));

vi.mock("../document-export-helpers", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../document-export-helpers")>();
	return {
		...actual,
		svgToPng: vi.fn(async () => ({
			dataUrl: "data:image/png;base64,ZXhhbXBsZQ==",
			width: 10,
			height: 10,
		})),
	};
});

import { renderMermaidToPng } from "../markdown-to-document";

const LONG_LABEL =
	"Discover and confirm — Agree the example pilot scope, its users and the sources of information (Name the success measures.)";

describe("renderMermaidToPng with beautiful-mermaid", () => {
	beforeEach(() => {
		engine.calls = [];
		engine.refuse = null;
		engine.native = [];
	});

	it("breaks a flowchart's long node labels into lines before drawing", async () => {
		await renderMermaidToPng(
			`flowchart LR\n  a["${LONG_LABEL}"] --> b["Review"]`,
		);

		expect(engine.calls).toHaveLength(1);
		const drawn = engine.calls[0]?.source ?? "";
		expect(drawn).toContain("<br/>");
		expect(drawn.startsWith("flowchart LR")).toBe(true);
		expect(drawn.replace(/<br\/>/g, " ").replace(/\s+/g, " ")).toContain(
			"Agree the example pilot scope",
		);
	});

	it("draws the source as written when the engine refuses the broken copy, before mermaid.js", async () => {
		engine.refuse = "<br/>";
		const source = `flowchart LR\n  a["${LONG_LABEL}"] --> b["Review"]`;

		const png = await renderMermaidToPng(source);

		expect(
			engine.calls.map((call) => call.source.includes("<br/>")),
		).toEqual([true, false]);
		expect(engine.calls[1]?.source).toBe(source);
		expect(engine.calls[1]?.options).toEqual(engine.calls[0]?.options);
		expect(engine.native).toEqual([]);
		expect(png).not.toBeNull();
	});

	it("goes to mermaid.js when the engine refuses a source it did not change", async () => {
		engine.refuse = "flowchart";
		const source = 'flowchart LR\n  a["Plan"] --> b["Build"]';

		await renderMermaidToPng(source);

		expect(engine.calls).toHaveLength(1);
		expect(engine.native).toEqual([source]);
	});

	it("draws a flowchart of short labels as written", async () => {
		const source = 'flowchart LR\n  a["Plan"] --> b["Build"]';

		await renderMermaidToPng(source);

		expect(engine.calls[0]?.source).toBe(source);
	});

	it("names one font family, which the engine quotes", async () => {
		await renderMermaidToPng('flowchart LR\n  a["Plan"] --> b["Build"]');

		expect(engine.calls[0]?.options.font).toBe("Helvetica");
	});
});
