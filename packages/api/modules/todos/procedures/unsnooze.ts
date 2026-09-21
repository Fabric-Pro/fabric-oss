/**
 * Ending a snooze early (#2340).
 *
 * ITS OWN PROCEDURE, not `snooze` with a null date, and its own audit key. A
 * snooze hides an item from everyone who can see it; unsnoozing returns it to
 * the open view. Those are opposite acts, and folding them into one call means
 * the audit filter for "who hid this" also matches the person who brought it
 * back — which is precisely the question the ledger exists to answer. A
 * nullable date on the snooze input would also make the past-date refusal that
 * procedure carries conditional on a field being present, which is how a guard
 * quietly stops running.
 *
 * WHY IT CLEARS RATHER THAN BACKDATES. The read's boundary is
 * `snoozedUntil <= now`, so an absent snooze and an elapsed one are the same
 * state to every query in the product. Writing `null` says that plainly;
 * writing "now" would invent a distinction nothing downstream can see, and
 * would leave the age clock — `GREATEST(sourceDate, snoozedUntil)` — reading
 * today for an item whose meeting was months ago, so an item unsnoozed by
 * mistake would jump to the top of the list and stay there.
 *
 * IDEMPOTENT ON PURPOSE. Unsnoozing a row that is not snoozed succeeds and says
 * so through `wasSnoozed`. A refusal would turn the ordinary double-click into
 * an error, and the caller learns nothing they could act on: the end state is
 * the one they asked for either way.
 */

import { ORPCError } from "@orpc/server";
import { setTodoSnooze } from "@repo/database";
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

export const unsnoozeTodoInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	todoId: z.string().min(1),
});

export const unsnoozeTodoProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.TODO_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/todos/{todoId}/unsnooze",
		tags: ["Todos"],
		summary: "End a to-do's snooze early",
		description:
			"Clears the snooze so the to-do returns to the open view immediately. Succeeds whether or not the row was snoozed.",
	})
	.input(unsnoozeTodoInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrganizationContext(
			resolveOrganizationId(input.organizationId, context.session),
		);
		await requireTodoListEnabled(organizationId);

		const now = new Date();

		const todo = await requireTodoMutationAccess({
			todoId: input.todoId,
			organizationId,
			viewerUserId: context.user.id,
			now,
		});

		const updated = await setTodoSnooze({
			todoId: todo.id,
			organizationId,
			snoozedUntil: null,
		});
		if (!updated) {
			throw new ORPCError("NOT_FOUND", { message: "To-do not found" });
		}

		recordAuditFromRequest(context, {
			action: "org.todo.unsnoozed",
			category: "org",
			organizationId,
			projectId: todo.projectId,
			resource: { type: "todo_item", id: todo.id, name: null },
			metadata: {
				// What the snooze WAS. Without it the row says an item was
				// brought back without saying from how far away, which is the
				// only part of the act anyone would query for afterwards.
				previousSnoozedUntil: todo.snoozedUntil?.toISOString() ?? null,
			},
		});

		return {
			todoId: todo.id,
			snoozedUntil: null,
			wasSnoozed: todo.snoozedUntil !== null,
		};
	});
