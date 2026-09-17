import { listDraftTimeline } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

/**
 * A topic's draft history for one content type as ONE dense sequence —
 * generated runs, hand edits and restores numbered together.
 *
 * The sibling of `listAnalysisTimeline` one level down. Before this, a hand
 * edit appeared in no history at all: the working draft is a single upserted
 * row, so every save overwrote the last and a restore discarded them behind a
 * confirm dialog. `PublishingTopicDraftRevision` records them and this read
 * puts them on one scale with the generated runs.
 *
 * `seq` IS DISPLAY ONLY and is accepted by no write. Adoption and the editor
 * both still send `expectedUpdatedAt` — the working draft's own timestamp —
 * which is untouched by this change.
 *
 * READ-PERMISSIVE, matching `listAnalysisTimelineProcedure` and
 * `listTopicDraftsProcedure`: no `requireEligibleProjectForTopic()` ratchet.
 * That check also filters archived and soft-deleted projects, which is right
 * for a write and wrong for a read — it would 404 this history while the
 * panel's own current-state read kept rendering.
 */
export const listDraftTimelineProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/publishing-topics/{topicId}/draft-timeline",
		tags: ["Projects", "Publishing Suite"],
		summary: "List a topic's unified draft version timeline",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			postType: z.enum([
				"TWEET",
				"LINKEDIN_POST",
				"BLOG_POST",
				"CASE_STUDY",
				"STAKEHOLDER_EMAIL",
				"NEWSLETTER_BLURB",
				"WEBINAR_SCRIPT",
			]),
			/**
			 * The lowest `seq` the caller already holds; the next page is
			 * strictly below it. A position in an ordering, not a claim about a
			 * row — an unknown value yields an empty page rather than an error.
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
		const { entries, nextCursor } = await listDraftTimeline({
			topicId: input.topicId,
			projectId: input.projectId,
			postType: input.postType,
			cursor: input.cursor,
			limit: input.limit,
		});

		// `nextCursor` is part of the contract even when null, so a client can
		// tell "no more pages" from "this server does not page".
		return { entries, nextCursor };
	});
