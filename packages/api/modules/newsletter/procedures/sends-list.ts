import { ORPCError } from "@orpc/server";
import { countNewsletterSends, db, listNewsletterSends } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const listSendsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			limit: z
				.union([z.literal(15), z.literal(50), z.literal(100)])
				.default(15),
			offset: z.number().int().min(0).default(0),
			status: z.enum(["all", "sent", "failed", "skipped"]).default("all"),
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
			listNewsletterSends(input.projectId, {
				limit: input.limit,
				offset: input.offset,
				status: input.status,
			}),
			countNewsletterSends(input.projectId, input.status),
		]);
		return { sends, total };
	});
