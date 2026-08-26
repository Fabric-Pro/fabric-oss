import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Pure-ish DB op: tenant-scoped completion toggle on a meeting action item.
 * Scoping goes through the `transcript` relation (linked meeting rows have
 * no direct `projectId` column) so a client-supplied `actionItemId` from a
 * different project can never match.
 */
export async function applyActionItemCompletion(params: {
	projectId: string;
	actionItemId: string;
	userId: string;
	completed: boolean;
}): Promise<{ success: true; completedAt: Date | null }> {
	const completedAt = params.completed ? new Date() : null;
	const res = await db.projectMeetingActionItem.updateMany({
		where: {
			id: params.actionItemId,
			transcript: { projectId: params.projectId },
		},
		data: {
			completedAt,
			completedById: params.completed ? params.userId : null,
		},
	});
	if (res.count === 0) {
		throw new ORPCError("NOT_FOUND", {
			message: "Action item not found",
		});
	}
	return { success: true, completedAt };
}

/**
 * PROJECT_READ on purpose (same posture as extractInsights): checking off a
 * meeting action item is a lightweight collaborative act for every project
 * member, not an admin setting.
 */
export const setActionItemCompletedProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/meeting-digest/action-items/{actionItemId}",
		tags: ["Projects", "Meeting Digest"],
		summary: "Set completion on a meeting action item",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			actionItemId: z.string(),
			completed: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const access = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!access) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this project",
			});
		}

		const result = await applyActionItemCompletion({
			projectId: input.projectId,
			actionItemId: input.actionItemId,
			userId: context.user.id,
			completed: input.completed,
		});

		recordAuditFromRequest(context, {
			action: "project.meeting_digest.action_item_toggled",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: { type: "meeting_action_item", id: input.actionItemId },
			metadata: { completed: input.completed },
		});

		return result;
	});
