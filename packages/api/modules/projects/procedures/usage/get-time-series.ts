import { getProjectUsageTimeSeries } from "@repo/database";
import { z } from "zod";
import {
	projectScopeSchema,
	projectUsageProcedure,
	USAGE_ROUTE_TAGS,
	usageRangeSchema,
} from "./shared";

export const getUsageTimeSeriesProcedure = projectUsageProcedure
	.route({
		method: "GET",
		path: "/projects/{projectId}/usage/time-series",
		tags: [...USAGE_ROUTE_TAGS],
		summary: "Get project AI usage time series",
		description:
			"Daily or weekly buckets of cost and tokens for a project.",
	})
	.input(
		projectScopeSchema.extend({
			range: usageRangeSchema,
			bucket: z.enum(["day", "week"]).default("day"),
		}),
	)
	.handler(async ({ input }) => {
		return getProjectUsageTimeSeries({
			projectId: input.projectId,
			range: input.range,
			bucket: input.bucket,
		});
	});
