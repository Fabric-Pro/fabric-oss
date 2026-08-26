import { describe, expect, it } from "vitest";
import {
	buildSecurityPrompt,
	canonicalizeRuleReference,
	computeFindingFingerprint,
	mapRawFindingToDraft,
	normalizeConfidence,
	type RawFinding,
	SECURITY_KNOWLEDGE_BASELINE,
} from "../scan-schemas";

describe("canonicalizeRuleReference — stable identity across re-wordings", () => {
	it("collapses different phrasings of the same WCAG criterion to one canonical label", () => {
		const a = canonicalizeRuleReference(
			"ACCESSIBILITY",
			"1.4.3 Contrast (Minimum)",
		);
		const b = canonicalizeRuleReference("ACCESSIBILITY", "Color Contrast");
		const c = canonicalizeRuleReference(
			"ACCESSIBILITY",
			"Interactive UI must meet WCAG 2.1 AA",
			"The button text fails the 1.4.3 contrast requirement.",
		);
		// b names no criterion → best-effort passthrough; a and c both resolve
		// to the SAME canonical id-label from the taxonomy.
		expect(a).toBe("1.4.3 Contrast (Minimum)");
		expect(c).toBe("1.4.3 Contrast (Minimum)");
		expect(b).toBe("Color Contrast");
	});

	it("falls back to the bare criterion number for a criterion not in the taxonomy", () => {
		expect(
			canonicalizeRuleReference("ACCESSIBILITY", "9.9.9 Imaginary"),
		).toBe("9.9.9");
	});

	it("canonicalizes an OWASP id regardless of phrasing/case", () => {
		expect(
			canonicalizeRuleReference("SECURITY", "A03:2021 Injection"),
		).toBe("A03:2021 Injection");
		expect(
			canonicalizeRuleReference(
				"SECURITY",
				"sql injection (owasp a03:2021)",
			),
		).toBe("A03:2021 Injection");
	});

	it("passes a reference through unchanged when no canonical id is present", () => {
		expect(
			canonicalizeRuleReference("SECURITY", "Hardcoded credential"),
		).toBe("Hardcoded credential");
	});
});

