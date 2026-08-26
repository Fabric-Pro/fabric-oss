import { describe, expect, it } from "vitest";
import {
	buildFindingReviewPrompt,
	DEFAULT_FP_JUDGE_RUBRIC,
	type ReviewFindingInput,
} from "../review-schemas";
import {
	ACCESSIBILITY_KNOWLEDGE_BASELINE,
	buildAccessibilityPrompt,
	buildSecurityPrompt,
	defaultAccessibilityReviewerGuidance,
	defaultSecurityReviewerGuidance,
	fabricContentContract,
	SECURITY_KNOWLEDGE_BASELINE,
} from "../scan-schemas";

// A distinctive sentinel none of the default guidance/rubric text contains, so
// "override wins" and "default is gone" are both unambiguous.
const GUIDANCE_SENTINEL =
	"CUSTOM-REVIEWER-GUIDANCE-SENTINEL — org override applied here.";
const RUBRIC_SENTINEL =
	"CUSTOM-ADVERSARIAL-RUBRIC-SENTINEL — org override applied here.";

// Stable markers unique to each default block.
const SEC_BASELINE_MARKER = "SECURITY REVIEW KNOWLEDGE BASELINE";
const A11Y_BASELINE_MARKER = "ACCESSIBILITY REVIEW KNOWLEDGE BASELINE";
const CONTRACT_MARKER = "WHAT YOU ARE LOOKING AT — READ THIS FIRST";
const JUDGE_MARKER = "REFUTE BY DEFAULT";

const scanArgs = {
	projectName: "Acme",
	content: "some feature spec",
	customRules: [],
};

// =============================================================================
// Default-guidance helpers
// =============================================================================

describe("defaultSecurityReviewerGuidance", () => {
	it("is exactly the security baseline + the security contract, joined by a blank line", () => {
		expect(defaultSecurityReviewerGuidance()).toBe(
			`${SECURITY_KNOWLEDGE_BASELINE}\n\n${fabricContentContract("security")}`,
		);
	});

	it("contains the baseline text AND the false-positive contract", () => {
		const g = defaultSecurityReviewerGuidance();
		expect(g).toContain(SEC_BASELINE_MARKER);
		expect(g).toContain(CONTRACT_MARKER);
		expect(g).toMatch(/ACTUAL SENSITIVE DATA IS PRESENT/);
	});
});

describe("defaultAccessibilityReviewerGuidance", () => {
	it("is exactly the accessibility baseline + the accessibility contract, joined by a blank line", () => {
		expect(defaultAccessibilityReviewerGuidance()).toBe(
			`${ACCESSIBILITY_KNOWLEDGE_BASELINE}\n\n${fabricContentContract("accessibility")}`,
		);
	});

	it("contains the WCAG baseline text AND the false-positive contract", () => {
		const g = defaultAccessibilityReviewerGuidance();
		expect(g).toContain(A11Y_BASELINE_MARKER);
		expect(g).toContain(CONTRACT_MARKER);
		expect(g).toMatch(/INTRODUCES an accessibility defect/);
	});
});

// =============================================================================
// buildSecurityPrompt — override vs default
// =============================================================================

describe("buildSecurityPrompt — reviewerGuidance override", () => {
	it("uses the in-code default when reviewerGuidance is omitted (baseline + contract present exactly once)", () => {
		const p = buildSecurityPrompt(scanArgs);
		expect(p).toContain(SEC_BASELINE_MARKER);
		expect(p).toContain(CONTRACT_MARKER);
		// The whole default guidance block appears verbatim.
		expect(p).toContain(defaultSecurityReviewerGuidance());
		// Baseline moved early -> late: it must appear exactly ONCE (no leftover
		// early injection duplicating it).
		expect(p.split(SEC_BASELINE_MARKER)).toHaveLength(2);
	});

	it("uses the provided guidance and drops the default baseline + contract when overridden", () => {
		const p = buildSecurityPrompt({
			...scanArgs,
			reviewerGuidance: GUIDANCE_SENTINEL,
		});
		expect(p).toContain(GUIDANCE_SENTINEL);
		expect(p).not.toContain(SEC_BASELINE_MARKER);
		expect(p).not.toContain(CONTRACT_MARKER);
	});
});

// =============================================================================
// buildAccessibilityPrompt — override vs default
// =============================================================================

describe("buildAccessibilityPrompt — reviewerGuidance override", () => {
	it("uses the in-code default when reviewerGuidance is omitted (baseline + contract present exactly once)", () => {
		const p = buildAccessibilityPrompt(scanArgs);
		expect(p).toContain(A11Y_BASELINE_MARKER);
		expect(p).toContain(CONTRACT_MARKER);
		expect(p).toContain(defaultAccessibilityReviewerGuidance());
		expect(p.split(A11Y_BASELINE_MARKER)).toHaveLength(2);
	});

	it("uses the provided guidance and drops the default baseline + contract when overridden", () => {
		const p = buildAccessibilityPrompt({
			...scanArgs,
			reviewerGuidance: GUIDANCE_SENTINEL,
		});
		expect(p).toContain(GUIDANCE_SENTINEL);
		expect(p).not.toContain(A11Y_BASELINE_MARKER);
		expect(p).not.toContain(CONTRACT_MARKER);
	});
});

// =============================================================================
// buildFindingReviewPrompt — adversarialRubric override (4th param)
// =============================================================================

describe("buildFindingReviewPrompt — adversarialRubric override", () => {
	const finding: ReviewFindingInput = {
		id: "f1",
		category: "SECURITY",
		severity: "HIGH",
		title: "Example finding",
		description: "Some described issue.",
		ruleSource: "OWASP Top 10 — A03:2021 Injection",
		location: "Feature F-1",
		sourceUrl: null,
		confidence: 0.6,
		evidence: null,
	};

	it("uses DEFAULT_FP_JUDGE_RUBRIC when the 4th param is omitted", () => {
		const p = buildFindingReviewPrompt(finding, "");
		expect(p).toContain(JUDGE_MARKER);
		expect(p).toContain(DEFAULT_FP_JUDGE_RUBRIC);
	});

	it("uses the provided rubric and drops the default when overridden", () => {
		const p = buildFindingReviewPrompt(
			finding,
			"",
			undefined,
			RUBRIC_SENTINEL,
		);
		expect(p).toContain(RUBRIC_SENTINEL);
		expect(p).not.toContain(JUDGE_MARKER);
	});

	it("still honors the override when an evidence excerpt is also passed (3rd param)", () => {
		const p = buildFindingReviewPrompt(
			finding,
			"",
			"an evidence excerpt",
			RUBRIC_SENTINEL,
		);
		expect(p).toContain("an evidence excerpt");
		expect(p).toContain(RUBRIC_SENTINEL);
		expect(p).not.toContain(JUDGE_MARKER);
	});
});
