import { ORPCError } from "@orpc/client";
import { getAiUsageActivityFacets } from "@repo/database";
import { z } from "zod";
import {
	requireOrganizationAdmin,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	periodDays: z.number().int().min(1).max(365).optional(),
	from: z.coerce.date().optional(),
	to: z.coerce.date().optional(),
});

export const getAiActivityFacets = tenantProtectedProcedure
	// Visibility-only — org access gated to owners/admins inside handler.
	.route({
		method: "GET",
		path: "/payments/ai-activity-facets",
		tags: ["Payments"],
		summary: "Get distinct models and projects for AI activity filters",
	})
	.input(inputSchema)
	.handler(
		async ({
			input: { organizationId, periodDays, from, to },
			context: { user },
		}) => {
			if (organizationId) {
				await requireOrganizationAdmin(organizationId, user.id).catch(
					() => {
						throw new ORPCError("FORBIDDEN", {
							message:
								"Only organization owners or admins can view organization AI activity",
						});
					},
				);

				return await getAiUsageActivityFacets({
					organizationId,
					periodDays,
					from,
					to,
				});
			}

			return await getAiUsageActivityFacets({
				userId: user.id,
				periodDays,
				from,
				to,
			});
		},
	);
