import { describe, expect, it } from "vitest";
import { analyzeRules, isRuleFilePath } from "../src/rules-health";

const text = (words: number, seed: string) =>
	Array.from({ length: words }, (_, i) => `${seed}${i % 40}`).join(" ");

describe("rules health", () => {
	it("knows rule files", () => {
		expect(isRuleFilePath("rules/api.md")).toBe(true);
		expect(isRuleFilePath(".claude/rules/x.md")).toBe(true);
		expect(isRuleFilePath("skills/a/SKILL.md")).toBe(false);
	});

	it("tiers rules and fills the always-on budget in path order", () => {
		const health = analyzeRules(
			[
				{ path: "rules/a.md", text: "x".repeat(70) },
				{ path: "rules/b.md", text: "---\npaths: src/**\n---\nscoped" },
				{
					path: "rules/c.md",
					text: "---\ndescription: rare\nload: on-demand\n---\nrare",
				},
				{ path: "rules/d.md", text: "y".repeat(50) },
			],
			100,
		);
		expect(health.rules.map((r) => [r.path, r.tier])).toEqual([
			["rules/a.md", "always-on"],
			["rules/b.md", "scoped"],
			["rules/c.md", "on-demand"],
			["rules/d.md", "over-budget"],
		]);
		expect(health.alwaysOnChars).toBe(70);
		expect(health.findings.map((f) => f.kind).sort()).toEqual([
			"no-description",
			"over-budget",
		]);
	});

	it("finds duplicates and near duplicates", () => {
		const shared = text(60, "w");
		const health = analyzeRules([
			{ path: "rules/a.md", text: shared },
			{ path: "rules/b.md", text: shared },
			{ path: "rules/c.md", text: `${shared} plus a little more` },
		]);
		const kinds = health.findings.map((f) => [f.kind, f.paths]);
		expect(kinds).toContainEqual([
			"duplicate",
			["rules/a.md", "rules/b.md"],
		]);
		expect(kinds).toContainEqual([
			"near-duplicate",
			["rules/a.md", "rules/c.md"],
		]);
	});
});
