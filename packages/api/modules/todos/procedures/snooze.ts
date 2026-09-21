/**
 * Putting a to-do out of sight until a date (#2340).
 *
 * A snooze hides UNCONDITIONALLY and beats the recency floor — the read
 * excludes snoozed rows in `scoped`, before anything is ranked, so a snoozed
 * to-do cannot occupy one of the floor's slots and cannot be counted as hidden
 * by age. That makes the date the whole contract of this procedure: it is not a
 * hint, it is the moment the item comes back to everyone who can see it.
 *
 * A PAST DATE IS REFUSED rather than normalized. The read's boundary is
 * `snoozedUntil <= now`, so a date already elapsed is indistinguishable from no
 * snooze at all: accepting one would answer "snoozed until yesterday" with a
 * success and leave the item exactly where it was, which reads as the feature
 * being broken rather than as the input being wrong.
 *
 * The check runs in the handler against the request's single clock rather than
 * in the schema, because the schema would have to sample a second one. Two
 * clocks in one request is how an instant gets refused and applied in the same
 * breath — the same reason the read takes `now` as a parameter instead of
 * reading it three times.
 *
 * Authorization is the module's rule, not organization membership: see
 * `../lib/mutation-access.ts`. A manual to-do may have no project, so nothing
 * project-shaped can answer for it, and the rule is the READ's own predicate —
 * so nobody can hide an item that was never on their page in the first place.
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

export const snoozeTodoInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	todoId: z.string().min(1),
	/**
	 * When the item comes back. Coerced from the ISO string the client sends;
	 * whether it is in the future is decided in the handler, against the one
	 * clock that request uses.
	 */
	snoozedUntil: z.coerce.date(),
});

export const snoozeTodoProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.TODO_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/todos/{todoId}/snooze",
		tags: ["Todos"],
		summary: "Snooze a to-do until a date",
		description:
			"Hides the to-do from every view until the given moment. A date in the past is refused, because the read treats an elapsed snooze as no snooze and accepting one would report success while changing nothing.",
	})
	.input(snoozeTodoInputSchema)
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

		// `<=` and not `<`: the read's boundary is exclusive, so a snooze whose
		// deadline has exactly arrived counts as elapsed there. Accepting one
		// here would write a snooze that the very next read ignores.
		if (input.snoozedUntil.getTime() <= now.getTime()) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Choose a date in the future to snooze until",
			});
		}

		const updated = await setTodoSnooze({
			todoId: todo.id,
			organizationId,
			snoozedUntil: input.snoozedUntil,
		});
		if (!updated) {
			// Deleted between the load and the write.
			throw new ORPCError("NOT_FOUND", { message: "To-do not found" });
		}

		// The date is the whole point of the row and carries nothing about a
		// person; the to-do's text and its assignee deliberately do not appear.
		recordAuditFromRequest(context, {
			action: "org.todo.snoozed",
			category: "org",
			organizationId,
			projectId: todo.projectId,
			resource: { type: "todo_item", id: todo.id, name: null },
			metadata: {
				snoozedUntil: input.snoozedUntil.toISOString(),
				previousSnoozedUntil: todo.snoozedUntil?.toISOString() ?? null,
			},
		});

		return {
			todoId: todo.id,
			snoozedUntil: input.snoozedUntil.toISOString(),
		};
	});
