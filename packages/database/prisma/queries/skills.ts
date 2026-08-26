/**
 * Skill Catalog Database Queries
 *
 * CRUD operations for the skill catalog and template-skill associations.
 * Skills are reusable behavior modules that can be attached to agent templates
 * and materialized as AgentMemoryFile entries on instance creation.
 */

import { db } from "../client";
import type {
	AgentTemplateScope,
	AgentTemplateSkill,
	Prisma,
	ReportTemplateSkill,
	Skill,
} from "../generated/client";

// Re-export types
export type { Skill, AgentTemplateSkill, ReportTemplateSkill };

// ============================================
// SKILL CATALOG QUERIES
// ============================================

export interface ListSkillsParams {
	userId?: string;
	organizationId?: string | null;
	scope?: AgentTemplateScope;
	category?: string;
	tags?: string[];
	search?: string;
	isPublished?: boolean;
	limit?: number;
	offset?: number;
	sortBy?: "name" | "createdAt" | "updatedAt" | "useCount";
	sortOrder?: "asc" | "desc";
}

export async function listSkills(params: ListSkillsParams): Promise<{
	skills: Skill[];
	total: number;
}> {
	const {
		userId,
		organizationId,
		scope,
		category,
		tags,
		search,
		isPublished = true,
		limit = 50,
		offset = 0,
		sortBy = "updatedAt",
		sortOrder = "desc",
	} = params;

	const where: Prisma.SkillWhereInput = {
		isPublished,
	};

	// XOR PATTERN: Strict context isolation
	// Always constrain by tenant context, even when scope is provided.
	// SYSTEM skills are visible to everyone; ORG/USER skills are tenant-isolated.
	{
		const scopeConditions: Prisma.SkillWhereInput[] = [{ scope: "SYSTEM" }];

		if (organizationId) {
			scopeConditions.push({
				scope: "ORGANIZATION" as const,
				organizationId,
			});
		} else if (userId) {
			scopeConditions.push({ scope: "USER" as const, userId });
		}

		where.OR = scopeConditions;

		// If caller also wants a specific scope, narrow further
		if (scope) {
			where.scope = scope;
		}
	}

	if (category) {
		where.category = category;
	}

	if (tags && tags.length > 0) {
		where.tags = { hasSome: tags };
	}

	if (search) {
		where.AND = [
			where.OR ? { OR: where.OR } : {},
			{
				OR: [
					{ name: { contains: search, mode: "insensitive" } },
					{ slug: { contains: search, mode: "insensitive" } },
					{ description: { contains: search, mode: "insensitive" } },
				],
			},
		];
		// Remove top-level OR to avoid conflict with AND
		delete where.OR;
	}

	const [skills, total] = await Promise.all([
		db.skill.findMany({
			where,
			orderBy: { [sortBy]: sortOrder },
			skip: offset,
			take: limit,
		}),
		db.skill.count({ where }),
	]);

	return { skills, total };
}

export async function getSkill(idOrSlug: string): Promise<Skill | null> {
	return db.skill.findFirst({
		where: {
			OR: [{ id: idOrSlug }, { slug: idOrSlug }],
		},
	});
}

export async function getSkillById(
	id: string,
	opts: { userId?: string; organizationId?: string },
): Promise<Skill | null> {
	return db.skill.findFirst({
		where: {
			id,
			OR: [
				{ scope: "SYSTEM" },
				...(opts.organizationId
					? [
							{
								scope: "ORGANIZATION" as const,
								organizationId: opts.organizationId,
							},
						]
					: []),
				...(opts.userId
					? [{ scope: "USER" as const, userId: opts.userId }]
					: []),
			],
		},
	});
}

export interface CreateSkillParams {
	slug: string;
	name: string;
	description: string;
	content: string;
	category?: string;
	tags?: string[];
	scope?: AgentTemplateScope;
	userId?: string;
	organizationId?: string | null;
	isPublished?: boolean;
}

export async function createSkill(params: CreateSkillParams): Promise<Skill> {
	const {
		slug,
		name,
		description,
		content,
		category,
		tags = [],
		scope = "USER",
		userId,
		organizationId,
		isPublished = true,
	} = params;

	return db.skill.create({
		data: {
			slug,
			name,
			description,
			content,
			category,
			tags,
			scope,
			userId,
			organizationId,
			isPublished,
		},
	});
}

export interface UpdateSkillParams {
	name?: string;
	description?: string;
	content?: string;
	category?: string;
	tags?: string[];
	isPublished?: boolean;
}

export async function updateSkill(
	id: string,
	params: UpdateSkillParams,
): Promise<Skill> {
	return db.skill.update({
		where: { id },
		data: {
			...params,
			version: { increment: 1 },
		},
	});
}

export async function deleteSkill(id: string): Promise<void> {
	await db.skill.delete({ where: { id } });
}

// ============================================
// TEMPLATE-SKILL ASSOCIATION QUERIES
// ============================================

export async function attachSkillToTemplate(params: {
	templateId: string;
	skillId: string;
	sortOrder?: number;
	isRequired?: boolean;
}): Promise<AgentTemplateSkill> {
	const { templateId, skillId, sortOrder = 0, isRequired = true } = params;

	return db.agentTemplateSkill.create({
		data: {
			templateId,
			skillId,
			sortOrder,
			isRequired,
		},
	});
}

export async function detachSkillFromTemplate(
	templateId: string,
	skillId: string,
): Promise<void> {
	await db.agentTemplateSkill.delete({
		where: {
			templateId_skillId: {
				templateId,
				skillId,
			},
		},
	});
}

export async function listTemplateSkills(
	templateId: string,
): Promise<(AgentTemplateSkill & { skill: Skill })[]> {
	return db.agentTemplateSkill.findMany({
		where: { templateId },
		include: { skill: true },
		orderBy: { sortOrder: "asc" },
	});
}

export async function incrementSkillUseCount(id: string): Promise<void> {
	await db.skill.update({
		where: { id },
		data: { useCount: { increment: 1 } },
	});
}

// ============================================
// REPORT TEMPLATE-SKILL ASSOCIATION QUERIES
// ============================================

export async function attachSkillToReportTemplate(params: {
	templateId: string;
	skillId: string;
	sortOrder?: number;
	isRequired?: boolean;
}): Promise<ReportTemplateSkill> {
	const { templateId, skillId, sortOrder = 0, isRequired = true } = params;

	return db.reportTemplateSkill.create({
		data: {
			templateId,
			skillId,
			sortOrder,
			isRequired,
		},
	});
}

export async function detachSkillFromReportTemplate(
	templateId: string,
	skillId: string,
): Promise<void> {
	await db.reportTemplateSkill.delete({
		where: {
			templateId_skillId: {
				templateId,
				skillId,
			},
		},
	});
}

export async function listReportTemplateSkills(
	templateId: string,
): Promise<(ReportTemplateSkill & { skill: Skill })[]> {
	return db.reportTemplateSkill.findMany({
		where: { templateId },
		include: { skill: true },
		orderBy: { sortOrder: "asc" },
	});
}
