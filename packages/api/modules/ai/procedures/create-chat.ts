import { ORPCError } from "@orpc/client";
import { createAiChat, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const createChat = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "POST",
		path: "/ai/chats",
		tags: ["AI"],
		summary: "Create chat",
		description: "Create a new chat",
	})
	.input(
		z.object({
			title: z.string().optional(),
			organizationId: z.string().nullable().optional(),
			projectId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { title, organizationId: inputOrgId, projectId } = input;
		const user = context.user;
		const organizationId = resolveOrganizationId(
			inputOrgId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN");
			}
		}

		if (projectId) {
			const canAccess = await hasProjectAccess(
				projectId,
				user.id,
				organizationId,
			);
			if (!canAccess) {
				throw new ORPCError("FORBIDDEN");
			}
		}

		const chat = await createAiChat({
			title: title,
			organizationId,
			userId: user.id,
			projectId,
		});

		if (!chat) {
			throw new ORPCError("INTERNAL_SERVER_ERROR");
		}

		return { chat };
	});
