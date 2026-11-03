/**
 * The print column, a printed figure's height, the label floor and the
 * canvas margin, one set for the export and the live page (Fizzy #2946).
 * Both read them from `@repo/utils/proposal-artifact/diagram-label-wrap`,
 * which restates the Word writer's page width because, browser-safe, it
 * cannot import it, and takes a figure's height from the print layer. The
 * export's renderer passes them on as they are, and the column and height
 * must stay the Word writer's, so the live page turns and breaks a diagram
 * exactly when print does, on a page the size of the one printed.
 */

import * as shared from "@repo/utils/proposal-artifact/diagram-label-wrap";
import { describe, expect, it, vi } from "vitest";
import {
	MAX_IMAGE_HEIGHT,
	PAGE,
	PAGE_MARGIN,
	PORTRAIT_TEXT_WIDTH,
	TWIPS_PER_PIXEL,
} from "../../../lib/proposal-export/build-docx/styles";
import * as renderDiagrams from "../render-diagrams";

vi.mock("../../lib/activity-logger", () => ({
	activityLogger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe("the print column, for the export and the live page", () => {
	it("is the Word writer's text width", () => {
		expect(shared.PRINT_COLUMN_PX).toBe(
			PORTRAIT_TEXT_WIDTH / TWIPS_PER_PIXEL,
		);
	});

	it("has the Word writer's tallest picture as a figure's height", () => {
		expect(shared.PRINT_FIGURE_MAX_HEIGHT_PX).toBe(
			MAX_IMAGE_HEIGHT / TWIPS_PER_PIXEL,
		);
		expect(shared.PRINT_FIGURE_MAX_HEIGHT_PX).toBe(
			(PAGE.height - PAGE_MARGIN.top - PAGE_MARGIN.bottom - 1440) /
				TWIPS_PER_PIXEL,
		);
	});

	it("is shorter than the printed page's text area, so the Word writer's cap is the one that binds", () => {
		const textHeight =
			(PAGE.height - PAGE_MARGIN.top - PAGE_MARGIN.bottom) /
			TWIPS_PER_PIXEL;
		expect(textHeight).toBe(888);
		expect(shared.PRINT_FIGURE_MAX_HEIGHT_PX).toBe(792);
		expect(shared.PRINT_FIGURE_MAX_HEIGHT_PX).toBeLessThan(textHeight);
	});

	it("is what the export's renderer measures with", () => {
		expect(renderDiagrams.PRINT_COLUMN_PX).toBe(shared.PRINT_COLUMN_PX);
		expect(renderDiagrams.PRINT_LABEL_FLOOR_PT).toBe(
			shared.PRINT_LABEL_FLOOR_PT,
		);
		expect(renderDiagrams.printedNodeLabelPt).toBe(
			shared.printedNodeLabelPt,
		);
		expect(renderDiagrams.DIAGRAM_CANVAS_PADDING_PX).toBe(
			shared.DIAGRAM_CANVAS_PADDING_PX,
		);
	});
});
