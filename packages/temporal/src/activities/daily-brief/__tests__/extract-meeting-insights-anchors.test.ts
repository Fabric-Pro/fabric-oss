import { describe, expect, it } from "vitest";
import {
	buildActionItemRows,
	buildExtractionPrompt,
	MEETING_INSIGHTS_VERSION,
} from "../extract-meeting-insights";

describe("extract-meeting-insights anchor support", () => {
	it("bumps the insights version so prior caches regenerate with anchors (backfill)", () => {
		expect(MEETING_INSIGHTS_VERSION).toBe(3);
	});

	it("prompt instructs the model to return a verbatim sourceQuote per item", () => {
		const prompt = buildExtractionPrompt({
			meetingSubject: "Sprint Review",
			meetingDate: new Date("2026-07-01T10:00:00Z"),
			speakerNames: ["Ann", "Bob"],
			transcriptText: "Ann: we decided to ship.",
		});
		expect(prompt).toContain("sourceQuote");
		expect(prompt.toLowerCase()).toContain("verbatim");
	});
});

describe("buildActionItemRows anchor fields (#1896 Task 3)", () => {
	it("carries anchor fields from enriched action items onto rows", () => {
		const rows = buildActionItemRows({
			extracted: [
				{ text: "Ship it", sourceQuote: "we ship it", anchorLine: 12 },
				{ text: "No anchor" },
			],
			existing: [],
		});
		expect(rows[0]).toMatchObject({
			sourceQuote: "we ship it",
			anchorLine: 12,
		});
		expect(rows[1]).toMatchObject({ sourceQuote: null, anchorLine: null });
	});
});
