import { describe, expect, it } from "vitest";
import {
	buildAccessibilityPrompt,
	buildScanRequest,
	buildSecurityPrompt,
	defaultAccessibilityReviewerGuidance,
	defaultSecurityReviewerGuidance,
	fabricContentContract,
	mapRawFindingToDraft,
	normalizeSeverity,
	type RawFinding,
	redactSecrets,
	ScanResultSchema,
} from "../scan-schemas";

const baseRaw: RawFinding = {
	title: "Issue",
	severity: "HIGH",
	description: "desc",
	remediation: "fix",
	ruleReference: "A03:2021 Injection",
	ruleType: "DEFAULT",
	location: "Feature F-1",
};

describe("mapRawFindingToDraft — rule-source attribution (AC3)", () => {
	it("attributes default security findings to OWASP Top 10", () => {
		const draft = mapRawFindingToDraft(baseRaw, "SECURITY");
		expect(draft.ruleSource).toBe("OWASP Top 10 — A03:2021 Injection");
		expect(draft.isCustomRule).toBe(false);
		expect(draft.location).toBe("Feature F-1");
	});

	it("attributes default accessibility findings to WCAG 2.1 AA", () => {
		const draft = mapRawFindingToDraft(
			{ ...baseRaw, ruleReference: "1.4.3 Contrast (Minimum)" },
			"ACCESSIBILITY",
		);
		expect(draft.ruleSource).toBe("WCAG 2.1 AA — 1.4.3 Contrast (Minimum)");
		expect(draft.isCustomRule).toBe(false);
	});

	it("attributes custom-rule findings with a Custom prefix and flags them", () => {
		const draft = mapRawFindingToDraft(
			{
				...baseRaw,
				ruleType: "CUSTOM",
				ruleReference: "Acme PII Rule",
			},
			"SECURITY",
		);
		expect(draft.ruleSource).toBe("Custom: Acme PII Rule");
		expect(draft.isCustomRule).toBe(true);
	});

	it("normalizes a missing location to null and clamps very long titles", () => {
		const draft = mapRawFindingToDraft(
			{ ...baseRaw, title: "x".repeat(300), location: undefined },
			"SECURITY",
		);
		expect(draft.location).toBeNull();
		expect(draft.title.length).toBeLessThanOrEqual(240);
	});
});

describe("prompt builders", () => {
	it("security prompt embeds OWASP, the content, and custom rules", () => {
		const prompt = buildSecurityPrompt({
			projectName: "Acme",
			content: "raw sql string concatenation here",
			customRules: [
				{
					name: "PII Logging",
					severity: "HIGH",
					guidance: "no PII in logs",
				},
			],
		});
		expect(prompt).toContain("OWASP Top 10");
		expect(prompt).toContain("raw sql string concatenation here");
		expect(prompt).toContain("PII Logging");
		expect(prompt).toContain("no PII in logs");
		expect(prompt).toContain('ruleType="CUSTOM"');
	});

	it("accessibility prompt embeds WCAG and the content; omits custom block when none", () => {
		const prompt = buildAccessibilityPrompt({
			projectName: "Acme",
			content: "icon-only button without a label",
			customRules: [],
		});
		expect(prompt).toContain("WCAG 2.1 Level AA");
		expect(prompt).toContain("icon-only button without a label");
		expect(prompt).not.toContain("organization-specific custom rules");
	});
});

describe("fabricContentContract — false-positive OVERRIDE rules", () => {
	it("security contract carries the three OVERRIDE rules", () => {
		const contract = fabricContentContract("security");
		expect(contract).toContain("SILENCE IS NEVER A DEFECT");
		expect(contract).toContain("ASSUME THE PLATFORM BASELINE");
		expect(contract).toContain("NO SPECULATION");
	});

	it("accessibility contract carries the OVERRIDE rules plus the a11y-specific FP rules", () => {
		const contract = fabricContentContract("accessibility");
		// A draft feature/card title is not a UI control — the biggest a11y FP.
		expect(contract).toContain("NOT a UI control");
		expect(contract).toContain("SILENCE IS NEVER A DEFECT");
		expect(contract).toContain("ASSUME THE PLATFORM BASELINE");
		expect(contract).toContain("NO SPECULATION");
	});

	it("the default reviewer-guidance blocks embed the contract (seed/migration sync source)", () => {
		expect(defaultSecurityReviewerGuidance()).toContain(
			"SILENCE IS NEVER A DEFECT",
		);
		expect(defaultAccessibilityReviewerGuidance()).toContain(
			"NOT a UI control",
		);
	});
});

