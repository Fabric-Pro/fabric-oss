import { describe, expect, it } from "vitest";
import {
	ALWAYS_ON_RULES_BUDGET,
	type ProjectRule,
	tierRules,
} from "../src/lib/plugin/rules.js";
import { rulesSkill } from "../src/lib/plugin/rules-skill.js";

const rule = (path: string, text: string): ProjectRule => ({
	path,
	source: `rules/${path}`,
	bytes: new TextEncoder().encode(text),
});

describe("rule tiers", () => {
	it("delivers scoped rules and always-on rules within the budget", () => {
		const { delivered, onDemand } = tierRules([
			rule(
				"api.md",
				"---\npaths: src/api/**\n---\n# API rules\nUse DTOs.",
			),
			rule("core.md", "# Core\nBe careful."),
		]);
		expect(delivered.map((r) => r.path)).toEqual(["api.md", "core.md"]);
		expect(onDemand).toEqual([]);
	});

	it("keeps rules marked on-demand out, with their description", () => {
		const { delivered, onDemand } = tierRules([
			rule(
				"release.md",
				"---\ndescription: How to cut a release\nload: on-demand\n---\nSteps...",
			),
		]);
		expect(delivered).toEqual([]);
		expect(onDemand).toEqual([
			{
				path: "release.md",
				source: "rules/release.md",
				description: "How to cut a release",
				paths: [],
				reason: "on-demand",
			},
		]);
	});

	it("moves always-on rules past the budget to on-demand", () => {
		const big = "x".repeat(ALWAYS_ON_RULES_BUDGET - 10);
		const { delivered, onDemand, alwaysOnChars } = tierRules([
			rule("a.md", big),
			rule("b.md", "# Second rule\nmore text than fits"),
		]);
		expect(delivered.map((r) => r.path)).toEqual(["a.md"]);
		expect(onDemand.map((r) => [r.path, r.reason, r.description])).toEqual([
			["b.md", "over-budget", "Second rule"],
		]);
		expect(alwaysOnChars).toBe(big.length);
	});

	it("lists on-demand rules in the fabric-rules skill", () => {
		const skill = rulesSkill(
			[
				{
					path: "release.md",
					source: "rules/release.md",
					description: "How to cut a release",
					paths: [],
					reason: "on-demand",
				},
			],
			"claude-code",
			"project-1",
		);
		expect(skill).toContain("name: fabric-rules");
		expect(skill).toContain(
			"- `release.md`: How to cut a release. File: `instructions/source/rules/release.md`",
		);
		expect(skill).toContain("fabric_rules_for");
	});
});
