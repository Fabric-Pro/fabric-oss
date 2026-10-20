import { describe, expect, it } from "vitest";
import type { ChangeProposal } from "../analyze-context";
import { addRoutingNoteToSummary } from "../routing-summary";

function enrichment(identifier: string): ChangeProposal["changes"][number] {
	return {
		type: "feature",
		action: "update",
		title: { to: "Export throttling" },
		existingIdentifier: identifier,
		reasoning: "Captured from discussion",
		sourceContext: "meeting_transcript",
		routing: { decision: "enrich", confidence: 0.9 },
	};
}

const SINGULAR =
	"1 proposed item was matched to existing work item (F-12) and will update it.";

describe("addRoutingNoteToSummary", () => {
	it("preserves the summary byte-for-byte without final enrichments", () => {
		const summary = "  Capture exports.\n";
		expect(addRoutingNoteToSummary(summary, [])).toBe(summary);
		expect(
			addRoutingNoteToSummary(summary, [
				{ ...enrichment("F-12"), action: "create" },
				{ ...enrichment("F-13"), routing: undefined },
			]),
		).toBe(summary);
	});

	it("names a single enriched item using its display identifier", () => {
		expect(
			addRoutingNoteToSummary("Capture exports.", [enrichment("F-12")]),
		).toBe(`${SINGULAR}\n\nCapture exports.`);
	});

	it("uses plural wording and caps identifiers at three", () => {
		expect(
			addRoutingNoteToSummary(
				"Capture exports.",
				[12, 13, 14, 15, 16].map((n) => enrichment(`F-${n}`)),
			),
		).toBe(
			"5 proposed items were matched to existing work items (F-12, F-13, F-14, and 2 more) and will update them.\n\nCapture exports.",
		);
	});

	it.each(["", " \t\n "])("preserves a blank summary %j", (summary) => {
		expect(addRoutingNoteToSummary(summary, [enrichment("F-12")])).toBe(
			summary,
		);
	});

	it("finds identifiers after unnamed enrichments and counts all unnamed items", () => {
		const unnamed = {
			...enrichment("F-12"),
			existingIdentifier: undefined,
		};
		expect(
			addRoutingNoteToSummary("Capture exports.", [
				unnamed,
				unnamed,
				unnamed,
				enrichment("F-15"),
			]),
		).toBe(
			"4 proposed items were matched to existing work items (F-15, and 3 more) and will update them.\n\nCapture exports.",
		);
	});
});
