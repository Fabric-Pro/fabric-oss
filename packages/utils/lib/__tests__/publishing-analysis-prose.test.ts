import { describe, expect, it } from "vitest";
import {
	effectivePlanningAnalysis,
	renderAnalysisProse,
	splitAnalysis,
} from "../publishing-analysis-prose";

const AI = {
	topicAngle: "Open sourcing the platform",
	whyWorthPublishing: "First public release",
	keyDetails: { released: "v1.0", problem: "No public build" },
	contentTypes: { recommended: [{ type: "Tweet", rationale: "short" }] },
	sourceSignals: ["pr-1"],
	risks: ["Names a customer"],
	preDraftGuidance: "Check legal first",
};

describe("splitAnalysis", () => {
	it("puts prose in the document and leaves data structured", () => {
		const { prose, data } = splitAnalysis(AI);
		expect(prose).toContain("### Topic angle");
		expect(prose).toContain("Open sourcing the platform");
		expect(prose).toContain("### Risks");
		expect(prose).toContain("### Pre draft guidance");
		expect(prose).not.toContain("### Content types");
		expect(data.contentTypes).toEqual(AI.contentTypes);
		expect(data.sourceSignals).toEqual(["pr-1"]);
		expect("risks" in data).toBe(false);
	});

	it("omits an empty prose field rather than rendering a bare heading", () => {
		const prose = renderAnalysisProse({ topicAngle: "", risks: [] });
		expect(prose).toBe("");
	});
});

describe("effectivePlanningAnalysis", () => {
	it("returns AI prose when there is no revision", () => {
		const r = effectivePlanningAnalysis({ ai: AI, revision: null });
		expect(r?.prose).toBe(renderAnalysisProse(AI));
		expect(r?.overridden).toBe(false);
	});

	it("returns the revision body when one exists", () => {
		const r = effectivePlanningAnalysis({
			ai: AI,
			revision: { body: "my own words", sourceAnalysisVersion: 1 },
		});
		expect(r?.prose).toBe("my own words");
		expect(r?.overridden).toBe(true);
		expect(r?.data.contentTypes).toEqual(AI.contentTypes);
	});

	it("treats an EMPTY revision body as a deliberate override, not as absent", () => {
		const r = effectivePlanningAnalysis({
			ai: AI,
			revision: { body: "", sourceAnalysisVersion: 1 },
		});
		expect(r?.prose).toBe("");
		expect(r?.overridden).toBe(true);
	});

	it("returns null when there is no analysis at all", () => {
		expect(
			effectivePlanningAnalysis({ ai: null, revision: null }),
		).toBeNull();
	});
});
