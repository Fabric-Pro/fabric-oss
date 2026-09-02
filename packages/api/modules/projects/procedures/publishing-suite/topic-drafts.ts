/**
 * A topic's generated-draft state, for the Topic Item Page's generation tabs
 * (Publishing Suite Phase 2B-1, Fizzy #1853).
 *
 * READ ONLY, and it stays that way: the writes live in `short-post.ts` (2B-2)
 * and will live beside them for the blog post (2B-3). This endpoint answers only
 * "what exists, and what does it say about itself" — it is also the poll target
 * while a generation runs, which is why it must stay cheap.
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
 * `content` is `z.unknown()` rather than a shape. Each content type stores a
 * different document — the short post's three labeled options are nothing like a
 * blog draft — so a union here would make every panel's props carry the other
 * three's cases, and every new content type a breaking change to this schema.
 * The panel that renders one is the place that knows which, and each narrows it
 * defensively for itself.
 *
 * 2B-1 omitted it entirely, on the grounds that shipping a blob to a page which
 * cannot display it is bytes over the wire for nothing. 2B-2 built that page.
 */
const DraftRowSchema = z.object({
	id: z.string(),
	content: z.unknown(),
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
					 * Whether the saved draft has any text, derived from `body`
					 * rather than from the row existing — so an empty body reads
					 * as "nothing saved" instead of as a draft the panel then
					 * renders blank.
					 */
					hasBody: z.boolean(),
					/**
					 * The saved draft text.
					 *
					 * Not a privacy question: a working draft is SHARED project
					 * content (see `PublishingTopicWorkingDraft`), so every
					 * project member is entitled to read one. 2B-1 withheld it
					 * only because nothing rendered it then; 2B-2's panel shows
					 * the option the user adopted.
					 */
					body: z.string(),
					/**
					 * Which candidate the body came from. The LABEL alone does
					 * not identify an option across regenerations — the prompt is
					 * asked for descriptive labels, so the same one recurring
					 * with different text is the common case, and a reader
					 * comparing on it marks the new option as already saved and
					 * makes it unreachable.
					 */
					sourceDraftId: z.string().nullable(),
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
