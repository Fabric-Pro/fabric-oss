/**
 * The Proposal export's diagram SVG allowlist (Fizzy #2946): beautiful-mermaid's
 * real output keeps its drawing, and hand-written hostile markup loses
 * everything that could run, load or restyle the page.
 */

import { describe, expect, it } from "vitest";
import { cleanDiagramSvg } from "../clean-svg";
import { PROPOSAL_EXPORT_LIMITS } from "../types";

const SVG_NAMESPACE_DECLARATION = 'xmlns="http://www.w3.org/2000/svg"';

const COLORS = {
	bg: "#ffffff",
	fg: "#111827",
	line: "#5a5f6b",
	accent: "#334155",
	muted: "#5a5f6b",
	surface: "#f1f2f4",
	border: "#d4d6da",
	font: "Inter",
	transparent: true,
} as const;

async function renderWithBeautifulMermaid(source: string): Promise<string> {
	const { renderMermaidSVG } = await import("beautiful-mermaid");
	return renderMermaidSVG(source, COLORS);
}

function clean(svg: string, scopeId = "pa-diagram-1"): string {
	const result = cleanDiagramSvg(svg, { scopeId });
	if (!result) {
		throw new Error("expected the SVG to be kept");
	}
	return result.svg;
}

/** The output without the one `http` it must carry, the SVG namespace. */
function withoutNamespace(svg: string): string {
	return svg.replace(SVG_NAMESPACE_DECLARATION, "");
}

function styleElements(svg: string): string[] {
	return Array.from(svg.matchAll(/<style>([\s\S]*?)<\/style>/g), (match) =>
		String(match[1]),
	);
}

function ids(svg: string): string[] {
	return Array.from(svg.matchAll(/\sid="([^"]*)"/g), (match) =>
		String(match[1]),
	);
}

