import { describe, expect, it } from "vitest";
import {
	GLOSSY_ELIGIBLE_DOCUMENT_TYPES,
	isGlossyEligible,
} from "../lib/glossy/eligibility";

describe("isGlossyEligible", () => {
	it("is true for PROPOSAL and BUSINESS_CASE", () => {
		expect(isGlossyEligible("PROPOSAL")).toBe(true);
		expect(isGlossyEligible("BUSINESS_CASE")).toBe(true);
	});

	it("is false for every other document type", () => {
		expect(isGlossyEligible("PRD")).toBe(false);
		expect(isGlossyEligible("GENERAL")).toBe(false);
	});

	it("is false for an unknown string rather than throwing", () => {
		expect(isGlossyEligible("NOT_A_REAL_TYPE")).toBe(false);
		expect(isGlossyEligible("")).toBe(false);
	});

	it("GLOSSY_ELIGIBLE_DOCUMENT_TYPES lists exactly the two eligible types", () => {
		expect(GLOSSY_ELIGIBLE_DOCUMENT_TYPES).toEqual([
			"PROPOSAL",
			"BUSINESS_CASE",
		]);
	});
});
