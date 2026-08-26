import { getProjectUsageRecent } from "@repo/database";
import { z } from "zod";
import {
	projectScopeSchema,
	projectUsageProcedure,
	USAGE_ROUTE_TAGS,
} from "./shared";

export const listRecentUsageProcedure = projectUsageProcedure
	.route({
		method: "GET",
		path: "/projects/{projectId}/usage/recent",
		tags: [...USAGE_ROUTE_TAGS],
		summary: "List recent AI calls for a project",
		description:
			"Paginated list of recent AI usage log entries attributed to this project.",
	})
	.input(
		projectScopeSchema.extend({
			limit: z.number().int().min(1).max(100).default(25),
			cursor: z.string().optional(),
		}),
	)
	.handler(async ({ input }) => {
		return getProjectUsageRecent({
			projectId: input.projectId,
			limit: input.limit,
			cursor: input.cursor,
		});
	});
