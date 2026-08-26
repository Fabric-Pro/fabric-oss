import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses canEditProject() — only project owners/editors can
 * unlink Slack channels.
 *
 * Unlinks a Slack channel from a project. The cascading FK on
 * ProjectLinkedSlackChannelSeenMessage removes the per-channel dedup markers.
 * Existing PendingBacklogProposal rows are kept — they carry their own
 * sourceMetadata snapshot of channel info for historical display.
 */
export const unlinkChannelProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/slack-channel-monitor/unlink",
		tags: ["Projects", "Slack Channel Monitor"],
		summary: "Unlink a Slack channel from a project",
		description:
			"Removes a linked Slack channel and its seen-message markers.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			linkedChannelId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const tenantFilter = organizationId
			? { organizationId }
			: { organizationId: null, userId: user.id };

		const project = await db.project.findFirst({
			where: { id: input.projectId, ...tenantFilter },
			select: { id: true },
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Delete is scoped to (id, projectId) so a guessed linkedChannelId from
		// another tenant's project can't be removed via this caller's session.
		await db.projectLinkedSlackChannel.deleteMany({
			where: {
				id: input.linkedChannelId,
				projectId: input.projectId,
			},
		});

		return { success: true };
	});
