/**
 * beautiful-mermaid's node label metrics, as the shared label rule mirrors
 * them (Fizzy #2946). `@repo/utils/proposal-artifact/diagram-label-wrap`
 * restates the engine's per-character width estimate, its label size and
 * the padding inside a node's box, to predict which labels spill out of
 * their boxes. Here the installed engine draws single-node flowcharts, and
 * each box must be exactly as wide as the mirror says and each label set at
 * the size it assumes, so an engine upgrade that moves any of them fails
 * here rather than letting labels spill unpredicted.
 */

import { nodeLabelBoxWidthPx } from "@repo/utils/proposal-artifact/diagram-label-wrap";
import { renderMermaidSVG } from "beautiful-mermaid";
import { describe, expect, it } from "vitest";

/**
 * Labels covering every width class the engine estimates: very wide and
 * wide capitals and letters, narrow letters and punctuation, brackets,
 * slashes and the hyphen, r, digits, spaces, typographic punctuation, and
 * accented, Cyrillic, Greek and other Latin letters. A square bracket ends
 * a rectangle's label, so none is drawn.
 */
const LABELS = [
	"Momentum — minimum-time multi-team flow",
	"WWW MMM www mmm @ % ilt fjI 1!| .,:; '",
	"(){}/\\- rrr 0123456789 ABCXYZ",
	"Plan, build & ship: 100% of the agreed scope",
	"“Quoted” ‘text’ … • · → × € £ ° ± § –",
	"Échéance révisée à Zürich — São Paulo",
	"ÆØŒŁĐÞ æøœłđþß ı",
	"ЦЕНТРАЛИЗОВАННОЕ УПРАВЛЕНИЕ ДОСТУПОМ",
	"Согласование требований с заинтересованными",
	"ΚΕΝΤΡΙΚΗ ΔΙΑΧΕΙΡΙΣΗ ΠΡΟΣΒΑΣΗΣ ΟΜΑΔΩΝ",
	"συντονισμός ομάδων και παράδοση",
] as const;

/** The node's box width and its label's text attributes, as drawn. */
function drawnNode(label: string): {
	width: number;
	fontSize: string | undefined;
	fontWeight: string | undefined;
} {
	const svg = renderMermaidSVG(`flowchart TD\n  A["${label}"]`, {});
	const rect =
		/<rect\b[^>]*\bwidth="([\d.]+)"[^>]*\bstroke-width="0\.75"/.exec(svg);
	const text = /<text\b([^>]*)>(?:(?!<\/text>)[\s\S])*<\/text>/.exec(
		svg.slice(rect?.index ?? 0),
	);
	return {
		width: Number(rect?.[1]),
		fontSize: /\bfont-size="([^"]+)"/.exec(text?.[1] ?? "")?.[1],
		fontWeight: /\bfont-weight="([^"]+)"/.exec(text?.[1] ?? "")?.[1],
	};
}

describe("beautiful-mermaid's node label metrics, as the label rule mirrors them", () => {
	it.each(LABELS)(
		"draws the box around %s as wide as the mirror estimates",
		(label) => {
			const drawn = drawnNode(label);
			expect(drawn.width).toBeCloseTo(nodeLabelBoxWidthPx([label]), 6);
		},
	);

	it("sizes a broken label's box by its widest line", () => {
		const lines = ["Momentum —", "minimum-time multi-team flow"];
		const drawn = drawnNode(lines.join("<br/>"));
		expect(drawn.width).toBeCloseTo(nodeLabelBoxWidthPx(lines), 6);
	});

	it("sets node labels at 13 px in its 500 weight", () => {
		const drawn = drawnNode(LABELS[0]);
		expect(drawn.fontSize).toBe("13");
		expect(drawn.fontWeight).toBe("500");
	});
});
