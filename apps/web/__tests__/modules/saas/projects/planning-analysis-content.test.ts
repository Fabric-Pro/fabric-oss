/**
 * `isEmptyAnalysis` — whether a planning analysis document has anything
 * worth rendering (Publishing Suite Phase 2A-2/2A-3, Fizzy #1851).
 *
 * Pins a final-review regression: `doc.questions` used to count toward
 * "not empty", but `PlanningAnalysisTab` has never rendered `doc.questions`
 * since 2A-3 moved question display to the decision-thread rows
 * (`TopicQuestionsPanel`). An analysis whose only content was questions
 * therefore passed the not-empty check and rendered a worksheet with no
 * sections at all — a blank body instead of the "came back empty" message.
 */

import {
	isEmptyAnalysis,
	readPlanningAnalysis,
} from "@saas/projects/components/publishing-suite/planning-analysis-content";
import { describe, expect, it } from "vitest";

describe("isEmptyAnalysis", () => {
	it("treats an analysis whose only content is questions as empty", () => {
		const doc = readPlanningAnalysis({
			questions: [
				{
					questionId: "q1",
					decisionKind: "CUSTOMER_NAME",
					subject: "the named customer",
					question: "May we name the customer?",
					recommendedResponse: null,
					whyItMatters: null,
					source: "MODEL",
				},
			],
		});

		expect(doc.questions).toHaveLength(1);
		expect(isEmptyAnalysis(doc)).toBe(true);
	});

	it("is not empty when a real section is filled in", () => {
		const doc = readPlanningAnalysis({
			topicAngle: "An engineering reliability story.",
		});

		expect(isEmptyAnalysis(doc)).toBe(false);
	});

	it("is empty when nothing at all was filled in", () => {
		expect(isEmptyAnalysis(readPlanningAnalysis({}))).toBe(true);
	});
});
