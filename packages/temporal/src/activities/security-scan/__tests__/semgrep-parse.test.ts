import { describe, expect, it } from "vitest";
import {
	deriveSemgrepConfidence,
	extractSemgrepEvidence,
	parseSemgrepResults,
} from "../semgrep-scan";

/**
 * A small but representative slice of a Semgrep `--json` payload:
 *   1. ERROR severity, with an explicit metadata.fix (→ HIGH, uses the fix)
 *   2. WARNING severity whose MESSAGE contains a fake hardcoded secret
 *      (→ MEDIUM, secret must be REDACTED, no metadata.fix → generic fallback)
 *   3. INFO severity (→ LOW)
 *   4. A duplicate of #1 (same check_id + path + line) to prove de-duping
 */
// Built at runtime (never written as a literal) so the repo's Semgrep CI
// secret-detection doesn't flag this test fixture as a real leaked credential.
// The runtime value still matches the redaction patterns under test.
const FAKE_SECRET = `ghp_${"A".repeat(36)}`;

const SAMPLE: unknown = {
	results: [
		{
			check_id:
				"javascript.express.security.audit.xss.direct-response-write",
			path: "src/routes/user.ts",
			start: { line: 42 },
			extra: {
				message:
					"Detected directly writing user input to the response.",
				severity: "ERROR",
				metadata: {
					fix: "Encode the value before writing it to the response.",
				},
			},
		},
		{
			check_id: "generic.secrets.hardcoded-token",
			path: "src/config.ts",
			start: { line: 7 },
			extra: {
				message: `Hardcoded credential found: ${FAKE_SECRET} — move it to a secret store.`,
				severity: "WARNING",
			},
		},
		{
			check_id: "python.lang.best-practice.print-statement",
			path: "scripts/util.py",
			start: { line: 3 },
			extra: {
				message: "Leftover debug print statement.",
				severity: "INFO",
			},
		},
		{
			// Exact duplicate of result #1 — must be collapsed.
			check_id:
				"javascript.express.security.audit.xss.direct-response-write",
			path: "src/routes/user.ts",
			start: { line: 42 },
			extra: {
				message:
					"Detected directly writing user input to the response.",
				severity: "ERROR",
				metadata: {
					fix: "Encode the value before writing it to the response.",
				},
			},
		},
	],
};

describe("parseSemgrepResults", () => {
	const findings = parseSemgrepResults(SAMPLE);

	it("de-dupes identical rule+location findings", () => {
		// 4 raw results, but #4 duplicates #1 → 3 unique findings.
		expect(findings).toHaveLength(3);
	});

	it("maps Semgrep severities (ERROR→HIGH, WARNING→MEDIUM, INFO→LOW)", () => {
		const bySource = Object.fromEntries(
			findings.map((f) => [f.ruleSource, f]),
		);
		expect(
			bySource[
				"Semgrep: javascript.express.security.audit.xss.direct-response-write"
			].severity,
		).toBe("HIGH");
		expect(
			bySource["Semgrep: generic.secrets.hardcoded-token"].severity,
		).toBe("MEDIUM");
		expect(
			bySource["Semgrep: python.lang.best-practice.print-statement"]
				.severity,
		).toBe("LOW");
	});

	it("prefixes ruleSource with 'Semgrep: ' and the full check_id", () => {
		expect(findings.map((f) => f.ruleSource)).toEqual(
			expect.arrayContaining([
				"Semgrep: javascript.express.security.audit.xss.direct-response-write",
				"Semgrep: generic.secrets.hardcoded-token",
				"Semgrep: python.lang.best-practice.print-statement",
			]),
		);
	});

	it("builds location as '<relative path>:<line>'", () => {
		const xss = findings.find((f) =>
			f.ruleSource.includes("direct-response-write"),
		);
		expect(xss?.location).toBe("src/routes/user.ts:42");
	});

	it("humanizes a title from the last check_id segment", () => {
		const xss = findings.find((f) =>
			f.ruleSource.includes("direct-response-write"),
		);
		expect(xss?.title).toBe("Direct response write");
	});

	it("uses metadata.fix as remediation when present", () => {
		const xss = findings.find((f) =>
			f.ruleSource.includes("direct-response-write"),
		);
		expect(xss?.remediation).toBe(
			"Encode the value before writing it to the response.",
		);
	});

	it("falls back to a generic remediation when no fix is provided", () => {
		const info = findings.find((f) =>
			f.ruleSource.includes("print-statement"),
		);
		expect(info?.remediation).toBe(
			"Review and remediate per the Semgrep rule.",
		);
	});

	it("marks every Semgrep finding as a non-custom rule", () => {
		expect(findings.every((f) => f.isCustomRule === false)).toBe(true);
	});

	it("REDACTS a secret matched in the finding message", () => {
		const secretFinding = findings.find((f) =>
			f.ruleSource.includes("hardcoded-token"),
		);
		expect(secretFinding).toBeDefined();
		// The literal token must never survive into any field.
		expect(secretFinding?.description).not.toContain(FAKE_SECRET);
		expect(secretFinding?.description).toContain("[REDACTED]");
		// And it must not leak through any other field either.
		const serialized = JSON.stringify(findings);
		expect(serialized).not.toContain(FAKE_SECRET);
	});

	it("returns an empty array for malformed / empty input", () => {
		expect(parseSemgrepResults(null)).toEqual([]);
		expect(parseSemgrepResults({})).toEqual([]);
		expect(parseSemgrepResults({ results: "nope" })).toEqual([]);
		expect(parseSemgrepResults({ results: [] })).toEqual([]);
	});
});

