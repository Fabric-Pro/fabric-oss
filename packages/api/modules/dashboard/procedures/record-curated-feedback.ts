import { ORPCError } from "@orpc/client";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	curatedFeedbackInputSchema,
	recordCuratedFeedbackCommand,
} from "../lib/curated-feedback-commands";

export const recordDashboardCuratedFeedback = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.DASHBOARD_READ))
	.route({
		method: "POST",
		path: "/dashboard/curated-feedback",
		tags: ["Dashboard"],
		summary: "Record Curated for you feedback",
		description:
			"Record a click, pin, unpin, dismissal or restoration for the current user.",
	})
	.input(
		curatedFeedbackInputSchema.extend({
			organizationId: z.string().nullable().optional(),
		}),
	)
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
		return recordCuratedFeedbackCommand(
			{ userId: context.user.id, organizationId },
			input,
		);
	});
