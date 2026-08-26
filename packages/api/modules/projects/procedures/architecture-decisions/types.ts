import { ORPCError } from "@orpc/client";
import { hasProjectAccess, listDecisionTypes } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Per-project decision-type taxonomy, read side. Types are minted by the
 * save path when a suggested or hand-typed new label is applied — there is no
 * standalone create endpoint, so nothing ships without a consumer.
 */
export const listDecisionTypesProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ARCHITECTURE_DECISION_READ))
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/decision-types",
		tags: ["Projects", "Architecture Decisions"],
		summary: "List the project's decision types",
	})
	.input(
		z.object({
			projectId: z.string(),
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

		const types = await listDecisionTypes({ projectId: input.projectId });
		return { types };
	});
