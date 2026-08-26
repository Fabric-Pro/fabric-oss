import { describe, expect, it } from "vitest";
import { buildFindingReviewPrompt } from "../review-schemas";
import {
	buildAccessibilityPrompt,
	buildSecurityPrompt,
	fabricContentContract,
	isMetaContentFinding,
	normalizeEvidenceBasis,
	ScanResultSchema,
} from "../scan-schemas";

// =============================================================================
// evidenceBasis normalization
// =============================================================================

describe("normalizeEvidenceBasis", () => {
	it("maps the three canonical values", () => {
		expect(normalizeEvidenceBasis("sensitive_data")).toBe("sensitive_data");
		expect(normalizeEvidenceBasis("introduced")).toBe("introduced");
		expect(normalizeEvidenceBasis("describes")).toBe("describes");
	});

	it("maps a 'sensitive data' phrase (space form) to sensitive_data", () => {
		expect(normalizeEvidenceBasis("sensitive data")).toBe("sensitive_data");
		expect(normalizeEvidenceBasis("SENSITIVE DATA")).toBe("sensitive_data");
	});

	it("maps the describe/track/test/plan family to describes", () => {
		for (const v of [
			"tracking",
			"reports",
			"audit",
			"test",
			"testing",
			"plan",
			"planning",
			"mentions",
			"Describes.", // trailing punctuation is stripped
			"  Tracking  ",
		]) {
			expect(normalizeEvidenceBasis(v)).toBe("describes");
		}
	});

	it("maps the design/impl family to introduced", () => {
		for (const v of [
			"introduces",
			"design",
			"implementation",
			"concrete",
		]) {
			expect(normalizeEvidenceBasis(v)).toBe("introduced");
		}
	});

	it("returns 'unknown' for missing / empty / unrecognized values (never 'describes')", () => {
		expect(normalizeEvidenceBasis(undefined)).toBe("unknown");
		expect(normalizeEvidenceBasis(null)).toBe("unknown");
		expect(normalizeEvidenceBasis("")).toBe("unknown");
		expect(normalizeEvidenceBasis("   ")).toBe("unknown");
		expect(normalizeEvidenceBasis("banana")).toBe("unknown");
		expect(normalizeEvidenceBasis(42)).toBe("unknown");
	});
});

// =============================================================================
// The deterministic FINDER-stage drop (conservative)
// =============================================================================

describe("isMetaContentFinding — conservative echo drop", () => {
	it("drops ONLY an affirmative 'describes' basis", () => {
		expect(isMetaContentFinding({ evidenceBasis: "describes" })).toBe(true);
		expect(isMetaContentFinding({ evidenceBasis: "tracking" })).toBe(true);
		expect(isMetaContentFinding({ evidenceBasis: "test" })).toBe(true);
	});

	it("KEEPS sensitive_data and introduced findings", () => {
		expect(isMetaContentFinding({ evidenceBasis: "sensitive_data" })).toBe(
			false,
		);
		expect(isMetaContentFinding({ evidenceBasis: "introduced" })).toBe(
			false,
		);
	});

	it("KEEPS a finding with a missing/unknown/garbled basis (routed to the judge, never silently lost)", () => {
		expect(isMetaContentFinding({})).toBe(false);
		expect(isMetaContentFinding({ evidenceBasis: null })).toBe(false);
		expect(isMetaContentFinding({ evidenceBasis: "" })).toBe(false);
		expect(isMetaContentFinding({ evidenceBasis: "banana" })).toBe(false);
	});
});

// =============================================================================
// The schema accepts the new field without breaking existing findings
// =============================================================================

