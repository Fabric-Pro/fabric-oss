/**
 * Choosing who owes a to-do (#2340).
 *
 * Three targets, one procedure: an organization member, a non-member contact,
 * or nobody. They share a call because a to-do carries `assigneeUserId` XOR
 * `assigneeContactId` and the two columns have to be written as a pair —
 * separate "assign to member" and "assign to contact" procedures would each
 * have to remember to clear the other's column, and the day one forgot, a row
 * would name two people.
 *
 * `assignedManually` IS THE POINT OF THE WRITE. Meeting action items are
 * re-extracted wholesale on every run and the owner matcher re-guesses an
 * assignee each time; that flag is what it checks before touching one. Without
 * it set, the next run would replace a person's deliberate choice with the
 * machine's guess from a free-text name in a transcript. The suggestion columns
 * are cleared in the same write for the mirror-image reason: a suggestion is an
 * unconfirmed guess offered FOR confirmation, and leaving one beside a
 * confirmed assignee keeps the surface asking a question that has been
 * answered.
 *
 * THE TARGET IS VERIFIED AGAINST THIS ORGANIZATION, always. A member id is
 * checked for current membership and a contact id for a LIVE row of this
 * tenant — not merely for existence. The contact case is the sharper one: the
 * register is org-only with no owning user, so the organization filter is its
 * entire tenant boundary, and a contact id from another organization would
 * otherwise be accepted verbatim and then leak that organization's person into
 * this one's list the moment the page hydrated the name. A REDACTED contact is
 * refused by the same check, because assigning work to a tombstone would walk
 * an erased person back into the obligations that `contacts.delete` detached
 * them from.
 *
 * THE CONTACT CHECK BELOW IS THE EARLY ANSWER, NOT THE DECIDING ONE. It is a
 * read, and `contacts.delete` is a transaction that can commit between it and
 * the write — which is exactly the state this procedure forbids, arrived at by
 * timing: the erasure detaches every to-do pointing at the contact, this write
 * then points one back at it, and `assignedManually` freezes the row so no
 * later matcher run ever clears it. `setTodoAssignee` therefore re-asks the
 * same question under a row lock inside the transaction that performs the
 * write, and answers `contact_not_assignable` when the contact stopped being
 * live in between. That answer is mapped to the SAME `NOT_FOUND` /
 * "Contact not found" as every other contact refusal here: a caller who loses
 * the race must not be able to tell it apart from a contact that was never
 * theirs, or the difference becomes a way to probe another tenant's register
 * one id at a time.
 *
 * No name and no email is written anywhere by this procedure — not into the
 * to-do, which stores an id, and not into the audit row. The log is
 * append-only, so either would outlive the erasure `org.contact.redacted`
 * records.
 */

import { ORPCError } from "@orpc/server";
import {
	isAssignableContact,
	isAssignableOrganizationMember,
	setTodoAssignee,
} from "@repo/database";
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

export const assignTodoInputSchema = z
	.object({
		organizationId: z.string().nullable().optional(),
		todoId: z.string().min(1),
		/** A member of this organization. Mutually exclusive with the contact. */
		assigneeUserId: z.string().nullable().optional(),
		/** A live non-member contact of this organization. */
		assigneeContactId: z.string().nullable().optional(),
	})
	.refine((input) => !(input.assigneeUserId && input.assigneeContactId), {
		// The model stores one or the other. Both at once is not a request
		// the database can honour, and silently preferring one would assign
		// the item to a person the caller did not choose.
		message:
			"Assign to a member or to a contact, not both — a to-do has one or the other",
		path: ["assigneeContactId"],
	});

/** What the row ends up pointing at. Used in the response and the audit row. */
type AssigneeKind = "member" | "contact" | "none";

function assigneeKind(
	assigneeUserId: string | null,
	assigneeContactId: string | null,
): AssigneeKind {
	if (assigneeUserId) {
		return "member";
	}
	return assigneeContactId ? "contact" : "none";
}

export const assignTodoProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.TODO_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "PATCH",
		path: "/todos/{todoId}/assignee",
		tags: ["Todos"],
		summary: "Assign a to-do to a member, a contact, or nobody",
		description:
			"Sets assignedManually so the choice survives the next re-extraction, and clears the unconfirmed suggestion. Omitting both ids unassigns the to-do.",
	})
	.input(assignTodoInputSchema)
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

		// An omitted id and an explicit null both mean "nobody". The schema has
		// already refused the one combination that is not a choice.
		const assigneeUserId = input.assigneeUserId ?? null;
		const assigneeContactId = input.assigneeContactId ?? null;

		if (assigneeUserId) {
			const isMember = await isAssignableOrganizationMember({
				organizationId,
				userId: assigneeUserId,
			});
			if (!isMember) {
				throw new ORPCError("NOT_FOUND", {
					message: "That person is not a member of this organization",
				});
			}
		}

		if (assigneeContactId) {
			const isContact = await isAssignableContact({
				organizationId,
				contactId: assigneeContactId,
			});
			if (!isContact) {
				// One refusal for "another organization's contact", "no such
				// contact" and "already redacted". Telling them apart would let
				// a caller probe another tenant's register one id at a time.
				throw new ORPCError("NOT_FOUND", {
					message: "Contact not found",
				});
			}
		}

		const updated = await setTodoAssignee({
			todoId: todo.id,
			organizationId,
			assigneeUserId,
			assigneeContactId,
		});
		if (!updated.assigned) {
			if (updated.reason === "contact_not_assignable") {
				// Word for word the refusal above, and deliberately so. The
				// contact was live when this request checked and is not live
				// now; saying anything more specific would describe the state
				// of a row the caller may have no claim to.
				throw new ORPCError("NOT_FOUND", {
					message: "Contact not found",
				});
			}
			throw new ORPCError("NOT_FOUND", { message: "To-do not found" });
		}

		const kind = assigneeKind(assigneeUserId, assigneeContactId);

		// Ids, never names or emails — see the header. The ids are pointers
		// that a redaction leaves intact; a name is the thing a redaction
		// removes, and this ledger cannot be edited afterwards.
		recordAuditFromRequest(context, {
			action: "org.todo.assigned",
			category: "org",
			organizationId,
			projectId: todo.projectId,
			resource: { type: "todo_item", id: todo.id, name: null },
			metadata: {
				assigneeKind: kind,
				assigneeUserId,
				assigneeContactId,
				previousAssigneeKind: assigneeKind(
					todo.assigneeUserId,
					todo.assigneeContactId,
				),
				previousAssigneeUserId: todo.assigneeUserId,
				previousAssigneeContactId: todo.assigneeContactId,
			},
		});

		return {
			todoId: todo.id,
			assigneeUserId,
			assigneeContactId,
			assigneeKind: kind,
			/** Always true after this call — it is what the write is for. */
			assignedManually: true,
		};
	});
