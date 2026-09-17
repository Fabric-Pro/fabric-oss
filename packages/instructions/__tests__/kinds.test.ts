import { describe, expect, it } from "vitest";
import { classifyPath } from "../src/kinds";

describe("classifyPath", () => {
	it.each([
		[".claude/skills/example-qa-test/SKILL.md", "SKILL"],
		[
			".claude/skills/example-qa-test/references/agent-prompts/ba-analyst.md",
			"SKILL",
		],
		[".codex/skills/review/SKILL.md", "SKILL"],
		[".claude/agents/qa-lead.md", "AGENT"],
		[".claude/rules/git-workflow.md", "RULE"],
		[".cursor/rules/style.mdc", "RULE"],
		[".github/instructions/tests.instructions.md", "RULE"],
		["CLAUDE.md", "INSTRUCTIONS"],
		["AGENTS.md", "INSTRUCTIONS"],
		["apps/web/CLAUDE.md", "INSTRUCTIONS"],
		[".github/copilot-instructions.md", "INSTRUCTIONS"],
		[".claude/settings.json", "SETTINGS"],
		[".mcp.json", "SETTINGS"],
		[".codex/config.toml", "SETTINGS"],
		["scripts/run-node.sh", "SCRIPT"],
		["scripts/lib/helper.py", "SCRIPT"],
		["scripts/session-preflight.js", "SCRIPT"],
		["areas/vendor-management.md", "KNOWLEDGE"],
		["01-project-overview.md", "KNOWLEDGE"],
		["references/phase-gates/log-schema.md", "KNOWLEDGE"],
		["metrics/phase-gate-v2-gates.txt", "OTHER"],
		["templates/task-intake.md", "KNOWLEDGE"],
		["assets/logo.png", "OTHER"],
	] as const)("%s → %s", (path, kind) => {
		expect(classifyPath(path)).toBe(kind);
	});

	it("is case-insensitive on well-known file names", () => {
		expect(classifyPath("claude.md")).toBe("INSTRUCTIONS");
		expect(classifyPath(".claude/skills/x/skill.md")).toBe("SKILL");
	});

	it("treats a leading ./ and backslashes as the same path", () => {
		expect(classifyPath("./.claude/agents/a.md")).toBe("AGENT");
		expect(classifyPath(".claude\\agents\\a.md")).toBe("AGENT");
	});
});
