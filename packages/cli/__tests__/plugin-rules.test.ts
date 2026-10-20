import { describe, expect, it } from "vitest";
import {
	AGENTS_RULES_LIMIT,
	agentsInstructions,
	agentsRulesSection,
	capRules,
	type ProjectRule,
	RULES_MAX_BYTES,
	RULES_MAX_FILES,
	selectRules,
} from "../src/lib/plugin/rules.js";

const encode = (text: string) => new TextEncoder().encode(text);
const rule = (path: string, text: string): ProjectRule => ({
	path,
	source: `rules/${path}`,
	bytes: encode(text),
});

describe("selectRules", () => {
	const files = [
		{ path: "rules/style.md", bytes: encode("style") },
		{ path: ".claude/rules/team/naming.md", bytes: encode("naming") },
		{ path: "skills/deploy/SKILL.md", bytes: encode("skill") },
		{ path: "CLAUDE.md", bytes: encode("memory") },
	];
	const listed = files.map((file) => ({ path: file.path, size: 1 }));

	it("takes the markdown under rules/ and .claude/rules/, below the rules folder, in path order", () => {
		const rules = selectRules({ files, listed }, "claude-code");

		expect(rules.map((entry) => [entry.path, entry.source])).toEqual([
			["style.md", "rules/style.md"],
			["team/naming.md", ".claude/rules/team/naming.md"],
		]);
	});

	it("is one rule when both spellings name it, and the .claude one wins", () => {
		const both = [
			{ path: "rules/a.md", bytes: encode("root") },
			{ path: ".claude/rules/a.md", bytes: encode("claude") },
		];

		const rules = selectRules(
			{ files: both, listed: both.map((f) => ({ path: f.path })) },
			"claude-code",
		);

		expect(rules).toHaveLength(1);
		expect(new TextDecoder().decode(rules[0]?.bytes)).toBe("claude");
	});

	it("leaves out a rule whose bytes were not read", () => {
		expect(
			selectRules(
				{ files: [], listed: [{ path: "rules/a.md" }] },
				"codex",
			),
		).toEqual([]);
	});
});

describe("capRules", () => {
	it("keeps the first 64 files and counts the rest", () => {
		const many = Array.from({ length: RULES_MAX_FILES + 6 }, (_, i) =>
			rule(`r${String(i).padStart(3, "0")}.md`, "x"),
		);

		const { kept, omitted } = capRules(many);

		expect(kept).toHaveLength(RULES_MAX_FILES);
		expect(omitted).toBe(6);
	});

	it("stops before the byte budget is passed", () => {
		const big = "x".repeat(RULES_MAX_BYTES / 2 - 10);
		const { kept, omitted } = capRules([
			rule("a.md", big),
			rule("b.md", big),
			rule("c.md", big),
		]);

		expect(kept.map((entry) => entry.path)).toEqual(["a.md", "b.md"]);
		expect(omitted).toBe(1);
	});
});

describe("the rules in AGENTS.override.md", () => {
	it("gives each rule a heading and its text without the frontmatter", () => {
		const section = agentsRulesSection([
			rule("style.md", "Use tabs.\n"),
			rule(
				"api.md",
				'---\npaths:\n  - src/api/**\n  - "lib/*.ts"\n---\nValidate input.\n',
			),
		]);

		expect(section.startsWith("## Project rules")).toBe(true);
		expect(section).toContain("### Rule: style.md\nUse tabs.");
		expect(section).toContain(
			"### Rule: api.md\n_Applies when working on: src/api/**, lib/*.ts_",
		);
		expect(section).toContain("Validate input.");
		expect(section).not.toContain("paths:");
	});

	it("reads an inline paths list too", () => {
		const section = agentsRulesSection([
			rule("a.md", '---\npaths: ["a/**", b/*.md]\n---\nbody'),
			rule("b.md", "---\npaths: one/**\n---\nbody"),
		]);

		expect(section).toContain("Applies when working on: a/**, b/*.md");
		expect(section).toContain("Applies when working on: one/**");
	});

	it("is nothing without rules", () => {
		expect(agentsRulesSection([])).toBe("");
	});

	it("cuts between files at the limit and names what it left out", () => {
		const filler = "y".repeat(AGENTS_RULES_LIMIT / 2);
		const section = agentsRulesSection([
			rule("a.md", filler),
			rule("b.md", filler),
			rule("c.md", "short"),
		]);

		expect(section).toContain("### Rule: a.md");
		expect(section).not.toContain("### Rule: b.md");
		expect(section).toContain("2 more rule files were left out");
		expect(section).toContain("b.md, c.md");
		expect(section.length).toBeLessThan(AGENTS_RULES_LIMIT + 400);
	});

	it("follows the memory file, and is null when there is neither", () => {
		const text = agentsInstructions("memory\n", [rule("a.md", "rule")]);

		expect(text?.indexOf("memory")).toBeLessThan(
			text?.indexOf("## Project rules") ?? -1,
		);
		expect(agentsInstructions(null, [rule("a.md", "rule")])).toMatch(
			/^## Project rules/,
		);
		expect(agentsInstructions(null, [])).toBeNull();
		expect(agentsInstructions("memory", [])).toBe("memory");
	});
});
