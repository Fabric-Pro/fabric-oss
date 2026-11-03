import { describe, expect, it } from "vitest";
import { isRulePath, parseRuleText, scoreRule } from "../rules-tools";

describe("fabric_rules_for matching", () => {
	it("knows rule files", () => {
		expect(isRulePath("rules/api.md")).toBe(true);
		expect(isRulePath(".claude/rules/team/naming.md")).toBe(true);
		expect(isRulePath("skills/x/SKILL.md")).toBe(false);
		expect(isRulePath("rules/script.sh")).toBe(false);
	});

	it("reads paths, description and body", () => {
		const parsed = parseRuleText(
			"---\ndescription: Orders API conventions\npaths:\n  - src/api/**\n  - 'src/orders/*.ts'\n---\nUse DTOs.",
		);
		expect(parsed).toEqual({
			paths: ["src/api/**", "src/orders/*.ts"],
			description: "Orders API conventions",
			body: "Use DTOs.",
		});
	});

	it("ranks a path match above a word match, and drops what does not apply", () => {
		const api = {
			path: "rules/api.md",
			...parseRuleText("---\npaths: src/api/**\n---\n# API\nUse DTOs."),
		};
		const release = {
			path: "rules/release.md",
			...parseRuleText(
				"# Releasing\nTag the release, write release notes.",
			),
		};
		const files = ["src/api/orders.ts"];
		const task = "prepare the release notes";
		expect(scoreRule(api, files, "")).toBeGreaterThan(
			scoreRule(release, [], task),
		);
		expect(scoreRule(release, [], task)).toBeGreaterThan(0);
		expect(scoreRule(api, ["docs/readme.md"], "")).toBe(0);
	});
});
