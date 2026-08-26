import { ORPCError } from "@orpc/server";
import {
	countNewsletterSendsForMembers,
	db,
	listNewsletterSendsForMembers,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const memberListSendsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			limit: z
				.union([z.literal(15), z.literal(50), z.literal(100)])
				.default(15),
			offset: z.number().int().min(0).default(0),
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
			select: { id: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		const [sends, total] = await Promise.all([
			listNewsletterSendsForMembers(input.projectId, {
				limit: input.limit,
				offset: input.offset,
			}),
			countNewsletterSendsForMembers(input.projectId),
		]);
		return { sends, total };
	});
