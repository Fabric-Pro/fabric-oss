import { computeActionItemKey, computeTodoItemKey } from "@repo/database";
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

describe("buildActionItemRows stores the to-do binding key (#2340)", () => {
	it("writes itemKey for every row, from the to-do key not the link key", () => {
		const rows = buildActionItemRows({
			extracted: [
				{ text: "Send the coverage report" },
				{ text: "  SEND   the COVERAGE report  " },
			],
			existing: [],
		});

		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.itemKey).toBe(computeTodoItemKey(row.text));
			expect(row.itemKey).not.toBe(computeActionItemKey(row.text));
		}
		// Normalization is shared, so the two texts land on one key — which is
		// exactly why the to-do layer disambiguates by occurrence rather than by
		// key alone.
		expect(rows[0].itemKey).toBe(rows[1].itemKey);
	});

	it("keys off the item's own text, so a rewording moves the key", () => {
		const [before] = buildActionItemRows({
			extracted: [{ text: "Draft the migration plan" }],
			existing: [],
		});
		const [after] = buildActionItemRows({
			extracted: [{ text: "Draft the migration plan by Friday" }],
			existing: [],
		});

		expect(before.itemKey).not.toBe(after.itemKey);
	});
});
