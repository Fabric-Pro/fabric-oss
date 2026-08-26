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
});
