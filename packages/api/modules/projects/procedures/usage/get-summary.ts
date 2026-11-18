import { getProjectUsageSummary } from "@repo/database";
import {
	hiddenUsageFeatureKey,
	projectScopeSchema,
	projectUsageProcedure,
	USAGE_ROUTE_TAGS,
	usageRangeSchema,
} from "./shared";

export const getUsageSummaryProcedure = projectUsageProcedure
	.route({
		method: "GET",
		path: "/projects/{projectId}/usage/summary",
		tags: [...USAGE_ROUTE_TAGS],
		summary: "Get project AI usage summary",
		description:
			"Returns totals (cost, tokens, calls) and a breakdown by billing category for a project.",
	})
	.input(projectScopeSchema.extend({ range: usageRangeSchema }))
	.handler(async ({ input, context }) => {
		return getProjectUsageSummary({
			projectId: input.projectId,
			range: input.range,
			hiddenFeatureKey: await hiddenUsageFeatureKey(
				input.projectId,
				context.user.id,
			),
		});
	});
