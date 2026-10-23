/**
 * How wide a diagram is drawn on a client-document Proposal's page (Fizzy
 * #2946): never so narrow that a label falls below 12 CSS px. A diagram
 * that would need to be wider than its column keeps that width and scrolls.
 */

import {
	diagramDisplayWidth,
	MIN_DIAGRAM_LABEL_PX,
	readSvgNaturalSize,
} from "@saas/projects/lib/mermaid-diagram-sizing";
import { renderMermaidSVG } from "beautiful-mermaid";
import { describe, expect, it } from "vitest";

describe("diagramDisplayWidth", () => {
	it("keeps a narrow diagram at its own width", () => {
		expect(
			diagramDisplayWidth({
				naturalWidth: 320,
				labelPx: 13,
				columnWidth: 640,
			}),
		).toEqual({ width: 320, scrollable: false });
	});

	it("fits a diagram to the column while its labels stay at 12 px or more", () => {
		// 690 px at 13 px labels shrinks to 640 px: labels at about 12.06 px.
		const sizing = diagramDisplayWidth({
			naturalWidth: 690,
			labelPx: 13,
			columnWidth: 640,
		});
		expect(sizing).toEqual({ width: 640, scrollable: false });
		expect((13 * sizing.width) / 690).toBeGreaterThanOrEqual(
			MIN_DIAGRAM_LABEL_PX,
		);
	});

	it("keeps a wide diagram's labels at 12 px and marks it scrollable", () => {
		const sizing = diagramDisplayWidth({
			naturalWidth: 1400,
			labelPx: 13,
			columnWidth: 640,
		});
		expect(sizing.scrollable).toBe(true);
		expect(sizing.width).toBeCloseTo((1400 * 12) / 13, 6);
		expect((13 * sizing.width) / 1400).toBeCloseTo(12, 6);
	});

	it("does the same in a 360 px phone column", () => {
		const fits = diagramDisplayWidth({
			naturalWidth: 320,
			labelPx: 13,
			columnWidth: 360,
		});
		expect(fits).toEqual({ width: 320, scrollable: false });

		const wide = diagramDisplayWidth({
			naturalWidth: 700,
			labelPx: 13,
			columnWidth: 360,
		});
		expect(wide.scrollable).toBe(true);
		expect(wide.width).toBeGreaterThan(360);
		expect((13 * wide.width) / 700).toBeCloseTo(12, 6);
	});

	it("enlarges a diagram drawn with labels below the minimum", () => {
		const sizing = diagramDisplayWidth({
			naturalWidth: 300,
			labelPx: 10,
			columnWidth: 640,
		});
		expect(sizing).toEqual({ width: 360, scrollable: false });
	});

	it("leaves the diagram alone before there is a column to measure", () => {
		expect(
			diagramDisplayWidth({
				naturalWidth: 1400,
				labelPx: 13,
				columnWidth: 0,
			}),
		).toEqual({ width: 1400, scrollable: false });
	});
});

describe("readSvgNaturalSize", () => {
	it("reads beautiful-mermaid's width and its 13 px labels", () => {
		const svg = renderMermaidSVG(
			'flowchart LR\n  a["Discovery"] --> b["Launch"]',
			{},
		);
		const size = readSvgNaturalSize(svg);
		expect(size?.width).toBeGreaterThan(0);
		expect(size?.labelPx).toBe(13);
	});

	it("takes the smallest declared font size", () => {
		expect(
			readSvgNaturalSize(
				'<svg width="900" height="200"><text font-size="13">A</text><text font-size="11">b</text></svg>',
			),
		).toEqual({ width: 900, labelPx: 11 });
	});

	it("falls back to the viewBox width", () => {
		expect(
			readSvgNaturalSize(
				'<svg viewBox="0 0 640 200"><text font-size="14">A</text></svg>',
			),
		).toEqual({ width: 640, labelPx: 14 });
	});

	it("declines an SVG sized to its container, as the mermaid.js fallback's", () => {
		expect(
			readSvgNaturalSize(
				'<svg width="100%" viewBox="0 0 2412 512"><text>A</text></svg>',
			),
		).toBeNull();
	});
});