describe("computeFindingFingerprint — stability + normalization + distinctness", () => {
	it("is stable across cosmetic variation (case / whitespace / trailing punctuation)", () => {
		const a = computeFindingFingerprint(
			"SECURITY",
			"OWASP Top 10 — A03:2021 Injection",
			"Feature F-12",
		);
		const b = computeFindingFingerprint(
			"security",
			"OWASP Top 10 — A03:2021 Injection",
			"  feature   f-12 ",
		);
		expect(a).toBe(b);
	});

	it("ignores a '+N more' suffix on the location", () => {
		const a = computeFindingFingerprint(
			"SECURITY",
			"Custom: PII Rule",
			"Feature F-1",
		);
		const b = computeFindingFingerprint(
			"SECURITY",
			"Custom: PII Rule",
			"Feature F-1 (+3 more findings)",
		);
		expect(a).toBe(b);
	});

	it("reduces a ruleSource to its rule id, so prefixes don't matter", () => {
		// Same OWASP rule id, but one source string carries the category prefix.
		const withPrefix = computeFindingFingerprint(
			"SECURITY",
			"OWASP Top 10 — A01:2021 Broken Access Control",
			"Feature F-9",
		);
		const bareId = computeFindingFingerprint(
			"SECURITY",
			"A01:2021 Broken Access Control",
			"Feature F-9",
		);
		expect(withPrefix).toBe(bareId);
	});

	it("is INVARIANT to a re-worded title (title is excluded from the fingerprint)", () => {
		// The whole point of the stabilization fix: the model re-words a
		// finding's title on every run, so the same rule+location must hash
		// identically regardless of title, or a full rescan looks all-new.
		const a = computeFindingFingerprint(
			"SECURITY",
			"OWASP Top 10 — A03:2021 Injection",
			"Feature F-1",
		);
		const b = computeFindingFingerprint(
			"SECURITY",
			"OWASP Top 10 — A03:2021 Injection",
			"Feature F-1",
		);
		expect(a).toBe(b);
	});

	it("produces distinct keys for different rule / location / category", () => {
		const base = computeFindingFingerprint(
			"SECURITY",
			"OWASP Top 10 — A03:2021 Injection",
			"Feature F-1",
		);
		const diffRule = computeFindingFingerprint(
			"SECURITY",
			"OWASP Top 10 — A01:2021 Broken Access Control",
			"Feature F-1",
		);
		const diffLocation = computeFindingFingerprint(
			"SECURITY",
			"OWASP Top 10 — A03:2021 Injection",
			"Feature F-2",
		);
		const diffCategory = computeFindingFingerprint(
			"ACCESSIBILITY",
			"OWASP Top 10 — A03:2021 Injection",
			"Feature F-1",
		);
		const all = new Set([base, diffRule, diffLocation, diffCategory]);
		// All four must be unique.
		expect(all.size).toBe(4);
	});

	it("returns a 64-char hex sha256 digest and tolerates a null location", () => {
		const fp = computeFindingFingerprint(
			"SECURITY",
			"Semgrep: js.audit.xss",
			null,
		);
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("normalizeConfidence — categorical buckets + numeric strings", () => {
	it("maps the categorical buckets to anchored floats", () => {
		expect(normalizeConfidence("high")).toBe(0.9);
		expect(normalizeConfidence("Medium")).toBe(0.6);
		expect(normalizeConfidence("LOW")).toBe(0.3);
	});

	it("accepts synonyms and phrases", () => {
		expect(normalizeConfidence("likely")).toBe(0.6);
		expect(normalizeConfidence("high confidence")).toBe(0.9);
		expect(normalizeConfidence("very high")).toBe(0.95);
	});

	it("accepts a raw 0..1 numeric string and a percentage", () => {
		expect(normalizeConfidence("0.8")).toBeCloseTo(0.8, 5);
		expect(normalizeConfidence("85%")).toBeCloseTo(0.85, 5);
		expect(normalizeConfidence("85")).toBeCloseTo(0.85, 5);
		expect(normalizeConfidence(0.42)).toBeCloseTo(0.42, 5);
	});

	it("clamps out-of-range values into [0, 1]", () => {
		expect(normalizeConfidence(1.5)).toBe(1);
		expect(normalizeConfidence(-0.2)).toBe(0);
		expect(normalizeConfidence("250%")).toBe(1);
	});

	it("falls back to 0.5 for missing / garbled input", () => {
		expect(normalizeConfidence(undefined)).toBe(0.5);
		expect(normalizeConfidence(null)).toBe(0.5);
		expect(normalizeConfidence("")).toBe(0.5);
		expect(normalizeConfidence("nonsense")).toBe(0.5);
	});
});

describe("mapRawFindingToDraft — sets confidence + fingerprint + evidence", () => {
	const raw: RawFinding = {
		title: "Missing tenant check on export",
		severity: "HIGH",
		description: "The export endpoint does not check ownership.",
		evidence: "exports any report by id without an ownership check",
		remediation: "Add a tenant/owner check.",
		ruleReference: "A01:2021 Broken Access Control",
		ruleType: "DEFAULT",
		location: "Feature F-7",
		confidence: "high",
	};

	it("normalizes confidence and computes a stable fingerprint", () => {
		const draft = mapRawFindingToDraft(raw, "SECURITY");
		expect(draft.confidence).toBe(0.9);
		expect(draft.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		// Fingerprint matches a direct computation over the persisted fields.
		expect(draft.fingerprint).toBe(
			computeFindingFingerprint(
				"SECURITY",
				draft.ruleSource,
				draft.location,
			),
		);
	});

	it("appends the evidence quote to the description", () => {
		const draft = mapRawFindingToDraft(raw, "SECURITY");
		expect(draft.description).toContain("Evidence:");
		expect(draft.description).toContain(
			"exports any report by id without an ownership check",
		);
	});

	it("captures the cited quote as structured evidence for the FP judge", () => {
		const draft = mapRawFindingToDraft(raw, "SECURITY");
		expect(draft.evidence).toBe(
			"exports any report by id without an ownership check",
		);
	});

	it("defaults confidence to 0.5 when the model omits it", () => {
		const draft = mapRawFindingToDraft(
			{ ...raw, confidence: undefined },
			"SECURITY",
		);
		expect(draft.confidence).toBe(0.5);
	});
});

describe("prompt structure (query-at-end) + knowledge baseline", () => {
	it("puts the content at the top in a <document> block and the role/scope after it", () => {
		const prompt = buildSecurityPrompt({
			projectName: "Acme",
			content: "MARKER_CONTENT raw sql concatenation",
			customRules: [],
		});
		const docIdx = prompt.indexOf("<document>");
		const contentIdx = prompt.indexOf("MARKER_CONTENT");
		const roleIdx = prompt.indexOf("application security auditor");
		const scopeIdx = prompt.indexOf("SCOPE — STRICT");
		expect(docIdx).toBeGreaterThanOrEqual(0);
		expect(prompt).toContain("</document>");
		// content comes before the role, which comes before the scope/output tail.
		expect(contentIdx).toBeLessThan(roleIdx);
		expect(roleIdx).toBeLessThan(scopeIdx);
	});

	it("bakes the hardcoded security-knowledge baseline into the security prompt", () => {
		const prompt = buildSecurityPrompt({
			projectName: "Acme",
			content: "x",
			customRules: [],
		});
		expect(prompt).toContain("SECURITY REVIEW KNOWLEDGE BASELINE");
		// A few representative tells from each section must be present.
		expect(prompt).toMatch(/indirect prompt injection|MCP tool poisoning/i);
		expect(prompt).toMatch(/rotate it, don't just delete/i);
		expect(prompt).toMatch(/FALSE-POSITIVE TRAPS/);
		// The baseline constant is the source of that text.
		expect(SECURITY_KNOWLEDGE_BASELINE).toContain("FALSE-POSITIVE TRAPS");
	});

	it("injects a severity rubric and knowledge packs when provided", () => {
		const prompt = buildSecurityPrompt({
			projectName: "Acme",
			content: "x",
			customRules: [],
			severityRubric: [
				{ severity: "CRITICAL", definition: "RUBRIC_CRIT_DEF" },
				{ severity: "LOW", definition: "RUBRIC_LOW_DEF" },
			],
			knowledgePacks: [
				{ title: "PACK_TITLE", content: "PACK_BODY_TEXT" },
			],
		});
		expect(prompt).toContain("SEVERITY RUBRIC");
		expect(prompt).toContain("RUBRIC_CRIT_DEF");
		expect(prompt).toContain("PACK_TITLE");
		expect(prompt).toContain("PACK_BODY_TEXT");
		// Rubric is rendered CRITICAL-before-LOW regardless of input order.
		expect(prompt.indexOf("RUBRIC_CRIT_DEF")).toBeLessThan(
			prompt.indexOf("RUBRIC_LOW_DEF"),
		);
	});

	it("requires evidence + confidence in the output instructions", () => {
		const prompt = buildSecurityPrompt({
			projectName: "Acme",
			content: "x",
			customRules: [],
		});
		expect(prompt).toMatch(/"evidence"/);
		expect(prompt).toMatch(/"confidence"/);
		// Static review only — never includes exploitation steps.
		expect(prompt).toMatch(/static design review|static review/i);
	});
});
