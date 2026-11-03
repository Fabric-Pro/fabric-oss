/**
 * The plugin's built-in `fabric-change-instructions` skill
 * (specs/2026-10-21-ai-artifacts-hub §5.3, §5.7). The plugin is read-only: the
 * instructions it carries change only through Fabric, which commits the
 * change to the project's instructions repository; every teammate receives it
 * as a plugin update.
 */

import type { PluginTool } from "@fabricorg/sdk";

export const CHANGE_INSTRUCTIONS_SKILL = "fabric-change-instructions";

export function changeInstructionsSkill(
	tool: PluginTool,
	projectId: string,
): string {
	const restart =
		tool === "claude-code"
			? "Teammates get it at their next session; to load it here, start a new session."
			: "Teammates get it when their next session starts; start a new session to load it here.";
	return `${[
		"---",
		`name: ${CHANGE_INSTRUCTIONS_SKILL}`,
		"description: Change this project's coding instructions (rules, AGENTS.md/CLAUDE.md, skills, agents, commands) when the user asks — e.g. 'update the rule about X', 'add a skill for Y', 'stop doing Z'. The plugin is read-only; instructions change only through Fabric.",
		"---",
		"",
		"# Change the project's coding instructions",
		"",
		`The instructions in this plugin are delivered by Fabric (project \`${projectId}\`) and are read-only. Never edit the plugin's files, and never copy instruction files into the user's repository to change them there. Change them through Fabric:`,
		"",
		"1. Find the files: use the fabric-instruction-access skill (its catalog) and `fabric_list_project_instructions`. Read each file you will change with `fabric_get_project_instruction`, and keep the base it reports (`nativeBase` for a repository, `baseSnapshotId` for uploaded instructions).",
		"2. Make the change the user asked for, keeping each file's style. A new skill is `skills/<name>/SKILL.md` with `name` and `description` frontmatter; a rule is a markdown file under `rules/`. Refer to the project's code by its workspace path, `repos/<name>/...` (for example `repos/app/docs/setup.md`), never as if the instructions lived inside a code repository.",
		"3. Show the user the diff and wait for their OK.",
		"4. Send it with `fabric_change_instructions`: the whole new content of each changed file, the base, and a one-line `summary` in the user's words. It commits to the instructions repository when you may, otherwise it opens a pull request for review; the result says which.",
		`5. Tell the user the outcome. ${restart}`,
		"",
		"If a file changed since you read it, the tool refuses: read it again and redo the edit. Lessons learned while working go through `fabric_add_instruction_lesson`; project knowledge (notes, specs, decisions) through the fabric-knowledge skill, not into instructions.",
	].join("\n")}\n`;
}

/** Added to the always-on session text: the plugin is read-only. */
export const READ_ONLY_RULE = `Coding instructions: this project's instructions come from the Fabric plugin and are read-only. To change a rule, a skill or AGENTS.md/CLAUDE.md, use the ${CHANGE_INSTRUCTIONS_SKILL} skill (fabric_change_instructions); never edit the plugin's files or add instruction files to the repository.\n`;

/**
 * Added to the always-on session text: the agent workspace layout
 * (specs/2026-10-21-ai-artifacts-hub §5.7). The coding tool runs in the
 * workspace; each code repository is a clone in `repos/<name>/`, made with
 * plain git from the list `fabric_list_code_repositories` returns.
 */
export const WORKSPACE_RULE =
	"Workspace layout: the folder this session runs in is the agent workspace. The project's code repositories are cloned in `repos/<name>/`. To find them, or when one is missing, call `fabric_list_code_repositories` and clone each missing one with plain git (`git clone <cloneUrl> repos/<folder>`) from the workspace root; when the workspace is itself a git checkout, keep `/repos/` out of it in `.git/info/exclude`. Fabric does not sync these clones: fetch, pull, branch and push with git in each. A path in these instructions that is not an instruction file (for example `docs/...` or `src/...`) is inside a code repository: resolve it under `repos/<name>/`. Run git, builds and tests inside `repos/<name>/`, and never add AI instruction files to a code repository.\n";
