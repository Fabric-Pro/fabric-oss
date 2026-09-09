import { ORPCError } from "@orpc/client";
import { updatePublishingTopicStatus } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { recordTopicStatusOutcome } from "../../lib/publishing-outcome";
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
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);
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

		// Measurement only, and only for the two terminal moves (Fizzy #1851
		// A9). PUBLISHED is the outcome the whole feature exists to produce —
		// counting distinct users over those rows is the nearest measure of
		// "how many people are actually posting" the system can offer.
		await recordTopicStatusOutcome({
			topicId: input.topicId,
			projectId: input.projectId,
			userId: context.user.id,
			status: input.status,
		});

		return { topic: result.topic };
	});
