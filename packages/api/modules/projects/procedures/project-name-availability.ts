import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const checkProjectNameProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "GET",
		path: "/projects/check-name",
		tags: ["Projects"],
		summary: "Check project name availability",
		description:
			"Returns whether a project name is available within the current tenant context. Uses the same uniqueness rules as project creation.",
	})
	.input(
		z.object({
			name: z.string().min(1).max(255),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Mirror the exact tenant filter used in create-project:
		// org context  → all projects in the org (any owner)
		// personal ctx → only this user's own personal projects
		const tenantFilter = organizationId
			? { organizationId }
			: { organizationId: null, userId: context.user.id };

		const duplicate = await db.project.findFirst({
			where: {
				...tenantFilter,
				name: { equals: input.name.trim(), mode: "insensitive" },
				status: { not: "DRAFT" },
				deletedAt: null,
			},
			select: { id: true },
		});

		return { available: !duplicate };
	});
