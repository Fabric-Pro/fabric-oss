/**
 * Skill resolution for weave agents
 *
 * Integrates with Fabric's existing skill catalog at /app/skills
 */

import { db } from "@repo/database";
import type { TenantContext } from "../types/index.js";

export interface ResolveSkillsParams {
	agentName: string;
	projectId: string;
	tenantContext: TenantContext;
}

/**
 * Resolve skills for a weave agent
 *
 * Fetches enabled skills from ProjectWeaveConfig and formats them
 * for prompt injection.
 */
export async function resolveSkillsForAgent({
	agentName,
	projectId,
	tenantContext,
}: ResolveSkillsParams): Promise<string> {
	// Get project config
	const config = await db.projectWeaveConfig.findUnique({
		where: { projectId },
	});

	if (!config || config.enabledSkills.length === 0) {
		return "";
	}

	// Fetch skills from Fabric catalog
	const skills = await db.skill.findMany({
		where: {
			id: { in: config.enabledSkills },
			OR: [
				{
					userId: tenantContext.userId,
					organizationId: tenantContext.organizationId,
				},
				{ userId: tenantContext.userId, organizationId: null },
			],
		},
	});

	// Filter skills applicable to this agent and format for injection
	const applicableSkills = skills.filter((skill) =>
		isSkillApplicableToAgent(skill, agentName),
	);

	return applicableSkills
		.map((skill) => formatSkillForPrompt(skill))
		.join("\n\n---\n\n");
}

/**
 * Check if a skill applies to a specific agent
 */
function isSkillApplicableToAgent(
	skill: { tags?: string[]; appliesTo?: string[] },
	agentName: string,
): boolean {
	// If appliesTo is specified, check if agent is included
	if (skill.appliesTo && skill.appliesTo.length > 0) {
		return skill.appliesTo.includes(agentName);
	}

	// Otherwise, check tags for agent-specific tags
	if (skill.tags) {
		const agentTags = ["all", agentName];
		return skill.tags.some((tag) => agentTags.includes(tag));
	}

	return true; // Default: apply to all agents
}

/**
 * Format a skill for prompt injection
 */
function formatSkillForPrompt(skill: {
	name: string;
	description?: string | null;
	content: string;
}): string {
	return `### ${skill.name}
${skill.description ? `${skill.description}\n\n` : ""}${skill.content}`;
}

/**
 * List available skills for a project
 */
export async function listAvailableSkills(
	projectId: string,
	tenantContext: TenantContext,
): Promise<
	Array<{
		id: string;
		name: string;
		description: string | null;
		enabled: boolean;
	}>
> {
	const [config, allSkills] = await Promise.all([
		db.projectWeaveConfig.findUnique({ where: { projectId } }),
		db.skill.findMany({
			where: {
				OR: [
					{
						userId: tenantContext.userId,
						organizationId: tenantContext.organizationId,
					},
					{ userId: tenantContext.userId, organizationId: null },
				],
			},
			select: { id: true, name: true, description: true },
		}),
	]);

	const enabledIds = new Set(config?.enabledSkills || []);

	return allSkills.map((skill) => ({
		...skill,
		enabled: enabledIds.has(skill.id),
	}));
}

/**
 * Toggle skill enabled status
 */
export async function toggleSkill(
	projectId: string,
	skillId: string,
	enabled: boolean,
): Promise<void> {
	const config = await db.projectWeaveConfig.findUnique({
		where: { projectId },
	});

	if (!config) {
		throw new Error("ProjectWeaveConfig not found");
	}

	const enabledSkills = new Set(config.enabledSkills);

	if (enabled) {
		enabledSkills.add(skillId);
	} else {
		enabledSkills.delete(skillId);
	}

	await db.projectWeaveConfig.update({
		where: { projectId },
		data: { enabledSkills: Array.from(enabledSkills) },
	});
}
