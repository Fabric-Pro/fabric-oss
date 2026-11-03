/**
 * The plugin's built-in `fabric-rules` skill (specs/2026-10-21-ai-artifacts-hub
 * §5.8): the index of the project's rules a session does not carry from the
 * start (`tierRules`), so a long rule set costs a line each instead of its
 * whole text. The agent loads a rule when the task or the files it touches
 * call for it.
 */
import type { PluginTool } from "@fabricorg/sdk";
import type { OnDemandRule } from "./rules.js";

export const RULES_SKILL = "fabric-rules";

export function rulesSkill(
	rules: readonly OnDemandRule[],
	tool: PluginTool,
	projectId: string,
): string {
	const pluginRoot =
		tool === "claude-code"
			? "${CLAUDE_PLUGIN_ROOT}"
			: "this plugin's folder";
	const index =
		rules.length === 0
			? ["- (none: every rule of this project is already loaded)"]
			: rules.map((rule) => {
					const scope =
						rule.paths.length > 0
							? ` Applies to: ${rule.paths.map((p) => `\`${p}\``).join(", ")}.`
							: "";
					return `- \`${rule.path}\`: ${rule.description || "(no description)"}.${scope} File: \`instructions/source/${rule.source}\``;
				});
	return `${[
		"---",
		`name: ${RULES_SKILL}`,
		"description: The project's rules that are not loaded at session start. Check this list before starting a task, editing files or reviewing code, and load every rule whose description or paths match the work.",
		"---",
		"",
		"# Project rules loaded on demand",
		"",
		`These rules of Fabric project \`${projectId}\` are kept out of the always-on context so it stays small. Before a task, read this list. For every rule that matches what you are about to do (its description, or files under its paths):`,
		"",
		`1. Read it from ${pluginRoot}/<File> below, or call \`fabric_rules_for\` with the files and a one-line task: it returns the matching rules in full.`,
		"2. Follow it as strictly as an always-on rule.",
		"",
		"Do not load rules that do not apply. Rules change through the fabric-change-instructions skill, never by editing these files.",
		"",
		"## Index",
		"",
		...index,
	].join("\n")}\n`;
}
