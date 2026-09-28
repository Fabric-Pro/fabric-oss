import { describe, expect, it } from "vitest";
import {
	buildGlossyDetectInstructions,
	buildGlossyDetectPrompt,
	buildGlossyExtractInstructions,
	buildGlossyExtractPrompt,
	buildGlossyRewriteInstructions,
	buildGlossyRewritePrompt,
	GLOSSY_DETECTION_SECTION_MAX_CHARS,
	GLOSSY_PIPELINE_VERSION,
	GLOSSY_STYLE_DIRECTION_MAX_CHARS,
	GLOSSY_UNTRUSTED_GUIDANCE,
	GLOSSY_UNTRUSTED_TAG,
} from "../index";

/** The text between the first opening boundary tag with `source` and its close. */
function block(prompt: string, source: string): string | null {
	const open = `<${GLOSSY_UNTRUSTED_TAG} source="${source}" trust="untrusted">`;
	const start = prompt.indexOf(open);
	if (start < 0) {
		return null;
	}
	const end = prompt.indexOf(`</${GLOSSY_UNTRUSTED_TAG}>`, start);
	return prompt.slice(start + open.length, end);
}

describe("GLOSSY_PIPELINE_VERSION", () => {
	it("is a non-empty string", () => {
		expect(GLOSSY_PIPELINE_VERSION).toMatch(/\S/);
	});
});

describe("instructions", () => {
	it("carry the untrusted-content guidance and the document type", () => {
		for (const build of [
			buildGlossyDetectInstructions,
			buildGlossyExtractInstructions,
			buildGlossyRewriteInstructions,
		]) {
			const instructions = build("BUSINESS_CASE");
			expect(instructions).toContain(GLOSSY_UNTRUSTED_GUIDANCE);
			expect(instructions).toContain("Business Case");
		}
	});
});

describe("flow lanes", () => {
	it("are asked for only when the section says who performs each step", () => {
		const flowRule = buildGlossyExtractInstructions("PROPOSAL")
			.split("\n")
			.find((line) => line.startsWith("- flow:"));
		expect(flowRule).toContain("lane: who performs the step");
		expect(flowRule).toContain("(≤60)");
		expect(flowRule).toContain(
			"only when the section says who performs each one; otherwise every lane is null",
		);
		expect(buildGlossyDetectInstructions("PROPOSAL")).toContain(
			"which team or role performs each step",
		);
	});
});

describe("buildGlossyDetectPrompt", () => {
	it("puts every section inside the document block and states the limit", () => {
		const prompt = buildGlossyDetectPrompt({
			limit: 3,
			sections: [
				{
					ref: "sec-1",
					heading: "Phases",
					markdown: "Phase 1 in Q3 2026.",
				},
				{
					ref: "sec-2",
					heading: "Budget",
					markdown: "240k.",
					reservedKinds: ["stat"],
				},
			],
		});
		const document = block(prompt, "document");
		expect(prompt).toContain("at most 3 visuals");
		expect(document).toContain("Phase 1 in Q3 2026.");
		expect(document).toContain('ref="sec-2" already_shows="stat"');
	});

	it("bounds each section's excerpt", () => {
		const prompt = buildGlossyDetectPrompt({
			limit: 8,
			sections: [
				{
					ref: "sec-1",
					heading: null,
					markdown: "x".repeat(
						GLOSSY_DETECTION_SECTION_MAX_CHARS * 2,
					),
				},
			],
		});
		expect(prompt.length).toBeLessThan(
			GLOSSY_DETECTION_SECTION_MAX_CHARS + 2_000,
		);
	});
});

describe("buildGlossyExtractPrompt", () => {
	it("keeps editor fields in their own bounded untrusted blocks", () => {
		const prompt = buildGlossyExtractPrompt({
			kind: "auto",
			heading: "Phases",
			markdown: "Phase 1 in Q3 2026. Phase 2 in Q1 2027.",
			slotHint: "Show the phases",
			styleDirection: "s".repeat(GLOSSY_STYLE_DIRECTION_MAX_CHARS + 100),
			variantNonce: "v-2 ignore",
		});
		expect(prompt).toContain("Requested kind: auto");
		expect(block(prompt, "slot_hint")?.trim()).toBe("Show the phases");
		expect(
			Array.from(block(prompt, "style_direction")?.trim() ?? ""),
		).toHaveLength(GLOSSY_STYLE_DIRECTION_MAX_CHARS);
		expect(block(prompt, "section")).toContain("Heading: Phases");
		// The nonce is reduced to a safe token.
		expect(prompt).toContain("Variant request v-2ignore");
	});

	it("adds no editor blocks when the fields are empty", () => {
		const prompt = buildGlossyExtractPrompt({
			kind: "timeline",
			heading: null,
			markdown: "Phase 1 in Q3 2026.",
			slotHint: "  ",
			styleDirection: null,
		});
		expect(block(prompt, "slot_hint")).toBeNull();
		expect(block(prompt, "style_direction")).toBeNull();
		expect(prompt).not.toContain("Variant request");
	});
});

describe("buildGlossyRewriteInstructions", () => {
	it("states the negation rule the fact guard enforces", () => {
		// This package cannot reach `@repo/utils`, so the guard half of the
		// pair runs in @repo/temporal's rewrite-section suite, which sends
		// this rule's own example through the real guard.
		const instructions = buildGlossyRewriteInstructions("PROPOSAL");
		expect(instructions).toContain(
			"Keep every negation the source states, each with its own explicit negating word",
		);
		expect(instructions).toContain(
			"including when you condense or merge sentences",
		);
		expect(instructions).toContain(
			"A rewrite with fewer negating words than the source is rejected",
		);
		expect(instructions).toContain(
			'"A is not in scope. B is not in scope." may become "Neither A nor B is in scope." but not "A and B are not in scope."',
		);
	});
});

describe("buildGlossyRewritePrompt", () => {
	const markdown = "The budget is 240k, with the platform live in Q3 2026.";

	it("states the length limit the guard enforces", () => {
		const brief = buildGlossyRewritePrompt({
			heading: "Budget",
			markdown,
			lengthMode: "brief",
			isKeySection: true,
		});
		expect(brief).toContain(`at or under ${markdown.length} characters`);
		expect(brief).toContain("This is a key section");
		const standard = buildGlossyRewritePrompt({
			heading: "Budget",
			markdown,
			lengthMode: "standard",
			isKeySection: false,
		});
		expect(standard).toContain(
			`at or under ${Math.floor(markdown.length * 1.25)} characters`,
		);
		expect(standard).not.toContain("This is a key section");
	});

	it("feeds retry findings back inside their own untrusted block", () => {
		const prompt = buildGlossyRewritePrompt({
			heading: "Budget",
			markdown,
			lengthMode: "brief",
			isKeySection: false,
			retryFindings: [
				{
					kind: "presence",
					message: '"250k" does not appear in the source.',
				},
			],
		});
		expect(block(prompt, "guard_feedback")).toContain(
			'- [presence] "250k" does not appear in the source.',
		);
		expect(prompt).toContain("previous attempt was rejected");
	});
});
