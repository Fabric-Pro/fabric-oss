import { describe, expect, it } from "vitest";
import { parseRefineResponse, refineFeedbackPreview } from "../refine-response";

const CURRENT = "CURRENT";

const WELL_FORMED =
	"FEEDBACK: What auth provider?\nUPDATED_MESSAGE: Add JWT auth\nREADY: false";
const NO_MARKERS = "No markers at all, just prose.";

/** Replies as the model writes them, and how the procedure has always read each. */
const FIXTURES: Array<{
	name: string;
	text: string;
	feedback: string;
	updatedMessage: string;
	isReady: boolean;
}> = [
	{
		name: "a well-formed reply",
		text: WELL_FORMED,
		feedback: "What auth provider?",
		updatedMessage: "Add JWT auth",
		isReady: false,
	},
	{
		name: "a preamble and an upper-case READY",
		text: "Sure.\nFEEDBACK:  Looks good.  \n\nUPDATED_MESSAGE: Build X\nREADY: TRUE",
		feedback: "Looks good.",
		updatedMessage: "Build X",
		isReady: true,
	},
	{
		name: "no markers",
		text: NO_MARKERS,
		feedback: NO_MARKERS,
		updatedMessage: CURRENT,
		isReady: false,
	},
	{
		name: "an empty feedback line",
		text: "FEEDBACK:\nUPDATED_MESSAGE: only update\nREADY: true",
		feedback: "UPDATED_MESSAGE: only update\nREADY: true",
		updatedMessage: "only update",
		isReady: true,
	},
	{
		name: "blank feedback lines",
		text: "FEEDBACK:   \n  \nUPDATED_MESSAGE: y",
		feedback: "UPDATED_MESSAGE: y",
		updatedMessage: "y",
		isReady: false,
	},
	{
		name: "a reply cut inside the next marker",
		text: "FEEDBACK: truncated mid marker\nUPDATED",
		feedback: "truncated mid marker\nUPDATED",
		updatedMessage: CURRENT,
		isReady: false,
	},
	{
		name: "two UPDATED_MESSAGE lines",
		text: "FEEDBACK: two\nUPDATED_MESSAGE: a\nUPDATED_MESSAGE: b\nREADY: false",
		feedback: "two",
		updatedMessage: "a\nUPDATED_MESSAGE: b",
		isReady: false,
	},
	{
		name: "CRLF line ends",
		text: "FEEDBACK: windows line\r\nUPDATED_MESSAGE: x\r\nREADY: true",
		feedback: "windows line",
		updatedMessage: "x",
		isReady: true,
	},
	{
		name: "two FEEDBACK lines",
		text: "FEEDBACK: a\nFEEDBACK: b\nUPDATED_MESSAGE: c",
		feedback: "a\nFEEDBACK: b",
		updatedMessage: "c",
		isReady: false,
	},
	{
		name: "an empty reply",
		text: "",
		feedback: "",
		updatedMessage: CURRENT,
		isReady: false,
	},
];

describe("parseRefineResponse", () => {
	it.each(FIXTURES)(
		"reads $name",
		({ text, feedback, updatedMessage, isReady }) => {
			expect(parseRefineResponse(text, CURRENT)).toEqual({
				feedback,
				updatedMessage,
				isReady,
			});
		},
	);
});

describe("refineFeedbackPreview", () => {
	it.each(FIXTURES)(
		"only grows, within the final feedback, for $name",
		({ text }) => {
			const { feedback } = parseRefineResponse(text, CURRENT);
			let shown = "";
			for (let k = 0; k <= text.length; k++) {
				const preview = refineFeedbackPreview(text.slice(0, k));
				expect(preview.startsWith(shown), `cut ${k}`).toBe(true);
				expect(feedback.startsWith(preview), `cut ${k}`).toBe(true);
				shown = preview;
			}
		},
	);

	it("shows nothing of a reply that never names its feedback", () => {
		for (let k = 0; k <= NO_MARKERS.length; k++) {
			expect(refineFeedbackPreview(NO_MARKERS.slice(0, k))).toBe("");
		}
	});

	it("never shows the improved request of a well-formed reply", () => {
		for (let k = 0; k <= WELL_FORMED.length; k++) {
			expect(
				refineFeedbackPreview(WELL_FORMED.slice(0, k)),
			).not.toContain("UPDATED");
		}
		expect(refineFeedbackPreview(WELL_FORMED)).toBe("What auth provider?");
	});
});
