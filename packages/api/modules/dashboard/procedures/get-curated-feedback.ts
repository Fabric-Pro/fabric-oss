import { ORPCError } from "@orpc/client";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { listCuratedFeedbackCommand } from "../lib/curated-feedback-commands";

export const getDashboardCuratedFeedback = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.DASHBOARD_READ))
	.route({
		method: "GET",
		path: "/dashboard/curated-feedback",
		tags: ["Dashboard"],
		summary: "Get Curated for you feedback",
		description:
			"Get the current user's pins, dismissals and click signals.",
	})
	.input(z.object({ organizationId: z.string().nullable().optional() }))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "An organization context is required",
			});
		}
		return listCuratedFeedbackCommand({
			userId: context.user.id,
			organizationId,
		});
	});
