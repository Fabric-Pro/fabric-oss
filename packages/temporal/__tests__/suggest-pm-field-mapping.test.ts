/**
 * Fallback ranking tests — used only when a project's process exposes no form
 * definition, so "is this a body?" has to be inferred from the value itself.
 *
 * All values are synthetic.
 */
import { describe, expect, it } from "vitest";
import {
	renderFieldMap,
	scoreFieldCandidates,
} from "../src/activities/pm-integration/suggest-pm-field-mapping";

const PROSE = [
	"This story adds a photo-requirement filter to the billing queues so",
	"reviewers can segment records. It also introduces a reminder email.",
].join("\n");

const SHORT_PROSE = "Acceptance: the filter persists across page reloads.";

const values: Record<string, string> = {
	"System.Description": PROSE,
	"Custom.BusinessRules": SHORT_PROSE,
	"Custom.SummaryPlaceholder": "TBD",
	"Custom.DesignState": "Approved",
	"Custom.StateSummary": "42",
};

const candidateIds = Object.keys(values);

function rank() {
	return scoreFieldCandidates({ candidateIds, values });
}

describe("scoreFieldCandidates (fallback ranking)", () => {
	it("ranks the long-form prose field first", () => {
		expect(rank()[0]?.id).toBe("System.Description");
	});

	it("ranks prose above scalars and short placeholders", () => {
		const order = rank().map((s) => s.id);
		expect(order.indexOf("Custom.BusinessRules")).toBeLessThan(
			order.indexOf("Custom.DesignState"),
		);
		expect(order.indexOf("Custom.BusinessRules")).toBeLessThan(
			order.indexOf("Custom.StateSummary"),
		);
	});

	it("flags short enums and numeric scalars as non-content", () => {
		const byId = Object.fromEntries(rank().map((s) => [s.id, s]));
		expect(byId["Custom.DesignState"]?.isContentControl).toBe(false);
		expect(byId["Custom.StateSummary"]?.isContentControl).toBe(false);
		expect(byId["System.Description"]?.isContentControl).toBe(true);
	});

	it("reports character counts and populated state from the example", () => {
		const description = rank().find((s) => s.id === "System.Description");
		expect(description?.charCount).toBe(PROSE.length);
		expect(description?.populatedOnExample).toBe(true);
	});

	it("truncates the example preview for display", () => {
		const long = "x".repeat(900);
		const [only] = scoreFieldCandidates({
			candidateIds: ["Custom.Long"],
			values: { "Custom.Long": long },
		});
		expect(only?.examplePreview.length).toBeLessThan(long.length);
		expect(only?.examplePreview.endsWith("\u2026")).toBe(true);
	});

	it("returns zeroed stats for a candidate with no value", () => {
		const [absent] = scoreFieldCandidates({
			candidateIds: ["Custom.NeverSet"],
			values: {},
		});
		expect(absent?.charCount).toBe(0);
		expect(absent?.score).toBe(0);
		expect(absent?.populatedOnExample).toBe(false);
	});
});

describe("renderFieldMap", () => {
	it("keeps only fields that render to non-empty text", () => {
		const rendered = renderFieldMap({
			"System.Description": "<p>Hello there.</p>",
			"Custom.Empty": "",
			"Custom.Blank": "<p></p>",
			"Custom.Count": 12,
			"Custom.Flag": false,
			"Custom.Missing": null,
			"Custom.Nested": { id: 1 },
		});

		expect(Object.keys(rendered).sort()).toEqual([
			"Custom.Count",
			"Custom.Flag",
			"System.Description",
		]);
		expect(rendered["System.Description"]).toContain("Hello there.");
	});

	it("returns an empty map when the work item carries no fields", () => {
		expect(renderFieldMap(undefined)).toEqual({});
	});
});
