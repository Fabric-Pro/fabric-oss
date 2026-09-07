import { ORPCError } from "@orpc/client";
import {
	getProjectMembers,
	getPublishingTopicEffectiveContributorIds,
	updatePublishingTopicContributors,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

export const updatePublishingTopicContributorsProcedure =
	tenantProtectedProcedure
		.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
		.route({
			method: "PATCH",
			path: "/projects/{projectId}/publishing-topics/{topicId}/contributors",
			tags: ["Projects", "Publishing Suite"],
			summary:
				"Set or reset a publishing topic's user contributor override",
		})
		.input(
			z.object({
				projectId: z.string(),
				topicId: z.string(),
				organizationId: z.string().nullable().optional(),
				// null = reset to the AI-resolved set; [] = explicit "nobody"; a set
				// = override. Capped so one request cannot name the whole directory.
				contributorUserIds: z.array(z.string()).max(50).nullable(),
			}),
		)
		.handler(async ({ input }) => {
			await assertPublishingSuiteFeatureEnabled(input.projectId);
			// Every submitted id must be EITHER a current member of this project
			// OR already present in the topic's CURRENT effective contributor set
			// (the "grandfather" rule). `contributors` is resolved by an unscoped
			// user lookup in the temporal helper (`resolveContributorNames`), so
			// an unchecked id here would turn this endpoint into a
			// name-disclosure oracle for arbitrary user ids — THAT is the
			// property this check exists to preserve, and grandfathering an
			// already-effective id does not widen it: that id was either written
			// by the server's own `resolveProjectContributorIds` resolver or
			// passed this exact membership check at an earlier write, so it was
			// never introduced by this request. `resolveProjectContributorIds`
			// deliberately resolves story/document/PR authors via ANY linked
			// account, not just current project members (see its doc comment),
			// so a topic routinely names a contributor who has since left the
			// project or was never a member — without the grandfather rule, an
			// editor opening the dialog to ADD one person would silently drop
			// every such contributor on Save. A reset carries no ids to check.
			if (input.contributorUserIds !== null) {
				const [members, effectiveContributorIds] = await Promise.all([
					getProjectMembers(input.projectId),
					getPublishingTopicEffectiveContributorIds({
						id: input.topicId,
						projectId: input.projectId,
					}),
				]);
				if (effectiveContributorIds === null) {
					throw new ORPCError("NOT_FOUND", {
						message: "Topic not found",
					});
				}
				// MEASURED: getProjectMembers returns rows shaped
				// { userId, role, user: { id, name, email, image }, isOwner,
				//   isCreator, isGuest, invitedAt, acceptedAt, expiresAt }
				// — there is no top-level `id`. Use `userId`.
				const allowedIds = new Set([
					...members.map((m) => m.userId),
					...effectiveContributorIds,
				]);
				const stranger = input.contributorUserIds.find(
					(id) => !allowedIds.has(id),
				);
				if (stranger !== undefined) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Contributors must be current project members or already associated with this topic",
					});
				}
			}
			const result = await updatePublishingTopicContributors({
				id: input.topicId,
				projectId: input.projectId,
				contributorUserIds: input.contributorUserIds,
			});
			if (!result) {
				throw new ORPCError("NOT_FOUND", {
					message: "Topic not found",
				});
			}
			return { topic: result.topic };
		});
