import { ORPCError } from "@orpc/server";
import { addNewsletterSubscriber, db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const addSubscribersProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			emails: z.array(z.string().email()).min(1).max(200),
			name: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const project = await db.project.findFirst({
			where: organizationId
				? { id: input.projectId, organizationId }
				: {
						id: input.projectId,
						organizationId: null,
						userId: context.user.id,
					},
			select: { id: true, organizationId: true, userId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const unique = Array.from(
			new Set(input.emails.map((e) => e.trim().toLowerCase())),
		);
		let added = 0;
		for (const email of unique) {
			await addNewsletterSubscriber({
				projectId: input.projectId,
				email,
				name: input.name ?? null,
				userId: project.organizationId ? null : project.userId,
				organizationId: project.organizationId ?? null,
				createdByUserId: context.user.id,
			});
			added += 1;
		}
		return { added };
	});
