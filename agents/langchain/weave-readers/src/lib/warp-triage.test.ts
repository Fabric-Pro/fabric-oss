/**
 * Warp Triage System Tests
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	formatFindings,
	getPatternGrepList,
	type PatternMatch,
	step1DiffScan,
	step3DeepReview,
} from "./warp-triage.js";

describe("step1DiffScan", () => {
	it("should return full scan for empty file list", () => {
		const result = step1DiffScan([]);
		assert.strictEqual(result.shouldScan, true);
		assert.strictEqual(result.estimatedComplexity, "full");
	});

	it("should fast-exit for markdown only changes", () => {
		const result = step1DiffScan([
			"README.md",
			"docs/guide.md",
			"CHANGELOG.md",
		]);
		assert.strictEqual(result.shouldScan, true);
		assert.strictEqual(result.estimatedComplexity, "minimal");
		assert.ok(result.skipReason?.includes("documentation"));
	});

	it("should fast-exit for test files only", () => {
		const result = step1DiffScan([
			"src/utils.test.ts",
			"src/components/__tests__/Button.spec.tsx",
			"__mocks__/fileMock.ts",
		]);
		assert.strictEqual(result.shouldScan, true);
		assert.strictEqual(result.estimatedComplexity, "minimal");
		assert.ok(result.skipReason?.includes("test files"));
	});

	it("should fast-exit for CSS only changes", () => {
		const result = step1DiffScan([
			"styles/button.css",
			"components/card.scss",
			"theme/theme.less",
		]);
		assert.strictEqual(result.shouldScan, true);
		assert.strictEqual(result.estimatedComplexity, "minimal");
		assert.ok(result.skipReason?.includes("CSS"));
	});

	it("should fast-exit for JSON/config only changes", () => {
		const result = step1DiffScan([
			"package.json",
			"tsconfig.json",
			"config.yml",
			"settings.toml",
		]);
		assert.strictEqual(result.shouldScan, true);
		assert.strictEqual(result.estimatedComplexity, "minimal");
		assert.ok(result.skipReason?.includes("documentation"));
	});

	it("should do full scan for auth-related files", () => {
		const result = step1DiffScan([
			"src/auth/login.ts",
			"src/middleware/session.ts",
		]);
		assert.strictEqual(result.shouldScan, true);
		assert.strictEqual(result.estimatedComplexity, "full");
		assert.ok(!result.skipReason);
	});

	it("should do full scan for crypto-related files", () => {
		const result = step1DiffScan([
			"src/utils/crypto.ts",
			"src/services/encrypt.ts",
		]);
		assert.strictEqual(result.shouldScan, true);
		assert.strictEqual(result.estimatedComplexity, "full");
	});

	it("should do full scan for .env files", () => {
		const result = step1DiffScan([".env", ".env.local", "env/prod.env"]);
		assert.strictEqual(result.shouldScan, true);
		assert.strictEqual(result.estimatedComplexity, "full");
	});

	it("should do partial scan for regular code files", () => {
		const result = step1DiffScan([
			"src/components/Button.tsx",
			"src/utils/helpers.ts",
		]);
		assert.strictEqual(result.shouldScan, true);
		assert.strictEqual(result.estimatedComplexity, "partial");
	});

	it("should track file types correctly", () => {
		const result = step1DiffScan([
			"README.md",
			"src/utils.test.ts",
			"styles/button.css",
		]);
		assert.ok(result.fileTypes.includes("non-code"));
		assert.ok(result.fileTypes.includes("test"));
		assert.ok(result.fileTypes.includes("css"));
	});

	it("should handle mixed security-sensitive and regular files", () => {
		const result = step1DiffScan([
			"src/auth/login.ts",
			"src/components/Button.tsx",
		]);
		assert.strictEqual(result.shouldScan, true);
		assert.strictEqual(result.estimatedComplexity, "full");
	});
});

describe("step3DeepReview", () => {
	it("should return empty findings for no matches", () => {
		const result = step3DeepReview([]);
		assert.strictEqual(result.summary.total, 0);
		assert.strictEqual(result.blockingIssues.length, 0);
		assert.strictEqual(result.nonBlockingIssues.length, 0);
		assert.strictEqual(result.maxBlockingReached, false);
	});

	it("should classify critical issues as blocking", () => {
		const matches: PatternMatch[] = [
			{
				file: "src/auth/login.ts",
				line: 42,
				pattern: "password.*=",
				patternId: "credential-hardcoding",
				severity: "critical",
				context: "const password = 'admin';",
			},
		];
		const result = step3DeepReview(matches);
		assert.strictEqual(result.summary.critical, 1);
		assert.strictEqual(result.blockingIssues.length, 1);
		assert.strictEqual(result.blockingIssues[0].blocking, true);
	});

	it("should classify high issues as blocking when in auth/crypto categories", () => {
		const matches: PatternMatch[] = [
			{
				file: "src/auth/password.ts",
				line: 10,
				pattern: "password.length < 6",
				patternId: "weak-password-policy",
				severity: "high",
				context: "if (password.length < 6)",
			},
		];
		const result = step3DeepReview(matches);
		assert.strictEqual(result.summary.high, 1);
		assert.strictEqual(result.blockingIssues.length, 1);
		assert.strictEqual(result.blockingIssues[0].blocking, true);
	});

	it("should classify high issues as non-blocking when not in auth/crypto categories", () => {
		const matches: PatternMatch[] = [
			{
				file: "src/sql/query.ts",
				line: 10,
				pattern: "SELECT.*WHERE",
				patternId: "sql-injection",
				severity: "high",
				context: "db.query('SELECT * FROM users WHERE id = ' + id)",
			},
		];
		const result = step3DeepReview(matches);
		assert.strictEqual(result.summary.high, 1);
		assert.strictEqual(result.nonBlockingIssues.length, 1);
		assert.strictEqual(result.nonBlockingIssues[0].blocking, false);
	});

	it("should classify medium issues as blocking when in injection category", () => {
		const matches: PatternMatch[] = [
			{
				file: "src/sql/query.ts",
				line: 10,
				pattern: "SELECT.*WHERE",
				patternId: "sql-injection",
				severity: "medium",
				context: "db.query('SELECT * FROM users WHERE id = ' + id)",
			},
		];
		const result = step3DeepReview(matches);
		assert.strictEqual(result.summary.medium, 1);
		assert.strictEqual(result.blockingIssues.length, 1);
		assert.strictEqual(result.blockingIssues[0].blocking, true);
	});

	it("should classify medium issues as non-blocking when not in injection category", () => {
		const matches: PatternMatch[] = [
			{
				file: "src/config.ts",
				line: 5,
				pattern: "console.log",
				patternId: "debug-code",
				severity: "medium",
				context: "console.log('debug');",
			},
		];
		const result = step3DeepReview(matches);
		assert.strictEqual(result.summary.medium, 1);
		assert.strictEqual(result.nonBlockingIssues.length, 1);
		assert.strictEqual(result.nonBlockingIssues[0].blocking, false);
	});

	it("should classify low issues as non-blocking", () => {
		const matches: PatternMatch[] = [
			{
				file: "src/utils/format.ts",
				line: 20,
				pattern: "TODO",
				patternId: "TODO-comment",
				severity: "low",
				context: "// TODO: fix this later",
			},
		];
		const result = step3DeepReview(matches);
		assert.strictEqual(result.summary.low, 1);
		assert.strictEqual(result.nonBlockingIssues.length, 1);
		assert.strictEqual(result.nonBlockingIssues[0].blocking, false);
	});

	it("should deduplicate matches at same location", () => {
		const matches: PatternMatch[] = [
			{
				file: "src/auth/token.ts",
				line: 50,
				pattern: "jwt.sign",
				patternId: "jwt-none-algorithm",
				severity: "high",
				context: "jwt.sign(payload, secret)",
			},
			{
				file: "src/auth/token.ts",
				line: 50,
				pattern: "password.length < 6",
				patternId: "weak-password-policy",
				severity: "high",
				context: "if (password.length < 6)",
			},
		];
		const result = step3DeepReview(matches);
		// Should deduplicate - same file:line but different patternId
		assert.strictEqual(result.summary.total, 2);
	});

	it("should enforce max blocking issues limit of 3", () => {
		const matches: PatternMatch[] = [
			{
				file: "src/auth/token.ts",
				line: 10,
				pattern: "password",
				patternId: "credential-hardcoding",
				severity: "critical",
				context: "password = 'secret'",
			},
			{
				file: "src/auth/token.ts",
				line: 20,
				pattern: "password",
				patternId: "credential-hardcoding",
				severity: "critical",
				context: "password = 'secret2'",
			},
			{
				file: "src/auth/token.ts",
				line: 30,
				pattern: "password",
				patternId: "credential-hardcoding",
				severity: "critical",
				context: "password = 'secret3'",
			},
			{
				file: "src/auth/token.ts",
				line: 40,
				pattern: "password",
				patternId: "credential-hardcoding",
				severity: "critical",
				context: "password = 'secret4'",
			},
		];
		const result = step3DeepReview(matches);
		assert.strictEqual(result.summary.critical, 4);
		assert.strictEqual(result.blockingIssues.length, 3); // Limited to 3
		assert.strictEqual(result.maxBlockingReached, true);
	});

	it("should sort findings by severity", () => {
		const matches: PatternMatch[] = [
			{
				file: "a.ts",
				line: 1,
				pattern: "console.log",
				patternId: "debug-code",
				severity: "low",
				context: "console.log('debug')",
			},
			{
				file: "b.ts",
				line: 1,
				pattern: "password = 'secret'",
				patternId: "credential-hardcoding",
				severity: "critical",
				context: "password = 'admin'",
			},
			{
				file: "c.ts",
				line: 1,
				pattern: "password.length < 6",
				patternId: "weak-password-policy",
				severity: "high",
				context: "if (password.length < 6)",
			},
		];
		const result = step3DeepReview(matches);
		assert.strictEqual(result.blockingIssues[0].severity, "critical");
		assert.strictEqual(result.blockingIssues[1].severity, "high");
		assert.strictEqual(result.nonBlockingIssues[0].severity, "low");
	});

	it("should include remediation from pattern", () => {
		const matches: PatternMatch[] = [
			{
				file: "src/auth/login.ts",
				line: 42,
				pattern: "password.*=",
				patternId: "credential-hardcoding",
				severity: "critical",
				context: "const password = 'admin';",
			},
		];
		const result = step3DeepReview(matches);
		assert.ok(result.blockingIssues[0].remediation.length > 0);
		assert.ok(result.blockingIssues[0].rfcRefs.length > 0);
	});
});

describe("formatFindings", () => {
	it("should format empty results as success", () => {
		const classified = {
			blockingIssues: [],
			nonBlockingIssues: [],
			summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
			maxBlockingReached: false,
		};
		const result = formatFindings(classified);
		assert.ok(result.includes("No security issues found"));
	});

	it("should format blocking issues with severity", () => {
		const classified: {
			blockingIssues: Array<{
				id: string;
				patternId: string;
				patternName: string;
				severity: "critical" | "high" | "medium" | "low";
				file: string;
				line: number;
				description: string;
				remediation: string;
				blocking: boolean;
				rfcRefs: string[];
			}>;
			nonBlockingIssues: Array<{
				id: string;
				patternId: string;
				patternName: string;
				severity: "critical" | "high" | "medium" | "low";
				file: string;
				line: number;
				description: string;
				remediation: string;
				blocking: boolean;
				rfcRefs: string[];
			}>;
			summary: {
				total: number;
				critical: number;
				high: number;
				medium: number;
				low: number;
			};
			maxBlockingReached: boolean;
		} = {
			blockingIssues: [
				{
					id: "hardcoded-creds-auth-login-42",
					patternId: "credential-hardcoding",
					patternName: "Hardcoded Credentials",
					severity: "critical",
					file: "src/auth/login.ts",
					line: 42,
					description: "Hardcoded credentials found",
					remediation: "Use environment variables",
					blocking: true,
					rfcRefs: ["OWASP-Top10-2021"],
				},
			],
			nonBlockingIssues: [],
			summary: { total: 1, critical: 1, high: 0, medium: 0, low: 0 },
			maxBlockingReached: false,
		};
		const result = formatFindings(classified);
		assert.ok(result.includes("Blocking Issues"));
		assert.ok(result.includes("Hardcoded Credentials"));
		assert.ok(result.includes("critical"));
		assert.ok(result.includes("OWASP-Top10-2021"));
	});

	it("should format non-blocking issues separately", () => {
		const classified: {
			blockingIssues: Array<{
				id: string;
				patternId: string;
				patternName: string;
				severity: "critical" | "high" | "medium" | "low";
				file: string;
				line: number;
				description: string;
				remediation: string;
				blocking: boolean;
				rfcRefs: string[];
			}>;
			nonBlockingIssues: Array<{
				id: string;
				patternId: string;
				patternName: string;
				severity: "critical" | "high" | "medium" | "low";
				file: string;
				line: number;
				description: string;
				remediation: string;
				blocking: boolean;
				rfcRefs: string[];
			}>;
			summary: {
				total: number;
				critical: number;
				high: number;
				medium: number;
				low: number;
			};
			maxBlockingReached: boolean;
		} = {
			blockingIssues: [],
			nonBlockingIssues: [
				{
					id: "debug-code-utils-5",
					patternId: "debug-code",
					patternName: "Debug Code",
					severity: "medium",
					file: "src/utils/format.ts",
					line: 5,
					description: "Console.log found",
					remediation: "Remove debug code",
					blocking: false,
					rfcRefs: [],
				},
			],
			summary: { total: 1, critical: 0, high: 0, medium: 1, low: 0 },
			maxBlockingReached: false,
		};
		const result = formatFindings(classified);
		assert.ok(result.includes("Non-Blocking Issues"));
		assert.ok(result.includes("Debug Code"));
	});

	it("should show max blocking reached warning", () => {
		const classified: {
			blockingIssues: Array<{
				id: string;
				patternId: string;
				patternName: string;
				severity: "critical" | "high" | "medium" | "low";
				file: string;
				line: number;
				description: string;
				remediation: string;
				blocking: boolean;
				rfcRefs: string[];
			}>;
			nonBlockingIssues: Array<{
				id: string;
				patternId: string;
				patternName: string;
				severity: "critical" | "high" | "medium" | "low";
				file: string;
				line: number;
				description: string;
				remediation: string;
				blocking: boolean;
				rfcRefs: string[];
			}>;
			summary: {
				total: number;
				critical: number;
				high: number;
				medium: number;
				low: number;
			};
			maxBlockingReached: boolean;
		} = {
			blockingIssues: [
				{
					id: "issue-1",
					patternId: "test",
					patternName: "Issue 1",
					severity: "critical",
					file: "a.ts",
					line: 1,
					description: "Test",
					remediation: "Fix",
					blocking: true,
					rfcRefs: [],
				},
				{
					id: "issue-2",
					patternId: "test",
					patternName: "Issue 2",
					severity: "critical",
					file: "b.ts",
					line: 1,
					description: "Test",
					remediation: "Fix",
					blocking: true,
					rfcRefs: [],
				},
				{
					id: "issue-3",
					patternId: "test",
					patternName: "Issue 3",
					severity: "critical",
					file: "c.ts",
					line: 1,
					description: "Test",
					remediation: "Fix",
					blocking: true,
					rfcRefs: [],
				},
			],
			nonBlockingIssues: [],
			summary: { total: 3, critical: 3, high: 0, medium: 0, low: 0 },
			maxBlockingReached: true,
		};
		const result = formatFindings(classified);
		assert.ok(result.includes("Showing top 3 blocking issues"));
	});
});

describe("getPatternGrepList", () => {
	it("should return array of patterns", () => {
		const patterns = getPatternGrepList();
		assert.ok(Array.isArray(patterns));
		assert.ok(patterns.length > 0);
	});

	it("should return patterns with required fields", () => {
		const patterns = getPatternGrepList();
		for (const p of patterns) {
			assert.ok(p.pattern);
			assert.ok(p.patternId);
			assert.ok(p.severity);
		}
	});

	it("should include injection patterns", () => {
		const patterns = getPatternGrepList();
		const injectionPatterns = patterns.filter(
			(p) =>
				p.patternId === "sql-injection" ||
				p.patternId === "command-injection",
		);
		assert.ok(injectionPatterns.length > 0);
	});

	it("should include auth patterns", () => {
		const patterns = getPatternGrepList();
		const authPatterns = patterns.filter(
			(p) =>
				p.patternId === "credential-hardcoding" ||
				p.patternId === "jwt-none-algorithm",
		);
		assert.ok(authPatterns.length > 0);
	});
});
