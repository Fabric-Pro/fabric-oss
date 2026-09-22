/**
 * Who may WRITE which to-do (#2340).
 *
 * The sibling of `visibility.ts`, and the same argument applies: the To Do page
 * is a single organization-level surface with no project in its route, so the
 * gate every mutation declares — `requireInputOrgPermission(TODO_UPDATE,
 * { requireOrganization: true })` — proves the caller belongs to the tenant
 * named in the input and NOTHING MORE. It is where authorization starts. This
 * module is where it ends.
 *
 * THE WRITE RULE IS THE READ RULE. A row the caller cannot SEE must not be a
 * row they can change, so this module resolves the reader's own scope with
 * `resolveTodoVisibility` and evaluates the reader's own predicate with
 * `isTodoVisibleTo` over the loaded row. There is deliberately no second
 * spelling of the rule here: the last one was a security defect.
 *
 * WHAT THE SECOND SPELLING COST. The rule used to be "the caller owns the row,
 * OR the row has a project the caller can reach", and `organizationProjectWhere`
 * grants every project of an organization to every member of it. But that
 * predicate is only the OUTER gate of the read, which then narrows to its arms.
 * So a to-do on a shared project ASSIGNED TO A COLLEAGUE was absent from the
 * caller's list and still completable, snoozable, unsnoozeable and
 * reassignable by id — and reassigning it to themselves made it readable too.
 * `TODO_UPDATE` sits at viewer level, so that was every member of the tenant.
 * The module's own header claimed the invariant the code broke; the header was
 * right.
 *
 * NARROWING TO THE READ NEEDED THE READ TO GROW ONE ARM. The read's first arm
 * is the ASSIGNEE, not the owner, so narrowing to it alone would have taken a
 * manual to-do away from the person who wrote it the moment they handed it to
 * someone else — they could neither see it nor undo it. `todoVisibilityCondition`
 * arm 5 is that arm, scoped to MANUAL rows for a reason recorded beside it.
 *
 * WHY THE READ'S SCOPE AND NOT `hasProjectAccess`. Two differences make this a
 * correctness matter rather than a style choice: that helper ignores its
 * `_organizationId` parameter entirely (so a project legitimately reached could
 * be paired with another tenant's organization id), and it has no `deletedAt`
 * filter (so a soft-deleted project's to-dos would stay writable after the
 * project left every list — a soft delete fires no cascade, so those rows are
 * all still there). The predicates the read's scope composes
 * (`organizationProjectWhere` for the tenant gate, `openableProjectWhere` for
 * the arms that show other people's work) close both.
 *
 * THE BATCH PATH asks the same exported predicate against a scope it resolves
 * ONCE per request (`../procedures/bulk-resolve.ts`): a fixed, bounded number
 * of queries for the whole batch, never one per row. The DECISION is still per
 * row, so naming twenty ids never pools the caller's rights across them.
 *
 * The count is deliberately not written down here. It was "two", and became
 * three when the scope grew a second project predicate; a number in prose that
 * nobody re-derives is a claim that goes quietly false. What must hold is that
 * it does not scale with the batch, and that is what the tests assert.
 *
 * WHAT "NOT FOUND" MEANS HERE. A to-do of another organization and a to-do that
 * never existed are reported identically, because the load is scoped by
 * organization and a row outside it simply does not match. Only a row the
 * caller can see but may not touch is a FORBIDDEN, and that distinction is safe
 * to make: they already know the row exists — it is on their page.
 */

import { ORPCError } from "@orpc/server";
import {
	isFeatureEnabled,
	loadTodoForMutation,
	type TodoMutationRow,
} from "@repo/database";
import { isTodoVisibleTo, resolveTodoVisibility } from "./visibility";

/**
 * Why a to-do write was refused.
 *
 * A closed union rather than a thrown error, because the batch path has to
 * report one of these PER ROW and carry on. `requireTodoMutationAccess` turns
 * it into the ORPC refusal for the single-row procedures.
 */
type TodoMutationDenial = "not_found" | "forbidden";

type TodoMutationAccess =
	| { ok: true; todo: TodoMutationRow }
	| { ok: false; reason: TodoMutationDenial };

/**
 * The rollout gate, shared by every to-do write.
 *
 * Off means the To Do page does not exist for this organization, so a write
 * arriving from it is answered the way the read is: absent, not empty and not
 * silently accepted. The contact register deliberately sits OUTSIDE this gate
 * (see the router's docblock) — a contact outlives the page that motivated it.
 * The page's own writes do not.
 */
export async function requireTodoListEnabled(
	organizationId: string,
): Promise<void> {
	if (!(await isFeatureEnabled("TODO_LIST", organizationId))) {
		throw new ORPCError("NOT_FOUND", {
			message: "The To Do list is not available",
		});
	}
}

/**
 * Loads one to-do of this organization and applies the read's rule to it.
 *
 * Non-throwing, because the answer is a closed union rather than a throw: the
 * refusal has to be distinguishable from the absence for the single-row
 * procedures to report the right one.
 *
 * The scope is resolved AFTER the load and only when there is a row to decide
 * about, so naming an id from another tenant costs one query and learns
 * nothing.
 */
async function resolveTodoMutationAccess(params: {
	todoId: string;
	organizationId: string;
	viewerUserId: string;
	now: Date;
}): Promise<TodoMutationAccess> {
	const todo = await loadTodoForMutation({
		todoId: params.todoId,
		organizationId: params.organizationId,
	});
	if (!todo) {
		return { ok: false, reason: "not_found" };
	}

	const visibility = await resolveTodoVisibility({
		viewerUserId: params.viewerUserId,
		organizationId: params.organizationId,
		now: params.now,
	});

	return isTodoVisibleTo(todo, visibility)
		? { ok: true, todo }
		: { ok: false, reason: "forbidden" };
}

/**
 * The same, as the single-row procedures need it: the row, or a refusal.
 *
 * Call it BEFORE any write and before anything is reported back — a caller who
 * may not touch a row has no business learning anything about it beyond that
 * they may not.
 */
export async function requireTodoMutationAccess(params: {
	todoId: string;
	organizationId: string;
	viewerUserId: string;
	now: Date;
}): Promise<TodoMutationRow> {
	const access = await resolveTodoMutationAccess(params);
	if (access.ok) {
		return access.todo;
	}
	if (access.reason === "not_found") {
		throw new ORPCError("NOT_FOUND", { message: "To-do not found" });
	}
	throw new ORPCError("FORBIDDEN", {
		message: "You do not have access to this to-do",
	});
}
