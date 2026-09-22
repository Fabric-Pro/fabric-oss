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
 * THREE LAYERS OF AUTHORIZATION, not one — and each answers a question the one
 * before it does not.
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
 *  3. AND `PROJECT_READ` IS STILL NOT THE QUESTION THE ANSWER ANSWERS (#2615).
 *     `assertProjectPermission` resolves through
 *     `resolveEffectiveProjectPermissions`, whose last path falls back to the
 *     caller's ORGANIZATION role when they hold no active `ProjectMember` row.
 *     So it passes for every member of the tenant — while `getProjectById`,
 *     which every route this response feeds must go through, runs
 *     `buildProjectAccessWhere` and refuses exactly those people. Answered on
 *     the permission check alone, this hands back a `projectId` the page turns
 *     into a story link whose destination then says "Project not found", plus
 *     the identifiers, titles and statuses of work items in a project the
 *     reader was deliberately never added to. So a third check asks the
 *     openable question directly, with `openableProjectWhere`.
 *
 *     KEEP BOTH. They are not redundant and neither subsumes the other: the
 *     permission check answers "is this caller allowed to do PROJECT_READ
 *     here", refusing with NOT_FOUND/FORBIDDEN and seeding the guest tenant
 *     carve-out that the queries below depend on; the reach check answers "will
 *     this project open for them", and DEGRADES rather than throwing. Deleting
 *     either one silently restores half of this defect.
 *
 * WHY THE REACH FAILURE DEGRADES AND DOES NOT THROW. Arms 1 and 5 of the read
 * deliberately keep showing a person their OWN commitments from a project they
 * cannot open (#2615, R5) — the digest's owner matcher assigns work across the
 * whole organization — so the To Do page legitimately renders such a row and
 * asks this of it like any other. A refusal would put an error under an
 * ordinary row. Instead the answer carries `projectId: null` and no items,
 * which is the same shape a MANUAL to-do gets and which
 * `TodoWorkItemLinks.tsx` already renders as a plain `<span>` with no controls.
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
import { isProjectOpenable } from "../lib/visibility";
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
	 *
	 * Null on a manual to-do, and null with `projectId` when the caller cannot
	 * OPEN the meeting's project — the two travel together, because a
	 * transcript ref is only ever addressable through its project and half a
	 * deep link is not a lesser answer, it is a broken one.
	 */
	transcriptRef: string | null;
	/**
	 * The project that owns the meeting. Null on a manual to-do, and null when
	 * the caller cannot open it (see the header): the page builds a story route
	 * from this field, so a value here is a promise that the route resolves.
	 */
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

		/**
		 * The honest empty answer: this row has no project to report.
		 *
		 * ONE LITERAL FOR BOTH REASONS — no meeting at all, and a meeting whose
		 * project the caller cannot open — so the two cannot drift into two
		 * differently-shaped nulls the page has to tell apart.
		 */
		const nothingToReport = {
			todoId: todo.id,
			transcriptRef: null,
			projectId: null,
			linkingEnabled,
			resolvedVia: null,
			isOrphaned: false,
			items: [],
		};

		const binding = await resolveTodoMeetingBinding({
			todo,
			organizationId,
		});
		if (!binding) {
			// A MANUAL to-do has no meeting, so it has nothing to report. That
			// is an answer, not a failure: the page asks this of every row it
			// renders and a refusal here would be an error the client has to
			// swallow on the ordinary path.
			return nothingToReport;
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

		// THE THIRD LAYER, AND IT IS NOT THE SECOND ONE RESTATED (#2615).
		// `assertProjectPermission` falls back to the caller's ORGANIZATION
		// role when they hold no active `ProjectMember` row, so it passes for
		// every member of the tenant — including the ones `getProjectById`
		// refuses. `openableProjectWhere` is that refusal, asked here, so this
		// response never carries a project id the page cannot route to, nor the
		// work items of a project the reader was never added to. Header
		// paragraph 3 records why BOTH checks stay.
		//
		// It runs AFTER the permission check on purpose: that check seeds the
		// guest tenant carve-out (`grantProjectAccess`) the queries below rely
		// on, and it owns the hard refusals — this one only decides whether
		// there is anything to say.
		const openable = await isProjectOpenable({
			viewerUserId: context.user.id,
			organizationId,
			projectId: binding.projectId,
			now,
		});
		if (!openable) {
			// Degrade, do not refuse. The row itself is legitimately the
			// caller's — arms 1 and 5 of the read keep a person's own
			// commitments visible from a project they cannot open — so this is
			// an ordinary row with nothing to link, and the client already
			// renders exactly that.
			return nothingToReport;
		}

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
