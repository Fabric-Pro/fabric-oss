import { ORPCError } from "@orpc/client";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const getEligibleUsersProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/members/eligible",
		tags: ["Projects", "Members"],
		summary: "Get eligible users for invitation",
		description:
			"Get list of users who can be invited to the project based on multi-tenancy rules",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			search: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify user has access to the project
		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Get project details
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				userId: true,
				organizationId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Get existing members to exclude them
		const existingMembers = await db.projectMember.findMany({
			where: {
				projectId: input.projectId,
				acceptedAt: { not: null },
			},
			select: { userId: true },
		});

		const excludedUserIds = [
			project.userId, // Exclude owner
			...existingMembers.map((m) => m.userId),
		];

		// Build query based on project type
		let eligibleUsers: Array<{
			id: string;
			name: string | null;
			email: string;
			image: string | null;
		}>;

		if (project.organizationId) {
			// Organization project: Only invite users from the same organization
			eligibleUsers = await db.user.findMany({
				where: {
					id: { notIn: excludedUserIds },
					members: {
						some: {
							organizationId: project.organizationId,
						},
					},
					...(input.search
						? {
								OR: [
									{
										name: {
											contains: input.search,
											mode: "insensitive",
										},
									},
									{
										email: {
											contains: input.search,
											mode: "insensitive",
										},
									},
								],
							}
						: {}),
				},
				select: {
					id: true,
					name: true,
					email: true,
					image: true,
				},
				take: 20,
			});
		} else {
			// Personal project: Only invite other personal accounts (users not in any org)
			eligibleUsers = await db.user.findMany({
				where: {
					id: { notIn: excludedUserIds },
					members: { none: {} }, // No organization memberships
					...(input.search
						? {
								OR: [
									{
										name: {
											contains: input.search,
											mode: "insensitive",
										},
									},
									{
										email: {
											contains: input.search,
											mode: "insensitive",
										},
									},
								],
							}
						: {}),
				},
				select: {
					id: true,
					name: true,
					email: true,
					image: true,
				},
				take: 20,
			});
		}

		return { users: eligibleUsers };
	});
