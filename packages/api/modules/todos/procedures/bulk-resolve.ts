/**
 * Clearing several to-dos at once (#2340).
 *
 * Resolve means complete: the same write `todos.complete` performs, applied to
 * a set. It is a separate procedure rather than an array-shaped `complete`
 * because its failure contract is the opposite one.
 *
 * PARTIAL SUCCESS IS THE CONTRACT. The list is a live view over rows that a
 * re-extraction can delete between the moment the page rendered and the moment
 * someone hits the button: a meeting re-processed in that window replaces its
 * action items wholesale, so ids the client is holding can simply stop
 * existing. Failing the batch on one of those would refuse a person's entire
 * selection because of a row they never chose to touch, and — worse — would
 * leave them no way to tell which one. So every row is decided, written and
 * committed on its own, and the response reports an outcome PER ROW:
 *
 *   completed — written.
 *   not_found — no such to-do in this organization any more.
 *   forbidden — theirs to see, not theirs to change.
 *   vanished  — the row was loaded and then deleted before the write landed
 *               item, so there is nothing holding its completion. The read
 *               already marks these `isOrphaned`; they need a person, not a
 *               retry.
 *
 * Nothing is wrapped in one transaction, and that is the point rather than an
 * omission: a transaction would give back exactly the all-or-nothing behaviour
 * this procedure exists to avoid.
 *
 * AUTHORIZATION IS PER ROW, not per batch. Naming twenty ids does not pool the
 * caller's rights across them — each one is decided by the same rule the
 * single-row procedures use, which is the READ's own predicate
 * (`isTodoVisibleTo`), so a batch is never a way to reach a row a single call
 * would have refused, and never a way to change a row the caller cannot see.
 * The load is one query and the caller's visibility scope is two more, both for
 * the whole batch; the decision is still one per row.
 */

import { loadTodosForMutation, setTodoCompletion } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { requireTodoListEnabled } from "../lib/mutation-access";
import { isTodoVisibleTo, resolveTodoVisibility } from "../lib/visibility";
import { requireOrganizationContext } from "./contacts/shared";

/**
 * How many rows one batch may carry.
 *
 * An abuse ceiling well above any selection a person makes on a page that
 * renders fifty rows at a time, not a product limit. It is deliberately tighter
 * than `INPUT_BOUNDS.idArray` (500) because every accepted id costs a write and
 * an audit row.
 */
const BULK_RESOLVE_MAX = 100;

export const bulkResolveTodosInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	todoIds: z
		.array(z.string().min(1))
		.min(1, "Choose at least one to-do")
		.max(BULK_RESOLVE_MAX),
});

/** One row's outcome. A closed set, so a client can branch exhaustively. */
type BulkResolveOutcome =
	| "completed"
	| "not_found"
	| "forbidden"
	// The row was loaded and then disappeared before the write landed — a race
	// with a concurrent delete, not a binding problem. An orphaned binding is no
	// longer a refusal: a row whose wording changed under it completes on
	// itself, because there is no live action item to be the other place.
	| "vanished";

interface BulkResolveResult {
	todoId: string;
	outcome: BulkResolveOutcome;
}

export const bulkResolveTodosProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.TODO_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/todos/bulk-resolve",
		tags: ["Todos"],
		summary: "Complete several to-dos",
		description:
			"Completes each named to-do independently and reports an outcome per row. A row deleted by a re-extraction between render and submit is reported, not thrown — the rest of the batch still commits.",
	})
	.input(bulkResolveTodosInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrganizationContext(
			resolveOrganizationId(input.organizationId, context.session),
		);
		await requireTodoListEnabled(organizationId);

		const now = new Date();

		// Duplicates collapse here rather than being written twice. A client
		// that sent one id three times gets one outcome for it, which is the
		// only answer that can be true.
		const todoIds = [...new Set(input.todoIds)];

		const rows = await loadTodosForMutation({ todoIds, organizationId });
		const rowById = new Map(rows.map((row) => [row.id, row]));

		// The caller's visibility scope, resolved ONCE for the whole batch: two
		// bounded queries about this caller, not two per row. It is the same
		// scope `todos.list` resolves for the same caller, organization and
		// clock, so a row this batch may write is a row that batch's page
		// showed.
		const visibility = await resolveTodoVisibility({
			viewerUserId: context.user.id,
			organizationId,
			now,
		});

		const results: BulkResolveResult[] = [];
		for (const todoId of todoIds) {
			const todo = rowById.get(todoId);
			if (!todo) {
				results.push({ todoId, outcome: "not_found" });
				continue;
			}

			// In memory, per row, with no further I/O — the property the
			// single lookup above exists to preserve.
			if (!isTodoVisibleTo(todo, visibility)) {
				results.push({ todoId, outcome: "forbidden" });
				continue;
			}

			const written = await setTodoCompletion({
				todo,
				organizationId,
				completed: true,
				userId: context.user.id,
				now,
			});
			if (!written) {
				results.push({ todoId, outcome: "vanished" });
				continue;
			}

			results.push({ todoId, outcome: "completed" });

			// The same row the single-row path writes, for each row actually
			// completed. Without it, "who completed this to-do" would be
			// answerable only when it was ticked on its own — a batch would be
			// a way to change someone's item and leave no receipt naming it.
			recordAuditFromRequest(context, {
				action: "org.todo.completion_changed",
				category: "org",
				organizationId,
				projectId: todo.projectId,
				resource: { type: "todo_item", id: todo.id, name: null },
				metadata: {
					completed: true,
					source: todo.source,
					completionTarget: written.target,
					actionItemId: written.actionItemId,
					/** Distinguishes these from a deliberate single tick. */
					viaBulkResolve: true,
				},
			});
		}

		const counts = {
			requested: todoIds.length,
			completed: results.filter((r) => r.outcome === "completed").length,
			notFound: results.filter((r) => r.outcome === "not_found").length,
			forbidden: results.filter((r) => r.outcome === "forbidden").length,
			vanished: results.filter((r) => r.outcome === "vanished").length,
		};

		// One summary row for the act itself. The per-row rows above say WHICH
		// items moved; this one says they were one decision, and its counts are
		// what make a partial batch legible at a glance.
		recordAuditFromRequest(context, {
			action: "org.todo.bulk_resolved",
			category: "org",
			organizationId,
			resource: { type: "todo_item_batch", id: null, name: null },
			metadata: counts,
		});

		return { results, counts };
	});
