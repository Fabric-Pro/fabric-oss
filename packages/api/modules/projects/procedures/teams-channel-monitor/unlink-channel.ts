import { ORPCError } from "@orpc/server";
import { db, unlinkTeamsChannelFromProject } from "@repo/database";
import { deleteMonitoredConversationContext } from "@repo/temporal/delete-channel-context";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireContextSourceAdmin } from "../../lib/require-context-source-admin";

/**
 * AUTHORIZATION: Uses canEditProject() - only project owners/editors can
 * unlink Teams channels.
 *
 * Unlinks a Teams channel from a project. Cascading deletes remove the
 * associated seen-message dedup rows. Existing PendingBacklogProposal rows
 * remain intact — they keep their reference to the channel via sourceMetadata
 * for historical display.
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
		path: "/projects/{projectId}/teams-channel-monitor/unlink",
		tags: ["Projects", "Teams Channel Monitor"],
		summary: "Unlink a Teams channel from a project",
		description:
			"Removes a linked Teams channel, its seen-message markers, and everything captured from it.",
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

		// Destructive: raises the floor to PROJECT_ADMIN while the flag is on.
		// After the tenant check so a non-member still gets NOT_FOUND rather
		// than FORBIDDEN, which would confirm the project exists.
		await requireContextSourceAdmin({
			projectId: input.projectId,
			userId: user.id,
		});

		// The monitor row is what carries the provider identity — the input is
		// this row's own id, which no context's metadata records. Read it while
		// it is still there; the context lookup below matches on
		// `(teamId, channelId)`.
		const linked = await db.projectLinkedTeamsChannel.findFirst({
			where: { id: input.linkedChannelId, projectId: input.projectId },
			select: { teamId: true, channelId: true },
		});

		if (linked) {
			await deleteMonitoredConversationContext({
				projectId: input.projectId,
				// The tenant a PERSONAL stranded-vector cleanup record is
				// written and read under. An organization unlink keys on
				// `organizationId` instead — the queue enforces the XOR.
				userId: user.id,
				organizationId,
				conversation: {
					provider: "MICROSOFT_TEAMS",
					kind: "channel",
					teamId: linked.teamId,
					channelId: linked.channelId,
				},
			});
		}

		await unlinkTeamsChannelFromProject(
			input.projectId,
			input.linkedChannelId,
		);

		return { success: true };
	});
