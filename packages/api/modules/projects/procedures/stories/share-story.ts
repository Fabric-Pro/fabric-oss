import { ORPCError } from "@orpc/server";
import {
	getProjectMembers,
	getStoryById,
	hasProjectAccess,
} from "@repo/database";
import { z } from "zod";
import { fanOut } from "../../../../lib/notification-service";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Notify (tag) one or more project members from the feature editor. Each
 * recipient receives an in-app `STORY_SHARED` notification that deep-links to
 * the feature, with the feature title as context and an optional author
 * message. Gated on STORY_READ (least privilege) — a VIEWER can pull in a
 * reviewer. Recipients are validated server-side against the project's member
 * list (creator + accepted members, exactly what the selector surfaces), so a
 * bypassed client cannot notify a non-member ("only project members, no
 * external sharing").
 */
export const shareStoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/share",
		tags: ["Projects", "Stories"],
		summary: "Notify project members about a feature",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			storyId: z.string(),
			recipientUserIds: z.array(z.string()).min(1).max(50),
			message: z.string().max(280).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const story = await getStoryById(input.storyId, input.projectId);
		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Feature not found",
			});
		}

		// Server-side allow-list: only project members (creator + accepted,
		// non-expired members — the same set the selector shows) may be tagged.
		const members = await getProjectMembers(input.projectId);
		const allowedUserIds = new Set(members.map((m) => m.userId));
		const requested = Array.from(new Set(input.recipientUserIds));
		const invalid = requested.filter((id) => !allowedUserIds.has(id));
		if (invalid.length > 0) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"One or more recipients are not members of this project",
			});
		}

		// `notifiedCount` is the number of rows actually written — self-skips,
		// dedupe/preference suppressions, and failed writes are all excluded, so
		// the success toast never overstates delivery (and a systemic failure
		// surfaces as 0 rather than a false positive).
		const notifiedCount = await fanOut.storyShared({
			recipientUserIds: requested,
			storyId: story.id,
			projectId: input.projectId,
			organizationId: organizationId ?? null,
			actorUserId: user.id,
			actorName: user.name ?? "Someone",
			featureTitle: story.title,
			identifier: story.identifier ?? null,
			// Context-relative link — `resolveNotificationLink` re-bases it onto
			// the notification's own workspace (org slug or personal `/app`).
			link: `projects/${input.projectId}/stories/${story.id}`,
			message: input.message,
		});

		return { notifiedCount };
	});
