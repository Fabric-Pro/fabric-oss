import { ORPCError } from "@orpc/client";
import {
	getProjectMembers,
	resolveProjectTenant,
	updatePublishingTopicAssignees,
} from "@repo/database";
import { z } from "zod";
import { fanOut } from "../../../../lib/notification-service";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

/** Same ceiling as the contributor override: one request cannot name the whole
 *  directory. A publishing topic realistically has two or three assignees. */
const MAX_ASSIGNEES = 50;

export const updatePublishingTopicAssigneesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/publishing-topics/{topicId}/assignees",
		tags: ["Projects", "Publishing Suite"],
		summary: "Replace a publishing topic's assignee list",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			// A plain array, NOT the contributor field's tri-state. Nothing
			// AI-resolves assignees, so there is no suggestion to revert to and
			// no `null` reset — `[]` is "nobody", and it is the only way to
			// clear the list.
			assigneeUserIds: z.array(z.string()).max(MAX_ASSIGNEES),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);
		// AUTHORIZATION: requireProjectPermission(PUBLISHING_TOPIC_UPDATE) gates
		// project access; the membership check below gates the ids themselves.
		const user = context.user;

		// Every submitted id MUST be a CURRENT project member.
		//
		// This is the same name-disclosure-oracle protection
		// `update-topic-contributors.ts` documents at length — the ids written
		// here are later fed to an unscoped `db.user.findMany` that resolves
		// display handles, so an unchecked id would let any caller read back an
		// arbitrary user's name and avatar — but WITHOUT its grandfather rule,
		// and the difference is not an oversight.
		//
		// Contributors carry one because the server's own
		// `resolveProjectContributorIds` deliberately resolves story/document/PR
		// authors via ANY linked account, so a topic routinely names someone who
		// was never a project member; refusing those ids on resubmit would make
		// an editor adding one person silently drop everyone else. Assignees have
		// no server-resolved set at all — every id in the column got there by
		// passing THIS check — so a non-member id can only mean the person left
		// the project since. Dropping them is then correct rather than lossy, and
		// there is nothing legitimate for a grandfather rule to protect.
		//
		// MEASURED: getProjectMembers returns rows shaped
		// { userId, role, user: {...}, isOwner, isCreator, isGuest, invitedAt,
		//   acceptedAt, expiresAt } — there is no top-level `id`. Use `userId`.
		if (input.assigneeUserIds.length > 0) {
			const members = await getProjectMembers(input.projectId);
			const memberIds = new Set(members.map((m) => m.userId));
			const stranger = input.assigneeUserIds.find(
				(id) => !memberIds.has(id),
			);
			if (stranger !== undefined) {
				throw new ORPCError("BAD_REQUEST", {
					message: "Assignees must be current project members",
				});
			}
		}

		const result = await updatePublishingTopicAssignees({
			id: input.topicId,
			projectId: input.projectId,
			assigneeUserIds: input.assigneeUserIds,
		});
		if (!result) {
			throw new ORPCError("NOT_FOUND", {
				message: "Topic not found",
			});
		}

		// Notify on ADD only, and never the person doing the assigning.
		//
		// A removal tells the recipient nothing they can act on — the whole
		// point of assignment here is "have a look", and "you no longer need to
		// have a look" is not worth a bell row. The added-only diff comes from
		// the query helper, which read the prior set inside the same call.
		//
		// Fire-and-forget: a notification failure must never fail the write the
		// user actually asked for. The tenant comes from the PROJECT row, not
		// from `input.organizationId` — a caller-supplied tenant is never
		// membership-checked, and this is the value the row is stamped with.
		if (result.addedUserIds.length > 0) {
			void (async () => {
				const tenant = await resolveProjectTenant(input.projectId);
				await fanOut.publishingTopicAssigned({
					recipientUserIds: result.addedUserIds,
					topicId: input.topicId,
					topicTitle: result.topic.title,
					projectId: input.projectId,
					organizationId: tenant?.organizationId ?? null,
					actorUserId: user.id,
					actorName: user.name ?? "Someone",
					// Context-relative, like every other in-app link: the bell
					// prepends the notification's OWN workspace base, so this
					// must not carry `/app` or an org slug of its own.
					link: `projects/${input.projectId}/publishing/${input.topicId}`,
				});
			})().catch((error) => {
				console.warn(
					"[notification-service] Publishing topic assignee fan-out failed:",
					error,
				);
			});
		}

		return { topic: result.topic };
	});
