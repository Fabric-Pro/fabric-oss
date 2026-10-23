/**
 * Glossy's detection and extraction prompts, pinned byte for byte to the
 * text they had before the Proposal artifact's visuals step gained its own
 * options (Fizzy #2946). Those options add guidance only when set, so a
 * Glossy build, a Business Case's included, asks exactly what it asked
 * before. A change here is a Glossy prompt change and needs a
 * `GLOSSY_PIPELINE_VERSION` bump and a new baseline.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	buildGlossyDetectInstructions,
	buildGlossyDetectPrompt,
	buildGlossyExtractInstructions,
	buildGlossyExtractPrompt,
} from "../index";

const baseline = JSON.parse(
	readFileSync(
		new URL("./fixtures/glossy-prompts-baseline.json", import.meta.url),
		"utf8",
	),
) as Record<string, string>;

const sections = [
	{
		ref: "sec-1",
		heading: "Timeline",
		markdown: "Q1 2026 discovery, then Q2 2026 build.",
		reservedKinds: ["stat"],
	},
	{
		ref: "sec-2",
		heading: "Appendix A. Architecture",
		markdown: "The gateway calls the service.",
	},
	{ ref: "sec-3", heading: null, markdown: "Plain narrative." },
];

describe("Glossy prompts without the Proposal options", () => {
	it.each(["BUSINESS_CASE", "PROPOSAL", "OTHER"])(
		"keeps the %s detection and extraction instructions unchanged",
		(documentType) => {
			expect(buildGlossyDetectInstructions(documentType)).toBe(
				baseline[`detectInstructions:${documentType}`],
			);
			expect(buildGlossyExtractInstructions(documentType)).toBe(
				baseline[`extractInstructions:${documentType}`],
			);
			expect(
				buildGlossyDetectInstructions(documentType, {
					proposalArtifact: false,
				}),
			).toBe(baseline[`detectInstructions:${documentType}`]);
		},
	);

	it("keeps the detection and extraction prompts unchanged", () => {
		expect(buildGlossyDetectPrompt({ sections, limit: 8 })).toBe(
			baseline.detectPrompt,
		);
		expect(
			buildGlossyDetectPrompt({
				sections: sections.slice(0, 1),
				limit: 1,
			}),
		).toBe(baseline.detectPromptOne);
		expect(
			buildGlossyExtractPrompt({
				kind: "timeline",
				heading: "Timeline",
				markdown: "Q1 2026 discovery.",
				styleDirection: "Calm",
				slotHint: "Phases",
				variantNonce: "abc-123",
			}),
		).toBe(baseline.extractPrompt);
		expect(
			buildGlossyExtractPrompt({
				kind: "auto",
				heading: null,
				markdown: "Body.",
			}),
		).toBe(baseline.extractPromptAuto);
	});
});
