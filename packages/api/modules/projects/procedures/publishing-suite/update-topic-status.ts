import { ORPCError } from "@orpc/client";
import { updatePublishingTopicStatus } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

export const updatePublishingTopicStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/publishing-topics/{topicId}/status",
		tags: ["Projects", "Publishing Suite"],
		summary: "Update a publishing topic's status",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			status: z.enum([
				"SUGGESTION",
				"SELECTED",
				"IN_PROGRESS",
				"PUBLISHED",
				"DECLINED",
			]),
			declineReason: z.string().nullable().optional(),
			publishedUrl: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertPublishingSuiteFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(PUBLISHING_TOPIC_UPDATE) gates
		// project access. The DB helper re-scopes the write to
		// { id: topicId, projectId } (Task 1), so this carries no P1 risk — it
		// writes no tenant columns.
		const result = await updatePublishingTopicStatus({
			id: input.topicId,
			projectId: input.projectId,
			status: input.status,
			declineReason: input.declineReason,
			publishedUrl: input.publishedUrl,
		});
		if (!result) {
			throw new ORPCError("NOT_FOUND", { message: "Topic not found" });
		}
		return { topic: result.topic };
	});
