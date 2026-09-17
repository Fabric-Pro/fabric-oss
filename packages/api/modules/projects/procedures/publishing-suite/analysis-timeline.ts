import { listAnalysisTimeline } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

/**
 * A topic's Planning & Analysis history as ONE dense sequence — AI runs and
 * hand-saved revisions interleaved, numbered 1..N together.
 *
 * Replaces a display that carried two independent counters, where a first
 * manual save after six AI runs read as "Version 1 · AI v6". The unified number
 * is computed at read time from rows that already exist, so nothing was
 * renumbered and nothing was backfilled — see `listAnalysisTimeline`'s own
 * docblock for why renumbering is unsafe here and why allocating the next
 * number across both tables is the shortcut to resist.
 *
 * `seq` IS DISPLAY ONLY. It is deliberately not accepted by any write in this
 * directory: `saveAnalysisRevision` still takes the stored `expectedVersion`
 * and the stored `sourceAnalysisVersion`, both of which ride in this response
 * under their own names so a caller reaching for a write token finds the real
 * one.
 *
 * READ-PERMISSIVE, matching `listAnalysisRevisionsProcedure`: no
 * `requireEligibleProjectForTopic()` ratchet. That check also filters on
 * `status: "ACTIVE", deletedAt: null`, which is right for a write but wrong for
 * a read — it would 404 this history on an archived project while the tab's own
 * current-state read kept rendering, leaving the page's panels disagreeing
 * about whether the project exists. The scoping that matters for isolation,
 * `{ topicId, projectId }` inside the query, stays.
 */
export const listAnalysisTimelineProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/publishing-topics/{topicId}/analysis-timeline",
		tags: ["Projects", "Publishing Suite"],
		summary: "List a topic's unified planning analysis version timeline",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			/**
			 * The lowest `seq` the caller already holds; the next page is
			 * strictly below it. A position in an ordering, not a claim about a
			 * row — an unknown value yields an empty page rather than an error,
			 * because rejecting it would let a caller probe which entries exist.
			 */
			cursor: z.number().int().positive().optional(),
			/** Page size. The query clamps too, for non-oRPC callers. */
			limit: z.number().int().min(1).max(100).optional(),
		}),
	)
	.handler(async ({ input }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		// AUTHORIZATION: requireProjectPermission(PUBLISHING_TOPIC_READ) gates
		// project access; `input.organizationId` is an F2 client-org shape guard
		// that is never read here and never stamped — this procedure writes
		// nothing at all.
		const { entries, nextCursor } = await listAnalysisTimeline({
			topicId: input.topicId,
			projectId: input.projectId,
			cursor: input.cursor,
			limit: input.limit,
		});

		// `nextCursor` is part of the contract even when null, so a client can
		// tell "no more pages" from "this server does not page" without
		// inspecting the row count against a limit it may not have sent.
		return { entries, nextCursor };
	});
