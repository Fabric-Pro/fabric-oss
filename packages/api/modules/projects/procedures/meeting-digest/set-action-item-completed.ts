import { ORPCError } from "@orpc/server";
import { hasProjectAccess, setActionItemCompletion } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Tenant-scoped completion toggle on a meeting action item.
 *
 * The write itself lives in `@repo/database` (`setActionItemCompletion`), and
 * that is not tidiness: `ProjectMeetingActionItem.completedAt` is no longer read
 * by this surface alone. The consolidated To Do list (#2340) binds a `TodoItem`
 * to this row by `(transcriptId, itemKey, occurrenceIndex)` and keeps
 * `lastKnownCompletedAt` as a snapshot of this very column, so that a row whose
 * wording a re-extraction changed can still say it had been completed. A digest
 * write that ignored the snapshot would make the To Do page claim an item was
 * never done (completed here, never snapshotted) or claim a completion the
 * person had taken back (reopened here, snapshot left behind). The query module
 * writes both in one transaction, over the same partition the To Do read
 * numbers occurrences with.
 *
 * `organizationId` is therefore part of the call: it is the tenant whose
 * partition the occurrence is counted in, and the same value the To Do read
 * uses. Passing it is not optional book-keeping — an absent one is why the
 * snapshot half is skipped rather than guessed.
 *
 * `projectId` remains the scope guard, applied through the `transcript`
 * relation because linked-meeting rows have no direct `projectId` column, so a
 * client-supplied `actionItemId` from a different project can never match.
 */
export async function applyActionItemCompletion(params: {
	projectId: string;
	actionItemId: string;
	userId: string;
	completed: boolean;
	organizationId: string | null | undefined;
	/** One clock for the request; defaulted only so callers may omit it. */
	now?: Date;
}): Promise<{ success: true; completedAt: Date | null }> {
	const result = await setActionItemCompletion({
		actionItemId: params.actionItemId,
		projectId: params.projectId,
		organizationId: params.organizationId,
		userId: params.userId,
		completed: params.completed,
		now: params.now,
	});
	if (!result.matched) {
		throw new ORPCError("NOT_FOUND", {
			message: "Action item not found",
		});
	}
	return { success: true, completedAt: result.completedAt };
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
			// The resolved tenant, never the client's claim: the To Do snapshot
			// this write maintains is addressed by an occurrence counted inside
			// this organization's partition.
			organizationId,
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
