/**
 * System-prompt fragment that advertises available skills to the model.
 *
 * Follows Anthropic's progressive-disclosure contract: the system prompt
 * carries ONLY the skill registry (slug + one-line description). The full
 * SKILL.md body is pulled on demand via the load_skill tool.
 */

import type { SkillSummary } from "./loader";

export function buildSkillsSystemBlock(skills: SkillSummary[]): string | null {
	if (skills.length === 0) {
		return null;
	}

	const lines = skills.map((s) => `- ${s.slug}: ${s.description}`);
	return [
		"## Available Skills",
		"",
		"You have access to the following skills. When a user's request matches a skill's description, call `load_skill(slug)` to fetch the full instructions, then follow them. Call `read_skill_file(slug, path)` only when the loaded instructions direct you to a specific file.",
		"",
		lines.join("\n"),
	].join("\n");
}
