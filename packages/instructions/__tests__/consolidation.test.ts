import { describe, expect, it } from "vitest";
import { planConsolidation, scopeHeader } from "../src/consolidation";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

function toOf(paths: string[]) {
	const plan = planConsolidation(paths.map((path) => ({ path })));
	return Object.fromEntries(plan.items.map((i) => [i.from, i.to]));
}

describe("planConsolidation", () => {
	it("maps each tool's files to the canonical layout", () => {
		expect(
			toOf([
				"AGENTS.md",
				"CLAUDE.md",
				"GEMINI.md",
				".claude/skills/review/SKILL.md",
				".claude/skills/review/scripts/run.sh",
				".claude/agents/qa.md",
				".claude/commands/ship.md",
				".claude/rules/git.md",
				".claude/settings.json",
				".claude/hooks/guard.sh",
				".cursor/rules/style.mdc",
				".github/copilot-instructions.md",
				".github/instructions/tests.instructions.md",
				".github/prompts/plan.prompt.md",
				".kiro/steering/product.md",
				".mcp.json",
				".cursorrules",
			]),
		).toEqual({
			"AGENTS.md": "AGENTS.md",
			"CLAUDE.md": "CLAUDE.md",
			"GEMINI.md": "rules/gemini.md",
			".claude/skills/review/SKILL.md": "skills/review/SKILL.md",
			".claude/skills/review/scripts/run.sh":
				"skills/review/scripts/run.sh",
			".claude/agents/qa.md": "agents/qa.md",
			".claude/commands/ship.md": "commands/ship.md",
			".claude/rules/git.md": "rules/git.md",
			".claude/settings.json": "tools/claude/settings.json",
			".claude/hooks/guard.sh": "tools/claude/hooks/guard.sh",
			".cursor/rules/style.mdc": "rules/style.md",
			".github/copilot-instructions.md": "rules/copilot-instructions.md",
			".github/instructions/tests.instructions.md": "rules/tests.md",
			".github/prompts/plan.prompt.md": "commands/plan.md",
			".kiro/steering/product.md": "rules/product.md",
			".mcp.json": "tools/mcp.json",
			".cursorrules": "rules/cursor.md",
		});
	});

	it("never moves CI, application code or dependencies", () => {
		expect(
			toOf([
				".github/workflows/ci.yml",
				".github/CODEOWNERS",
				"src/index.ts",
				"README.md",
				"node_modules/pkg/AGENTS.md",
			]),
		).toEqual({});
	});

	it("turns a directory-scoped instruction file into a scoped rule", () => {
		const plan = planConsolidation([{ path: "packages/api/AGENTS.md" }]);
		expect(plan.items[0]).toMatchObject({
			to: "rules/scoped/packages/api/AGENTS.md",
			transform: "scope-header",
		});
		expect(scopeHeader("packages/api/AGENTS.md")).toContain(
			"`packages/api/`",
		);
	});

	it("offers neutral root folders without including them", () => {
		const plan = planConsolidation([{ path: "skills/x/SKILL.md" }]);
		expect(plan.items[0]).toMatchObject({
			to: "skills/x/SKILL.md",
			defaultIncluded: false,
		});
	});

	it("skips personal files and symlinks", () => {
		const plan = planConsolidation([
			{ path: ".claude/settings.local.json" },
			{ path: "CLAUDE.local.md" },
			{ path: ".claude/skills/x/SKILL.md", mode: "120000" },
		]);
		expect(plan.items).toEqual([]);
		expect(plan.skipped.map((s) => s.reason)).toEqual([
			"personal",
			"personal",
			"not-a-file",
		]);
	});

	it("folds identical copies and keeps a different one under its tool", () => {
		const plan = planConsolidation([
			{ path: ".claude/skills/review/SKILL.md", oid: OID_A },
			{ path: ".agents/skills/review/SKILL.md", oid: OID_A },
			{ path: ".codex/skills/review/SKILL.md", oid: OID_B },
		]);
		const by = Object.fromEntries(plan.items.map((i) => [i.from, i]));
		expect(by[".claude/skills/review/SKILL.md"]?.to).toBe(
			"skills/review/SKILL.md",
		);
		expect(by[".agents/skills/review/SKILL.md"]).toMatchObject({
			to: null,
			duplicateOf: ".claude/skills/review/SKILL.md",
		});
		expect(by[".codex/skills/review/SKILL.md"]).toMatchObject({
			to: "tools/codex/skills/review/SKILL.md",
			target: "TOOL",
		});
	});
});
