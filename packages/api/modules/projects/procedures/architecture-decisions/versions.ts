import { ORPCError } from "@orpc/client";
import {
	db,
	hasProjectAccess,
	listArchitectureDecisionVersions,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const listArchitectureDecisionVersionsProcedure =
	tenantProtectedProcedure
		.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_READ))
		.route({
			method: "GET",
			path: "/projects/{projectId}/architecture-decisions/{architectureDecisionId}/versions",
			tags: ["Projects", "Architecture Decisions", "Versions"],
			summary: "List an architecture decision's version history",
		})
		.input(
			z.object({
				projectId: z.string(),
				architectureDecisionId: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);
			const canAccess = await hasProjectAccess(
				input.projectId,
				context.user.id,
				organizationId,
			);
			if (!canAccess) {
				throw new ORPCError("FORBIDDEN", {
					message: "You don't have access to this project",
				});
			}

			const decision = await db.architectureDecision.findFirst({
				where: {
					id: input.architectureDecisionId,
					projectId: input.projectId,
				},
				select: { id: true },
			});
			if (!decision) {
				throw new ORPCError("NOT_FOUND", {
					message: "Architecture decision not found",
				});
			}

			const versions = await listArchitectureDecisionVersions({
				architectureDecisionId: input.architectureDecisionId,
			});
			return { versions };
		});
