/**
 * Ticking a to-do off, and taking that back (#2340).
 *
 * ONE procedure for both directions, with `completed` in the input, because
 * they are one act a person repeats rather than two events — the same shape
 * `projects.setActionItemCompleted` settled on, and the reason the audit
 * taxonomy carries one `org.todo.completion_changed` key rather than a pair.
 *
 * WHERE THE COMPLETION GOES depends on the row's shape, and getting that wrong
 * is the failure this whole feature is arranged to avoid. A MEETING-SOURCED
 * to-do's completion lives on its `ProjectMeetingActionItem`, never on the
 * to-do: `TodoItem.completedAt` is for MANUAL rows alone, and the read
 * (`list-todos.ts`) picks between them on `transcriptId IS NULL`. Writing both
 * would give the page two answers and it only ever reads one.
 *
 * Completing a meeting-sourced row ALSO stamps `lastKnownCompletedAt` on the
 * to-do. That is not a second copy of the truth — it is the only record that
 * survives a rewording. The next extraction run replaces the transcript's
 * action items wholesale; once the text changes, the binding orphans, the row
 * that carried the completion is gone, and without the snapshot the orphaned
 * to-do cannot say it had ever been completed. `setTodoCompletion` writes both
 * in one transaction for that reason.
 *
 * AUTHORIZATION IS IN TWO HALVES, exactly as the read's is. The declared gate
 * proves membership of the organization NAMED IN THE INPUT — `requirePermission`
 * would have checked the caller's SESSION org role, which is how a member of
 * one tenant borrows their own role to act on another's, and
 * `requireOrganization: true` is mandatory because without it an explicit
 * `organizationId: null` resolves to nothing and skips the role check entirely.
 * The second half is `requireTodoMutationAccess`: this procedure is keyed by
 * to-do id and a manual to-do may have no project at all, so organization
 * membership alone would let any member tick off any other member's private
 * list.
 */

import { ORPCError } from "@orpc/server";
import { setTodoCompletion } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	requireTodoListEnabled,
	requireTodoMutationAccess,
} from "../lib/mutation-access";
import { requireOrganizationContext } from "./contacts/shared";

export const completeTodoInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	todoId: z.string().min(1),
	/** True completes, false reopens. */
	completed: z.boolean(),
});

export const completeTodoProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.TODO_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "PATCH",
		path: "/todos/{todoId}/completion",
		tags: ["Todos"],
		summary: "Complete or reopen a to-do",
		description:
			"Writes completion where the row actually holds it: a meeting-sourced to-do's action item, or a manual to-do's own column. Completing a meeting-sourced row also snapshots lastKnownCompletedAt so the completion survives a rewording.",
	})
	.input(completeTodoInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrganizationContext(
			resolveOrganizationId(input.organizationId, context.session),
		);
		await requireTodoListEnabled(organizationId);

		// One clock for the whole request, for the same reason the read takes
		// one: the membership-expiry check inside the access rule and the
		// completion timestamp must not disagree about when "now" was.
		const now = new Date();

		const todo = await requireTodoMutationAccess({
			todoId: input.todoId,
			organizationId,
			viewerUserId: context.user.id,
			now,
		});

		const result = await setTodoCompletion({
			todo,
			organizationId,
			completed: input.completed,
			userId: context.user.id,
			now,
		});

		if (!result) {
			// Nothing was written, which now means only one thing: the row was
			// deleted between the load and the write. An orphaned binding is no
			// longer a refusal — a row whose wording changed under it carries
			// its own completion, because a to-do that can never be closed is
			// worse than one holding its completion locally.
			throw new ORPCError("NOT_FOUND", {
				message: "This to-do no longer exists",
			});
		}

		// No title and no assignee name: a meeting-sourced item's text
		// routinely names the person who owes the work, and an assignee may be
		// a non-member contact whom `org.contact.redacted` erases on request.
		// The audit log is append-only, so either would outlive that erasure.
		recordAuditFromRequest(context, {
			action: "org.todo.completion_changed",
			category: "org",
			organizationId,
			projectId: todo.projectId,
			resource: { type: "todo_item", id: todo.id, name: null },
			metadata: {
				completed: input.completed,
				source: todo.source,
				// Which row took the write. Worth recording because it is the
				// one thing about this mutation that is not obvious from the
				// to-do id alone.
				completionTarget: result.target,
				actionItemId: result.actionItemId,
			},
		});

		return {
			todoId: todo.id,
			completed: input.completed,
			completedAt: result.completedAt?.toISOString() ?? null,
			completionTarget: result.target,
			actionItemId: result.actionItemId,
		};
	});
