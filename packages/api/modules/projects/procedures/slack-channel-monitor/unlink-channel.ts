import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { deleteMonitoredConversationContext } from "@repo/temporal/delete-channel-context";
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
 *
 * The channel's `ProjectContext` pointer row goes too, along with every
 * conversation bundle captured under it and every vector either of them put in
 * the store (Fizzy #2228, U7). That runs BEFORE the monitor row is removed: if
 * the vector store refuses, the unlink fails with the channel still linked, so
 * the user sees a failure they can retry rather than a success that left
 * conversation text searchable in a channel they just removed.
 */
export const unlinkChannelProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/slack-channel-monitor/unlink",
		tags: ["Projects", "Slack Channel Monitor"],
		summary: "Unlink a Slack channel from a project",
		description:
			"Removes a linked Slack channel, its seen-message markers, and everything captured from it.",
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

		// Scoped to (id, projectId) — the same scoping the delete below uses —
		// so a guessed linkedChannelId from another tenant's project resolves
		// to nothing and takes no context with it.
		const linked = await db.projectLinkedSlackChannel.findFirst({
			where: { id: input.linkedChannelId, projectId: input.projectId },
			select: { channelId: true },
		});

		if (linked) {
			// Matched on `channelId` alone, never on the workspace id: the
			// Add-Context writers never persisted one, so a context row created
			// by them would not be recognized. See `slack-integration-context.ts`.
			await deleteMonitoredConversationContext({
				projectId: input.projectId,
				// The tenant a PERSONAL stranded-vector cleanup record is
				// written and read under. An organization unlink keys on
				// `organizationId` instead — the queue enforces the XOR.
				userId: user.id,
				organizationId,
				conversation: {
					provider: "SLACK",
					kind: "channel",
					channelId: linked.channelId,
				},
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
