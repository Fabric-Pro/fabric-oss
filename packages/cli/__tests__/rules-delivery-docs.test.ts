/**
 * The words the docs use for delivering project rules are checked against the
 * code that does it, so the folder, the command and the hook cannot drift.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { desiredHooks } from "../src/lib/memory/hooks.js";
import { INSTRUCTION_ACCESS_SKILL } from "../src/lib/plugin/instruction-access.js";
import { pluginNameFor } from "../src/lib/plugin/layout.js";
import { rulesFolderFor } from "../src/lib/plugin/rules-sync.js";

const ROOT = path.resolve(__dirname, "../../..");
const read = (relative: string) =>
	readFileSync(path.join(ROOT, relative), "utf8");

const GUIDE = read("apps/web/content/docs/integrations/mcp-gateway.mdx");
const CLI_GUIDE = read("docs/guides/coding-instructions-cli.md");
const FEATURE_GUIDE = read(
	"apps/web/content/docs/features/coding-instructions.mdx",
);
const PROJECT = "cmexampleproject0123456789";

describe("the docs on project rules", () => {
	it("explain on-demand access without promising automatic delivery of every instruction", () => {
		for (const guide of [GUIDE, CLI_GUIDE, FEATURE_GUIDE]) {
			expect(guide).toContain(INSTRUCTION_ACCESS_SKILL);
			expect(guide).toContain("automatic");
		}
		for (const guide of [GUIDE, CLI_GUIDE]) {
			expect(guide).toContain("fabric_list_project_instructions");
			expect(guide).toContain("fabric_get_project_instruction");
			expect(guide).toContain("@MAIN.md");
			expect(guide).toContain("nextOffset");
		}
		expect(CLI_GUIDE).toContain("snapshotVersion");
		expect(CLI_GUIDE).toContain("instructions/source/<original path>");
	});

	it("name the folder the code writes, as the plugin's name with the id in place", () => {
		const folder = rulesFolderFor(PROJECT);

		expect(folder).toBe(`.claude/rules/${pluginNameFor(PROJECT)}`);
		const documented = folder.replace(
			pluginNameFor(PROJECT),
			"fabric-<id>",
		);
		expect(GUIDE).toContain(`${documented}/`);
		expect(CLI_GUIDE).toContain(`${documented}/`);
	});

	it("name the command the Claude Code session hook runs", () => {
		const hook = desiredHooks({
			tool: "claude-code",
			projectId: PROJECT,
			launcher: "fabric",
		}).find((entry) => entry.kind === "rules-sync");

		expect(hook?.command).toBe(
			`fabric instructions rules --project ${PROJECT} --hook`,
		);
		expect(CLI_GUIDE).toContain("`fabric instructions rules --hook`");
		expect(CLI_GUIDE).toContain("fabric instructions rules --project <id>");
		expect(GUIDE).toContain("`instructions rules`");
	});

	it("name the marker file and the caps the code uses", () => {
		expect(GUIDE).toContain(".fabric-managed.json");
		expect(CLI_GUIDE).toContain(".fabric-managed.json");
		expect(CLI_GUIDE).toContain("64 files and 256 KiB");
		expect(CLI_GUIDE).toContain("24,000");
	});

	it("do not say any more that the plugin is the only home of rules or that they are not delivered", () => {
		expect(GUIDE).not.toContain("does not carry them yet");
		expect(CLI_GUIDE).not.toContain("recognised, not yet delivered");
	});

	it("give Codex's heading and scope wording the code writes", () => {
		expect(CLI_GUIDE).toContain("## Project rules");
		expect(CLI_GUIDE).toContain("### Rule: <path>");
		expect(CLI_GUIDE).toContain("Applies when working on:");
	});
});
