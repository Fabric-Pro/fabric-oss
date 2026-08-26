import { listPublishingTopics } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

export const listPublishingTopicsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/publishing-topics",
		tags: ["Projects", "Publishing Suite"],
		summary: "List publishing topics",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			status: z
				.enum([
					"SUGGESTION",
					"SELECTED",
					"IN_PROGRESS",
					"PUBLISHED",
					"DECLINED",
				])
				.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertPublishingSuiteFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(PUBLISHING_TOPIC_READ) gates
		// project access; results are scoped to the project by the query layer.
		const { items } = await listPublishingTopics({
			projectId: input.projectId,
			status: input.status,
			viewerUserId: context.user.id,
		});

		return { items };
	});
