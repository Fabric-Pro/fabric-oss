/**
 * A topic's generated-draft state, for the Topic Item Page's generation tabs
 * (Publishing Suite Phase 2B-1, Fizzy #1853).
 *
 * READ ONLY. 2B-1 ships no write: generation arrives in 2B-2/2B-3 with the
 * prompts and the workflow that produce it, so this endpoint answers only
 * "what exists, and what does it say about itself".
 *
 * Scoped like every sibling: the DB helper re-scopes to `{ topicId, projectId }`,
 * so a topic id belonging to another project yields the same empty answer a
 * topic with no drafts produces. This endpoint cannot be used to probe for the
 * existence of topics in projects the caller cannot see (DV16).
 *
 * Deliberately NO `requireEligibleProjectForTopic()` ratchet, matching
 * `listTopicDecisionsProcedure` and `getPlanningAnalysisProcedure`: that ratchet
 * also filters on `status: "ACTIVE", deletedAt: null`, which is right for a
 * write but wrong for a read — it would 404 this ONE tab strip of the Topic
 * Item Page on an archived project while the header and the other tabs render
 * normally, leaving the page's own tabs disagreeing about whether the project
 * exists.
 */

import { listTopicDrafts } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

const PostTypeSchema = z.enum([
	"TWEET",
	"BLOG_POST",
	"CASE_STUDY",
	"STAKEHOLDER_EMAIL",
]);

/**
 * One draft attempt.
 *
 * `content` is deliberately ABSENT. 2B-1 renders no draft body, and shipping the
 * blob to a page that cannot display it is bytes over the wire for nothing;
 * 2B-2 adds it alongside the panel that reads it.
 */
const DraftRowSchema = z.object({
	id: z.string(),
	postType: PostTypeSchema,
	version: z.number().int(),
	status: z.string(),
	guidance: z.string().nullable(),
	model: z.string().nullable(),
	promptSource: z.string().nullable(),
	promptId: z.string().nullable(),
	promptVersion: z.number().int().nullable(),
	error: z.string().nullable(),
	requestedById: z.string().nullable(),
	createdAt: z.date(),
	updatedAt: z.date(),
	/** Server-computed: a GENERATING row past its deadline that nothing
	 * terminalised. The panel must treat it as retryable, because the only code
	 * that reclaims such a row runs inside the NEXT attempt. */
	isExpired: z.boolean(),
});

export const listTopicDraftsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/publishing-topics/{topicId}/drafts",
		tags: ["Projects", "Publishing Suite"],
		summary: "List a topic's generated drafts",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			drafts: z.array(
				z.object({
					postType: PostTypeSchema,
					/** The newest row of any status — what to SAY about the state. */
					latestAttempt: DraftRowSchema.nullable(),
					/** The newest READY row — what to RENDER. */
					latestReady: DraftRowSchema.nullable(),
				}),
			),
			workingDrafts: z.array(
				z.object({
					postType: PostTypeSchema,
					/**
					 * Existence only — the BODY is deliberately not returned.
					 *
					 * Not a privacy hedge: a working draft is SHARED project
					 * content (see `PublishingTopicWorkingDraft`), so every
					 * project member is entitled to read one. It is omitted
					 * because 2B-1 renders no draft text at all, and shipping a
					 * body to a page that cannot display it is bytes over the
					 * wire for nothing. 2B-3 adds it alongside the editor that
					 * reads it.
					 */
					hasBody: z.boolean(),
					sourceOptionLabel: z.string().nullable(),
					updatedAt: z.date(),
				}),
			),
		}),
	)
	.handler(async ({ input }) => {
		assertPublishingSuiteFeatureEnabled();

		// Scoped by BOTH ids inside the helper. `input.organizationId` is a
		// guard the middleware already used, never a scoping key here.
		return await listTopicDrafts({
			projectId: input.projectId,
			topicId: input.topicId,
		});
	});
