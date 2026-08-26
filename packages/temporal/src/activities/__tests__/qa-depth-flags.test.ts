import { describe, expect, it } from "vitest";
import { computeQaDepthFlags } from "../project-document-generation";

describe("computeQaDepthFlags", () => {
	it('returns only isLightQA true for "LIGHT"', () => {
		expect(computeQaDepthFlags("LIGHT")).toEqual({
			isLightQA: true,
			isStandardQA: false,
			isStrictQA: false,
		});
	});

	it('returns only isStandardQA true for "STANDARD"', () => {
		expect(computeQaDepthFlags("STANDARD")).toEqual({
			isLightQA: false,
			isStandardQA: true,
			isStrictQA: false,
		});
	});

	it('returns only isStrictQA true for "STRICT"', () => {
		expect(computeQaDepthFlags("STRICT")).toEqual({
			isLightQA: false,
			isStandardQA: false,
			isStrictQA: true,
		});
	});

	it("defaults to STANDARD when level is null", () => {
		expect(computeQaDepthFlags(null)).toEqual({
			isLightQA: false,
			isStandardQA: true,
			isStrictQA: false,
		});
	});

	it("defaults to STANDARD when level is undefined", () => {
		expect(computeQaDepthFlags(undefined)).toEqual({
			isLightQA: false,
			isStandardQA: true,
			isStrictQA: false,
		});
	});
});
