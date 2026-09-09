import { ORPCError } from "@orpc/client";
import {
	PUBLISHING_TOPIC_POST_TYPES,
	updatePublishingTopicPostTypes,
} from "@repo/database";
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
			//
			// Both the vocabulary and the cap come from the shared tuple, the
			// same way `update-settings.ts` takes them. They used to be a
			// hand-written enum beside a literal `.max(4)`, and the literal is
			// the half that fails quietly: a fifth post type makes "select
			// every type" a validation error, on a dialog whose whole purpose
			// is choosing several at once, and no type-check can see it.
			postTypes: z
				.array(z.enum(PUBLISHING_TOPIC_POST_TYPES))
				.max(PUBLISHING_TOPIC_POST_TYPES.length)
				.nullable(),
		}),
	)
	.handler(async ({ input }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);
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