/** Every `url(#…)` target, in attributes and in the stylesheet. */
function references(svg: string): string[] {
	return Array.from(svg.matchAll(/url\(#([^)]*)\)/g), (match) =>
		String(match[1]),
	);
}

/** Every `url(` that is not a same-document reference. */
function foreignUrls(svg: string): string[] {
	return Array.from(svg.matchAll(/url\((?!#)[^)]*\)/gi), (match) => match[0]);
}

function svgDocument(body: string, rootAttributes = ""): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"${rootAttributes}>${body}</svg>`;
}

const FLOWCHART = [
	"flowchart TD",
	'  A["Discovery & scoping"] --> B["Review (v1 -> v2)"]',
	"  B -.-> C((Launch))",
	"  A <--> C",
].join("\n");

describe("cleanDiagramSvg on beautiful-mermaid output", () => {
	it("keeps the drawing with one scoped stylesheet and no font import", async () => {
		const raw = await renderWithBeautifulMermaid(FLOWCHART);
		expect(raw).toContain("@import");
		expect(raw).toContain('id="arrowhead"');

		const result = cleanDiagramSvg(raw, { scopeId: "pa-diagram-1" });
		expect(result).not.toBeNull();
		const svg = result?.svg ?? "";

		const styles = styleElements(svg);
		expect(styles).toHaveLength(1);
		const css = styles[0] ?? "";
		expect(css).not.toContain("@import");
		expect(css).not.toContain("@");
		expect(css).not.toContain("http");
		expect(foreignUrls(css)).toEqual([]);
		expect(withoutNamespace(svg)).not.toContain("http");

		// Every rule is scoped under the diagram's own root.
		const selectors = Array.from(css.matchAll(/^([^{\n]+)\{/gm), (match) =>
			String(match[1]).trim(),
		);
		expect(selectors.length).toBeGreaterThan(0);
		for (const selector of selectors) {
			for (const part of selector.split(",")) {
				expect(part.trim()).toMatch(/^#pa-diagram-1(?:[ .]|$)/);
			}
		}
		expect(css).toMatch(/#pa-diagram-1 text \{ font-family: "Inter"/);

		// Edges stroke with a variable the kept stylesheet defines from a
		// colour the root carries.
		expect(svg).toContain('stroke="var(--_line)"');
		expect(css).toMatch(/#pa-diagram-1 \{[^}]*--_line: var\(--line/);
		expect(svg).toMatch(/<svg [^>]*style="[^"]*--line:#5a5f6b/);

		// The size comes from the viewBox.
		const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(raw);
		expect(result?.width).toBe(Number(viewBox?.[1]));
		expect(result?.height).toBe(Number(viewBox?.[2]));
		expect(svg).toMatch(
			/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" id="pa-diagram-1" /,
		);
	});

	it("prefixes every id and rewrites every reference to it", async () => {
		const svg = clean(await renderWithBeautifulMermaid(FLOWCHART));
		const allIds = ids(svg);
		expect(allIds[0]).toBe("pa-diagram-1");
		for (const id of allIds.slice(1)) {
			expect(id.startsWith("pa-diagram-1-")).toBe(true);
		}
		expect(allIds).toContain("pa-diagram-1-arrowhead");
		const targets = references(svg);
		expect(targets.length).toBeGreaterThan(0);
		for (const target of targets) {
			expect(allIds).toContain(target);
		}
	});

	it("never lets two diagrams on one page share an id", async () => {
		const raw = await renderWithBeautifulMermaid(FLOWCHART);
		const first = new Set(ids(clean(raw, "pa-diagram-1")));
		const second = ids(clean(raw, "pa-diagram-2"));
		expect(second.length).toBeGreaterThan(1);
		for (const id of second) {
			expect(first.has(id)).toBe(false);
		}
	});

	it("keeps labels escaped once, never twice", async () => {
		const svg = clean(await renderWithBeautifulMermaid(FLOWCHART));
		expect(svg).toContain(">Discovery &amp; scoping</text>");
		expect(svg).toContain(">Review (v1 -&gt; v2)</text>");
		expect(svg).not.toContain("&amp;amp;");
		expect(svg).not.toContain("&amp;gt;");
	});

	it("prefixes classes so the page's own rules cannot style a diagram", async () => {
		const svg = clean(
			await renderWithBeautifulMermaid(
				"classDiagram\n  class Animal {\n    +String name\n  }\n  Animal <|-- Dog",
			),
		);
		expect(svg).not.toMatch(/class="(?!dg-)/);
		expect(svg).toMatch(/class="dg-/);
		expect(styleElements(svg)[0]).toContain("#pa-diagram-1 .dg-mono");
	});

	it("merges an xychart's two stylesheets into one", async () => {
		const raw = await renderWithBeautifulMermaid(
			'xychart-beta\n  title "Revenue"\n  x-axis [jan, feb, mar]\n  y-axis "Total" 0 --> 100\n  bar [10, 50, 80]\n  line [20, 40, 90]',
		);
		expect(styleElements(raw)).toHaveLength(2);
		const svg = clean(raw);
		const styles = styleElements(svg);
		expect(styles).toHaveLength(1);
		// Both of its `svg {…}` rules keep their custom properties.
		expect(styles[0]).toContain("--_text: var(--fg)");
		expect(styles[0]).toContain(
			"--xychart-color-0: var(--accent, #3b82f6)",
		);
		expect(styles[0]).toContain(
			"#pa-diagram-1 path.dg-xychart-color-0, #pa-diagram-1 line.dg-xychart-color-0",
		);
		expect(withoutNamespace(svg)).not.toContain("http");
	});

	it("drops a fence's url() fills and strokes", async () => {
		const raw = await renderWithBeautifulMermaid(
			[
				"flowchart TD",
				"  A --> B",
				"  style A fill:url(http://example.com/x)",
				"  linkStyle 0 stroke:url(file:///etc/passwd)",
			].join("\n"),
		);
		expect(raw).toContain("url(http://example.com/x)");
		expect(raw).toContain("url(file:///etc/passwd)");
		const svg = clean(raw);
		expect(withoutNamespace(svg)).not.toContain("http");
		expect(svg).not.toContain("file:");
		expect(foreignUrls(svg)).toEqual([]);
		// The edge keeps its arrow, through the marker's scoped id.
		expect(svg).toMatch(/marker-end="url\(#pa-diagram-1-arrowhead[^"]*\)"/);
	});

	it("cleans the same input to the same output", async () => {
		const raw = await renderWithBeautifulMermaid(FLOWCHART);
		expect(clean(raw)).toBe(clean(raw));
	});
});

describe("cleanDiagramSvg on hostile markup", () => {
	it("removes script, foreignObject, links, images, uses and handlers", () => {
		const svg = clean(
			svgDocument(
				[
					"<script>alert(1)</script>",
					'<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
					'<a href="javascript:alert(1)"><text x="1" y="1">link</text></a>',
					'<image href="http://example.com/x.png" width="10" height="10" />',
					'<use href="http://example.com/sprite.svg#x" />',
					'<iframe src="http://example.com" />',
					'<animate attributeName="fill" to="red" />',
					'<set attributeName="href" to="javascript:alert(1)" />',
					'<filter id="f"><feImage href="http://example.com/x" /></filter>',
					'<rect x="1" y="1" width="5" height="5" onload="alert(1)" ONCLICK="alert(1)" fill="#ff0000" />',
					'<svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(1)</svg:script>',
					"<SCRIPT>alert(1)</SCRIPT>",
				].join(""),
				' onload="alert(1)"',
			),
		);
		const lowered = withoutNamespace(svg).toLowerCase();
		for (const banned of [
			"script",
			"foreignobject",
			"javascript",
			"<a",
			"<image",
			"<use",
			"<iframe",
			"<animate",
			"<set",
			"<filter",
			"feimage",
			"onload",
			"onclick",
			"alert",
			"http",
		]) {
			expect(lowered).not.toContain(banned);
		}
		expect(svg).toContain(
			'<rect x="1" y="1" width="5" height="5" fill="#ff0000" />',
		);
	});

	it("rebuilds a stylesheet without imports, remote urls or unscoped rules", () => {
		const svg = clean(
			svgDocument(
				[
					"<style>",
					"@import url(http://example.com/a.css);",
					"@import 'http://example.com/b.css';",
					"@font-face { font-family: X; src: url(http://example.com/x.woff); }",
					"@media print { text { fill: red; } }",
					"text { fill: url(http://example.com/x); font-family: 'Inter', system-ui; }",
					"rect { fill: #ff0000; background-image: url(http://example.com/y); }",
					"* { fill: red; }",
					"body, .node { stroke: blue; }",
					"svg { --x: url(http://example.com/z); --y: #00ff00; --z: expression(alert(1)); }",
					"circle { fill: u\\72 l(http://example.com/w); stroke: image-set('http://example.com/v' 1x); }",
					"</style>",
					'<rect x="1" y="1" width="5" height="5" />',
				].join("\n"),
			),
		);
		const styles = styleElements(svg);
		expect(styles).toHaveLength(1);
		const css = styles[0] ?? "";
		expect(css).not.toContain("@");
		expect(css).not.toContain("http");
		expect(css).not.toContain("expression");
		expect(css).not.toContain("image-set");
		expect(css).not.toContain("\\");
		expect(foreignUrls(css)).toEqual([]);
		expect(css).toContain(
			'#pa-diagram-1 text { font-family: "Inter", system-ui; }',
		);
		expect(css).toContain("#pa-diagram-1 rect { fill: #ff0000; }");
		expect(css).toContain(
			"#pa-diagram-1 body, #pa-diagram-1 .dg-node { stroke: blue; }",
		);
		expect(css).toContain("#pa-diagram-1 { --y: #00ff00; }");
		expect(css).not.toMatch(/(^|\n)\s*\*/);
		expect(css).not.toContain("circle");
	});

	it("drops unsafe values from presentation attributes", () => {
		const svg = clean(
			svgDocument(
				[
					'<rect width="1" height="1" fill="url(http://example.com/x)" />',
					'<rect width="1" height="1" fill="&#117;rl(http://example.com/x)" />',
					'<rect width="1" height="1" fill="u\\72 l(http://example.com/x)" />',
					'<rect width="1" height="1" fill="url(\'#a\')" />',
					'<rect width="1" height="1" stroke="image-set(x 1x)" />',
					'<rect width="1" height="1" fill="#00ff00" style="fill:url(http://example.com/x)" />',
					'<polyline points="0 0, 1 1" marker-end="url(#arrow)" />',
				].join(""),
			),
		);
		expect(withoutNamespace(svg)).not.toContain("http");
		expect(foreignUrls(svg)).toEqual([]);
		expect(svg).not.toContain("image-set");
		expect(svg).not.toContain("style=");
		expect(svg).toContain('<rect width="1" height="1" fill="#00ff00" />');
		expect(svg).toContain('marker-end="url(#pa-diagram-1-arrow)"');
	});

	it("keeps only custom properties and a var(--bg) background on the root", () => {
		const result = cleanDiagramSvg(
			svgDocument(
				"",
				' style="--bg:#ffffff;--fg:#111827;--x:url(http://example.com/a);color:red;background:var(--bg);background-image:url(http://example.com/b)" class="root" data-xychart-colors="1"',
			),
			{ scopeId: "pa-diagram-3" },
		);
		expect(result?.svg).toBe(
			'<svg xmlns="http://www.w3.org/2000/svg" id="pa-diagram-3" viewBox="0 0 200 100" width="200" height="100" style="--bg:#ffffff;--fg:#111827;background:var(--bg)"></svg>',
		);
	});

	it("keeps entity tricks as text", () => {
		const svg = clean(
			`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>">]>${svgDocument(
				[
					'<text x="1" y="1">&lt;script&gt;alert(1)&lt;/script&gt;</text>',
					'<text x="1" y="2">&#60;img src=x onerror=alert(1)&#62;</text>',
					'<text x="1" y="3">&x;</text>',
					'<text x="1" y="4"><![CDATA[<b>bold</b> & more]]></text>',
					'<text x="1" y="5">A &amp; B &lt;x&gt; &quot;q&quot;</text>',
				].join(""),
			)}`,
		);
		expect(svg).not.toContain("<script");
		expect(svg).not.toContain("<img");
		expect(svg).not.toContain("<b>");
		expect(svg).toContain(">&lt;script&gt;alert(1)&lt;/script&gt;</text>");
		expect(svg).toContain(">&lt;img src=x onerror=alert(1)&gt;</text>");
		expect(svg).toContain(">&amp;x;</text>");
		expect(svg).toContain(">&lt;b&gt;bold&lt;/b&gt; &amp; more</text>");
		expect(svg).toContain('>A &amp; B &lt;x&gt; "q"</text>');
	});

	it("rewrites fragment hrefs and drops every other one", () => {
		const svg = clean(
			svgDocument(
				[
					'<rect id="a" width="1" height="1" />',
					'<rect width="1" height="1" href="#a" />',
					'<rect width="1" height="1" xlink:href="#a" xmlns:xlink="http://www.w3.org/1999/xlink" />',
					'<rect width="1" height="1" href="http://example.com/#a" />',
					'<rect id="bad id" width="1" height="1" />',
				].join(""),
			),
		);
		expect(svg).toContain(
			'<rect id="pa-diagram-1-a" width="1" height="1" />',
		);
		expect(svg.match(/href="#pa-diagram-1-a"/g)).toHaveLength(2);
		expect(svg).not.toContain("xlink");
		expect(withoutNamespace(svg)).not.toContain("http");
		expect(svg).not.toContain("bad id");
	});

	it("keeps only text inside title and desc, and drops nested svg", () => {
		const svg = clean(
			svgDocument(
				'<title>Plan<tspan>inner</tspan></title><desc>About</desc><svg viewBox="0 0 1 1"><rect width="1" height="1" /></svg>',
			),
		);
		expect(svg).toContain("<title>Plan</title><desc>About</desc>");
		expect(svg.match(/<svg/g)).toHaveLength(1);
		expect(svg).not.toContain("<rect");
	});

	it("keeps the root's role only when it is img", () => {
		expect(
			clean(
				svgDocument(
					"<title>Plan</title><desc>Steps</desc>",
					' role="img"',
				),
			),
		).toBe(
			'<svg xmlns="http://www.w3.org/2000/svg" id="pa-diagram-1" viewBox="0 0 200 100" width="200" height="100" role="img"><title>Plan</title><desc>Steps</desc></svg>',
		);
		for (const role of ["button", "img button", "presentation"]) {
			expect(clean(svgDocument("", ` role="${role}"`))).not.toContain(
				"role=",
			);
		}
		// Only the root carries one.
		expect(
			clean(
				svgDocument('<g role="img"><rect width="1" height="1" /></g>'),
			),
		).toContain('<g><rect width="1" height="1" /></g>');
	});

	it("drops text outside text elements", () => {
		const svg = clean(svgDocument("stray<g>more<text>kept</text></g>"));
		expect(svg).toContain("<g><text>kept</text></g>");
		expect(svg).not.toContain("stray");
		expect(svg).not.toContain("more");
	});
});

describe("cleanDiagramSvg on a figure template", () => {
	const palette = {
		ink: "#14171f",
		onInk: "#ffffff",
		primary: "#1f3a6b",
		onPrimary: "#ffffff",
		tint: "#e8edf5",
		border: "#d4d6da",
		surface: "#ffffff",
		muted: "#5a5f6b",
	};
	const source = [
		"%% figure: process",
		"flowchart TD",
		'  s0["Scope<br/>Agree what done looks like"]',
		'  s1["Build"]',
		'  s2["Launch"]',
		"  s0 --> s1 --> s2",
		"  s2 -.->|Feedback| s0",
	].join("\n");

	it("keeps its role, title, desc, faces and arrow references", async () => {
		const { renderFigureSvg } = await import(
			"@repo/utils/proposal-artifact/proposal-figures"
		);
		const template = renderFigureSvg("process", source, palette, {
			caption: "How a scope line moves",
		});
		if (template === null) {
			throw new Error("expected the template to draw");
		}
		const result = cleanDiagramSvg(template, { scopeId: "pa-diagram-2" });
		expect(result).toMatchObject({ width: 662 });
		const svg = String(result?.svg);
		expect(svg).toMatch(/^<svg [^>]*\brole="img"/);
		expect(svg).toContain("<title>How a scope line moves</title>");
		expect(svg).toMatch(
			/<desc>[^<]*Scope[^<]*Build[^<]*Launch[^<]*<\/desc>/,
		);
		// The faces the print page and the screenshot page embed.
		expect(svg).toContain('font-family="&quot;Inter&quot;');
		expect(svg).toContain('font-family="&quot;JetBrains Mono&quot;');
		const kept = new Set(ids(svg));
		const targets = references(svg);
		expect(targets.length).toBeGreaterThan(0);
		for (const target of targets) {
			expect(kept.has(target)).toBe(true);
		}
		expect(withoutNamespace(svg)).not.toMatch(
			/http|<script|foreignObject|\son\w+=/i,
		);
	});
});

describe("cleanDiagramSvg refusals", () => {
	it.each([
		["markup that is not well-formed", "<svg viewBox='0 0 1 1'><g></svg>"],
		["text that is not markup", "not svg"],
		["two roots", "<svg viewBox='0 0 1 1'/><svg viewBox='0 0 1 1'/>"],
		["a root other than svg", "<g viewBox='0 0 1 1'/>"],
		["no size", "<svg><rect width='1' height='1'/></svg>"],
		["a zero-width viewBox", "<svg viewBox='0 0 0 10'/>"],
		["an absurd viewBox", "<svg viewBox='0 0 20001 10'/>"],
		["a viewBox that is not numbers", "<svg viewBox='0 0 a b'/>"],
		["a relative size", "<svg width='100%' height='10'/>"],
	])("refuses %s", (_, svg) => {
		expect(cleanDiagramSvg(svg, { scopeId: "pa-diagram-1" })).toBeNull();
	});

	it("takes the size from plain pixel width and height without a viewBox", () => {
		expect(
			cleanDiagramSvg("<svg width='120px' height='40'/>", {
				scopeId: "pa-diagram-1",
			}),
		).toEqual({
			svg: '<svg xmlns="http://www.w3.org/2000/svg" id="pa-diagram-1" viewBox="0 0 120 40" width="120" height="40"></svg>',
			width: 120,
			height: 40,
		});
	});

	it("refuses markup longer than one export renders", () => {
		const padding = " ".repeat(PROPOSAL_EXPORT_LIMITS.maxSvgLength);
		expect(
			cleanDiagramSvg(`<svg viewBox="0 0 1 1">${padding}</svg>`, {
				scopeId: "pa-diagram-1",
			}),
		).toBeNull();
	});

	it("rejects a scope id that could break out of a selector", () => {
		expect(() =>
			cleanDiagramSvg(svgDocument(""), { scopeId: "x{} body" }),
		).toThrow(TypeError);
	});
});
