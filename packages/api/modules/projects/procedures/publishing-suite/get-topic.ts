import { ORPCError } from "@orpc/client";
import { getPublishingTopic } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

/**
 * Read ONE publishing topic for the Topic Item Page (Fizzy #1851, Phase 2A-1).
 *
 * Returns the same enriched shape `listTopics` returns for the same topic, so
 * the page's header and the Inbox row render from one contract.
 */
export const getPublishingTopicProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/publishing-topics/{topicId}",
		tags: ["Projects", "Publishing Suite"],
		summary: "Get a publishing topic",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertPublishingSuiteFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(PUBLISHING_TOPIC_READ) gates
		// project access. The DB helper re-scopes the read to
		// { id: topicId, projectId }, so a topic id belonging to another
		// project resolves to null here and leaves as the SAME NOT_FOUND a
		// missing topic produces — this endpoint cannot be used to probe for
		// the existence of topics in projects the caller cannot see (DV16).
		const result = await getPublishingTopic({
			id: input.topicId,
			projectId: input.projectId,
			viewerUserId: context.user.id,
		});
		if (!result) {
			throw new ORPCError("NOT_FOUND", { message: "Topic not found" });
		}
		return { topic: result.topic };
	});
