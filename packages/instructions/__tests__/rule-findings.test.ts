/**
 * The shared finding categories: the checks map onto `over-budget` and
 * `cleanup`, the AI review keeps only its own categories and files it was
 * given, and every surface counts files per category the same way.
 */
import { describe, expect, it } from "vitest";
import {
	healthFindingCategory,
	healthRuleFindings,
	knownRuleFindingCategories,
	RULE_FINDING_CATEGORIES,
	ruleFindingCategoriesByFile,
	summarizeRuleFindings,
	validateReviewFindings,
} from "../src/rule-findings";
import { analyzeRules } from "../src/rules-health";

describe("rule finding categories", () => {
	it("is the one ordered set every surface uses", () => {
		expect(RULE_FINDING_CATEGORIES).toEqual([
			"over-budget",
			"overlap",
			"vague",
			"narrower-scope",
			"better-enforced",
			"cleanup",
		]);
	});

	it("files the checks' over-budget finding under over-budget and every other check under cleanup", () => {
		expect(healthFindingCategory("over-budget")).toBe("over-budget");
		for (const kind of [
			"duplicate",
			"near-duplicate",
			"long",
			"no-description",
			"empty",
		] as const) {
			expect(healthFindingCategory(kind)).toBe("cleanup");
		}
	});

	it("counts the files over budget exactly as the checks' tiers do", () => {
		const rules = ["a", "b", "c", "d"].map((name) => ({
			path: `.claude/rules/${name}.md`,
			text: `---\ndescription: ${name}\n---\n${name.repeat(3_000)}\n`,
		}));
		const health = analyzeRules(rules);
		const overBudget = health.rules.filter(
			(rule) => rule.tier === "over-budget",
		).length;

		const summary = summarizeRuleFindings(
			healthRuleFindings(health.findings),
		);

		expect(overBudget).toBe(2);
		expect(summary.counts).toEqual([
			{ category: "over-budget", files: overBudget },
		]);
		expect(summary.findings).toBe(1);
		expect(summary.files).toHaveLength(2);
	});

	it("keeps known categories once, in the shared order", () => {
		expect(
			knownRuleFindingCategories([
				"vague",
				"made-up",
				"overlap",
				"vague",
			]),
		).toEqual(["overlap", "vague"]);
	});

	it("lists every flagged file with its categories, and counts files, not findings", () => {
		const findings = [
			{ category: "overlap", files: ["a.md", "b.md"], summary: "s" },
			{ category: "overlap", files: ["a.md"], summary: "s" },
			{ category: "over-budget", files: ["c.md", "a.md"], summary: "s" },
		] as const;
		const mutable = findings.map((f) => ({ ...f, files: [...f.files] }));

		expect([...ruleFindingCategoriesByFile(mutable)]).toEqual([
			["a.md", ["over-budget", "overlap"]],
			["b.md", ["overlap"]],
			["c.md", ["over-budget"]],
		]);
		expect(summarizeRuleFindings(mutable)).toEqual({
			findings: 3,
			files: ["a.md", "b.md", "c.md"],
			counts: [
				{ category: "over-budget", files: 2 },
				{ category: "overlap", files: 2 },
			],
		});
	});
});

describe("validateReviewFindings", () => {
	const given = [".claude/rules/a.md", ".claude/rules/b.md"];

	it("round-trips the review's own categories with the files it was given", () => {
		const raw = [
			{
				category: "overlap",
				files: [".claude/rules/a.md", ".claude/rules/b.md"],
				summary: "Merge them.",
			},
			{
				category: " vague ",
				files: [" .claude/rules/b.md ", ".claude/rules/b.md"],
				summary: "Say which tests.",
			},
			{
				category: "narrower-scope",
				files: [".claude/rules/a.md"],
				summary: "paths: src/**",
			},
			{
				category: "better-enforced",
				files: [".claude/rules/b.md"],
				summary: "A lint rule.",
			},
		];

		expect(validateReviewFindings(raw, given)).toEqual([
			{
				category: "overlap",
				files: [".claude/rules/a.md", ".claude/rules/b.md"],
				summary: "Merge them.",
			},
			{
				category: "vague",
				files: [".claude/rules/b.md"],
				summary: "Say which tests.",
			},
			{
				category: "narrower-scope",
				files: [".claude/rules/a.md"],
				summary: "paths: src/**",
			},
			{
				category: "better-enforced",
				files: [".claude/rules/b.md"],
				summary: "A lint rule.",
			},
		]);
	});

	it("drops unknown categories, the checks' own, files it was not given, and empty findings", () => {
		const raw = [
			{ category: "contradiction", files: given, summary: "s" },
			{ category: "over-budget", files: given, summary: "s" },
			{ category: "cleanup", files: given, summary: "s" },
			{ category: "overlap", files: ["CLAUDE.md"], summary: "s" },
			{ category: "vague", files: given, summary: "   " },
			{
				category: "vague",
				files: ["CLAUDE.md", ".claude/rules/a.md"],
				summary: "kept",
			},
		];

		expect(validateReviewFindings(raw, given)).toEqual([
			{
				category: "vague",
				files: [".claude/rules/a.md"],
				summary: "kept",
			},
		]);
	});
});
