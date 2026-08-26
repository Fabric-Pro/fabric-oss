import { ORPCError } from "@orpc/client";
import { db, getProjectMemberRole, ProjectMemberRole } from "@repo/database";
import { ProjectMemberRoleSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const updateMemberRoleProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/members/:userId/role",
		tags: ["Projects", "Members"],
		summary: "Update member role",
		description: "Update a project member's role",
	})
	.input(
		z.object({
			projectId: z.string(),
			userId: z.string(),
			role: ProjectMemberRoleSchema,
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// Authorization (PROJECT_MEMBERS_MANAGE — OWNER and PROJECT_ADMIN)
		// is enforced by `requireProjectPermission` above. In addition, only
		// OWNERs may grant the OWNER role or modify an existing OWNER —
		// otherwise PROJECT_ADMIN could self-escalate.
		const actorRole = await getProjectMemberRole(
			input.projectId,
			context.user.id,
		);
		// Capture the existing member row up-front so we can both validate
		// owner-modification guards AND record the from-role on the audit row.
		// `ProjectMember` has no Prisma back-relation to `User`, so fetch the
		// email separately.
		const target = await db.projectMember.findUnique({
			where: {
				projectId_userId: {
					projectId: input.projectId,
					userId: input.userId,
				},
			},
			select: { role: true, userId: true },
		});
		const targetUser = target
			? await db.user.findUnique({
					where: { id: target.userId },
					select: { email: true },
				})
			: null;
		if (actorRole !== ProjectMemberRole.OWNER) {
			if (input.role === ProjectMemberRole.OWNER) {
				throw new ORPCError("FORBIDDEN", {
					message: "Only project owners can grant the OWNER role",
				});
			}
			if (target?.role === ProjectMemberRole.OWNER) {
				throw new ORPCError("FORBIDDEN", {
					message: "Only project owners can modify another owner",
				});
			}
		}

		// Cannot change the role of the original project creator (they are the permanent owner)
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { userId: true },
		});
		if (project?.userId === input.userId) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Cannot change the role of the original project creator",
			});
		}

		// Update the member's role
		const member = await db.projectMember.updateMany({
			where: {
				projectId: input.projectId,
				userId: input.userId,
				acceptedAt: { not: null }, // Only update accepted members
			},
			data: {
				role: input.role,
			},
		});

		if (member.count === 0) {
			throw new ORPCError("NOT_FOUND", {
				message: "Member not found or invitation not accepted",
			});
		}

		// Audit-log emission. Resource is the affected member —
		// not the actor — so deployment admins reviewing a role-change can
		// identify who was promoted/demoted at a glance.
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		recordAuditFromRequest(context, {
			action: "project.member.role_changed",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "user",
				id: input.userId,
				name: targetUser?.email ?? null,
			},
			metadata: {
				fromRole: target?.role ?? null,
				toRole: input.role,
			},
		});

		return { success: true };
	});