describe("severity / ruleType normalization (regression for live scan failure)", () => {
	it("maps mixed-case and axe/WCAG synonyms to the canonical enum", () => {
		expect(normalizeSeverity("Critical")).toBe("CRITICAL");
		expect(normalizeSeverity("serious")).toBe("HIGH");
		expect(normalizeSeverity("Moderate")).toBe("MEDIUM");
		expect(normalizeSeverity("Minor")).toBe("LOW");
		expect(normalizeSeverity("info")).toBe("LOW");
	});

	it("falls back to MEDIUM for unknown or non-string severities", () => {
		expect(normalizeSeverity("nonsense")).toBe("MEDIUM");
		expect(normalizeSeverity(null)).toBe("MEDIUM");
		expect(normalizeSeverity(7)).toBe("MEDIUM");
	});

	it("ScanResultSchema accepts the model's varied output without throwing", () => {
		const parsed = ScanResultSchema.parse({
			findings: [
				{
					title: "Unlabeled filter inputs",
					severity: "Serious",
					description: "d",
					remediation: "r",
					ruleReference: "3.3.2 Labels or Instructions",
					ruleType: "default",
					location: "Feature F-005",
				},
			],
		});
		expect(parsed.findings).toHaveLength(1);
		// The permissive schema preserves the raw strings; normalization to the
		// canonical enum happens in mapRawFindingToDraft.
		const draft = mapRawFindingToDraft(parsed.findings[0], "ACCESSIBILITY");
		expect(draft.severity).toBe("HIGH");
		expect(draft.isCustomRule).toBe(false);
	});

	it("tolerates findings with missing fields (parse + sensible defaults)", () => {
		const parsed = ScanResultSchema.parse({
			findings: [{ severity: "HIGH" }],
		});
		expect(parsed.findings).toHaveLength(1);
		const draft = mapRawFindingToDraft(parsed.findings[0], "SECURITY");
		expect(draft.title).toBe("Unspecified rule");
		expect(draft.description).toBe("");
		expect(draft.remediation).toBe("");
		expect(draft.severity).toBe("HIGH");
		expect(draft.ruleSource).toBe("OWASP Top 10 — Unspecified rule");
	});

	it("derives a title from the description when the model omits the title", () => {
		const draft = mapRawFindingToDraft(
			{
				severity: "HIGH",
				description:
					"Missing access control on the audit log export endpoint. Anyone could download logs.",
				ruleReference: "A01:2021 Broken Access Control",
			},
			"SECURITY",
		);
		expect(draft.title).toBe(
			"Missing access control on the audit log export endpoint.",
		);
	});
});

// Fake secrets are CONSTRUCTED at runtime (never written as string literals) so
// the repo's Semgrep CI secret-detection doesn't flag these test fixtures as real
// leaked credentials. The runtime values still match the redaction patterns, so
// the assertions are unchanged in intent.
const FAKE_GH = `ghp_${"A".repeat(36)}`;
const FAKE_SLACK = `xoxb-${"1".repeat(12)}-${"a".repeat(12)}`;
const FAKE_SK = `sk-${"a".repeat(26)}`;
const FAKE_AWS = `AKIA${"Q".repeat(16)}`;
const FAKE_JWT = [`eyJ${"a".repeat(16)}`, "b".repeat(20), "c".repeat(22)].join(
	".",
);
const FAKE_ENTROPY = "a1".repeat(20); // 40 chars, mixed letters+digits
const FAKE_PEM = `-----BEGIN RSA PRIVATE KEY-----\n${"M".repeat(24)}\n-----END RSA PRIVATE KEY-----`;

describe("redactSecrets — never persist a found credential", () => {
	it("redacts recognizable provider tokens", () => {
		expect(redactSecrets(`key is ${FAKE_GH}`)).toBe("key is [REDACTED]");
		expect(redactSecrets(`slack ${FAKE_SLACK}`)).toContain("[REDACTED]");
		expect(redactSecrets(`openai ${FAKE_SK}`)).toContain("[REDACTED]");
		expect(redactSecrets(`aws ${FAKE_AWS}`)).toContain("[REDACTED]");
	});

	it("redacts JWTs and PEM private key blocks", () => {
		expect(redactSecrets(`token ${FAKE_JWT}`)).toContain(
			"[REDACTED token]",
		);
		expect(redactSecrets(`leaked ${FAKE_PEM}`)).toBe(
			"leaked [REDACTED private key]",
		);
	});

	it("redacts a generic high-entropy token but preserves prose + identifiers", () => {
		// 40-char mixed letters+digits → looks like a key → redacted.
		expect(redactSecrets(`apiKey ${FAKE_ENTROPY}`)).toBe(
			"apiKey [REDACTED]",
		);
		// Things that must NOT be redacted:
		expect(redactSecrets("OWASP Top 10 — A03:2021 Injection")).toBe(
			"OWASP Top 10 — A03:2021 Injection",
		);
		expect(redactSecrets("WCAG 2.1 AA — 1.4.3 Contrast (Minimum)")).toBe(
			"WCAG 2.1 AA — 1.4.3 Contrast (Minimum)",
		);
		expect(
			redactSecrets("See Feature F-123 and Document: Architecture"),
		).toBe("See Feature F-123 and Document: Architecture");
		expect(
			redactSecrets(
				"Store credentials in a secrets manager, not in code.",
			),
		).toBe("Store credentials in a secrets manager, not in code.");
	});

	it("mapRawFindingToDraft scrubs secrets from every persisted field", () => {
		const draft = mapRawFindingToDraft(
			{
				title: `Hardcoded key ${FAKE_GH}`,
				severity: "HIGH",
				description: `The config embeds apiKey ${FAKE_ENTROPY} directly.`,
				remediation: `Move ${FAKE_SK} to a vault.`,
				ruleReference: "A02:2021 Cryptographic Failures",
				ruleType: "DEFAULT",
				location: "Document: secrets.env",
			},
			"SECURITY",
		);
		expect(draft.title).not.toContain("ghp_");
		expect(draft.description).toContain("[REDACTED]");
		expect(draft.description).not.toContain(FAKE_ENTROPY);
		expect(draft.remediation).not.toContain(FAKE_SK);
		// Non-secret content stays intact.
		expect(draft.ruleSource).toBe(
			"OWASP Top 10 — A02:2021 Cryptographic Failures",
		);
	});
});

