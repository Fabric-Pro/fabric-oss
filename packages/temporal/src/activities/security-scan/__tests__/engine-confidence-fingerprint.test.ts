import { describe, expect, it } from "vitest";
import { parseGitleaksResults } from "../git-history-scan";
import { computeFindingFingerprint } from "../scan-schemas";
import { parseSemgrepResults } from "../semgrep-scan";

/**
 * G13 — the repo engines (Semgrep, gitleaks) must carry a DERIVED confidence and
 * a fingerprint, so they sort/filter and dedup/carry-forward exactly like the AI
 * findings. (The existing semgrep-parse / gitleaks-parse suites cover severity +
 * redaction; this file is scoped to the new fields.)
 */

const SEMGREP_SAMPLE: unknown = {
	results: [
		{
			check_id: "javascript.express.security.audit.xss.foo",
			path: "src/a.ts",
			start: { line: 10 },
			extra: { message: "error rule", severity: "ERROR" },
		},
		{
			check_id: "javascript.audit.bar",
			path: "src/b.ts",
			start: { line: 20 },
			extra: { message: "warning rule", severity: "WARNING" },
		},
		{
			check_id: "python.best-practice.baz",
			path: "src/c.py",
			start: { line: 30 },
			extra: { message: "info rule", severity: "INFO" },
		},
	],
};

describe("Semgrep findings — derived confidence + fingerprint", () => {
	const findings = parseSemgrepResults(SEMGREP_SAMPLE);

	it("derives confidence from rule severity (ERROR→0.8, WARNING→0.6, INFO→0.4)", () => {
		const by = Object.fromEntries(findings.map((f) => [f.ruleSource, f]));
		expect(
			by["Semgrep: javascript.express.security.audit.xss.foo"].confidence,
		).toBe(0.8);
		expect(by["Semgrep: javascript.audit.bar"].confidence).toBe(0.6);
		expect(by["Semgrep: python.best-practice.baz"].confidence).toBe(0.4);
	});

	it("sets a fingerprint matching a direct computation over the persisted fields", () => {
		for (const f of findings) {
			expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
			expect(f.fingerprint).toBe(
				computeFindingFingerprint("SECURITY", f.ruleSource, f.location),
			);
		}
	});
});

describe("gitleaks findings — high fixed confidence + fingerprint", () => {
	const sample: unknown = [
		{
			RuleID: "aws-access-token",
			Description: "AWS token",
			File: "config/old.env",
			Commit: "abc123def456",
			StartLine: 5,
		},
	];
	const findings = parseGitleaksResults(sample);

	it("assigns the high (0.85) secrets confidence", () => {
		expect(findings).toHaveLength(1);
		expect(findings[0].confidence).toBe(0.85);
	});

	it("sets a stable fingerprint over its persisted fields", () => {
		const f = findings[0];
		expect(f.fingerprint).toBe(
			computeFindingFingerprint("SECURITY", f.ruleSource, f.location),
		);
	});
});
