/**
 * Get Weave Config Procedure
 */

import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requireProjectPermission,
	resolveOrganizationIdForCaller,
} from "../../../orpc/procedures";

const GetConfigInputSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const getConfigProcedure = protectedProcedure
	.use(requireProjectPermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/weave/config/:projectId",
		tags: ["Weave"],
		summary: "Get project weave configuration",
	})
	.input(GetConfigInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			userId,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			userId,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const config = await db.projectWeaveConfig.findUnique({
			where: { projectId: input.projectId },
		});

		return config;
	});
