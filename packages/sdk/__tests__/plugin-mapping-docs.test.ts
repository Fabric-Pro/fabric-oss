// @vitest-environment node
/**
 * The standard layout the docs describe is checked against the mapping that
 * builds the plugin, so the two cannot drift: every row the docs show is
 * named in both canonical pages, and the sample path for it goes where the row
 * says.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planPluginFiles } from "../src/plugin-mapping.js";

const ROOT = path.resolve(__dirname, "../../..");
const read = (relative: string) =>
	readFileSync(path.join(ROOT, relative), "utf8");

const GUIDE = read("apps/web/content/docs/integrations/mcp-gateway.mdx");
const CLI_GUIDE = read("docs/guides/coding-instructions-cli.md");

type Outcome =
	| { carriedAs: string }
	| { ruleAs: string }
	| { alwaysOn: string };

/** The rows of the Standard layout table: what the docs name, and what a file there becomes. */
const STANDARD_LAYOUT: Array<{
	documented: string;
	sample: string;
	outcome: Outcome;
}> = [
	{
		documented: "`skills/<name>/SKILL.md`",
		sample: "skills/deploy/SKILL.md",
		outcome: { carriedAs: "skills/deploy/SKILL.md" },
	},
	{
		documented: "`agents/<name>.md`",
		sample: "agents/reviewer.md",
		outcome: { carriedAs: "agents/reviewer.md" },
	},
	{
		documented: "`commands/**`",
		sample: "commands/team/ship.md",
		outcome: { carriedAs: "commands/team/ship.md" },
	},
	{
		documented: "`rules/**/*.md`",
		sample: "rules/team/style.md",
		outcome: { ruleAs: "team/style.md" },
	},
	{
		documented: "`CLAUDE.md` or `AGENTS.md`",
		sample: "CLAUDE.md",
		outcome: { alwaysOn: "CLAUDE.md" },
	},
	{
		documented: "`.claude/skills/<name>/SKILL.md`",
		sample: ".claude/skills/deploy/SKILL.md",
		outcome: { carriedAs: "skills/deploy/SKILL.md" },
	},
];

describe("the standard layout in the docs", () => {
	it.each(STANDARD_LAYOUT)(
		"$documented is in the setup guide and goes where it says",
		({ documented, sample, outcome }) => {
			const plan = planPluginFiles([{ path: sample }], "claude-code");

			expect(GUIDE).toContain(documented);
			expect(plan.leftOut).toEqual([]);
			if ("carriedAs" in outcome) {
				expect(plan.carried).toEqual([
					{ path: sample, as: outcome.carriedAs },
				]);
			} else if ("ruleAs" in outcome) {
				expect(plan.rules).toEqual([
					{ path: sample, as: outcome.ruleAs },
				]);
			} else {
				expect(plan.alwaysOn).toEqual({ path: outcome.alwaysOn });
			}
		},
	);

	it("names the layout and the report where an admin looks for them", () => {
		expect(GUIDE).toContain("**Standard layout.**");
		expect(GUIDE).toContain("Coding Instructions");
		expect(CLI_GUIDE).toContain(
			"`rules/**/*.md` or `.claude/rules/**/*.md`",
		);
		expect(CLI_GUIDE).toContain("`planPluginFiles`");
	});

	it("says a file outside the layout is left out, as the mapping does", () => {
		const plan = planPluginFiles(
			[{ path: "scripts/release.sh" }, { path: ".claude/settings.json" }],
			"claude-code",
		);

		expect(plan.leftOut.map((entry) => entry.path)).toEqual([
			".claude/settings.json",
			"scripts/release.sh",
		]);
		expect(GUIDE).toContain(
			"such as standalone scripts, settings and knowledge files",
		);
	});
});
