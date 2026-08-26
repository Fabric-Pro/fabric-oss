import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Bulk soft-delete multiple projects
 *
 * AUTHORIZATION: Only projects the user OWNS can be deleted.
 * Non-owner projects in the selection are silently skipped.
 */
export const bulkDeleteProjectsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_DELETE))
	.route({
		method: "POST",
		path: "/projects/bulk-delete",
		tags: ["Projects"],
		summary: "Bulk soft-delete projects",
		description:
			"Soft-delete multiple projects at once. Only projects the user owns will be deleted; others are skipped.",
	})
	.input(
		z.object({
			ids: z.array(z.string()).min(1).max(100),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// For org context, verify the caller is still an active org member
		// (mirrors the check in getProjectRole() for single-project paths)
		if (organizationId) {
			const orgMembership = await db.member.findFirst({
				where: { organizationId, userId },
				select: { id: true },
			});
			if (!orgMembership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		const orgFilter = organizationId
			? { organizationId }
			: { organizationId: null };

		// Find all projects in the selection that this user owns
		// (original creator OR promoted owner via ProjectMember)
		const owned = await db.project.findMany({
			where: {
				id: { in: input.ids },
				deletedAt: null,
				...orgFilter,
				OR: [
					{ userId },
					{
						members: {
							some: {
								userId,
								role: "OWNER",
								acceptedAt: { not: null },
								OR: [
									{ expiresAt: null },
									{ expiresAt: { gt: new Date() } },
								],
							},
						},
					},
				],
			},
			select: { id: true },
		});

		if (owned.length === 0) {
			throw new ORPCError("FORBIDDEN", {
				message: "None of the selected projects could be deleted",
			});
		}

		const ownedIds = owned.map((p) => p.id);
		const now = new Date();
		const scheduledDeletion = new Date(
			now.getTime() + 7 * 24 * 60 * 60 * 1000,
		);

		await db.project.updateMany({
			where: { id: { in: ownedIds } },
			data: {
				deletedAt: now,
				deletedBy: userId,
				scheduledPermanentDeleteAt: scheduledDeletion,
			},
		});

		return {
			deletedCount: ownedIds.length,
			skippedCount: input.ids.length - ownedIds.length,
		};
	});
