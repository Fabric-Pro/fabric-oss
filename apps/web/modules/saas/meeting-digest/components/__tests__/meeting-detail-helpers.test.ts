import { describe, expect, it } from "vitest";
import {
	toAnalysisStatusLabel,
	toLastScannedLabel,
} from "../MeetingDetailSheet";

describe("toAnalysisStatusLabel", () => {
	it.each([
		["NOT_SCANNED", "Not analyzed"],
		["IN_PROGRESS", "Analyzing…"],
		["SCANNED", "Analyzed"],
		["FAILED", "Analysis failed"],
		["SOMETHING_NEW", "SOMETHING_NEW"],
	])("%s → %s", (status, label) => {
		expect(toAnalysisStatusLabel(status)).toBe(label);
	});
});

describe("toLastScannedLabel", () => {
	it("returns null when never scanned", () => {
		expect(toLastScannedLabel(null)).toBeNull();
	});
	it("formats a wire-format ISO string", () => {
		const label = toLastScannedLabel("2026-07-09T08:15:00.000Z");
		expect(label).toMatch(/^Last scanned /);
		expect(label).toContain("2026");
	});
});
