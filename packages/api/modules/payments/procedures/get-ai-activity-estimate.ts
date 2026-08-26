import { ORPCError } from "@orpc/client";
import { getMedianAiUsageByTaskType } from "@repo/database";
import { z } from "zod";
import {
	requireOrganizationAdmin,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const taskTypeEnum = z.enum([
	"SIMPLE",
	"COMPLEX",
	"REASONING",
	"CHAT",
	"TOOL_CALLING",
	"EMBEDDING",
	"IMAGE",
	"AUDIO",
	"EVAL",
]);

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	taskType: taskTypeEnum,
});

export const getAiActivityEstimate = tenantProtectedProcedure
	// Visibility-only — org access gated to owners/admins inside handler.
	.route({
		method: "GET",
		path: "/payments/ai-activity-estimate",
		tags: ["Payments"],
		summary: "Get AI activity median estimate",
		description:
			"Returns the median tokens/latency/cost for the tenant's recent runs of the given task type",
	})
	.input(inputSchema)
	.handler(
		async ({ input: { organizationId, taskType }, context: { user } }) => {
			if (organizationId) {
				await requireOrganizationAdmin(organizationId, user.id).catch(
					() => {
						throw new ORPCError("FORBIDDEN", {
							message:
								"Only organization owners or admins can view organization AI estimates",
						});
					},
				);

				const estimate = await getMedianAiUsageByTaskType({
					organizationId,
					taskType,
				});
				return { estimate };
			}

			const estimate = await getMedianAiUsageByTaskType({
				userId: user.id,
				taskType,
			});
			return { estimate };
		},
	);
