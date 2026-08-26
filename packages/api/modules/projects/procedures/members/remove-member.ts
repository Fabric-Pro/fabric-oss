import {
	db,
	disconnectIntegrationsForUser,
	logRepoIntegrationActivity,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const removeMemberProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE))
	.route({
		method: "DELETE",
		path: "/projects/:projectId/members/:userId",
		tags: ["Projects", "Members"],
		summary: "Remove member from project",
		description:
			"Remove a member from a project. This immediately revokes their access to the project and all its resources.",
	})
	.input(
		z.object({
			projectId: z.string(),
			userId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Authorization (PROJECT_MEMBERS_MANAGE — OWNER and PROJECT_ADMIN)
		// is enforced by `requireProjectPermission` above.

		// Capture the affected member's email BEFORE the delete fires so the
		// audit row preserves a `resourceName` snapshot (D11). The Prisma
		// model `ProjectMember` has no `user` back-relation (see
		// `packages/database/prisma/schema.prisma`); we read the user row
		// separately. Both queries are best-effort — missing rows still let
		// the delete proceed.
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

		// Remove the member
		// This will cascade delete any project-specific permissions
		// Access to RAG data is controlled by hasProjectAccess() which checks membership
		await db.projectMember.deleteMany({
			where: {
				projectId: input.projectId,
				userId: input.userId,
			},
		});

		// Disconnect any repository integrations configured by the removed user.
		// Sets configuredByUserId to null and status to DISCONNECTED.
		const disconnectedResult = await disconnectIntegrationsForUser(
			input.projectId,
			input.userId,
		);

		if (disconnectedResult.count > 0) {
			await logRepoIntegrationActivity({
				projectId: input.projectId,
				userId: user.id,
				userName: user.name || "Unknown",
				organizationId,
				activityType: "repo_integration_disconnected",
				metadata: {
					reason: "configured_user_removed",
					removedUserId: input.userId,
					integrationsAffected: disconnectedResult.count,
				},
			});
		}

		// Audit-log emission. Snapshot of the removed user's role
		// and email is captured pre-delete above.
		recordAuditFromRequest(context, {
			action: "project.member.removed",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "user",
				id: input.userId,
				name: targetUser?.email ?? null,
			},
			metadata: {
				previousRole: target?.role ?? null,
				integrationsDisconnected: disconnectedResult.count,
			},
		});

		return { success: true };
	});
