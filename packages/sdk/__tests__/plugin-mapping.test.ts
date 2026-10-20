import { describe, expect, it } from "vitest";
import {
	PLUGIN_LEFT_OUT_REASONS,
	type PluginLeftOutReason,
	planPluginFiles,
	pluginPathFor,
	projectRulePathFor,
} from "../src/plugin-mapping.js";

const plan = (paths: string[], tool: "claude-code" | "codex" = "claude-code") =>
	planPluginFiles(
		paths.map((path) => ({ path })),
		tool,
	);

describe("pluginPathFor", () => {
	it.each([
		["skills/deploy/SKILL.md", "skills/deploy/SKILL.md"],
		[".claude/skills/deploy/SKILL.md", "skills/deploy/SKILL.md"],
		["Skills/deploy/scripts/run.sh", "skills/deploy/scripts/run.sh"],
		["agents/reviewer.md", "agents/reviewer.md"],
		[".claude/agents/reviewer.md", "agents/reviewer.md"],
		["Agents/Reviewer.MD", "agents/Reviewer.MD"],
		["commands/ship.md", "commands/ship.md"],
		[".claude/commands/team/ship.md", "commands/team/ship.md"],
	])("maps %s to %s", (from, to) => {
		expect(pluginPathFor(from)).toBe(to);
	});

	it.each([
		"CLAUDE.md",
		"rules/style.md",
		".claude/rules/style.md",
		"skills/loose.md",
		"agents/tools/helper.py",
		"agents/sub/a.md",
		"commands",
		"docs/guide.md",
	])("has no place in the plugin tree for %s", (path) => {
		expect(pluginPathFor(path)).toBeNull();
	});
});

describe("projectRulePathFor", () => {
	it.each([
		["rules/style.md", "style.md"],
		["Rules/team/style.md", "team/style.md"],
		[".claude/rules/style.md", "style.md"],
		[".claude/rules/a/b/c.MD", "a/b/c.MD"],
	])("takes %s as the project rule %s", (from, to) => {
		expect(projectRulePathFor(from)).toBe(to);
	});

	it.each([
		"rules",
		"rules/style.txt",
		"rules/img/logo.png",
		"docs/rules/style.md",
		".claude/rules",
	])("does not take %s", (path) => {
		expect(projectRulePathFor(path)).toBeNull();
	});
});

describe("planPluginFiles", () => {
	it("carries the standard layout and says where each file goes", () => {
		const result = plan([
			"CLAUDE.md",
			"skills/deploy/SKILL.md",
			".claude/agents/reviewer.md",
			"commands/ship.md",
			"rules/style.md",
		]);

		expect(result.alwaysOn).toEqual({ path: "CLAUDE.md" });
		expect(result.carried).toEqual([
			{ path: ".claude/agents/reviewer.md", as: "agents/reviewer.md" },
			{ path: "commands/ship.md", as: "commands/ship.md" },
			{ path: "skills/deploy/SKILL.md", as: "skills/deploy/SKILL.md" },
		]);
		expect(result.rules).toEqual([
			{ path: "rules/style.md", as: "style.md" },
		]);
		expect(result.leftOut).toEqual([]);
	});

	it("counts rules as delivered, not as left out", () => {
		const result = plan([".claude/rules/a.md", "rules/b.md"]);

		expect(result.rules.map((rule) => rule.path)).toEqual([
			".claude/rules/a.md",
			"rules/b.md",
		]);
		expect(result.leftOut).toEqual([]);
	});

	it.each<[string, PluginLeftOutReason]>([
		["docs/guide.md", "outside-plugin-folders"],
		[".claude/settings.json", "outside-plugin-folders"],
		["README.md", "outside-plugin-folders"],
		["skills/loose.md", "skill-needs-folder"],
		["skills/SKILL.md", "skill-needs-folder"],
		["agents/tools/helper.py", "agent-must-be-markdown-file"],
		["agents/sub/a.md", "agent-must-be-markdown-file"],
		["agents/notes.txt", "agent-must-be-markdown-file"],
		["rules/style.txt", "rule-must-be-markdown"],
		["rules/logo.png", "rule-must-be-markdown"],
	])("leaves %s out because of %s", (path, reason) => {
		expect(plan([path]).leftOut).toEqual([{ path, reason }]);
	});

	it("leaves out a file that is not text, whatever its place", () => {
		const result = planPluginFiles(
			[
				{ path: "skills/deploy/logo.png", isText: false },
				{ path: "skills/deploy/SKILL.md", isText: true },
			],
			"claude-code",
		);

		expect(result.leftOut).toEqual([
			{ path: "skills/deploy/logo.png", reason: "not-text" },
		]);
		expect(result.carried.map((file) => file.path)).toEqual([
			"skills/deploy/SKILL.md",
		]);
	});

	it("uses CLAUDE.md for Claude Code and AGENTS.md for Codex, and says the other one is not used", () => {
		const paths = ["CLAUDE.md", "AGENTS.md"];

		expect(plan(paths, "claude-code")).toMatchObject({
			alwaysOn: { path: "CLAUDE.md" },
			leftOut: [{ path: "AGENTS.md", reason: "always-on-shadowed" }],
		});
		expect(plan(paths, "codex")).toMatchObject({
			alwaysOn: { path: "AGENTS.md" },
			leftOut: [{ path: "CLAUDE.md", reason: "always-on-shadowed" }],
		});
	});

	it("falls back to the other memory file when the preferred one is empty", () => {
		const result = planPluginFiles(
			[
				{ path: "CLAUDE.md", size: 0 },
				{ path: "AGENTS.md", size: 10 },
			],
			"claude-code",
		);

		expect(result.alwaysOn).toEqual({ path: "AGENTS.md" });
		expect(result.leftOut).toEqual([
			{ path: "CLAUDE.md", reason: "always-on-shadowed" },
		]);
	});

	it("is the same whatever the order of the entries", () => {
		const paths = [
			"docs/z.md",
			"skills/b/SKILL.md",
			"CLAUDE.md",
			"docs/a.md",
			"skills/a/SKILL.md",
		];

		expect(plan(paths)).toEqual(plan([...paths].reverse()));
		expect(plan(paths).leftOut.map((entry) => entry.path)).toEqual([
			"docs/a.md",
			"docs/z.md",
		]);
	});

	it("names every reason once", () => {
		expect(new Set(PLUGIN_LEFT_OUT_REASONS).size).toBe(
			PLUGIN_LEFT_OUT_REASONS.length,
		);
	});
});
