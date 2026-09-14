import { ORPCError } from "@orpc/client";
import {
	claimWorkingDraftLock,
	getProjectMembers,
	releaseWorkingDraftLock,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";
import { requireEligibleProjectForTopic } from "../../lib/publishing-topic-project";

/**
 * How long a claim stands without a refresh.
 *
 * Ten minutes, set on the deck call rather than derived: long enough that
 * reading a draft and thinking about it does not drop the claim, short enough
 * that somebody who opened it and walked away is not holding it after lunch.
 */
const LOCK_TTL_MINUTES = 10;

const PostTypeSchema = z.enum([
	"TWEET",
	"LINKEDIN_POST",
	"BLOG_POST",
	"CASE_STUDY",
	"STAKEHOLDER_EMAIL",
	"NEWSLETTER_BLURB",
	"WEBINAR_SCRIPT",
]);

/**
 * `publishingSuite.claimDraftLock` — say that you are editing a shared draft.
 *
 * `PublishingTopicWorkingDraft` is unique on `(topicId, postType)`: one draft
 * per content type for the WHOLE topic, not one per author. Two people editing
 * is therefore a real collision, and until now the only signal was a CONFLICT
 * on save — after the words were typed.
 *
 * ADVISORY, and deliberately so. It reports who holds the draft so the second
 * person can decide; `saveBody`'s compare-and-set stays the thing that actually
 * protects the text. Nothing here can refuse a write, which is why an expired
 * or missing claim is never an error.
 *
 * Take-over is always available and never destructive, because every prior body
 * is reachable through the draft version list. That is why this was sequenced
 * after opening that read path rather than before it.
 */
export const claimDraftLockProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/drafts/{postType}/lock",
		tags: ["Projects", "Publishing Suite"],
		summary: "Claim the advisory edit lock on a working draft",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			postType: PostTypeSchema,
			organizationId: z.string().nullable().optional(),
			/** Take it even when somebody else holds an unexpired claim. */
			takeOver: z.boolean().optional(),
		}),
	)
	.output(
		z.object({
			status: z.enum(["claimed", "held"]),
			expiresAt: z.date(),
			/** Who holds it, when somebody else does. */
			heldBy: z
				.object({ id: z.string(), name: z.string().nullable() })
				.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);
		const project = await requireEligibleProjectForTopic({
			projectId: input.projectId,
			clientOrganizationId: input.organizationId,
		});

		const result = await claimWorkingDraftLock({
			topicId: input.topicId,
			projectId: project.id,
			postType: input.postType,
			userId: context.user.id,
			ttlMinutes: LOCK_TTL_MINUTES,
			takeOver: input.takeOver,
		});

		if (result.status === "not_found") {
			throw new ORPCError("NOT_FOUND", {
				message: "No saved draft to claim",
			});
		}
		if (result.status === "claimed") {
			return {
				status: "claimed" as const,
				expiresAt: result.expiresAt,
				heldBy: null,
			};
		}

		// Resolve the holder's NAME through the project's member list rather
		// than an unscoped user lookup: the same name-disclosure rule every
		// other reader in this folder follows, and a holder who has since left
		// the project should read as nobody rather than as a name.
		const members = await getProjectMembers(input.projectId);
		const holder =
			members.find((m) => m.userId === result.byUserId)?.user ?? null;
		return {
			status: "held" as const,
			expiresAt: result.expiresAt,
			heldBy: holder
				? { id: holder.id, name: holder.name ?? null }
				: null,
		};
	});

/**
 * `publishingSuite.releaseDraftLock` — give it up.
 *
 * Scoped to the holder, so a stale tab closing cannot clear somebody else's
 * claim: the common case is two tabs, and the one that lost the race must not
 * release the one that won it.
 */
export const releaseDraftLockProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/drafts/{postType}/lock/release",
		tags: ["Projects", "Publishing Suite"],
		summary: "Release the advisory edit lock on a working draft",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			postType: PostTypeSchema,
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.object({ released: z.boolean() }))
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);
		const project = await requireEligibleProjectForTopic({
			projectId: input.projectId,
			clientOrganizationId: input.organizationId,
		});

		await releaseWorkingDraftLock({
			topicId: input.topicId,
			projectId: project.id,
			postType: input.postType,
			userId: context.user.id,
		});
		return { released: true };
	});
