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

	it.each([
		// The environment declaration the CLI doctor reads (Fizzy #2653).
		["fabric.environment.json", "SETTINGS"],
		["Fabric.Environment.json", "SETTINGS"],
		// Only at the tree root: a nested copy is not the declaration.
		["docs/fabric.environment.json", "OTHER"],
		[".claude/fabric.environment.json", "OTHER"],
	] as const)("environment declaration %s → %s", (path, kind) => {
		expect(classifyPath(path)).toBe(kind);
	});
});

describe("classifyPath: Guild-shaped trees (spec §5.8)", () => {
	it.each([
		["Rules/typescript.md", "RULE"],
		["rules/nested/deep.md", "RULE"],
		[".claude/Rules/style.md", "RULE"],
		["Skills/review/SKILL.md", "SKILL"],
		["Skills/review/references/checklist.md", "SKILL"],
		["Skills/SKILL.md", "SKILL"],
		["skills/deep/nested/SKILL.md", "SKILL"],
		[".claude/Skills/review/run.sh", "SKILL"],
		["Agents/reviewer.md", "AGENT"],
		["Agents/tools/helper.py", "AGENT"],
		["Lessons/2026-09-01-retry.md", "KNOWLEDGE"],
		["Knowledge/CLAUDE.md", "KNOWLEDGE"],
		["UserPreferences/dev-example/style.md", "KNOWLEDGE"],
		["UserPreferences/dev-example/settings.json", "KNOWLEDGE"],
		["Mcp/servers.json", "SETTINGS"],
		[".claude/mcp/servers.json", "SETTINGS"],
		["Env/staging/vars.json", "SETTINGS"],
		["Env/vars.json", "SETTINGS"],
	] as const)("%s → %s", (path, kind) => {
		expect(classifyPath(path)).toBe(kind);
	});

	it.each([
		// A loose file directly in Skills/ is not inside a skill folder.
		["Skills/notes.md", "KNOWLEDGE"],
		// Only Mcp/*.json, one level deep.
		["Mcp/nested/servers.json", "OTHER"],
		["Mcp/README.md", "KNOWLEDGE"],
		// Env/ maps JSON only.
		["Env/setup.sh", "SCRIPT"],
		// Only at the tree root or under .claude/.
		["docs/Rules/old.md", "KNOWLEDGE"],
		["tools/Agents/x.md", "KNOWLEDGE"],
		// A root FILE named like a folder is untouched.
		["AGENTS.md", "INSTRUCTIONS"],
	] as const)("%s keeps today's rules → %s", (path, kind) => {
		expect(classifyPath(path)).toBe(kind);
	});
});
