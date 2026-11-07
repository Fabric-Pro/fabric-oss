import { describe, expect, it } from "vitest";
import {
	canExportFramePresentationToPdf,
	effectiveFramePresentation,
} from "../frame-presentation";

describe("Frame presentation", () => {
	it("keeps legacy pages in document presentation", () => {
		expect(effectiveFramePresentation({})).toBe("DOCUMENT");
	});
	it("preserves an authored interface outside report origin", () => {
		expect(effectiveFramePresentation({ presentation: "INTERFACE" })).toBe(
			"INTERFACE",
		);
	});
	it.each([
		{ sourceRunType: "REPORT_EXECUTION" },
		{ metadata: { sourceRunType: "REPORT_EXECUTION" } },
	])("report origin overrides presentation: %j", (origin) => {
		expect(
			effectiveFramePresentation({
				...origin,
				presentation: "INTERFACE",
			}),
		).toBe("DOCUMENT");
	});
});

it("allows one isolated Interface block and rejects any multi-block Interface PDF", () => {
	expect(
		canExportFramePresentationToPdf({
			presentation: "INTERFACE",
			blocks: [{}],
		}),
	).toBe(true);
	expect(
		canExportFramePresentationToPdf({
			presentation: "INTERFACE",
			blocks: [{}, {}],
		}),
	).toBe(false);
	expect(
		canExportFramePresentationToPdf({
			presentation: "INTERFACE",
			blocks: [],
		}),
	).toBe(false);
	expect(canExportFramePresentationToPdf({ blocks: [{}, {}] })).toBe(true);
	expect(
		canExportFramePresentationToPdf({
			presentation: "INTERFACE",
			sourceRunType: "REPORT_EXECUTION",
			blocks: [{}, {}],
		}),
	).toBe(true);
	expect(
		canExportFramePresentationToPdf({
			presentation: "INTERFACE",
			metadata: { sourceRunType: "REPORT_EXECUTION" },
			blocks: [{}, {}],
		}),
	).toBe(true);
});
