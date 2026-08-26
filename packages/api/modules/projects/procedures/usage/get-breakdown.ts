import { getProjectUsageBreakdown } from "@repo/database";
import { z } from "zod";
import {
	projectScopeSchema,
	projectUsageProcedure,
	USAGE_ROUTE_TAGS,
	usageRangeSchema,
} from "./shared";

export const getUsageBreakdownProcedure = projectUsageProcedure
	.route({
		method: "GET",
		path: "/projects/{projectId}/usage/breakdown",
		tags: [...USAGE_ROUTE_TAGS],
		summary: "Get project AI usage breakdown",
		description:
			"Group usage by model, provider, taskType, agentId, or billingCategory.",
	})
	.input(
		projectScopeSchema.extend({
			range: usageRangeSchema,
			groupBy: z
				.enum([
					"model",
					"provider",
					"taskType",
					"agentId",
					"billingCategory",
				])
				.default("model"),
		}),
	)
	.handler(async ({ input }) => {
		return getProjectUsageBreakdown({
			projectId: input.projectId,
			range: input.range,
			groupBy: input.groupBy,
		});
	});
