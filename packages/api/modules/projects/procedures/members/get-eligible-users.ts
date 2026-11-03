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
	// Lists colleagues' email addresses, so it needs the permission that can act
	// on them: reading a project's members must not expose the whole organization.
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE))
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

		// Everyone `canInviteUser` would refuse: offering them only ends in an
		// error once they are picked.
		const [existingMembers, pendingInvitations] = await Promise.all([
			db.projectMember.findMany({
				where: { projectId: input.projectId },
				select: { userId: true },
			}),
			db.projectInvitation.findMany({
				where: {
					projectId: input.projectId,
					status: "PENDING",
					expiresAt: { gt: new Date() },
				},
				select: { email: true },
			}),
		]);

		const excludedUserIds = [
			project.userId, // Exclude owner
			...existingMembers.map((m) => m.userId),
		];
		const excludedEmails = pendingInvitations.map(
			(invitation) => invitation.email,
		);

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
					email: { notIn: excludedEmails },
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
					email: { notIn: excludedEmails },
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
