/**
 * Adding a to-do by hand (#2340).
 *
 * The MANUAL arm of `TodoItemSource`. A manual row carries its own `title` and
 * leaves every meeting column null, and that nullity is not tidiness — it is
 * the discriminator the read branches on. `list-todos.ts` selects completion
 * with `CASE WHEN transcriptId IS NULL THEN t."completedAt" ELSE ai."completedAt"`,
 * so a manual row that somehow carried a `transcriptId` would have its
 * completion read off an action item it has no binding to. Nothing here writes
 * one.
 *
 * THE PROJECT IS OPTIONAL, and a to-do with none is the case the rest of this
 * module is arranged around. It is an organization-level commitment: while it
 * is unassigned the read's Unassigned arm shows it to any member, and the write
 * rule is that same predicate (`../lib/mutation-access.ts`), so the bucket the
 * page offers for triage is a bucket its rows can actually be triaged from.
 * Once it is assigned to someone else, the creator keeps it through the read's
 * MANUAL-owner arm rather than losing the row they wrote.
 *
 * WHEN A PROJECT IS NAMED it is verified with `openableProjectWhere` — a
 * shared predicate, not a bare existence check. Two things ride on that: the
 * project must belong to THIS organization (so a reachable project cannot be
 * paired with someone else's tenant id), and it must not be soft-deleted (a
 * soft delete fires no cascade, so a deleted project's rows are all still
 * there and would otherwise accept new ones).
 *
 * AND IT IS THE STRICT PREDICATE, NOT THE WIDE ONE (#2615). This used to ask
 * `organizationProjectWhere`, which admits every project of the tenant — so a
 * member could file a to-do against a project they cannot open, and the row
 * was born with a dead link: the list renders its project heading, the heading
 * goes to `getProjectById`, and `getProjectById` runs the strict rule and says
 * "Project not found". `openableProjectWhere` is that strict rule, so what a
 * to-do may be filed against is exactly what its reader can open. Creating
 * into a project the caller cannot reach at all would also produce a row they
 * immediately cannot see.
 *
 * THERE IS NO PICKER IN FRONT OF THIS, which is why the check has to be here.
 * The To Do page has no manual-create control at all today — the only project
 * control it renders is a FILTER over the rows already loaded — so every
 * caller of this endpoint reaches it directly, as `POST /todos` with a
 * `projectId` of their choosing: an API-key client, a script, a future dialog
 * nobody has written yet. A narrow picker would have been convenience; this
 * check is the rule, and at present it is the only thing constraining which
 * project a manual to-do can be filed against.
 *
 * `sourceDate` IS NOW. The model documents it as "the meeting's date for a
 * meeting-sourced row, creation for a manual one", and both the age cutoff and
 * the recency ordering key off that single field — a manual row without it
 * would sort as though it were from the beginning of time.
 *
 * NO ASSIGNEE ON CREATE, deliberately. Assigning is `todos.assign`, which is
 * also where the target is verified against this organization and where
 * `assignedManually` is set. One place for that rule, whether the row is a
 * minute or a month old.
 */

import { ORPCError } from "@orpc/server";
import { createManualTodo, db } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { requireTodoListEnabled } from "../lib/mutation-access";
import { isProjectOpenable } from "../lib/visibility";
import { requireOrganizationContext } from "./contacts/shared";

export const createTodoInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	/**
	 * `.trim()` runs before the length check, so `"   "` fails `min(1)` — the
	 * same rule the contact register applies to a name, and for the same
	 * reason: a whitespace-only title renders as an empty line nobody can
	 * search for or identify.
	 */
	title: z
		.string()
		.trim()
		.min(1, "A to-do needs a title")
		.max(INPUT_BOUNDS.name),
	/** Optional. Omitted means an organization-level commitment. */
	projectId: z.string().optional(),
});

export const createTodoProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.TODO_CREATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/todos",
		tags: ["Todos"],
		summary: "Create a manual to-do",
		description:
			"Adds a to-do with its own title, optionally on a project the caller can reach. Source is MANUAL and sourceDate is now, which is what the age and recency rules key off.",
	})
	.input(createTodoInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrganizationContext(
			resolveOrganizationId(input.organizationId, context.session),
		);
		await requireTodoListEnabled(organizationId);

		const now = new Date();

		if (input.projectId) {
			// The STRICT rule — what `getProjectById` runs, and therefore what
			// decides whether this to-do's project heading will open for the
			// person who reads it. See the header.
			const openable = await isProjectOpenable({
				viewerUserId: context.user.id,
				organizationId,
				projectId: input.projectId,
				now,
			});
			if (!openable) {
				// One refusal for "another organization's project", "no such
				// project", "soft-deleted", "you were removed from it" and
				// "you are in the organization but not on this project".
				// Telling them apart would let a caller enumerate projects of
				// organizations they do not belong to.
				throw new ORPCError("FORBIDDEN", {
					message: "You do not have access to this project",
				});
			}
		}

		const todo = await createManualTodo({
			organizationId,
			// The creator owns the row. `user_owned` RLS keys on this column,
			// and it is what the read's MANUAL-owner arm matches — so the
			// author keeps their own to-do readable and writable however it is
			// later assigned.
			userId: context.user.id,
			title: input.title,
			projectId: input.projectId ?? null,
			now,
		});

		// The title is deliberately absent from the ledger: it is free text a
		// person typed, it routinely names whoever owes the work, and an audit
		// row cannot be edited when that person asks to be erased.
		recordAuditFromRequest(context, {
			action: "org.todo.created",
			category: "org",
			organizationId,
			projectId: todo.projectId,
			resource: { type: "todo_item", id: todo.id, name: null },
			metadata: { source: "MANUAL", hasProject: todo.projectId !== null },
		});

		return {
			id: todo.id,
			source: todo.source,
			title: todo.title,
			projectId: todo.projectId,
			assigneeUserId: todo.assigneeUserId,
			assigneeContactId: todo.assigneeContactId,
			assignedManually: todo.assignedManually,
			snoozedUntil: todo.snoozedUntil?.toISOString() ?? null,
			completedAt: todo.completedAt?.toISOString() ?? null,
			sourceDate: todo.sourceDate.toISOString(),
			createdAt: todo.createdAt.toISOString(),
			updatedAt: todo.updatedAt.toISOString(),
		};
	});
