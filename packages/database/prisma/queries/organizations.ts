import type { z } from "zod";
import { db, Prisma } from "../client";
import type { OrganizationSchema } from "../zod";

export interface OrganizationListFilter {
	query?: string;
	status?: "active" | "deactivated" | "all";
}

function organizationWhere({
	query,
	status = "active",
}: OrganizationListFilter) {
	return {
		name: { contains: query, mode: "insensitive" as const },
		...(status === "all"
			? {}
			: { deletedAt: status === "active" ? null : { not: null } }),
	};
}

export async function getOrganizations({
	limit,
	offset,
	query,
	status = "active",
	sort = "createdAt",
	direction = "desc",
}: OrganizationListFilter & {
	limit: number;
	offset: number;
	sort?: "name" | "members" | "projects" | "createdAt";
	direction?: "asc" | "desc";
}) {
	const order = {
		name: Prisma.sql`o.name`,
		members: Prisma.sql`"membersCount"`,
		projects: Prisma.sql`"projectsCount"`,
		createdAt: Prisma.sql`o."createdAt"`,
	}[sort];
	const ordering = direction === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
	return db.$queryRaw<
		Array<{
			id: string;
			name: string;
			logo: string | null;
			slug: string;
			createdAt: Date;
			deletedAt: Date | null;
			scheduledPermanentDeleteAt: Date | null;
			membersCount: number;
			projectsCount: number;
		}>
	>(Prisma.sql`
 SELECT o.id, o.name, o.logo, o.slug, o."createdAt", o."deletedAt", o."scheduledPermanentDeleteAt",
 (SELECT count(*)::int FROM member m WHERE m."organizationId" = o.id) AS "membersCount",
 (SELECT count(*)::int FROM project p WHERE p."organizationId" = o.id AND p."deletedAt" IS NULL) AS "projectsCount"
 FROM organization o
 WHERE ${status === "all" ? Prisma.sql`TRUE` : status === "active" ? Prisma.sql`o."deletedAt" IS NULL` : Prisma.sql`o."deletedAt" IS NOT NULL`}
 AND o.name ILIKE ${`%${query ?? ""}%`}
 ORDER BY ${order} ${ordering}, o.id ASC
 LIMIT ${limit} OFFSET ${offset}
 `);
}

export async function countAllOrganizations(
	filter: OrganizationListFilter = {},
) {
	return db.organization.count({ where: organizationWhere(filter) });
}

export async function getOrganizationById(id: string) {
	return db.organization.findUnique({
		where: { id },
		include: {
			members: true,
			invitations: true,
		},
	});
}

export async function getInvitationById(id: string) {
	return db.invitation.findUnique({
		where: { id },
		include: {
			organization: true,
		},
	});
}

export async function getOrganizationBySlug(slug: string) {
	return db.organization.findUnique({
		where: { slug },
	});
}

export async function getOrganizationMembership(
	organizationId: string,
	userId: string,
) {
	return db.member.findUnique({
		where: {
			organizationId_userId: {
				organizationId,
				userId,
			},
		},
		include: {
			organization: true,
		},
	});
}

export async function getOrganizationWithPurchasesAndMembersCount(
	organizationId: string,
) {
	const organization = await db.organization.findUnique({
		where: {
			id: organizationId,
		},
		include: {
			purchases: true,
			_count: {
				select: {
					members: true,
				},
			},
		},
	});

	return organization
		? {
				...organization,
				membersCount: organization._count.members,
			}
		: null;
}

export async function getPendingInvitationByEmail(email: string) {
	const normalized = email.trim().toLowerCase();
	return db.invitation.findFirst({
		where: {
			email: normalized,
			status: "pending",
			expiresAt: { gt: new Date() },
		},
	});
}

export async function updateOrganization(
	organization: Partial<z.infer<typeof OrganizationSchema>> & { id: string },
) {
	return db.organization.update({
		where: {
			id: organization.id,
		},
		data: organization,
	});
}