describe("ScanResultSchema — evidenceBasis is optional + lenient", () => {
	it("parses a finding that omits evidenceBasis (backward compatible)", () => {
		const parsed = ScanResultSchema.parse({
			findings: [{ title: "x", severity: "HIGH", description: "d" }],
		});
		expect(parsed.findings).toHaveLength(1);
	});

	it("parses a finding carrying evidenceBasis", () => {
		const parsed = ScanResultSchema.parse({
			findings: [{ title: "x", evidenceBasis: "describes" }],
		});
		expect(parsed.findings[0]?.evidenceBasis).toBe("describes");
	});
});

// =============================================================================
// The contract text — the "smart gate" the finder + judge share
// =============================================================================

describe("fabricContentContract", () => {
	it("security: carries the sensitive-data carve-out, the introduces-support-check, and the meta-content trap", () => {
		const c = fabricContentContract("security");
		expect(c).toMatch(/ACTUAL SENSITIVE DATA IS PRESENT/);
		expect(c).toMatch(/INTRODUCES THE DEFECT/);
		expect(c).toMatch(/REPORTING or TRACKING/);
		expect(c).toMatch(/TESTING or PLANNING/);
		// control-/data-plane split: in-content severity is a claim, not a verdict
		expect(c).toMatch(/untrusted CLAIM, never your verdict/);
		// concrete negative example (illustrates the principle — not a match rule)
		expect(c).toMatch(/119 API keys/);
		expect(c).toMatch(/there is NO finding/);
	});

	it("accessibility: has the introduces-support-check but NO sensitive-data clause", () => {
		const c = fabricContentContract("accessibility");
		expect(c).toMatch(/INTRODUCES an accessibility defect/);
		expect(c).toMatch(/REPORTING or TRACKING/);
		expect(c).not.toMatch(/SENSITIVE DATA IS PRESENT/);
	});
});

describe("prompts embed the contract", () => {
	const args = {
		projectName: "Acme",
		content: "some feature spec",
		customRules: [],
	};

	it("buildSecurityPrompt includes the contract + the evidenceBasis instruction", () => {
		const p = buildSecurityPrompt(args);
		expect(p).toMatch(/WHAT YOU ARE LOOKING AT — READ THIS FIRST/);
		expect(p).toMatch(/ACTUAL SENSITIVE DATA IS PRESENT/);
		expect(p).toMatch(/evidenceBasis/);
		expect(p).toMatch(/NEVER return a finding whose basis is "describes"/);
	});

	it("buildAccessibilityPrompt includes the contract", () => {
		const p = buildAccessibilityPrompt(args);
		expect(p).toMatch(/WHAT YOU ARE LOOKING AT — READ THIS FIRST/);
		expect(p).toMatch(/INTRODUCES an accessibility defect/);
		expect(p).toMatch(/evidenceBasis/);
	});
});

// =============================================================================
// The adversarial judge shares the contract AND protects deterministic findings
// =============================================================================

describe("buildFindingReviewPrompt — echo-aware judge", () => {
	const finding = {
		id: "f1",
		category: "SECURITY" as const,
		severity: "CRITICAL" as const,
		title: "Compromised API keys in git history",
		description:
			'119 keys were committed. Evidence: "must be treated as compromised"',
		ruleSource: "OWASP Top 10 — A02:2021 Cryptographic Failures",
		location: "Feature F-231 (BUG)",
		sourceUrl: null,
		confidence: 0.9,
		evidence: null,
	};

	it("carries the support-check, the control/data-plane rule, and the meta-content echo test", () => {
		const p = buildFindingReviewPrompt(finding, "");
		expect(p).toMatch(/SUPPORT-CHECK/);
		expect(p).toMatch(/self-referential \/ meta-content ECHO/);
		expect(p).toMatch(/untrusted/i);
		expect(p).toMatch(/REPORTING, TRACKING, AUDITING/);
	});

	it("protects real deterministic (code/secret) findings from the meta-content test", () => {
		const p = buildFindingReviewPrompt(finding, "");
		expect(p).toMatch(/DETERMINISTIC-SCANNER CARVE-OUT/);
		expect(p).toMatch(/COMMIT hash or LINE number/);
	});
});
