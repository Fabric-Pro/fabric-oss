/**
 * `isEmptyAnalysis` — whether a topic's planning analysis has anything worth
 * rendering (Publishing Suite, Fizzy #1851).
 *
 * It takes the RESOLVER's output and nothing else. Until Task 11 it also
 * accepted a parsed `PlanningAnalysisDocument`, because `PlanningAnalysisTab`
 * still read the raw AI row for its own rendering; that overload was
 * scaffolding for Tasks 9-11 and went with the commit that moved the tab onto
 * the resolver. The cases below are the ones that survived, plus the parser's
 * own contract on the DATA half it is now always fed.
 */

import {
	isEmptyAnalysis,
	readPlanningAnalysis,
} from "@saas/projects/components/publishing-suite/planning-analysis-content";
import { describe, expect, it } from "vitest";

describe("isEmptyAnalysis — against the resolver's output", () => {
	// `risks` and `preDraftGuidance` moved from data this file parsed off the
	// raw JSON to PROSE, resolved (AI text, or the author's own override) by
	// `effectivePlanningAnalysis`. A check that only looked at the parsed DATA
	// half would call an analysis whose entire substance is a rich risks
	// section "empty" — and, through the media-tab gate in `TopicItemPage.tsx`,
	// take the user's generation tabs with it.
	it("is NOT empty when all the substance is in the prose", () => {
		expect(
			isEmptyAnalysis({
				prose: "### Risks\n\nNames a customer",
				data: {},
				overridden: false,
			}),
		).toBe(false);
	});

	it("is NOT empty when all the substance is in the data", () => {
		expect(
			isEmptyAnalysis({
				prose: "",
				data: { contentTypes: { recommended: [{ type: "Tweet" }] } },
				overridden: false,
			}),
		).toBe(false);
	});

	it("is empty only when BOTH halves are empty", () => {
		expect(
			isEmptyAnalysis({ prose: "   ", data: {}, overridden: true }),
		).toBe(true);
	});

	it("is empty when there is no analysis at all", () => {
		expect(isEmptyAnalysis(null)).toBe(true);
	});
});

describe("readPlanningAnalysis — fed the resolver's data half", () => {
	// The tab's data sections and the media-tab gate both call it this way
	// now. Only the structured keys survive the split, so the parser has to
	// return the buckets and the signals and nothing else — an accessor that
	// went looking for prose keys here would find them all missing.
	it("returns the structured buckets and signals", () => {
		const doc = readPlanningAnalysis({
			contentTypes: {
				recommended: [
					{ type: "Blog post", rationale: "Enough depth to teach." },
				],
			},
			sourceSignals: ["Three merged pull requests."],
		});

		expect(doc.buckets).toHaveLength(1);
		expect(doc.buckets[0].buckets[0].items).toEqual([
			{ type: "Blog post", rationale: "Enough depth to teach." },
		]);
		expect(doc.sourceSignals).toEqual(["Three merged pull requests."]);
	});

	it("drops a bucket item missing either half of its shape", () => {
		// A recommendation with no rationale is not a recommendation — it
		// would render as a bare type with a dangling em dash.
		const doc = readPlanningAnalysis({
			contentTypes: {
				recommended: [
					{ type: "Blog post" },
					{ rationale: "No type given." },
				],
			},
		});

		expect(doc.buckets).toEqual([]);
	});
});
