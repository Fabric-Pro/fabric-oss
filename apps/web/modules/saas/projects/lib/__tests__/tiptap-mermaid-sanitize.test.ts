/**
 * The guard on the diagram markup that reaches `dangerouslySetInnerHTML`.
 *
 * Diagram source is authored by one project member and rendered for the rest,
 * so it is stored cross-user content. Two renderers produce that markup and
 * neither sanitized it; the call site merely claimed it was sanitized. These
 * tests pin both halves of the requirement: the injection vectors are gone, and
 * the structure a real diagram depends on survives — a sanitizer that strips
 * `foreignObject` would silently blank every diagram with a text label.
 */

import { describe, expect, it } from "vitest";
import { sanitizeDiagramSvg } from "../tiptap-mermaid-extension";

describe("sanitizeDiagramSvg", () => {
	it("removes a script element embedded in the diagram markup", () => {
		const out = sanitizeDiagramSvg(
			"<svg><g><script>window.stolen = document.cookie;</script></g></svg>",
		);

		expect(out).not.toContain("<script");
		expect(out).not.toContain("document.cookie");
	});

	it.each([
		["onerror", '<svg><image href="x" onerror="alert(1)" /></svg>'],
		["onload", '<svg onload="alert(1)"><g /></svg>'],
		["onclick", '<svg><rect onclick="alert(1)" /></svg>'],
	])("strips the %s handler attribute", (handler, dirty) => {
		const out = sanitizeDiagramSvg(dirty);

		expect(out).not.toContain(handler);
		expect(out).not.toContain("alert(1)");
	});

	it("strips a javascript: target from a diagram link", () => {
		const out = sanitizeDiagramSvg(
			'<svg><a href="javascript:alert(1)"><text>go</text></a></svg>',
		);

		expect(out).not.toContain("javascript:");
	});

	/**
	 * The other half, and the reason the profile is SVG-only.
	 *
	 * `foreignObject` is the bridge from SVG back into HTML. It is not admitted,
	 * which is safe only because neither renderer needs it: the primary one emits
	 * `<text>`, and the fallback is configured with `htmlLabels: false` to match.
	 * This test is the tripwire on that coupling — if a renderer starts emitting
	 * foreignObject labels again, they will be drawn empty, and the failure will
	 * name the cause instead of looking like a layout bug.
	 */
	it("drops foreignObject, which no renderer here is allowed to depend on", () => {
		const out = sanitizeDiagramSvg(
			'<svg><foreignObject width="80"><div>Order placed</div></foreignObject></svg>',
		);

		expect(out).not.toContain("foreignObject");
	});

	it("keeps ordinary SVG geometry and styling attributes", () => {
		const out = sanitizeDiagramSvg(
			'<svg viewBox="0 0 10 10"><path d="M0 0 L10 10" stroke="#333" ' +
				'stroke-width="2" fill="none" /></svg>',
		);

		expect(out).toContain("viewBox");
		expect(out).toContain("M0 0 L10 10");
		expect(out).toContain("stroke-width");
	});

	/**
	 * What loads, not only what runs. A fence's `style A fill:url(…)` line
	 * reaches the renderer's `fill` attribute as written, and the renderer's
	 * own stylesheet opens with a font `@import`; either would make every
	 * reader's browser fetch a URL the diagram's author chose.
	 */
	it("drops a fill or stroke that points at an external url", () => {
		const out = sanitizeDiagramSvg(
			'<svg><rect fill="url(https://example.com/x.svg#p)" ' +
				"stroke=\"URL( 'https://example.com/y' )\" " +
				'style="fill: url(https://example.com/z)" width="10" /></svg>',
		);

		expect(out).not.toContain("example.com");
		expect(out).toContain('width="10"');
	});

	it.each([
		["a data: url", 'fill="url(data:image/svg+xml;base64,PHN2Zy8+)"'],
		["an escaped url", 'fill="\\75 rl(https://example.com/x)"'],
		[
			"an image-set",
			"style=\"fill: image-set('https://example.com/x' 1x)\"",
		],
	])("drops %s, which is not a same-document reference", (_, attribute) => {
		const out = sanitizeDiagramSvg(`<svg><rect ${attribute} /></svg>`);

		expect(out).not.toMatch(/fill=|style=/);
	});

	it("keeps a same-document marker or gradient reference", () => {
		const out = sanitizeDiagramSvg(
			'<svg><defs><marker id="arrow"><path d="M0 0 L5 5" /></marker></defs>' +
				'<path d="M0 0 L10 10" marker-end="url(#arrow)" ' +
				"fill=\"url( '#grad' )\" /></svg>",
		);

		expect(out).toContain('marker-end="url(#arrow)"');
		expect(out).toContain("url( '#grad' )");
	});

	it("drops an image whose href points outside the diagram", () => {
		const out = sanitizeDiagramSvg(
			'<svg><image href="https://example.com/pixel.png" width="1" /></svg>',
		);

		expect(out).not.toContain("example.com");
	});

	it("cleans a stylesheet's imports and external urls but keeps its other rules", () => {
		const out = sanitizeDiagramSvg(
			[
				"<svg><style>",
				"  @import url('https://example.com/css2?family=Inter:wght@400;500&amp;display=swap');",
				"  @font-face { font-family: X; src: url(https://example.com/x.woff2); }",
				"  text { font-family: 'Inter', system-ui, sans-serif; }",
				"  .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }",
				"  svg { --_text: var(--fg); --_line: var(--line, color-mix(in srgb, var(--fg) 30%, var(--bg))); }",
				"  .edge { marker-end: url(#arrow); stroke: var(--_line); }",
				"  .node { fill: url(https://example.com/a); stroke: red; }",
				"  .label { fill: \\75 rl(https://example.com/b); color: blue; }",
				"  .tile { fill: url(data:image/png;base64,AAAA); opacity: 0.5; }",
				"</style><g /></svg>",
			].join("\n"),
		);

		expect(out).not.toContain("@import");
		expect(out).not.toContain("@font-face");
		expect(out).not.toContain("example.com");
		expect(out).not.toContain("data:");
		expect(out).toContain(
			"text { font-family: 'Inter', system-ui, sans-serif; }",
		);
		expect(out).toContain(
			".mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }",
		);
		expect(out).toContain(
			"--_line: var(--line, color-mix(in srgb, var(--fg) 30%, var(--bg)))",
		);
		expect(out).toContain("marker-end: url(#arrow)");
		expect(out).toContain("stroke: red");
		expect(out).toContain("color: blue");
		expect(out).toContain("opacity: 0.5");
	});
});
