/**
 * The features and bugs a to-do's meeting item produced (Fizzy #2340).
 *
 * WHAT THIS ANSWERS. Somebody filed a to-do's action item into the Feature
 * Proposals inbox; somebody else approved it; a feature or bug now exists. This
 * is the read that lets the To Do page say so, instead of leaving the person who
 * asked for the ticket with no way to find out whether they got one.
 *
 * THE RESOLUTION IS STABLE-KEY FIRST, and that is the whole reason this is not
 * a one-line join. `ProjectMeetingActionItem.id` does not survive a
 * re-extraction, so a proposal filed before one and approved after it addressed
 * a row that no longer existed. `../lib/proposal-links.ts` resolves the key
 * first and the row id only as a fallback; the fallback still exists because a
 * proposal filed before #2340 carries no key at all and must keep resolving
 * exactly as it always did.
 *
 * TWO LAYERS OF AUTHORIZATION, not one.
 *
 *  1. `requireInputOrgPermission(TODO_READ, { requireOrganization: true })`
 *     proves the caller belongs to the organization NAMED IN THE INPUT.
 *     `requirePermission` would have checked their SESSION org role instead,
 *     and `requireOrganization: true` is mandatory because without it an
 *     explicit `organizationId: null` resolves to nothing and skips the role
 *     check entirely.
 *  2. That is not sufficient. This endpoint is keyed by TO-DO id and reads a
 *     PROJECT's meeting digest, and organization membership says nothing about
 *     which of that organization's projects the caller may read. So the to-do is
 *     loaded under the module's own rule — the READ's visibility predicate,
 *     so this endpoint can only be pointed at a row its caller can see — and the
 *     project that owns the MEETING — taken from the transcript, not from the
 *     caller's input — is then checked with `PROJECT_READ`, the same permission
 *     `meeting-digest/manage-action-item-links.ts` requires of the digest side.
 *
 * WHY THE WRITE'S ACCESS RULE GATES THIS READ. `requireTodoMutationAccess` is
 * named for the mutations, and using it here is deliberate rather than
 * convenient: every work item this read returns is one the caller is being
 * offered a button to accept or reject. A read that showed rows the paired write
 * would refuse would be a page of dead controls, and the two rules drifting
 * apart is exactly how that happens.
 *
 * THE FLAG. `MEETING_ACTION_ITEM_LINKING` is `default: false`, and with it off
 * there are no links: none were ever written and the matcher never ran. This
 * read then answers with an empty `items` and `linkingEnabled: false` rather
 * than an error, which is the clean-rollback posture
 * `stories/list-meeting-references.ts` already established — stored rows stay
 * untouched and simply stop rendering. It is NOT the same flag as `TODO_LIST`:
 * that one gates the To Do page itself, and it is checked first.
 */

import { isFeatureEnabled } from "@repo/database";
import { z } from "zod";
import {
	assertProjectPermission,
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	requireTodoListEnabled,
	requireTodoMutationAccess,
} from "../lib/mutation-access";
import {
	findProposalsForTodo,
	listWorkItemsForTodo,
	resolveTodoMeetingBinding,
	type TodoProposalResolvedVia,
	type TodoWorkItem,
} from "../lib/proposal-links";
import { requireOrganizationContext } from "./contacts/shared";

export const todoLinkedWorkItemsInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	todoId: z.string().min(1),
});

/** What the To Do page renders beside one row. */
interface TodoLinkedWorkItemsResult {
	todoId: string;
	/**
	 * The Graph transcript id of the meeting, for a deep link into the digest.
	 * Null on a manual to-do, and on nothing else.
	 */
	transcriptRef: string | null;
	/** The project that owns the meeting. Null on a manual to-do. */
	projectId: string | null;
	/**
	 * False when `MEETING_ACTION_ITEM_LINKING` is off. `items` is then empty,
	 * and the page must not render an accept/reject control it would refuse.
	 */
	linkingEnabled: boolean;
	/**
	 * How the to-do reached its proposal — the stable key, or the action item
	 * row id for a proposal filed before the key existed. Null when no proposal
	 * was ever filed from this item, which is the ordinary case.
	 */
	resolvedVia: TodoProposalResolvedVia | null;
	/**
	 * True when the binding no longer resolves to a live action item, because a
	 * re-extraction reworded or dropped it. Links cannot be addressed for such a
	 * row (see `requireWritableBinding`), so the page should not offer to change
	 * them.
	 */
	isOrphaned: boolean;
	items: TodoWorkItem[];
}

export const todoLinkedWorkItemsProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.TODO_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/todos/{todoId}/work-items",
		tags: ["Todos"],
		summary: "The work items this to-do's meeting item produced",
		description:
			"Resolves the to-do's action item to the proposals filed from it — stable key first, action item row id as the fallback for proposals filed before the key existed — and returns the features and bugs those proposals produced, together with the link row each one hangs on. Empty when MEETING_ACTION_ITEM_LINKING is off.",
	})
	.input(todoLinkedWorkItemsInputSchema)
	.handler(async ({ input, context }): Promise<TodoLinkedWorkItemsResult> => {
		const organizationId = requireOrganizationContext(
			resolveOrganizationId(input.organizationId, context.session),
		);
		await requireTodoListEnabled(organizationId);

		// Read once, before any early return, because it is part of the answer
		// and not only a gate: the page needs to know whether an empty list
		// means "nothing linked" or "linking is switched off".
		const linkingEnabled = await isFeatureEnabled(
			"MEETING_ACTION_ITEM_LINKING",
		);

		const now = new Date();
		const todo = await requireTodoMutationAccess({
			todoId: input.todoId,
			organizationId,
			viewerUserId: context.user.id,
			now,
		});

		const binding = await resolveTodoMeetingBinding({
			todo,
			organizationId,
		});
		if (!binding) {
			// A MANUAL to-do has no meeting, so it has nothing to report. That
			// is an answer, not a failure: the page asks this of every row it
			// renders and a refusal here would be an error the client has to
			// swallow on the ordinary path.
			return {
				todoId: todo.id,
				transcriptRef: null,
				projectId: null,
				linkingEnabled,
				resolvedVia: null,
				isOrphaned: false,
				items: [],
			};
		}

		// The second authorization layer, and the one the organization check
		// cannot stand in for: the meeting belongs to a project, and naming a
		// to-do id must not let somebody read a project's digest links they were
		// never granted. The project comes from the TRANSCRIPT, never from the
		// caller.
		await assertProjectPermission(
			binding.projectId,
			context.user.id,
			Permissions.PROJECT_READ,
			context,
		);

		const shared = {
			todoId: todo.id,
			transcriptRef: binding.transcriptRef,
			projectId: binding.projectId,
			linkingEnabled,
			isOrphaned: binding.liveActionItem === null,
		};

		if (!linkingEnabled) {
			// Clean rollback: stored rows stay untouched and simply stop
			// rendering. Nothing further is queried, because with the flag off
			// there is nothing a link could be shown for.
			return { ...shared, resolvedVia: null, items: [] };
		}

		const proposals = await findProposalsForTodo(binding);
		const items = await listWorkItemsForTodo({ binding, proposals });

		return {
			...shared,
			resolvedVia: proposals[0]?.resolvedVia ?? null,
			items,
		};
	});
