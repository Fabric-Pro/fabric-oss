/**
 * The transcript wording for an answered clarifying question.
 *
 * Fizzy #2406: the orchestrator's clarity gate re-asked questions the user had
 * already answered because the exchange never reached the next turn's history.
 * The fix persists it as a transcript line, and the gate's prompt is told to
 * treat a line in this shape as a settled question — so the wording is a
 * contract between the client and the workflow prompt, not cosmetic.
 *
 * One formatter feeds both the persisted message and the `history` entry; these
 * tests pin the shape so the two cannot drift apart.
 */

import { describe, expect, it } from "vitest";
import { formatClarificationTurn } from "../clarification-turns";

describe("formatClarificationTurn", () => {
	it("renders the question and answer in the shape the clarity prompt recognises", () => {
		expect(
			formatClarificationTurn({
				question: "What is the purpose of these mockup quotes?",
				answer: "They relate to Fabric Open source",
			}),
		).toBe(
			"Clarification — What is the purpose of these mockup quotes?: They relate to Fabric Open source",
		);
	});

	it("keeps the em-dash marker the prompt keys on", () => {
		// The activity prompt instructs the model that a "Clarification — …"
		// line closes that question. Losing the marker silently reopens the bug.
		expect(
			formatClarificationTurn({ question: "Which one?", answer: "A" }),
		).toContain("Clarification — ");
	});

	it("passes through punctuation in the question without mangling the separator", () => {
		expect(
			formatClarificationTurn({
				question: "Website, campaign, or testimonials?",
				answer: "Campaign",
			}),
		).toBe("Clarification — Website, campaign, or testimonials?: Campaign");
	});
});
