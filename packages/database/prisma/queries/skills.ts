/**
 * Skill Catalog Database Queries
 *
 * CRUD operations for the skill catalog and template-skill associations.
 * Skills are reusable behavior modules that can be attached to agent templates
 * and materialized as AgentMemoryFile entries on instance creation.
 */

import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
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

/** Organization contexts never include the legacy USER/null namespace. Drafts are owner-private. */
export function skillVisibilityWhere(
	actor: { userId?: string; organizationId?: string | null },
	includeArchived = false,
): Prisma.SkillWhereInput {
	const visible: Prisma.SkillWhereInput[] = [
		{
			scope: "SYSTEM",
			userId: null,
			organizationId: null,
			isPublished: true,
			archivedAt: null,
		},
	];
	if (actor.organizationId) {
		visible.push({
			scope: "ORGANIZATION",
			organizationId: actor.organizationId,
			...(!includeArchived ? { archivedAt: null } : {}),
			OR: [
				...(actor.userId ? [{ userId: actor.userId }] : []),
				{ isPublished: true, archivedAt: null },
			],
		});
	}
	return { OR: visible };
}
/** Live permission floors also apply to background source reads. */
export async function assertSkillReadAccess(
	actor: {
		userId?: string;
		organizationId?: string | null;
	},
	client: Prisma.TransactionClient = db,
) {
	if (!actor.userId || !actor.organizationId) {
		throw new Error("Current organization skill access is required.");
	}
	const member = await client.member.findFirst({
		where: {
			userId: actor.userId,
			organizationId: actor.organizationId,
			organization: { deletedAt: null },
		},
		select: { role: true },
	});
	if (
		!member ||
		!hasPermission(
			resolveOrgPermissions(member.role),
			Permissions.SKILL_READ,
		)
	) {
		throw new Error("Current skill access is unavailable.");
	}
}
export async function listSkills(
	params: ListSkillsParams,
): Promise<{ skills: Skill[]; total: number }> {
	if (params.organizationId) {
		await assertSkillReadAccess(params);
	}
	const where: Prisma.SkillWhereInput = {
		AND: [skillVisibilityWhere(params)],
		isPublished: params.isPublished ?? true,
		...(params.scope ? { scope: params.scope } : {}),
		...(params.category ? { category: params.category } : {}),
		...(params.tags?.length ? { tags: { hasSome: params.tags } } : {}),
	};
	if (params.search) {
		(where.AND as Prisma.SkillWhereInput[]).push({
			OR: [
				{ name: { contains: params.search, mode: "insensitive" } },
				{ slug: { contains: params.search, mode: "insensitive" } },
				{
					description: {
						contains: params.search,
						mode: "insensitive",
					},
				},
			],
		});
	}
	const [skills, total] = await Promise.all([
		db.skill.findMany({
			where,
			orderBy: [
				{ [params.sortBy ?? "updatedAt"]: params.sortOrder ?? "desc" },
				{ id: "asc" },
			],
			skip: params.offset ?? 0,
			take: Math.min(params.limit ?? 50, 100),
		}),
		db.skill.count({ where }),
	]);
	if (params.organizationId) {
		await assertSkillReadAccess(params);
	}
	return { skills, total };
}
export async function getSkill(
	idOrSlug: string,
	actor: { userId?: string; organizationId?: string | null } = {},
): Promise<Skill | null> {
	if (actor.organizationId) {
		await assertSkillReadAccess(actor);
	}
	return db.skill.findFirst({
		where: {
			AND: [
				skillVisibilityWhere(actor),
				{ OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
			],
		},
	});
}
export async function getSkillById(
	id: string,
	actor: { userId?: string; organizationId?: string | null },
	client: Prisma.TransactionClient = db,
): Promise<Skill | null> {
	if (actor.organizationId) {
		await assertSkillReadAccess(actor, client);
	}
	return client.skill.findFirst({
		where: { id, AND: [skillVisibilityWhere(actor)] },
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
	actor: { userId?: string; organizationId?: string | null } = {},
): Promise<(AgentTemplateSkill & { skill: Skill })[]> {
	if (actor.organizationId) {
		await assertSkillReadAccess(actor);
	}
	return db.agentTemplateSkill.findMany({
		where: { templateId, skill: { is: skillVisibilityWhere(actor) } },
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
	actor: { userId?: string; organizationId?: string | null } = {},
): Promise<(ReportTemplateSkill & { skill: Skill })[]> {
	if (actor.organizationId) {
		await assertSkillReadAccess(actor);
	}
	return db.reportTemplateSkill.findMany({
		where: { templateId, skill: { is: skillVisibilityWhere(actor) } },
		include: { skill: true },
		orderBy: { sortOrder: "asc" },
	});
}

/** Pinned instructions confer no authority after publication/source access changes. */
export async function assertPinnedSkillAccess(
	actor: { userId: string; organizationId?: string | null },
	skills: ReadonlyArray<{
		id: string;
		version: number;
		name: string;
		content: string;
	}>,
	client: Prisma.TransactionClient = db,
) {
	if (!skills.length) {
		return;
	}
	if (
		skills.length > 32 ||
		new Set(skills.map((s) => s.id)).size !== skills.length
	) {
		throw new Error("Invalid pinned skill selection.");
	}
	await assertSkillReadAccess(actor, client);
	// Compare exact source bytes inside SQL; never load a newly enlarged or changed body.
	const current = await client.skill.findMany({
		where: {
			AND: [
				skillVisibilityWhere(actor),
				{
					OR: skills.map(({ id, version, name, content }) => ({
						id,
						version,
						name,
						content,
					})),
				},
			],
		},
		select: { id: true },
	});
	await assertSkillReadAccess(actor, client);
	if (current.length !== skills.length) {
		throw new Error(
			"A selected skill is unavailable or changed. Refresh its attachment and start a new run.",
		);
	}
}
