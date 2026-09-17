import { ORPCError } from "@orpc/client";
import { updatePublishingTopicSummary } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

/**
 * Edit a topic's SUMMARY (`pitch`) — the paragraph the Topic Item Page shows
 * under the title, and the text every generation prompt is given.
 *
 * The TITLE is deliberately out of scope. `dedupeKey` is derived from it and
 * backs `@@unique([projectId, dedupeKey])`, so a rename needs the key
 * recomputed and the resulting collision handled — different work from editing
 * free text, and not something to smuggle in behind this route.
 *
 * Writes `pitchUpdatedAt` alongside the summary so an analysis generated before
 * the edit can be shown as predating it. See the query helper for why clearing
 * the summary stamps the time too.
 *
 * No companion read procedure: `getTopic` returns the query layer's topic
 * straight through, and the page already calls it on load.
 */
export const updatePublishingTopicSummaryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/publishing-topics/{topicId}/summary",
		tags: ["Projects", "Publishing Suite"],
		summary: "Edit a publishing topic's summary",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			/** null clears the summary. The 500-char ceiling is the one
			 *  `createTopic` already puts on the description it writes into this
			 *  same column, so a topic cannot be edited into a shape it could
			 *  not have been created in. */
			pitch: z.string().max(500).nullable(),
		}),
	)
	.output(z.object({ saved: z.boolean() }))
	.handler(async ({ input }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);
		// AUTHORIZATION: requireProjectPermission(PUBLISHING_TOPIC_UPDATE) gates
		// project access. The DB helper re-scopes the write to
		// { id: topicId, projectId } and writes no tenant columns, so
		// `input.organizationId` is an F2 client-org shape guard ONLY — it is
		// never read here and never stamped on the row. Tenancy comes from the
		// project, exactly as it does for `updateTopicStatus` and
		// `setTopicSnooze`. A topic id from another project matches nothing and
		// leaves as the SAME NOT_FOUND a missing topic produces, so this route
		// cannot be used to probe for topics the caller cannot see.
		const count = await updatePublishingTopicSummary({
			id: input.topicId,
			projectId: input.projectId,
			pitch: input.pitch,
		});
		if (count === 0) {
			throw new ORPCError("NOT_FOUND", { message: "Topic not found" });
		}
		return { saved: true };
	});