describe("scope guard — strictly security XOR accessibility, no junk, no secrets", () => {
	const sec = buildSecurityPrompt({
		projectName: "Acme",
		content: "x",
		customRules: [],
	});
	const a11y = buildAccessibilityPrompt({
		projectName: "Acme",
		content: "x",
		customRules: [],
	});

	it("security prompt forbids accessibility + non-security junk", () => {
		expect(sec).toMatch(/Report ONLY security/i);
		expect(sec).toMatch(/Do NOT report accessibility/i);
		expect(sec).toMatch(/performance, code style, naming/i);
		expect(sec).toMatch(/OWASP Top 10 category or a provided custom rule/i);
	});

	it("accessibility prompt forbids security + non-accessibility junk", () => {
		expect(a11y).toMatch(/Report ONLY accessibility/i);
		expect(a11y).toMatch(/Do NOT report security/i);
		expect(a11y).toMatch(/WCAG 2.1 AA success criterion/i);
	});

	it("both prompts forbid echoing secret values", () => {
		for (const p of [sec, a11y]) {
			expect(p).toMatch(/NEVER include a real secret/i);
			expect(p).toMatch(/WITHOUT quoting the secret/i);
		}
	});
});

describe("buildScanRequest — cache-friendly system/prompt split", () => {
	const CONTENT =
		"The importer fetches a user-supplied URL server-side with no allow-list.";

	it("puts the FIXED guidance in system and ONLY the content in the prompt (security)", () => {
		const { system, prompt } = buildScanRequest("security", {
			projectName: "Acme",
			content: CONTENT,
			customRules: [],
		});

		// Fixed, stable-within-a-scan guidance belongs in the cacheable system
		// prefix — the OWASP list, the role, and the false-positive contract.
		expect(system).toContain("A03 Injection");
		expect(system).toContain("application security auditor");
		expect(system).toContain("SILENCE IS NEVER A DEFECT");
		// The variable per-chunk content must NOT be in the system prefix (that is
		// exactly what would defeat caching).
		expect(system).not.toContain(CONTENT);

		// The user prompt carries only the <document> block + a short instruction.
		expect(prompt).toContain(`<document>\n${CONTENT}\n</document>`);
		expect(prompt).toContain("Analyze the content in the document above.");
		expect(prompt).not.toContain("A03 Injection");
		expect(prompt).not.toContain("SILENCE IS NEVER A DEFECT");
	});

	it("puts the FIXED guidance in system and ONLY the content in the prompt (accessibility)", () => {
		const { system, prompt } = buildScanRequest("accessibility", {
			projectName: "Acme",
			content: CONTENT,
			customRules: [],
		});

		expect(system).toContain("WCAG 2.1 Level AA");
		expect(system).toContain("web accessibility auditor");
		expect(system).not.toContain(CONTENT);

		expect(prompt).toContain(`<document>\n${CONTENT}\n</document>`);
		expect(prompt).toContain("Analyze the content in the document above.");
		expect(prompt).not.toContain("WCAG 2.1 Level AA");
	});

	it("the single-string builders equal the content block + the system prefix (no drift)", () => {
		const args = {
			projectName: "Acme",
			content: CONTENT,
			customRules: [],
		};
		const sec = buildScanRequest("security", args);
		// The combined builder is the <document> block joined to the SAME system
		// guidance, so the A/B harness + existing tests see the unchanged prompt.
		expect(buildSecurityPrompt(args)).toBe(
			`<document>\n${CONTENT}\n</document>\n\n${sec.system}`,
		);

		const a11y = buildScanRequest("accessibility", args);
		expect(buildAccessibilityPrompt(args)).toBe(
			`<document>\n${CONTENT}\n</document>\n\n${a11y.system}`,
		);
	});
});
