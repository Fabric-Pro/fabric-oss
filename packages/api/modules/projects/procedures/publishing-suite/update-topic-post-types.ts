import { ORPCError } from "@orpc/client";
import { updatePublishingTopicPostTypes } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

export const updatePublishingTopicPostTypesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/publishing-topics/{topicId}/post-types",
		tags: ["Projects", "Publishing Suite"],
		summary: "Set or reset a publishing topic's user post-type override",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			// null = reset to the AI suggestion; [] = explicit clear; a set =
			// override. Enum-checked + capped here; the DB helper dedupes.
			postTypes: z
				.array(
					z.enum([
						"TWEET",
						"BLOG_POST",
						"CASE_STUDY",
						"STAKEHOLDER_EMAIL",
					]),
				)
				.max(4)
				.nullable(),
		}),
	)
	.handler(async ({ input }) => {
		assertPublishingSuiteFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(PUBLISHING_TOPIC_UPDATE) gates
		// project access. The DB helper re-scopes the write to
		// { id: topicId, projectId } and writes no tenant columns.
		const result = await updatePublishingTopicPostTypes({
			id: input.topicId,
			projectId: input.projectId,
			postTypes: input.postTypes,
		});
		if (!result) {
			throw new ORPCError("NOT_FOUND", { message: "Topic not found" });
		}
		return { topic: result.topic };
	});
