/**
 * Skill Tool Execution Activity
 *
 * Workflow-invoked dispatch for the three skill runtime tools bound into
 * orchestrator iterations: `list_skills`, `load_skill`, `read_skill_file`.
 *
 * Lives as an activity (not inline in the workflow) because the runtime it
 * proxies — `@repo/ai/skills` — pulls in `@repo/database` and `@repo/storage`,
 * which are forbidden in the Temporal workflow sandbox (see worker.ts notes).
 */

import {
	listAvailableSkills,
	loadSkillBundle,
	readSkillFile,
	type SkillBundle,
	type SkillFileContent,
	type SkillSummary,
} from "@repo/ai/skills";

export interface ExecuteSkillToolInput {
	toolName: "list_skills" | "load_skill" | "read_skill_file";
	args: Record<string, unknown>;
	userId: string;
	organizationId?: string;
}

export type ExecuteSkillToolOutput =
	| { kind: "list"; skills: SkillSummary[] }
	| { kind: "bundle"; bundle: SkillBundle }
	| { kind: "file"; file: SkillFileContent };

export async function executeSkillToolActivity(
	input: ExecuteSkillToolInput,
): Promise<ExecuteSkillToolOutput> {
	const { toolName, args, userId, organizationId } = input;
	const ctx = { userId, organizationId };

	if (toolName === "list_skills") {
		const skills = await listAvailableSkills(ctx);
		return { kind: "list", skills };
	}

	if (toolName === "load_skill") {
		const slug = typeof args.slug === "string" ? args.slug : "";
		if (!slug) {
			throw new Error("load_skill: missing required arg 'slug'");
		}
		const bundle = await loadSkillBundle(slug, ctx);
		return { kind: "bundle", bundle };
	}

	if (toolName === "read_skill_file") {
		const slug = typeof args.slug === "string" ? args.slug : "";
		const path = typeof args.path === "string" ? args.path : "";
		if (!slug || !path) {
			throw new Error(
				"read_skill_file: requires both 'slug' and 'path' args",
			);
		}
		const file = await readSkillFile(slug, path, ctx);
		return { kind: "file", file };
	}

	throw new Error(`executeSkillToolActivity: unknown tool "${toolName}"`);
}
