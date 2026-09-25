import { ORPCError } from "@orpc/client";
import { updatePublishingTopicStatus } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { runInBackground } from "../../../weave/lib/run-in-background";
import { autoStartPlanningAnalysis } from "../../lib/publishing-analysis-autostart";
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

		// Selecting a topic starts its analysis once the status write has
		// resolved (a failed or not-found write throws above and schedules
		// nothing), so it is usually running before anybody opens the page. Not
		// awaited: the response is the user's status change, and the start is
		// database and Temporal round trips that held "Saving…" on screen (Fizzy
		// #2651). Not a bare `void`: on Vercel a floating promise is not
		// guaranteed to finish once the response is sent — `runInBackground`
		// keeps the invocation alive and logs a rejection. The helper itself
		// never rejects; it logs its own failures.
		if (input.status === "SELECTED") {
			runInBackground(
				autoStartPlanningAnalysis({
					projectId: input.projectId,
					topicId: input.topicId,
					requestedById: context.user.id,
				}),
			);
		}

		return { topic: result.topic };
	});
