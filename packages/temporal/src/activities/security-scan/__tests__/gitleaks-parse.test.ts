import { describe, expect, it } from "vitest";
import { parseGitleaksResults } from "../git-history-scan";

// Built at runtime (never a literal) so the repo's Semgrep CI secret-detection
// doesn't flag this fixture; the runtime value still exercises redaction.
const FAKE_SECRET = `ghp_${"A".repeat(36)}`;

const SAMPLE: unknown = [
	{
		RuleID: "github-pat",
		Description: `GitHub Personal Access Token ${FAKE_SECRET} committed.`,
		File: "src/config.ts",
		Commit: "0badc0ffee1234567890abcdef",
		StartLine: 12,
	},
	{
		RuleID: "aws-access-token",
		Description: "AWS access key found.",
		File: "infra/main.tf",
		Commit: "abc123def4567890",
		StartLine: 3,
	},
	{
		// Exact duplicate of #1 — must be collapsed.
		RuleID: "github-pat",
		Description: `GitHub Personal Access Token ${FAKE_SECRET} committed.`,
		File: "src/config.ts",
		Commit: "0badc0ffee1234567890abcdef",
		StartLine: 12,
	},
];

describe("parseGitleaksResults", () => {
	const findings = parseGitleaksResults(SAMPLE);

	it("de-dupes identical rule+commit+file+line findings", () => {
		expect(findings).toHaveLength(2);
	});

	it("humanizes the rule into the title and prefixes the rule source", () => {
		const pat = findings.find((f) => f.ruleSource.includes("github-pat"));
		expect(pat?.title).toBe("Secret in git history: Github pat");
		expect(pat?.ruleSource).toBe("Secret history: github-pat");
	});

	it("marks every finding HIGH severity and non-custom", () => {
		expect(findings.every((f) => f.severity === "HIGH")).toBe(true);
		expect(findings.every((f) => f.isCustomRule === false)).toBe(true);
	});

	it("builds a location from file + line + short commit", () => {
		const pat = findings.find((f) => f.ruleSource.includes("github-pat"));
		expect(pat?.location).toContain("src/config.ts");
		expect(pat?.location).toContain("line 12");
		expect(pat?.location).toContain("commit 0badc0ffee");
	});

	it("REDACTS a secret embedded in the gitleaks description", () => {
		const pat = findings.find((f) => f.ruleSource.includes("github-pat"));
		expect(pat?.description).not.toContain(FAKE_SECRET);
		expect(pat?.description).toContain("[REDACTED]");
		// And it never leaks through any other field.
		expect(JSON.stringify(findings)).not.toContain(FAKE_SECRET);
	});

	it("returns an empty array for malformed / empty input", () => {
		expect(parseGitleaksResults(null)).toEqual([]);
		expect(parseGitleaksResults({})).toEqual([]);
		expect(parseGitleaksResults([])).toEqual([]);
	});
});