describe("deriveSemgrepConfidence — prefers Semgrep's own confidence", () => {
	it("maps metadata.confidence HIGH/MEDIUM/LOW to 0.9/0.6/0.3", () => {
		expect(
			deriveSemgrepConfidence({
				severity: "INFO",
				metadata: { confidence: "HIGH" },
			}),
		).toBe(0.9);
		expect(
			deriveSemgrepConfidence({
				severity: "INFO",
				metadata: { confidence: "MEDIUM" },
			}),
		).toBe(0.6);
		expect(
			deriveSemgrepConfidence({
				severity: "ERROR",
				metadata: { confidence: "LOW" },
			}),
		).toBe(0.3);
	});

	it("falls back to the severity proxy when metadata is absent", () => {
		expect(deriveSemgrepConfidence({ severity: "ERROR" })).toBe(0.8);
		expect(deriveSemgrepConfidence({ severity: "WARNING" })).toBe(0.6);
		expect(deriveSemgrepConfidence({ severity: "INFO" })).toBe(0.4);
		expect(deriveSemgrepConfidence(undefined)).toBe(0.5);
	});

	it("caps an audit-category rule below the default-view floor (<= 0.35)", () => {
		// Even a HIGH-confidence audit rule is down-ranked so the noisy audit
		// tail collapses out of the default view (never dropped).
		expect(
			deriveSemgrepConfidence({
				severity: "INFO",
				metadata: { confidence: "HIGH", category: "audit" },
			}),
		).toBe(0.35);
		expect(
			deriveSemgrepConfidence({
				severity: "INFO",
				metadata: { confidence: "LOW", category: "audit" },
			}),
		).toBe(0.3);
	});

	it("tolerates missing / partial metadata without throwing", () => {
		expect(() => deriveSemgrepConfidence({})).not.toThrow();
		expect(() => deriveSemgrepConfidence({ metadata: {} })).not.toThrow();
		expect(deriveSemgrepConfidence({ metadata: {} })).toBe(0.5);
	});
});

describe("extractSemgrepEvidence — redacted, clamped source excerpt", () => {
	it("returns the trimmed matched lines", () => {
		expect(extractSemgrepEvidence("  res.send(userInput)  ")).toBe(
			"res.send(userInput)",
		);
	});

	it("returns null for empty / non-string input", () => {
		expect(extractSemgrepEvidence("")).toBeNull();
		expect(extractSemgrepEvidence("   ")).toBeNull();
		expect(extractSemgrepEvidence(undefined)).toBeNull();
		expect(extractSemgrepEvidence(null)).toBeNull();
	});

	it("clamps a very long excerpt", () => {
		const out = extractSemgrepEvidence("x".repeat(1000)) ?? "";
		// 500-char clamp + a single ellipsis character.
		expect(out.length).toBeLessThanOrEqual(501);
	});

	it("redacts a secret matched in the source lines", () => {
		// Built at runtime so CI secret-detection doesn't flag the fixture.
		const secret = `ghp_${"B".repeat(36)}`;
		const out = extractSemgrepEvidence(`const token = "${secret}"`) ?? "";
		expect(out).not.toContain(secret);
		expect(out).toContain("[REDACTED]");
	});

	it("redacts BEFORE clamping so a boundary-straddling secret can't leak", () => {
		// A full token that starts before the 500-char clamp and extends past it:
		// clamp-then-redact would truncate it below the pattern length and leak a
		// partial credential. Redact-then-clamp replaces the whole token first.
		const secret = `ghp_${"C".repeat(36)}`; // 40 chars, matches the gh token pattern
		// A non-word char (space) precedes the token so its \b boundary holds, as it
		// would in real source. The token starts at index 481 and ends at 521, so it
		// straddles the 500-char clamp.
		const lines = `${"a".repeat(480)} ${secret}`;
		const out = extractSemgrepEvidence(lines) ?? "";
		expect(out).not.toContain(secret);
		// No partial secret prefix survives either.
		expect(out).not.toContain("ghp_");
		expect(out).toContain("[REDACTED]");
	});
});

describe("parseSemgrepResults — captures evidence + metadata confidence", () => {
	const findings = parseSemgrepResults({
		results: [
			{
				check_id: "javascript.lang.audit.unsafe-formatstring",
				path: "src/log.ts",
				start: { line: 5 },
				extra: {
					message: "Unsafe format string.",
					severity: "INFO",
					lines: "logger.info(String(userInput))",
					metadata: { confidence: "LOW", category: "audit" },
				},
			},
		],
	});

	it("captures the matched lines as redacted evidence", () => {
		expect(findings[0]?.evidence).toBe("logger.info(String(userInput))");
	});

	it("down-ranks an audit-category finding below the default-view floor", () => {
		expect(findings[0]?.confidence).toBeLessThanOrEqual(0.35);
	});
});
